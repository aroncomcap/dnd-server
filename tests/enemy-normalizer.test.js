'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isPlaceholderEnemyName,
  normalizeEnemyEntry,
  normalizeEnemyEntries,
} = require('../enemy-normalizer');

test('placeholder enemy names are rejected before combat initialization', () => {
  assert.equal(isPlaceholderEnemyName('None'), true);
  assert.equal(isPlaceholderEnemyName('no enemies'), true);
  assert.equal(isPlaceholderEnemyName('N/A'), true);
  assert.equal(isPlaceholderEnemyName('Goblin'), false);
});

test('normalizeEnemyEntry returns null for placeholder ENEMIES rows', () => {
  assert.equal(normalizeEnemyEntry({ displayName: 'None', count: 1, slug: 'none' }), null);
  assert.equal(normalizeEnemyEntry({ displayName: 'No enemies', count: 1, slug: 'custom' }), null);
});

test('normalizeEnemyEntries preserves concrete custom enemies', () => {
  const enemies = normalizeEnemyEntries([
    { displayName: 'Merchant Guild Guardpost', count: 1, slug: 'custom' },
    { displayName: 'None', count: 1, slug: 'none' },
  ]);

  assert.deepEqual(enemies, [{
    displayName: 'Merchant Guild Guardpost',
    count: 1,
    slug: 'merchant-guild-guardpost',
    hint: 'Merchant Guild Guardpost',
  }]);
});
