'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('../encounter-designer.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fighter 5: longsword, Extra Attack, STR 18 (+4) */
function makeFighter(overrides = {}) {
  return {
    id: 'fighter-1',
    name: 'Kael',
    class: 'fighter',
    level: 5,
    hp: 52,
    maxHp: 52,
    ac: 18,
    abilities: { str: 18, dex: 12, con: 16, int: 10, wis: 13, cha: 8 },
    proficiencyBonus: 3,
    weapons: [
      { name: 'longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing', properties: [] },
    ],
    spells: [],
    spellSlots: {},
    features: ['Extra Attack', 'Action Surge'],
    ...overrides,
  };
}

/** Cleric 5: mace, STR 14, WIS 16, Guiding Bolt + Spiritual Weapon */
function makeCleric(overrides = {}) {
  return {
    id: 'cleric-1',
    name: 'Mira',
    class: 'cleric',
    level: 5,
    hp: 40,
    maxHp: 40,
    ac: 16,
    abilities: { str: 14, dex: 10, con: 14, int: 12, wis: 16, cha: 13 },
    proficiencyBonus: 3,
    spellcastingAbility: 'wis',
    weapons: [
      { name: 'mace', attackMod: 'str', damage: '1d6', damageType: 'bludgeoning', properties: [] },
    ],
    spells: [
      { name: 'Guiding Bolt', level: 1, damage: '4d6', damageType: 'radiant', attackRoll: true },
      { name: 'Spiritual Weapon', level: 2, damage: '1d8', damageType: 'force' },
    ],
    spellSlots: { 1: 4, 2: 3, 3: 2 },
    features: [],
    ...overrides,
  };
}

/** Rogue 5: rapier, DEX 18, Sneak Attack 3d6 */
function makeRogue(overrides = {}) {
  return {
    id: 'rogue-1',
    name: 'Lyra',
    class: 'rogue',
    level: 5,
    hp: 36,
    maxHp: 36,
    ac: 15,
    abilities: { str: 10, dex: 18, con: 12, int: 14, wis: 13, cha: 12 },
    proficiencyBonus: 3,
    weapons: [
      { name: 'rapier', attackMod: 'dex', damage: '1d8', damageType: 'piercing', properties: ['finesse'] },
    ],
    spells: [],
    spellSlots: {},
    features: ['Sneak Attack 3d6', 'Cunning Action', 'Uncanny Dodge'],
    ...overrides,
  };
}

/** Wizard 5: fire bolt cantrip, Fireball */
function makeWizard(overrides = {}) {
  return {
    id: 'wizard-1',
    name: 'Zara',
    class: 'wizard',
    level: 5,
    hp: 30,
    maxHp: 30,
    ac: 12,
    abilities: { str: 8, dex: 14, con: 13, int: 18, wis: 12, cha: 10 },
    proficiencyBonus: 3,
    spellcastingAbility: 'int',
    weapons: [],
    cantrip: { name: 'Fire Bolt', damage: '2d10', damageType: 'fire' },
    spells: [
      { name: 'Magic Missile', level: 1, damage: '3d4+3', damageType: 'force' },
      { name: 'Fireball',      level: 3, damage: '8d6',   damageType: 'fire', save: 'dex' },
    ],
    spellSlots: { 1: 4, 2: 3, 3: 2 },
    features: [],
    ...overrides,
  };
}

