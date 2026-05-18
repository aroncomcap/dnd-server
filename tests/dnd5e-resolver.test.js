'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('../resolvers/dnd5e-resolver.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePC(overrides = {}) {
  return {
    id: 'kael',
    name: 'Kael',
    type: 'PC',
    level: 5,
    ac: 16,
    hp: 38,
    maxHp: 38,
    speed: 30,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 13, cha: 8 },
    saveProficiencies: ['str', 'con'],
    proficiencyBonus: 3,
    weapons: [
      { name: 'longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing', properties: [] },
    ],
    spells: [
      { name: 'fireball', level: 3, save: 'dex', damage: '8d6', damageType: 'fire' },
      { name: 'cure wounds', level: 1, healing: '1d8', effect: 'heal' },
    ],
    spellSlots: { 1: 4, 2: 3, 3: 2 },
    spellcastingAbility: 'int',
    features: [],
    conditions: [],
    concentrating: null,
    deathSaves: { successes: 0, failures: 0 },
    inspiration: false,
    resistances: [],
    vulnerabilities: [],
    immunities: [],
    ...overrides,
  };
}

function makeEnemy(overrides = {}) {
  return {
    id: 'goblin',
    name: 'Goblin',
    type: 'Enemy',
    level: 1,
    ac: 13,
    hp: 7,
    maxHp: 7,
    speed: 30,
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
    resistances: [],
    vulnerabilities: [],
    immunities: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getAbilityMod
// ---------------------------------------------------------------------------

describe('getAbilityMod', () => {
  it('score 1 => -5', () => assert.equal(getAbilityMod(1), -5));
  it('score 8 => -1', () => assert.equal(getAbilityMod(8), -1));
  it('score 10 => 0', () => assert.equal(getAbilityMod(10), 0));
  it('score 11 => 0', () => assert.equal(getAbilityMod(11), 0));
  it('score 16 => +3', () => assert.equal(getAbilityMod(16), 3));
  it('score 20 => +5', () => assert.equal(getAbilityMod(20), 5));
});

// ---------------------------------------------------------------------------
// getSaveMod
// ---------------------------------------------------------------------------

describe('getSaveMod', () => {
  it('returns mod + proficiency for proficient save', () => {
    const pc = makePC(); // str=16 (mod +3), proficiencyBonus=3, proficient in str
    assert.equal(getSaveMod(pc, 'str'), 6); // +3 mod + 3 prof
  });

  it('returns mod only for non-proficient save', () => {
    const pc = makePC(); // dex=12 (mod +1), not proficient in dex
    assert.equal(getSaveMod(pc, 'dex'), 1);
  });
});

// ---------------------------------------------------------------------------
// getSpellSaveDC
// ---------------------------------------------------------------------------

describe('getSpellSaveDC', () => {
  it('returns 8 + profBonus + spellcasting mod', () => {
    // int=10 => mod 0, profBonus=3 => DC = 8 + 3 + 0 = 11
    const pc = makePC();
    assert.equal(getSpellSaveDC(pc), 11);
  });

  it('uses correct ability for higher int caster', () => {
    const pc = makePC({ abilities: { str: 10, dex: 10, con: 10, int: 18, wis: 10, cha: 10 } });
    // int=18 => mod +4, profBonus=3 => DC = 15
    assert.equal(getSpellSaveDC(pc), 15);
  });
});

// ---------------------------------------------------------------------------
// getAttackMod
// ---------------------------------------------------------------------------

describe('getAttackMod', () => {
  it('str weapon: ability mod + proficiency', () => {
    const pc = makePC(); // str=16 => mod +3, prof=3
    const weapon = { attackMod: 'str', damage: '1d8' };
    assert.equal(getAttackMod(pc, weapon), 6);
  });

  it('dex weapon: dex mod + proficiency', () => {
    const pc = makePC(); // dex=12 => mod +1, prof=3
    const weapon = { attackMod: 'dex', damage: '1d6' };
    assert.equal(getAttackMod(pc, weapon), 4);
  });

  it('uses numeric attackMod as the final to-hit bonus when parsed from a sheet', () => {
    const pc = makePC();
    const weapon = { attackMod: 7, damage: '1d8+4' };
    assert.equal(getAttackMod(pc, weapon), 7);
  });
});

// ---------------------------------------------------------------------------
// rollInitiative
// ---------------------------------------------------------------------------

describe('rollInitiative', () => {
  it('returns a number in range [1 + dexMod, 20 + dexMod]', () => {
    const pc = makePC(); // dex=12 => mod +1
    for (let i = 0; i < 100; i++) {
      const result = rollInitiative(pc);
      assert.ok(result >= 2 && result <= 21, `initiative ${result} out of range [2, 21]`);
    }
  });

  it('returns lower range for negative dex mod', () => {
    const pc = makePC({ abilities: { str: 10, dex: 6, con: 10, int: 10, wis: 10, cha: 10 } });
    // dex=6 => mod -2
    for (let i = 0; i < 100; i++) {
      const result = rollInitiative(pc);
      assert.ok(result >= -1 && result <= 18, `initiative ${result} out of range [-1, 18]`);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveAttack
// ---------------------------------------------------------------------------

describe('resolveAttack', () => {
  const attacker = makePC();
  const target = makeEnemy();
  const weapon = attacker.weapons[0]; // longsword, str

  it('returns all required fields', () => {
    const result = resolveAttack(attacker, target, weapon, [], []);
    const required = [
      'type', 'attacker', 'attackerName', 'target', 'targetName',
      'weapon', 'roll', 'modifier', 'effectBonus', 'total', 'targetAC',
      'hit', 'critical', 'fumble', 'damageRoll', 'totalDamage', 'damageType',
    ];
    for (const field of required) {
      assert.ok(field in result, `missing field: ${field}`);
    }
  });

  it('type is "attack"', () => {
    const result = resolveAttack(attacker, target, weapon, [], []);
    assert.equal(result.type, 'attack');
  });

  it('nat 20 is critical and always hits even vs AC 30', () => {
    const highAcTarget = makeEnemy({ ac: 30 });
    // Run many times; we just need to verify the nat20 path using _resolveAttackWithRoll if available,
    // or by forcing a critical via repeated runs.
    // Since we don't have a deterministic version for resolveAttack, we verify the invariant
    // by checking that if critical=true then hit=true
    let foundCrit = false;
    for (let i = 0; i < 500; i++) {
      const r = resolveAttack(attacker, highAcTarget, weapon, [], []);
      if (r.critical) {
        assert.ok(r.hit, 'critical must always be a hit');
        assert.ok(r.roll === 20, 'critical must have roll=20');
        foundCrit = true;
        break;
      }
    }
    assert.ok(foundCrit, 'never rolled a critical in 500 attempts');
  });

  it('nat 1 is fumble and always misses even with high modifier', () => {
    const highModAttacker = makePC({
      abilities: { str: 30, dex: 12, con: 14, int: 10, wis: 13, cha: 8 },
      proficiencyBonus: 9,
    });
    let foundFumble = false;
    for (let i = 0; i < 500; i++) {
      const r = resolveAttack(highModAttacker, target, weapon, [], []);
      if (r.fumble) {
        assert.ok(!r.hit, 'fumble must never be a hit');
        assert.ok(r.roll === 1, 'fumble must have roll=1');
        foundFumble = true;
        break;
      }
    }
    assert.ok(foundFumble, 'never rolled a fumble in 500 attempts');
  });

  it('modifier equals ability mod + proficiency bonus', () => {
    const result = resolveAttack(attacker, target, weapon, [], []);
    // str=16 => +3, prof=3 => total +6
    assert.equal(result.modifier, 6);
  });

  it('hit when total >= targetAC', () => {
    for (let i = 0; i < 50; i++) {
      const r = resolveAttack(attacker, target, weapon, [], []);
      if (!r.critical && !r.fumble) {
        if (r.total >= r.targetAC) {
          assert.ok(r.hit, `total ${r.total} >= AC ${r.targetAC} should be a hit`);
        } else {
          assert.ok(!r.hit, `total ${r.total} < AC ${r.targetAC} should be a miss`);
        }
      }
    }
  });

  it('critical doubles damage dice (totalDamage > 0)', () => {
    let foundCrit = false;
    for (let i = 0; i < 500; i++) {
      const r = resolveAttack(attacker, target, weapon, [], []);
      if (r.critical) {
        assert.ok(r.totalDamage >= 1, 'critical damage must be at least 1');
        foundCrit = true;
        break;
      }
    }
    assert.ok(foundCrit, 'never found a critical to test');
  });

  it('minimum 1 damage on a hit', () => {
    // Run many attacks; when hit, damage >= 1
    for (let i = 0; i < 200; i++) {
      const r = resolveAttack(attacker, target, weapon, [], []);
      if (r.hit) {
        assert.ok(r.totalDamage >= 1, `damage ${r.totalDamage} must be at least 1 on a hit`);
      }
    }
  });

  it('adds ability modifier to bare weapon dice exactly once', () => {
    const strongAttacker = makePC({ abilities: { str: 18, dex: 12, con: 14, int: 10, wis: 13, cha: 8 } });
    const bareWeapon = { name: 'longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing', properties: [] };
    let checked = false;
    for (let i = 0; i < 300; i++) {
      const r = resolveAttack(strongAttacker, target, bareWeapon, [], []);
      if (r.hit && !r.critical) {
        assert.ok(r.totalDamage >= 5 && r.totalDamage <= 12, `bare dice damage ${r.totalDamage} should include +4 once`);
        assert.equal(r.damageFormula, '1d8+4');
        checked = true;
        break;
      }
    }
    assert.ok(checked, 'never found a normal hit to test');
  });

  it('does not add ability modifier twice when weapon damage already includes a flat modifier', () => {
    const strongAttacker = makePC({ abilities: { str: 18, dex: 12, con: 14, int: 10, wis: 13, cha: 8 } });
    const sheetWeapon = { name: 'longsword', attackMod: 'str', damage: '1d8+4', damageType: 'slashing', properties: [] };
    let checked = false;
    for (let i = 0; i < 300; i++) {
      const r = resolveAttack(strongAttacker, target, sheetWeapon, [], []);
      if (r.hit && !r.critical) {
        assert.ok(r.totalDamage >= 5 && r.totalDamage <= 12, `sheet damage ${r.totalDamage} should not double-count +4`);
        assert.equal(r.damageFormula, '1d8+4');
        checked = true;
        break;
      }
    }
    assert.ok(checked, 'never found a normal hit to test');
  });

  describe('advantage/disadvantage from conditions', () => {
    it('prone target gives advantage on melee attack (roll has advantageRolls)', () => {
      const proneTarget = makeEnemy({ conditions: ['prone'] });
      const meleeWeapon = { name: 'longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing', properties: [] };
      let foundAdv = false;
      for (let i = 0; i < 20; i++) {
        const r = resolveAttack(attacker, proneTarget, meleeWeapon, [], []);
        if (r.advantageRolls) { foundAdv = true; break; }
      }
      assert.ok(foundAdv, 'prone target with melee should produce advantageRolls');
    });

    it('blinded attacker gives disadvantage', () => {
      const blindedAttacker = makePC({ conditions: ['blinded'] });
      let foundDisadv = false;
      for (let i = 0; i < 20; i++) {
        const r = resolveAttack(blindedAttacker, target, weapon, [], []);
        if (r.advantageRolls) { foundDisadv = true; break; }
      }
      assert.ok(foundDisadv, 'blinded attacker should produce advantageRolls (disadv)');
    });
  });

  it('Bless effect adds 1d4 to attack roll', () => {
    const blessEffect = { type: 'bless', targets: [attacker.id] };
    let totalBonus = 0;
    let runs = 0;
    for (let i = 0; i < 100; i++) {
      const r = resolveAttack(attacker, target, weapon, [], [blessEffect]);
      totalBonus += r.effectBonus;
      runs++;
    }
    // Bless adds 1d4 (1-4), so average effectBonus should be ~2.5
    const avg = totalBonus / runs;
    assert.ok(avg >= 1 && avg <= 4, `avg effectBonus ${avg} should be 1-4 for bless`);
  });
});

// ---------------------------------------------------------------------------
// resolveSpell — save-based
// ---------------------------------------------------------------------------

describe('resolveSpell (save-based)', () => {
  it('returns save DC = 8 + prof + ability mod', () => {
    // int=10 => mod 0, prof=3 => DC=11
    const caster = makePC();
    const spell = { name: 'fireball', level: 3, save: 'dex', damage: '8d6', damageType: 'fire' };
    const targets = [makeEnemy()];
    const result = resolveSpell(caster, spell, targets, [], []);
    assert.equal(result.saveDC, 11);
  });

  it('uses editable spell profile save DC when present', () => {
    const caster = makePC({
      attackProfiles: [
        { id: 'spell-fireball', source: 'spell', name: 'fireball', enabled: true, saveDC: 15, damageFormula: '8d6' },
      ],
    });
    const spell = { name: 'fireball', level: 3, save: 'dex', damage: '8d6', damageType: 'fire' };
    const result = resolveSpell(caster, spell, [makeEnemy()], [], []);
    assert.equal(result.saveDC, 15);
  });

  it('each target has a saveRoll and save result', () => {
    const caster = makePC();
    const spell = { name: 'fireball', level: 3, save: 'dex', damage: '8d6', damageType: 'fire' };
    const targets = [makeEnemy(), makeEnemy({ id: 'goblin2', name: 'Goblin 2' })];
    const result = resolveSpell(caster, spell, targets, [], []);
    assert.ok(Array.isArray(result.targets), 'result.targets should be an array');
    assert.equal(result.targets.length, 2);
    for (const t of result.targets) {
      assert.ok('saveRoll' in t, 'target missing saveRoll');
      assert.ok('saved' in t, 'target missing saved');
      assert.ok('damage' in t, 'target missing damage');
    }
  });

  it('half damage on successful save', () => {
    // We cannot force a save result, but we can verify: damage on save == floor(fullDamage/2)
    const caster = makePC({ abilities: { str: 10, dex: 10, con: 10, int: 18, wis: 10, cha: 10 } }); // high int so DC is high
    const spell = { name: 'fireball', level: 3, save: 'dex', damage: '8d6', damageType: 'fire' };
    const target = makeEnemy();
    for (let i = 0; i < 50; i++) {
      const result = resolveSpell(caster, spell, [target], [], []);
      const t = result.targets[0];
      if (t.saved) {
        assert.equal(t.damage, Math.floor(t.fullDamage / 2));
      } else {
        assert.equal(t.damage, t.fullDamage);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// resolveSpell — direct damage
// ---------------------------------------------------------------------------

describe('resolveSpell (direct damage)', () => {
  it('resolves damage-only spells without treating them as buffs', () => {
    const caster = makePC();
    const target = makeEnemy({ hp: 20, maxHp: 20 });
    const spell = { name: 'magic missile', level: 1, damage: '3d4+3', damageType: 'force', autoHit: true };

    const result = resolveSpell(caster, spell, [target], [], []);

    assert.equal(result.type, 'spell-damage');
    assert.equal(result.spell, 'magic missile');
    assert.equal(result.damageType, 'force');
    assert.ok(result.damageRoll >= 6 && result.damageRoll <= 15);
    assert.equal(result.targets[0].damage, result.damageRoll);
    assert.equal(result.damageFormula, '3d4+3');
  });
});

// ---------------------------------------------------------------------------
// resolveSpell — healing
// ---------------------------------------------------------------------------

describe('resolveSpell (healing)', () => {
  it('healing amount includes spellcasting ability mod', () => {
    const caster = makePC({ abilities: { str: 10, dex: 10, con: 10, int: 20, wis: 10, cha: 10 } });
    // int=20 => mod +5, spellcastingAbility='int'
    const spell = { name: 'cure wounds', level: 1, healing: '1d8', effect: 'heal' };
    const target = makePC({ hp: 10 });
    for (let i = 0; i < 50; i++) {
      const result = resolveSpell(caster, spell, [target], [], []);
      // healing = 1d8 (1-8) + int mod (5) = 6-13
      assert.ok(result.healingRoll >= 1 && result.healingRoll <= 8, 'dice roll 1-8');
      assert.ok(result.totalHealing >= 6 && result.totalHealing <= 13, `totalHealing ${result.totalHealing} should be 6-13`);
    }
  });

  it('type is "heal"', () => {
    const caster = makePC();
    const spell = { name: 'cure wounds', level: 1, healing: '1d8', effect: 'heal' };
    const result = resolveSpell(caster, spell, [makePC()], [], []);
    assert.equal(result.type, 'heal');
  });
});

// ---------------------------------------------------------------------------
// applyDamage
// ---------------------------------------------------------------------------

describe('applyDamage', () => {
  it('returns required fields', () => {
    const target = makePC();
    const result = applyDamage(target, 10, 'slashing', []);
    const fields = ['id', 'name', 'hpBefore', 'hp', 'maxHp', 'effectiveDamage', 'damageType', 'resistant', 'vulnerable', 'immune'];
    for (const f of fields) {
      assert.ok(f in result, `missing field: ${f}`);
    }
  });

  it('normal damage reduces hp by full amount', () => {
    const target = makePC({ hp: 38 });
    const result = applyDamage(target, 10, 'slashing', []);
    assert.equal(result.effectiveDamage, 10);
    assert.equal(result.hp, 28);
  });

  it('resistance halves damage (rounded down)', () => {
    const target = makePC({ hp: 38, resistances: ['fire'] });
    const result = applyDamage(target, 9, 'fire', []);
    assert.equal(result.effectiveDamage, 4); // floor(9/2)
    assert.equal(result.hp, 34);
    assert.ok(result.resistant);
  });

  it('vulnerability doubles damage', () => {
    const target = makePC({ hp: 38, vulnerabilities: ['fire'] });
    const result = applyDamage(target, 5, 'fire', []);
    assert.equal(result.effectiveDamage, 10);
    assert.equal(result.hp, 28);
    assert.ok(result.vulnerable);
  });

  it('immunity reduces damage to 0', () => {
    const target = makePC({ hp: 38, immunities: ['poison'] });
    const result = applyDamage(target, 15, 'poison', []);
    assert.equal(result.effectiveDamage, 0);
    assert.equal(result.hp, 38);
    assert.ok(result.immune);
  });

  it('hp does not go below 0', () => {
    const target = makePC({ hp: 5 });
    const result = applyDamage(target, 100, 'slashing', []);
    assert.equal(result.hp, 0);
  });
});

// ---------------------------------------------------------------------------
// checkDeath
// ---------------------------------------------------------------------------

describe('checkDeath', () => {
  it('hp > 0 => alive', () => {
    const pc = makePC({ hp: 1 });
    assert.equal(checkDeath(pc).status, 'alive');
  });

  it('enemy at 0 hp => dead', () => {
    const enemy = makeEnemy({ hp: 0 });
    assert.equal(checkDeath(enemy).status, 'dead');
  });

  it('NPC at 0 hp => dead', () => {
    const npc = makeEnemy({ type: 'NPC', hp: 0 });
    assert.equal(checkDeath(npc).status, 'dead');
  });

  it('PC at 0 hp => unconscious', () => {
    const pc = makePC({ hp: 0 });
    assert.equal(checkDeath(pc).status, 'unconscious');
  });

  it('PC with 3 failed death saves => dead', () => {
    const pc = makePC({ hp: 0, deathSaves: { successes: 0, failures: 3 } });
    assert.equal(checkDeath(pc).status, 'dead');
  });

  it('PC with 3 successful death saves is unconscious but stable', () => {
    const pc = makePC({ hp: 0, deathSaves: { successes: 3, failures: 0 } });
    const result = checkDeath(pc);
    assert.equal(result.status, 'unconscious');
    assert.equal(result.stable, true);
  });
});

// ---------------------------------------------------------------------------
// resolveDeathSave — deterministic via _resolveDeathSaveWithRoll
// ---------------------------------------------------------------------------

describe('_resolveDeathSaveWithRoll (deterministic)', () => {
  it('roll >= 10 => success', () => {
    const pc = makePC({ hp: 0, deathSaves: { successes: 0, failures: 0 } });
    const result = _resolveDeathSaveWithRoll(pc, 10);
    assert.ok(result.success);
    assert.ok(!result.stabilized);
  });

  it('roll < 10 => failure', () => {
    const pc = makePC({ hp: 0, deathSaves: { successes: 0, failures: 0 } });
    const result = _resolveDeathSaveWithRoll(pc, 9);
    assert.ok(!result.success);
    assert.equal(result.failures, 1);
  });

  it('nat 20 => stabilized + 1 HP restored', () => {
    const pc = makePC({ hp: 0, deathSaves: { successes: 0, failures: 0 } });
    const result = _resolveDeathSaveWithRoll(pc, 20);
    assert.ok(result.stabilized);
    assert.equal(result.hp, 1);
  });

  it('nat 1 => double failure (2 failures added)', () => {
    const pc = makePC({ hp: 0, deathSaves: { successes: 0, failures: 0 } });
    const result = _resolveDeathSaveWithRoll(pc, 1);
    assert.equal(result.failures, 2);
    assert.ok(!result.success);
  });

  it('3 successes => stabilized', () => {
    const pc = makePC({ hp: 0, deathSaves: { successes: 2, failures: 0 } });
    const result = _resolveDeathSaveWithRoll(pc, 15);
    assert.ok(result.stabilized);
  });

  it('3 failures => dead', () => {
    const pc = makePC({ hp: 0, deathSaves: { successes: 0, failures: 2 } });
    const result = _resolveDeathSaveWithRoll(pc, 5);
    assert.ok(result.dead);
  });
});

describe('resolveDeathSave (random)', () => {
  it('returns required fields', () => {
    const pc = makePC({ hp: 0, deathSaves: { successes: 0, failures: 0 } });
    const result = resolveDeathSave(pc);
    const fields = ['roll', 'success', 'stabilized', 'dead', 'successes', 'failures'];
    for (const f of fields) {
      assert.ok(f in result, `missing field: ${f}`);
    }
  });

  it('roll is in [1, 20]', () => {
    const pc = makePC({ hp: 0, deathSaves: { successes: 0, failures: 0 } });
    for (let i = 0; i < 50; i++) {
      const result = resolveDeathSave(pc);
      assert.ok(result.roll >= 1 && result.roll <= 20, `roll ${result.roll} out of [1,20]`);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveConcentrationCheck
// ---------------------------------------------------------------------------

describe('resolveConcentrationCheck', () => {
  it('DC is max(10, floor(damage/2))', () => {
    const caster = makePC({ concentrating: { name: 'bless' } });
    // damage=8 => floor(8/2)=4 => DC=10 (max)
    const r1 = resolveConcentrationCheck(caster, 8);
    assert.equal(r1.dc, 10);
    // damage=30 => floor(30/2)=15 => DC=15
    const r2 = resolveConcentrationCheck(caster, 30);
    assert.equal(r2.dc, 15);
  });

  it('includes roll, saveMod, total, success, and spell', () => {
    const caster = makePC({ concentrating: { name: 'bless' } });
    const result = resolveConcentrationCheck(caster, 10);
    const fields = ['dc', 'roll', 'saveMod', 'total', 'success', 'spell'];
    for (const f of fields) {
      assert.ok(f in result, `missing field: ${f}`);
    }
  });

  it('success when total >= DC', () => {
    const caster = makePC({ concentrating: { name: 'bless' } });
    for (let i = 0; i < 100; i++) {
      const result = resolveConcentrationCheck(caster, 10);
      if (result.total >= result.dc) {
        assert.ok(result.success);
      } else {
        assert.ok(!result.success);
      }
    }
  });

  it('uses CON saving throw', () => {
    // con=14 => mod +2, proficient in con, profBonus=3 => saveMod=5
    const caster = makePC({ concentrating: { name: 'bless' } });
    const result = resolveConcentrationCheck(caster, 10);
    assert.equal(result.saveMod, 5); // +2 con mod + 3 prof
  });
});

// ---------------------------------------------------------------------------
// getAvailableActions
// ---------------------------------------------------------------------------

describe('getAvailableActions', () => {
  it('includes weapons', () => {
    const pc = makePC();
    const actions = getAvailableActions(pc);
    const weaponActions = actions.filter(a => a.type === 'weapon');
    assert.ok(weaponActions.length > 0, 'should have weapon actions');
    assert.ok(weaponActions.some(a => a.name === 'longsword'));
    assert.ok(weaponActions.some(a => a.label === 'Attack with longsword'), 'weapon actions should have enemy prompt labels');
  });

  it('includes spells when spell slots are available', () => {
    const pc = makePC(); // has spellSlots: { 1: 4, 2: 3, 3: 2 }
    const actions = getAvailableActions(pc);
    const spellActions = actions.filter(a => a.type === 'spell');
    assert.ok(spellActions.length > 0, 'should have spell actions when slots available');
  });

  it('excludes spells when no spell slots remain', () => {
    const pc = makePC({ spellSlots: { 1: 0, 2: 0, 3: 0 } });
    const actions = getAvailableActions(pc);
    const spellActions = actions.filter(a => a.type === 'spell');
    assert.equal(spellActions.length, 0, 'should have no spell actions without slots');
  });

  it('excludes spells when spellSlots is empty', () => {
    const enemy = makeEnemy(); // spellSlots: {}
    const actions = getAvailableActions(enemy);
    const spellActions = actions.filter(a => a.type === 'spell');
    assert.equal(spellActions.length, 0);
  });

  it('includes dodge, disengage, dash actions', () => {
    const pc = makePC();
    const actions = getAvailableActions(pc);
    const types = actions.map(a => a.type);
    assert.ok(types.includes('dodge'), 'should include dodge');
    assert.ok(types.includes('disengage'), 'should include disengage');
    assert.ok(types.includes('dash'), 'should include dash');
  });
});
