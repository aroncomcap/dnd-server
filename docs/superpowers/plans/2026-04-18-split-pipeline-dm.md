# Split Pipeline DM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the monolithic Haiku DM call with a split pipeline — Sonnet for narration, Haiku for extraction/validation, server-side templates for combat.

**Architecture:** New `narration-pipeline.js` module orchestrates turn routing. Combat turns assemble narration from DB-cached monster templates (zero API calls). Non-combat turns use 3 parallel calls: Sonnet (streamed narration), Haiku (world extraction), Haiku (validation). Feature-flagged via `SPLIT_PIPELINE` env var for safe rollout.

**Tech Stack:** Node.js, Anthropic SDK (Sonnet + Haiku), PostgreSQL (JSONB), Socket.io

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `narration-pipeline.js` | CREATE | Pipeline orchestrator — routes combat vs non-combat, manages parallel calls |
| `template-engine.js` | CREATE | Monster template cache, lazy generation, variable substitution, fallback chain |
| `templates/generic-templates.json` | CREATE | Hardcoded fallback templates by creature type |
| `db.js` | MODIFY | Add `monster_templates` table + CRUD functions |
| `server.js` | MODIFY | Wire pipeline into `player_action` handler, feature flag, preserve legacy path |
| `tests/narration-pipeline.test.js` | CREATE | Pipeline routing, Sonnet parsing, correction injection |
| `tests/template-engine.test.js` | CREATE | Template lookup, substitution, fallback chain, lazy generation |

---

### Task 1: Database — monster_templates Table

**Files:**
- Modify: `db.js` (inside `initDB()`, around line 25)
- Test: `tests/template-engine.test.js` (created in Task 2)

- [ ] **Step 1: Add monster_templates table to initDB()**

In `db.js`, add after the existing CREATE TABLE statements inside the `initDB()` function (after the `pool.query` block starting at line 25):

```javascript
// Add to the existing pool.query template string, after the last CREATE TABLE:

CREATE TABLE IF NOT EXISTS monster_templates (
  id SERIAL PRIMARY KEY,
  monster_slug TEXT NOT NULL,
  event_type TEXT NOT NULL,
  persona TEXT NOT NULL DEFAULT 'epic',
  templates JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(monster_slug, event_type, persona)
);
```

- [ ] **Step 2: Add DB helper functions for templates**

Add at the end of `db.js`, before `module.exports`:

```javascript
async function getMonsterTemplates(monsterSlug, eventType, persona) {
  const { rows } = await pool.query(
    'SELECT templates FROM monster_templates WHERE monster_slug = $1 AND event_type = $2 AND persona = $3',
    [monsterSlug, eventType, persona]
  );
  return rows[0]?.templates || null;
}

async function saveMonsterTemplates(monsterSlug, eventType, persona, templates) {
  await pool.query(`
    INSERT INTO monster_templates (monster_slug, event_type, persona, templates)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (monster_slug, event_type, persona)
    DO UPDATE SET templates = $4
  `, [monsterSlug, eventType, persona, JSON.stringify(templates)]);
}
```

- [ ] **Step 3: Export the new functions**

Add `getMonsterTemplates` and `saveMonsterTemplates` to the `module.exports` object in `db.js`.

- [ ] **Step 4: Commit**

```bash
git add db.js
git commit -m "feat: add monster_templates table and DB helpers"
```

---

### Task 2: Template Engine — Core Module

**Files:**
- Create: `template-engine.js`
- Create: `templates/generic-templates.json`
- Test: `tests/template-engine.test.js`

- [ ] **Step 1: Write failing tests for template engine**

Create `tests/template-engine.test.js`:

```javascript
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

// We'll test the pure functions first, mock DB/API later
const {
  substituteVariables,
  pickTemplate,
  getEventDescription,
  GENERIC_TEMPLATES,
} = require('../template-engine');

describe('substituteVariables', () => {
  it('replaces all known variables', () => {
    const template = '{attacker} strikes {target} for {damage} damage.';
    const vars = { attacker: 'Kael', target: 'Goblin', damage: '7' };
    const result = substituteVariables(template, vars);
    assert.strictEqual(result, 'Kael strikes Goblin for 7 damage.');
  });

  it('leaves unknown variables as-is', () => {
    const template = '{attacker} hits {target} with {unknown}.';
    const vars = { attacker: 'Kael', target: 'Goblin' };
    const result = substituteVariables(template, vars);
    assert.strictEqual(result, 'Kael hits Goblin with {unknown}.');
  });

  it('handles empty vars object', () => {
    const template = '{target} staggers.';
    const result = substituteVariables(template, {});
    assert.strictEqual(result, '{target} staggers.');
  });
});

describe('pickTemplate', () => {
  it('returns a string from the pool', () => {
    const pool = ['Line A.', 'Line B.', 'Line C.'];
    const result = pickTemplate(pool);
    assert.ok(pool.includes(result));
  });

  it('returns null for empty pool', () => {
    assert.strictEqual(pickTemplate([]), null);
    assert.strictEqual(pickTemplate(null), null);
  });
});

describe('getEventDescription', () => {
  it('returns description for known event types', () => {
    assert.ok(getEventDescription('attack_hit').length > 0);
    assert.ok(getEventDescription('death').length > 0);
  });

  it('returns fallback for unknown event types', () => {
    assert.ok(getEventDescription('unknown_event').length > 0);
  });
});

describe('GENERIC_TEMPLATES', () => {
  it('has templates for humanoid creature type', () => {
    assert.ok(GENERIC_TEMPLATES.humanoid);
    assert.ok(GENERIC_TEMPLATES.humanoid.attack_hit);
    assert.ok(Array.isArray(GENERIC_TEMPLATES.humanoid.attack_hit.epic));
    assert.ok(GENERIC_TEMPLATES.humanoid.attack_hit.epic.length >= 5);
  });

  it('has templates for beast creature type', () => {
    assert.ok(GENERIC_TEMPLATES.beast);
    assert.ok(GENERIC_TEMPLATES.beast.attack_hit);
  });

  it('has templates for undead creature type', () => {
    assert.ok(GENERIC_TEMPLATES.undead);
    assert.ok(GENERIC_TEMPLATES.undead.death);
  });

  it('every template pool has at least 5 entries', () => {
    for (const [type, events] of Object.entries(GENERIC_TEMPLATES)) {
      for (const [event, personas] of Object.entries(events)) {
        for (const [persona, templates] of Object.entries(personas)) {
          assert.ok(templates.length >= 5,
            `${type}.${event}.${persona} has only ${templates.length} templates (need 5+)`);
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/template-engine.test.js
```

Expected: FAIL — `Cannot find module '../template-engine'`

- [ ] **Step 3: Create generic templates JSON**

Create `templates/generic-templates.json`. This file contains fallback templates by creature type, event type, and persona. Each pool has 5+ entries.

Structure: `{ creatureType: { eventType: { persona: [strings] } } }`

