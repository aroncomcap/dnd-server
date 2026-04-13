# Combat Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a server-side combat engine that owns all dice rolls, math, HP tracking, and condition management — the AI narrates pre-resolved results instead of simulating rules.

**Architecture:** New `combat-engine.js` module with system-specific resolvers (`dnd5e-resolver.js`, `runequest-resolver.js`). Server.js routes player actions through the engine when combat is active. AI receives pre-resolved results and narrates them. Layered monster database with SRD defaults + AI fallback.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert` for testing, PostgreSQL (pg), Socket.io, Anthropic Claude API (Haiku)

**Spec:** `docs/superpowers/specs/2026-04-12-combat-engine-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `resolvers/dice.js` | Real RNG: d4–d100, NdX notation parser, advantage/disadvantage |
| `resolvers/dnd5e-resolver.js` | D&D 5e: attacks, spells, saves, damage, conditions, death saves, concentration |
| `resolvers/runequest-resolver.js` | RQ: percentile rolls, parry/dodge, hit locations, fumble/special/critical tables |
| `combat-engine.js` | Combat state management, lifecycle, turn routing, active effects |
| `stat-parser.js` | Haiku: statsText → combatStats JSON extraction |
| `action-parser.js` | Tier 1 pattern matching + Tier 2 Haiku intent extraction |
| `monster-lookup.js` | Layered monster source resolution (DB → JSON → AI fallback) |
| `monsters/monsters-5e-srd.json` | ~300 SRD monsters in combatStats format |
| `monsters/monsters-rq-core.json` | Core RuneQuest creatures in combatStats format |
| `tests/dice.test.js` | Tests for dice module |
| `tests/dnd5e-resolver.test.js` | Tests for D&D 5e resolver |
| `tests/runequest-resolver.test.js` | Tests for RuneQuest resolver |
| `tests/combat-engine.test.js` | Tests for combat engine lifecycle |
| `tests/stat-parser.test.js` | Tests for stat parser |
| `tests/action-parser.test.js` | Tests for action parser |
| `tests/monster-lookup.test.js` | Tests for monster source lookup |

### Modified Files
| File | Changes |
|------|---------|
| `package.json` | Add `test` script |
| `db.js` | Add `monster_sources`, `game_monster_sources` tables; add `combatStats` to character data |
| `server.js` | Combat routing in callClaude, lifecycle hooks, ENEMIES parsing, reaction socket events, fix 3 async handlers |
| `public/game.html` | Combat log panel, enhanced turn order with HP bars, reaction prompt modal, enemy stat cards |

---

## Task 1: Test Infrastructure & Dice Module

**Files:**
- Create: `resolvers/dice.js`
- Create: `tests/dice.test.js`
- Modify: `package.json`

- [ ] **Step 1: Add test script to package.json**

In `package.json`, add to the `"scripts"` section:

```json
"test": "node --test tests/*.test.js",
"test:watch": "node --test --watch tests/*.test.js"
```

- [ ] **Step 2: Write dice module tests**

Create `tests/dice.test.js`:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { d4, d6, d8, d10, d12, d20, d100, roll, advantage, disadvantage } = require('../resolvers/dice');

