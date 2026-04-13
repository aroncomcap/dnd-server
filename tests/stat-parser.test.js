'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseStatsText, DND5E_SCHEMA, RUNEQUEST_SCHEMA, buildPrompt } = require('../stat-parser.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_DND_TEXT = `
Fighter Level 5. STR 18 (+4) DEX 14 (+2) CON 16 (+3) INT 10 WIS 12 CHA 10.
AC 16 (chain mail + shield). HP 38. Speed 30 ft.
Weapons: Longsword +7 to hit, 1d8+4 slashing.
Features: Action Surge, Second Wind, Extra Attack.
`;

const SAMPLE_RQ_TEXT = `
Warrior. STR 14 CON 13 SIZ 12 INT 11 POW 10 DEX 15 CHA 10.
HP: Head 4/4, Chest 6/6, Abdomen 5/5, Each Arm 3/3, Each Leg 4/4. Total HP 13.
Broadsword 65%, 1d8+1 damage, SR 3.
Skills: Dodge 35%, Scan 45%.
`;

// ---------------------------------------------------------------------------
// D&D 5e mock
// ---------------------------------------------------------------------------

describe('parseStatsText — D&D 5e mock', () => {
  it('returns an object with correct system field', async () => {
    const result = await parseStatsText(SAMPLE_DND_TEXT, 'dnd5e', { mock: true });
    assert.equal(result.system, 'dnd5e');
  });

  it('returns numeric ac and hp', async () => {
    const result = await parseStatsText(SAMPLE_DND_TEXT, 'dnd5e', { mock: true });
    assert.equal(typeof result.ac, 'number');
    assert.equal(typeof result.hp, 'number');
    assert.ok(result.ac > 0, 'ac should be positive');
    assert.ok(result.hp > 0, 'hp should be positive');
  });

  it('returns abilities object with all six scores', async () => {
    const result = await parseStatsText(SAMPLE_DND_TEXT, 'dnd5e', { mock: true });
    assert.ok(result.abilities, 'abilities must exist');
    for (const ability of ['str', 'dex', 'con', 'int', 'wis', 'cha']) {
      assert.equal(typeof result.abilities[ability], 'number', `abilities.${ability} must be a number`);
    }
  });

  it('returns a non-empty weapons array', async () => {
    const result = await parseStatsText(SAMPLE_DND_TEXT, 'dnd5e', { mock: true });
    assert.ok(Array.isArray(result.weapons), 'weapons must be an array');
    assert.ok(result.weapons.length > 0, 'weapons must not be empty');
    const [w] = result.weapons;
    assert.ok(typeof w.name === 'string', 'weapon name must be a string');
    assert.ok(typeof w.attackMod === 'number', 'weapon attackMod must be a number');
  });

  it('mock Fighter is level 5 with AC 16 and HP 38', async () => {
    const result = await parseStatsText(SAMPLE_DND_TEXT, 'dnd5e', { mock: true });
    assert.equal(result.level, 5);
    assert.equal(result.ac, 16);
    assert.equal(result.hp, 38);
  });
});

// ---------------------------------------------------------------------------
// RuneQuest mock
// ---------------------------------------------------------------------------