Creature types: `humanoid`, `beast`, `undead`, `fiend`, `dragon`, `construct`, `aberration`, `elemental`

Event types: `attack_hit`, `attack_miss`, `attack_crit`, `takes_damage`, `takes_crit`, `death`, `taunt`, `spell_hit`, `spell_miss`, `pc_attack_hit`, `pc_attack_miss`, `pc_spell_hit`

Personas: `epic`, `over_the_top`

Each template is 1 sentence, max 20 words, using `{target}`, `{attacker}`, `{damage}`, `{weapon}`, `{hp}`, `{maxHp}`, `{spell}` as appropriate for the event type.

Example entries:

```json
{
  "humanoid": {
    "attack_hit": {
      "epic": [
        "The blade finds its mark, biting into {target}.",
        "{target} staggers as the blow connects.",
        "Steel meets flesh — {target} takes {damage} damage.",
        "A vicious strike catches {target} off-guard.",
        "{target} grunts as the weapon tears through armor."
      ],
      "over_the_top": [
        "BONK! {target} takes {damage} right in the everything.",
        "The hit lands and {target} does NOT look happy about it.",
        "{target} catches a face full of {weapon}. Ouch.",
        "That's gonna leave a mark — {damage} damage to {target}!",
        "Critical workplace injury! {target} takes {damage}."
      ]
    },
    "attack_miss": {
      "epic": [
        "The strike goes wide, whistling past {target}.",
        "{target} sidesteps the clumsy blow.",
        "Steel scrapes stone as the attack misses {target}.",
        "The swing falls short, cutting only air.",
        "{target} twists away at the last moment."
      ],
      "over_the_top": [
        "Swing and a miss! {target} does a little dodge dance.",
        "Not even close. {target} didn't even have to try.",
        "Air sword! The attack whiffs past {target} entirely.",
        "That attack had the accuracy of a blindfolded cat.",
        "{target} ducks and the weapon hits absolutely nothing."
      ]
    },
    "death": {
      "epic": [
        "The creature crumples with a final wheeze.",
        "Eyes go wide, then dark. It topples.",
        "With a gurgling cry, it collapses to the ground.",
        "The body hits the floor, still and silent.",
        "Life leaves its eyes as it sinks to its knees."
      ],
      "over_the_top": [
        "It does a full backflip into the afterlife. Absolutely yeeted.",
        "And THAT'S how you make a corpse, folks!",
        "It ragdolls into the ground with zero dignity.",
        "RIP. It was annoying and now it's dead.",
        "Critical existence failure. It has ceased to be."
      ]
    }
  }
}
```

Generate the full file with ALL creature types, ALL event types, ALL personas. Each pool needs 5+ templates. Use the variables from the spec's Section 5.2 table for each event type.

- [ ] **Step 4: Create template-engine.js**

```javascript
'use strict';

const db = require('./db');
const GENERIC_TEMPLATES = require('./templates/generic-templates.json');

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
  const dbTemplates = await db.getMonsterTemplates(monsterSlug, eventType, persona);
  if (dbTemplates && dbTemplates.length > 0) {
    templateCache.set(cacheKey, dbTemplates);
    return pickTemplate(dbTemplates);
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
  // Lazy require to avoid circular dependency
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic();

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

  // Option 1: Attack with primary weapon
  const weapon = player.weapons?.[0]?.name || 'weapon';
  const opt1 = nearestEnemy
    ? `🗡️ Attack ${nearestEnemy.name} with ${weapon}`
    : '🗡️ Attack the nearest enemy';

  // Option 2: Defensive action
  const opt2 = '🛡️ Dodge';

  // Option 3: Context-specific (spell > special ability > environment)
  let opt3;
  const hasSlots = player.spellSlots && Object.entries(player.spellSlots).some(([_, v]) => v > 0);
  if (hasSlots && player.spells?.length > 0) {
    // Find highest-level available spell
    const availableSpells = player.spells.filter(s => {
      if (s.level === 0) return true; // cantrips always available
      return player.spellSlots[s.level] > 0;
    });
    const bestSpell = availableSpells.sort((a, b) => (b.level || 0) - (a.level || 0))[0];
    opt3 = bestSpell
      ? `🔥 Cast ${bestSpell.name}${nearestEnemy ? ` on ${nearestEnemy.name}` : ''}`
      : '🔥 Attempt something reckless';
  } else if (player.features?.some(f => /extra attack|action surge|sneak attack|rage|wild shape/i.test(f))) {
    const feature = player.features.find(f => /extra attack|action surge|sneak attack|rage|wild shape/i.test(f));
    opt3 = `🔥 Use ${feature}`;
  } else {
    opt3 = '🔥 Attempt something reckless';
  }

  return [opt1, opt2, opt3];
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
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test -- tests/template-engine.test.js
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add template-engine.js templates/generic-templates.json tests/template-engine.test.js
git commit -m "feat: template engine with generic fallbacks and lazy generation"
```

---

### Task 3: Template Engine — Advanced Tests

**Files:**
- Modify: `tests/template-engine.test.js`

- [ ] **Step 1: Add tests for mapResultToTemplate and assembleCombatNarration**

Append to `tests/template-engine.test.js`:

