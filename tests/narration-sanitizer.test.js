const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const modulePath = path.join(__dirname, '..', 'narration-sanitizer.js');

test('removes bogus hit text from non-damage spell narration', () => {
  assert.ok(fs.existsSync(modulePath), 'narration-sanitizer.js should exist');
  const { cleanInvalidCombatNarration } = require(modulePath);

  const cleaned = cleanInvalidCombatNarration(
    'Vesper Quill casts hex — rolls —, HIT! No immediate damage. The curse settles.'
  );

  assert.equal(cleaned, 'Vesper Quill casts hex. No immediate damage. The curse settles.');
});

test('removes unknown combat placeholder lines', () => {
  assert.ok(fs.existsSync(modulePath), 'narration-sanitizer.js should exist');
  const { cleanInvalidCombatNarration } = require(modulePath);

  const cleaned = cleanInvalidCombatNarration(
    'Fleeing Presence Claw — rolls unknown. HIT/MISS! Damage unknown. target unknown The blue-lit thing streaks on.'
  );

  assert.equal(cleaned, 'Fleeing Presence Claw. The blue-lit thing streaks on.');
});
