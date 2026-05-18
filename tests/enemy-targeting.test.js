const assert = require('node:assert/strict');
const test = require('node:test');

const { chooseEnemyTargetId, resolveEnemyDecisionTarget } = require('../enemy-targeting');

test('enemy target selection ignores downed PCs', () => {
  const targetId = chooseEnemyTargetId([
    { id: 'elira', name: 'Elira', hp: 0, maxHp: 8 },
    { id: 'seraphine', name: 'Seraphine', hp: 2, maxHp: 9 },
  ]);

  assert.equal(targetId, 'seraphine');
});

test('stale enemy decisions retarget when the chosen PC is no longer alive', () => {
  const targetId = resolveEnemyDecisionTarget('elira', [
    { id: 'elira', name: 'Elira', hp: 0, maxHp: 8 },
    { id: 'seraphine', name: 'Seraphine', hp: 2, maxHp: 9 },
  ]);

  assert.equal(targetId, 'seraphine');
});

test('fresh enemy decisions keep the chosen living target', () => {
  const targetId = resolveEnemyDecisionTarget('elira', [
    { id: 'elira', name: 'Elira', hp: 4, maxHp: 8 },
    { id: 'seraphine', name: 'Seraphine', hp: 2, maxHp: 9 },
  ]);

  assert.equal(targetId, 'elira');
});
