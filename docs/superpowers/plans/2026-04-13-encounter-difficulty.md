# Encounter Difficulty Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a server-side encounter difficulty module that uses DPR math to design balanced encounters, plan adventuring days, and self-correct based on actual combat outcomes.

**Architecture:** New `encounter-designer.js` module with pure functions for DPR calculation, encounter budgeting, monster selection, and day planning. Integrates with `combat-engine.js` for post-combat data collection. Server.js generates plans on game start and injects them into AI prompts. Host tab gets a planner panel.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert`, existing monster JSON database, existing combat engine

**Spec:** `docs/superpowers/specs/2026-04-13-encounter-difficulty-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `encounter-designer.js` | Core module: DPR estimation, HP/DPR budgets, monster selection, social/exploration scaling, day planning, difficulty correction |
| `tests/encounter-designer.test.js` | Unit tests for all pure functions |
| `test-encounter-designer.js` | CLI test harness — run scenarios without server |

### Modified Files
| File | Changes |
|------|---------|
| `combat-engine.js` | Add `getCombatSummary()` method that extracts per-character damage/healing/slots from combat log |
| `server.js` | Post-combat DPR collection, encounter plan generation on game start/long rest, plan injection into prompts, host tab socket events |
| `public/game.html` | Encounter planner panel in host tab |

---

## Task 1: Dice Math Utilities & DPR Estimator

**Files:**
- Create: `encounter-designer.js`
- Create: `tests/encounter-designer.test.js`

- [ ] **Step 1: Write DPR estimation tests**

Create `tests/encounter-designer.test.js`:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const ed = require('../encounter-designer');

// ── Test fixtures ──────────────────────────────────────────────

function makeFighter() {
  return {
    system: 'dnd5e', level: 5, ac: 18, hp: 44, maxHp: 44,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 13, cha: 8 },
    proficiencyBonus: 3,
    weapons: [{ name: 'longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing', properties: [] }],
    spells: [], spellSlots: {}, spellcastingAbility: null,
    features: ['Extra Attack'],
  };
}

function makeCleric() {
  return {
    system: 'dnd5e', level: 5, ac: 18, hp: 38, maxHp: 38,
    abilities: { str: 14, dex: 10, con: 14, int: 10, wis: 16, cha: 12 },
    proficiencyBonus: 3,
    weapons: [{ name: 'mace', attackMod: 'str', damage: '1d6', damageType: 'bludgeoning', properties: [] }],
    spells: [
      { name: 'guiding bolt', level: 1, attack: true, damage: '4d6', damageType: 'radiant' },
      { name: 'spiritual weapon', level: 2, damage: '1d8', damageType: 'force' },
      { name: 'spirit guardians', level: 3, damage: '3d8', damageType: 'radiant', save: 'wis' },
    ],
    spellSlots: { 1: 4, 2: 3, 3: 2 }, spellcastingAbility: 'wis',
    features: [],
  };
}

function makeRogue() {
  return {
    system: 'dnd5e', level: 5, ac: 15, hp: 33, maxHp: 33,
    abilities: { str: 10, dex: 18, con: 12, int: 13, wis: 12, cha: 14 },
    proficiencyBonus: 3,
    weapons: [{ name: 'rapier', attackMod: 'dex', damage: '1d8', damageType: 'piercing', properties: ['finesse'] }],
    spells: [], spellSlots: {}, spellcastingAbility: null,
    features: ['Sneak Attack 3d6'],
  };
}

function makeWizard() {
  return {
    system: 'dnd5e', level: 5, ac: 12, hp: 26, maxHp: 26,
    abilities: { str: 8, dex: 14, con: 12, int: 18, wis: 12, cha: 10 },
    proficiencyBonus: 3,
    weapons: [{ name: 'dagger', attackMod: 'dex', damage: '1d4', damageType: 'piercing', properties: [] }],
    spells: [
      { name: 'fire bolt', level: 0, attack: true, damage: '2d10', damageType: 'fire' },
      { name: 'fireball', level: 3, save: 'dex', damage: '8d6', damageType: 'fire' },
      { name: 'magic missile', level: 1, damage: '3d4+3', damageType: 'force' },
    ],
    spellSlots: { 1: 4, 2: 3, 3: 2 }, spellcastingAbility: 'int',
    features: [],
  };
}