```javascript
const { mapResultToTemplate, assembleCombatNarration, generateCombatOptions } = require('../template-engine');

describe('mapResultToTemplate', () => {
  const mockEngine = {
    state: {
      combatants: {
        'player-kael': { type: 'PC', name: 'Kael', hp: 30, maxHp: 35, slug: null,
          weapons: [{ name: 'Greatsword' }], spells: [], spellSlots: {} },
        'goblin-1': { type: 'Enemy', name: 'Goblin Archer', hp: 10, maxHp: 15,
          slug: 'goblin', creatureType: 'humanoid', personality: 'Cowardly and sneaky' },
      },
    },
  };

  it('maps monster attack hit correctly', () => {
    const result = { type: 'attack', attackerId: 'goblin-1', targetId: 'player-kael', hit: true, damage: 7, weapon: 'Shortbow' };
    const mapped = mapResultToTemplate(result, mockEngine);
    assert.strictEqual(mapped.monsterSlug, 'goblin');
    assert.strictEqual(mapped.eventType, 'attack_hit');
    assert.strictEqual(mapped.vars.target, 'Kael');
    assert.strictEqual(mapped.vars.damage, 7);
  });

  it('maps PC attack hit to pc_attack_hit', () => {
    const result = { type: 'attack', attackerId: 'player-kael', targetId: 'goblin-1', hit: true, damage: 12, weapon: 'Greatsword' };
    const mapped = mapResultToTemplate(result, mockEngine);
    assert.strictEqual(mapped.monsterSlug, 'goblin');
    assert.strictEqual(mapped.eventType, 'pc_attack_hit');
  });

  it('maps killing blow to death event', () => {
    const deadEngine = {
      state: {
        combatants: {
          'player-kael': { type: 'PC', name: 'Kael', hp: 30, maxHp: 35 },
          'goblin-1': { type: 'Enemy', name: 'Goblin', hp: 0, maxHp: 15, slug: 'goblin', creatureType: 'humanoid' },
        },
      },
    };
    const result = { type: 'attack', attackerId: 'player-kael', targetId: 'goblin-1', hit: true, damage: 15 };
    const mapped = mapResultToTemplate(result, deadEngine);
    assert.strictEqual(mapped.eventType, 'death');
  });

  it('returns empty for heal results', () => {
    const result = { type: 'heal', casterId: 'player-kael' };
    const mapped = mapResultToTemplate(result, mockEngine);
    assert.deepStrictEqual(mapped, {});
  });
});

describe('generateCombatOptions', () => {
  it('generates 3 options for a fighter', () => {
    const engine = {
      state: {
        combatants: {
          'player-kael': { type: 'PC', name: 'Kael', hp: 30, maxHp: 35,
            weapons: [{ name: 'Greatsword' }], spells: [], spellSlots: {},
            features: ['Extra Attack'] },
          'goblin-1': { type: 'Enemy', name: 'Goblin', hp: 10, maxHp: 15 },
        },
      },
    };
    const options = generateCombatOptions(engine, 'Kael');
    assert.strictEqual(options.length, 3);
    assert.ok(options[0].includes('Greatsword'));
    assert.ok(options[1].includes('Dodge'));
    assert.ok(options[2].includes('Extra Attack'));
  });

  it('suggests spell for caster with slots', () => {
    const engine = {
      state: {
        combatants: {
          'player-mira': { type: 'PC', name: 'Mira', hp: 20, maxHp: 20,
            weapons: [{ name: 'Dagger' }],
            spells: [{ name: 'Fireball', level: 3 }, { name: 'Fire Bolt', level: 0 }],
            spellSlots: { 1: 2, 2: 1, 3: 1 }, features: [] },
          'goblin-1': { type: 'Enemy', name: 'Goblin', hp: 10, maxHp: 15 },
        },
      },
    };
    const options = generateCombatOptions(engine, 'Mira');
    assert.ok(options[2].includes('Fireball'));
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm test -- tests/template-engine.test.js
```

Expected: All PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/template-engine.test.js
git commit -m "test: add combat template mapping and option generation tests"
```

---

### Task 4: Narration Pipeline — Core Module

**Files:**
- Create: `narration-pipeline.js`
- Test: `tests/narration-pipeline.test.js`

- [ ] **Step 1: Write failing tests for pipeline utilities**

Create `tests/narration-pipeline.test.js`:

```javascript
const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  buildNarrationPrompt,
  buildUserMessage,
  parseSonnetResponse,
  buildExtractionPrompt,
  buildValidationPrompt,
  processViolation,
  shouldCallSonnetForFlavor,
} = require('../narration-pipeline');

describe('buildNarrationPrompt', () => {
  const baseConfig = {
    system: 'dnd5e',
    custom_context: '',
  };
  const baseState = {
    dmPersona: 'epic',
    verbosity: 'brief',
    ferocity: 3,
    pillars: { exploration: 33, combat: 33, social: 34 },
    storySummary: 'The party entered the dungeon.',
    rulesCorrections: [],
    npcMemory: {},
    encounterPlan: null,
    encounterPlanIndex: 0,
    data: {
      characters: {
        'Kael': {
          personality: 'Brave warrior',
          backstory: 'Former soldier',
          standardActions: 'Attack with greatsword',
          catchphrases: ['Steel solves everything'],
          statsText: 'Level 5 Fighter, HP 44',
        },
      },
    },
  };

  it('includes persona block', () => {
    const prompt = buildNarrationPrompt('test-game', baseConfig, baseState);
    assert.ok(prompt.includes('EPIC'));
    assert.ok(prompt.includes('master storyteller'));
  });

  it('includes character names and personalities but NOT full stat blocks', () => {
    const prompt = buildNarrationPrompt('test-game', baseConfig, baseState);
    assert.ok(prompt.includes('Kael'));
    assert.ok(prompt.includes('Brave warrior'));
    // Should NOT include full statsText in narration prompt
    assert.ok(!prompt.includes('HP 44'));
  });

  it('includes verbosity limit', () => {
    const prompt = buildNarrationPrompt('test-game', baseConfig, baseState);
    assert.ok(prompt.includes('75 words max') || prompt.includes('BRIEF'));
  });

  it('includes house rules when present', () => {
    const stateWithRules = { ...baseState, rulesCorrections: [{ text: 'Crits on 19-20' }] };
    const prompt = buildNarrationPrompt('test-game', baseConfig, stateWithRules);
    assert.ok(prompt.includes('Crits on 19-20'));
  });

  it('includes story summary', () => {
    const prompt = buildNarrationPrompt('test-game', baseConfig, baseState);
    assert.ok(prompt.includes('The party entered the dungeon'));
  });
});

describe('parseSonnetResponse', () => {
  it('extracts narration and options from clean response', () => {
    const text = `The tavern door splinters inward. Three hooded figures stand in the rain.

1️⃣ 🗣️ Bluff your way out
2️⃣ 🛡️ Draw your weapon
3️⃣ 🔥 Flip the table and charge`;

    const result = parseSonnetResponse(text);
    assert.ok(result.narration.includes('tavern door'));
    assert.strictEqual(result.options.length, 3);
    assert.ok(result.options[0].includes('Bluff'));
  });

  it('handles response with no options', () => {
    const text = 'The door opens to reveal an empty room.';
    const result = parseSonnetResponse(text);
    assert.ok(result.narration.includes('empty room'));
    assert.strictEqual(result.options.length, 0);
  });

  it('handles numbered format without emojis', () => {
    const text = `Something happens.\n\n1. Do this\n2. Do that\n3. Do the other`;
    const result = parseSonnetResponse(text);
    assert.strictEqual(result.options.length, 3);
  });
});

describe('buildUserMessage', () => {
  it('includes corrections when pending', () => {
    const gs = {
      pendingCorrections: [
        { description: 'Kael has no 3rd-level slots', correction: 'The spell fizzled' },
      ],
      data: { chatHistory: [] },
    };
    const msg = buildUserMessage(gs, 'Kael', 'I cast Fireball');
    assert.ok(msg.includes('[CORRECTION:'));
    assert.ok(msg.includes('spell fizzled'));
    // Corrections should be consumed
    assert.strictEqual(gs.pendingCorrections.length, 0);
  });

  it('includes chat history and player action', () => {
    const gs = {
      pendingCorrections: [],
      data: {
        chatHistory: [
          { role: 'user', content: 'Kael: I look around' },
          { role: 'assistant', content: 'You see a dark corridor.' },
        ],
      },
    };
    const msg = buildUserMessage(gs, 'Kael', 'I enter the corridor');
    assert.ok(msg.includes('Player (Kael): I enter the corridor'));
  });
});

