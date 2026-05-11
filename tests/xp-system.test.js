const assert = require('node:assert/strict');
const test = require('node:test');

const {
  awardCombatXP,
  calculateEncounterXP,
  getMonsterXP,
} = require('../xp-system');

test('monster CR values use standard encounter XP', () => {
  assert.equal(typeof getMonsterXP, 'function');
  assert.equal(getMonsterXP({ name: 'Goblin', cr: 0.25 }), 50);
  assert.equal(getMonsterXP({ name: 'Skeleton', cr: '1/4' }), 50);
  assert.equal(getMonsterXP({ name: 'Orc', challengeRating: '1/2' }), 100);
});

test('encounter XP counts defeated enemies only', () => {
  assert.equal(typeof calculateEncounterXP, 'function');

  const combatants = {
    lysa: { name: 'Lysa', type: 'PC', hp: 6, cr: 3 },
    goblin: { name: 'Goblin', type: 'Enemy', hp: 0, cr: '1/4' },
    skeleton: { name: 'Skeleton', type: 'Enemy', totalHp: 0, cr: 0.25 },
    fleeingOrc: { name: 'Orc', type: 'Enemy', hp: 2, cr: 0.5 },
  };

  const result = calculateEncounterXP(combatants);

  assert.equal(result.totalXP, 100);
  assert.deepEqual(result.defeated.map(enemy => enemy.name), ['Goblin', 'Skeleton']);
});

test('combat XP is split across the party and updates level data', () => {
  assert.equal(typeof awardCombatXP, 'function');

  const gameState = {
    data: {
      characters: {
        Alara: {
          xp: 250,
          level: 1,
          combatStats: { level: 1, hp: 10 },
          statsText: 'Level 1 Fighter\nHP 10\nAC 16',
        },
        Brindle: {
          xp: 250,
          level: 1,
          combatStats: { level: 1, hp: 8 },
          statsText: 'Level 1 Wizard\nHP 8\nAC 12',
        },
      },
    },
  };
  const combatants = {
    goblin1: { name: 'Goblin 1', type: 'Enemy', hp: 0, cr: '1/4' },
    goblin2: { name: 'Goblin 2', type: 'Enemy', hp: 0, cr: '1/4' },
    goblin3: { name: 'Goblin 3', type: 'Enemy', hp: 0, cr: '1/4' },
    goblin4: { name: 'Goblin 4', type: 'Enemy', hp: 0, cr: '1/4' },
    goblin5: { name: 'Goblin 5', type: 'Enemy', hp: 0, cr: '1/4' },
    goblin6: { name: 'Goblin 6', type: 'Enemy', hp: 0, cr: '1/4' },
  };

  const award = awardCombatXP(gameState, combatants);

  assert.equal(award.totalXP, 300);
  assert.equal(award.xpPerCharacter, 150);
  assert.deepEqual(award.defeated.map(enemy => enemy.name), [
    'Goblin 1',
    'Goblin 2',
    'Goblin 3',
    'Goblin 4',
    'Goblin 5',
    'Goblin 6',
  ]);
  assert.equal(gameState.data.characters.Alara.xp, 400);
  assert.equal(gameState.data.characters.Alara.level, 2);
  assert.equal(gameState.data.characters.Alara.combatStats.level, 2);
  assert.equal(gameState.data.characters.Brindle.xp, 400);
  assert.equal(gameState.data.characters.Brindle.level, 2);
  assert.equal(gameState.data.characters.Brindle.combatStats.level, 2);
  assert.deepEqual(award.results.map(result => ({
    character: result.character,
    xpGained: result.xpGained,
    leveledUp: result.leveledUp,
    newLevel: result.newLevel,
  })), [
    { character: 'Alara', xpGained: 150, leveledUp: true, newLevel: 2 },
    { character: 'Brindle', xpGained: 150, leveledUp: true, newLevel: 2 },
  ]);
});