describe('encounter-designer', () => {
  describe('avgDice', () => {
    it('calculates average of dice notation', () => {
      assert.strictEqual(ed.avgDice('1d8'), 4.5);
      assert.strictEqual(ed.avgDice('2d6'), 7);
      assert.strictEqual(ed.avgDice('1d8+3'), 7.5);
      assert.strictEqual(ed.avgDice('8d6'), 28);
      assert.strictEqual(ed.avgDice('1d4+1d4'), 5); // compound
      assert.strictEqual(ed.avgDice('3d4+3'), 10.5);
    });
  });

  describe('estimateCharacterDPR', () => {
    it('estimates fighter DPR (Extra Attack)', () => {
      const dpr = ed.estimateCharacterDPR(makeFighter());
      // Longsword: avg 4.5+3=7.5, hit prob vs AC 13 ~65%, Extra Attack ×2
      // ~7.5 × 0.65 × 2 = ~9.75 + crit bonus
      assert.ok(dpr.effectiveDPR > 8 && dpr.effectiveDPR < 14, `Fighter DPR ${dpr.effectiveDPR}`);
    });

    it('estimates rogue DPR (Sneak Attack)', () => {
      const dpr = ed.estimateCharacterDPR(makeRogue());
      // Rapier: avg 4.5+4=8.5 + Sneak 3d6 avg 10.5 = 19 × ~70% = ~13.3
      assert.ok(dpr.effectiveDPR > 10 && dpr.effectiveDPR < 18, `Rogue DPR ${dpr.effectiveDPR}`);
    });

    it('estimates wizard DPR (cantrip + spell amortization)', () => {
      const dpr = ed.estimateCharacterDPR(makeWizard());
      // Fire Bolt: avg 11 × ~65% = ~7.15 + fireball amortized
      assert.ok(dpr.effectiveDPR > 6 && dpr.effectiveDPR < 16, `Wizard DPR ${dpr.effectiveDPR}`);
    });

    it('estimates cleric DPR', () => {
      const dpr = ed.estimateCharacterDPR(makeCleric());
      assert.ok(dpr.effectiveDPR > 4 && dpr.effectiveDPR < 12, `Cleric DPR ${dpr.effectiveDPR}`);
    });
  });

  describe('calculatePartyDPR', () => {
    it('sums individual DPRs', () => {
      const party = [makeFighter(), makeCleric(), makeRogue(), makeWizard()];
      const result = ed.calculatePartyDPR(party);
      assert.ok(result.totalDPR > 25 && result.totalDPR < 55, `Party DPR ${result.totalDPR}`);
      assert.strictEqual(result.characters.length, 4);
    });
  });

  describe('calculateMonsterHPBudget', () => {
    it('scales with ferocity', () => {
      const partyDPR = 40;
      const deadly = ed.calculateMonsterHPBudget(partyDPR, 1);
      const balanced = ed.calculateMonsterHPBudget(partyDPR, 3);
      const easy = ed.calculateMonsterHPBudget(partyDPR, 5);
      assert.ok(deadly > balanced, 'Deadly should have more HP than balanced');
      assert.ok(balanced > easy, 'Balanced should have more HP than easy');
      // Balanced: 40 DPR × 3.5 rounds × 1.0 = ~140
      assert.ok(balanced > 100 && balanced < 200, `Balanced HP budget ${balanced}`);
    });

    it('scales with encounter position', () => {
      const partyDPR = 40;
      const early = ed.calculateMonsterHPBudget(partyDPR, 3, 'early');
      const boss = ed.calculateMonsterHPBudget(partyDPR, 3, 'boss');
      assert.ok(boss > early * 2, `Boss ${boss} should be >2x early ${early}`);
    });
  });

  describe('calculateMonsterDPRBudget', () => {
    it('scales with ferocity', () => {
      const partyHP = 140;
      const deadly = ed.calculateMonsterDPRBudget(partyHP, 1);
      const easy = ed.calculateMonsterDPRBudget(partyHP, 5);
      assert.ok(deadly > easy * 2, `Deadly DPR ${deadly} should be >2x easy ${easy}`);
    });
  });

  describe('selectMonsters', () => {
    it('selects monsters within HP budget', () => {
      const monsters = require('../monsters/monsters-5e-srd.json');
      const result = ed.selectMonsters(80, 15, monsters);
      assert.ok(result.length > 0, 'Should select at least one monster');
      const totalHP = result.reduce((sum, m) => sum + m.hp * m.count, 0);
      assert.ok(totalHP >= 60 && totalHP <= 100, `Total HP ${totalHP} should be near 80`);
    });

    it('selects harder monsters for higher budgets', () => {
      const monsters = require('../monsters/monsters-5e-srd.json');
      const easy = ed.selectMonsters(30, 8, monsters);
      const hard = ed.selectMonsters(200, 30, monsters);
      const easyCR = Math.max(...easy.map(m => m.cr || 0));
      const hardCR = Math.max(...hard.map(m => m.cr || 0));
      assert.ok(hardCR >= easyCR, `Hard CR ${hardCR} should be >= easy CR ${easyCR}`);
    });
  });

  describe('designCombatEncounter', () => {
    it('returns complete encounter with monsters and estimates', () => {
      const party = [makeFighter(), makeCleric(), makeRogue(), makeWizard()];
      const monsters = require('../monsters/monsters-5e-srd.json');
      const enc = ed.designCombatEncounter(party, 3, 'mid', monsters);
      assert.ok(enc.monsters.length > 0);
      assert.ok(enc.totalHP > 0);
      assert.ok(enc.estimatedRounds >= 2 && enc.estimatedRounds <= 8);
      assert.ok(enc.estimatedDPR > 0);
      assert.ok(['easy', 'medium', 'hard', 'deadly'].includes(enc.difficultyRating));
    });
  });

  describe('designSocialEncounter', () => {
    it('returns DC and challenge structure scaled by ferocity', () => {
      const deadly = ed.designSocialEncounter(1, 'mid');
      const easy = ed.designSocialEncounter(5, 'mid');
      assert.ok(deadly.dc > easy.dc, `Deadly DC ${deadly.dc} > Easy DC ${easy.dc}`);
      assert.ok(deadly.successesNeeded >= easy.successesNeeded);
    });
  });

  describe('designExplorationEncounter', () => {
    it('returns DC and trap damage scaled by ferocity', () => {
      const deadly = ed.designExplorationEncounter(1, 'mid');
      const easy = ed.designExplorationEncounter(5, 'mid');
      assert.ok(deadly.dc > easy.dc);
      assert.ok(deadly.trapDamage > easy.trapDamage);
    });
  });

  describe('designAdventuringDay', () => {
    it('produces correct encounter count for ferocity', () => {
      const party = [makeFighter(), makeCleric(), makeRogue(), makeWizard()];
      const monsters = require('../monsters/monsters-5e-srd.json');
      const plan = ed.designAdventuringDay(party, 3, { exploration: 33, combat: 33, social: 34 }, monsters);
      assert.ok(plan.encounters.length >= 4 && plan.encounters.length <= 8);
      assert.ok(plan.summary.shortRests >= 1);
      assert.ok(plan.summary.longRests >= 1);
    });

    it('respects pillar distribution', () => {
      const party = [makeFighter(), makeCleric(), makeRogue(), makeWizard()];
      const monsters = require('../monsters/monsters-5e-srd.json');
      const plan = ed.designAdventuringDay(party, 3, { exploration: 50, combat: 25, social: 25 }, monsters);
      const combatCount = plan.encounters.filter(e => e.pillar === 'combat').length;
      const explorationCount = plan.encounters.filter(e => e.pillar === 'exploration').length;
      assert.ok(explorationCount >= combatCount, `Exploration ${explorationCount} should be >= combat ${combatCount}`);
    });

    it('includes rest points', () => {
      const party = [makeFighter(), makeCleric(), makeRogue(), makeWizard()];
      const monsters = require('../monsters/monsters-5e-srd.json');
      const plan = ed.designAdventuringDay(party, 1, { exploration: 33, combat: 33, social: 34 }, monsters);
      const rests = plan.encounters.filter(e => e.rest);
      assert.ok(rests.length >= 2, `Deadly should have at least 2 rests, got ${rests.length}`);
    });
  });

  describe('updateRollingDPR', () => {
    it('calculates weighted average from combat history', () => {
      const history = {
        combats: [
          { rounds: 4, damageDealt: 40 }, // DPR: 10
          { rounds: 3, damageDealt: 30 }, // DPR: 10
          { rounds: 5, damageDealt: 75 }, // DPR: 15
        ],
      };
      const avg = ed.updateRollingDPR(history);
      // Weighted: 15×0.35 + 10×0.25 + 10×0.20 = 5.25+2.5+2.0 = 9.75
      // (only 3 entries, renormalize weights)
      assert.ok(avg > 9 && avg < 14, `Rolling DPR ${avg}`);
    });
  });

  describe('applyDifficultyCorrection', () => {
    it('increases correction when combats are too short', () => {
      let correction = 1.0;
      // Combat ended in 2 rounds, predicted 4
      correction = ed.applyDifficultyCorrection(correction, { predictedRounds: 4, actualRounds: 2 });
      assert.ok(correction > 1.0, `Correction should increase: ${correction}`);
    });

    it('decreases correction when combats are too long', () => {
      let correction = 1.0;
      correction = ed.applyDifficultyCorrection(correction, { predictedRounds: 3, actualRounds: 7 });
      assert.ok(correction < 1.0, `Correction should decrease: ${correction}`);
    });

    it('clamps between 0.5 and 2.0', () => {
      let correction = 1.9;
      correction = ed.applyDifficultyCorrection(correction, { predictedRounds: 4, actualRounds: 1 });
      assert.ok(correction <= 2.0, `Should cap at 2.0: ${correction}`);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/aron/Downloads/dnd-server && npm test`
Expected: FAIL — `Cannot find module '../encounter-designer'`

- [ ] **Step 3: Implement encounter-designer.js**

Create `encounter-designer.js` with all the pure functions:

```js
'use strict';

const { roll } = require('./resolvers/dice');

// ── Dice Math ─────────────────────────────────────────────────────────────────

// Average result of a dice notation string: "2d6+3" → 10, "1d8" → 4.5
function avgDice(notation) {
  const parts = notation.match(/(\d+d\d+|[+-]?\d+)/gi);
  if (!parts) return 0;
  let total = 0;
  for (const part of parts) {
    const diceMatch = part.match(/^([+-]?)(\d+)d(\d+)$/i);
    if (diceMatch) {
      const sign = diceMatch[1] === '-' ? -1 : 1;
      const count = parseInt(diceMatch[2], 10);
      const sides = parseInt(diceMatch[3], 10);
      total += sign * count * (sides + 1) / 2;
    } else {
      total += parseInt(part, 10);
    }
  }
  return total;
}

// ── DPR Estimation ────────────────────────────────────────────────────────────

const DEFAULT_TARGET_AC = 13; // Typical AC for level-appropriate monsters
const EXPECTED_COMBAT_ROUNDS = 4;

function getAbilityMod(score) { return Math.floor((score - 10) / 2); }

function hitProbability(attackMod, targetAC) {
  return Math.max(0.05, Math.min(0.95, (21 - (targetAC - attackMod)) / 20));
}

function estimateCharacterDPR(combatStats, targetAC) {
  targetAC = targetAC || DEFAULT_TARGET_AC;
  const prof = combatStats.proficiencyBonus || 2;

  // Weapon DPR
  let bestWeaponDPR = 0;
  for (const weapon of (combatStats.weapons || [])) {
    const abilityMod = getAbilityMod(combatStats.abilities?.[weapon.attackMod] || 10);
    const attackMod = abilityMod + prof;
    const avgDmg = avgDice(weapon.damage) + abilityMod;
    const hitProb = hitProbability(attackMod, targetAC);
    const critBonus = 0.05 * avgDice(weapon.damage); // 5% chance to crit, doubles dice
    let weaponDPR = (avgDmg * hitProb + critBonus);

    // Extra Attack (Fighter 5+, Paladin 5+, Ranger 5+, Monk 5+)
    const features = (combatStats.features || []).join(' ').toLowerCase();
    if (features.includes('extra attack')) {
      weaponDPR *= 2;
      if (combatStats.level >= 11 && features.includes('fighter')) weaponDPR *= 1.5; // 3 attacks
    }

    // Sneak Attack (Rogue)
    const sneakMatch = features.match(/sneak attack (\d+)d(\d+)/i);
    if (sneakMatch) {
      const sneakAvg = parseInt(sneakMatch[1]) * (parseInt(sneakMatch[2]) + 1) / 2;
      weaponDPR += sneakAvg * hitProb; // Sneak attack once per turn
    }

    bestWeaponDPR = Math.max(bestWeaponDPR, weaponDPR);
  }

  // Cantrip DPR
  let cantripDPR = 0;
  for (const spell of (combatStats.spells || [])) {
    if (spell.level === 0 && spell.damage) {
      const spellMod = getAbilityMod(combatStats.abilities?.[combatStats.spellcastingAbility] || 10);
      const spellAttackMod = spellMod + prof;
      const dmg = avgDice(spell.damage);
      if (spell.attack) {
        cantripDPR = Math.max(cantripDPR, dmg * hitProbability(spellAttackMod, targetAC));
      } else if (spell.save) {
        cantripDPR = Math.max(cantripDPR, dmg * 0.6); // ~60% fail saves
      }
    }
  }

  // Leveled spell burst (amortized over expected combat rounds)
  let bestSpellBurst = 0;
  let totalSlots = 0;
  for (const spell of (combatStats.spells || [])) {
    if (spell.level > 0 && spell.damage) {
      const dmg = avgDice(spell.damage);
      bestSpellBurst = Math.max(bestSpellBurst, dmg * 0.6); // Assume ~60% effectiveness
    }
  }
  for (const [level, count] of Object.entries(combatStats.spellSlots || {})) {
    totalSlots += (count || 0);
  }
  const amortizedSpellDPR = totalSlots > 0 ? (bestSpellBurst * Math.min(totalSlots, EXPECTED_COMBAT_ROUNDS)) / EXPECTED_COMBAT_ROUNDS : 0;

  // Effective DPR: best at-will option + amortized spell contribution
  const atWillDPR = Math.max(bestWeaponDPR, cantripDPR);
  const effectiveDPR = atWillDPR + amortizedSpellDPR * 0.5; // Only 50% of turns use leveled spells

  return {
    weaponDPR: Math.round(bestWeaponDPR * 10) / 10,
    cantripDPR: Math.round(cantripDPR * 10) / 10,
    spellBurstDPR: Math.round(bestSpellBurst * 10) / 10,
    amortizedSpellDPR: Math.round(amortizedSpellDPR * 10) / 10,
    effectiveDPR: Math.round(effectiveDPR * 10) / 10,
  };
}

function calculatePartyDPR(partyStats, targetAC) {
  const characters = partyStats.map(cs => ({
    stats: cs,
    dpr: estimateCharacterDPR(cs, targetAC),
  }));
  const totalDPR = characters.reduce((sum, c) => sum + c.dpr.effectiveDPR, 0);
  return { totalDPR: Math.round(totalDPR * 10) / 10, characters };
}

// ── Ferocity Tables ───────────────────────────────────────────────────────────

const FEROCITY = {
  1: { label: 'Deadly',    targetRounds: 4.5, hpMult: 1.5, dprMult: 1.8, deathFreq: 4,  encountersPerDay: [6, 8], shortRests: 2 },
  2: { label: 'Dangerous', targetRounds: 4,   hpMult: 1.3, dprMult: 1.4, deathFreq: 7,  encountersPerDay: [5, 7], shortRests: 2 },
  3: { label: 'Balanced',  targetRounds: 3.5, hpMult: 1.0, dprMult: 1.0, deathFreq: 10, encountersPerDay: [4, 6], shortRests: 1.5 },
  4: { label: 'Light',     targetRounds: 2.5, hpMult: 0.7, dprMult: 0.7, deathFreq: 14, encountersPerDay: [3, 5], shortRests: 1 },
  5: { label: 'Easy',      targetRounds: 2,   hpMult: 0.5, dprMult: 0.5, deathFreq: 18, encountersPerDay: [2, 4], shortRests: 1 },
};

const POSITION_MULT = { early: 0.6, mid: 1.0, late: 1.3, boss: 1.8 };

// ── Monster HP & DPR Budgets ──────────────────────────────────────────────────

function calculateMonsterHPBudget(partyDPR, ferocity, position, correction) {
  const f = FEROCITY[ferocity] || FEROCITY[3];
  const posMult = POSITION_MULT[position] || 1.0;
  const corr = correction || 1.0;
  return Math.round(partyDPR * f.targetRounds * f.hpMult * posMult * corr);
}

function calculateMonsterDPRBudget(partyTotalHP, ferocity, position) {
  const f = FEROCITY[ferocity] || FEROCITY[3];
  const posMult = POSITION_MULT[position] || 1.0;
  // monsterDPR should drain ~(1/deathFreq) of party HP per combat
  // Over targetRounds, total damage = monsterDPR × targetRounds
  // We want: monsterDPR × targetRounds = partyTotalHP / deathFreq × posMult
  return Math.round((partyTotalHP / f.deathFreq) * posMult / f.targetRounds * f.dprMult);
}

// ── Monster Selection ─────────────────────────────────────────────────────────

function estimateMonsterDPR(monster) {
  let best = 0;
  for (const weapon of (monster.weapons || [])) {
    const abilityMod = getAbilityMod(monster.abilities?.[weapon.attackMod] || 10);
    const attackMod = abilityMod + (monster.proficiencyBonus || 2);
    const avgDmg = avgDice(weapon.damage) + abilityMod;
    const hitProb = hitProbability(attackMod, 15); // vs typical party AC
    best = Math.max(best, avgDmg * hitProb);
  }
  // Multiattack doubles effective DPR
  if ((monster.features || []).some(f => /multiattack/i.test(f))) best *= 2;
  return Math.round(best * 10) / 10;
}

function selectMonsters(hpBudget, dprBudget, monsterDB, options) {
  const { previousMonsters, minCR, maxCR } = options || {};
  const candidates = Object.entries(monsterDB)
    .map(([slug, m]) => ({ slug, ...m, estimatedDPR: estimateMonsterDPR(m) }))
    .filter(m => m.hp > 0 && m.weapons?.length > 0)
    .filter(m => !minCR || (m.cr || 0) >= minCR)
    .filter(m => !maxCR || (m.cr || 0) <= maxCR)
    .sort((a, b) => (b.cr || 0) - (a.cr || 0));

  if (candidates.length === 0) return [];

  const results = [];
  let remainingHP = hpBudget;
  let remainingDPR = dprBudget;

  // Try to pick one "anchor" monster (strongest that fits)
  const anchor = candidates.find(m => m.hp <= remainingHP * 0.7 && m.hp >= remainingHP * 0.2);
  if (anchor) {
    const count = Math.max(1, Math.min(3, Math.floor(remainingHP / anchor.hp)));
    results.push({ slug: anchor.slug, name: anchor.name, count, hp: anchor.hp, cr: anchor.cr || 0, estimatedDPR: anchor.estimatedDPR });
    remainingHP -= anchor.hp * count;
    remainingDPR -= anchor.estimatedDPR * count;
  }

  // Fill remaining budget with weaker monsters
  if (remainingHP > 5) {
    const fillers = candidates.filter(m => m.hp <= remainingHP && m.slug !== (anchor?.slug));
    if (fillers.length > 0) {
      const filler = fillers[Math.floor(Math.random() * Math.min(5, fillers.length))];
      const count = Math.max(1, Math.floor(remainingHP / filler.hp));
      results.push({ slug: filler.slug, name: filler.name, count, hp: filler.hp, cr: filler.cr || 0, estimatedDPR: filler.estimatedDPR });
    }
  }

  return results;
}

// ── Encounter Design ──────────────────────────────────────────────────────────

function designCombatEncounter(partyStats, ferocity, position, monsterDB, options) {
  const { correction, combatHistory } = options || {};
  const partyDPR = calculatePartyDPR(partyStats).totalDPR;
  const partyHP = partyStats.reduce((sum, cs) => sum + (cs.hp || cs.maxHp || 30), 0);
  const hpBudget = calculateMonsterHPBudget(partyDPR, ferocity, position, correction);
  const dprBudget = calculateMonsterDPRBudget(partyHP, ferocity, position);
  const monsters = selectMonsters(hpBudget, dprBudget, monsterDB);
  const totalHP = monsters.reduce((sum, m) => sum + m.hp * m.count, 0);
  const totalDPR = monsters.reduce((sum, m) => sum + m.estimatedDPR * m.count, 0);
  const estimatedRounds = partyDPR > 0 ? Math.round(totalHP / partyDPR) : 4;

  let difficultyRating = 'medium';
  const f = FEROCITY[ferocity] || FEROCITY[3];
  const posMult = POSITION_MULT[position] || 1.0;
  if (posMult >= 1.5) difficultyRating = 'deadly';
  else if (posMult >= 1.1) difficultyRating = 'hard';
  else if (posMult <= 0.7) difficultyRating = 'easy';

  return {
    pillar: 'combat', type: 'combat', position,
    monsters, totalHP, estimatedDPR: totalDPR,
    estimatedRounds: Math.max(1, Math.min(10, estimatedRounds)),
    difficultyRating, hpBudget, dprBudget,
  };
}

// ── Social & Exploration Encounters ───────────────────────────────────────────

const SOCIAL_DC = { 1: 19, 2: 17, 3: 14, 4: 12, 5: 9 };
const SOCIAL_SUCCESSES = { 1: [4, 2], 2: [4, 3], 3: [3, 3], 4: [3, 4], 5: [2, 3] }; // [needed, maxFails]
const EXPLORATION_DC = { 1: 19, 2: 17, 3: 14, 4: 12, 5: 9 };
const TRAP_DAMAGE = { 1: '4d10', 2: '3d10', 3: '2d10', 4: '1d10', 5: '1d6' };
const DETECTION_DC = { 1: 18, 2: 16, 3: 14, 4: 12, 5: 10 };

function designSocialEncounter(ferocity, position) {
  const baseDC = SOCIAL_DC[ferocity] || 14;
  const posMod = position === 'boss' ? 2 : position === 'late' ? 1 : position === 'early' ? -1 : 0;
  const [successes, maxFails] = SOCIAL_SUCCESSES[ferocity] || [3, 3];
  return {
    pillar: 'social', type: 'social_challenge', position,
    dc: baseDC + posMod,
    successesNeeded: successes, maxFailures: maxFails,
    difficultyRating: ferocity <= 2 ? 'hard' : ferocity <= 4 ? 'medium' : 'easy',
  };
}

function designExplorationEncounter(ferocity, position) {
  const baseDC = EXPLORATION_DC[ferocity] || 14;
  const posMod = position === 'boss' ? 2 : position === 'late' ? 1 : position === 'early' ? -1 : 0;
  const trapDmg = TRAP_DAMAGE[ferocity] || '2d10';
  const detectDC = DETECTION_DC[ferocity] || 14;
  return {
    pillar: 'exploration', type: 'exploration_challenge', position,
    dc: baseDC + posMod, trapDamage: avgDice(trapDmg), trapDice: trapDmg,
    detectionDC: detectDC + posMod,
    difficultyRating: ferocity <= 2 ? 'hard' : ferocity <= 4 ? 'medium' : 'easy',
  };
}

// ── Adventuring Day Planner ───────────────────────────────────────────────────

function designAdventuringDay(partyStats, ferocity, pillars, monsterDB, options) {
  const f = FEROCITY[ferocity] || FEROCITY[3];
  const { hostOverrides, correction } = options || {};

  // Determine encounter count
  const [minEnc, maxEnc] = f.encountersPerDay;
  const encounterCount = hostOverrides?.encounterCount || Math.round((minEnc + maxEnc) / 2);

  // Distribute pillars
  const combatPct = (pillars?.combat || 33) / 100;
  const socialPct = (pillars?.social || 34) / 100;
  const explorePct = (pillars?.exploration || 33) / 100;

  let combatCount = Math.max(1, Math.round(encounterCount * combatPct));
  let socialCount = Math.max(0, Math.round(encounterCount * socialPct));
  let exploreCount = Math.max(0, Math.round(encounterCount * explorePct));

  // Adjust to hit exact count
  while (combatCount + socialCount + exploreCount > encounterCount) {
    if (socialCount > 0 && socialCount >= exploreCount) socialCount--;
    else if (exploreCount > 0) exploreCount--;
    else combatCount--;
  }
  while (combatCount + socialCount + exploreCount < encounterCount) combatCount++;

  // Build encounter sequence with positions
  const encounters = [];
  const sequence = [];

  // Interleave pillar types
  for (let i = 0; i < combatCount; i++) sequence.push('combat');
  for (let i = 0; i < socialCount; i++) sequence.push('social');
  for (let i = 0; i < exploreCount; i++) sequence.push('exploration');

  // Sort to interleave: don't cluster same type. Simple: alternate combat with non-combat
  const combats = sequence.filter(s => s === 'combat');
  const nonCombats = sequence.filter(s => s !== 'combat');
  const interleaved = [];
  let ci = 0, nci = 0;
  for (let i = 0; i < sequence.length; i++) {
    if (i % 2 === 0 && nci < nonCombats.length && i > 0) {
      interleaved.push(nonCombats[nci++]);
    } else if (ci < combats.length) {
      interleaved.push(combats[ci++]);
    } else if (nci < nonCombats.length) {
      interleaved.push(nonCombats[nci++]);
    }
  }
  // Drain remaining
  while (ci < combats.length) interleaved.push(combats[ci++]);
  while (nci < nonCombats.length) interleaved.push(nonCombats[nci++]);

  // Assign positions based on index
  const total = interleaved.length;
  let encountersSinceRest = 0;
  const restThreshold = Math.max(2, Math.ceil(total / (f.shortRests + 1)));

  for (let i = 0; i < total; i++) {
    const pct = i / (total - 1 || 1);
    const position = i === total - 1 ? 'boss' : pct < 0.3 ? 'early' : pct < 0.7 ? 'mid' : 'late';
    const pillar = interleaved[i];

    if (pillar === 'combat') {
      encounters.push(designCombatEncounter(partyStats, ferocity, position, monsterDB, { correction }));
    } else if (pillar === 'social') {
      encounters.push(designSocialEncounter(ferocity, position));
    } else {
      encounters.push(designExplorationEncounter(ferocity, position));
    }

    encountersSinceRest++;
    // Insert short rest
    if (encountersSinceRest >= restThreshold && i < total - 1) {
      encounters.push({ rest: 'short', reason: `After ${encountersSinceRest} encounters` });
      encountersSinceRest = 0;
    }
  }

  // Long rest at end
  encounters.push({ rest: 'long', reason: 'End of adventuring day' });

  // Summary
  const combatEncs = encounters.filter(e => e.pillar === 'combat');
  const socialEncs = encounters.filter(e => e.pillar === 'social');
  const exploreEncs = encounters.filter(e => e.pillar === 'exploration');
  const shortRests = encounters.filter(e => e.rest === 'short').length;
  const totalMonsterHP = combatEncs.reduce((sum, e) => sum + (e.totalHP || 0), 0);
  const totalRounds = combatEncs.reduce((sum, e) => sum + (e.estimatedRounds || 0), 0);
  const partyHP = partyStats.reduce((sum, cs) => sum + (cs.maxHp || cs.hp || 30), 0);
  const estimatedDrain = combatEncs.reduce((sum, e) => sum + (e.estimatedDPR || 0) * (e.estimatedRounds || 0), 0);

  return {
    encounters,
    summary: {
      totalEncounters: combatEncs.length + socialEncs.length + exploreEncs.length,
      combatEncounters: combatEncs.length,
      socialEncounters: socialEncs.length,
      explorationEncounters: exploreEncs.length,
      shortRests,
      longRests: 1,
      totalMonsterHP,
      estimatedTotalRounds: totalRounds,
      estimatedPartyHPDrain: partyHP > 0 ? Math.round((estimatedDrain / partyHP) * 100) + '%' : '0%',
      pillarDistribution: {
        combat: Math.round((combatEncs.length / (combatEncs.length + socialEncs.length + exploreEncs.length || 1)) * 100),
        social: Math.round((socialEncs.length / (combatEncs.length + socialEncs.length + exploreEncs.length || 1)) * 100),
        exploration: Math.round((exploreEncs.length / (combatEncs.length + socialEncs.length + exploreEncs.length || 1)) * 100),
      },
      pillarTarget: { exploration: pillars?.exploration || 33, combat: pillars?.combat || 33, social: pillars?.social || 34 },
    },
  };
}

// ── Rolling DPR Tracker ───────────────────────────────────────────────────────

const DPR_WEIGHTS = [0.35, 0.25, 0.20, 0.12, 0.08];

function updateRollingDPR(history) {
  const combats = (history?.combats || []).slice(-5); // Last 5
  if (combats.length === 0) return 0;
  const dprs = combats.map(c => c.rounds > 0 ? c.damageDealt / c.rounds : 0).reverse(); // Most recent first
  let totalWeight = 0;
  let weightedSum = 0;
  for (let i = 0; i < dprs.length; i++) {
    const w = DPR_WEIGHTS[i] || 0.05;
    weightedSum += dprs[i] * w;
    totalWeight += w;
  }
  return Math.round((weightedSum / totalWeight) * 10) / 10;
}

// ── Difficulty Self-Correction ────────────────────────────────────────────────

function applyDifficultyCorrection(currentCorrection, outcome) {
  const { predictedRounds, actualRounds } = outcome;
  const ratio = actualRounds / (predictedRounds || 1);
  // If combat was shorter than predicted (party stronger): increase correction
  // If combat was longer (party weaker): decrease correction
  let delta = 0;
  if (ratio < 0.6) delta = 0.15;       // Way too easy for party
  else if (ratio < 0.8) delta = 0.1;    // Somewhat too easy
  else if (ratio > 1.5) delta = -0.15;  // Way too hard
  else if (ratio > 1.2) delta = -0.1;   // Somewhat too hard
  // else: within range, no adjustment

  return Math.max(0.5, Math.min(2.0, currentCorrection + delta));
}

// ── Prompt Formatting ─────────────────────────────────────────────────────────

function formatPlanForPrompt(plan, currentIndex) {
  const total = plan.summary.totalEncounters;
  const current = Math.min(currentIndex + 1, total);
  const nextEnc = plan.encounters.find((e, i) => i >= currentIndex && !e.rest);
  if (!nextEnc) return '';

  let line = `ENCOUNTER PLAN: Encounter ${current} of ${total}.`;
  if (nextEnc.pillar === 'combat' && nextEnc.monsters) {
    const monsterStr = nextEnc.monsters.map(m => `${m.count}x ${m.name}`).join(', ');
    line += ` Next: COMBAT (${nextEnc.difficultyRating}). Monsters: ${monsterStr} (~${nextEnc.totalHP} HP, est. ${nextEnc.estimatedRounds} rounds).`;
  } else if (nextEnc.pillar === 'social') {
    line += ` Next: SOCIAL challenge (DC ${nextEnc.dc}, ${nextEnc.successesNeeded} successes before ${nextEnc.maxFailures} failures).`;
  } else if (nextEnc.pillar === 'exploration') {
    line += ` Next: EXPLORATION challenge (DC ${nextEnc.dc}, trap: ${nextEnc.trapDice}).`;
  }

  // Check if rest follows
  const nextIdx = plan.encounters.indexOf(nextEnc);
  if (nextIdx + 1 < plan.encounters.length && plan.encounters[nextIdx + 1]?.rest) {
    line += ` After this, offer a ${plan.encounters[nextIdx + 1].rest} rest.`;
  }

  const pDist = plan.summary.pillarDistribution;
  line += ` Pillar progress: C${pDist.combat}%/S${pDist.social}%/E${pDist.exploration}%.`;

  return line;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  avgDice,
  estimateCharacterDPR,
  calculatePartyDPR,
  calculateMonsterHPBudget,
  calculateMonsterDPRBudget,
  estimateMonsterDPR,
  selectMonsters,
  designCombatEncounter,
  designSocialEncounter,
  designExplorationEncounter,
  designAdventuringDay,
  updateRollingDPR,
  applyDifficultyCorrection,
  formatPlanForPrompt,
  FEROCITY,
  POSITION_MULT,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/aron/Downloads/dnd-server && npm test`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/aron/Downloads/dnd-server
git add encounter-designer.js tests/encounter-designer.test.js
git commit -m "feat: add encounter difficulty module — DPR calc, monster budgets, day planning"
```

---

## Task 2: CLI Test Harness

**Files:**
- Create: `test-encounter-designer.js`

- [ ] **Step 1: Create the CLI test harness**

Create `test-encounter-designer.js` — a standalone script that runs encounter design scenarios and prints formatted output. Uses the same party fixtures as the unit tests plus loads real monster data.

The script should:
1. Accept a scenario name as CLI arg (standard-party, low-level, high-level, solo, random)
2. Build the appropriate party
3. Calculate party DPR analysis
4. Design a full adventuring day
5. Print formatted results

Key code:
- Party creation for each scenario (level 1, 5, 10 variants)
- Calls `calculatePartyDPR()` and `designAdventuringDay()`
- Prints DPR breakdown per character, day plan with encounter details, summary stats

- [ ] **Step 2: Run and verify output**

Run: `cd /Users/aron/Downloads/dnd-server && node test-encounter-designer.js standard-party`
Expected: Formatted output showing party DPR and adventuring day plan

- [ ] **Step 3: Commit**

```bash
git add test-encounter-designer.js
git commit -m "feat: add CLI test harness for encounter designer scenarios"
```

---

## Task 3: Combat Engine — Post-Combat Summary

**Files:**
- Modify: `combat-engine.js`
- Modify: `tests/combat-engine.test.js`

- [ ] **Step 1: Add getCombatSummary() test**

In `tests/combat-engine.test.js`, add test for `getCombatSummary()`:

```js
describe('getCombatSummary', () => {
  it('returns per-character damage dealt and taken', () => {
    const engine = new CombatEngine();
    // ... init combat, resolve some attacks, then:
    const summary = engine.getCombatSummary();
    assert.ok(summary.rounds > 0);
    assert.ok(Object.keys(summary.characters).length > 0);
    // Each character entry has: damageDealt, damageTaken, healed, spellSlotsUsed
  });
});
```

- [ ] **Step 2: Implement getCombatSummary()**

Add to `CombatEngine` class in `combat-engine.js`:

```js
getCombatSummary() {
  const characters = {};
  for (const [id, c] of Object.entries(this.state.combatants)) {
    characters[id] = { name: c.name, type: c.type, damageDealt: 0, damageTaken: 0, healed: 0, spellSlotsUsed: 0 };
  }

  for (const entry of this.state.log) {
    if (entry.type === 'attack' && entry.hit && entry.totalDamage > 0) {
      if (characters[entry.attacker]) characters[entry.attacker].damageDealt += entry.totalDamage;
      if (characters[entry.target] && entry.damageResult) {
        characters[entry.target].damageTaken += entry.damageResult.effectiveDamage || entry.totalDamage;
      }
    }
    if (entry.type === 'spell_save' && entry.targets) {
      for (const t of entry.targets) {
        if (t.damage > 0 && characters[entry.caster]) characters[entry.caster].damageDealt += t.damage;
        if (characters[t.id]) characters[t.id].damageTaken += t.damage;
      }
    }
    if (entry.type === 'spell_attack' && entry.hit && entry.totalDamage > 0) {
      if (characters[entry.caster]) characters[entry.caster].damageDealt += entry.totalDamage;
      if (characters[entry.target]) characters[entry.target].damageTaken += entry.totalDamage;
    }
    if (entry.type === 'heal' && entry.healing > 0) {
      if (characters[entry.caster]) characters[entry.caster].healed += entry.healing;
    }
    if (entry.slotUsed && characters[entry.caster]) {
      characters[entry.caster].spellSlotsUsed++;
    }
  }

  return { rounds: this.state.round, characters };
}
```

- [ ] **Step 3: Run tests, commit**

```bash
npm test
git add combat-engine.js tests/combat-engine.test.js
git commit -m "feat: add getCombatSummary() for post-combat DPR tracking"
```

---

## Task 4: Server Integration — DPR Collection & Plan Generation

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add post-combat DPR collection**

In server.js, find where `combatEngine.endCombat()` is called (in the callClaude combat routing). After combat ends, collect DPR data:

```js
// After: gs.combatEngine.endCombat();
const combatSummary = gs.combatEngine.getCombatSummary();
if (!gs.combatHistory) gs.combatHistory = {};
for (const [id, data] of Object.entries(combatSummary.characters)) {
  if (data.type !== 'PC') continue;
  if (!gs.combatHistory[id]) gs.combatHistory[id] = { combats: [] };
  gs.combatHistory[id].combats.push({
    date: Date.now(), rounds: combatSummary.rounds,
    damageDealt: data.damageDealt, damageTaken: data.damageTaken,
    healed: data.healed, spellSlotsUsed: data.spellSlotsUsed,
  });
  if (gs.combatHistory[id].combats.length > 5) gs.combatHistory[id].combats.shift();
  gs.combatHistory[id].rollingDPR = ed.updateRollingDPR(gs.combatHistory[id]);
}
db.setState(gameId, 'combatHistory', gs.combatHistory).catch(() => {});

// Difficulty correction
if (gs.encounterPlan) {
  const currentEnc = gs.encounterPlan.encounters.find(e => e.pillar === 'combat' && !e.completed);
  if (currentEnc) {
    gs.difficultyCorrection = ed.applyDifficultyCorrection(
      gs.difficultyCorrection || 1.0,
      { predictedRounds: currentEnc.estimatedRounds, actualRounds: combatSummary.rounds }
    );
    currentEnc.completed = true;
    gs.encounterPlanIndex = (gs.encounterPlanIndex || 0) + 1;
  }
}
```

- [ ] **Step 2: Add encounter plan generation on game start**

In the `dm_start` handler, after generating the opening scene, create the first day plan:

```js
const ed = require('./encounter-designer');
const monsterDB = require('./monster-lookup').loadDefaultMonsters(gameConfig.system || 'dnd5e');

// Generate encounter plan
const partyStats = Object.values(gs.data.characters).map(c => c.combatStats).filter(Boolean);
if (partyStats.length > 0) {
  gs.encounterPlan = ed.designAdventuringDay(partyStats, gs.ferocity, gs.pillars, monsterDB, {
    correction: gs.difficultyCorrection || 1.0,
  });
  gs.encounterPlanIndex = 0;
  io.to(gameId).emit('encounter_plan_updated', gs.encounterPlan);
}
```

- [ ] **Step 3: Add plan injection into system prompt**

In `buildTrimmedPrompt()`, add after the pillar line:

```js
const encounterPlanLine = gs.encounterPlan ? ed.formatPlanForPrompt(gs.encounterPlan, gs.encounterPlanIndex || 0) : '';
```

Include `encounterPlanLine` in the returned prompt string.

- [ ] **Step 4: Add host tab socket events**

```js
socket.on('adjust_difficulty', (data) => {
  const gs = getGameState(socket.gameId);
  if (!gs.encounterPlan) return;
  const modifier = data.harder ? 1.2 : 0.8;
  // Adjust remaining encounters
  for (const enc of gs.encounterPlan.encounters) {
    if (enc.completed || enc.rest) continue;
    if (enc.totalHP) enc.totalHP = Math.round(enc.totalHP * modifier);
    if (enc.estimatedRounds) enc.estimatedRounds = Math.max(1, Math.round(enc.estimatedRounds * modifier));
  }
  io.to(socket.gameId).emit('encounter_plan_updated', gs.encounterPlan);
});

socket.on('regenerate_plan', async (data) => {
  const gameId = socket.gameId;
  if (!gameId) return;
  const gs = getGameState(gameId);
  const gameConfig = await db.getGame(gameId);
  const monsterDB = require('./monster-lookup').loadDefaultMonsters(gameConfig.system || 'dnd5e');
  const partyStats = Object.values(gs.data.characters).map(c => c.combatStats).filter(Boolean);
  if (partyStats.length > 0) {
    gs.encounterPlan = ed.designAdventuringDay(partyStats, gs.ferocity, gs.pillars, monsterDB, {
      correction: gs.difficultyCorrection || 1.0,
      hostOverrides: data,
    });
    gs.encounterPlanIndex = 0;
    io.to(gameId).emit('encounter_plan_updated', gs.encounterPlan);
  }
});

socket.on('force_boss', () => {
  const gs = getGameState(socket.gameId);
  if (!gs.encounterPlan) return;
  // Mark all remaining non-rest encounters as completed, add boss
  for (const enc of gs.encounterPlan.encounters) {
    if (!enc.rest && !enc.completed) enc.completed = true;
  }
  gs.encounterPlanIndex = gs.encounterPlan.encounters.length - 2; // Point to boss
  io.to(socket.gameId).emit('encounter_plan_updated', gs.encounterPlan);
});

socket.on('insert_rest', () => {
  const gs = getGameState(socket.gameId);
  if (!gs.encounterPlan) return;
  const idx = gs.encounterPlanIndex || 0;
  gs.encounterPlan.encounters.splice(idx, 0, { rest: 'short', reason: 'Host inserted rest' });
  io.to(socket.gameId).emit('encounter_plan_updated', gs.encounterPlan);
});
```

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: integrate encounter designer — DPR collection, plan generation, prompt injection, host events"
```

---

## Task 5: Host Tab UI — Encounter Planner Panel

**Files:**
- Modify: `public/game.html`

- [ ] **Step 1: Add encounter planner CSS and HTML**

In the Host tab section of game.html, after the existing Game Style panel, add a new Encounter Planner panel:

**HTML:** Timeline visualization with icons for combat (⚔️), social (💬), exploration (🗺️), and rest (☕). Current encounter highlighted. Difficulty adjustment buttons. Party DPR display. Regenerate button.

**JS:** Socket handlers for `encounter_plan_updated` and `encounter_progress`. Functions to render the timeline, update current position, handle adjust/regenerate/force-boss/insert-rest buttons.

- [ ] **Step 2: Commit**

```bash
git add public/game.html
git commit -m "feat: add encounter planner panel to host tab"
```

---

## Task 6: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add encounter designer documentation**

Add section covering: file purpose, DPR calculation approach, ferocity tables, how plans inject into prompts, test harness usage.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add encounter difficulty module to CLAUDE.md"
```

---

## Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | Core module — DPR calc, budgets, monster selection, day planning | `encounter-designer.js`, tests |
| 2 | CLI test harness | `test-encounter-designer.js` |
| 3 | Combat engine post-combat summary | `combat-engine.js` |
| 4 | Server integration — collection, generation, prompt injection, sockets | `server.js` |
| 5 | Host tab encounter planner UI | `public/game.html` |
| 6 | Documentation | `CLAUDE.md` |