/** Minimal monster DB for testing (subset) */
const MINI_DB = {
  goblin: {
    name: 'Goblin', cr: 0.25, ac: 15, hp: 7, maxHp: 7,
    abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
    proficiencyBonus: 2,
    weapons: [{ name: 'scimitar', attackMod: 'dex', damage: '1d6', damageType: 'slashing', properties: [] }],
    features: ['Nimble Escape'],
  },
  bugbear: {
    name: 'Bugbear', cr: 1, ac: 16, hp: 27, maxHp: 27,
    abilities: { str: 15, dex: 14, con: 13, int: 8, wis: 11, cha: 9 },
    proficiencyBonus: 2,
    weapons: [{ name: 'morningstar', attackMod: 'str', damage: '2d8', damageType: 'piercing', properties: [] }],
    features: ['Brute', 'Surprise Attack'],
  },
  ogre: {
    name: 'Ogre', cr: 2, ac: 11, hp: 59, maxHp: 59,
    abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
    proficiencyBonus: 2,
    weapons: [{ name: 'greatclub', attackMod: 'str', damage: '2d8+4', damageType: 'bludgeoning', properties: [] }],
    features: [],
  },
  troll: {
    name: 'Troll', cr: 5, ac: 15, hp: 84, maxHp: 84,
    abilities: { str: 18, dex: 13, con: 20, int: 7, wis: 9, cha: 7 },
    proficiencyBonus: 3,
    weapons: [
      { name: 'claw', attackMod: 'str', damage: '2d6+4', damageType: 'slashing', properties: [] },
      { name: 'bite', attackMod: 'str', damage: '1d6+4', damageType: 'piercing', properties: [] },
    ],
    features: ['Regeneration'],
  },
};

// ---------------------------------------------------------------------------
// avgDice
// ---------------------------------------------------------------------------

describe('avgDice()', () => {
  it('"1d6" → 3.5', () => assert.equal(avgDice('1d6'), 3.5));
  it('"2d6" → 7', () => assert.equal(avgDice('2d6'), 7));
  it('"2d6+3" → 10', () => assert.equal(avgDice('2d6+3'), 10));
  it('"1d8" → 4.5', () => assert.equal(avgDice('1d8'), 4.5));
  it('"1d8+1+1d4" → 8', () => assert.equal(avgDice('1d8+1+1d4'), 8));
  it('"4d10" → 22', () => assert.equal(avgDice('4d10'), 22));
  it('"3d10" → 16.5', () => assert.equal(avgDice('3d10'), 16.5));
  it('"8d6" → 28', () => assert.equal(avgDice('8d6'), 28));
  it('"1d20+5" → 15.5', () => assert.equal(avgDice('1d20+5'), 15.5));
  it('"d4" (no count) → 2.5', () => assert.equal(avgDice('d4'), 2.5));
  it('empty string → 0', () => assert.equal(avgDice(''), 0));
  it('non-string → 0', () => assert.equal(avgDice(null), 0));
});

// ---------------------------------------------------------------------------
// estimateCharacterDPR
// ---------------------------------------------------------------------------

