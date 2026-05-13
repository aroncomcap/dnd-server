const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeDnd5eCombatStats,
  scaleCantripDamageFormula,
  getAttacksPerAction,
} = require('../combat-stats');

test('normalizes weapon attack profiles from ability stats and Extra Attack', () => {
  const stats = normalizeDnd5eCombatStats({
    system: 'dnd5e',
    level: 5,
    abilities: { str: 18, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
    proficiencyBonus: 3,
    weapons: [
      { name: 'Longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing', properties: [] },
    ],
    spells: [],
    spellSlots: {},
    features: ['Extra Attack'],
  });

  assert.equal(stats.attacksPerAction, 2);
  assert.equal(stats.attackProfiles.length, 1);
  assert.deepEqual(
    {
      id: stats.attackProfiles[0].id,
      attackBonus: stats.attackProfiles[0].attackBonus,
      damageFormula: stats.attackProfiles[0].damageFormula,
      attacksPerAction: stats.attackProfiles[0].attacksPerAction,
      enabled: stats.attackProfiles[0].enabled,
      carried: stats.attackProfiles[0].carried,
    },
    {
      id: 'weapon-longsword',
      attackBonus: 7,
      damageFormula: '1d8+4',
      attacksPerAction: 2,
      enabled: true,
      carried: true,
    }
  );
});

test('normalizes sheet-provided numeric attack bonus without changing final damage math', () => {
  const stats = normalizeDnd5eCombatStats({
    system: 'dnd5e',
    level: 5,
    abilities: { str: 18, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
    proficiencyBonus: 3,
    weapons: [
      { name: 'Greatsword', attackMod: 7, damage: '2d6+4', damageType: 'slashing', properties: [] },
    ],
    spells: [],
    spellSlots: {},
    features: [],
  });

  assert.equal(stats.attackProfiles[0].attackBonus, 7);
  assert.equal(stats.attackProfiles[0].damageFormula, '2d6+4');
  assert.equal(stats.attackProfiles[0].auto.damageFormula, '2d6+4');
});

test('manual attack profile edits persist while auto math updates after level changes', () => {
  const stats = normalizeDnd5eCombatStats({
    system: 'dnd5e',
    level: 5,
    abilities: { str: 18, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
    proficiencyBonus: 3,
    weapons: [
      { name: 'Longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing', properties: [] },
    ],
    spells: [],
    spellSlots: {},
    features: ['Extra Attack'],
    attackProfiles: [
      {
        id: 'weapon-longsword',
        manual: true,
        attackBonus: 9,
        damageFormula: '1d8+6',
        attacksPerAction: 1,
        enabled: false,
        carried: false,
      },
    ],
  });

  const profile = stats.attackProfiles[0];
  assert.equal(profile.attackBonus, 9);
  assert.equal(profile.damageFormula, '1d8+6');
  assert.equal(profile.attacksPerAction, 1);
  assert.equal(profile.enabled, false);
  assert.equal(profile.carried, false);
  assert.equal(profile.auto.attackBonus, 7);
  assert.equal(profile.auto.damageFormula, '1d8+4');
  assert.equal(profile.auto.attacksPerAction, 2);
});

test('scales cantrip damage at D&D level breakpoints', () => {
  assert.equal(scaleCantripDamageFormula('1d10', 1), '1d10');
  assert.equal(scaleCantripDamageFormula('1d10', 5), '2d10');
  assert.equal(scaleCantripDamageFormula('1d10', 11), '3d10');
  assert.equal(scaleCantripDamageFormula('1d10', 17), '4d10');
  assert.equal(scaleCantripDamageFormula('2d10', 11), '3d10');
});

test('fills common spell math defaults before building spell profiles', () => {
  const stats = normalizeDnd5eCombatStats({
    system: 'dnd5e',
    level: 5,
    abilities: { str: 10, dex: 10, con: 14, int: 10, wis: 18, cha: 10 },
    proficiencyBonus: 3,
    weapons: [],
    spells: [
      { name: 'Magic Missile' },
      { name: 'Spiritual Weapon' },
      { name: 'Sacred Flame' },
    ],
  });

  const magicMissile = stats.spells.find(s => s.name === 'Magic Missile');
  const spiritualWeapon = stats.spells.find(s => s.name === 'Spiritual Weapon');
  const sacredFlame = stats.spells.find(s => s.name === 'Sacred Flame');

  assert.equal(magicMissile.damage, '3d4+3');
  assert.equal(magicMissile.autoHit, true);
  assert.equal(spiritualWeapon.attack, true);
  assert.equal(spiritualWeapon.damage, '1d8');
  assert.equal(sacredFlame.save, 'dex');
  assert.equal(sacredFlame.damage, '1d8');
  assert.ok(stats.attackProfiles.some(profile => profile.id === 'spell-magic-missile'));
  assert.ok(stats.attackProfiles.some(profile => profile.id === 'spell-spiritual-weapon'));
  assert.ok(stats.attackProfiles.some(profile => profile.id === 'spell-sacred-flame'));
});

test('getAttacksPerAction honors carried and enabled attack profile toggles', () => {
  const combatant = normalizeDnd5eCombatStats({
    system: 'dnd5e',
    level: 5,
    abilities: { str: 18, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
    proficiencyBonus: 3,
    weapons: [
      { name: 'Longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing', properties: [] },
    ],
    spells: [],
    spellSlots: {},
    features: ['Extra Attack'],
    attackProfiles: [
      { id: 'weapon-longsword', manual: true, enabled: false, carried: true, attacksPerAction: 2 },
    ],
  });

  assert.equal(getAttacksPerAction(combatant, combatant.weapons[0]), 1);
});