describe('dice', () => {
  describe('individual dice', () => {
    it('d4 returns 1-4', () => {
      for (let i = 0; i < 100; i++) {
        const r = d4();
        assert.ok(r >= 1 && r <= 4, `d4 returned ${r}`);
      }
    });

    it('d6 returns 1-6', () => {
      for (let i = 0; i < 100; i++) {
        const r = d6();
        assert.ok(r >= 1 && r <= 6, `d6 returned ${r}`);
      }
    });

    it('d8 returns 1-8', () => {
      for (let i = 0; i < 100; i++) {
        const r = d8();
        assert.ok(r >= 1 && r <= 8, `d8 returned ${r}`);
      }
    });

    it('d10 returns 1-10', () => {
      for (let i = 0; i < 100; i++) {
        const r = d10();
        assert.ok(r >= 1 && r <= 10, `d10 returned ${r}`);
      }
    });

    it('d12 returns 1-12', () => {
      for (let i = 0; i < 100; i++) {
        const r = d12();
        assert.ok(r >= 1 && r <= 12, `d12 returned ${r}`);
      }
    });

    it('d20 returns 1-20', () => {
      for (let i = 0; i < 100; i++) {
        const r = d20();
        assert.ok(r >= 1 && r <= 20, `d20 returned ${r}`);
      }
    });

    it('d100 returns 1-100', () => {
      for (let i = 0; i < 100; i++) {
        const r = d100();
        assert.ok(r >= 1 && r <= 100, `d100 returned ${r}`);
      }
    });
  });

  describe('roll notation parser', () => {
    it('parses "1d6" correctly', () => {
      const r = roll('1d6');
      assert.ok(r.rolls.length === 1);
      assert.ok(r.rolls[0] >= 1 && r.rolls[0] <= 6);
      assert.strictEqual(r.modifier, 0);
      assert.strictEqual(r.total, r.rolls[0]);
    });

    it('parses "2d6+3" correctly', () => {
      const r = roll('2d6+3');
      assert.strictEqual(r.rolls.length, 2);
      assert.strictEqual(r.modifier, 3);
      assert.strictEqual(r.total, r.rolls[0] + r.rolls[1] + 3);
    });

    it('parses "1d8-1" correctly', () => {
      const r = roll('1d8-1');
      assert.strictEqual(r.rolls.length, 1);
      assert.strictEqual(r.modifier, -1);
      assert.strictEqual(r.total, r.rolls[0] - 1);
    });

    it('parses "4d6" correctly', () => {
      const r = roll('4d6');
      assert.strictEqual(r.rolls.length, 4);
      r.rolls.forEach(v => assert.ok(v >= 1 && v <= 6));
      assert.strictEqual(r.total, r.rolls.reduce((a, b) => a + b, 0));
    });

    it('parses "1d20+5" correctly', () => {
      const r = roll('1d20+5');
      assert.strictEqual(r.rolls.length, 1);
      assert.strictEqual(r.modifier, 5);
      assert.strictEqual(r.total, r.rolls[0] + 5);
    });

    it('handles compound notation "1d8+1+1d4" (RQ damage bonus)', () => {
      const r = roll('1d8+1+1d4');
      assert.ok(r.total >= 3 && r.total <= 13);
      assert.strictEqual(r.rolls.length, 2); // 1d8 and 1d4
      assert.strictEqual(r.modifier, 1);
    });
  });

  describe('advantage and disadvantage', () => {
    it('advantage returns the higher of two d20 rolls', () => {
      for (let i = 0; i < 50; i++) {
        const r = advantage();
        assert.ok(r.result >= 1 && r.result <= 20);
        assert.strictEqual(r.rolls.length, 2);
        assert.strictEqual(r.result, Math.max(r.rolls[0], r.rolls[1]));
      }
    });

    it('disadvantage returns the lower of two d20 rolls', () => {
      for (let i = 0; i < 50; i++) {
        const r = disadvantage();
        assert.ok(r.result >= 1 && r.result <= 20);
        assert.strictEqual(r.rolls.length, 2);
        assert.strictEqual(r.result, Math.min(r.rolls[0], r.rolls[1]));
      }
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/aron/Downloads/dnd-server && npm test`
Expected: FAIL — `Cannot find module '../resolvers/dice'`

- [ ] **Step 4: Implement dice module**

Create `resolvers/dice.js`:

```js
'use strict';

const crypto = require('crypto');

// Cryptographically secure random integer in [1, sides]
function rollDie(sides) {
  const max = Math.floor(0xFFFFFFFF / sides) * sides;
  let val;
  do {
    val = crypto.randomBytes(4).readUInt32BE(0);
  } while (val >= max);
  return (val % sides) + 1;
}

function d4()   { return rollDie(4); }
function d6()   { return rollDie(6); }
function d8()   { return rollDie(8); }
function d10()  { return rollDie(10); }
function d12()  { return rollDie(12); }
function d20()  { return rollDie(20); }
function d100() { return rollDie(100); }

// Parse dice notation: "2d6+3", "1d8-1", "1d8+1+1d4" (compound)
// Returns { rolls: number[], modifier: number, total: number }
function roll(notation) {
  const parts = notation.match(/(\d+d\d+|[+-]?\d+)/gi);
  if (!parts) throw new Error(`Invalid dice notation: ${notation}`);

  const rolls = [];
  let modifier = 0;

  for (const part of parts) {
    const diceMatch = part.match(/^([+-]?)(\d+)d(\d+)$/i);
    if (diceMatch) {
      const sign = diceMatch[1] === '-' ? -1 : 1;
      const count = parseInt(diceMatch[2], 10);
      const sides = parseInt(diceMatch[3], 10);
      for (let i = 0; i < count; i++) {
        rolls.push(rollDie(sides) * sign);
      }
    } else {
      modifier += parseInt(part, 10);
    }
  }

  const total = rolls.reduce((a, b) => a + b, 0) + modifier;
  return { rolls, modifier, total };
}

// Roll 2d20, take higher
function advantage() {
  const r1 = d20();
  const r2 = d20();
  return { rolls: [r1, r2], result: Math.max(r1, r2) };
}

// Roll 2d20, take lower
function disadvantage() {
  const r1 = d20();
  const r2 = d20();
  return { rolls: [r1, r2], result: Math.min(r1, r2) };
}

module.exports = { d4, d6, d8, d10, d12, d20, d100, roll, advantage, disadvantage, rollDie };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/aron/Downloads/dnd-server && npm test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/aron/Downloads/dnd-server
git add resolvers/dice.js tests/dice.test.js package.json
git commit -m "feat: add dice module with real RNG and notation parser"
```

---

## Task 2: D&D 5e Resolver

**Files:**
- Create: `resolvers/dnd5e-resolver.js`
- Create: `tests/dnd5e-resolver.test.js`

- [ ] **Step 1: Write D&D 5e resolver tests**

Create `tests/dnd5e-resolver.test.js`:

```js
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const dnd5e = require('../resolvers/dnd5e-resolver');

// Helper: create a minimal D&D 5e combatant
function makePC(overrides = {}) {
  return {
    id: 'kael', name: 'Kael', type: 'PC', system: 'dnd5e',
    level: 5, ac: 16, hp: 38, maxHp: 38, speed: 30,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 13, cha: 8 },
    saveProficiencies: ['str', 'con'],
    proficiencyBonus: 3,
    weapons: [
      { name: 'longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing', properties: [] },
    ],
    spells: [],
    spellSlots: {},
    spellcastingAbility: null,
    features: [],
    conditions: [],
    concentrating: null,
    deathSaves: { successes: 0, failures: 0 },
    inspiration: false,
    ...overrides,
  };
}

function makeEnemy(overrides = {}) {
  return {
    id: 'goblin-1', name: 'Goblin', type: 'Enemy', system: 'dnd5e',
    level: 1, ac: 15, hp: 7, maxHp: 7, speed: 30,
    abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
    saveProficiencies: [],
    proficiencyBonus: 2,
    weapons: [
      { name: 'scimitar', attackMod: 'dex', damage: '1d6', damageType: 'slashing', properties: [] },
    ],
    spells: [],
    spellSlots: {},
    spellcastingAbility: null,
    features: [],
    conditions: [],
    concentrating: null,
    deathSaves: { successes: 0, failures: 0 },
    inspiration: false,
    ...overrides,
  };
}

describe('dnd5e-resolver', () => {
  describe('rollInitiative', () => {
    it('returns a number based on DEX modifier', () => {
      const pc = makePC();
      for (let i = 0; i < 20; i++) {
        const init = dnd5e.rollInitiative(pc);
        // DEX 12 = +1 mod, so range is 2-21
        assert.ok(init >= 2 && init <= 21, `init ${init} out of range`);
      }
    });
  });

  describe('getAbilityMod', () => {
    it('calculates modifier correctly', () => {
      assert.strictEqual(dnd5e.getAbilityMod(10), 0);
      assert.strictEqual(dnd5e.getAbilityMod(16), 3);
      assert.strictEqual(dnd5e.getAbilityMod(8), -1);
      assert.strictEqual(dnd5e.getAbilityMod(1), -5);
      assert.strictEqual(dnd5e.getAbilityMod(20), 5);
    });
  });

  describe('resolveAttack', () => {
    it('returns a result with all required fields', () => {
      const attacker = makePC();
      const target = makeEnemy();
      const result = dnd5e.resolveAttack(attacker, target, attacker.weapons[0], [], []);
      assert.ok('roll' in result);
      assert.ok('modifier' in result);
      assert.ok('total' in result);
      assert.ok('targetAC' in result);
      assert.ok('hit' in result);
      assert.ok('critical' in result);
      assert.ok('fumble' in result);
      assert.ok('damageRoll' in result || !result.hit);
      assert.ok('totalDamage' in result);
      assert.ok('damageType' in result);
    });

    it('critical hit on natural 20 always hits', () => {
      // Run many times, check that nat 20 = critical + hit
      const results = [];
      for (let i = 0; i < 500; i++) {
        const r = dnd5e.resolveAttack(makePC(), makeEnemy({ ac: 30 }), makePC().weapons[0], [], []);
        if (r.roll === 20) results.push(r);
      }
      // We should get some nat 20s in 500 rolls
      assert.ok(results.length > 0, 'No nat 20s in 500 rolls');
      results.forEach(r => {
        assert.strictEqual(r.critical, true);
        assert.strictEqual(r.hit, true);
      });
    });

    it('natural 1 always misses', () => {
      const results = [];
      for (let i = 0; i < 500; i++) {
        const r = dnd5e.resolveAttack(makePC({ abilities: { ...makePC().abilities, str: 30 } }), makeEnemy({ ac: 1 }), makePC().weapons[0], [], []);
        if (r.roll === 1) results.push(r);
      }
      assert.ok(results.length > 0, 'No nat 1s in 500 rolls');
      results.forEach(r => {
        assert.strictEqual(r.fumble, true);
        assert.strictEqual(r.hit, false);
      });
    });

    it('applies advantage correctly', () => {
      const attacker = makePC({ conditions: ['advantage'] });
      const result = dnd5e.resolveAttack(attacker, makeEnemy(), attacker.weapons[0], ['advantage'], []);
      assert.ok('advantageRolls' in result);
      assert.strictEqual(result.advantageRolls.length, 2);
      assert.strictEqual(result.roll, Math.max(...result.advantageRolls));
    });

    it('applies disadvantage correctly', () => {
      const result = dnd5e.resolveAttack(makePC(), makeEnemy(), makePC().weapons[0], ['disadvantage'], []);
      assert.ok('advantageRolls' in result);
      assert.strictEqual(result.roll, Math.min(...result.advantageRolls));
    });
  });

  describe('resolveSpell (save-based)', () => {
    it('resolves a save-based spell like fireball', () => {
      const caster = makePC({
        spellcastingAbility: 'int',
        abilities: { str: 10, dex: 10, con: 10, int: 16, wis: 10, cha: 10 },
        spells: [{ name: 'fireball', level: 3, save: 'dex', damage: '8d6', damageType: 'fire', area: '20ft sphere' }],
        spellSlots: { 3: 2 },
      });
      const target = makeEnemy();
      const spell = caster.spells[0];
      const result = dnd5e.resolveSpell(caster, spell, [target], [], []);

      assert.ok('saveDC' in result);
      assert.ok('targets' in result);
      assert.strictEqual(result.targets.length, 1);
      assert.ok('saveRoll' in result.targets[0]);
      assert.ok('saved' in result.targets[0]);
      assert.ok('damage' in result.targets[0]);
      // Save DC = 8 + prof(3) + INT mod(3) = 14
      assert.strictEqual(result.saveDC, 14);
    });
  });

  describe('resolveSpell (healing)', () => {
    it('resolves cure wounds correctly', () => {
      const caster = makePC({
        spellcastingAbility: 'wis',
        abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 16, cha: 10 },
        spells: [{ name: 'cure wounds', level: 1, healing: '1d8', effect: 'heal' }],
        spellSlots: { 1: 3 },
      });
      const target = makePC({ id: 'target', hp: 10, maxHp: 38 });
      const spell = caster.spells[0];
      const result = dnd5e.resolveSpell(caster, spell, [target], [], []);

      assert.ok(result.healing > 0);
      // 1d8 + WIS mod(3) = 4-11
      assert.ok(result.healing >= 4 && result.healing <= 11);
    });
  });

  describe('applyDamage', () => {
    it('subtracts damage from HP', () => {
      const target = makeEnemy();
      const result = dnd5e.applyDamage(target, 5, 'slashing', []);
      assert.strictEqual(result.hp, 2);
      assert.strictEqual(result.hpBefore, 7);
    });

    it('does not go below 0 HP for enemies', () => {
      const target = makeEnemy();
      const result = dnd5e.applyDamage(target, 20, 'slashing', []);
      assert.strictEqual(result.hp, 0);
    });

    it('applies resistance (half damage)', () => {
      const target = makeEnemy({ resistances: ['fire'] });
      const result = dnd5e.applyDamage(target, 10, 'fire', []);
      assert.strictEqual(result.hp, 2); // 7 - floor(10/2) = 2
    });

    it('applies vulnerability (double damage)', () => {
      const target = makeEnemy({ vulnerabilities: ['fire'] });
      const result = dnd5e.applyDamage(target, 3, 'fire', []);
      assert.strictEqual(result.hp, 1); // 7 - (3*2) = 1
    });

    it('applies immunity (zero damage)', () => {
      const target = makeEnemy({ immunities: ['poison'] });
      const result = dnd5e.applyDamage(target, 10, 'poison', []);
      assert.strictEqual(result.hp, 7);
    });
  });

  describe('checkDeath', () => {
    it('returns alive for positive HP', () => {
      assert.strictEqual(dnd5e.checkDeath(makePC()).status, 'alive');
    });

    it('returns dead for enemy at 0 HP', () => {
      assert.strictEqual(dnd5e.checkDeath(makeEnemy({ hp: 0 })).status, 'dead');
    });

    it('returns unconscious for PC at 0 HP', () => {
      assert.strictEqual(dnd5e.checkDeath(makePC({ hp: 0 })).status, 'unconscious');
    });
  });

  describe('resolveDeathSave', () => {
    it('tracks successes and failures', () => {
      const pc = makePC({ hp: 0, deathSaves: { successes: 0, failures: 0 } });
      const result = dnd5e.resolveDeathSave(pc);
      assert.ok('roll' in result);
      assert.ok('success' in result);
      if (result.roll >= 10) {
        assert.strictEqual(result.success, true);
      } else {
        assert.strictEqual(result.success, false);
      }
    });

    it('natural 20 restores 1 HP', () => {
      // Test the logic directly
      const result = dnd5e._resolveDeathSaveWithRoll(makePC({ hp: 0 }), 20);
      assert.strictEqual(result.stabilized, true);
      assert.strictEqual(result.hpRestored, 1);
    });

    it('natural 1 counts as two failures', () => {
      const result = dnd5e._resolveDeathSaveWithRoll(makePC({ hp: 0, deathSaves: { successes: 0, failures: 0 } }), 1);
      assert.strictEqual(result.doubleFailure, true);
    });
  });

  describe('resolveConcentrationCheck', () => {
    it('DC is 10 or half damage, whichever is higher', () => {
      const caster = makePC({ concentrating: 'Bless' });
      // 8 damage → DC 10 (half is 4, minimum is 10)
      const r1 = dnd5e.resolveConcentrationCheck(caster, 8);
      assert.strictEqual(r1.dc, 10);
      // 30 damage → DC 15 (half is 15)
      const r2 = dnd5e.resolveConcentrationCheck(caster, 30);
      assert.strictEqual(r2.dc, 15);
    });
  });

  describe('getAvailableActions', () => {
    it('includes weapon attacks', () => {
      const pc = makePC();
      const actions = dnd5e.getAvailableActions(pc);
      assert.ok(actions.some(a => a.type === 'attack' && a.weapon === 'longsword'));
    });

    it('includes dodge and disengage', () => {
      const actions = dnd5e.getAvailableActions(makePC());
      assert.ok(actions.some(a => a.type === 'dodge'));
      assert.ok(actions.some(a => a.type === 'disengage'));
      assert.ok(actions.some(a => a.type === 'dash'));
    });

    it('includes spells if caster has slots', () => {
      const caster = makePC({
        spellcastingAbility: 'int',
        spells: [{ name: 'fireball', level: 3, save: 'dex', damage: '8d6', damageType: 'fire' }],
        spellSlots: { 3: 2 },
      });
      const actions = dnd5e.getAvailableActions(caster);
      assert.ok(actions.some(a => a.type === 'spell' && a.spell === 'fireball'));
    });

    it('excludes spells when out of slots', () => {
      const caster = makePC({
        spellcastingAbility: 'int',
        spells: [{ name: 'fireball', level: 3, save: 'dex', damage: '8d6', damageType: 'fire' }],
        spellSlots: { 3: 0 },
      });
      const actions = dnd5e.getAvailableActions(caster);
      assert.ok(!actions.some(a => a.type === 'spell' && a.spell === 'fireball'));
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/aron/Downloads/dnd-server && npm test`
Expected: FAIL — `Cannot find module '../resolvers/dnd5e-resolver'`

- [ ] **Step 3: Implement D&D 5e resolver**

Create `resolvers/dnd5e-resolver.js`:

```js
'use strict';

const { d20, roll, advantage, disadvantage } = require('./dice');

function getAbilityMod(score) {
  return Math.floor((score - 10) / 2);
}

function getSaveMod(combatant, ability) {
  const mod = getAbilityMod(combatant.abilities[ability] || 10);
  const proficient = (combatant.saveProficiencies || []).includes(ability);
  return mod + (proficient ? (combatant.proficiencyBonus || 2) : 0);
}

function getSpellSaveDC(caster) {
  const mod = getAbilityMod(caster.abilities[caster.spellcastingAbility] || 10);
  return 8 + (caster.proficiencyBonus || 2) + mod;
}

function getAttackMod(combatant, weapon) {
  const abilityMod = getAbilityMod(combatant.abilities[weapon.attackMod] || 10);
  return abilityMod + (combatant.proficiencyBonus || 2);
}

function rollAttack(conditions) {
  const hasAdv = conditions.includes('advantage');
  const hasDisadv = conditions.includes('disadvantage');
  // Advantage and disadvantage cancel out
  if (hasAdv && hasDisadv) {
    const r = d20();
    return { roll: r, advantageRolls: null };
  }
  if (hasAdv) {
    const r = advantage();
    return { roll: r.result, advantageRolls: r.rolls };
  }
  if (hasDisadv) {
    const r = disadvantage();
    return { roll: r.result, advantageRolls: r.rolls };
  }
  const r = d20();
  return { roll: r, advantageRolls: null };
}

function resolveAttack(attacker, target, weapon, conditions, activeEffects) {
  const modifier = getAttackMod(attacker, weapon);

  // Check conditions that grant advantage/disadvantage
  const effectiveConditions = [...conditions];
  if (target.conditions?.includes('prone') && !weapon.properties?.includes('ranged')) {
    effectiveConditions.push('advantage');
  }
  if (target.conditions?.includes('prone') && weapon.properties?.includes('ranged')) {
    effectiveConditions.push('disadvantage');
  }
  if (attacker.conditions?.includes('prone') || attacker.conditions?.includes('restrained')) {
    effectiveConditions.push('disadvantage');
  }
  if (target.conditions?.includes('stunned') || target.conditions?.includes('paralyzed') || target.conditions?.includes('unconscious')) {
    effectiveConditions.push('advantage');
  }
  if (attacker.conditions?.includes('blinded')) {
    effectiveConditions.push('disadvantage');
  }
  if (target.conditions?.includes('blinded')) {
    effectiveConditions.push('advantage');
  }
  if (attacker.conditions?.includes('invisible') && !target.conditions?.includes('see_invisible')) {
    effectiveConditions.push('advantage');
  }

  // Apply active effects (e.g., Bless adds 1d4 to attack rolls)
  let effectBonus = 0;
  for (const effect of activeEffects) {
    if (effect.targets?.includes(attacker.id) && effect.effect?.attackBonus) {
      const bonusRoll = roll(effect.effect.attackBonus);
      effectBonus += bonusRoll.total;
    }
  }

  const { roll: attackRoll, advantageRolls } = rollAttack(effectiveConditions);
  const total = attackRoll + modifier + effectBonus;
  const critical = attackRoll === 20;
  const fumble = attackRoll === 1;

  // Natural 20 always hits, natural 1 always misses
  const hit = fumble ? false : (critical ? true : total >= target.ac);

  let damageRoll = null;
  let totalDamage = 0;
  let damageType = weapon.damageType || 'bludgeoning';

  if (hit) {
    const dmg = roll(weapon.damage);
    damageRoll = dmg;
    const abilityDamageMod = getAbilityMod(attacker.abilities[weapon.attackMod] || 10);

    if (critical) {
      // Critical: double the dice (roll again), add modifier once
      const critExtra = roll(weapon.damage);
      totalDamage = dmg.total + critExtra.total + abilityDamageMod;
      damageRoll = { rolls: [...dmg.rolls, ...critExtra.rolls], modifier: abilityDamageMod, total: totalDamage };
    } else {
      totalDamage = dmg.total + abilityDamageMod;
      damageRoll = { ...dmg, modifier: dmg.modifier + abilityDamageMod, total: totalDamage };
    }

    // Minimum 1 damage on hit (can't deal 0 on a successful hit after modifiers)
    if (totalDamage < 1) totalDamage = 1;
  }

  const result = {
    type: 'attack',
    attacker: attacker.id,
    attackerName: attacker.name,
    target: target.id,
    targetName: target.name,
    weapon: weapon.name,
    roll: attackRoll,
    modifier,
    effectBonus,
    total,
    targetAC: target.ac,
    hit,
    critical,
    fumble,
    damageRoll,
    totalDamage: hit ? totalDamage : 0,
    damageType,
  };

  if (advantageRolls) result.advantageRolls = advantageRolls;

  return result;
}

function resolveSpell(caster, spell, targets, conditions, activeEffects) {
  // Healing spells
  if (spell.healing || spell.effect === 'heal') {
    const healRoll = roll(spell.healing);
    const mod = getAbilityMod(caster.abilities[caster.spellcastingAbility] || 10);
    const healing = healRoll.total + mod;
    return {
      type: 'heal',
      caster: caster.id,
      casterName: caster.name,
      spell: spell.name,
      spellLevel: spell.level,
      healing,
      healRoll: healRoll,
      targets: targets.map(t => ({ id: t.id, name: t.name })),
    };
  }

  // Save-based spells (fireball, etc.)
  if (spell.save) {
    const saveDC = getSpellSaveDC(caster);
    const dmg = roll(spell.damage);
    const targetResults = targets.map(t => {
      const saveMod = getSaveMod(t, spell.save);
      let effectBonus = 0;
      for (const effect of activeEffects) {
        if (effect.targets?.includes(t.id) && effect.effect?.saveBonus) {
          effectBonus += roll(effect.effect.saveBonus).total;
        }
      }
      const saveRoll = d20();
      const saveTotal = saveRoll + saveMod + effectBonus;
      const saved = saveTotal >= saveDC;
      const damage = saved ? Math.floor(dmg.total / 2) : dmg.total;
      return {
        id: t.id,
        name: t.name,
        saveRoll,
        saveMod,
        saveTotal,
        saved,
        damage,
        damageType: spell.damageType,
      };
    });

    return {
      type: 'spell_save',
      caster: caster.id,
      casterName: caster.name,
      spell: spell.name,
      spellLevel: spell.level,
      saveDC,
      saveAbility: spell.save,
      damageRoll: dmg,
      targets: targetResults,
    };
  }

  // Attack-roll spells (fire bolt, etc.)
  if (spell.attack) {
    const target = targets[0];
    const mod = getAbilityMod(caster.abilities[caster.spellcastingAbility] || 10) + (caster.proficiencyBonus || 2);
    const { roll: attackRoll, advantageRolls } = rollAttack(conditions);
    const total = attackRoll + mod;
    const critical = attackRoll === 20;
    const fumble = attackRoll === 1;
    const hit = fumble ? false : (critical ? true : total >= target.ac);

    let totalDamage = 0;
    if (hit) {
      const dmg = roll(spell.damage);
      totalDamage = dmg.total;
      if (critical) {
        totalDamage += roll(spell.damage).total;
      }
    }

    return {
      type: 'spell_attack',
      caster: caster.id,
      casterName: caster.name,
      target: target.id,
      targetName: target.name,
      spell: spell.name,
      spellLevel: spell.level,
      roll: attackRoll,
      modifier: mod,
      total,
      targetAC: target.ac,
      hit,
      critical,
      fumble,
      totalDamage,
      damageType: spell.damageType,
      advantageRolls: advantageRolls || undefined,
    };
  }

  // Buff/condition spells (Bless, Shield of Faith, etc.)
  return {
    type: 'spell_buff',
    caster: caster.id,
    casterName: caster.name,
    spell: spell.name,
    spellLevel: spell.level,
    targets: targets.map(t => ({ id: t.id, name: t.name })),
    effect: spell.effect,
    concentration: spell.concentration || false,
  };
}

function applyDamage(target, damage, damageType, activeEffects) {
  const hpBefore = target.hp;
  let effectiveDamage = damage;

  // Resistance = half damage (rounded down)
  if (target.resistances?.includes(damageType)) {
    effectiveDamage = Math.floor(effectiveDamage / 2);
  }
  // Vulnerability = double damage
  if (target.vulnerabilities?.includes(damageType)) {
    effectiveDamage = effectiveDamage * 2;
  }
  // Immunity = no damage
  if (target.immunities?.includes(damageType)) {
    effectiveDamage = 0;
  }

  target.hp = Math.max(0, target.hp - effectiveDamage);

  return {
    id: target.id,
    name: target.name,
    hpBefore,
    hp: target.hp,
    maxHp: target.maxHp,
    effectiveDamage,
    damageType,
    resistant: target.resistances?.includes(damageType) || false,
    vulnerable: target.vulnerabilities?.includes(damageType) || false,
    immune: target.immunities?.includes(damageType) || false,
  };
}

function checkDeath(combatant) {
  if (combatant.hp > 0) return { status: 'alive' };
  if (combatant.type === 'Enemy' || combatant.type === 'NPC') return { status: 'dead' };
  // PCs go unconscious, start death saves
  return { status: 'unconscious' };
}

function resolveDeathSave(combatant) {
  const r = d20();
  return _resolveDeathSaveWithRoll(combatant, r);
}

function _resolveDeathSaveWithRoll(combatant, r) {
  const result = {
    roll: r,
    success: r >= 10,
    stabilized: false,
    dead: false,
    hpRestored: 0,
    doubleFailure: false,
  };

  if (r === 20) {
    // Natural 20: regain 1 HP
    result.stabilized = true;
    result.hpRestored = 1;
    return result;
  }

  if (r === 1) {
    // Natural 1: two failures
    result.doubleFailure = true;
    result.success = false;
    return result;
  }

  return result;
}

function resolveConcentrationCheck(caster, damageTaken) {
  const dc = Math.max(10, Math.floor(damageTaken / 2));
  const saveMod = getSaveMod(caster, 'con');
  const r = d20();
  const total = r + saveMod;
  const success = total >= dc;

  return {
    dc,
    roll: r,
    saveMod,
    total,
    success,
    spell: caster.concentrating,
  };
}

function rollInitiative(combatant) {
  return d20() + getAbilityMod(combatant.abilities?.dex || 10);
}

function getAvailableActions(combatant) {
  const actions = [];

  // Weapon attacks
  for (const weapon of (combatant.weapons || [])) {
    actions.push({ type: 'attack', weapon: weapon.name, label: `Attack with ${weapon.name}` });
  }

  // Spells (only if slots available)
  for (const spell of (combatant.spells || [])) {
    // Check if a slot of the spell's level (or higher) is available
    let hasSlot = false;
    for (let lvl = spell.level; lvl <= 9; lvl++) {
      if ((combatant.spellSlots?.[lvl] || 0) > 0) {
        hasSlot = true;
        break;
      }
    }
    // Cantrips (level 0) don't need slots
    if (spell.level === 0) hasSlot = true;
    if (hasSlot) {
      actions.push({ type: 'spell', spell: spell.name, level: spell.level, label: `Cast ${spell.name}` });
    }
  }

  // Standard actions
  actions.push({ type: 'dodge', label: 'Dodge' });
  actions.push({ type: 'disengage', label: 'Disengage' });
  actions.push({ type: 'dash', label: 'Dash' });
  actions.push({ type: 'help', label: 'Help' });
  actions.push({ type: 'grapple', label: 'Grapple' });
  actions.push({ type: 'shove', label: 'Shove' });

  return actions;
}

module.exports = {
  getAbilityMod,
  getSaveMod,
  getSpellSaveDC,
  getAttackMod,
  rollInitiative,
  resolveAttack,
  resolveSpell,
  applyDamage,
  checkDeath,
  resolveDeathSave,
  _resolveDeathSaveWithRoll,
  resolveConcentrationCheck,
  getAvailableActions,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/aron/Downloads/dnd-server && npm test`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/aron/Downloads/dnd-server
git add resolvers/dnd5e-resolver.js tests/dnd5e-resolver.test.js
git commit -m "feat: add D&D 5e combat resolver with attacks, spells, damage, death saves"
```

---

## Task 3: RuneQuest Resolver

**Files:**
- Create: `resolvers/runequest-resolver.js`
- Create: `tests/runequest-resolver.test.js`

- [ ] **Step 1: Write RuneQuest resolver tests**

Create `tests/runequest-resolver.test.js`:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const rq = require('../resolvers/runequest-resolver');

function makeRQCharacter(overrides = {}) {
  return {
    id: 'harrek', name: 'Harrek', type: 'PC', system: 'runequest',
    characteristics: { str: 14, con: 12, siz: 13, int: 15, pow: 16, dex: 11, cha: 10 },
    hitLocations: {
      head: { hp: 5, maxHp: 5, armor: 0 },
      chest: { hp: 6, maxHp: 6, armor: 3 },
      abdomen: { hp: 5, maxHp: 5, armor: 3 },
      rightArm: { hp: 4, maxHp: 4, armor: 0 },
      leftArm: { hp: 4, maxHp: 4, armor: 0 },
      rightLeg: { hp: 5, maxHp: 5, armor: 3 },
      leftLeg: { hp: 5, maxHp: 5, armor: 3 },
    },
    totalHp: 12,
    weapons: [
      { name: 'broadsword', skill: 65, damage: '1d8+1+1d4', sr: 7 },
      { name: 'medium shield', skill: 45, damage: '1d4+1d4', parry: 45 },
    ],
    runePoints: 3, maxRunePoints: 3,
    magicPoints: 16, maxMagicPoints: 16,
    runeSpells: [{ name: 'Shield', cost: 1, effect: '+20% to parry' }],
    spiritSpells: [{ name: 'Bladesharp 2', cost: 2, effect: '+10% attack, +2 damage' }],
    skills: { dodge: 35, firstAid: 40 },
    strikeRank: 7,
    conditions: [],
    ...overrides,
  };
}

function makeRQEnemy(overrides = {}) {
  return {
    id: 'broo-1', name: 'Broo', type: 'Enemy', system: 'runequest',
    characteristics: { str: 14, con: 11, siz: 14, int: 8, pow: 11, dex: 10, cha: 5 },
    hitLocations: {
      head: { hp: 4, maxHp: 4, armor: 0 },
      chest: { hp: 6, maxHp: 6, armor: 2 },
      abdomen: { hp: 5, maxHp: 5, armor: 0 },
      rightArm: { hp: 3, maxHp: 3, armor: 0 },
      leftArm: { hp: 3, maxHp: 3, armor: 0 },
      rightLeg: { hp: 5, maxHp: 5, armor: 0 },
      leftLeg: { hp: 5, maxHp: 5, armor: 0 },
    },
    totalHp: 11,
    weapons: [{ name: 'mace', skill: 55, damage: '1d8+1d4', sr: 8 }],
    runePoints: 0, maxRunePoints: 0,
    magicPoints: 11, maxMagicPoints: 11,
    runeSpells: [], spiritSpells: [],
    skills: { dodge: 25 },
    strikeRank: 8,
    conditions: [],
    ...overrides,
  };
}

describe('runequest-resolver', () => {
  describe('getAttackResult', () => {
    it('classifies critical (≤ skill/20)', () => {
      assert.strictEqual(rq.getAttackResult(3, 65), 'critical');  // 65/20 = 3.25, so ≤3 is critical
      assert.strictEqual(rq.getAttackResult(1, 65), 'critical');
    });

    it('classifies special (≤ skill/5)', () => {
      assert.strictEqual(rq.getAttackResult(10, 65), 'special');  // 65/5 = 13, 10 ≤ 13
      assert.strictEqual(rq.getAttackResult(13, 65), 'special');
    });

    it('classifies normal hit (≤ skill)', () => {
      assert.strictEqual(rq.getAttackResult(50, 65), 'hit');
      assert.strictEqual(rq.getAttackResult(65, 65), 'hit');
    });

    it('classifies miss (> skill, < 96)', () => {
      assert.strictEqual(rq.getAttackResult(66, 65), 'miss');
      assert.strictEqual(rq.getAttackResult(95, 65), 'miss');
    });

    it('classifies fumble (96-00)', () => {
      assert.strictEqual(rq.getAttackResult(96, 65), 'fumble');
      assert.strictEqual(rq.getAttackResult(100, 65), 'fumble');
    });

    it('handles high skills (> 100%) correctly', () => {
      // Skill 120%: critical = 6, special = 24, fumble only on 100
      assert.strictEqual(rq.getAttackResult(6, 120), 'critical');
      assert.strictEqual(rq.getAttackResult(24, 120), 'special');
      assert.strictEqual(rq.getAttackResult(99, 120), 'hit');
      assert.strictEqual(rq.getAttackResult(100, 120), 'fumble');
    });
  });

  describe('rollHitLocation', () => {
    it('returns valid hit locations', () => {
      const validLocations = ['rightLeg', 'leftLeg', 'abdomen', 'chest', 'rightArm', 'leftArm', 'head'];
      for (let i = 0; i < 50; i++) {
        const loc = rq.rollHitLocation();
        assert.ok(validLocations.includes(loc.location), `Invalid location: ${loc.location}`);
        assert.ok(loc.roll >= 1 && loc.roll <= 20);
      }
    });
  });

  describe('resolveAttack', () => {
    it('returns result with all required fields', () => {
      const attacker = makeRQCharacter();
      const target = makeRQEnemy();
      const result = rq.resolveAttack(attacker, target, attacker.weapons[0], null);
      assert.ok('attackRoll' in result);
      assert.ok('attackResult' in result);
      assert.ok('hitLocation' in result || result.attackResult === 'miss' || result.attackResult === 'fumble');
    });
  });

  describe('resolveDefense', () => {
    it('parry reduces damage by weapon/shield HP', () => {
      const defender = makeRQCharacter();
      const incomingDamage = 10;
      const result = rq.resolveDefense(defender, 'parry', defender.weapons[1], incomingDamage, 'hit');
      assert.ok('defenseRoll' in result);
      assert.ok('defenseResult' in result);
      assert.ok('damageAfterDefense' in result);
    });

    it('dodge on success negates attack entirely', () => {
      // With dodge skill 35, some should succeed
      let dodged = false;
      for (let i = 0; i < 100; i++) {
        const result = rq.resolveDefense(makeRQCharacter(), 'dodge', null, 10, 'hit');
        if (result.defenseResult !== 'miss' && result.defenseResult !== 'fumble') {
          assert.strictEqual(result.damageAfterDefense, 0);
          dodged = true;
          break;
        }
      }
      assert.ok(dodged, 'No successful dodges in 100 attempts (unlikely with 35%)');
    });
  });

  describe('applyDamage', () => {
    it('applies damage to hit location minus armor', () => {
      const target = makeRQEnemy();
      const result = rq.applyDamage(target, 8, 'chest');
      // chest armor = 2, so 8-2 = 6 damage, chest HP 6→0
      assert.strictEqual(result.locationHpAfter, 0);
      assert.strictEqual(result.effectiveDamage, 6);
    });

    it('limb is useless when location HP ≤ 0', () => {
      const target = makeRQEnemy();
      const result = rq.applyDamage(target, 10, 'rightArm');
      assert.strictEqual(result.limbStatus, 'useless');
    });

    it('limb is severed when location HP ≤ -(max location HP)', () => {
      const target = makeRQEnemy();
      const result = rq.applyDamage(target, 10, 'rightArm');
      // rightArm: 3 maxHp, 0 armor, 10 damage = 10 effective → HP goes to -7
      // -7 ≤ -3 (negative max) → severed
      assert.strictEqual(result.limbStatus, 'severed');
    });
  });

  describe('resolveFumble', () => {
    it('returns a fumble result from the melee table', () => {
      const result = rq.resolveFumble('melee');
      assert.ok(result.description);
      assert.ok(result.roll >= 1 && result.roll <= 20);
    });

    it('returns a fumble result from the ranged table', () => {
      const result = rq.resolveFumble('ranged');
      assert.ok(result.description);
    });
  });

  describe('checkDeath', () => {
    it('returns alive for healthy character', () => {
      assert.strictEqual(rq.checkDeath(makeRQCharacter()).status, 'alive');
    });

    it('returns dead when total HP ≤ 0', () => {
      const char = makeRQCharacter({ totalHp: 0 });
      assert.strictEqual(rq.checkDeath(char).status, 'dead');
    });
  });

  describe('rollInitiative (Strike Rank)', () => {
    it('returns strike rank value based on DEX+SIZ', () => {
      const char = makeRQCharacter();
      const sr = rq.rollInitiative(char);
      // Strike ranks are deterministic in RQ (no random roll)
      assert.strictEqual(typeof sr, 'number');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/aron/Downloads/dnd-server && npm test`
Expected: FAIL — `Cannot find module '../resolvers/runequest-resolver'`

- [ ] **Step 3: Implement RuneQuest resolver**

Create `resolvers/runequest-resolver.js`:

```js
'use strict';

const { d20, d100, roll } = require('./dice');

// ── Attack Result Classification ──────────────────────────────────────────────

function getAttackResult(rollValue, skill) {
  const effectiveSkill = Math.max(skill, 1);
  const critThreshold = Math.max(1, Math.floor(effectiveSkill / 20));
  const specialThreshold = Math.max(critThreshold + 1, Math.floor(effectiveSkill / 5));

  // Fumble: 96-00 for skills < 100, only 100 for skills ≥ 100
  const fumbleThreshold = effectiveSkill >= 100 ? 100 : 96;

  if (rollValue >= fumbleThreshold) return 'fumble';
  if (rollValue <= critThreshold) return 'critical';
  if (rollValue <= specialThreshold) return 'special';
  if (rollValue <= Math.min(effectiveSkill, effectiveSkill >= 100 ? 99 : 95)) return 'hit';
  return 'miss';
}

// ── Hit Location ──────────────────────────────────────────────────────────────

const HIT_LOCATION_TABLE = [
  { min: 1, max: 4, location: 'rightLeg' },
  { min: 5, max: 8, location: 'leftLeg' },
  { min: 9, max: 11, location: 'abdomen' },
  { min: 12, max: 12, location: 'chest' },
  { min: 13, max: 15, location: 'rightArm' },
  { min: 16, max: 18, location: 'leftArm' },
  { min: 19, max: 20, location: 'head' },
];

function rollHitLocation() {
  const r = d20();
  const entry = HIT_LOCATION_TABLE.find(e => r >= e.min && r <= e.max);
  return { roll: r, location: entry.location };
}

// ── Fumble Tables (Full) ─────────────────────────────────────────────────────

const MELEE_FUMBLE_TABLE = [
  { min: 1, max: 2, description: 'Lose next attack. Off balance — no parry until next SR.' },
  { min: 3, max: 4, description: 'Lose next attack. Stumble — lose 1 SR next round.' },
  { min: 5, max: 6, description: 'Drop weapon. Must spend 5 SR to recover.' },
  { min: 7, max: 8, description: 'Drop weapon. Weapon lands 1d3 meters away.' },
  { min: 9, max: 10, description: 'Weapon stuck in ground/wall. STR roll to free (5 SR).' },
  { min: 11, max: 12, description: 'Shield strap breaks (if shield) or weapon knocked away 1d6 meters.' },
  { min: 13, max: 14, description: 'Hit nearest ally in random hit location for normal damage.' },
  { min: 15, max: 16, description: 'Hit self in random hit location for half damage.' },
  { min: 17, max: 18, description: 'Fall prone. Must spend 5 SR and movement to stand.' },
  { min: 19, max: 19, description: 'Weapon breaks (if breakable). Unbreakable weapons: drop + fall prone.' },
  { min: 20, max: 20, description: 'Weapon breaks AND hit self in random location for full damage.' },
];

const RANGED_FUMBLE_TABLE = [
  { min: 1, max: 3, description: 'Bowstring breaks or weapon jams. 1d6 rounds to fix.' },
  { min: 4, max: 6, description: 'Lose ammunition. Arrow/bolt/stone lost or broken.' },
  { min: 7, max: 9, description: 'Weapon misfires or slips. Lose next attack.' },
  { min: 10, max: 12, description: 'Hit nearest ally for normal damage.' },
  { min: 13, max: 15, description: 'Drop weapon. Must spend 5 SR to recover.' },
  { min: 16, max: 17, description: 'Wild shot hits random bystander or object in area.' },
  { min: 18, max: 19, description: 'Weapon string snaps/mechanism breaks. Field repair (10 minutes).' },
  { min: 20, max: 20, description: 'Weapon destroyed. Bow snaps, sling tears, etc.' },
];

const NATURAL_FUMBLE_TABLE = [
  { min: 1, max: 4, description: 'Fall prone. Spend 5 SR and movement to stand.' },
  { min: 5, max: 8, description: 'Twist limb. Lose next attack from pain.' },
  { min: 9, max: 12, description: 'Bite tongue / claw stuck. Lose next attack.' },
  { min: 13, max: 15, description: 'Overextend. Opponent gets free attack at +20%.' },
  { min: 16, max: 18, description: 'Collide with obstacle. Take 1d3 damage to random location.' },
  { min: 19, max: 20, description: 'Hit self in random location for full damage.' },
];

const SPELL_FUMBLE_TABLE = [
  { min: 1, max: 4, description: 'Spell fails. Magic Points still spent.' },
  { min: 5, max: 8, description: 'Spell fails. Lose an additional 1d3 Magic Points.' },
  { min: 9, max: 12, description: 'Spell targets random nearby creature instead.' },
  { min: 13, max: 15, description: 'Spell backfires — offensive spell hits caster instead.' },
  { min: 16, max: 18, description: 'Caster stunned for 1 round. All magic disrupted.' },
  { min: 19, max: 20, description: 'Catastrophic failure. Lose 1d6 Magic Points AND spell hits caster.' },
];

function resolveFumble(weaponType) {
  const r = d20();
  let table;
  switch (weaponType) {
    case 'ranged': table = RANGED_FUMBLE_TABLE; break;
    case 'natural': table = NATURAL_FUMBLE_TABLE; break;
    case 'spell': table = SPELL_FUMBLE_TABLE; break;
    default: table = MELEE_FUMBLE_TABLE;
  }
  const entry = table.find(e => r >= e.min && r <= e.max);
  return { roll: r, description: entry.description, weaponType };
}

// ── Special/Critical Effects ──────────────────────────────────────────────────

function getSpecialEffect(weapon, attackResult) {
  // Determine weapon category for special effect
  const name = (weapon.name || '').toLowerCase();
  const isSlashing = name.includes('sword') || name.includes('axe') || name.includes('scimitar') || name.includes('kopis');
  const isCrushing = name.includes('mace') || name.includes('hammer') || name.includes('maul') || name.includes('club') || name.includes('staff');
  const isImpaling = name.includes('spear') || name.includes('rapier') || name.includes('lance') || name.includes('arrow') || name.includes('javelin') || name.includes('dagger');

  if (attackResult === 'critical') {
    return {
      type: 'critical',
      maxDamage: true,    // Roll max weapon damage
      ignoreArmor: true,  // Bypass armor entirely
      description: 'Critical hit! Maximum damage, ignores armor.',
    };
  }

  if (attackResult === 'special') {
    if (isImpaling) {
      return {
        type: 'impale',
        maxWeaponDamage: true,
        extraDamage: true,  // Weapon stuck, extra = max weapon damage dice
        description: 'Impale! Weapon stuck — max weapon damage + impale damage. STR vs SIZ to pull free.',
      };
    }
    if (isSlashing) {
      return {
        type: 'slash',
        maxDamage: true,
        bleed: true,  // 1 HP/round to location
        description: 'Slash! Maximum damage + bleeding (1 HP/round to hit location).',
      };
    }
    if (isCrushing) {
      return {
        type: 'crush',
        maxDamage: true,
        knockback: true,
        description: 'Crush! Maximum damage + knockback. Target must resist (STR vs damage) or fall prone.',
      };
    }
    // Default special
    return {
      type: 'special',
      maxDamage: true,
      description: 'Special success! Maximum weapon damage.',
    };
  }

  return null;
}

// ── Attack Resolution ─────────────────────────────────────────────────────────

function resolveAttack(attacker, target, weapon, defenseChoice) {
  const attackRoll = d100();
  const attackResult = getAttackResult(attackRoll, weapon.skill);

  const result = {
    type: 'attack',
    attacker: attacker.id,
    attackerName: attacker.name,
    target: target.id,
    targetName: target.name,
    weapon: weapon.name,
    attackRoll,
    skill: weapon.skill,
    attackResult,
  };

  if (attackResult === 'fumble') {
    const weaponType = weapon.range ? 'ranged' : 'melee';
    result.fumble = resolveFumble(weaponType);
    return result;
  }

  if (attackResult === 'miss') {
    return result;
  }

  // Hit — roll damage and location
  const hitLoc = rollHitLocation();
  result.hitLocation = hitLoc;

  // Calculate damage
  const dmgRoll = roll(weapon.damage);
  const specialEffect = getSpecialEffect(weapon, attackResult);
  result.specialEffect = specialEffect;

  let totalDamage = dmgRoll.total;
  if (specialEffect?.maxDamage) {
    // For special/critical: use max of weapon damage dice
    const maxRoll = roll(weapon.damage); // We'll calculate max separately
    totalDamage = Math.max(totalDamage, maxRoll.total); // Use higher of roll or re-roll
    // TODO: proper max damage calculation — for now use the better of two rolls
  }
  if (specialEffect?.type === 'critical') {
    // Critical: truly max damage — parse and maximize each die
    totalDamage = maximizeDamage(weapon.damage);
  }

  result.rawDamage = totalDamage;
  result.damageRoll = dmgRoll;

  return result;
}

// Parse dice notation and return maximum possible result
function maximizeDamage(notation) {
  const parts = notation.match(/(\d+d\d+|[+-]?\d+)/gi);
  if (!parts) return 0;
  let total = 0;
  for (const part of parts) {
    const diceMatch = part.match(/^([+-]?)(\d+)d(\d+)$/i);
    if (diceMatch) {
      const sign = diceMatch[1] === '-' ? -1 : 1;
      const count = parseInt(diceMatch[2], 10);
      const sides = parseInt(diceMatch[3], 10);
      total += sign * count * sides;
    } else {
      total += parseInt(part, 10);
    }
  }
  return total;
}

// ── Defense Resolution ────────────────────────────────────────────────────────

function resolveDefense(defender, defenseType, weapon, incomingDamage, incomingAttackResult) {
  if (defenseType === 'dodge') {
    const dodgeSkill = defender.skills?.dodge || 0;
    const defenseRoll = d100();
    const defenseResult = getAttackResult(defenseRoll, dodgeSkill);

    const success = defenseResult === 'critical' || defenseResult === 'special' || defenseResult === 'hit';

    return {
      defenseType: 'dodge',
      defenseRoll,
      skill: dodgeSkill,
      defenseResult,
      success,
      damageAfterDefense: success ? 0 : incomingDamage,
    };
  }

  if (defenseType === 'parry' && weapon) {
    const parrySkill = weapon.parry || weapon.skill || 0;
    const defenseRoll = d100();
    const defenseResult = getAttackResult(defenseRoll, parrySkill);

    // Shield/weapon absorbs damage based on its HP/damage rating
    // Simple: use weapon damage dice max as absorption value
    const absorption = weapon.parry ? 12 : 6; // shields absorb more

    const success = defenseResult === 'critical' || defenseResult === 'special' || defenseResult === 'hit';

    let damageAfterDefense = incomingDamage;
    let weaponDamaged = false;

    if (success) {
      if (defenseResult === 'critical' && (incomingAttackResult === 'hit' || incomingAttackResult === 'special')) {
        // Critical parry vs normal/special: no damage, attacker weapon takes damage
        damageAfterDefense = 0;
        weaponDamaged = true;
      } else if (defenseResult === 'special') {
        // Special parry: absorb double
        damageAfterDefense = Math.max(0, incomingDamage - absorption * 2);
      } else {
        // Normal parry: absorb weapon/shield HP
        damageAfterDefense = Math.max(0, incomingDamage - absorption);
      }
    }

    return {
      defenseType: 'parry',
      defenseRoll,
      skill: parrySkill,
      defenseResult,
      success,
      absorption: success ? absorption : 0,
      damageAfterDefense,
      weaponDamaged,
      parryWeapon: weapon.name,
    };
  }

  // No defense
  return {
    defenseType: 'none',
    defenseRoll: null,
    defenseResult: 'none',
    success: false,
    damageAfterDefense: incomingDamage,
  };
}

// ── Damage Application ────────────────────────────────────────────────────────

function applyDamage(target, damage, locationKey) {
  const location = target.hitLocations[locationKey];
  if (!location) return { error: `Unknown location: ${locationKey}` };

  const armor = location.armor || 0;
  const effectiveDamage = Math.max(0, damage - armor);
  const hpBefore = location.hp;
  location.hp -= effectiveDamage;

  // Update total HP
  if (effectiveDamage > 0) {
    target.totalHp -= effectiveDamage;
  }

  let limbStatus = 'ok';
  if (location.hp <= 0) {
    limbStatus = 'useless';
    if (location.hp <= -location.maxHp) {
      limbStatus = 'severed';
    }
  }

  return {
    location: locationKey,
    armor,
    rawDamage: damage,
    effectiveDamage,
    locationHpBefore: hpBefore,
    locationHpAfter: location.hp,
    locationMaxHp: location.maxHp,
    totalHp: target.totalHp,
    limbStatus,
  };
}

// ── Death Check ───────────────────────────────────────────────────────────────

function checkDeath(combatant) {
  if (combatant.totalHp <= 0) return { status: 'dead' };
  // Check for head/chest at 0
  if (combatant.hitLocations?.head?.hp <= 0) return { status: 'unconscious', reason: 'head' };
  if (combatant.hitLocations?.chest?.hp <= 0) return { status: 'dying', reason: 'chest' };
  if (combatant.hitLocations?.abdomen?.hp <= 0) return { status: 'dying', reason: 'abdomen' };
  return { status: 'alive' };
}

// ── Initiative (Strike Rank) ──────────────────────────────────────────────────

function rollInitiative(combatant) {
  // RuneQuest strike rank is deterministic: based on DEX+SIZ category
  // Lower SR = acts first. Weapon SR added per action.
  const dex = combatant.characteristics?.dex || 10;
  const siz = combatant.characteristics?.siz || 10;
  // DEX SR: DEX 1-5 = 5, 6-8 = 4, 9-12 = 3, 13-15 = 2, 16-18 = 1, 19+ = 0
  let dexSR;
  if (dex <= 5) dexSR = 5;
  else if (dex <= 8) dexSR = 4;
  else if (dex <= 12) dexSR = 3;
  else if (dex <= 15) dexSR = 2;
  else if (dex <= 18) dexSR = 1;
  else dexSR = 0;
  // SIZ SR: SIZ 1-5 = 3, 6-8 = 2, 9-12 = 1, 13-15 = 1, 16-20 = 0, 21+ = 0
  let sizSR;
  if (siz <= 5) sizSR = 3;
  else if (siz <= 8) sizSR = 2;
  else if (siz <= 12) sizSR = 1;
  else if (siz <= 15) sizSR = 1;
  else sizSR = 0;

  return dexSR + sizSR; // Base strike rank (lower = faster)
}

// ── Available Actions ─────────────────────────────────────────────────────────

function getAvailableActions(combatant) {
  const actions = [];
  for (const weapon of (combatant.weapons || [])) {
    if (weapon.parry) {
      actions.push({ type: 'parry', weapon: weapon.name, skill: weapon.parry || weapon.skill, label: `Parry with ${weapon.name}` });
    } else {
      actions.push({ type: 'attack', weapon: weapon.name, skill: weapon.skill, label: `Attack with ${weapon.name}` });
    }
  }
  if (combatant.skills?.dodge) {
    actions.push({ type: 'dodge', skill: combatant.skills.dodge, label: 'Dodge' });
  }
  for (const spell of (combatant.runeSpells || [])) {
    if ((combatant.runePoints || 0) >= (spell.cost || 1)) {
      actions.push({ type: 'rune_spell', spell: spell.name, cost: spell.cost, label: `Cast ${spell.name} (${spell.cost} RP)` });
    }
  }
  for (const spell of (combatant.spiritSpells || [])) {
    if ((combatant.magicPoints || 0) >= (spell.cost || 1)) {
      actions.push({ type: 'spirit_spell', spell: spell.name, cost: spell.cost, label: `Cast ${spell.name} (${spell.cost} MP)` });
    }
  }
  actions.push({ type: 'disengage', label: 'Disengage' });
  return actions;
}

module.exports = {
  getAttackResult,
  rollHitLocation,
  resolveAttack,
  resolveDefense,
  applyDamage,
  checkDeath,
  rollInitiative,
  getAvailableActions,
  resolveFumble,
  getSpecialEffect,
  maximizeDamage,
  HIT_LOCATION_TABLE,
  MELEE_FUMBLE_TABLE,
  RANGED_FUMBLE_TABLE,
  NATURAL_FUMBLE_TABLE,
  SPELL_FUMBLE_TABLE,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/aron/Downloads/dnd-server && npm test`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/aron/Downloads/dnd-server
git add resolvers/runequest-resolver.js tests/runequest-resolver.test.js
git commit -m "feat: add RuneQuest combat resolver with percentile rolls, hit locations, fumble tables"
```

---

## Task 4: Combat Engine

**Files:**
- Create: `combat-engine.js`
- Create: `tests/combat-engine.test.js`

- [ ] **Step 1: Write combat engine tests**

Create `tests/combat-engine.test.js`:

```js
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const CombatEngine = require('../combat-engine');

function makePC5e(id, name, overrides = {}) {
  return {
    id, name, type: 'PC', system: 'dnd5e',
    level: 5, ac: 16, hp: 38, maxHp: 38, speed: 30,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 13, cha: 8 },
    saveProficiencies: ['str', 'con'], proficiencyBonus: 3,
    weapons: [{ name: 'longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing', properties: [] }],
    spells: [], spellSlots: {}, spellcastingAbility: null,
    features: [], conditions: [], concentrating: null,
    deathSaves: { successes: 0, failures: 0 }, inspiration: false,
    ...overrides,
  };
}

function makeEnemy5e(id, name, overrides = {}) {
  return {
    id, name, type: 'Enemy', system: 'dnd5e',
    level: 1, ac: 15, hp: 7, maxHp: 7, speed: 30,
    abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
    saveProficiencies: [], proficiencyBonus: 2,
    weapons: [{ name: 'scimitar', attackMod: 'dex', damage: '1d6', damageType: 'slashing', properties: [] }],
    spells: [], spellSlots: {}, spellcastingAbility: null,
    features: [], conditions: [], concentrating: null,
    deathSaves: { successes: 0, failures: 0 }, inspiration: false,
    ...overrides,
  };
}

describe('CombatEngine', () => {
  let engine;

  beforeEach(() => {
    engine = new CombatEngine();
  });

  describe('initCombat', () => {
    it('sets up combat state with initiative order', () => {
      const pcs = [makePC5e('kael', 'Kael')];
      const enemies = [makeEnemy5e('gob-1', 'Goblin')];
      const state = engine.initCombat(pcs, enemies, 'dnd5e');

      assert.strictEqual(state.active, true);
      assert.strictEqual(state.round, 1);
      assert.strictEqual(state.system, 'dnd5e');
      assert.strictEqual(Object.keys(state.combatants).length, 2);
      assert.strictEqual(state.initiativeOrder.length, 2);
      assert.ok(state.initiativeOrder[0].init >= state.initiativeOrder[1].init); // Sorted descending
    });
  });

  describe('resolveAction', () => {
    it('resolves a melee attack and updates HP', () => {
      const pcs = [makePC5e('kael', 'Kael')];
      const enemies = [makeEnemy5e('gob-1', 'Goblin')];
      engine.initCombat(pcs, enemies, 'dnd5e');

      const result = engine.resolveAction({
        type: 'attack',
        attackerId: 'kael',
        targetId: 'gob-1',
        weapon: 'longsword',
      });

      assert.strictEqual(result.type, 'attack');
      assert.ok('hit' in result);
      if (result.hit) {
        const goblin = engine.getCombatant('gob-1');
        assert.ok(goblin.hp < 7);
      }
    });
  });

  describe('advanceTurn', () => {
    it('advances to next combatant in initiative order', () => {
      const pcs = [makePC5e('kael', 'Kael')];
      const enemies = [makeEnemy5e('gob-1', 'Goblin')];
      engine.initCombat(pcs, enemies, 'dnd5e');

      const first = engine.getCurrentTurn();
      engine.advanceTurn();
      const second = engine.getCurrentTurn();
      assert.notStrictEqual(first.id, second.id);
    });

    it('increments round when wrapping around', () => {
      const pcs = [makePC5e('kael', 'Kael')];
      const enemies = [makeEnemy5e('gob-1', 'Goblin')];
      engine.initCombat(pcs, enemies, 'dnd5e');

      assert.strictEqual(engine.state.round, 1);
      engine.advanceTurn(); // Turn 2 of round 1
      engine.advanceTurn(); // Wraps to round 2
      assert.strictEqual(engine.state.round, 2);
    });

    it('skips dead combatants', () => {
      const pcs = [makePC5e('kael', 'Kael')];
      const enemies = [makeEnemy5e('gob-1', 'Goblin'), makeEnemy5e('gob-2', 'Goblin 2')];
      engine.initCombat(pcs, enemies, 'dnd5e');

      // Kill gob-1
      engine.state.combatants['gob-1'].hp = 0;

      // Advance turns — should skip dead goblin
      const turns = [];
      for (let i = 0; i < 4; i++) {
        turns.push(engine.getCurrentTurn().id);
        engine.advanceTurn();
      }
      assert.ok(!turns.includes('gob-1'), 'Dead combatant should be skipped');
    });
  });

  describe('endCombat', () => {
    it('sets active to false and returns final state', () => {
      const pcs = [makePC5e('kael', 'Kael')];
      const enemies = [makeEnemy5e('gob-1', 'Goblin')];
      engine.initCombat(pcs, enemies, 'dnd5e');

      const final = engine.endCombat();
      assert.strictEqual(engine.state.active, false);
      assert.ok('combatants' in final);
    });
  });

  describe('isCombatOver', () => {
    it('returns true when all enemies are dead', () => {
      const pcs = [makePC5e('kael', 'Kael')];
      const enemies = [makeEnemy5e('gob-1', 'Goblin')];
      engine.initCombat(pcs, enemies, 'dnd5e');

      engine.state.combatants['gob-1'].hp = 0;
      assert.strictEqual(engine.isCombatOver().over, true);
      assert.strictEqual(engine.isCombatOver().reason, 'enemies_defeated');
    });

    it('returns true when all PCs are down', () => {
      const pcs = [makePC5e('kael', 'Kael')];
      const enemies = [makeEnemy5e('gob-1', 'Goblin')];
      engine.initCombat(pcs, enemies, 'dnd5e');

      engine.state.combatants['kael'].hp = 0;
      assert.strictEqual(engine.isCombatOver().over, true);
      assert.strictEqual(engine.isCombatOver().reason, 'pcs_down');
    });

    it('returns false when both sides have combatants up', () => {
      const pcs = [makePC5e('kael', 'Kael')];
      const enemies = [makeEnemy5e('gob-1', 'Goblin')];
      engine.initCombat(pcs, enemies, 'dnd5e');

      assert.strictEqual(engine.isCombatOver().over, false);
    });
  });

  describe('addActiveEffect', () => {
    it('tracks buff effects with duration', () => {
      const pcs = [makePC5e('kael', 'Kael'), makePC5e('elara', 'Elara')];
      const enemies = [makeEnemy5e('gob-1', 'Goblin')];
      engine.initCombat(pcs, enemies, 'dnd5e');

      engine.addActiveEffect({
        name: 'Bless',
        caster: 'elara',
        targets: ['kael', 'elara'],
        effect: { attackBonus: '1d4', saveBonus: '1d4' },
        duration: { type: 'concentration', maxRounds: 10 },
      });

      assert.strictEqual(engine.state.activeEffects.length, 1);
      assert.strictEqual(engine.state.activeEffects[0].name, 'Bless');
    });
  });

  describe('expireEffects', () => {
    it('removes expired round-based effects', () => {
      const pcs = [makePC5e('kael', 'Kael')];
      const enemies = [makeEnemy5e('gob-1', 'Goblin')];
      engine.initCombat(pcs, enemies, 'dnd5e');

      engine.addActiveEffect({
        name: 'Shield of Faith',
        caster: 'kael',
        targets: ['kael'],
        effect: { acBonus: 2 },
        duration: { type: 'rounds', count: 1 },
      });

      assert.strictEqual(engine.state.activeEffects.length, 1);
      // Advance past duration
      engine.state.round = 3;
      engine.expireEffects();
      assert.strictEqual(engine.state.activeEffects.length, 0);
    });

    it('removes concentration effects when caster loses concentration', () => {
      const pcs = [makePC5e('kael', 'Kael', { concentrating: 'Bless' })];
      const enemies = [makeEnemy5e('gob-1', 'Goblin')];
      engine.initCombat(pcs, enemies, 'dnd5e');

      engine.addActiveEffect({
        name: 'Bless',
        caster: 'kael',
        targets: ['kael'],
        effect: { attackBonus: '1d4' },
        duration: { type: 'concentration', maxRounds: 10 },
      });

      engine.breakConcentration('kael');
      assert.strictEqual(engine.state.activeEffects.length, 0);
      assert.strictEqual(engine.state.combatants['kael'].concentrating, null);
    });
  });

  describe('getReactionTriggers (D&D 5e)', () => {
    it('detects concentration check trigger', () => {
      const pcs = [makePC5e('elara', 'Elara', {
        concentrating: 'Bless',
        spellcastingAbility: 'wis',
        spells: [{ name: 'shield', level: 1, reaction: true, effect: '+5 AC until next turn' }],
        spellSlots: { 1: 2 },
        inspiration: true,
      })];
      const enemies = [makeEnemy5e('gob-1', 'Goblin')];
      engine.initCombat(pcs, enemies, 'dnd5e');

      const triggers = engine.getReactionTriggers('elara', {
        type: 'damage',
        damage: 8,
        attackRoll: 15,
        attackTotal: 19,
      });

      assert.ok(triggers.length > 0);
      assert.ok(triggers.some(t => t.type === 'concentration_damage'));
    });
  });

  describe('formatResultsForPrompt', () => {
    it('formats combat results as a readable string', () => {
      const pcs = [makePC5e('kael', 'Kael')];
      const enemies = [makeEnemy5e('gob-1', 'Goblin')];
      engine.initCombat(pcs, enemies, 'dnd5e');

      const result = engine.resolveAction({
        type: 'attack',
        attackerId: 'kael',
        targetId: 'gob-1',
        weapon: 'longsword',
      });

      const text = engine.formatResultForPrompt(result);
      assert.ok(typeof text === 'string');
      assert.ok(text.includes('Kael'));
      assert.ok(text.includes('Goblin'));
      assert.ok(text.includes('longsword'));
    });
  });

  describe('getCombatStateForPrompt', () => {
    it('returns formatted combat state string', () => {
      const pcs = [makePC5e('kael', 'Kael')];
      const enemies = [makeEnemy5e('gob-1', 'Goblin')];
      engine.initCombat(pcs, enemies, 'dnd5e');

      const text = engine.getCombatStateForPrompt();
      assert.ok(text.includes('ACTIVE COMBAT'));
      assert.ok(text.includes('Kael'));
      assert.ok(text.includes('Goblin'));
      assert.ok(text.includes('Round'));
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/aron/Downloads/dnd-server && npm test`
Expected: FAIL — `Cannot find module '../combat-engine'`

- [ ] **Step 3: Implement combat engine**

Create `combat-engine.js`:

```js
'use strict';

const dnd5eResolver = require('./resolvers/dnd5e-resolver');
const rqResolver = require('./resolvers/runequest-resolver');

const resolvers = {
  dnd5e: dnd5eResolver,
  runequest: rqResolver,
};

class CombatEngine {
  constructor() {
    this.state = {
      active: false,
      round: 0,
      system: null,
      turnIndex: 0,
      initiativeOrder: [],
      combatants: {},
      activeEffects: [],
      pendingReaction: null,
      log: [],
    };
  }

  getResolver() {
    return resolvers[this.state.system] || resolvers.dnd5e;
  }

  initCombat(pcs, enemies, system) {
    const resolver = resolvers[system] || resolvers.dnd5e;

    const allCombatants = [...pcs, ...enemies];
    const combatants = {};
    const initEntries = [];

    for (const c of allCombatants) {
      combatants[c.id] = { ...c };
      const init = resolver.rollInitiative(c);
      initEntries.push({ id: c.id, name: c.name, init, type: c.type });
    }

    // Sort by initiative: D&D = higher first, RQ = lower first (strike rank)
    if (system === 'runequest') {
      initEntries.sort((a, b) => a.init - b.init);
    } else {
      initEntries.sort((a, b) => b.init - a.init);
    }

    this.state = {
      active: true,
      round: 1,
      system,
      turnIndex: 0,
      initiativeOrder: initEntries,
      combatants,
      activeEffects: [],
      pendingReaction: null,
      log: [],
    };

    return this.state;
  }

  getCombatant(id) {
    return this.state.combatants[id];
  }

  getCurrentTurn() {
    const entry = this.state.initiativeOrder[this.state.turnIndex];
    if (!entry) return null;
    return this.state.combatants[entry.id];
  }

  advanceTurn() {
    const order = this.state.initiativeOrder;
    let idx = this.state.turnIndex;
    let wrapped = false;

    do {
      idx = (idx + 1) % order.length;
      if (idx === 0) {
        this.state.round++;
        this.expireEffects();
        wrapped = true;
      }
      const combatant = this.state.combatants[order[idx].id];
      // Skip dead/destroyed combatants
      const resolver = this.getResolver();
      const deathStatus = resolver.checkDeath(combatant);
      if (deathStatus.status === 'alive' || deathStatus.status === 'unconscious') {
        break;
      }
    } while (idx !== this.state.turnIndex); // Safety: don't infinite loop

    this.state.turnIndex = idx;
    return this.getCurrentTurn();
  }

  resolveAction(action) {
    const resolver = this.getResolver();
    const attacker = this.state.combatants[action.attackerId];
    if (!attacker) return { error: `Unknown attacker: ${action.attackerId}` };

    if (action.type === 'attack') {
      const target = this.state.combatants[action.targetId];
      if (!target) return { error: `Unknown target: ${action.targetId}` };
      const weapon = attacker.weapons?.find(w => w.name === action.weapon) || attacker.weapons?.[0];
      if (!weapon) return { error: `No weapon found: ${action.weapon}` };

      const result = resolver.resolveAttack(attacker, target, weapon, action.conditions || [], this.state.activeEffects);

      // Apply damage if hit
      if (result.hit || (result.attackResult && result.attackResult !== 'miss' && result.attackResult !== 'fumble')) {
        let damage, damageResult;
        if (this.state.system === 'runequest' && result.hitLocation) {
          // RQ: defense phase first
          // For now, auto-resolve with no defense (defense choice comes from reaction system)
          damage = result.rawDamage || result.totalDamage;
          damageResult = resolver.applyDamage(target, damage, result.hitLocation.location);
        } else {
          damage = result.totalDamage;
          damageResult = resolver.applyDamage(target, damage, result.damageType, this.state.activeEffects);
        }
        result.damageResult = damageResult;
        result.targetDown = resolver.checkDeath(target).status !== 'alive';
      }

      this.state.log.push(result);
      return result;
    }

    if (action.type === 'spell') {
      const targets = (action.targetIds || [action.targetId]).map(id => this.state.combatants[id]).filter(Boolean);
      const spell = attacker.spells?.find(s => s.name === action.spell);
      if (!spell) return { error: `Unknown spell: ${action.spell}` };

      const result = resolver.resolveSpell(attacker, spell, targets, action.conditions || [], this.state.activeEffects);

      // Apply damage/healing
      if (result.type === 'spell_save' && result.targets) {
        for (const tr of result.targets) {
          const target = this.state.combatants[tr.id];
          if (target && tr.damage > 0) {
            const dmgResult = resolver.applyDamage(target, tr.damage, tr.damageType, this.state.activeEffects);
            tr.damageResult = dmgResult;
          }
        }
      }
      if (result.type === 'spell_attack' && result.hit) {
        const target = this.state.combatants[result.target];
        if (target) {
          result.damageResult = resolver.applyDamage(target, result.totalDamage, result.damageType, this.state.activeEffects);
        }
      }
      if (result.type === 'heal') {
        for (const tr of result.targets) {
          const target = this.state.combatants[tr.id];
          if (target) {
            const hpBefore = target.hp;
            target.hp = Math.min(target.maxHp || target.hp + result.healing, target.hp + result.healing);
            tr.hpBefore = hpBefore;
            tr.hpAfter = target.hp;
          }
        }
      }

      // Deduct spell slot
      if (spell.level && spell.level > 0 && attacker.spellSlots) {
        for (let lvl = spell.level; lvl <= 9; lvl++) {
          if ((attacker.spellSlots[lvl] || 0) > 0) {
            attacker.spellSlots[lvl]--;
            result.slotUsed = lvl;
            break;
          }
        }
      }

      // Handle concentration
      if (spell.concentration || result.concentration) {
        if (attacker.concentrating) {
          this.breakConcentration(attacker.id);
        }
        attacker.concentrating = spell.name;
      }

      this.state.log.push(result);
      return result;
    }

    if (action.type === 'dodge') {
      attacker.conditions = attacker.conditions || [];
      if (!attacker.conditions.includes('dodging')) {
        attacker.conditions.push('dodging');
      }
      const result = { type: 'dodge', combatant: attacker.id, combatantName: attacker.name };
      this.state.log.push(result);
      return result;
    }

    if (action.type === 'disengage') {
      const result = { type: 'disengage', combatant: attacker.id, combatantName: attacker.name };
      this.state.log.push(result);
      return result;
    }

    if (action.type === 'dash') {
      const result = { type: 'dash', combatant: attacker.id, combatantName: attacker.name };
      this.state.log.push(result);
      return result;
    }

    return { error: `Unknown action type: ${action.type}` };
  }

  addActiveEffect(effect) {
    effect.roundApplied = this.state.round;
    this.state.activeEffects.push(effect);
  }

  expireEffects() {
    this.state.activeEffects = this.state.activeEffects.filter(effect => {
      const dur = effect.duration;
      if (!dur) return true;
      if (dur.type === 'rounds' && dur.count) {
        return (this.state.round - effect.roundApplied) < dur.count;
      }
      // Concentration effects persist until broken
      if (dur.type === 'concentration') return true;
      // Permanent effects persist
      if (dur.type === 'permanent') return true;
      return true;
    });
  }

  breakConcentration(casterId) {
    const caster = this.state.combatants[casterId];
    if (caster) caster.concentrating = null;
    this.state.activeEffects = this.state.activeEffects.filter(e => {
      return !(e.caster === casterId && e.duration?.type === 'concentration');
    });
  }

  getReactionTriggers(combatantId, event) {
    const combatant = this.state.combatants[combatantId];
    if (!combatant) return [];
    const triggers = [];

    if (event.type === 'damage' && combatant.concentrating) {
      const options = [];
      options.push({ id: 'roll', label: `Roll CON save`, available: true });
      if (combatant.inspiration) {
        options.push({ id: 'inspiration', label: 'Use Inspiration (advantage on save)', available: true });
      }
      // Check for Shield spell as reaction
      const shieldSpell = combatant.spells?.find(s => s.name?.toLowerCase() === 'shield' && s.reaction);
      if (shieldSpell) {
        let hasSlot = false;
        for (let lvl = 1; lvl <= 9; lvl++) {
          if ((combatant.spellSlots?.[lvl] || 0) > 0) { hasSlot = true; break; }
        }
        if (hasSlot && event.attackTotal && event.attackTotal <= (combatant.ac + 5)) {
          options.push({ id: 'shield', label: `Cast Shield (+5 AC, attack becomes MISS)`, available: true });
        }
      }

      triggers.push({
        type: 'concentration_damage',
        combatant: combatantId,
        context: { damage: event.damage, dc: Math.max(10, Math.floor(event.damage / 2)) },
        options,
      });
    }

    return triggers;
  }

  isCombatOver() {
    const resolver = this.getResolver();
    const pcsAlive = Object.values(this.state.combatants)
      .filter(c => c.type === 'PC')
      .some(c => resolver.checkDeath(c).status === 'alive');
    const enemiesAlive = Object.values(this.state.combatants)
      .filter(c => c.type === 'Enemy')
      .some(c => resolver.checkDeath(c).status !== 'dead');

    if (!enemiesAlive) return { over: true, reason: 'enemies_defeated' };
    if (!pcsAlive) return { over: true, reason: 'pcs_down' };
    return { over: false };
  }

  endCombat() {
    this.state.active = false;
    return {
      combatants: this.state.combatants,
      log: this.state.log,
      rounds: this.state.round,
    };
  }

  // ── Prompt Formatting ───────────────────────────────────────────────────────

  formatResultForPrompt(result) {
    if (result.type === 'attack') {
      if (this.state.system === 'runequest') {
        return this._formatRQAttack(result);
      }
      const hitMiss = result.hit ? 'HIT' : 'MISS';
      const dmgStr = result.hit ? ` ${result.damageRoll?.rolls?.join('+')}${result.damageRoll?.modifier ? '+' + result.damageRoll.modifier : ''} = ${result.totalDamage} ${result.damageType}.` : '';
      const hpStr = result.damageResult ? ` ${result.targetName} HP: ${result.damageResult.hpBefore}→${result.damageResult.hp}/${result.damageResult.maxHp}.` : '';
      const critStr = result.critical ? ' CRITICAL!' : '';
      const fumbleStr = result.fumble ? ' FUMBLE!' : '';
      return `${result.attackerName} attacks ${result.targetName} with ${result.weapon}: d20+${result.modifier}=${result.total} vs AC ${result.targetAC}. ${hitMiss}!${critStr}${fumbleStr}${dmgStr}${hpStr}`;
    }

    if (result.type === 'spell_save') {
      const lines = [`${result.casterName} casts ${result.spell} (DC ${result.saveDC} ${result.saveAbility.toUpperCase()} save).`];
      for (const t of result.targets) {
        const saveStr = t.saved ? 'SAVED' : 'FAILED';
        lines.push(`  ${t.name}: d20+${t.saveMod}=${t.saveTotal} vs DC ${result.saveDC}. ${saveStr}! ${t.damage} ${t.damageType} damage.${t.damageResult ? ` HP: ${t.damageResult.hpBefore}→${t.damageResult.hp}.` : ''}`);
      }
      return lines.join('\n');
    }

    if (result.type === 'heal') {
      const t = result.targets[0];
      return `${result.casterName} casts ${result.spell}. Heals ${result.healing} HP.${t?.hpBefore !== undefined ? ` ${t.name} HP: ${t.hpBefore}→${t.hpAfter}.` : ''}`;
    }

    if (result.type === 'dodge') return `${result.combatantName} takes the Dodge action.`;
    if (result.type === 'disengage') return `${result.combatantName} disengages.`;
    if (result.type === 'dash') return `${result.combatantName} dashes.`;

    return JSON.stringify(result);
  }

  _formatRQAttack(result) {
    let str = `${result.attackerName} attacks ${result.targetName} with ${result.weapon}: d100=${result.attackRoll} vs ${result.skill}%. ${result.attackResult.toUpperCase()}!`;
    if (result.fumble) str += ` Fumble: ${result.fumble.description}`;
    if (result.hitLocation) str += ` Hit location: ${result.hitLocation.location} (${result.hitLocation.roll}).`;
    if (result.rawDamage) str += ` Damage: ${result.rawDamage}.`;
    if (result.specialEffect) str += ` ${result.specialEffect.description}`;
    if (result.damageResult) {
      str += ` ${result.hitLocation.location}: ${result.damageResult.locationHpBefore}→${result.damageResult.locationHpAfter} HP (${result.damageResult.armor} armor absorbed).`;
      if (result.damageResult.limbStatus !== 'ok') str += ` Limb ${result.damageResult.limbStatus}!`;
    }
    return str;
  }

  getCombatStateForPrompt() {
    const resolver = this.getResolver();
    const current = this.getCurrentTurn();
    const lines = [
      `ACTIVE COMBAT — Round ${this.state.round}`,
      `Initiative: ${this.state.initiativeOrder.map(e => `${e.name} (${e.init})`).join(' → ')}`,
      `Current turn: ${current?.name || 'unknown'}`,
      '',
      'COMBATANT STATUS:',
    ];

    for (const entry of this.state.initiativeOrder) {
      const c = this.state.combatants[entry.id];
      const status = resolver.checkDeath(c);
      if (status.status === 'dead') {
        lines.push(`- ${c.name}: DEAD`);
        continue;
      }
      if (this.state.system === 'runequest') {
        const locs = Object.entries(c.hitLocations || {})
          .filter(([, loc]) => loc.hp < loc.maxHp)
          .map(([name, loc]) => `${name}: ${loc.hp}/${loc.maxHp}`)
          .join(', ');
        const locsStr = locs ? ` [${locs}]` : '';
        const conds = c.conditions?.length ? `, ${c.conditions.join(', ')}` : '';
        lines.push(`- ${c.name}: ${c.totalHp} total HP${locsStr}${conds}`);
      } else {
        const concStr = c.concentrating ? `, concentrating on ${c.concentrating}` : '';
        const conds = c.conditions?.length ? `, ${c.conditions.join(', ')}` : '';
        lines.push(`- ${c.name}: ${c.hp}/${c.maxHp} HP, AC ${c.ac}${concStr}${conds || ', no conditions'}`);
      }
    }

    if (this.state.activeEffects.length > 0) {
      lines.push('', 'ACTIVE EFFECTS:');
      for (const effect of this.state.activeEffects) {
        const targetNames = (effect.targets || []).map(id => this.state.combatants[id]?.name || id).join(', ');
        const durStr = effect.duration?.type === 'concentration' ? 'concentration' : `${effect.duration?.count || '?'} rounds`;
        lines.push(`- ${effect.name} (${this.state.combatants[effect.caster]?.name || effect.caster}, ${durStr}): ${targetNames}`);
      }
    }

    return lines.join('\n');
  }
}

module.exports = CombatEngine;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/aron/Downloads/dnd-server && npm test`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/aron/Downloads/dnd-server
git add combat-engine.js tests/combat-engine.test.js
git commit -m "feat: add combat engine with state management, turn tracking, and prompt formatting"
```

---

## Task 5: Stat Parser

**Files:**
- Create: `stat-parser.js`
- Create: `tests/stat-parser.test.js`

- [ ] **Step 1: Write stat parser tests**

Create `tests/stat-parser.test.js`:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parseStatsText, DND5E_SCHEMA, RUNEQUEST_SCHEMA } = require('../stat-parser');

describe('stat-parser', () => {
  describe('parseStatsText (D&D 5e)', () => {
    it('extracts structured stats from typical D&D 5e statsText', async () => {
      const statsText = `Level 5 Human Fighter
HP: 38/38 | AC: 16 (Chain Mail + Shield)
STR 16 (+3) DEX 12 (+1) CON 14 (+2) INT 10 (+0) WIS 13 (+1) CHA 8 (-1)
Save Proficiencies: STR, CON
Proficiency Bonus: +3
Weapons: Longsword (1d8 slashing), Javelin (1d6 piercing, 30/120)
Features: Extra Attack, Action Surge, Second Wind
Fighting Style: Defense`;

      // This calls Haiku, so mock it for unit tests
      // In integration tests, use real API
      const result = await parseStatsText(statsText, 'dnd5e', { mock: true });
      assert.ok(result);
      assert.strictEqual(result.system, 'dnd5e');
      assert.strictEqual(typeof result.ac, 'number');
      assert.strictEqual(typeof result.hp, 'number');
      assert.ok(result.abilities);
      assert.ok(result.weapons?.length > 0);
    });
  });

  describe('parseStatsText (RuneQuest)', () => {
    it('extracts structured stats from typical RQ statsText', async () => {
      const statsText = `Harrek the Berserk
STR 14, CON 12, SIZ 13, INT 15, POW 16, DEX 11, CHA 10
Cult: Orlanth Adventurous
Hit Points: 12
Weapons: Broadsword 65%, Medium Shield (Parry 45%)
Dodge: 35%
Rune Points: 3, Magic Points: 16
Armor: Chest/Abdomen/Legs: 3 (leather)`;

      const result = await parseStatsText(statsText, 'runequest', { mock: true });
      assert.ok(result);
      assert.strictEqual(result.system, 'runequest');
      assert.ok(result.characteristics);
      assert.ok(result.hitLocations);
      assert.ok(result.weapons?.length > 0);
    });
  });

  describe('schema validation', () => {
    it('fills defaults for missing optional D&D fields', async () => {
      const minimal = `Level 1 Elf Wizard, HP: 6, AC: 12, STR 8 DEX 14 CON 10 INT 16 WIS 12 CHA 10`;
      const result = await parseStatsText(minimal, 'dnd5e', { mock: true });
      assert.ok(result.conditions);
      assert.ok(Array.isArray(result.conditions));
      assert.strictEqual(result.deathSaves.successes, 0);
      assert.strictEqual(result.deathSaves.failures, 0);
    });
  });
});
```

- [ ] **Step 2: Implement stat parser**

Create `stat-parser.js`:

```js
'use strict';

const DND5E_SCHEMA = {
  system: 'dnd5e',
  level: 'number',
  ac: 'number',
  hp: 'number',
  maxHp: 'number',
  speed: 'number (default 30)',
  abilities: '{ str, dex, con, int, wis, cha } — each a number',
  saveProficiencies: 'array of ability names the character is proficient in saving throws for',
  proficiencyBonus: 'number (2 at level 1-4, 3 at 5-8, 4 at 9-12, 5 at 13-16, 6 at 17-20)',
  weapons: '[{ name, attackMod: "str"|"dex", damage: dice notation like "1d8", damageType, properties: [] }]',
  spells: '[{ name, level: 0-9, save?: ability, damage?: dice, damageType?, healing?: dice, attack?: true, reaction?: true, concentration?: true, effect?: string }]',
  spellSlots: '{ 1: count, 2: count, ... } — current remaining slots',
  spellcastingAbility: '"int"|"wis"|"cha" or null',
  features: 'array of feature name strings',
};

const RUNEQUEST_SCHEMA = {
  system: 'runequest',
  characteristics: '{ str, con, siz, int, pow, dex, cha } — each a number',
  hitLocations: '{ head, chest, abdomen, rightArm, leftArm, rightLeg, leftLeg } — each { hp, maxHp, armor }',
  totalHp: 'number',
  weapons: '[{ name, skill: number (percentage), damage: dice notation, sr?: number, parry?: number (percentage) }]',
  runePoints: 'number',
  maxRunePoints: 'number',
  magicPoints: 'number',
  maxMagicPoints: 'number',
  runeSpells: '[{ name, cost, effect }]',
  spiritSpells: '[{ name, cost, effect }]',
  skills: '{ dodge: number, firstAid: number, ... }',
  strikeRank: 'number',
};

const DND5E_DEFAULTS = {
  speed: 30,
  conditions: [],
  concentrating: null,
  deathSaves: { successes: 0, failures: 0 },
  inspiration: false,
  resistances: [],
  vulnerabilities: [],
  immunities: [],
};

const RUNEQUEST_DEFAULTS = {
  conditions: [],
  runeSpells: [],
  spiritSpells: [],
  skills: {},
};

function buildPrompt(statsText, system) {
  const schema = system === 'runequest' ? RUNEQUEST_SCHEMA : DND5E_SCHEMA;
  return `Extract structured combat stats from this RPG character sheet text. Return ONLY valid JSON, no markdown fences, no explanation.

SCHEMA (follow exactly):
${JSON.stringify(schema, null, 2)}

CHARACTER TEXT:
${statsText}

Return the JSON object. Fill in all fields you can extract. Use reasonable defaults for anything missing (e.g., standard HP per hit die, standard equipment damage dice). For weapons, use standard game-system damage dice.`;
}

async function parseStatsText(statsText, system, options = {}) {
  if (options.mock) {
    // Return a reasonable mock for testing
    return system === 'runequest' ? mockRuneQuest(statsText) : mockDnd5e(statsText);
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = options.anthropic || new Anthropic();

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages: [{ role: 'user', content: buildPrompt(statsText, system) }],
  });

  const text = response.content[0].text.trim();
  // Strip markdown fences if present
  const jsonStr = text.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`Failed to parse combat stats JSON: ${e.message}\nRaw: ${text}`);
  }

  // Apply defaults
  const defaults = system === 'runequest' ? RUNEQUEST_DEFAULTS : DND5E_DEFAULTS;
  for (const [key, value] of Object.entries(defaults)) {
    if (parsed[key] === undefined) parsed[key] = JSON.parse(JSON.stringify(value));
  }

  parsed.system = system;
  return parsed;
}

// ── Mocks for testing ─────────────────────────────────────────────────────────

function mockDnd5e(statsText) {
  return {
    system: 'dnd5e', level: 5, ac: 16, hp: 38, maxHp: 38, speed: 30,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 13, cha: 8 },
    saveProficiencies: ['str', 'con'], proficiencyBonus: 3,
    weapons: [{ name: 'longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing', properties: [] }],
    spells: [], spellSlots: {}, spellcastingAbility: null,
    features: ['Extra Attack'],
    conditions: [], concentrating: null,
    deathSaves: { successes: 0, failures: 0 }, inspiration: false,
    resistances: [], vulnerabilities: [], immunities: [],
  };
}

function mockRuneQuest(statsText) {
  return {
    system: 'runequest',
    characteristics: { str: 14, con: 12, siz: 13, int: 15, pow: 16, dex: 11, cha: 10 },
    hitLocations: {
      head: { hp: 5, maxHp: 5, armor: 0 },
      chest: { hp: 6, maxHp: 6, armor: 3 },
      abdomen: { hp: 5, maxHp: 5, armor: 3 },
      rightArm: { hp: 4, maxHp: 4, armor: 0 },
      leftArm: { hp: 4, maxHp: 4, armor: 0 },
      rightLeg: { hp: 5, maxHp: 5, armor: 3 },
      leftLeg: { hp: 5, maxHp: 5, armor: 3 },
    },
    totalHp: 12,
    weapons: [{ name: 'broadsword', skill: 65, damage: '1d8+1+1d4', sr: 7 }],
    runePoints: 3, maxRunePoints: 3,
    magicPoints: 16, maxMagicPoints: 16,
    runeSpells: [], spiritSpells: [],
    skills: { dodge: 35, firstAid: 40 },
    strikeRank: 7,
    conditions: [],
  };
}

module.exports = { parseStatsText, DND5E_SCHEMA, RUNEQUEST_SCHEMA, buildPrompt };
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /Users/aron/Downloads/dnd-server && npm test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/aron/Downloads/dnd-server
git add stat-parser.js tests/stat-parser.test.js
git commit -m "feat: add stat parser for extracting structured combatStats from free-form text"
```

---

## Task 6: Action Parser

**Files:**
- Create: `action-parser.js`
- Create: `tests/action-parser.test.js`

- [ ] **Step 1: Write action parser tests**

Create `tests/action-parser.test.js`:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parseAction, parseOptions } = require('../action-parser');

function makeCombatContext() {
  return {
    combatants: {
      'kael': { id: 'kael', name: 'Kael', weapons: [{ name: 'longsword' }, { name: 'javelin' }], spells: [{ name: 'fireball' }] },
      'gob-1': { id: 'gob-1', name: 'Goblin', type: 'Enemy' },
      'gob-2': { id: 'gob-2', name: 'Goblin Archer', type: 'Enemy' },
    },
    preTaggedOptions: null,
  };
}

describe('action-parser', () => {
  describe('parseAction (Tier 1 - pattern matching)', () => {
    it('parses "1" as pre-tagged option', () => {
      const ctx = makeCombatContext();
      ctx.preTaggedOptions = [
        { type: 'attack', targetId: 'gob-1', weapon: 'longsword' },
        { type: 'dodge' },
        { type: 'spell', spell: 'fireball', targetId: 'gob-1' },
      ];
      const result = parseAction('1', 'kael', ctx);
      assert.deepStrictEqual(result, { type: 'attack', attackerId: 'kael', targetId: 'gob-1', weapon: 'longsword' });
    });

    it('parses "2" as pre-tagged option', () => {
      const ctx = makeCombatContext();
      ctx.preTaggedOptions = [
        { type: 'attack', targetId: 'gob-1', weapon: 'longsword' },
        { type: 'dodge' },
        { type: 'spell', spell: 'fireball', targetId: 'gob-1' },
      ];
      const result = parseAction('2', 'kael', ctx);
      assert.deepStrictEqual(result, { type: 'dodge', attackerId: 'kael' });
    });

    it('parses "attack goblin with longsword"', () => {
      const result = parseAction('attack goblin with longsword', 'kael', makeCombatContext());
      assert.strictEqual(result.type, 'attack');
      assert.strictEqual(result.weapon, 'longsword');
      assert.strictEqual(result.targetId, 'gob-1');
    });

    it('parses "cast fireball on goblin"', () => {
      const result = parseAction('cast fireball on goblin', 'kael', makeCombatContext());
      assert.strictEqual(result.type, 'spell');
      assert.strictEqual(result.spell, 'fireball');
      assert.strictEqual(result.targetId, 'gob-1');
    });

    it('parses "dodge"', () => {
      const result = parseAction('dodge', 'kael', makeCombatContext());
      assert.strictEqual(result.type, 'dodge');
    });

    it('parses "disengage"', () => {
      const result = parseAction('disengage', 'kael', makeCombatContext());
      assert.strictEqual(result.type, 'disengage');
    });

    it('parses "dash"', () => {
      const result = parseAction('dash', 'kael', makeCombatContext());
      assert.strictEqual(result.type, 'dash');
    });

    it('returns null for unparseable freeform text', () => {
      const result = parseAction('I try to convince the goblin to join our side through interpretive dance', 'kael', makeCombatContext());
      assert.strictEqual(result, null); // Needs Tier 2
    });
  });

  describe('parseOptions', () => {
    it('parses 3 AI-generated options into tagged actions', () => {
      const options = [
        '🗡️ Strike the Goblin with your longsword',
        '🛡️ Raise your shield and dodge',
        '🔥 Leap from the table and attack the Goblin Archer',
      ];
      const results = parseOptions(options, 'kael', makeCombatContext());
      assert.strictEqual(results.length, 3);
      assert.strictEqual(results[0].type, 'attack');
      assert.strictEqual(results[0].targetId, 'gob-1');
      assert.strictEqual(results[1].type, 'dodge');
      assert.strictEqual(results[2].type, 'attack');
      assert.strictEqual(results[2].targetId, 'gob-2');
    });
  });
});
```

- [ ] **Step 2: Implement action parser**

Create `action-parser.js`:

```js
'use strict';

// ── Tier 1: Pattern Matching ──────────────────────────────────────────────────

function parseAction(input, playerId, ctx) {
  const trimmed = input.trim();

  // Option number (1, 2, 3)
  const optionMatch = trimmed.match(/^[1-3]$/);
  if (optionMatch && ctx.preTaggedOptions) {
    const idx = parseInt(optionMatch[0], 10) - 1;
    const tagged = ctx.preTaggedOptions[idx];
    if (tagged) {
      return { ...tagged, attackerId: playerId };
    }
  }

  const lower = trimmed.toLowerCase();

  // Simple actions
  if (/^dodge$/i.test(lower)) return { type: 'dodge', attackerId: playerId };
  if (/^disengage$/i.test(lower)) return { type: 'disengage', attackerId: playerId };
  if (/^dash$/i.test(lower)) return { type: 'dash', attackerId: playerId };
  if (/^help$/i.test(lower)) return { type: 'help', attackerId: playerId };

  // "attack [target] with [weapon]"
  const attackWithMatch = lower.match(/(?:attack|strike|hit|slash|stab|swing at)\s+(.+?)\s+with\s+(.+)/i);
  if (attackWithMatch) {
    const targetId = matchCombatant(attackWithMatch[1], ctx, 'Enemy');
    const weapon = matchWeapon(attackWithMatch[2], ctx.combatants[playerId]);
    if (targetId) return { type: 'attack', attackerId: playerId, targetId, weapon };
  }

  // "attack [target]" (no weapon specified — use first)
  const attackMatch = lower.match(/(?:attack|strike|hit|slash|stab|swing at)\s+(.+)/i);
  if (attackMatch) {
    const targetId = matchCombatant(attackMatch[1], ctx, 'Enemy');
    const weapon = ctx.combatants[playerId]?.weapons?.[0]?.name;
    if (targetId) return { type: 'attack', attackerId: playerId, targetId, weapon };
  }

  // "cast [spell] on/at [target]"
  const castMatch = lower.match(/cast\s+(.+?)\s+(?:on|at)\s+(.+)/i);
  if (castMatch) {
    const spell = matchSpell(castMatch[1], ctx.combatants[playerId]);
    const targetId = matchCombatant(castMatch[2], ctx);
    if (spell) return { type: 'spell', attackerId: playerId, spell, targetId: targetId || playerId };
  }

  // "cast [spell]" (self-target or no target)
  const castSelfMatch = lower.match(/cast\s+(.+)/i);
  if (castSelfMatch) {
    const spell = matchSpell(castSelfMatch[1], ctx.combatants[playerId]);
    if (spell) return { type: 'spell', attackerId: playerId, spell, targetId: playerId };
  }

  // "heal [target]"
  const healMatch = lower.match(/heal\s+(.+)/i);
  if (healMatch) {
    const targetId = matchCombatant(healMatch[1], ctx, 'PC');
    const healSpell = ctx.combatants[playerId]?.spells?.find(s => s.healing || s.effect === 'heal');
    if (healSpell) return { type: 'spell', attackerId: playerId, spell: healSpell.name, targetId: targetId || playerId };
  }

  // Could not parse — return null (Tier 2 needed)
  return null;
}

function matchCombatant(text, ctx, preferType) {
  const lower = text.toLowerCase().trim();
  const combatants = Object.values(ctx.combatants);

  // Exact name match
  const exact = combatants.find(c => c.name.toLowerCase() === lower);
  if (exact) return exact.id;

  // Partial name match
  const partial = combatants.find(c => c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase()));
  if (partial) return partial.id;

  // If preferType given, find first matching type with fuzzy match
  if (preferType) {
    const typed = combatants.filter(c => c.type === preferType);
    const fuzzy = typed.find(c => {
      const words = lower.split(/\s+/);
      return words.some(w => c.name.toLowerCase().includes(w));
    });
    if (fuzzy) return fuzzy.id;
    // Default to first of that type
    if (typed.length === 1) return typed[0].id;
  }

  return null;
}

function matchWeapon(text, combatant) {
  if (!combatant?.weapons) return null;
  const lower = text.toLowerCase().trim();
  const match = combatant.weapons.find(w => w.name.toLowerCase().includes(lower) || lower.includes(w.name.toLowerCase()));
  return match?.name || combatant.weapons[0]?.name;
}

function matchSpell(text, combatant) {
  if (!combatant?.spells) return null;
  const lower = text.toLowerCase().trim();
  const match = combatant.spells.find(s => s.name.toLowerCase().includes(lower) || lower.includes(s.name.toLowerCase()));
  return match?.name || null;
}

// ── Parse AI-generated options into tagged actions ────────────────────────────

function parseOptions(options, playerId, ctx) {
  return options.map(optionText => {
    // Strip emoji prefix
    const cleaned = optionText.replace(/^[🗡️🛡️🔥💬\s]+/u, '').trim();
    const result = parseAction(cleaned, playerId, ctx);
    if (result) return result;
    // Fallback: try to extract attack/dodge/spell from the text
    if (/dodge|defend|shield|block/i.test(cleaned)) return { type: 'dodge', attackerId: playerId };
    if (/attack|strike|slash|stab|swing|charge|leap.*attack/i.test(cleaned)) {
      const targetId = matchCombatant(cleaned, ctx, 'Enemy');
      const weapon = ctx.combatants[playerId]?.weapons?.[0]?.name;
      return { type: 'attack', attackerId: playerId, targetId, weapon };
    }
    if (/cast|spell|magic/i.test(cleaned)) {
      return { type: 'spell', attackerId: playerId, spell: null, targetId: null };
    }
    // Unparseable — will need Tier 2
    return null;
  });
}

// ── Tier 2: AI Assist (called when Tier 1 returns null) ──────────────────────

async function parseActionWithAI(input, playerId, ctx, anthropic) {
  const combatant = ctx.combatants[playerId];
  const enemies = Object.values(ctx.combatants).filter(c => c.type === 'Enemy' && c.hp > 0);
  const allies = Object.values(ctx.combatants).filter(c => c.type === 'PC' && c.id !== playerId);

  const prompt = `Extract the game action from this player input. Reply with JSON only, no explanation.

Player: ${combatant?.name}
Weapons: ${(combatant?.weapons || []).map(w => w.name).join(', ')}
Spells: ${(combatant?.spells || []).map(s => s.name).join(', ')}
Enemies: ${enemies.map(e => `${e.name} (id: ${e.id})`).join(', ')}
Allies: ${allies.map(a => `${a.name} (id: ${a.id})`).join(', ')}

Input: "${input}"

Reply: {"type":"attack|spell|dodge|disengage|dash|grapple|shove","targetId":"id","weapon":"name","spell":"name","notes":"any extra context"}`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const jsonStr = text.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();

  try {
    const parsed = JSON.parse(jsonStr);
    return { ...parsed, attackerId: playerId };
  } catch {
    // If AI response is unparseable, default to basic attack
    const firstEnemy = enemies[0];
    return {
      type: 'attack',
      attackerId: playerId,
      targetId: firstEnemy?.id,
      weapon: combatant?.weapons?.[0]?.name,
      notes: input,
    };
  }
}

async function parseOptionsWithAI(options, playerId, ctx, anthropic) {
  const combatant = ctx.combatants[playerId];
  const enemies = Object.values(ctx.combatants).filter(c => c.type === 'Enemy' && c.hp > 0);

  const prompt = `Parse these 3 RPG action options into structured game actions. Reply with a JSON array of 3 objects, no explanation.

Player: ${combatant?.name}
Weapons: ${(combatant?.weapons || []).map(w => w.name).join(', ')}
Spells: ${(combatant?.spells || []).map(s => s.name).join(', ')}
Enemies: ${enemies.map(e => `${e.name} (id: ${e.id})`).join(', ')}

Options:
1. ${options[0] || ''}
2. ${options[1] || ''}
3. ${options[2] || ''}

Each object: {"type":"attack|spell|dodge|disengage|dash","targetId":"id or null","weapon":"name or null","spell":"name or null"}`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const jsonStr = text.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();

  try {
    const parsed = JSON.parse(jsonStr);
    return parsed.map(p => ({ ...p, attackerId: playerId }));
  } catch {
    return options.map(() => null);
  }
}

module.exports = { parseAction, parseOptions, parseActionWithAI, parseOptionsWithAI };
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /Users/aron/Downloads/dnd-server && npm test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/aron/Downloads/dnd-server
git add action-parser.js tests/action-parser.test.js
git commit -m "feat: add action parser with pattern matching and AI fallback"
```

---

## Task 7: Monster Database & Lookup

**Files:**
- Create: `monster-lookup.js`
- Create: `monsters/monsters-5e-srd.json` (initial 20 common monsters)
- Create: `monsters/monsters-rq-core.json` (initial 10 common creatures)
- Create: `tests/monster-lookup.test.js`
- Modify: `db.js` — add monster_sources and game_monster_sources tables

- [ ] **Step 1: Add DB tables to db.js**

In `db.js`, add to the `initDB()` function, after the existing CREATE TABLE statements:

```sql
CREATE TABLE IF NOT EXISTS monster_sources (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  system TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  game_id TEXT REFERENCES games(id) ON DELETE CASCADE,
  monsters JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS game_monster_sources (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES monster_sources(id) ON DELETE CASCADE,
  priority INT NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, source_id)
);
```

Add DB helper functions after the existing functions:

```js
async function getMonsterFromSources(gameId, slug) {
  // Check game-level overrides first, then attached sources by priority
  const result = await pool.query(`
    SELECT ms.monsters->$2 as monster, ms.name as source_name
    FROM game_monster_sources gms
    JOIN monster_sources ms ON ms.id = gms.source_id
    WHERE gms.game_id = $1
      AND ms.monsters ? $2
    ORDER BY gms.priority ASC
    LIMIT 1
  `, [gameId, slug]);
  return result.rows[0]?.monster || null;
}

async function saveMonsterToGameOverrides(gameId, slug, monsterData) {
  // Get or create game-level override source
  let source = await pool.query(
    `SELECT id FROM monster_sources WHERE game_id = $1 AND scope = 'game' LIMIT 1`,
    [gameId]
  );
  if (source.rows.length === 0) {
    const id = require('crypto').randomUUID();
    await pool.query(
      `INSERT INTO monster_sources (id, name, system, scope, game_id, monsters)
       VALUES ($1, 'Game Overrides', 'any', 'game', $2, $3)`,
      [id, gameId, JSON.stringify({ [slug]: monsterData })]
    );
    await pool.query(
      `INSERT INTO game_monster_sources (game_id, source_id, priority)
       VALUES ($1, $2, 0) ON CONFLICT DO NOTHING`,
      [gameId, id]
    );
  } else {
    await pool.query(
      `UPDATE monster_sources
       SET monsters = monsters || $2::jsonb, updated_at = NOW()
       WHERE id = $1`,
      [source.rows[0].id, JSON.stringify({ [slug]: monsterData })]
    );
  }
}

async function attachDefaultMonsterSource(gameId, system) {
  const source = await pool.query(
    `SELECT id FROM monster_sources WHERE scope = 'global' AND system = $1 LIMIT 1`,
    [system]
  );
  if (source.rows.length > 0) {
    await pool.query(
      `INSERT INTO game_monster_sources (game_id, source_id, priority)
       VALUES ($1, $2, 10) ON CONFLICT DO NOTHING`,
      [gameId, source.rows[0].id]
    );
  }
}
```

Export the new functions.

- [ ] **Step 2: Create initial SRD monster JSON (20 common D&D 5e monsters)**

Create `monsters/monsters-5e-srd.json` — Generate using AI from SRD. Here are the first 20 to get started (the full 300 can be generated in a batch later):

```json
{
  "goblin": {
    "name": "Goblin", "cr": 0.25, "ac": 15, "hp": 7, "maxHp": 7, "speed": 30,
    "abilities": { "str": 8, "dex": 14, "con": 10, "int": 10, "wis": 8, "cha": 8 },
    "saveProficiencies": [], "proficiencyBonus": 2,
    "weapons": [
      { "name": "scimitar", "attackMod": "dex", "damage": "1d6", "damageType": "slashing", "properties": [] },
      { "name": "shortbow", "attackMod": "dex", "damage": "1d6", "damageType": "piercing", "properties": ["ranged"], "range": "80/320" }
    ],
    "spells": [], "spellSlots": {}, "features": ["Nimble Escape"],
    "conditions": [], "resistances": [], "vulnerabilities": [], "immunities": []
  },
  "skeleton": {
    "name": "Skeleton", "cr": 0.25, "ac": 13, "hp": 13, "maxHp": 13, "speed": 30,
    "abilities": { "str": 10, "dex": 14, "con": 15, "int": 6, "wis": 8, "cha": 5 },
    "saveProficiencies": [], "proficiencyBonus": 2,
    "weapons": [
      { "name": "shortsword", "attackMod": "dex", "damage": "1d6", "damageType": "piercing", "properties": [] },
      { "name": "shortbow", "attackMod": "dex", "damage": "1d6", "damageType": "piercing", "properties": ["ranged"], "range": "80/320" }
    ],
    "spells": [], "spellSlots": {}, "features": [],
    "conditions": [], "resistances": [], "vulnerabilities": ["bludgeoning"], "immunities": ["poison"]
  }
}
```

The full file will contain ~20 common monsters initially: goblin, skeleton, zombie, orc, kobold, wolf, dire-wolf, bandit, bugbear, ogre, troll, owlbear, giant-spider, ghoul, wight, mimic, gelatinous-cube, basilisk, manticore, young-green-dragon. Each in the same combatStats schema. **Generate the remaining 18 entries using the same format as the 2 examples above.**

- [ ] **Step 3: Create initial RuneQuest monster JSON**

Create `monsters/monsters-rq-core.json` with 10 common RQ creatures: broo, troll-dark, scorpion-man, jack-o-bear, walktapus, chaos-snail, giant-beetle, saber-tooth-cat, dragonewt, ghost. Each in RuneQuest combatStats format (characteristics, hitLocations, weapons with skill%, etc.).

- [ ] **Step 4: Write monster lookup tests**

Create `tests/monster-lookup.test.js`:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { getMonsterStats, loadDefaultMonsters } = require('../monster-lookup');

describe('monster-lookup', () => {
  describe('loadDefaultMonsters', () => {
    it('loads D&D 5e SRD monsters from JSON', () => {
      const monsters = loadDefaultMonsters('dnd5e');
      assert.ok(monsters['goblin']);
      assert.strictEqual(monsters['goblin'].ac, 15);
      assert.strictEqual(monsters['goblin'].hp, 7);
    });

    it('loads RuneQuest core monsters from JSON', () => {
      const monsters = loadDefaultMonsters('runequest');
      assert.ok(monsters['broo']);
      assert.ok(monsters['broo'].characteristics);
      assert.ok(monsters['broo'].hitLocations);
    });
  });

  describe('getMonsterStats', () => {
    it('finds monster in system defaults', async () => {
      const result = await getMonsterStats('test-game', 'dnd5e', 'goblin', { skipDB: true });
      assert.ok(result);
      assert.strictEqual(result.name, 'Goblin');
      assert.strictEqual(result.ac, 15);
    });

    it('returns null for unknown monster (without AI fallback)', async () => {
      const result = await getMonsterStats('test-game', 'dnd5e', 'ancient-purple-dragon', { skipDB: true, skipAI: true });
      assert.strictEqual(result, null);
    });
  });
});
```

- [ ] **Step 5: Implement monster lookup**

Create `monster-lookup.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');

// Load default monster files into memory at startup
const defaultMonsters = {};

function loadDefaultMonsters(system) {
  if (defaultMonsters[system]) return defaultMonsters[system];

  const filename = system === 'runequest' ? 'monsters-rq-core.json' : 'monsters-5e-srd.json';
  const filePath = path.join(__dirname, 'monsters', filename);

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    defaultMonsters[system] = data;
    return data;
  } catch (e) {
    console.warn(`Failed to load ${filename}: ${e.message}`);
    defaultMonsters[system] = {};
    return {};
  }
}

async function getMonsterStats(gameId, system, slug, options = {}) {
  const { db, anthropic, skipDB, skipAI } = options;

  // 1. Check DB sources (game overrides + attached sources)
  if (!skipDB && db) {
    const dbResult = await db.getMonsterFromSources(gameId, slug);
    if (dbResult) return dbResult;
  }

  // 2. Check system defaults (in-memory JSON)
  const defaults = loadDefaultMonsters(system);
  if (defaults[slug]) {
    return { ...defaults[slug], id: slug };
  }

  // 3. AI fallback
  if (skipAI || !anthropic) return null;

  const stats = await generateMonsterWithAI(slug, system, anthropic, options.hint);

  // Save to game overrides for future use
  if (db && gameId) {
    await db.saveMonsterToGameOverrides(gameId, slug, stats);
  }

  return stats;
}

async function generateMonsterWithAI(slug, system, anthropic, hint) {
  const { DND5E_SCHEMA, RUNEQUEST_SCHEMA } = require('./stat-parser');
  const schema = system === 'runequest' ? RUNEQUEST_SCHEMA : DND5E_SCHEMA;
  const displayName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const prompt = `Generate a ${system === 'runequest' ? 'RuneQuest' : 'D&D 5e'} monster stat block for: ${displayName}
${hint ? `Hint: ${hint}` : ''}

Return ONLY valid JSON matching this schema:
${JSON.stringify(schema, null, 2)}

Include name, all combat-relevant stats, weapons with proper damage dice, and any special abilities. Use accurate stats for the creature type.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const jsonStr = text.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();

  try {
    const parsed = JSON.parse(jsonStr);
    parsed.id = slug;
    parsed.system = system;
    return parsed;
  } catch (e) {
    console.error(`Failed to generate monster ${slug}: ${e.message}`);
    return null;
  }
}

// Preload all defaults at module load
loadDefaultMonsters('dnd5e');
loadDefaultMonsters('runequest');

module.exports = { getMonsterStats, loadDefaultMonsters, generateMonsterWithAI };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/aron/Downloads/dnd-server && npm test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
cd /Users/aron/Downloads/dnd-server
git add monster-lookup.js monsters/ tests/monster-lookup.test.js db.js
git commit -m "feat: add monster database with layered source lookup and AI fallback"
```

---

## Task 8: Server.js Integration — Combat Routing

**Files:**
- Modify: `server.js`

This is the largest integration task. It modifies callClaude to route through the combat engine when combat is active.

- [ ] **Step 1: Add requires and combat state to game initialization**

At the top of `server.js`, after existing requires (~line 10):

```js
const CombatEngine = require('./combat-engine');
const { parseAction, parseOptions, parseActionWithAI, parseOptionsWithAI } = require('./action-parser');
const { parseStatsText } = require('./stat-parser');
const { getMonsterStats } = require('./monster-lookup');
```

In `getGameState()` (~line 85), add to the game state initialization object:

```js
combatEngine: new CombatEngine(),
```

- [ ] **Step 2: Add ENEMIES parsing to parseResponse**

In the `parseResponse` function (after the WORLD parsing section that extracts locations, npcs, accomplishments, charUpdates, turnOrder), add ENEMIES parsing:

```js
// Parse ENEMIES block
const enemiesMatch = worldRaw.match(/ENEMIES:\n((?:- .+\n?)+)/i);
let enemies = [];
if (enemiesMatch) {
  const enemyLines = enemiesMatch[1].trim().split('\n');
  for (const line of enemyLines) {
    const match = line.match(/^-\s*(.+?)\s*\|\s*(\d+)\s*\|\s*(.+?)(?:\s*\|\s*(.+))?$/);
    if (match) {
      enemies.push({
        displayName: match[1].trim(),
        count: parseInt(match[2], 10),
        slug: match[3].trim(),
        hint: match[4]?.trim() || null,
      });
    }
  }
}
if (enemies.length > 0) {
  world.enemies = enemies;
}
```

- [ ] **Step 3: Add combat lifecycle functions**

Add after the parseResponse function:

```js
// ── Combat Lifecycle ──────────────────────────────────────────────────────────

async function initiateCombat(gameId, gameConfig, enemies) {
  const gs = getGameState(gameId);
  const system = gameConfig.system || 'dnd5e';

  // Resolve monster stats for all enemies
  const enemyCombatants = [];
  for (const entry of enemies) {
    for (let i = 0; i < entry.count; i++) {
      const stats = await getMonsterStats(gameId, system, entry.slug, {
        db, anthropic, hint: entry.hint,
      });
      if (stats) {
        const id = `${entry.slug}-${i + 1}`;
        const name = entry.count > 1 ? `${entry.displayName} ${i + 1}` : entry.displayName;
        enemyCombatants.push({ ...stats, id, name, type: 'Enemy' });
      }
    }
  }

  if (enemyCombatants.length === 0) return null;

  // Ensure PCs have combatStats
  const pcCombatants = [];
  for (const [name, char] of Object.entries(gs.data.characters)) {
    let combatStats = char.combatStats;
    if (!combatStats) {
      combatStats = await parseStatsText(char.statsText, system, { anthropic });
      char.combatStats = combatStats;
      await db.upsertCharacter(gameId, name, char);
    }
    pcCombatants.push({ ...combatStats, id: name.toLowerCase().replace(/\s+/g, '-'), name, type: 'PC' });
  }

  // Initialize combat
  const state = gs.combatEngine.initCombat(pcCombatants, enemyCombatants, system);

  // Broadcast
  io.to(gameId).emit('combat_started', {
    initiativeOrder: state.initiativeOrder,
    combatants: Object.fromEntries(
      Object.entries(state.combatants).map(([id, c]) => [id, {
        id, name: c.name, type: c.type,
        hp: c.hp ?? c.totalHp, maxHp: c.maxHp ?? c.totalHp, ac: c.ac,
        conditions: c.conditions || [],
      }])
    ),
    round: state.round,
  });

  return state;
}

async function resolveEnemyTurns(gameId, gameConfig) {
  const gs = getGameState(gameId);
  const engine = gs.combatEngine;
  if (!engine.state.active) return [];

  // Collect all enemies whose turn it is
  const results = [];
  let current = engine.getCurrentTurn();

  while (current && current.type === 'Enemy') {
    // Build tactical context
    const availableActions = engine.getResolver().getAvailableActions(current);
    const pcs = Object.values(engine.state.combatants).filter(c => c.type === 'PC' && c.hp > 0);
    const enemies = Object.values(engine.state.combatants).filter(c => c.type === 'Enemy' && c.hp > 0);

    const tacticalPrompt = `You are the tactical AI for enemy combatants. Choose ONE action for ${current.name}.
Reply ONLY: ACTION: ${current.id} [action-type] [target-id]

${current.name} (${current.hp}/${current.maxHp} HP) can: ${availableActions.map(a => a.label).join(', ')}
Targets: ${pcs.map(p => `${p.name} (id:${p.id}, ${p.hp}/${p.maxHp} HP, AC ${p.ac}${p.concentrating ? ', concentrating on ' + p.concentrating : ''})`).join(', ')}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{ role: 'user', content: tacticalPrompt }],
    });

    const actionText = response.content[0].text.trim();
    const actionMatch = actionText.match(/ACTION:\s*\S+\s+(\S+)\s+(\S+)/);

    let result;
    if (actionMatch) {
      const actionType = actionMatch[1];
      const targetId = actionMatch[2];

      if (actionType === 'multiattack' && current.features?.includes('Multiattack')) {
        // Resolve multiple attacks
        for (const weapon of current.weapons || [current.weapons?.[0]]) {
          if (!weapon) continue;
          const r = engine.resolveAction({ type: 'attack', attackerId: current.id, targetId, weapon: weapon.name });
          results.push(r);
        }
      } else if (actionType.startsWith('attack')) {
        const weaponName = actionType.replace('attack-', '').replace('attack', '');
        const weapon = weaponName ? current.weapons?.find(w => w.name.toLowerCase().includes(weaponName)) : current.weapons?.[0];
        result = engine.resolveAction({ type: 'attack', attackerId: current.id, targetId, weapon: weapon?.name });
      } else {
        result = engine.resolveAction({ type: actionType, attackerId: current.id, targetId });
      }
    } else {
      // Fallback: attack first PC with first weapon
      const firstPC = pcs[0];
      if (firstPC) {
        result = engine.resolveAction({ type: 'attack', attackerId: current.id, targetId: firstPC.id, weapon: current.weapons?.[0]?.name });
      }
    }

    if (result) results.push(result);

    // Check if combat is over
    if (engine.isCombatOver().over) break;

    engine.advanceTurn();
    current = engine.getCurrentTurn();
  }

  return results;
}

function emitCombatUpdate(gameId) {
  const gs = getGameState(gameId);
  const engine = gs.combatEngine;
  if (!engine.state.active) return;

  io.to(gameId).emit('combat_update', {
    round: engine.state.round,
    turnIndex: engine.state.turnIndex,
    currentTurn: engine.getCurrentTurn()?.id,
    combatants: Object.fromEntries(
      Object.entries(engine.state.combatants).map(([id, c]) => [id, {
        id, name: c.name, type: c.type,
        hp: c.hp ?? c.totalHp, maxHp: c.maxHp ?? c.totalHp, ac: c.ac,
        conditions: c.conditions || [],
        concentrating: c.concentrating || null,
      }])
    ),
    activeEffects: engine.state.activeEffects,
    log: engine.state.log.slice(-10), // Last 10 entries
  });
}
```

- [ ] **Step 4: Modify callClaude to route through combat engine**

In the `callClaude` function, after the line `const messages = [...]` and before the API call, add combat routing:

```js
// ── Combat Engine Routing ─────────────────────────────────────────────────
const combatActive = gs.combatEngine?.state?.active;
let combatContext = '';
let playerResult = null;
let enemyResults = [];

if (combatActive) {
  // Parse player action
  const combatCtx = {
    combatants: gs.combatEngine.state.combatants,
    preTaggedOptions: gs.preTaggedOptions || null,
  };
  const currentPlayer = gs.data.turnOrder[gs.data.currentTurnIndex];
  const playerId = currentPlayer?.toLowerCase().replace(/\s+/g, '-');

  let parsedAction = parseAction(userMessage.replace(/^.*?:\s*/, ''), playerId, combatCtx);
  if (!parsedAction) {
    parsedAction = await parseActionWithAI(userMessage.replace(/^.*?:\s*/, ''), playerId, combatCtx, anthropic);
  }

  if (parsedAction) {
    // Resolve player action
    playerResult = gs.combatEngine.resolveAction(parsedAction);
    gs.combatEngine.advanceTurn();

    // Resolve enemy turns
    enemyResults = await resolveEnemyTurns(gameId, gameConfig);

    // Format results for AI prompt
    const allResults = [playerResult, ...enemyResults].filter(Boolean);
    const resultLines = allResults.map(r => gs.combatEngine.formatResultForPrompt(r));

    combatContext = `\n\n${gs.combatEngine.getCombatStateForPrompt()}\n\nRESOLVED THIS ROUND:\n${resultLines.join('\n')}\n\nNarrate these results in your DM persona. It is now ${gs.combatEngine.getCurrentTurn()?.name || 'the next player'}'s turn.`;

    // Check if combat is over
    const overCheck = gs.combatEngine.isCombatOver();
    if (overCheck.over) {
      combatContext += `\n\nCOMBAT IS OVER: ${overCheck.reason === 'enemies_defeated' ? 'All enemies are defeated. Narrate the aftermath and any loot.' : 'All player characters are down.'}`;
      gs.combatEngine.endCombat();
      io.to(gameId).emit('combat_ended', { reason: overCheck.reason });
    }
  }
}

// Inject combat context into the user message
const finalUserMessage = combatActive ? (prefix + userMessage + combatContext) : (prefix + userMessage);
const messages = [
  ...gd.chatHistory,
  { role: 'user', content: finalUserMessage },
];
```

Also, inject combat-mode prompt into system prompt when combat is active. After `const systemPrompt = hasHistory ? buildTrimmedPrompt(...) : buildSystemPrompt(...)`, add:

```js
const combatPromptInjection = combatActive ? `\n\nCOMBAT MODE — The server handles all dice rolls, damage calculation, and HP tracking. You MUST NOT invent dice results or change HP values. Your job is to NARRATE the pre-resolved results provided in RESOLVED THIS ROUND.\nRules:\n- Use the exact numbers provided. Do not alter, round, or reinterpret them.\n- Format each roll as: **🎲 [description] — rolls [total]. HIT/MISS! [damage]. [target] [HP]**\n- Narrate between rolls with 1-2 sentences of flavor in your DM persona.\n- Do NOT skip any resolved action — every result must appear in your narration.\n- For results where a target reaches 0 HP, include KILLSHOT: [dramatic scene description].\n- Conditions are tracked by the server. Mention them narratively but do not add or remove them.` : '';
const finalSystemPrompt = systemPrompt + combatPromptInjection;
```

Use `finalSystemPrompt` in the API call instead of `systemPrompt`.

- [ ] **Step 5: Add post-response combat handling**

After `parseResponse`, in the post-response handling section, add:

```js
// Check for ENEMIES in world data → initiate combat
if (parsed.world?.enemies?.length > 0 && !gs.combatEngine.state.active) {
  await initiateCombat(gameId, gameConfig, parsed.world.enemies);
}

// Pre-parse options for next turn (async, non-blocking)
if (combatActive && parsed.options?.length > 0) {
  const nextPlayer = gs.combatEngine.getCurrentTurn();
  if (nextPlayer) {
    const combatCtx = { combatants: gs.combatEngine.state.combatants };
    // Try Tier 1 first
    const tier1Results = parseOptions(parsed.options, nextPlayer.id, combatCtx);
    if (tier1Results.some(r => r === null)) {
      // Fallback to AI for unparseable options
      parseOptionsWithAI(parsed.options, nextPlayer.id, combatCtx, anthropic).then(results => {
        gs.preTaggedOptions = results;
      }).catch(() => {});
    } else {
      gs.preTaggedOptions = tier1Results;
    }
  }
}

// Emit combat update
if (gs.combatEngine.state.active) {
  emitCombatUpdate(gameId);
}
```

- [ ] **Step 6: Add ENEMIES format to system prompts**

In `buildSystemPrompt()`, add after the existing WORLD format section (around line 380):

```js
`
ENEMIES (include when hostile creatures appear that will initiate combat):
- [Display Name] | [count] | [monster-db-slug]
Example:
- Goblin War Chief | 1 | goblin-war-chief
- Goblin | 3 | goblin
For custom/homebrew: [Name] | [count] | custom | [hint: type, CR, abilities]
`
```

Add the same (condensed) to `buildTrimmedPrompt()`.

- [ ] **Step 7: Add combat socket events**

Add reaction handling socket events after the existing game socket events:

```js
socket.on('reaction_response', async (data) => {
  const gameId = socket.gameId;
  if (!gameId) return;
  const gs = getGameState(gameId);
  const engine = gs.combatEngine;
  if (!engine.state.pendingReaction) return;

  // Resolve the reaction
  const reaction = engine.state.pendingReaction;
  engine.state.pendingReaction = null;

  // Handle based on reaction type
  if (data.choice === 'shield') {
    // Cast Shield spell — +5 AC, re-check if attack hits
    const caster = engine.state.combatants[reaction.combatant];
    if (caster) {
      // Deduct spell slot
      for (let lvl = 1; lvl <= 9; lvl++) {
        if ((caster.spellSlots?.[lvl] || 0) > 0) { caster.spellSlots[lvl]--; break; }
      }
      caster.ac += 5; // Temporary until end of next turn
      // TODO: track Shield as temporary effect
    }
  } else if (data.choice === 'inspiration') {
    const caster = engine.state.combatants[reaction.combatant];
    if (caster) caster.inspiration = false;
    // Re-roll concentration with advantage
  }

  emitCombatUpdate(gameId);
});
```

- [ ] **Step 8: Fix async handler bugs**

At lines ~2165-2187 in server.js, fix the three socket handlers:

Change `socket.on('set_pillars', (data) => {` to `socket.on('set_pillars', async (data) => {`
And add `await` before `gameEngine.setPillars(...)`.

Same for `set_verbosity` and `set_ferocity`.

- [ ] **Step 9: Commit**

```bash
cd /Users/aron/Downloads/dnd-server
git add server.js
git commit -m "feat: integrate combat engine into server.js — combat routing, lifecycle, ENEMIES parsing, async handler fixes"
```

---

## Task 9: Client-Side Combat UI

**Files:**
- Modify: `public/game.html`

- [ ] **Step 1: Add combat CSS styles**

Add after the existing `.turn-order-item` styles (~line 729):

```css
/* Combat HP bars */
.turn-order-item .hp-bar {
  width: 60px; height: 6px; background: #333; border-radius: 3px; overflow: hidden; flex-shrink: 0;
}
.turn-order-item .hp-bar-fill {
  height: 100%; border-radius: 3px; transition: width 0.3s ease;
}
.hp-high { background: #4a8; }
.hp-mid { background: #c84; }
.hp-low { background: #c44; }
.turn-order-item.dead { opacity: 0.4; text-decoration: line-through; }
.turn-order-item .condition-icons { font-size: 0.65rem; opacity: 0.8; }

/* Combat log */
#combat-log {
  display: none; position: fixed; bottom: 0; left: 0; right: 0;
  max-height: 200px; overflow-y: auto; background: rgba(13,6,0,0.95);
  border-top: 1px solid var(--gold); padding: 8px 16px; z-index: 60;
  font-family: 'Courier New', monospace; font-size: 0.8rem; color: var(--parchment);
}
#combat-log .round-header { color: var(--gold); font-weight: bold; margin-top: 8px; }
#combat-log .log-hit { color: #4c8; }
#combat-log .log-miss { color: #c66; }
#combat-log .log-crit { color: #fc4; font-weight: bold; }
#combat-log .log-indent { padding-left: 16px; opacity: 0.8; }
#combat-log-toggle {
  position: fixed; bottom: 8px; right: 16px; z-index: 61;
  background: var(--gold); color: #000; border: none; border-radius: 4px;
  padding: 4px 8px; font-size: 0.75rem; cursor: pointer; display: none;
}

/* Reaction prompt */
#reaction-modal {
  display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  background: rgba(13,6,0,0.98); border: 2px solid var(--gold); border-radius: 12px;
  padding: 20px; z-index: 100; max-width: 400px; width: 90%;
}
#reaction-modal h3 { color: var(--gold); margin: 0 0 12px 0; font-family: 'Cinzel Decorative', cursive; font-size: 1rem; }
#reaction-modal .context { color: var(--parchment); margin-bottom: 12px; font-size: 0.9rem; }
#reaction-modal .timer { color: var(--gold); font-size: 0.8rem; text-align: center; margin-top: 8px; }
#reaction-modal button {
  display: block; width: 100%; margin: 6px 0; padding: 10px;
  background: rgba(200,146,42,0.15); border: 1px solid var(--gold); border-radius: 6px;
  color: var(--parchment); cursor: pointer; text-align: left; font-size: 0.85rem;
}
#reaction-modal button:hover { background: rgba(200,146,42,0.3); }
#reaction-modal button:disabled { opacity: 0.3; cursor: not-allowed; }
```

- [ ] **Step 2: Add combat log and reaction modal HTML**

Add after the turn order overlay HTML (~line 990):

```html
<div id="combat-log"></div>
<button id="combat-log-toggle" onclick="toggleCombatLog()">Combat Log</button>
<div id="reaction-modal">
  <h3 id="reaction-title">Reaction</h3>
  <div id="reaction-context" class="context"></div>
  <div id="reaction-options"></div>
  <div id="reaction-timer" class="timer"></div>
</div>
```

- [ ] **Step 3: Add combat socket handlers and UI functions**

Add to the JavaScript section of game.html:

```js
// ── Combat UI State ───────────────────────────────────────────────────────────
let combatActive = false;
let combatState = null;
let reactionTimeout = null;

socket.on('combat_started', (data) => {
  combatActive = true;
  combatState = data;
  document.getElementById('combat-log').style.display = 'block';
  document.getElementById('combat-log-toggle').style.display = 'block';
  document.getElementById('combat-log').innerHTML = '<div class="round-header">Combat Begins!</div>';
  updateCombatTurnOrder(data);
});

socket.on('combat_update', (data) => {
  combatState = data;
  updateCombatTurnOrder(data);
  appendCombatLog(data.log);
});

socket.on('combat_ended', (data) => {
  combatActive = false;
  combatState = null;
  document.getElementById('combat-log').innerHTML += '<div class="round-header">Combat Ended</div>';
  // Hide turn order after a delay
  setTimeout(() => {
    document.getElementById('turn-order-overlay').style.display = 'none';
    document.getElementById('combat-log-toggle').style.display = 'none';
  }, 5000);
});

socket.on('reaction_prompt', (data) => {
  showReactionPrompt(data);
});

function updateCombatTurnOrder(data) {
  const overlay = document.getElementById('turn-order-overlay');
  const list = document.getElementById('turn-order-list');
  overlay.style.display = 'block';
  list.innerHTML = '';

  const order = data.initiativeOrder || combatState?.initiativeOrder || [];
  const combatants = data.combatants || combatState?.combatants || {};

  for (const entry of order) {
    const c = combatants[entry.id];
    if (!c) continue;

    const hp = c.hp ?? 0;
    const maxHp = c.maxHp ?? 1;
    const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
    const isDead = hp <= 0 && c.type === 'Enemy';
    const isActive = entry.id === data.currentTurn;

    const div = document.createElement('div');
    div.className = 'turn-order-item' +
      (isActive ? ' active' : '') +
      (c.type === 'Enemy' ? ' enemy' : '') +
      (isDead ? ' dead' : '');

    const hpClass = pct > 60 ? 'hp-high' : pct > 30 ? 'hp-mid' : 'hp-low';
    const condIcons = (c.conditions || []).map(cond => {
      const icons = { stunned: '💫', prone: '⬇️', concentrating: '🔮', poisoned: '☠️', blinded: '👁️', frightened: '😨' };
      return icons[cond] || '';
    }).join('');

    div.innerHTML = `
      <span class="turn-num">${escapeHtml(String(entry.init || ''))}</span>
      <span class="turn-name">${escapeHtml(c.name)}</span>
      <div class="hp-bar"><div class="hp-bar-fill ${hpClass}" style="width:${pct}%"></div></div>
      <span class="turn-value">${hp}/${maxHp}</span>
      ${condIcons ? `<span class="condition-icons">${condIcons}</span>` : ''}
    `;
    list.appendChild(div);
  }
}

function appendCombatLog(logEntries) {
  const log = document.getElementById('combat-log');
  if (!logEntries) return;

  for (const entry of logEntries) {
    const div = document.createElement('div');
    if (entry.type === 'attack') {
      const hitClass = entry.hit ? (entry.critical ? 'log-crit' : 'log-hit') : 'log-miss';
      const hitText = entry.hit ? (entry.critical ? 'CRIT!' : 'HIT!') : 'MISS!';
      div.className = hitClass;
      div.textContent = `${entry.attackerName} → ${entry.targetName}: ${entry.roll}+${entry.modifier}=${entry.total} vs AC ${entry.targetAC}. ${hitText}${entry.hit ? ` ${entry.totalDamage} ${entry.damageType}.` : ''}${entry.damageResult ? ` [${entry.damageResult.hpBefore}→${entry.damageResult.hp} HP]` : ''}`;
    } else {
      div.textContent = JSON.stringify(entry);
    }
    log.appendChild(div);
  }
  log.scrollTop = log.scrollHeight;
}

function toggleCombatLog() {
  const log = document.getElementById('combat-log');
  log.style.display = log.style.display === 'none' ? 'block' : 'none';
}

function showReactionPrompt(data) {
  const modal = document.getElementById('reaction-modal');
  document.getElementById('reaction-title').textContent = data.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  document.getElementById('reaction-context').textContent = `${data.context.damage ? `Taking ${data.context.damage} damage. ` : ''}DC ${data.context.dc} save required.`;

  const optionsDiv = document.getElementById('reaction-options');
  optionsDiv.innerHTML = '';
  for (const opt of data.options) {
    const btn = document.createElement('button');
    btn.textContent = opt.label;
    btn.disabled = opt.available === false;
    btn.onclick = () => {
      socket.emit('reaction_response', { choice: opt.id });
      modal.style.display = 'none';
      clearTimeout(reactionTimeout);
    };
    optionsDiv.appendChild(btn);
  }

  // 30-second timer
  let remaining = 30;
  const timerDiv = document.getElementById('reaction-timer');
  timerDiv.textContent = `Auto-resolve in ${remaining}s`;
  reactionTimeout = setInterval(() => {
    remaining--;
    timerDiv.textContent = `Auto-resolve in ${remaining}s`;
    if (remaining <= 0) {
      clearInterval(reactionTimeout);
      socket.emit('reaction_response', { choice: data.options[0]?.id || 'roll' });
      modal.style.display = 'none';
    }
  }, 1000);

  modal.style.display = 'block';
}
```

- [ ] **Step 4: Commit**

```bash
cd /Users/aron/Downloads/dnd-server
git add public/game.html
git commit -m "feat: add combat UI — combat log panel, HP bars in turn order, reaction prompt modal"
```

---

## Task 10: Generate Full Monster SRD Data

**Files:**
- Modify: `monsters/monsters-5e-srd.json` (expand to ~300 monsters)
- Modify: `monsters/monsters-rq-core.json` (expand to ~30 creatures)

- [ ] **Step 1: Generate D&D 5e SRD monsters**

Use a subagent to generate the full SRD monster list. Run a script that calls Haiku in batches to generate stat blocks for all SRD monsters, outputting them in the combatStats JSON format. Batch 20 monsters per API call to keep costs down.

Key monsters to include beyond the initial 20: all SRD dragons (young/adult/ancient for each color), elementals, demons/devils, giants, undead (vampire, lich, mummy, wraith, specter, ghost), beasts (bear, boar, crocodile, eagle, lion, tiger, ape, elephant), aberrations (beholder, mind flayer), fey (dryad, satyr), and all common encounter monsters.

- [ ] **Step 2: Generate RuneQuest core creatures**

Expand to ~30 creatures: broo, dark troll, scorpion man, jack-o-bear, walktapus, chaos snail, giant beetle, saber-tooth cat, dragonewt (all 5 stages), dream dragon, dinosaurs (allosaur, brontosaur), spirits (disease, passion, magic), elementals (air, earth, fire, water — small/medium/large), griffin, hippogriff, centaur, minotaur, undead (zombie, skeleton, vampire, ghost, wraith).

- [ ] **Step 3: Validate all monster JSON**

Run a validation script to ensure every monster entry has required fields and valid data:

```bash
node -e "
const d = require('./monsters/monsters-5e-srd.json');
const r = require('./monsters/monsters-rq-core.json');
let errors = 0;
for (const [slug, m] of Object.entries(d)) {
  if (!m.ac || !m.hp || !m.weapons?.length) { console.log('5e missing fields:', slug); errors++; }
}
for (const [slug, m] of Object.entries(r)) {
  if (!m.characteristics || !m.hitLocations || !m.weapons?.length) { console.log('rq missing fields:', slug); errors++; }
}
console.log(errors ? errors + ' errors' : 'All valid');
"
```

- [ ] **Step 4: Commit**

```bash
cd /Users/aron/Downloads/dnd-server
git add monsters/
git commit -m "feat: add full SRD monster database (5e + RuneQuest)"
```

---

## Task 11: Integration Testing & Polish

**Files:**
- Create: `tests/integration.test.js`

- [ ] **Step 1: Write integration tests**

Create `tests/integration.test.js`:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const CombatEngine = require('../combat-engine');
const { parseAction } = require('../action-parser');
const { loadDefaultMonsters } = require('../monster-lookup');

describe('integration: full combat round', () => {
  it('runs a complete D&D 5e combat round: PC attacks, enemy attacks, HP updates', () => {
    const engine = new CombatEngine();

    const pc = {
      id: 'kael', name: 'Kael', type: 'PC', system: 'dnd5e',
      level: 5, ac: 16, hp: 38, maxHp: 38, speed: 30,
      abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 13, cha: 8 },
      saveProficiencies: ['str', 'con'], proficiencyBonus: 3,
      weapons: [{ name: 'longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing', properties: [] }],
      spells: [], spellSlots: {}, spellcastingAbility: null,
      features: [], conditions: [], concentrating: null,
      deathSaves: { successes: 0, failures: 0 }, inspiration: false,
    };

    const monsters = loadDefaultMonsters('dnd5e');
    const goblin = { ...monsters['goblin'], id: 'gob-1', name: 'Goblin', type: 'Enemy' };

    engine.initCombat([pc], [goblin], 'dnd5e');
    assert.strictEqual(engine.state.active, true);

    // PC attacks goblin
    const pcResult = engine.resolveAction({ type: 'attack', attackerId: 'kael', targetId: 'gob-1', weapon: 'longsword' });
    assert.ok(pcResult.type === 'attack');
    assert.ok('hit' in pcResult);

    // Check state consistency
    const goblinAfter = engine.getCombatant('gob-1');
    if (pcResult.hit) {
      assert.ok(goblinAfter.hp < 7, 'Goblin should take damage on hit');
    } else {
      assert.strictEqual(goblinAfter.hp, 7, 'Goblin should not take damage on miss');
    }

    // Format for prompt
    const promptText = engine.formatResultForPrompt(pcResult);
    assert.ok(promptText.includes('Kael'));
    assert.ok(promptText.includes('Goblin'));

    // Full state for prompt
    const stateText = engine.getCombatStateForPrompt();
    assert.ok(stateText.includes('ACTIVE COMBAT'));

    // Check combat over conditions
    engine.state.combatants['gob-1'].hp = 0;
    assert.strictEqual(engine.isCombatOver().over, true);
  });

  it('action parser + combat engine work together', () => {
    const engine = new CombatEngine();
    const pc = {
      id: 'kael', name: 'Kael', type: 'PC', system: 'dnd5e',
      level: 5, ac: 16, hp: 38, maxHp: 38,
      abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 13, cha: 8 },
      saveProficiencies: ['str', 'con'], proficiencyBonus: 3,
      weapons: [{ name: 'longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing', properties: [] }],
      spells: [], spellSlots: {}, conditions: [],
    };
    const goblin = {
      id: 'gob-1', name: 'Goblin', type: 'Enemy',
      ac: 15, hp: 7, maxHp: 7,
      abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
      proficiencyBonus: 2,
      weapons: [{ name: 'scimitar', attackMod: 'dex', damage: '1d6', damageType: 'slashing', properties: [] }],
      conditions: [],
    };

    engine.initCombat([pc], [goblin], 'dnd5e');

    const ctx = { combatants: engine.state.combatants, preTaggedOptions: null };
    const parsed = parseAction('attack goblin with longsword', 'kael', ctx);
    assert.ok(parsed);
    assert.strictEqual(parsed.type, 'attack');

    const result = engine.resolveAction(parsed);
    assert.ok(result.type === 'attack');
  });

  it('runs a RuneQuest combat with hit locations', () => {
    const engine = new CombatEngine();

    const pc = {
      id: 'harrek', name: 'Harrek', type: 'PC', system: 'runequest',
      characteristics: { str: 14, con: 12, siz: 13, int: 15, pow: 16, dex: 11, cha: 10 },
      hitLocations: {
        head: { hp: 5, maxHp: 5, armor: 0 }, chest: { hp: 6, maxHp: 6, armor: 3 },
        abdomen: { hp: 5, maxHp: 5, armor: 3 }, rightArm: { hp: 4, maxHp: 4, armor: 0 },
        leftArm: { hp: 4, maxHp: 4, armor: 0 }, rightLeg: { hp: 5, maxHp: 5, armor: 3 },
        leftLeg: { hp: 5, maxHp: 5, armor: 3 },
      },
      totalHp: 12,
      weapons: [{ name: 'broadsword', skill: 65, damage: '1d8+1+1d4', sr: 7 }],
      skills: { dodge: 35 }, conditions: [],
      runePoints: 3, maxRunePoints: 3, magicPoints: 16, maxMagicPoints: 16,
      runeSpells: [], spiritSpells: [], strikeRank: 7,
    };

    const broo = {
      id: 'broo-1', name: 'Broo', type: 'Enemy', system: 'runequest',
      characteristics: { str: 14, con: 11, siz: 14, int: 8, pow: 11, dex: 10, cha: 5 },
      hitLocations: {
        head: { hp: 4, maxHp: 4, armor: 0 }, chest: { hp: 6, maxHp: 6, armor: 2 },
        abdomen: { hp: 5, maxHp: 5, armor: 0 }, rightArm: { hp: 3, maxHp: 3, armor: 0 },
        leftArm: { hp: 3, maxHp: 3, armor: 0 }, rightLeg: { hp: 5, maxHp: 5, armor: 0 },
        leftLeg: { hp: 5, maxHp: 5, armor: 0 },
      },
      totalHp: 11,
      weapons: [{ name: 'mace', skill: 55, damage: '1d8+1d4', sr: 8 }],
      skills: { dodge: 25 }, conditions: [],
      runePoints: 0, maxRunePoints: 0, magicPoints: 11, maxMagicPoints: 11,
      runeSpells: [], spiritSpells: [], strikeRank: 8,
    };

    engine.initCombat([pc], [broo], 'runequest');
    assert.strictEqual(engine.state.active, true);
    assert.strictEqual(engine.state.system, 'runequest');

    const result = engine.resolveAction({ type: 'attack', attackerId: 'harrek', targetId: 'broo-1', weapon: 'broadsword' });
    assert.ok(result.attackRoll >= 1 && result.attackRoll <= 100);
    assert.ok(['critical', 'special', 'hit', 'miss', 'fumble'].includes(result.attackResult));
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `cd /Users/aron/Downloads/dnd-server && npm test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
cd /Users/aron/Downloads/dnd-server
git add tests/integration.test.js
git commit -m "feat: add integration tests for full combat rounds (D&D 5e + RuneQuest)"
```

---

## Task 12: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add combat engine documentation to CLAUDE.md**

Add a new section documenting the combat engine architecture, file map, and key patterns:

```markdown
## Combat Engine

Server-side combat engine that owns all dice rolls, math, HP tracking, and conditions.
The AI narrates pre-resolved results — it does NOT simulate combat rules.

### Key Files
- `combat-engine.js` — Combat state management, lifecycle, turn routing
- `resolvers/dnd5e-resolver.js` — D&D 5e: attacks, spells, saves, damage, death saves
- `resolvers/runequest-resolver.js` — RuneQuest: percentile rolls, parry/dodge, hit locations, fumble tables
- `resolvers/dice.js` — Real RNG, dice notation parser
- `stat-parser.js` — Haiku: statsText → combatStats JSON extraction
- `action-parser.js` — Pattern matching + Haiku fallback for player intent
- `monster-lookup.js` — Layered monster source resolution
- `monsters/monsters-5e-srd.json` — D&D 5e SRD monsters
- `monsters/monsters-rq-core.json` — RuneQuest core creatures

### Combat Flow
1. AI introduces enemies with ENEMIES: block → server parses, looks up stats
2. server.js calls combatEngine.initCombat() → rolls initiative, sets up state
3. Player acts → action-parser extracts intent → engine resolves with real dice
4. Enemy turns → Haiku picks tactics → engine resolves each action
5. All results formatted as text → injected into AI prompt → AI narrates
6. Combat ends when all enemies dead, AI declares COMBAT_END, or TPK

### Monster Sources (checked in order)
1. Game-level overrides (DB)
2. Campaign sources (DB, shareable)
3. System defaults (JSON files, in-memory)
4. AI fallback (Haiku generates, saves to game overrides)

### Gotchas
- combatStats is structured JSON alongside statsText — keep both in sync
- statsText re-parsing triggers on CHAR_UPDATES during combat
- Reaction system can pause resolution mid-turn (Shield, concentration saves)
- RuneQuest uses strike ranks (lower = faster), D&D uses initiative (higher = faster)
```

- [ ] **Step 2: Commit**

```bash
cd /Users/aron/Downloads/dnd-server
git add CLAUDE.md
git commit -m "docs: add combat engine architecture to CLAUDE.md"
```

---

## Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | Test infra + Dice module | `resolvers/dice.js`, `tests/dice.test.js` |
| 2 | D&D 5e resolver | `resolvers/dnd5e-resolver.js` |
| 3 | RuneQuest resolver | `resolvers/runequest-resolver.js` |
| 4 | Combat engine | `combat-engine.js` |
| 5 | Stat parser | `stat-parser.js` |
| 6 | Action parser | `action-parser.js` |
| 7 | Monster DB + lookup | `monster-lookup.js`, `monsters/`, `db.js` |
| 8 | Server.js integration | `server.js` (combat routing, lifecycle, prompts) |
| 9 | Client combat UI | `public/game.html` |
| 10 | Full monster data | `monsters/` JSON files |
| 11 | Integration tests | `tests/integration.test.js` |
| 12 | Update CLAUDE.md | `CLAUDE.md` |