describe('estimateCharacterDPR()', () => {
  it('fighter DPR is in reasonable range [8, 25]', () => {
    const result = estimateCharacterDPR(makeFighter());
    assert.ok(result.effectiveDPR >= 8,  `effectiveDPR too low: ${result.effectiveDPR}`);
    assert.ok(result.effectiveDPR <= 25, `effectiveDPR too high: ${result.effectiveDPR}`);
  });

  it('fighter has weaponDPR > 0', () => {
    const result = estimateCharacterDPR(makeFighter());
    assert.ok(result.weaponDPR > 0);
  });

  it('fighter uses Extra Attack (weaponDPR roughly double single-attack)', () => {
    const withExtra    = estimateCharacterDPR(makeFighter());
    const withoutExtra = estimateCharacterDPR(makeFighter({ features: [] }));
    // Extra Attack should roughly double weapon DPR
    assert.ok(withExtra.weaponDPR > withoutExtra.weaponDPR * 1.5,
      `Extra Attack not reflected: ${withExtra.weaponDPR} vs ${withoutExtra.weaponDPR}`);
  });

  it('cleric DPR is in reasonable range [4, 25]', () => {
    const result = estimateCharacterDPR(makeCleric());
    assert.ok(result.effectiveDPR >= 4,  `too low: ${result.effectiveDPR}`);
    assert.ok(result.effectiveDPR <= 25, `too high: ${result.effectiveDPR}`);
  });

  it('cleric has amortizedSpellDPR > 0 (has Guiding Bolt)', () => {
    const result = estimateCharacterDPR(makeCleric());
    assert.ok(result.amortizedSpellDPR > 0, `amortizedSpellDPR: ${result.amortizedSpellDPR}`);
  });

  it('rogue DPR includes sneak attack contribution', () => {
    const withSneak    = estimateCharacterDPR(makeRogue());
    const withoutSneak = estimateCharacterDPR(makeRogue({ features: [] }));
    assert.ok(withSneak.weaponDPR > withoutSneak.weaponDPR,
      `Sneak Attack not reflected: ${withSneak.weaponDPR} vs ${withoutSneak.weaponDPR}`);
  });

  it('rogue DPR is in reasonable range [8, 25]', () => {
    const result = estimateCharacterDPR(makeRogue());
    assert.ok(result.effectiveDPR >= 8,  `too low: ${result.effectiveDPR}`);
    assert.ok(result.effectiveDPR <= 25, `too high: ${result.effectiveDPR}`);
  });

  it('wizard has cantripDPR > 0 (Fire Bolt)', () => {
    const result = estimateCharacterDPR(makeWizard());
    assert.ok(result.cantripDPR > 0, `cantripDPR: ${result.cantripDPR}`);
  });

  it('wizard has spellBurstDPR > 0 (Fireball)', () => {
    const result = estimateCharacterDPR(makeWizard());
    assert.ok(result.spellBurstDPR > 0, `spellBurstDPR: ${result.spellBurstDPR}`);
  });

  it('wizard effectiveDPR is in reasonable range [8, 25]', () => {
    const result = estimateCharacterDPR(makeWizard());
    assert.ok(result.effectiveDPR >= 8,  `too low: ${result.effectiveDPR}`);
    assert.ok(result.effectiveDPR <= 25, `too high: ${result.effectiveDPR}`);
  });

  it('higher targetAC reduces weaponDPR', () => {
    const low  = estimateCharacterDPR(makeFighter(), 10);
    const high = estimateCharacterDPR(makeFighter(), 18);
    assert.ok(high.weaponDPR < low.weaponDPR,
      `Expected lower DPR vs AC 18 than AC 10. Got ${high.weaponDPR} vs ${low.weaponDPR}`);
  });

  it('returns numeric fields', () => {
    const r = estimateCharacterDPR(makeFighter());
    for (const key of ['weaponDPR','cantripDPR','spellBurstDPR','amortizedSpellDPR','effectiveDPR']) {
      assert.equal(typeof r[key], 'number', `${key} should be number`);
    }
  });
});

// ---------------------------------------------------------------------------
// calculatePartyDPR
// ---------------------------------------------------------------------------

describe('calculatePartyDPR()', () => {
  it('totalDPR equals sum of character effectiveDPRs', () => {
    const party = [makeFighter(), makeCleric(), makeRogue(), makeWizard()];
    const result = calculatePartyDPR(party, 13);
    const expected = result.characters.reduce((s, c) => s + c.effectiveDPR, 0);
    assert.ok(Math.abs(result.totalDPR - expected) < 0.1,
      `totalDPR ${result.totalDPR} ≠ sum ${expected}`);
  });

  it('returns one character entry per input', () => {
    const party = [makeFighter(), makeRogue()];
    const result = calculatePartyDPR(party);
    assert.equal(result.characters.length, 2);
  });

  it('totalDPR > 0 for a real party', () => {
    const result = calculatePartyDPR([makeFighter(), makeCleric()]);
    assert.ok(result.totalDPR > 0);
  });

  it('totalDPR for 4-person party is in range [30, 80]', () => {
    const result = calculatePartyDPR([makeFighter(), makeCleric(), makeRogue(), makeWizard()], 13);
    assert.ok(result.totalDPR >= 30, `too low: ${result.totalDPR}`);
    assert.ok(result.totalDPR <= 80, `too high: ${result.totalDPR}`);
  });
});

// ---------------------------------------------------------------------------
// calculateMonsterHPBudget
// ---------------------------------------------------------------------------

