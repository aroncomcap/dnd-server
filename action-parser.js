'use strict';

const llm = require('./llm');

// ---------------------------------------------------------------------------
// Fuzzy matching helpers
// ---------------------------------------------------------------------------

/**
 * Score how well `query` matches `name`.
 * Returns a positive number (higher = better) or 0 if no match.
 */
function fuzzyScore(query, name) {
  const q = query.toLowerCase().trim();
  const n = name.toLowerCase().trim();
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.startsWith(q) || q.startsWith(n)) return 80;
  if (n.includes(q) || q.includes(n)) return 60;
  // Word overlap
  const qWords = q.split(/\s+/);
  const nWords = n.split(/[\s\-_]+/);
  const overlap = qWords.filter(w => nWords.some(nw => nw.includes(w) || w.includes(nw)));
  if (overlap.length > 0) return 20 * overlap.length;
  return 0;
}

/**
 * Find the best matching combatant id for a name query.
 * When typeFilter is provided, prefer combatants of that type but fall back to any.
 */
function findCombatantId(query, combatants, typeFilter = null) {
  if (!query) return null;
  const q = query.toLowerCase().trim();

  // Direct id match
  if (combatants[q]) return q;

  let best = null;
  let bestScore = 0;

  for (const [id, c] of Object.entries(combatants)) {
    const score = Math.max(fuzzyScore(q, c.name), fuzzyScore(q, id));
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }

  if (bestScore === 0) return null;

  // If typeFilter is given, check if there's a same-type match and prefer it
  if (typeFilter) {
    let typeBest = null;
    let typeBestScore = 0;
    for (const [id, c] of Object.entries(combatants)) {
      if (c.type !== typeFilter) continue;
      const score = Math.max(fuzzyScore(q, c.name), fuzzyScore(q, id));
      if (score > typeBestScore) {
        typeBestScore = score;
        typeBest = id;
      }
    }
    if (typeBest && typeBestScore >= bestScore * 0.6) return typeBest;
  }

  return best;
}

/**
 * Find the first enemy combatant id.
 */
function firstEnemyId(combatants) {
  for (const [id, c] of Object.entries(combatants)) {
    const hp = c.hp ?? c.totalHp ?? c.maxHp;
    if (c.type === 'Enemy' && (hp === undefined || hp > 0)) return id;
  }
  return null;
}

function resolveTargetQuery(query, combatants, typeFilter = 'Enemy') {
  const targetId = findCombatantId(query, combatants, typeFilter);
  if (targetId) return targetId;
  if (/\b(?:it|them|enemy|foe|monster|creature|presence|thing|undead|threat)\b/i.test(query || '')) {
    return firstEnemyId(combatants);
  }
  return null;
}

/**
 * Fuzzy-match a weapon name from an array of weapon objects [{name}].
 */
