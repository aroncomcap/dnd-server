const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const gameHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'game.html'), 'utf8');
const gameActionTs = fs.readFileSync(path.join(__dirname, 'e2e', 'game-action.ts'), 'utf8');

test('game navigation binding is invoked', () => {
  const navBlock = gameHtml.match(/\/\/ ── Navigation[\s\S]*?\/\/ ── Player name persistence/);
  assert.ok(navBlock, 'navigation script block should exist');
  assert.match(navBlock[0], /\}\)\(\);\s*\/\/ ── Player name persistence/, 'navigation setup IIFE must be invoked');
});

test('DM rendering strips structured marker blocks before display', () => {
  assert.match(gameHtml, /function stripStructuredBlocksFromNarration\(text\)/, 'structured block sanitizer should exist');
  assert.match(gameHtml, /let cleaned = stripStructuredBlocksFromNarration\(text\)/, 'renderDmText should sanitize all DM text');
  assert.match(gameHtml, /const narration = stripStructuredBlocksFromNarration\(data\.narration \|\| body\.textContent \|\| ''\)/, 'stream end should sanitize fallback text');
});

test('E2E action waiter requires a new completed DM message', () => {
  assert.match(gameActionTs, /return completedDmCount > before;/, 'waitForActionResponse should require a new completed DM message');
  assert.doesNotMatch(gameActionTs, /completedDmCount > before\s*\|\|/, 'idle send button should not count as an action response');
});
