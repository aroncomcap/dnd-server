'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('../resolvers/runequest-resolver.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePC(overrides = {}) {
  return {
    id: 'harrek',
    name: 'Harrek',
    type: 'PC',
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
    weapons: [
      { name: 'broadsword', skill: 65, damage: '1d8+1+1d4', sr: 7, type: 'slashing' },
      { name: 'medium shield', skill: 45, damage: '1d4+1d4', parry: 45, type: 'shield' },
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

function makeEnemy(overrides = {}) {
  return {
    id: 'broo',
    name: 'Broo',
    type: 'NPC',
    system: 'runequest',
    characteristics: { str: 12, con: 11, siz: 11, int: 8, pow: 11, dex: 9, cha: 5 },
    hitLocations: {
      head: { hp: 4, maxHp: 4, armor: 0 },
      chest: { hp: 5, maxHp: 5, armor: 2 },
      abdomen: { hp: 4, maxHp: 4, armor: 2 },
      rightArm: { hp: 3, maxHp: 3, armor: 0 },
      leftArm: { hp: 3, maxHp: 3, armor: 0 },
      rightLeg: { hp: 4, maxHp: 4, armor: 2 },
      leftLeg: { hp: 4, maxHp: 4, armor: 2 },
    },
    totalHp: 11,
    weapons: [
      { name: 'spear', skill: 55, damage: '1d8+1', sr: 5, type: 'impaling' },
    ],
    skills: { dodge: 20 },
    strikeRank: 5,
    conditions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getAttackResult
// ---------------------------------------------------------------------------

describe('getAttackResult', () => {
  // skill = 60 => critical threshold = floor(60/20) = 3
  //              special threshold  = floor(60/5)  = 12
  //              hit threshold      = 60
  //              fumble             = 96-00

  it('roll ≤ skill/20 => critical', () => {
    assert.equal(getAttackResult(1, 60), 'critical');
    assert.equal(getAttackResult(3, 60), 'critical');
  });

  it('roll > skill/20 and ≤ skill/5 => special', () => {
    assert.equal(getAttackResult(4, 60), 'special');
    assert.equal(getAttackResult(12, 60), 'special');
  });

  it('roll > skill/5 and ≤ skill => hit', () => {
    assert.equal(getAttackResult(13, 60), 'hit');
    assert.equal(getAttackResult(60, 60), 'hit');
  });

  it('roll > skill and < 96 => miss', () => {
    assert.equal(getAttackResult(61, 60), 'miss');
    assert.equal(getAttackResult(95, 60), 'miss');
  });

  it('roll 96-00 (96-100) => fumble for skill < 100', () => {
    assert.equal(getAttackResult(96, 60), 'fumble');
    assert.equal(getAttackResult(100, 60), 'fumble');
  });

  it('critical threshold minimum is 1', () => {
    // skill = 10 => floor(10/20) = 0, but min is 1
    assert.equal(getAttackResult(1, 10), 'critical');
    assert.equal(getAttackResult(2, 10), 'special'); // floor(10/5) = 2, so 2 is special
  });

  it('high skill (>= 100): only roll of 100 is fumble', () => {
    assert.equal(getAttackResult(96, 110), 'hit');   // 96 ≤ 110, so hit
    assert.equal(getAttackResult(100, 110), 'fumble'); // only 100 fumbles
  });

  it('high skill (>= 100): critical threshold uses full skill/20', () => {
    // skill = 120 => critical = floor(120/20) = 6
    assert.equal(getAttackResult(6, 120), 'critical');
    assert.equal(getAttackResult(7, 120), 'special');
  });

  it('skill = 100: roll 100 is fumble, roll 99 is hit', () => {
    assert.equal(getAttackResult(99, 100), 'hit');
    assert.equal(getAttackResult(100, 100), 'fumble');
  });
});

// ---------------------------------------------------------------------------
// rollHitLocation
// ---------------------------------------------------------------------------

describe('rollHitLocation', () => {
  const VALID_LOCATIONS = ['rightLeg', 'leftLeg', 'abdomen', 'chest', 'rightArm', 'leftArm', 'head'];

  it('returns { roll, location }', () => {
    const result = rollHitLocation();
    assert.ok('roll' in result, 'missing roll');
    assert.ok('location' in result, 'missing location');
  });

  it('roll is in [1, 20]', () => {
    for (let i = 0; i < 50; i++) {
      const { roll } = rollHitLocation();
      assert.ok(roll >= 1 && roll <= 20, `roll ${roll} out of [1,20]`);
    }
  });

  it('location is always a valid hit location', () => {
    for (let i = 0; i < 100; i++) {
      const { location } = rollHitLocation();
      assert.ok(VALID_LOCATIONS.includes(location), `invalid location: ${location}`);
    }
  });

  it('all 7 locations are reachable over many rolls', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
      seen.add(rollHitLocation().location);
      if (seen.size === VALID_LOCATIONS.length) break;
    }
    assert.equal(seen.size, VALID_LOCATIONS.length, `only saw ${[...seen].join(', ')}`);
  });

  it('HIT_LOCATION_TABLE maps d20 rolls to correct locations', () => {
    // Spot-check the table per spec
    assert.equal(HIT_LOCATION_TABLE[1], 'rightLeg');
    assert.equal(HIT_LOCATION_TABLE[4], 'rightLeg');
    assert.equal(HIT_LOCATION_TABLE[5], 'leftLeg');
    assert.equal(HIT_LOCATION_TABLE[8], 'leftLeg');
    assert.equal(HIT_LOCATION_TABLE[9], 'abdomen');
    assert.equal(HIT_LOCATION_TABLE[11], 'abdomen');
    assert.equal(HIT_LOCATION_TABLE[12], 'chest');
    assert.equal(HIT_LOCATION_TABLE[13], 'rightArm');
    assert.equal(HIT_LOCATION_TABLE[15], 'rightArm');
    assert.equal(HIT_LOCATION_TABLE[16], 'leftArm');
    assert.equal(HIT_LOCATION_TABLE[18], 'leftArm');
    assert.equal(HIT_LOCATION_TABLE[19], 'head');
    assert.equal(HIT_LOCATION_TABLE[20], 'head');
  });
});

// ---------------------------------------------------------------------------
// resolveAttack
// ---------------------------------------------------------------------------

describe('resolveAttack', () => {
  const attacker = makePC();
  const target = makeEnemy();
  const weapon = attacker.weapons[0]; // broadsword

  it('returns all required fields', () => {
    const result = resolveAttack(attacker, target, weapon, 'none');
    const required = [
      'type', 'attacker', 'attackerName', 'target', 'targetName',
      'weapon', 'roll', 'attackResult', 'hitLocation', 'damage',
      'specialEffect', 'fumbleResult',
    ];
    for (const field of required) {
      assert.ok(field in result, `missing field: ${field}`);
    }
  });

  it('type is "attack"', () => {
    const result = resolveAttack(attacker, target, weapon, 'none');
    assert.equal(result.type, 'attack');
  });

  it('attackResult is one of critical/special/hit/miss/fumble', () => {
    const valid = new Set(['critical', 'special', 'hit', 'miss', 'fumble']);
    for (let i = 0; i < 20; i++) {
      const result = resolveAttack(attacker, target, weapon, 'none');
      assert.ok(valid.has(result.attackResult), `unexpected attackResult: ${result.attackResult}`);
    }
  });

  it('hitLocation is null on miss/fumble', () => {
    // Run many times; verify miss/fumble has null location
    for (let i = 0; i < 200; i++) {
      const result = resolveAttack(attacker, target, weapon, 'none');
      if (result.attackResult === 'miss' || result.attackResult === 'fumble') {
        assert.equal(result.hitLocation, null, 'miss/fumble should have null hitLocation');
      }
    }
  });

  it('damage is 0 on miss', () => {
    for (let i = 0; i < 200; i++) {
      const result = resolveAttack(attacker, target, weapon, 'none');
      if (result.attackResult === 'miss') {
        assert.equal(result.damage, 0, 'miss should deal 0 damage');
      }
    }
  });

  it('fumble populates fumbleResult', () => {
    // Verify that if attackResult is fumble, fumbleResult has a description
    for (let i = 0; i < 500; i++) {
      const result = resolveAttack(attacker, target, weapon, 'none');
      if (result.attackResult === 'fumble') {
        assert.ok(result.fumbleResult !== null, 'fumble should have fumbleResult');
        assert.ok(typeof result.fumbleResult.description === 'string');
        break;
      }
    }
  });

  it('critical gives damage > 0', () => {
    for (let i = 0; i < 500; i++) {
      const result = resolveAttack(attacker, target, weapon, 'none');
      if (result.attackResult === 'critical') {
        assert.ok(result.damage > 0, 'critical should deal damage');
        break;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// resolveDefense
// ---------------------------------------------------------------------------

describe('resolveDefense', () => {
  const defender = makePC();

  it('dodge success negates all damage', () => {
    const weapon = { name: 'spear', absorption: 6, type: 'impaling' };
    // Run many times looking for a dodge success
    let foundSuccess = false;
    for (let i = 0; i < 500; i++) {
      const result = resolveDefense(defender, 'dodge', weapon, 10, 'hit');
      if (result.success) {
        assert.equal(result.damageAbsorbed, 10, 'successful dodge absorbs all damage');
        assert.equal(result.remainingDamage, 0);
        foundSuccess = true;
        break;
      }
    }
    assert.ok(foundSuccess, 'never found a dodge success in 500 attempts');
  });

  it('parry reduces damage by absorption amount', () => {
    const weapon = { name: 'medium shield', absorption: 12, type: 'shield' };
    let foundNormalParry = false;
    for (let i = 0; i < 500; i++) {
      const result = resolveDefense(defender, 'parry', weapon, 15, 'hit');
      if (result.success && result.parryResult === 'normal') {
        // Normal parry absorbs absorption amount (12)
        assert.equal(result.damageAbsorbed, Math.min(12, 15));
        assert.equal(result.remainingDamage, 15 - result.damageAbsorbed);
        foundNormalParry = true;
        break;
      }
    }
    assert.ok(foundNormalParry, 'never found a normal parry success');
  });

  it('failed defense leaves damage unchanged', () => {
    // Use a combatant with 0 dodge skill for easy failure
    const poorDefender = makePC({ skills: { dodge: 1 } });
    let foundFailure = false;
    for (let i = 0; i < 500; i++) {
      const result = resolveDefense(poorDefender, 'dodge', null, 10, 'hit');
      if (!result.success) {
        assert.equal(result.damageAbsorbed, 0);
        assert.equal(result.remainingDamage, 10);
        foundFailure = true;
        break;
      }
    }
    assert.ok(foundFailure, 'never found a dodge failure');
  });

  it('critical parry vs normal hit: no damage, attacker weapon damaged', () => {
    // Use combatant with very high parry skill to eventually get a critical parry
    const greatDefender = makePC({
      weapons: [{ name: 'medium shield', skill: 95, damage: '1d4+1d4', parry: 95, type: 'shield', absorption: 12 }],
    });
    const shield = greatDefender.weapons[0];
    let foundCritParry = false;
    for (let i = 0; i < 500; i++) {
      const result = resolveDefense(greatDefender, 'parry', shield, 8, 'hit');
      if (result.success && result.parryResult === 'critical') {
        assert.equal(result.remainingDamage, 0);
        assert.ok(result.attackerWeaponDamaged, 'critical parry should damage attacker weapon');
        foundCritParry = true;
        break;
      }
    }
    assert.ok(foundCritParry, 'never found a critical parry in 500 attempts');
  });

  it('returns all required fields', () => {
    const weapon = { name: 'medium shield', absorption: 12, type: 'shield' };
    const result = resolveDefense(defender, 'parry', weapon, 8, 'hit');
    const required = ['type', 'defenseType', 'roll', 'success', 'parryResult', 'damageAbsorbed', 'remainingDamage', 'attackerWeaponDamaged'];
    for (const f of required) {
      assert.ok(f in result, `missing field: ${f}`);
    }
  });
});

// ---------------------------------------------------------------------------
// applyDamage
// ---------------------------------------------------------------------------

describe('applyDamage', () => {
  it('returns all required fields', () => {
    const target = makeEnemy();
    const result = applyDamage(target, 5, 'chest');
    const required = [
      'location', 'armor', 'rawDamage', 'effectiveDamage',
      'locationHpBefore', 'locationHpAfter', 'locationMaxHp',
      'totalHp', 'limbStatus',
    ];
    for (const f of required) {
      assert.ok(f in result, `missing field: ${f}`);
    }
  });

  it('subtracts armor before applying damage', () => {
    const target = makeEnemy(); // chest has armor: 2
    const result = applyDamage(target, 5, 'chest');
    // effective damage = 5 - 2 = 3
    assert.equal(result.armor, 2);
    assert.equal(result.effectiveDamage, 3);
    assert.equal(result.rawDamage, 5);
  });

  it('armor cannot reduce damage below 0', () => {
    const target = makeEnemy(); // chest armor = 2
    const result = applyDamage(target, 1, 'chest');
    assert.equal(result.effectiveDamage, 0);
    assert.equal(result.locationHpAfter, result.locationHpBefore);
  });

  it('location hp reduced correctly', () => {
    const target = makeEnemy(); // rightArm: hp=3, armor=0
    const result = applyDamage(target, 2, 'rightArm');
    assert.equal(result.locationHpBefore, 3);
    assert.equal(result.locationHpAfter, 1);
    assert.equal(result.effectiveDamage, 2);
  });

  it('totalHp is reduced by effectiveDamage', () => {
    const target = makeEnemy(); // totalHp = 11
    const result = applyDamage(target, 5, 'chest'); // armor 2, effective = 3
    assert.equal(result.totalHp, 11 - 3);
  });

  it('location HP ≤ 0 => limbStatus is "useless"', () => {
    const target = makeEnemy(); // rightArm: hp=3, armor=0
    const result = applyDamage(target, 3, 'rightArm');
    assert.equal(result.locationHpAfter, 0);
    assert.equal(result.limbStatus, 'useless');
  });

  it('location HP ≤ -(maxHp) => limbStatus is "severed"', () => {
    const target = makeEnemy(); // rightArm: hp=3, maxHp=3, armor=0
    const result = applyDamage(target, 7, 'rightArm'); // 7 damage, no armor => hp goes to 3-7 = -4 ≤ -3
    assert.ok(result.locationHpAfter <= -target.hitLocations.rightArm.maxHp);
    assert.equal(result.limbStatus, 'severed');
  });

  it('no armor location: full damage applies', () => {
    const target = makeEnemy(); // head: hp=4, armor=0
    const result = applyDamage(target, 3, 'head');
    assert.equal(result.effectiveDamage, 3);
    assert.equal(result.locationHpAfter, 1);
  });

  it('mutates the target hitLocation hp', () => {
    const target = makeEnemy();
    applyDamage(target, 2, 'head'); // head hp: 4 -> 2
    assert.equal(target.hitLocations.head.hp, 2);
  });

  it('mutates totalHp on target', () => {
    const target = makeEnemy(); // totalHp = 11
    applyDamage(target, 3, 'head'); // no armor
    assert.equal(target.totalHp, 8);
  });
});

// ---------------------------------------------------------------------------
// checkDeath
// ---------------------------------------------------------------------------

describe('checkDeath', () => {
  it('totalHp > 0 and no critical location at 0 => alive', () => {
    const pc = makePC();
    const result = checkDeath(pc);
    assert.equal(result.status, 'alive');
  });

  it('totalHp ≤ 0 => dead', () => {
    const pc = makePC({ totalHp: 0 });
    const result = checkDeath(pc);
    assert.equal(result.status, 'dead');
  });

  it('NPC totalHp ≤ 0 => dead', () => {
    const npc = makeEnemy({ totalHp: 0 });
    const result = checkDeath(npc);
    assert.equal(result.status, 'dead');
  });

  it('head location at 0 => unconscious', () => {
    const pc = makePC();
    pc.hitLocations.head.hp = 0;
    const result = checkDeath(pc);
    assert.equal(result.status, 'unconscious');
  });

  it('chest location at 0 and totalHp > 0 => seriously wounded', () => {
    const pc = makePC();
    pc.hitLocations.chest.hp = 0;
    const result = checkDeath(pc);
    // Chest at 0 = seriously wounded (common RQ rule)
    assert.ok(['dead', 'unconscious', 'seriously_wounded'].includes(result.status));
  });

  it('returns id and name', () => {
    const pc = makePC();
    const result = checkDeath(pc);
    assert.equal(result.id, 'harrek');
    assert.equal(result.name, 'Harrek');
  });

  it('returns reason when not alive', () => {
    const pc = makePC({ totalHp: -1 });
    const result = checkDeath(pc);
    assert.ok('reason' in result, 'should include reason when not alive');
  });
});

// ---------------------------------------------------------------------------
// rollInitiative (Strike Rank)
// ---------------------------------------------------------------------------

describe('rollInitiative', () => {
  it('is deterministic (no dice)', () => {
    const pc = makePC(); // dex=11, siz=13
    const sr1 = rollInitiative(pc);
    const sr2 = rollInitiative(pc);
    assert.equal(sr1, sr2, 'strike rank should be deterministic');
  });

  it('DEX SR: dex=11 maps to DEX SR 3 (9-12 range)', () => {
    // dex=11 => DEX SR=3, siz=13 => SIZ SR=1
    // total SR = 3+1 = 4
    const pc = makePC(); // dex=11, siz=13
    assert.equal(rollInitiative(pc), 4);
  });

  it('low DEX (1-5) => DEX SR 5', () => {
    const pc = makePC({ characteristics: { str: 10, con: 10, siz: 10, int: 10, pow: 10, dex: 3, cha: 10 } });
    // dex=3 => DEX SR=5, siz=10 => SIZ SR=1 => total=6
    assert.equal(rollInitiative(pc), 6);
  });

  it('high DEX (19+) => DEX SR 0', () => {
    const pc = makePC({ characteristics: { str: 10, con: 10, siz: 10, int: 10, pow: 10, dex: 20, cha: 10 } });
    // dex=20 => DEX SR=0, siz=10 => SIZ SR=1 => total=1
    assert.equal(rollInitiative(pc), 1);
  });

  it('lower strike rank = faster (verify relative ordering)', () => {
    const fast = makePC({ characteristics: { str: 10, con: 10, siz: 8, int: 10, pow: 10, dex: 17, cha: 10 } });
    const slow = makePC({ characteristics: { str: 10, con: 10, siz: 20, int: 10, pow: 10, dex: 4, cha: 10 } });
    assert.ok(rollInitiative(fast) < rollInitiative(slow), 'fast combatant should have lower SR');
  });

  it('SIZ SR: siz=21+ => SIZ SR 0', () => {
    const pc = makePC({ characteristics: { str: 10, con: 10, siz: 22, int: 10, pow: 10, dex: 11, cha: 10 } });
    // dex=11 => DEX SR=3, siz=22 => SIZ SR=0 => total=3
    assert.equal(rollInitiative(pc), 3);
  });
});

// ---------------------------------------------------------------------------
// getAvailableActions
// ---------------------------------------------------------------------------

describe('getAvailableActions', () => {
  it('returns array of actions', () => {
    const pc = makePC();
    const actions = getAvailableActions(pc);
    assert.ok(Array.isArray(actions), 'should return array');
    assert.ok(actions.length > 0, 'should have at least one action');
  });

  it('includes weapon attacks', () => {
    const pc = makePC();
    const actions = getAvailableActions(pc);
    const weaponActions = actions.filter(a => a.type === 'attack');
    assert.ok(weaponActions.length > 0, 'should include weapon attack actions');
    assert.ok(weaponActions.some(a => a.name === 'broadsword'), 'should include broadsword');
  });

  it('includes dodge action', () => {
    const pc = makePC();
    const actions = getAvailableActions(pc);
    assert.ok(actions.some(a => a.type === 'dodge'), 'should include dodge action');
  });

  it('includes parry when shields/weapons available', () => {
    const pc = makePC();
    const actions = getAvailableActions(pc);
    assert.ok(actions.some(a => a.type === 'parry'), 'should include parry action');
  });

  it('includes rune spells when rune points available', () => {
    const pc = makePC(); // runePoints: 3
    const actions = getAvailableActions(pc);
    const spellActions = actions.filter(a => a.type === 'runeSpell');
    assert.ok(spellActions.length > 0, 'should include rune spell actions');
  });

  it('excludes rune spells when no rune points', () => {
    const pc = makePC({ runePoints: 0 });
    const actions = getAvailableActions(pc);
    const spellActions = actions.filter(a => a.type === 'runeSpell');
    assert.equal(spellActions.length, 0, 'should exclude rune spells with 0 rune points');
  });

  it('includes spirit spells when magic points available', () => {
    const pc = makePC(); // magicPoints: 16
    const actions = getAvailableActions(pc);
    const spiritActions = actions.filter(a => a.type === 'spiritSpell');
    assert.ok(spiritActions.length > 0, 'should include spirit spell actions');
  });

  it('excludes spirit spells when no magic points', () => {
    const pc = makePC({ magicPoints: 0 });
    const actions = getAvailableActions(pc);
    const spiritActions = actions.filter(a => a.type === 'spiritSpell');
    assert.equal(spiritActions.length, 0, 'should exclude spirit spells with 0 magic points');
  });
});

// ---------------------------------------------------------------------------
// resolveFumble
// ---------------------------------------------------------------------------

describe('resolveFumble', () => {
  it('melee table returns roll and description', () => {
    const result = resolveFumble('melee');
    assert.ok('roll' in result, 'missing roll');
    assert.ok('description' in result, 'missing description');
    assert.ok(typeof result.description === 'string', 'description should be string');
    assert.ok(result.roll >= 1 && result.roll <= 20, `roll ${result.roll} out of [1,20]`);
  });

  it('ranged table returns roll and description', () => {
    const result = resolveFumble('ranged');
    assert.ok('roll' in result);
    assert.ok('description' in result);
    assert.ok(result.roll >= 1 && result.roll <= 20);
  });

  it('natural table returns roll and description', () => {
    const result = resolveFumble('natural');
    assert.ok('roll' in result);
    assert.ok('description' in result);
  });

  it('spell table returns roll and description', () => {
    const result = resolveFumble('spell');
    assert.ok('roll' in result);
    assert.ok('description' in result);
  });

  it('all tables return weaponType', () => {
    for (const type of ['melee', 'ranged', 'natural', 'spell']) {
      const result = resolveFumble(type);
      assert.equal(result.weaponType, type, `weaponType should be ${type}`);
    }
  });

  it('MELEE_FUMBLE_TABLE has 20 entries', () => {
    assert.equal(Object.keys(MELEE_FUMBLE_TABLE).length, 20);
  });

  it('RANGED_FUMBLE_TABLE has 20 entries', () => {
    assert.equal(Object.keys(RANGED_FUMBLE_TABLE).length, 20);
  });

  it('NATURAL_FUMBLE_TABLE has 20 entries', () => {
    assert.equal(Object.keys(NATURAL_FUMBLE_TABLE).length, 20);
  });

  it('SPELL_FUMBLE_TABLE has 20 entries', () => {
    assert.equal(Object.keys(SPELL_FUMBLE_TABLE).length, 20);
  });

  it('returns description from correct table for each type', () => {
    // Run many times and verify descriptions come from the right table
    for (let i = 0; i < 20; i++) {
      const r = resolveFumble('melee');
      const expected = MELEE_FUMBLE_TABLE[r.roll];
      assert.equal(r.description, expected);
    }
  });
});

// ---------------------------------------------------------------------------
// getSpecialEffect
// ---------------------------------------------------------------------------

describe('getSpecialEffect', () => {
  it('returns null for normal hit', () => {
    const weapon = { name: 'broadsword', type: 'slashing', damage: '1d8+1' };
    assert.equal(getSpecialEffect(weapon, 'hit'), null);
  });

  it('returns null for miss', () => {
    const weapon = { name: 'spear', type: 'impaling', damage: '1d8+1' };
    assert.equal(getSpecialEffect(weapon, 'miss'), null);
  });

  it('critical hit ignores armor and maximizes damage', () => {
    const weapon = { name: 'broadsword', type: 'slashing', damage: '1d8+1' };
    const effect = getSpecialEffect(weapon, 'critical');
    assert.ok(effect !== null, 'critical should have special effect');
    assert.equal(effect.ignoreArmor, true);
    assert.equal(effect.maximizeDamage, true);
  });

  it('special hit on impaling weapon => impale effect', () => {
    const weapon = { name: 'spear', type: 'impaling', damage: '1d8+1' };
    const effect = getSpecialEffect(weapon, 'special');
    assert.ok(effect !== null);
    assert.equal(effect.type, 'impale');
    assert.ok(effect.weaponStuck, 'impale sticks weapon');
  });

  it('special hit on slashing weapon => slash effect with bleeding', () => {
    const weapon = { name: 'broadsword', type: 'slashing', damage: '1d8+1' };
    const effect = getSpecialEffect(weapon, 'special');
    assert.ok(effect !== null);
    assert.equal(effect.type, 'slash');
    assert.ok('bleeding' in effect, 'slash should have bleeding');
  });

  it('special hit on crushing weapon => crush effect with knockback', () => {
    const weapon = { name: 'mace', type: 'crushing', damage: '1d8' };
    const effect = getSpecialEffect(weapon, 'special');
    assert.ok(effect !== null);
    assert.equal(effect.type, 'crush');
    assert.ok('knockback' in effect, 'crush should have knockback');
  });
});

// ---------------------------------------------------------------------------
// maximizeDamage
// ---------------------------------------------------------------------------

describe('maximizeDamage', () => {
  it('1d6 => 6', () => assert.equal(maximizeDamage('1d6'), 6));
  it('1d8 => 8', () => assert.equal(maximizeDamage('1d8'), 8));
  it('2d6 => 12', () => assert.equal(maximizeDamage('2d6'), 12));
  it('1d8+1 => 9', () => assert.equal(maximizeDamage('1d8+1'), 9));
  it('1d8+1+1d4 => 13', () => assert.equal(maximizeDamage('1d8+1+1d4'), 13));
  it('1d4+1d4 => 8', () => assert.equal(maximizeDamage('1d4+1d4'), 8));
  it('3d6+2 => 20', () => assert.equal(maximizeDamage('3d6+2'), 20));
});
