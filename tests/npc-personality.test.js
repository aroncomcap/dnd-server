const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('monster personality data', () => {
  const monsters = require('../monsters/monsters-5e-srd.json');

  it('all monsters have personality field', () => {
    for (const [slug, m] of Object.entries(monsters)) {
      assert.ok(m.personality, `${slug} missing personality`);
      assert.ok(m.personality.length > 10, `${slug} personality too short: "${m.personality}"`);
    }
  });

  it('all monsters have combatStyle field', () => {
    const validStyles = ['aggressive', 'defensive', 'ranged-ambush', 'hit-and-run', 'pack-tactics', 'spellcaster', 'brute', 'berserker', 'tactical', 'support', 'mindless'];
    for (const [slug, m] of Object.entries(monsters)) {
      assert.ok(m.combatStyle, `${slug} missing combatStyle`);
      assert.ok(validStyles.includes(m.combatStyle), `${slug} invalid combatStyle: ${m.combatStyle}`);
    }
  });

  it('all monsters have tactics field', () => {
    for (const [slug, m] of Object.entries(monsters)) {
      assert.ok(m.tactics, `${slug} missing tactics`);
    }
  });

  it('all monsters have morale field', () => {
    const validMorale = ['fanatical', 'brave', 'normal', 'cowardly'];
    for (const [slug, m] of Object.entries(monsters)) {
      assert.ok(m.morale, `${slug} missing morale`);
      assert.ok(validMorale.includes(m.morale), `${slug} invalid morale: ${m.morale}`);
    }
  });

  it('undead have fanatical morale', () => {
    const undead = ['skeleton', 'zombie', 'ghoul', 'wight', 'specter', 'shadow'];
    for (const slug of undead) {
      if (monsters[slug]) {
        assert.strictEqual(monsters[slug].morale, 'fanatical', `${slug} should be fanatical`);
      }
    }
  });
});

describe('RuneQuest monster personality data', () => {
  const rqMonsters = require('../monsters/monsters-rq-core.json');

  it('all RQ monsters have personality field', () => {
    for (const [slug, m] of Object.entries(rqMonsters)) {
      assert.ok(m.personality, `${slug} missing personality`);
      assert.ok(m.personality.length > 10, `${slug} personality too short: "${m.personality}"`);
    }
  });

  it('all RQ monsters have combatStyle field', () => {
    const validStyles = ['aggressive', 'defensive', 'ranged-ambush', 'hit-and-run', 'pack-tactics', 'spellcaster', 'brute', 'berserker', 'tactical', 'support', 'mindless'];
    for (const [slug, m] of Object.entries(rqMonsters)) {
      assert.ok(m.combatStyle, `${slug} missing combatStyle`);
      assert.ok(validStyles.includes(m.combatStyle), `${slug} invalid combatStyle: ${m.combatStyle}`);
    }
  });

  it('all RQ monsters have tactics field', () => {
    for (const [slug, m] of Object.entries(rqMonsters)) {
      assert.ok(m.tactics, `${slug} missing tactics`);
    }
  });

  it('all RQ monsters have morale field', () => {
    const validMorale = ['fanatical', 'brave', 'normal', 'cowardly'];
    for (const [slug, m] of Object.entries(rqMonsters)) {
      assert.ok(m.morale, `${slug} missing morale`);
      assert.ok(validMorale.includes(m.morale), `${slug} invalid morale: ${m.morale}`);
    }
  });
});