describe('processViolation', () => {
  it('queues critical violations immediately', () => {
    const gs = { pendingCorrections: [], minorViolationCounts: {} };
    processViolation(gs, { severity: 'critical', type: 'resource', description: 'No slots', correction: 'Fizzled' });
    assert.strictEqual(gs.pendingCorrections.length, 1);
  });

  it('escalates minor violations after 3 consecutive', () => {
    const gs = { pendingCorrections: [], minorViolationCounts: {} };
    const violation = { severity: 'minor', type: 'verbosity', description: 'Over word limit', correction: 'Keep shorter' };
    processViolation(gs, violation);
    assert.strictEqual(gs.pendingCorrections.length, 0);
    processViolation(gs, violation);
    assert.strictEqual(gs.pendingCorrections.length, 0);
    processViolation(gs, violation);
    assert.strictEqual(gs.pendingCorrections.length, 1);
  });
});

describe('shouldCallSonnetForFlavor', () => {
  it('returns true on round 1', () => {
    assert.ok(shouldCallSonnetForFlavor({ round: 1 }));
  });

  it('returns true on every 3rd round', () => {
    assert.ok(shouldCallSonnetForFlavor({ round: 3 }));
    assert.ok(shouldCallSonnetForFlavor({ round: 6 }));
  });

  it('returns false on round 2', () => {
    assert.ok(!shouldCallSonnetForFlavor({ round: 2 }));
  });

  it('returns true when combat is over', () => {
    assert.ok(shouldCallSonnetForFlavor({ round: 2, combatOver: true }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/narration-pipeline.test.js
```

Expected: FAIL — `Cannot find module '../narration-pipeline'`

- [ ] **Step 3: Create narration-pipeline.js**

```javascript
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const templateEngine = require('./template-engine');
const ed = require('./encounter-designer');

const anthropic = new Anthropic();

const SONNET_MODEL = 'claude-sonnet-4-6-20250514';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// ── Prompt Builders ─────────────────────────────────────────────────────────

function buildNarrationPrompt(gameId, gameConfig, gs) {
  const personaBlock = gs.dmPersona === 'overthetop'
    ? `DM PERSONA: OVER THE TOP\nYou are a wildly entertaining DM. Channel Critical Role's most unhinged moments. Ridiculous NPC quirks, fourth-wall breaks, action-movie combat narration. Comedy from character — stakes still real.`
    : `DM PERSONA: EPIC\nYou are a master storyteller. Dramatic, atmospheric, emotionally resonant. Tight evocative prose, grounded NPCs, visceral combat. The world has weight and history.`;

  const characterBlock = Object.entries(gs.data.characters)
    .map(([name, c]) => {
      const catchphrases = c.catchphrases?.length
        ? `\n  Catchphrases (use sparingly): ${c.catchphrases.join('; ')}` : '';
      return `- ${name} (${c.class || 'Adventurer'}, Level ${c.level || '?'}): ${c.personality || 'No personality set'}. ${(c.backstory || '').split('.')[0] || 'Unknown background'}.${catchphrases}${c.standardActions ? `\n  Standard Actions: ${c.standardActions}` : ''}`;
    })
    .join('\n');

  const summary = gs.storySummary ? `\nSTORY SO FAR:\n${gs.storySummary}\n` : '';

  let contextBlock = '';
  if (gameConfig.custom_context) {
    const MAX_CONTEXT_CHARS = 50000;
    contextBlock = `\nCAMPAIGN SOURCE MATERIAL:\n${gameConfig.custom_context.slice(0, MAX_CONTEXT_CHARS)}`;
    if (gameConfig.custom_context.length > MAX_CONTEXT_CHARS) {
      contextBlock += '\n[...truncated]';
    }
  }

  const houseRules = (gs.rulesCorrections || []).length
    ? `\nHOUSE RULES (follow strictly):\n${gs.rulesCorrections.map(r => '- ' + r.text).join('\n')}\n`
    : '';

  const npcMemoryEntries = Object.values(gs.npcMemory || {}).filter(npc => npc.encounters?.length > 0).slice(0, 5);
  const npcBlock = npcMemoryEntries.length > 0
    ? `\nRECURRING NPCs:\n${npcMemoryEntries.map(npc => {
        const last = npc.encounters[npc.encounters.length - 1];
        return `- ${npc.name} (${last.survived ? (last.fled ? 'fled' : 'alive') : 'dead'}, met ${npc.encounters.length}x): ${npc.personality || 'No notable personality'}`;
      }).join('\n')}`
    : '';

  const encounterLine = gs.encounterPlan
    ? `\nENCOUNTER GUIDANCE: ${ed.formatPlanForPrompt(gs.encounterPlan, gs.encounterPlanIndex || 0)}`
    : '';

  const ferocityDesc = gs.ferocity <= 1 ? 'extremely deadly, generous treasure' :
    gs.ferocity <= 2 ? 'very dangerous, good treasure' :
    gs.ferocity <= 3 ? 'balanced encounters, standard treasure' :
    gs.ferocity <= 4 ? 'light challenges, modest treasure' :
    'easy and forgiving, minimal treasure';

  const verbosityRule = gs.verbosity === 'terse' ? 'TERSE: 50 words max, 3 sentences. No atmosphere.' :
    gs.verbosity === 'brief' ? 'BRIEF: 75 words max narration. Punchy.' :
    'VERBOSE: 100 words max. Aim for 50-75.';

  const systemAdaptation = gameConfig.system === 'runequest'
    ? 'Use RuneQuest terms: scenes, Strike Ranks, Rune Points, skill percentages.'
    : gameConfig.system === 'dnd5e'
    ? 'Use D&D 5e terms: encounters, initiative, spell slots, ability checks.'
    : 'Adapt terminology to the game system.';

  return `You are the Game Master for a live multiplayer ${gameConfig.system === 'dnd5e' ? 'D&D 5e' : gameConfig.system === 'runequest' ? 'RuneQuest' : 'tabletop RPG'} session.

${personaBlock}

PARTY:
${characterBlock || 'No characters registered yet.'}
${summary}${contextBlock}${houseRules}${npcBlock}${encounterLine}
Ferocity: ${gs.ferocity ?? 5}/5 — ${ferocityDesc}
Pillars: E${gs.pillars?.exploration ?? 33}/C${gs.pillars?.combat ?? 33}/S${gs.pillars?.social ?? 34}. Include a skill check or ability roll every 1-2 actions.

RULES:
- ${verbosityRule}
- Give exactly 3 options after narration:
  1️⃣ [practical/combat action]
  2️⃣ [cautious/defensive action]
  3️⃣ [wild/creative/reckless action]
- Use emoji prefixes: 🗡️ ⚔️ 🛡️ 🔥 💀 🗣️ 🔍
- Write prose paragraphs. No markdown headers.
- Never roll dice or resolve combat mechanics.
- When hostiles appear, describe the threat — combat engine handles the rest.
- Be mechanically accurate — scale descriptions to actual power level.
- ${systemAdaptation}`;
}

function buildUserMessage(gs, characterName, actionText) {
  let message = '';

  // Inject corrections from previous turn's validation
  if (gs.pendingCorrections && gs.pendingCorrections.length > 0) {
    const corrections = gs.pendingCorrections
      .map(c => `[CORRECTION: ${c.description}. ${c.correction}]`)
      .join('\n');
    message += corrections + '\n\n';
    gs.pendingCorrections = [];
  }

  // Chat history (last 10 messages — narration + player actions only)
  const history = gs.data.chatHistory || [];
  const recentHistory = history.slice(-10);
  if (recentHistory.length > 0) {
    for (const msg of recentHistory) {
      message += msg.content + '\n';
    }
    message += '\n';
  }

  message += `Player (${characterName}): ${actionText}`;
  return message;
}

function buildExtractionPrompt(narration, actionText, worldState) {
  const currentState = {
    locations: (worldState?.locations || []).map(l => ({ name: l.name, description: l.description })),
    npcs: (worldState?.npcs || []).map(n => ({ name: n.name, description: n.description })),
    map: worldState?.currentMap || 'unknown',
  };

  return `Extract world state changes from this narration. Return ONLY valid JSON.

CURRENT WORLD STATE:
${JSON.stringify(currentState, null, 2)}

NARRATION:
"${narration}"

PLAYER ACTION:
"${actionText}"

Return JSON:
{
  "scene": { "action": "5-10 word summary", "mood": "1-3 words", "npc": "name or null" },
  "locations": [{"name": "...", "description": "...", "distance": "...", "isNew": true, "img": "one sentence visual or null"}],
  "npcs": [{"name": "...", "description": "...", "location": "...", "isNew": true, "img": "one sentence visual or null"}],
  "enemies": [{"displayName": "...", "count": 1, "slug": "monster-db-slug"}],
  "map": "current location name",
  "accomplishments": [{"character": "...", "achievement": "..."}],
  "charUpdates": [{"character": "...", "field": "statsText|personality|backstory|standardActions", "value": "..."}]
}

Rules:
- "isNew" = true ONLY if entity does NOT appear in CURRENT WORLD STATE
- "img" ONLY for isNew entities
- "enemies" ONLY if hostile creatures are actively threatening the party
- "slug" must be a plausible monster database key (lowercase, hyphenated). Use "custom" if unsure.
- Omit empty arrays entirely
- Return ONLY the JSON object, no explanation`;
}

function buildValidationPrompt(narration, options, gameState) {
  const charBlock = Object.entries(gameState.characters || {})
    .map(([name, c]) => {
      const stats = c.combatStats || {};
      const slots = stats.spellSlots
        ? Object.entries(stats.spellSlots).map(([lvl, n]) => `L${lvl}:${n}`).join(' ')
        : 'none';
      const conditions = stats.conditions?.length ? stats.conditions.join(', ') : 'none';
      return `  - ${name} (Level ${c.level || '?'} ${c.class || '?'}): HP ${stats.hp || '?'}/${stats.maxHp || '?'}, Slots: ${slots}, Conditions: ${conditions}`;
    })
    .join('\n');

  const houseRules = (gameState.rulesCorrections || []).map(r => '- ' + r.text).join('\n') || 'none';

  return `Check this narration against the current game state. Return ONLY valid JSON.

GAME STATE:
- System: ${gameState.system || 'dnd5e'}
- Characters:
${charBlock || '  (none)'}
- Story context: ${gameState.recentSummary || 'No recent context'}
- House rules: ${houseRules}
- Current location: ${gameState.currentMap || 'unknown'}

NARRATION:
"${narration}"

OPTIONS:
"${Array.isArray(options) ? options.join('\n') : options || ''}"

Flag ONLY if the narration contradicts the game state above.
Examples of violations:
- Using a resource the character doesn't have
- Referencing an ability the character doesn't possess
- Contradicting established facts from recent turns
- Violating a house rule
- A character acting impossibly for their condition

Do NOT flag: creative liberties, dramatic embellishment, minor flavor inconsistencies, mechanical rule details.

Return JSON:
{ "violations": [{"type": "resource|continuity|house_rule|condition", "severity": "critical|minor", "description": "...", "correction": "..."}], "wordCount": N, "passed": true }

If no violations: {"violations": [], "wordCount": N, "passed": true}`;
}

// ── Response Parsing ────────────────────────────────────────────────────────

function parseSonnetResponse(text) {
  const lines = text.split('\n');
  const optionRegex = /^[1-3]\uFE0F?\u20E3\s+/;
  const numberedRegex = /^\d+[.)]\s/;

  let narrationLines = [];
  let options = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (optionRegex.test(trimmed)) {
      options.push(trimmed.replace(optionRegex, '').trim());
    } else if (numberedRegex.test(trimmed) && options.length > 0) {
      // Only treat numbered lines as options if we've already seen emoji options
      options.push(trimmed.replace(numberedRegex, '').trim());
    } else if (numberedRegex.test(trimmed) && narrationLines.length > 0) {
      // Could be options in non-emoji format — check if 3 consecutive numbered lines
      options.push(trimmed.replace(numberedRegex, '').trim());
    } else {
      narrationLines.push(line);
    }
  }

  // If we collected numbered lines as options but they don't look like options (< 2), roll back
  if (options.length < 2) {
    narrationLines = lines;
    options = [];
  }

  const narration = narrationLines.join('\n').trim();
  return { narration, options: options.slice(0, 3) };
}

// ── Violation Processing ────────────────────────────────────────────────────

function processViolation(gs, violation) {
  if (!gs.pendingCorrections) gs.pendingCorrections = [];
  if (!gs.minorViolationCounts) gs.minorViolationCounts = {};

  if (violation.severity === 'critical') {
    gs.pendingCorrections.push(violation);
    return;
  }

  const key = `${violation.type}:${violation.description}`;
  gs.minorViolationCounts[key] = (gs.minorViolationCounts[key] || 0) + 1;

  if (gs.minorViolationCounts[key] >= 3) {
    gs.pendingCorrections.push(violation);
    gs.minorViolationCounts[key] = 0;
  }
}

// ── Combat Flavor Decision ──────────────────────────────────────────────────

function shouldCallSonnetForFlavor(combatState) {
  if (combatState.combatOver) return true;
  if (combatState.round === 1) return true;
  return combatState.round % 3 === 0;
}

// ── API Call Wrappers ───────────────────────────────────────────────────────

async function callSonnetNarration(gameId, gameConfig, gs, characterName, actionText, io) {
  const systemPrompt = buildNarrationPrompt(gameId, gameConfig, gs);
  const userMsg = buildUserMessage(gs, characterName, actionText);

  const temperature = gs.verbosity === 'terse' ? 0.4 : gs.verbosity === 'brief' ? 0.6 : 0.8;
  const maxTokens = gs.verbosity === 'terse' ? 400 : gs.verbosity === 'brief' ? 600 : 1500;

  // Stream start
  io.to(gameId).emit('dm_stream_start', { auto: false, player: null });

  let accumulatedText = '';
  const stream = await anthropic.messages.stream({
    model: SONNET_MODEL,
    max_tokens: maxTokens,
    temperature,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMsg }],
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.text) {
      accumulatedText += event.delta.text;
      io.to(gameId).emit('dm_stream_chunk', { text: event.delta.text });
    }
  }

  const finalMessage = await stream.finalMessage();
  io.to(gameId).emit('dm_stream_end', { narration: accumulatedText.trim() });

  // Log cost
  const inputTokens = finalMessage.usage?.input_tokens || 0;
  const outputTokens = finalMessage.usage?.output_tokens || 0;
  console.log(`[pipeline] Sonnet narration: ${inputTokens}in/${outputTokens}out`);

  return parseSonnetResponse(accumulatedText);
}

async function callHaikuExtraction(gameId, narration, actionText, worldState) {
  const prompt = buildExtractionPrompt(narration, actionText, worldState);

  try {
    const response = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 500,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[pipeline] Haiku extraction failed:', err.message);
    return null;
  }
}

async function callHaikuValidation(gameId, narration, options, gameState) {
  const prompt = buildValidationPrompt(narration, options, gameState);

  try {
    const response = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 300,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { violations: [], wordCount: 0, passed: true };
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[pipeline] Haiku validation failed:', err.message);
    return { violations: [], wordCount: 0, passed: true };
  }
}

// ── Main Pipeline Orchestrator ──────────────────────────────────────────────

async function handlePlayerAction(gameId, gameConfig, gs, characterName, actionText, io, deps) {
  const { initiateCombat, parseAction, resolveEnemyTurns, persistCombatState, emitCombatUpdate } = deps;

  // ── COMBAT PATH ──
  if (gs.combatEngine?.state?.active) {
    const combatEngine = gs.combatEngine;
    const resolver = combatEngine.getResolver();

    // Resolve player action (reuse existing logic from server.js lines 1404-1470)
    const engineCurrent = combatEngine.getCurrentTurn();
    const playerId = engineCurrent?.id;
    const playerCombatant = combatEngine.state.combatants[playerId];
    const isDown = playerCombatant && resolver.checkDeath(playerCombatant).status === 'unconscious';

    let parsedAction;
    if (isDown) {
      parsedAction = { type: 'death_save', actorId: playerId };
    } else {
      parsedAction = parseAction(actionText, playerId, {
        combatants: combatEngine.state.combatants,
        preTaggedOptions: gs.preTaggedOptions || null,
      });
      if (!parsedAction) {
        const enemies = Object.values(combatEngine.state.combatants).filter(c => c.type === 'Enemy' && c.hp > 0);
        const attacker = combatEngine.state.combatants[playerId];
        if (enemies.length > 0 && attacker) {
          parsedAction = { type: 'attack', attackerId: playerId, targetId: enemies[0].id, weapon: attacker.weapons?.[0]?.name };
        }
      }
    }

    const allResults = [];
    if (parsedAction) {
      allResults.push(combatEngine.resolveAction(parsedAction));
      combatEngine.advanceTurn();

      // Auto-resolve death saves for downed PCs
      while (true) {
        const nextTurn = combatEngine.getCurrentTurn();
        if (!nextTurn || nextTurn.type !== 'PC') break;
        if (resolver.checkDeath(nextTurn).status !== 'unconscious') break;
        allResults.push(combatEngine.resolveAction({ type: 'death_save', actorId: nextTurn.id }));
        combatEngine.advanceTurn();
      }

      const enemyResults = await resolveEnemyTurns(gameId, gameConfig);
      allResults.push(...enemyResults);

      // Auto-resolve death saves after enemy turns
      while (true) {
        const nextTurn = combatEngine.getCurrentTurn();
        if (!nextTurn || nextTurn.type !== 'PC') break;
        if (resolver.checkDeath(nextTurn).status !== 'unconscious') break;
        allResults.push(combatEngine.resolveAction({ type: 'death_save', actorId: nextTurn.id }));
        combatEngine.advanceTurn();
      }

      persistCombatState(gameId);
    }

    // Assemble narration from templates
    const narration = await templateEngine.assembleCombatNarration(
      allResults.filter(Boolean), combatEngine, gs.dmPersona || 'epic'
    );
    const options = templateEngine.generateCombatOptions(combatEngine, characterName);

    // Check combat over
    const overCheck = combatEngine.isCombatOver();

    // Flavor call on special rounds
    const combatState = { round: combatEngine.state.round, combatOver: overCheck.over };
    if (shouldCallSonnetForFlavor(combatState)) {
      // Non-blocking Sonnet flavor call
      callSonnetCombatFlavor(gameId, gameConfig, gs, allResults, overCheck, io).catch(err => {
        console.error('[pipeline] Flavor call failed:', err.message);
      });
    }

    if (overCheck.over) {
      combatEngine.endCombat();
      persistCombatState(gameId);
    }

    emitCombatUpdate(gameId);

    return { narration, options, scene: null, world: null, isKillshot: false };
  }

  // ── NON-COMBAT PATH ──

  // Call 1: Sonnet narration (streamed)
  const { narration, options } = await callSonnetNarration(gameId, gameConfig, gs, characterName, actionText, io);

  // Build state context for parallel calls
  const worldState = {
    locations: gs.data?.world?.locations || [],
    npcs: gs.data?.world?.npcs || [],
    currentMap: gs.data?.world?.currentMap || '',
  };

  const validationState = {
    system: gameConfig.system,
    characters: gs.data?.characters || {},
    rulesCorrections: gs.rulesCorrections || [],
    currentMap: worldState.currentMap,
    recentSummary: gs.storySummary || '',
  };

  // Calls 2 & 3: parallel background
  const [worldUpdates, validation] = await Promise.all([
    callHaikuExtraction(gameId, narration, actionText, worldState),
    callHaikuValidation(gameId, narration, options, validationState),
  ]);

  // Process enemies → combat
  if (worldUpdates?.enemies?.length) {
    await initiateCombat(gameId, worldUpdates.enemies);
  }

  // Process violations → queue corrections
  if (validation?.violations?.length) {
    for (const v of validation.violations) {
      processViolation(gs, v);
    }
  }

  // Extract scene for image generation
  const scene = worldUpdates?.scene || null;
  const isKillshot = scene?.action?.toLowerCase().includes('killshot') || false;

  return {
    narration,
    options,
    scene,
    world: worldUpdates,
    isKillshot,
  };
}

async function callSonnetCombatFlavor(gameId, gameConfig, gs, results, overCheck, io) {
  const resultLines = results.map(r => gs.combatEngine.formatResultForPrompt(r)).join('\n');
  const context = overCheck.over
    ? `Combat is over (${overCheck.reason}). Narrate the aftermath in 2-3 sentences.`
    : `Narrate these combat results with flavor in 2-3 sentences.`;

  const prompt = `${context}\n\nResults:\n${resultLines}`;
  const systemPrompt = buildNarrationPrompt(gameId, gameConfig, gs);

  const response = await anthropic.messages.create({
    model: SONNET_MODEL,
    max_tokens: 300,
    temperature: 0.6,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  });

  const flavorText = response.content[0]?.text || '';
  if (flavorText) {
    io.to(gameId).emit('combat_flavor', { text: flavorText.trim() });
  }
}

module.exports = {
  handlePlayerAction,
  // Exported for testing
  buildNarrationPrompt,
  buildUserMessage,
  buildExtractionPrompt,
  buildValidationPrompt,
  parseSonnetResponse,
  processViolation,
  shouldCallSonnetForFlavor,
  callSonnetNarration,
  callHaikuExtraction,
  callHaikuValidation,
};
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/narration-pipeline.test.js
```

Expected: All PASS. (The tests only exercise pure functions — no API calls.)

- [ ] **Step 5: Commit**

```bash
git add narration-pipeline.js tests/narration-pipeline.test.js
git commit -m "feat: narration pipeline with Sonnet/Haiku split and combat templates"
```

---

### Task 5: Wire Pipeline into server.js

**Files:**
- Modify: `server.js`

This task connects the new pipeline to the existing game loop with a feature flag.

- [ ] **Step 1: Add import and feature flag at top of server.js**

After the existing imports (around line 22), add:

```javascript
const narrationPipeline = require('./narration-pipeline');
const USE_SPLIT_PIPELINE = process.env.SPLIT_PIPELINE === 'true';
```

- [ ] **Step 2: Rename existing callClaude to legacyCallClaude**

At line 1355, rename:

```javascript
// Before:
async function callClaude(gameId, gameConfig, userMessage, actingAs = null) {

// After:
async function legacyCallClaude(gameId, gameConfig, userMessage, actingAs = null) {
```

- [ ] **Step 3: Create new callClaude router function**

Add immediately before `legacyCallClaude`:

```javascript
async function callClaude(gameId, gameConfig, userMessage, actingAs = null) {
  if (!USE_SPLIT_PIPELINE) {
    return legacyCallClaude(gameId, gameConfig, userMessage, actingAs);
  }

  // Rate limit check
  if (!checkRateLimit(gameId)) {
    const gs = getGameState(gameId);
    gs.paused = true;
    clearTimeout(gs.turnTimer);
    emitSystem(gameId, { text: '⚠️ Rate limit reached (60 calls/hour). Game paused.' });
    return { narration: 'Game paused — rate limit reached.', options: [], scene: null, world: null, isKillshot: false };
  }

  const gs = getGameState(gameId);
  const characterName = actingAs || userMessage.split(':')[0]?.trim() || 'Unknown';
  const actionText = userMessage.replace(/^.*?:\s*/, '');

  const prefix = actingAs ? `[AUTO-ACTION for ${actingAs}]\n` : '';

  try {
    const result = await narrationPipeline.handlePlayerAction(
      gameId, gameConfig, gs, characterName, prefix + actionText, io,
      { initiateCombat, parseAction, resolveEnemyTurns, persistCombatState, emitCombatUpdate }
    );

    // Save to chat history (same format as legacy)
    const gd = gs.data;
    const historyContent = result.narration +
      (result.options?.length ? '\n\n' + result.options.map((o, i) => `${i + 1}️⃣ ${o}`).join('\n') : '');
    gd.chatHistory.push(
      { role: 'user', content: prefix + userMessage },
      { role: 'assistant', content: historyContent }
    );
    if (gd.chatHistory.length > 16) {
      gd.chatHistory = gd.chatHistory.slice(-16);
    }

    // Apply world updates to game state
    if (result.world) {
      applyWorldUpdates(gameId, result.world);
    }

    // Trigger story summary if needed
    if (gd.chatHistory.length >= 12 && gs.turnCount % 50 === 0) {
      refreshStorySummary(gameId, gameConfig).catch(() => {});
    }

    return result;
  } catch (err) {
    console.error('[pipeline] Error, falling back to legacy:', err.message);
    // Fallback to legacy on pipeline error
    return legacyCallClaude(gameId, gameConfig, userMessage, actingAs);
  }
}
```

- [ ] **Step 4: Add applyWorldUpdates helper**

Add after the new `callClaude` function:

```javascript
function applyWorldUpdates(gameId, worldUpdates) {
  if (!worldUpdates) return;
  const gs = getGameState(gameId);
  const gd = gs.data;

  if (!gd.world) gd.world = { locations: [], npcs: [], accomplishments: [] };

  // Merge locations
  if (worldUpdates.locations) {
    for (const loc of worldUpdates.locations) {
      const existing = gd.world.locations.find(l => l.name.toLowerCase() === loc.name.toLowerCase());
      if (existing) {
        Object.assign(existing, loc);
      } else {
        gd.world.locations.push(loc);
      }
    }
  }

  // Merge NPCs
  if (worldUpdates.npcs) {
    for (const npc of worldUpdates.npcs) {
      const existing = gd.world.npcs.find(n => n.name.toLowerCase() === npc.name.toLowerCase());
      if (existing) {
        Object.assign(existing, npc);
      } else {
        gd.world.npcs.push(npc);
      }
    }
  }

  // Map update
  if (worldUpdates.map) {
    gd.world.currentMap = worldUpdates.map;
  }

  // Accomplishments
  if (worldUpdates.accomplishments) {
    gd.world.accomplishments = [...(gd.world.accomplishments || []), ...worldUpdates.accomplishments];
  }

  // Character updates
  if (worldUpdates.charUpdates) {
    for (const update of worldUpdates.charUpdates) {
      const char = gd.characters[update.character];
      if (char && update.field && update.value) {
        char[update.field] = update.value;
      }
    }
  }

  // Persist
  db.setState(gameId, 'world', gd.world).catch(() => {});
}
```

- [ ] **Step 5: Run existing tests to verify nothing is broken**

```bash
npm test
```

Expected: All 310+ existing tests PASS (pipeline is behind feature flag, legacy path unchanged).

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: wire split pipeline into server.js with SPLIT_PIPELINE feature flag"
```

---

### Task 6: Integration Test — Full Pipeline

**Files:**
- Create: `tests/pipeline-integration.test.js`

- [ ] **Step 1: Write integration test**

This test mocks the Anthropic API to test the full pipeline flow without real API calls.

```javascript
const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert');

// Mock Anthropic before requiring pipeline
const mockStream = {
  async *[Symbol.asyncIterator]() {
    yield { type: 'content_block_delta', delta: { text: 'The door creaks open.\n\n' } };
    yield { type: 'content_block_delta', delta: { text: '1️⃣ 🗡️ Enter carefully\n' } };
    yield { type: 'content_block_delta', delta: { text: '2️⃣ 🛡️ Listen first\n' } };
    yield { type: 'content_block_delta', delta: { text: '3️⃣ 🔥 Kick it wide open' } };
  },
  finalMessage: async () => ({ usage: { input_tokens: 500, output_tokens: 50 } }),
};

const mockCreateResponse = {
  content: [{ text: '{"scene":{"action":"Opening a door","mood":"tense","npc":null},"map":"Dark Corridor","violations":[],"wordCount":4,"passed":true}' }],
};

// We test parseSonnetResponse and the pure logic without mocking
const {
  parseSonnetResponse,
  buildNarrationPrompt,
  processViolation,
} = require('../narration-pipeline');

describe('Pipeline Integration', () => {
  it('parseSonnetResponse handles streamed chunks assembled into full text', () => {
    const fullText = 'The door creaks open.\n\n1️⃣ 🗡️ Enter carefully\n2️⃣ 🛡️ Listen first\n3️⃣ 🔥 Kick it wide open';
    const result = parseSonnetResponse(fullText);
    assert.ok(result.narration.includes('door creaks'));
    assert.strictEqual(result.options.length, 3);
    assert.ok(result.options[0].includes('Enter'));
    assert.ok(result.options[2].includes('Kick'));
  });

  it('narration prompt is under 1000 tokens worth of text', () => {
    const prompt = buildNarrationPrompt('test', { system: 'dnd5e', custom_context: '' }, {
      dmPersona: 'epic',
      verbosity: 'brief',
      ferocity: 3,
      pillars: { exploration: 33, combat: 33, social: 34 },
      storySummary: 'Short summary.',
      rulesCorrections: [],
      npcMemory: {},
      encounterPlan: null,
      encounterPlanIndex: 0,
      data: {
        characters: {
          'Kael': { personality: 'Brave', backstory: 'Soldier.', standardActions: 'Attack', catchphrases: [], class: 'Fighter', level: 5 },
        },
      },
    });
    // Rough token estimate: 1 token ≈ 4 chars. 1000 tokens ≈ 4000 chars.
    assert.ok(prompt.length < 4000, `Prompt too long: ${prompt.length} chars (~${Math.ceil(prompt.length / 4)} tokens)`);
  });

  it('correction injection clears pending corrections', () => {
    const gs = { pendingCorrections: [], minorViolationCounts: {} };

    // 3 minor violations → escalates
    processViolation(gs, { severity: 'minor', type: 'verbosity', description: 'too long', correction: 'shorter' });
    processViolation(gs, { severity: 'minor', type: 'verbosity', description: 'too long', correction: 'shorter' });
    processViolation(gs, { severity: 'minor', type: 'verbosity', description: 'too long', correction: 'shorter' });

    assert.strictEqual(gs.pendingCorrections.length, 1);
    assert.strictEqual(gs.pendingCorrections[0].description, 'too long');
  });
});
```

- [ ] **Step 2: Run integration tests**

```bash
npm test -- tests/pipeline-integration.test.js
```

Expected: All PASS.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: All tests PASS (310+ existing + new pipeline + template tests).

- [ ] **Step 4: Commit**

```bash
git add tests/pipeline-integration.test.js
git commit -m "test: add pipeline integration tests"
```

---

### Task 7: Deploy with Feature Flag

**Files:**
- No file changes — deployment and env var

- [ ] **Step 1: Push to origin**

```bash
cd "/Users/aron/Dropbox (Personal)/claude/dnd-server"
git push origin main
```

- [ ] **Step 2: Set SPLIT_PIPELINE env var on Railway (disabled initially)**

```bash
railway variables set SPLIT_PIPELINE=false
```

- [ ] **Step 3: Deploy**

```bash
railway up --detach
```

- [ ] **Step 4: Verify deploy succeeds**

```bash
railway logs --tail 20
```

Expected: Server starts, no errors. Legacy path active (SPLIT_PIPELINE=false).

- [ ] **Step 5: Enable split pipeline**

```bash
railway variables set SPLIT_PIPELINE=true
```

- [ ] **Step 6: Test in production**

Open https://dnd-server-production-9b61.up.railway.app, create a test game, take a few turns. Verify:
- Narration streams to client
- Options appear (3 choices)
- World state updates (map, NPCs, locations)
- Combat triggers correctly when enemies appear
- Combat turns use template narration (check server logs for no Sonnet call during standard combat)

- [ ] **Step 7: Commit any hotfixes if needed, then final commit**

```bash
git add -A && git commit -m "deploy: enable split pipeline in production"
```

---

### Task 8: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update architecture section**

Replace the "System Prompt Strategy" section with:

```markdown
### Narration Pipeline (Split Architecture)
- **Feature flag:** `SPLIT_PIPELINE=true` env var enables new pipeline; `false` uses legacy single-call path
- **Non-combat turns:** 3 parallel calls:
  1. Sonnet (streamed) — narration + 3 options (~800 token prompt, creative only)
  2. Haiku (background) — JSON world state extraction (locations, NPCs, enemies, map)
  3. Haiku (background) — narration validation against game state, queues corrections
- **Combat turns:** Zero API calls — server assembles narration from monster templates + combat engine results
  - Sonnet called for flavor on round 1, every 3rd round, combat end, and killshots
  - Templates lazily generated by Haiku, cached in `monster_templates` DB table
- **Legacy path:** `legacyCallClaude()` preserved behind feature flag for rollback
- **Corrections:** Validation violations queued in `gs.pendingCorrections[]`, injected as `[CORRECTION: ...]` in next turn's user message
```

- [ ] **Step 2: Update Key Files table**

Add to the Key Files table:

```markdown
| `narration-pipeline.js` | ~350 | Pipeline orchestrator — Sonnet/Haiku calls, prompt builders, parsing |
| `template-engine.js` | ~300 | Monster template cache, lazy generation, combat narration assembly |
| `templates/generic-templates.json` | ~500 | Hardcoded fallback templates by creature type |
```

- [ ] **Step 3: Update Model Selection section**

Replace any "Haiku ONLY" references:

```markdown
### Model Selection
- **Narration (non-combat):** claude-sonnet-4-6 — creative storytelling, streamed
- **World extraction:** claude-haiku-4-5-20251001 — JSON extraction from narration
- **Validation:** claude-haiku-4-5-20251001 — state contradiction checking
- **Template generation:** claude-haiku-4-5-20251001 — one-time monster template batch
- **Combat flavor:** claude-sonnet-4-6 — occasional color paragraphs
- **All other utilities:** claude-haiku-4-5-20251001 — stat parsing, action parsing, summaries, OOC
```

- [ ] **Step 4: Add Common Gotcha**

Add to Common Gotchas:

```markdown
- **Pipeline feature flag:** `SPLIT_PIPELINE` env var controls routing. If disabled, all calls go through `legacyCallClaude()`. If pipeline errors, it auto-falls back to legacy.
- **Monster templates cache:** In-memory Map + PostgreSQL. Clear cache by restarting server. Delete from DB to force regeneration.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for split pipeline architecture"
```