function findWeapon(query, weapons) {
  if (!weapons || weapons.length === 0) return null;
  if (!query) return weapons[0].name;
  let best = null;
  let bestScore = 0;
  for (const w of weapons) {
    const score = fuzzyScore(query, w.name);
    if (score > bestScore) {
      bestScore = score;
      best = w.name;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * Fuzzy-match a spell name from an array of spell objects [{name}].
 */
function findSpell(query, spells) {
  if (!spells || spells.length === 0) return null;
  if (!query) return spells[0].name;
  let best = null;
  let bestScore = 0;
  for (const s of spells) {
    const score = fuzzyScore(query, s.name);
    if (score > bestScore) {
      bestScore = score;
      best = s.name;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * Find the first healing spell from a spells array.
 * Heuristic: spell name contains "heal", "cure", "mend", "restore".
 */
function findHealingSpell(spells) {
  if (!spells || spells.length === 0) return null;
  const healWords = ['heal', 'cure', 'mend', 'restore'];
  for (const s of spells) {
    const n = s.name.toLowerCase();
    if (healWords.some(w => n.includes(w))) return s.name;
  }
  return null;
}

function isHealingSpell(spell) {
  if (!spell) return false;
  const n = String(spell.name || '').toLowerCase();
  return !!(spell.healing || spell.effect === 'heal' || spell.type === 'heal' || /\b(?:heal|cure|mend|restore|healing word|lay on hands)\b/.test(n));
}

function isOffensiveSpell(spell, query = '') {
  if (!spell) return false;
  const text = `${spell.name || ''} ${query || ''}`.toLowerCase();
  return !!(
    spell.damage ||
    spell.attack ||
    spell.save ||
    spell.type === 'damage' ||
    /\b(?:acid splash|burning hands|chill touch|chromatic orb|dissonant whispers|eldritch blast|fire bolt|fireball|guiding bolt|heat metal|inflict wounds|lightning bolt|magic missile|moonbeam|ray of frost|sacred flame|scorching ray|shatter|spirit guardians|toll the dead|vicious mockery)\b/.test(text)
  );
}

function defaultSpellTarget(spell, spellQuery, combatants, playerId) {
  if (isHealingSpell(spell)) return playerId;
  if (isOffensiveSpell(spell, spellQuery)) return firstEnemyId(combatants);
  return playerId;
}

function isFeatureAction(text) {
  return /\b(?:channel divinity|second wind|action surge|rage|reckless attack|wild shape|lay on hands|flurry of blows|stunning strike|bardic inspiration|turn undead|invoke duplicity)\b/i.test(text || '');
}

function isCheckAction(text) {
  return /\b(?:check|checks|checking|inspect|inspects|inspecting|investigate|investigates|investigating|search|searches|searching|examine|examines|examining|study|studies|studying|observe|observes|observing|look|looks|looking|listen|listens|listening|scan|scans|scanning|open|opens|opening|touch|touches|touching|test|tests|testing|secure|secures|securing|disarm|disarms|disarming|track|tracks|tracking|follow|follows|following)\b/i.test(text || '');
}

function makeCheckAction(raw, playerId) {
  return {
    type: 'check',
    actorId: playerId,
    attackerId: playerId,
    targetId: null,
    description: raw,
  };
}

// ---------------------------------------------------------------------------
// Strip emoji prefix from option strings
// ---------------------------------------------------------------------------

function stripEmoji(str) {
  // Remove leading emoji characters and whitespace
  return str.replace(/^[\p{Emoji}\s]+/u, '').trim();
}

// ---------------------------------------------------------------------------
// parseAction
// ---------------------------------------------------------------------------

/**
 * Tier 1 pattern-matching action parser.
 * @param {string} input
 * @param {string} playerId
 * @param {object} ctx  { combatants, preTaggedOptions }
 * @returns {object|null} structured action or null
 */
function parseAction(input, playerId, ctx) {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim();
  const lower = raw.toLowerCase();
  const combatants = ctx.combatants || {};
  const preTaggedOptions = ctx.preTaggedOptions || null;
  const player = combatants[playerId] || {};
  const weapons = player.weapons || [];
  const spells = player.spells || [];

  // --- 1. Option numbers ---
  if (preTaggedOptions && /^[123]$/.test(raw)) {
    const idx = parseInt(raw, 10) - 1;
    const option = preTaggedOptions[idx];
    if (option) {
      return { ...option, attackerId: playerId, actorId: option.actorId || option.attackerId || playerId };
    }
  }

  // --- 2. Simple actions ---
  const simpleActions = ['dodge', 'disengage', 'dash', 'help'];
  for (const action of simpleActions) {
    if (lower === action || lower.startsWith(action + ' ')) {
      return { type: action, actorId: playerId, attackerId: playerId };
    }
  }

  if (isFeatureAction(raw)) {
    return { type: 'feature', actorId: playerId, attackerId: playerId, targetId: firstEnemyId(combatants), description: raw };
  }

  // --- 3. Attack with weapon: "attack/strike/hit/slash/stab <target> with <weapon>" ---
  const attackWithWeaponOnlyRe = /^(?:attack|strike|hit|slash|stab|shoot)\s+with\s+(.+)$/i;
  const awom = raw.match(attackWithWeaponOnlyRe);
  if (awom) {
    const weaponQuery = awom[1].trim();
    const targetId = firstEnemyId(combatants);
    const weapon = findWeapon(weaponQuery, weapons) || findWeapon(null, weapons);
    return { type: 'attack', attackerId: playerId, targetId, weapon };
  }

  const attackWithWeaponRe = /^(?:attack|strike|hit|slash|stab|shoot)\s+(.+?)\s+with\s+(.+)$/i;
  const awm = raw.match(attackWithWeaponRe);
  if (awm) {
    const targetQuery = awm[1].trim();
    const weaponQuery = awm[2].trim();
    const targetId = resolveTargetQuery(targetQuery, combatants, 'Enemy');
    const weapon = findWeapon(weaponQuery, weapons) || findWeapon(null, weapons);
    return { type: 'attack', attackerId: playerId, targetId, weapon };
  }

  // --- 4. Attack (no weapon): "attack/strike/hit/slash/stab <target>" ---
  const attackRe = /^(?:attack|strike|hit|slash|stab|shoot)\s+(.+)$/i;
  const am = raw.match(attackRe);
  if (am) {
    const targetQuery = am[1].trim();
    const targetId = resolveTargetQuery(targetQuery, combatants, 'Enemy');
    const weapon = weapons.length > 0 ? weapons[0].name : null;
    return { type: 'attack', attackerId: playerId, targetId, weapon };
  }

  // --- 5. Cast on target: "cast <spell> on/at <target>" ---
  const castOnRe = /^cast\s+(.+?)\s+(?:on|at)\s+(.+)$/i;
  const com = raw.match(castOnRe);
  if (com) {
    const spellQuery = com[1].trim();
    const targetQuery = com[2].trim();
    const spell = findSpell(spellQuery, spells);
    const targetId = resolveTargetQuery(targetQuery, combatants, 'Enemy') || defaultSpellTarget(spells.find(s => s.name === spell), spellQuery, combatants, playerId);
    return { type: 'spell', attackerId: playerId, spell, targetId };
  }

  // --- 6. Cast (self): "cast <spell>" ---
  const castRe = /^cast\s+(.+)$/i;
  const cm = raw.match(castRe);
  if (cm) {
    const spellQuery = cm[1].trim();
    const spell = findSpell(spellQuery, spells);
    const spellObj = (spells || []).find(s => s.name === spell);
    return { type: 'spell', attackerId: playerId, spell, targetId: defaultSpellTarget(spellObj, spellQuery, combatants, playerId) };
  }

  // --- 7. Heal: "heal <target>" ---
  const healRe = /^heal\s+(.+)$/i;
  const hm = raw.match(healRe);
  if (hm) {
    const targetQuery = hm[1].trim();
    const targetId = findCombatantId(targetQuery, combatants) || playerId;
    const spell = findHealingSpell(spells);
    return { type: 'spell', attackerId: playerId, spell, targetId };
  }

  // --- 8. Exploration / interaction in combat ---
  if (isCheckAction(raw)) {
    return makeCheckAction(raw, playerId);
  }

  // --- 9. Unparseable ---
  return null;
}

// ---------------------------------------------------------------------------
// parseOptions
// ---------------------------------------------------------------------------

/**
 * Parse an array of 3 AI-generated option strings into tagged actions.
 * @param {string[]} options  Array of 3 option strings
 * @param {string}   playerId
 * @param {object}   ctx
 * @returns {Array}  Array of 3 parsed actions (some may be null)
 */
function parseOptions(options, playerId, ctx) {
  const combatants = ctx.combatants || {};
  const player = combatants[playerId] || {};
  const weapons = player.weapons || [];
  const spells = player.spells || [];

  return options.map(opt => {
    if (!opt) return null;
    // Strip emoji prefix
    const clean = stripEmoji(opt);

    // Try parseAction first
    const parsed = parseAction(clean, playerId, { ...ctx, preTaggedOptions: null });
    if (parsed) return parsed;

    // Fallback heuristics
    const lower = clean.toLowerCase();

    if (/dodge|defend|shield/.test(lower)) {
      return { type: 'dodge', actorId: playerId, attackerId: playerId };
    }
    if (isFeatureAction(clean)) {
      return { type: 'feature', actorId: playerId, attackerId: playerId, targetId: firstEnemyId(combatants), description: clean };
    }
    if (isCheckAction(clean)) {
      return makeCheckAction(clean, playerId);
    }
    if (/attack|strike|slash/.test(lower)) {
      const targetId = firstEnemyId(combatants);
      const weapon = weapons.length > 0 ? weapons[0].name : null;
      return { type: 'attack', attackerId: playerId, targetId, weapon };
    }
    if (/cast|spell|magic/.test(lower)) {
      const spell = spells.length > 0 ? spells[0].name : null;
      const spellObj = (spells || []).find(s => s.name === spell);
      const targetId = defaultSpellTarget(spellObj, clean, combatants, playerId);
      return { type: 'spell', attackerId: playerId, spell, targetId };
    }

    return null;
  });
}

// ---------------------------------------------------------------------------
// parseActionWithAI
// ---------------------------------------------------------------------------

/**
 * Tier 2 AI-assisted action parser using the configured LLM layer.
 * @param {string} input
 * @param {string} playerId
 * @param {object} ctx
 * @param {object} _legacyClient  Ignored legacy client parameter.
 * @returns {Promise<object>} parsed action (never null — has fallback)
 */
async function parseActionWithAI(input, playerId, ctx, _legacyClient) {
  const combatants = ctx.combatants || {};
  const player = combatants[playerId] || {};
  const weapons = (player.weapons || []).map(w => w.name);
  const spells = (player.spells || []).map(s => s.name);
  const enemies = Object.values(combatants)
    .filter(c => c.type === 'Enemy')
    .map(c => ({ id: c.id, name: c.name }));
  const allies = Object.values(combatants)
    .filter(c => c.id !== playerId && c.type !== 'Enemy')
    .map(c => ({ id: c.id, name: c.name }));

  const tier1 = parseAction(input, playerId, ctx);
  if (tier1) return tier1;

  const prompt = `You are a D&D combat assistant. Parse the player's action into JSON.

Player "${playerId}" wants to: "${input}"

Available weapons: ${weapons.length ? weapons.join(', ') : 'none'}
Available spells: ${spells.length ? spells.join(', ') : 'none'}
Enemies: ${enemies.map(e => `${e.name} (id: ${e.id})`).join(', ') || 'none'}
Allies: ${allies.map(a => `${a.name} (id: ${a.id})`).join(', ') || 'none'}

Respond with ONLY valid JSON (no markdown, no explanation):
{"type":"attack"|"spell"|"dodge"|"disengage"|"dash"|"help"|"check"|"feature","targetId":"id or null","weapon":"name or null","spell":"name or null","notes":"brief description"}`;

  try {
    const response = await llm.completeText({
      task: 'action-parse',
      prompt,
      maxTokens: 150,
      temperature: 0,
      gameId: ctx.gameId,
    });

    const text = response.text.trim();
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        type: parsed.type || 'check',
        attackerId: playerId,
        actorId: playerId,
        targetId: parsed.targetId || null,
        weapon: parsed.weapon || null,
        spell: parsed.spell || null,
        notes: parsed.notes || null,
        description: parsed.notes || input,
      };
    }
  } catch (_err) {
    // Fall through to default
  }

  return makeCheckAction(input, playerId);
}

// ---------------------------------------------------------------------------
// parseOptionsWithAI
// ---------------------------------------------------------------------------

/**
 * AI-powered option parsing — one cheap structured-model call for all 3 options.
 * @param {string[]} options  Array of 3 option strings
 * @param {string}   playerId
 * @param {object}   ctx
 * @param {object}   _legacyClient  Ignored legacy client parameter.
 * @returns {Promise<Array>} Array of 3 parsed actions
 */
async function parseOptionsWithAI(options, playerId, ctx, _legacyClient) {
  const combatants = ctx.combatants || {};
  const player = combatants[playerId] || {};
  const weapons = (player.weapons || []).map(w => w.name);
  const spells = (player.spells || []).map(s => s.name);
  const enemies = Object.values(combatants)
    .filter(c => c.type === 'Enemy')
    .map(c => ({ id: c.id, name: c.name }));
  const allies = Object.values(combatants)
    .filter(c => c.id !== playerId && c.type !== 'Enemy')
    .map(c => ({ id: c.id, name: c.name }));

  const optionsList = options
    .map((o, i) => `${i + 1}. "${stripEmoji(o || '')}"`)
    .join('\n');

  const prompt = `You are a D&D combat assistant. Parse each option into JSON.

Player "${playerId}" has these 3 options:
${optionsList}

Available weapons: ${weapons.length ? weapons.join(', ') : 'none'}
Available spells: ${spells.length ? spells.join(', ') : 'none'}
Enemies: ${enemies.map(e => `${e.name} (id: ${e.id})`).join(', ') || 'none'}
Allies: ${allies.map(a => `${a.name} (id: ${a.id})`).join(', ') || 'none'}

Respond with ONLY a JSON array of 3 objects (no markdown, no explanation):
[
  {"type":"attack"|"spell"|"dodge"|"disengage"|"dash"|"help"|"check"|"feature","targetId":"id or null","weapon":"name or null","spell":"name or null"},
  {"type":...},
  {"type":...}
]`;

  try {
    const response = await llm.completeText({
      task: 'action-parse',
      prompt,
      maxTokens: 300,
      temperature: 0,
      gameId: ctx.gameId,
    });

    const text = response.text.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed) && parsed.length === 3) {
        return parsed.map(p => ({
          type: p.type || 'check',
          attackerId: playerId,
          actorId: playerId,
          targetId: p.targetId || null,
          weapon: p.weapon || null,
          spell: p.spell || null,
          description: p.notes || null,
        }));
      }
    }
  } catch (_err) {
    // Fall through to fallback
  }

  // Fallback: parse each option individually; never coerce unclear options into attacks.
  return options.map(opt => {
    const clean = stripEmoji(opt || '');
    return parseAction(clean, playerId, { ...ctx, preTaggedOptions: null }) ||
      makeCheckAction(clean || 'assess the situation', playerId);
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { parseAction, parseOptions, parseActionWithAI, parseOptionsWithAI };