describe('calculateMonsterHPBudget()', () => {
  const partyDPR = 40;

  it('ferocity 1 (Deadly) yields larger HP budget than ferocity 5 (Easy)', () => {
    const deadly = calculateMonsterHPBudget(partyDPR, 1, 'mid');
    const easy   = calculateMonsterHPBudget(partyDPR, 5, 'mid');
    assert.ok(deadly > easy, `deadly ${deadly} should > easy ${easy}`);
  });

  it('boss position yields larger HP budget than early position', () => {
    const boss  = calculateMonsterHPBudget(partyDPR, 3, 'boss');
    const early = calculateMonsterHPBudget(partyDPR, 3, 'early');
    assert.ok(boss > early, `boss ${boss} should > early ${early}`);
  });

  it('scales linearly with partyDPR', () => {
    const base   = calculateMonsterHPBudget(40,  3, 'mid');
    const double = calculateMonsterHPBudget(80,  3, 'mid');
    assert.ok(Math.abs(double / base - 2) < 0.05, `expected 2×, got ${double/base}`);
  });

  it('correction factor scales result', () => {
    const base    = calculateMonsterHPBudget(partyDPR, 3, 'mid', 1.0);
    const boosted = calculateMonsterHPBudget(partyDPR, 3, 'mid', 1.5);
    assert.ok(Math.abs(boosted / base - 1.5) < 0.05, `expected 1.5×, got ${boosted/base}`);
  });

  it('returns a positive number', () => {
    assert.ok(calculateMonsterHPBudget(partyDPR, 3, 'mid') > 0);
  });
});

// ---------------------------------------------------------------------------
// calculateMonsterDPRBudget
// ---------------------------------------------------------------------------

describe('calculateMonsterDPRBudget()', () => {
  const partyHP = 158; // fighter 52 + cleric 40 + rogue 36 + wizard 30

  it('ferocity 1 yields larger DPR budget than ferocity 5', () => {
    const deadly = calculateMonsterDPRBudget(partyHP, 1, 'mid');
    const easy   = calculateMonsterDPRBudget(partyHP, 5, 'mid');
    assert.ok(deadly > easy, `deadly ${deadly} should > easy ${easy}`);
  });

  it('boss position yields larger DPR budget than early', () => {
    const boss  = calculateMonsterDPRBudget(partyHP, 3, 'boss');
    const early = calculateMonsterDPRBudget(partyHP, 3, 'early');
    assert.ok(boss > early, `boss ${boss} should > early ${early}`);
  });

  it('returns a positive number', () => {
    assert.ok(calculateMonsterDPRBudget(partyHP, 3, 'mid') > 0);
  });
});

// ---------------------------------------------------------------------------
// estimateMonsterDPR
// ---------------------------------------------------------------------------

describe('estimateMonsterDPR()', () => {
  it('goblin DPR is in range [1, 8]', () => {
    const dpr = estimateMonsterDPR(MINI_DB.goblin);
    assert.ok(dpr >= 1 && dpr <= 8, `goblin DPR: ${dpr}`);
  });

  it('troll DPR > goblin DPR', () => {
    const trollDPR  = estimateMonsterDPR(MINI_DB.troll);
    const goblinDPR = estimateMonsterDPR(MINI_DB.goblin);
    assert.ok(trollDPR > goblinDPR, `troll ${trollDPR} vs goblin ${goblinDPR}`);
  });

  it('returns a non-negative number', () => {
    assert.ok(estimateMonsterDPR(MINI_DB.bugbear) >= 0);
  });
});

// ---------------------------------------------------------------------------
// selectMonsters
// ---------------------------------------------------------------------------

