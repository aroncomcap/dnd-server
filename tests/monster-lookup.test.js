'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getMonsterStats, loadDefaultMonsters } = require('../monster-lookup.js');

// ---------------------------------------------------------------------------
// loadDefaultMonsters — D&D 5e
// ---------------------------------------------------------------------------
describe('loadDefaultMonsters (dnd5e)', () => {
  it('returns an object keyed by slug', () => {
    const monsters = loadDefaultMonsters('dnd5e');
    assert.strictEqual(typeof monsters, 'object');
    assert.ok(Object.keys(monsters).length > 0, 'should have entries');
  });

  it('contains "goblin" with correct stats', () => {
    const monsters = loadDefaultMonsters('dnd5e');
    assert.ok(monsters.goblin, 'goblin key should exist');
    const g = monsters.goblin;
    assert.strictEqual(g.name, 'Goblin');
    assert.strictEqual(g.cr, 0.25);
    assert.strictEqual(g.ac, 15);
    assert.strictEqual(g.hp, 7);
    assert.strictEqual(g.maxHp, 7);
    assert.strictEqual(g.speed, 30);
    assert.strictEqual(g.abilities.dex, 14);
    assert.ok(Array.isArray(g.weapons), 'weapons should be an array');
    assert.ok(g.weapons.length > 0, 'should have at least one weapon');
    assert.ok(Array.isArray(g.features), 'features should be an array');
    assert.ok(g.features.includes('Nimble Escape'));
  });

  it('has correct schema fields on goblin', () => {
    const g = loadDefaultMonsters('dnd5e').goblin;
    const required = ['name', 'cr', 'ac', 'hp', 'maxHp', 'speed', 'abilities', 'saveProficiencies',
      'proficiencyBonus', 'weapons', 'spells', 'spellSlots', 'features',
      'conditions', 'resistances', 'vulnerabilities', 'immunities'];
    for (const field of required) {
      assert.ok(field in g, `goblin should have field: ${field}`);
    }
  });

  it('result is cached — same object reference on second call', () => {
    const a = loadDefaultMonsters('dnd5e');
    const b = loadDefaultMonsters('dnd5e');
    assert.strictEqual(a, b, 'should return same cached object');
  });

  it('contains all 20 expected monsters', () => {
    const monsters = loadDefaultMonsters('dnd5e');
    const expected = [
      'goblin', 'skeleton', 'zombie', 'orc', 'kobold', 'wolf', 'dire-wolf', 'bandit',
      'bugbear', 'ogre', 'troll', 'owlbear', 'giant-spider', 'ghoul', 'wight',
      'mimic', 'basilisk', 'manticore', 'young-green-dragon', 'adult-red-dragon',
    ];
    for (const slug of expected) {
      assert.ok(monsters[slug], `missing monster: ${slug}`);
    }
  });
});

// ---------------------------------------------------------------------------
// loadDefaultMonsters — RuneQuest
// ---------------------------------------------------------------------------
describe('loadDefaultMonsters (runequest)', () => {
  it('returns an object keyed by slug', () => {
    const monsters = loadDefaultMonsters('runequest');
    assert.strictEqual(typeof monsters, 'object');
    assert.ok(Object.keys(monsters).length > 0, 'should have entries');
  });

  it('contains "broo" with correct RQ schema', () => {
    const monsters = loadDefaultMonsters('runequest');
    assert.ok(monsters.broo, 'broo key should exist');
    const b = monsters.broo;
    assert.strictEqual(b.name, 'Broo');
    assert.ok(b.characteristics, 'should have characteristics');
    assert.strictEqual(typeof b.characteristics.str, 'number');
    assert.strictEqual(typeof b.characteristics.pow, 'number');
    assert.ok(b.hitLocations, 'should have hitLocations');
    assert.ok(b.hitLocations.head, 'should have head hit location');
    assert.ok('hp' in b.hitLocations.head);
    assert.ok('maxHp' in b.hitLocations.head);
    assert.ok('armor' in b.hitLocations.head);
    assert.strictEqual(typeof b.totalHp, 'number');
    assert.ok(Array.isArray(b.weapons));
    assert.ok(typeof b.strikeRank === 'number');
    assert.ok(Array.isArray(b.runeSpells));
    assert.ok(Array.isArray(b.spiritSpells));
  });

  it('has all 10 expected RQ creatures', () => {
    const monsters = loadDefaultMonsters('runequest');
    const expected = [
      'broo', 'dark-troll', 'scorpion-man', 'jack-o-bear', 'walktapus',
      'giant-beetle', 'saber-tooth-cat', 'griffin', 'centaur', 'minotaur',
    ];
    for (const slug of expected) {
      assert.ok(monsters[slug], `missing RQ creature: ${slug}`);
    }
  });
});

// ---------------------------------------------------------------------------
// getMonsterStats — skipDB mode (no real DB needed)
// ---------------------------------------------------------------------------
describe('getMonsterStats with skipDB', () => {
  it('finds goblin in 5e defaults', async () => {
    const result = await getMonsterStats('game-1', 'dnd5e', 'goblin', { skipDB: true, skipAI: true });
    assert.ok(result, 'should return monster data');
    assert.strictEqual(result.name, 'Goblin');
    assert.strictEqual(result.cr, 0.25);
  });

  it('finds broo in runequest defaults', async () => {
    const result = await getMonsterStats('game-1', 'runequest', 'broo', { skipDB: true, skipAI: true });
    assert.ok(result, 'should return monster data');
    assert.strictEqual(result.name, 'Broo');
    assert.ok(result.characteristics);
  });

  it('returns null for unknown monster when skipDB and skipAI', async () => {
    const result = await getMonsterStats('game-1', 'dnd5e', 'purple-worm-of-doom', { skipDB: true, skipAI: true });
    assert.strictEqual(result, null);
  });

  it('returns null for unknown system when skipDB and skipAI', async () => {
    const result = await getMonsterStats('game-1', 'pathfinder2e', 'goblin', { skipDB: true, skipAI: true });
    assert.strictEqual(result, null);
  });

  it('returns dragon from defaults', async () => {
    const result = await getMonsterStats('game-1', 'dnd5e', 'adult-red-dragon', { skipDB: true, skipAI: true });
    assert.ok(result, 'should return adult red dragon');
    assert.strictEqual(result.cr, 17);
    assert.ok(result.hp > 200, 'adult red dragon should have many hp');
  });
});

// ---------------------------------------------------------------------------
// loadDefaultMonsters — error handling
// ---------------------------------------------------------------------------
describe('loadDefaultMonsters error handling', () => {
  it('throws for unknown system', () => {
    assert.throws(
      () => loadDefaultMonsters('unknown-system'),
      (err) => {
        assert.ok(err.message.includes('Unknown system'));
        return true;
      }
    );
  });
});
