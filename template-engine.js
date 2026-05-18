'use strict';

const db = require('./db');
const GENERIC_TEMPLATES = require('./templates/generic-templates.json');
const { buildStandardActionOptions } = require('./turn-options');
const targetAuthority = require('./target-authority');

// In-memory cache: Map<"slug:event:persona", string[]>
const templateCache = new Map();

// Event type metadata for Haiku generation prompts
const EVENT_DESCRIPTIONS = {
  attack_hit: 'hits a player character with a weapon attack',
  attack_miss: 'misses a player character with a weapon attack',
  attack_crit: 'lands a critical hit on a player character',
  takes_damage: 'takes damage from an attack',
  takes_crit: 'takes a critical hit',
  death: 'is killed (reaches 0 HP)',
  taunt: 'taunts or threatens a player character between attacks',
  spell_hit: 'hits with a spell attack',
  spell_miss: 'misses with a spell attack',
  pc_attack_hit: 'is hit by a player character (from the PC perspective)',
  pc_attack_miss: 'is missed by a player character (from the PC perspective)',
  pc_spell_hit: 'is hit by a player character spell',
};

const EVENT_VARIABLES = {
  attack_hit: ['target', 'damage', 'weapon', 'hp', 'maxHp'],
  attack_miss: ['target', 'weapon'],
  attack_crit: ['target', 'damage', 'weapon', 'hp', 'maxHp'],
  takes_damage: ['attacker', 'damage', 'weapon', 'hp', 'maxHp'],
  takes_crit: ['attacker', 'damage', 'weapon'],
  death: ['attacker', 'weapon'],
  taunt: ['target'],
  spell_hit: ['target', 'spell', 'damage', 'hp', 'maxHp'],
  spell_miss: ['target', 'spell'],
  pc_attack_hit: ['attacker', 'weapon', 'damage', 'hp', 'maxHp'],
  pc_attack_miss: ['attacker', 'weapon'],
  pc_spell_hit: ['attacker', 'spell', 'damage', 'hp', 'maxHp'],
};

function getEventDescription(eventType) {
  return EVENT_DESCRIPTIONS[eventType] || 'performs an action';
}

function substituteVariables(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return vars[key] !== undefined ? String(vars[key]) : match;
  });
}

