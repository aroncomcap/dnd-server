const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const gameHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'game.html'), 'utf8');

test('game navigation binding is invoked', () => {
  const navBlock = gameHtml.match(/\/\/ ── Navigation[\s\S]*?\/\/ ── Player name persistence/);
  assert.ok(navBlock, 'navigation script block should exist');
  assert.match(navBlock[0], /\}\)\(\);\s*\/\/ ── Player name persistence/, 'navigation setup IIFE must be invoked');
});