describe('selectMonsters()', () => {
  it('returns an array', () => {
    const result = selectMonsters(100, 20, MINI_DB);
    assert.ok(Array.isArray(result));
  });

  it('each entry has required fields', () => {
    const result = selectMonsters(100, 20, MINI_DB);
    assert.ok(result.length > 0, 'should return at least 1 monster');
    for (const m of result) {
      assert.ok(typeof m.slug        === 'string', 'slug');
      assert.ok(typeof m.name        === 'string', 'name');
      assert.ok(typeof m.count       === 'number', 'count');
      assert.ok(typeof m.hp          === 'number', 'hp');
      assert.ok(typeof m.cr          === 'number', 'cr');
      assert.ok(typeof m.estimatedDPR === 'number', 'estimatedDPR');
    }
  });

  it('total HP does not wildly overshoot budget (< 2.5×)', () => {
    const hpBudget = 100;
    const result   = selectMonsters(hpBudget, 30, MINI_DB);
    const totalHP  = result.reduce((s, m) => s + m.hp * m.count, 0);
    assert.ok(totalHP < hpBudget * 2.5, `totalHP ${totalHP} way over budget ${hpBudget}`);
  });

  it('count >= 1 for every entry', () => {
    const result = selectMonsters(80, 20, MINI_DB);
    for (const m of result) assert.ok(m.count >= 1);
  });

  it('maxCR option filters out high-CR monsters', () => {
    const result = selectMonsters(200, 50, MINI_DB, { maxCR: 1 });
    for (const m of result) assert.ok(m.cr <= 1, `CR ${m.cr} exceeds maxCR 1`);
  });

  it('respects empty DB gracefully', () => {
    const result = selectMonsters(100, 20, {});
    assert.deepEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// designCombatEncounter
// ---------------------------------------------------------------------------

describe('designCombatEncounter()', () => {
  const party = [makeFighter(), makeCleric(), makeRogue(), makeWizard()];

  it('returns expected top-level shape', () => {
    const enc = designCombatEncounter(party, 3, 'mid', MINI_DB);
    assert.equal(enc.pillar, 'combat');
    assert.equal(typeof enc.hpBudget,        'number');
    assert.equal(typeof enc.dprBudget,       'number');
    assert.equal(typeof enc.totalMonsterHP,  'number');
    assert.equal(typeof enc.estimatedRounds, 'number');
    assert.ok(Array.isArray(enc.monsters));
  });

  it('monsters array is non-empty', () => {
    const enc = designCombatEncounter(party, 3, 'mid', MINI_DB);
    assert.ok(enc.monsters.length > 0);
  });

  it('deadly encounter has larger hpBudget than easy', () => {
    const deadly = designCombatEncounter(party, 1, 'mid', MINI_DB);
    const easy   = designCombatEncounter(party, 5, 'mid', MINI_DB);
    assert.ok(deadly.hpBudget > easy.hpBudget);
  });

  it('boss position has larger hpBudget than early', () => {
    const boss  = designCombatEncounter(party, 3, 'boss',  MINI_DB);
    const early = designCombatEncounter(party, 3, 'early', MINI_DB);
    assert.ok(boss.hpBudget > early.hpBudget);
  });

  it('estimatedRounds is positive', () => {
    const enc = designCombatEncounter(party, 3, 'mid', MINI_DB);
    assert.ok(enc.estimatedRounds > 0);
  });
});

// ---------------------------------------------------------------------------
// designSocialEncounter
// ---------------------------------------------------------------------------

describe('designSocialEncounter()', () => {
  it('returns expected shape', () => {
    const enc = designSocialEncounter(3, 'mid');
    assert.equal(enc.pillar, 'social');
    assert.equal(typeof enc.dc,              'number');
    assert.equal(typeof enc.successesNeeded, 'number');
    assert.equal(typeof enc.maxFailures,     'number');
    assert.ok(typeof enc.type === 'string' && enc.type.length > 0);
  });

  it('DC for ferocity 1 > ferocity 5', () => {
    assert.ok(designSocialEncounter(1, 'mid').dc > designSocialEncounter(5, 'mid').dc);
  });

  it('deadly DC is 19', () => {
    assert.equal(designSocialEncounter(1, 'mid').dc, 19);
  });

  it('balanced DC is 14', () => {
    assert.equal(designSocialEncounter(3, 'mid').dc, 14);
  });

  it('easy DC is 9', () => {
    assert.equal(designSocialEncounter(5, 'mid').dc, 9);
  });

  it('difficultyRating equals ferocity', () => {
    for (let f = 1; f <= 5; f++) {
      assert.equal(designSocialEncounter(f, 'mid').difficultyRating, f);
    }
  });
});

// ---------------------------------------------------------------------------
// designExplorationEncounter
// ---------------------------------------------------------------------------

describe('designExplorationEncounter()', () => {
  it('returns expected shape', () => {
    const enc = designExplorationEncounter(3, 'mid');
    assert.equal(enc.pillar, 'exploration');
    assert.equal(typeof enc.dc,          'number');
    assert.equal(typeof enc.trapDamage,  'string');
    assert.equal(typeof enc.detectionDC, 'number');
    assert.ok(typeof enc.type === 'string' && enc.type.length > 0);
  });

  it('DC scales with ferocity (deadly > easy)', () => {
    assert.ok(designExplorationEncounter(1, 'mid').dc > designExplorationEncounter(5, 'mid').dc);
  });

  it('deadly trap damage is 4d10', () => {
    assert.equal(designExplorationEncounter(1, 'mid').trapDamage, '4d10');
  });

  it('easy trap damage is 1d6', () => {
    assert.equal(designExplorationEncounter(5, 'mid').trapDamage, '1d6');
  });

  it('detectionDC scales with ferocity', () => {
    const d1 = designExplorationEncounter(1, 'mid').detectionDC;
    const d5 = designExplorationEncounter(5, 'mid').detectionDC;
    assert.ok(d1 > d5, `deadly detectionDC ${d1} should > easy ${d5}`);
  });
});

// ---------------------------------------------------------------------------
// designAdventuringDay
// ---------------------------------------------------------------------------

describe('designAdventuringDay()', () => {
  const party   = [makeFighter(), makeCleric(), makeRogue(), makeWizard()];
  const pillars = { combat: 50, social: 25, exploration: 25 };

  it('returns encounters array and summary', () => {
    const day = designAdventuringDay(party, 3, pillars, MINI_DB);
    assert.ok(Array.isArray(day.encounters));
    assert.ok(day.summary && typeof day.summary === 'object');
  });

  it('ends with a long rest', () => {
    const day = designAdventuringDay(party, 3, pillars, MINI_DB);
    const last = day.encounters[day.encounters.length - 1];
    assert.equal(last.pillar, 'rest');
    assert.equal(last.type,   'long');
  });

  it('contains at least 1 combat encounter', () => {
    const day = designAdventuringDay(party, 3, pillars, MINI_DB);
    assert.ok(day.encounters.some(e => e.pillar === 'combat'));
  });

  it('encounter count matches ferocity range (Balanced = 4–6)', () => {
    const day   = designAdventuringDay(party, 3, pillars, MINI_DB);
    const count = day.summary.totalEncounters;
    assert.ok(count >= 4 && count <= 6, `encounter count ${count} not in [4,6]`);
  });

  it('deadly day has more encounters than easy day', () => {
    const deadly = designAdventuringDay(party, 1, pillars, MINI_DB);
    const easy   = designAdventuringDay(party, 5, pillars, MINI_DB);
    assert.ok(deadly.summary.totalEncounters >= easy.summary.totalEncounters,
      `deadly ${deadly.summary.totalEncounters} < easy ${easy.summary.totalEncounters}`);
  });

  it('includes at least one short rest for balanced difficulty', () => {
    const day = designAdventuringDay(party, 3, pillars, MINI_DB);
    assert.ok(day.encounters.some(e => e.pillar === 'rest' && e.type === 'short'),
      'missing short rest');
  });

  it('pillar distribution roughly matches requested pillars (±20%)', () => {
    const day = designAdventuringDay(party, 3, { combat: 100, social: 0, exploration: 0 }, MINI_DB);
    assert.ok(day.summary.combatCount > 0);
    // All non-rest encounters should be combat
    const nonRest = day.encounters.filter(e => e.pillar !== 'rest');
    assert.ok(nonRest.every(e => e.pillar === 'combat'),
      'Expected all encounters to be combat');
  });

  it('orders the day toward the dominant pillar weighting', () => {
    const day = designAdventuringDay(party, 3, { combat: 10, social: 80, exploration: 10 }, MINI_DB);
    const playable = day.encounters.filter(e => e.pillar !== 'rest');

    assert.equal(playable[0].pillar, 'social');
    assert.ok(
      playable.filter(e => e.pillar === 'social').length > playable.filter(e => e.pillar === 'combat').length,
      'social-heavy weighting should create more social beats than combat beats'
    );
  });

  it('summary ferocityLabel matches FEROCITY table', () => {
    for (let f = 1; f <= 5; f++) {
      const day = designAdventuringDay(party, f, pillars, MINI_DB);
      assert.equal(day.summary.ferocityLabel, FEROCITY[f].label);
    }
  });
});

// ---------------------------------------------------------------------------
// updateRollingDPR
// ---------------------------------------------------------------------------

describe('updateRollingDPR()', () => {
  it('single value returns that value', () => {
    assert.equal(updateRollingDPR([42]), 42);
  });

  it('two values: newer has more weight', () => {
    // weights [0.35, 0.25] — newest (100) should pull average above midpoint 50
    const avg = updateRollingDPR([10, 100]);
    assert.ok(avg > 50, `expected avg > 50, got ${avg}`);
  });

  it('weights [0.35, 0.25, 0.20, 0.12, 0.08] sum to 1.0', () => {
    const weights = [0.35, 0.25, 0.20, 0.12, 0.08];
    const sum = weights.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) < 0.001);
  });

  it('5-item history uses all weights', () => {
    // All same value → result should equal that value
    const val = 20;
    const result = updateRollingDPR([val, val, val, val, val]);
    assert.ok(Math.abs(result - val) < 0.01);
  });

  it('returns 0 for empty array', () => {
    assert.equal(updateRollingDPR([]), 0);
  });

  it('ignores entries beyond 5', () => {
    const short = updateRollingDPR([10, 20, 30, 40, 50]);
    const long  = updateRollingDPR([999, 999, 10, 20, 30, 40, 50]);
    assert.equal(short, long);
  });
});

// ---------------------------------------------------------------------------
// applyDifficultyCorrection
// ---------------------------------------------------------------------------

describe('applyDifficultyCorrection()', () => {
  it('ratio < 0.6 increases correction by 0.15', () => {
    const result = applyDifficultyCorrection(1.0, { actualRounds: 1, predictedRounds: 4 });
    assert.ok(Math.abs(result - 1.15) < 0.001, `got ${result}`);
  });

  it('ratio in [0.6, 0.8) increases by 0.10', () => {
    const result = applyDifficultyCorrection(1.0, { actualRounds: 2.5, predictedRounds: 4 });
    assert.ok(Math.abs(result - 1.10) < 0.001, `got ${result}`);
  });

  it('ratio > 1.5 decreases by 0.15', () => {
    const result = applyDifficultyCorrection(1.0, { actualRounds: 7, predictedRounds: 4 });
    assert.ok(Math.abs(result - 0.85) < 0.001, `got ${result}`);
  });

  it('ratio in (1.2, 1.5] decreases by 0.10', () => {
    const result = applyDifficultyCorrection(1.0, { actualRounds: 5, predictedRounds: 4 });
    assert.ok(Math.abs(result - 0.90) < 0.001, `got ${result}`);
  });

  it('ratio in [0.8, 1.2] makes no change', () => {
    const result = applyDifficultyCorrection(1.0, { actualRounds: 4, predictedRounds: 4 });
    assert.ok(Math.abs(result - 1.0) < 0.001, `got ${result}`);
  });

  it('clamps at lower bound 0.5', () => {
    const result = applyDifficultyCorrection(0.55, { actualRounds: 8, predictedRounds: 4 });
    assert.equal(result, 0.5);
  });

  it('clamps at upper bound 2.0', () => {
    const result = applyDifficultyCorrection(1.9, { actualRounds: 1, predictedRounds: 4 });
    assert.equal(result, 2.0);
  });
});

// ---------------------------------------------------------------------------
// formatPlanForPrompt
// ---------------------------------------------------------------------------

describe('formatPlanForPrompt()', () => {
  const party = [makeFighter(), makeCleric()];
  let plan;

  // Build a plan to use across tests
  plan = designAdventuringDay(party, 3, { combat: 60, social: 20, exploration: 20 }, MINI_DB);

  it('returns a string', () => {
    assert.equal(typeof formatPlanForPrompt(plan, 0), 'string');
  });

  it('contains "ENCOUNTER PLAN:"', () => {
    assert.ok(formatPlanForPrompt(plan, 0).includes('ENCOUNTER PLAN:'));
  });

  it('contains encounter number and total', () => {
    const str = formatPlanForPrompt(plan, 0);
    assert.ok(/Encounter \d+ of \d+/.test(str), `missing encounter count in: ${str}`);
  });

  it('handles out-of-range index gracefully', () => {
    const str = formatPlanForPrompt(plan, 9999);
    assert.ok(str.includes('complete'), `expected completion message, got: ${str}`);
  });

  it('contains "Pillar progress:"', () => {
    const str = formatPlanForPrompt(plan, 1);
    assert.ok(str.includes('Pillar progress:'), `missing pillar progress in: ${str}`);
  });

  it('includes a story beat contract so planned encounters do not feel random', () => {
    const str = formatPlanForPrompt(plan, 0);

    assert.ok(str.includes('STORY BEAT CONTRACT'), `missing story beat contract in: ${str}`);
    assert.match(str, /Objective:/, `missing objective in: ${str}`);
    assert.match(str, /Because:/, `missing because/provenance in: ${str}`);
    assert.match(str, /Therefore:/, `missing consequence bridge in: ${str}`);
    assert.match(str, /Success:/, `missing success consequence in: ${str}`);
    assert.match(str, /Failure:/, `missing failure consequence in: ${str}`);
    assert.match(str, /Continuity:/, `missing continuity bridge in: ${str}`);
    assert.match(str, /Reuse or evolve the current route/, `missing route continuity rule in: ${str}`);
    assert.match(str, /Next hook:/, `missing next hook in: ${str}`);
  });
});

// ---------------------------------------------------------------------------
// Constants sanity checks
// ---------------------------------------------------------------------------

describe('FEROCITY constant', () => {
  it('has entries 1–5', () => {
    for (let f = 1; f <= 5; f++) assert.ok(FEROCITY[f], `missing ferocity ${f}`);
  });

  it('hpMult decreases as ferocity increases (deadlier = higher multiplier)', () => {
    for (let f = 1; f < 5; f++) {
      assert.ok(FEROCITY[f].hpMult >= FEROCITY[f + 1].hpMult,
        `ferocity ${f} hpMult should >= ferocity ${f+1}`);
    }
  });

  it('encPerDay[0] >= 2 for all ferocities', () => {
    for (let f = 1; f <= 5; f++) assert.ok(FEROCITY[f].encPerDay[0] >= 2);
  });
});

describe('POSITION_MULT constant', () => {
  it('has early, mid, late, boss', () => {
    assert.ok(POSITION_MULT.early);
    assert.ok(POSITION_MULT.mid);
    assert.ok(POSITION_MULT.late);
    assert.ok(POSITION_MULT.boss);
  });

  it('boss > late > mid > early', () => {
    assert.ok(POSITION_MULT.boss > POSITION_MULT.late);
    assert.ok(POSITION_MULT.late > POSITION_MULT.mid);
    assert.ok(POSITION_MULT.mid  > POSITION_MULT.early);
  });
});