function pickTemplate(pool) {
  if (!pool || pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function getCacheKey(slug, eventType, persona) {
  return `${slug}:${eventType}:${persona}`;
}

/**
 * Get a narration template for a monster event. Three-tier lookup:
 * 1. Monster-specific (cache → DB → generate)
 * 2. Creature-type generic (hardcoded)
 * 3. Bare fallback
 */
async function getTemplate(monsterSlug, eventType, persona, monsterMeta) {
  const cacheKey = getCacheKey(monsterSlug, eventType, persona);

  // Tier 1: In-memory cache
  if (templateCache.has(cacheKey)) {
    return pickTemplate(templateCache.get(cacheKey));
  }

  // Tier 1: DB lookup
  try {
    const dbTemplates = await db.getMonsterTemplates(monsterSlug, eventType, persona);
    if (dbTemplates && dbTemplates.length > 0) {
      templateCache.set(cacheKey, dbTemplates);
      return pickTemplate(dbTemplates);
    }
  } catch (err) {
    // DB may not be available in tests — fall through to generic
  }

  // Tier 2: Generic by creature type
  const creatureType = monsterMeta?.creatureType || 'humanoid';
  const genericPool = GENERIC_TEMPLATES[creatureType]?.[eventType]?.[persona]
    || GENERIC_TEMPLATES.humanoid?.[eventType]?.[persona];
  if (genericPool && genericPool.length > 0) {
    // Queue background generation for this monster (non-blocking)
    queueTemplateGeneration(monsterSlug, eventType, persona, monsterMeta).catch(() => {});
    return pickTemplate(genericPool);
  }

  // Tier 3: Bare fallback
  return null;
}

// Background template generation queue (prevents duplicate generation)
const generationInFlight = new Set();

async function queueTemplateGeneration(monsterSlug, eventType, persona, monsterMeta) {
  const key = getCacheKey(monsterSlug, eventType, persona);
  if (generationInFlight.has(key)) return;
  generationInFlight.add(key);

  try {
    await generateTemplates(monsterSlug, eventType, persona, monsterMeta);
  } finally {
    generationInFlight.delete(key);
  }
}

async function generateTemplates(monsterSlug, eventType, persona, monsterMeta) {
  // Lazy require to avoid circular dependency: server requires template-engine
  const { anthropic } = require('./server');

  const monsterName = monsterMeta?.name || monsterSlug.replace(/-/g, ' ');
  const monsterDesc = monsterMeta?.description || monsterMeta?.personality || '';
  const personaDesc = persona === 'over_the_top'
    ? 'comedic and chaotic — Critical Role energy, absurd humor, fourth-wall breaks'
    : 'dramatic and atmospheric — tight evocative prose, visceral and grounded';
  const vars = (EVENT_VARIABLES[eventType] || ['target'])
    .map(v => `{${v}}`).join(', ');

  const prompt = `Generate 6 short combat narration lines for a ${monsterName}${monsterDesc ? ` (${monsterDesc})` : ''} when it ${getEventDescription(eventType)}.

Persona: ${personaDesc}

Use these variables (include literally with braces): ${vars}

Rules:
- Each line: 1 sentence, max 20 words
- Match the monster's personality and fighting style
- Vary intensity and word choice across the 6 lines
- No dice notation or numbers — just narration flavor

Return a JSON array of 6 strings. No other text.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    const templates = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(templates) || templates.length === 0) return;

    // Save to DB and cache
    await db.saveMonsterTemplates(monsterSlug, eventType, persona, templates);
    templateCache.set(getCacheKey(monsterSlug, eventType, persona), templates);
  } catch (err) {
    console.error(`Template generation failed for ${monsterSlug}/${eventType}/${persona}:`, err.message);
  }
}

/**
 * Assemble narration for a full combat round from resolved results.
 * Each result gets: dice line (deterministic) + flavor line (template).
 */
async function assembleCombatNarration(results, combatEngine, persona) {
  const lines = [];

  for (const result of results) {
    // Deterministic dice line from combat engine
    const diceLine = combatEngine.formatResultForPrompt(result);

    // Determine monster slug, event type, and template variables
    const { monsterSlug, eventType, vars, monsterMeta } = mapResultToTemplate(result, combatEngine);

    if (monsterSlug && eventType) {
      const template = await getTemplate(monsterSlug, eventType, persona, monsterMeta);
      if (template) {
        const flavorLine = substituteVariables(template, vars);
        lines.push(`**🎲 ${diceLine}**\n${flavorLine}`);
      } else {
        lines.push(`**🎲 ${diceLine}**`);
      }
    } else {
      lines.push(`**🎲 ${diceLine}**`);
    }
  }

  return lines.join('\n\n');
}

/**
 * Map a combat result to template lookup params.
 * Returns { monsterSlug, eventType, vars, monsterMeta }
 */
function mapResultToTemplate(result, combatEngine) {
  const combatants = combatEngine.state.combatants;

  if (result.type === 'attack') {
    const attacker = combatants[result.attackerId];
    const target = combatants[result.targetId];
    if (!attacker || !target) return {};

    const isMonsterAttacking = attacker.type === 'Enemy';
    const monster = isMonsterAttacking ? attacker : target;
    const other = isMonsterAttacking ? target : attacker;

    let eventType;
    if (isMonsterAttacking) {
      eventType = result.critical ? 'attack_crit' : (result.hit ? 'attack_hit' : 'attack_miss');
    } else {
      eventType = result.hit ? 'pc_attack_hit' : 'pc_attack_miss';
    }

    // Check for death
    if (result.hit && target.hp !== undefined && target.hp <= 0 && target.type === 'Enemy') {
      eventType = 'death';
    }

    return {
      monsterSlug: monster.slug || monster.name?.toLowerCase().replace(/\s+/g, '-'),
      eventType,
      vars: {
        target: target.name,
        attacker: attacker.name,
        damage: result.damage || '',
        weapon: result.weapon || result.weaponName || 'weapon',
        hp: target.hp || 0,
        maxHp: target.maxHp || target.totalHp || 0,
      },
      monsterMeta: {
        name: monster.name,
        description: monster.personality || '',
        creatureType: monster.creatureType || 'humanoid',
      },
    };
  }

  if (result.type === 'spell-save' || result.type === 'spell-attack') {
    const caster = combatants[result.casterId];
    const isMonsterCasting = caster?.type === 'Enemy';
    const firstTarget = result.targets?.[0];
    const targetCombatant = firstTarget ? combatants[firstTarget.id] : null;

    if (isMonsterCasting && firstTarget) {
      const hit = result.type === 'spell-save' ? !firstTarget.saved : firstTarget.hit;
      return {
        monsterSlug: caster.slug || caster.name?.toLowerCase().replace(/\s+/g, '-'),
        eventType: hit ? 'spell_hit' : 'spell_miss',
        vars: {
          target: firstTarget.name || targetCombatant?.name || 'target',
          spell: result.spell || 'spell',
          damage: firstTarget.damage || '',
          hp: targetCombatant?.hp || 0,
          maxHp: targetCombatant?.maxHp || targetCombatant?.totalHp || 0,
        },
        monsterMeta: {
          name: caster.name,
          description: caster.personality || '',
          creatureType: caster.creatureType || 'humanoid',
        },
      };
    } else if (!isMonsterCasting && targetCombatant?.type === 'Enemy') {
      return {
        monsterSlug: targetCombatant.slug || targetCombatant.name?.toLowerCase().replace(/\s+/g, '-'),
        eventType: 'pc_spell_hit',
        vars: {
          attacker: caster?.name || 'caster',
          spell: result.spell || 'spell',
          damage: firstTarget?.damage || '',
          hp: targetCombatant.hp || 0,
          maxHp: targetCombatant.maxHp || targetCombatant.totalHp || 0,
        },
        monsterMeta: {
          name: targetCombatant.name,
          description: targetCombatant.personality || '',
          creatureType: targetCombatant.creatureType || 'humanoid',
        },
      };
    }
  }

  if (result.type === 'heal') {
    return {}; // No monster template for heals — dice line is sufficient
  }

  if (result.type === 'death_save') {
    return {}; // Death saves use their own format from formatResultForPrompt
  }

  // dodge, disengage, dash — no template needed
  return {};
}

/**
 * Generate tactical combat options for the current player.
 */
function generateCombatOptions(combatEngine, characterName) {
  const combatants = combatEngine.state.combatants;
  const player = Object.values(combatants).find(
    c => c.type === 'PC' && c.name.toLowerCase() === characterName.toLowerCase()
  );
  if (!player) return [];

  const livingEnemies = Object.values(combatants).filter(
    c => c.type === 'Enemy' && c.hp > 0
  );
  const nearestEnemy = livingEnemies[0];

  const standardOptions = buildStandardActionOptions(player.standardActions, {
    targetPlayer: player.name,
    character: player,
    nearestEnemy,
    combatants,
    inCombat: true,
    includeActorLabel: false,
  });

  // Option 1: Attack with primary weapon
  const weapon = player.weapons?.[0]?.name || 'weapon';
  const opt1 = nearestEnemy
    ? `🗡️ Attack ${nearestEnemy.name} with ${weapon}`
    : '🗡️ Attack the nearest enemy';

  // Option 2: Defensive action
  const opt2 = '🛡️ Dodge';

  // Option 3: Context-specific (spell > special ability > environment)
  let opt3;
  const hasSlots = player.spellSlots && Object.entries(player.spellSlots).some(([, v]) => v > 0);
  if (hasSlots && player.spells?.length > 0) {
    // Find highest-level available spell
    const availableSpells = player.spells.filter(s => {
      if (s.level === 0) return true; // cantrips always available
      return player.spellSlots[s.level] > 0;
    });
    const bestSpell = availableSpells.sort((a, b) => (b.level || 0) - (a.level || 0))[0];
    if (bestSpell) {
      const role = targetAuthority.spellTargetRole(bestSpell, bestSpell.name);
      if (role === 'enemy') {
        opt3 = nearestEnemy ? `🔥 Cast ${bestSpell.name} at ${nearestEnemy.name}` : `🔥 Cast ${bestSpell.name}`;
      } else if (role === 'self') {
        opt3 = `🔥 Cast ${bestSpell.name}`;
      } else {
        const supportTargetId = targetAuthority.defaultSupportTargetId(combatants, player.id);
        const supportTarget = combatants[supportTargetId] || player;
        opt3 = `🔥 Cast ${bestSpell.name} on ${supportTarget.name}`;
      }
    } else {
      opt3 = nearestEnemy
        ? `🤝 Help an exposed ally against ${nearestEnemy.name}`
        : '🤝 Help an exposed ally';
    }
  } else if (player.features?.some(f => /extra attack|action surge|sneak attack|rage|wild shape/i.test(f))) {
    const feature = player.features.find(f => /extra attack|action surge|sneak attack|rage|wild shape/i.test(f));
    opt3 = `🔥 Use ${feature}`;
  } else {
    opt3 = nearestEnemy
      ? `🤝 Help an exposed ally against ${nearestEnemy.name}`
      : '🤝 Help an exposed ally';
  }

  const seen = new Set();
  return [...standardOptions, opt1, opt2, opt3]
    .filter(option => {
      const key = String(option || '')
        .toLowerCase()
        .replace(/^[^\w]+/, '')
        .replace(/[.!,;:]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
}

module.exports = {
  getTemplate,
  substituteVariables,
  pickTemplate,
  getEventDescription,
  assembleCombatNarration,
  mapResultToTemplate,
  generateCombatOptions,
  generateTemplates,
  GENERIC_TEMPLATES,
  EVENT_VARIABLES,
  EVENT_DESCRIPTIONS,
  // Exposed for testing
  _templateCache: templateCache,
  _generationInFlight: generationInFlight,
};