describe('parseStatsText — RuneQuest mock', () => {
  it('returns an object with correct system field', async () => {
    const result = await parseStatsText(SAMPLE_RQ_TEXT, 'runequest', { mock: true });
    assert.equal(result.system, 'runequest');
  });

  it('returns characteristics with all seven scores', async () => {
    const result = await parseStatsText(SAMPLE_RQ_TEXT, 'runequest', { mock: true });
    assert.ok(result.characteristics, 'characteristics must exist');
    for (const stat of ['str', 'con', 'siz', 'int', 'pow', 'dex', 'cha']) {
      assert.equal(typeof result.characteristics[stat], 'number', `characteristics.${stat} must be a number`);
    }
  });

  it('returns hitLocations with all seven locations', async () => {
    const result = await parseStatsText(SAMPLE_RQ_TEXT, 'runequest', { mock: true });
    assert.ok(result.hitLocations, 'hitLocations must exist');
    for (const loc of ['head', 'chest', 'abdomen', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg']) {
      const hl = result.hitLocations[loc];
      assert.ok(hl, `hitLocations.${loc} must exist`);
      assert.equal(typeof hl.hp, 'number', `hitLocations.${loc}.hp must be a number`);
      assert.equal(typeof hl.maxHp, 'number', `hitLocations.${loc}.maxHp must be a number`);
      assert.equal(typeof hl.armor, 'number', `hitLocations.${loc}.armor must be a number`);
    }
  });

  it('returns a non-empty weapons array with skill percentage', async () => {
    const result = await parseStatsText(SAMPLE_RQ_TEXT, 'runequest', { mock: true });
    assert.ok(Array.isArray(result.weapons), 'weapons must be an array');
    assert.ok(result.weapons.length > 0, 'weapons must not be empty');
    const [w] = result.weapons;
    assert.ok(typeof w.name === 'string', 'weapon name must be a string');
    assert.equal(typeof w.skill, 'number', 'weapon skill must be a number');
    assert.ok(w.skill >= 0 && w.skill <= 100, 'skill must be 0–100');
  });

  it('mock warrior has Broadsword skill 65% and dodge 35%', async () => {
    const result = await parseStatsText(SAMPLE_RQ_TEXT, 'runequest', { mock: true });
    assert.equal(result.weapons[0].skill, 65);
    assert.equal(result.skills.dodge, 35);
  });
});

// ---------------------------------------------------------------------------
// Schema defaults applied
// ---------------------------------------------------------------------------

describe('Schema defaults — D&D 5e', () => {
  it('fills conditions array', async () => {
    const result = await parseStatsText(SAMPLE_DND_TEXT, 'dnd5e', { mock: true });
    assert.ok(Array.isArray(result.conditions), 'conditions must be an array');
    assert.equal(result.conditions.length, 0, 'conditions starts empty');
  });

  it('fills deathSaves with successes and failures', async () => {
    const result = await parseStatsText(SAMPLE_DND_TEXT, 'dnd5e', { mock: true });
    assert.ok(result.deathSaves, 'deathSaves must exist');
    assert.equal(result.deathSaves.successes, 0);
    assert.equal(result.deathSaves.failures, 0);
  });

  it('fills inspiration as false', async () => {
    const result = await parseStatsText(SAMPLE_DND_TEXT, 'dnd5e', { mock: true });
    assert.equal(result.inspiration, false);
  });

  it('fills resistances, vulnerabilities, immunities as empty arrays', async () => {
    const result = await parseStatsText(SAMPLE_DND_TEXT, 'dnd5e', { mock: true });
    assert.ok(Array.isArray(result.resistances));
    assert.ok(Array.isArray(result.vulnerabilities));
    assert.ok(Array.isArray(result.immunities));
  });

  it('fills concentrating as null', async () => {
    const result = await parseStatsText(SAMPLE_DND_TEXT, 'dnd5e', { mock: true });
    assert.equal(result.concentrating, null);
  });

  it('speed defaults to 30 when not in mock override', async () => {
    const result = await parseStatsText(SAMPLE_DND_TEXT, 'dnd5e', { mock: true });
    assert.equal(typeof result.speed, 'number');
    // mock explicitly sets 30
    assert.equal(result.speed, 30);
  });
});

describe('Schema defaults — RuneQuest', () => {
  it('fills conditions array', async () => {
    const result = await parseStatsText(SAMPLE_RQ_TEXT, 'runequest', { mock: true });
    assert.ok(Array.isArray(result.conditions));
    assert.equal(result.conditions.length, 0);
  });

  it('fills runeSpells as empty array when absent', async () => {
    const result = await parseStatsText(SAMPLE_RQ_TEXT, 'runequest', { mock: true });
    // mock sets runeSpells: [], default also sets [] — either way must be array
    assert.ok(Array.isArray(result.runeSpells));
  });

  it('fills spiritSpells as array', async () => {
    const result = await parseStatsText(SAMPLE_RQ_TEXT, 'runequest', { mock: true });
    assert.ok(Array.isArray(result.spiritSpells));
  });

  it('fills skills as object', async () => {
    const result = await parseStatsText(SAMPLE_RQ_TEXT, 'runequest', { mock: true });
    assert.ok(result.skills !== null && typeof result.skills === 'object' && !Array.isArray(result.skills));
  });
});

// ---------------------------------------------------------------------------
// buildPrompt
// ---------------------------------------------------------------------------

describe('buildPrompt', () => {
  it('returns a string', () => {
    const p = buildPrompt('STR 16', 'dnd5e');
    assert.equal(typeof p, 'string');
  });

  it('contains the statsText verbatim', () => {
    const text = 'STR 16 DEX 12 CON 14';
    const p = buildPrompt(text, 'dnd5e');
    assert.ok(p.includes(text), 'prompt must contain the original statsText');
  });

  it('contains schema keys for dnd5e', () => {
    const p = buildPrompt('dummy', 'dnd5e');
    assert.ok(p.includes('abilities'), 'prompt must contain "abilities"');
    assert.ok(p.includes('proficiencyBonus'), 'prompt must contain "proficiencyBonus"');
    assert.ok(p.includes('spellSlots'), 'prompt must contain "spellSlots"');
  });

  it('contains schema keys for runequest', () => {
    const p = buildPrompt('dummy', 'runequest');
    assert.ok(p.includes('characteristics'), 'prompt must contain "characteristics"');
    assert.ok(p.includes('hitLocations'), 'prompt must contain "hitLocations"');
    assert.ok(p.includes('runePoints'), 'prompt must contain "runePoints"');
  });

  it('instructs for ONLY valid JSON with no markdown fences', () => {
    const p = buildPrompt('dummy', 'dnd5e');
    assert.ok(p.toLowerCase().includes('json'), 'prompt must mention JSON');
    assert.ok(p.toLowerCase().includes('no markdown'), 'prompt must say no markdown');
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('parseStatsText — input validation', () => {
  it('throws TypeError on non-string statsText', async () => {
    await assert.rejects(() => parseStatsText(null, 'dnd5e', { mock: true }), TypeError);
    await assert.rejects(() => parseStatsText(42, 'dnd5e', { mock: true }), TypeError);
  });

  it('throws TypeError on unknown system', async () => {
    await assert.rejects(() => parseStatsText('text', 'pathfinder', { mock: true }), TypeError);
  });

  it('throws Error in real mode without anthropic client', async () => {
    await assert.rejects(() => parseStatsText('text', 'dnd5e', {}), Error);
  });
});
