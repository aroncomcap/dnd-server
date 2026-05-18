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

test('removes hit or miss text from healing and support actions', () => {
  assert.ok(fs.existsSync(modulePath), 'narration-sanitizer.js should exist');
  const { cleanInvalidCombatNarration } = require(modulePath);

  const cleaned = cleanInvalidCombatNarration(
    'Sister Elowen casts Cure Wounds — rolls 17. HIT! Mirek regains 6 hit points.'
  );

  assert.doesNotMatch(cleaned, /\bHIT\b|\bMISS\b/);
  assert.doesNotMatch(cleaned, /rolls 17/);
  assert.match(cleaned, /Mirek regains 6 hit points/);
});

test('removes unknown combat placeholder lines', () => {
  assert.ok(fs.existsSync(modulePath), 'narration-sanitizer.js should exist');
  const { cleanInvalidCombatNarration } = require(modulePath);

  const cleaned = cleanInvalidCombatNarration(
    'Fleeing Presence Claw — rolls unknown. HIT/MISS! Damage unknown. target unknown The blue-lit thing streaks on.'
  );

  assert.equal(cleaned, 'Fleeing Presence Claw. The blue-lit thing streaks on.');
});

test('removes unresolved dice placeholders from exploration narration', () => {
  assert.ok(fs.existsSync(modulePath), 'narration-sanitizer.js should exist');
  const { cleanInvalidCombatNarration } = require(modulePath);

  const cleaned = cleanInvalidCombatNarration(
    'The shed floor is streaked with ink. 1d20+? The evidence says Joss was here recently. 1d20 + ? A second path heads toward the waterline.'
  );

  assert.equal(cleaned, 'The shed floor is streaked with ink. The evidence says Joss was here recently. A second path heads toward the waterline.');
  assert.doesNotMatch(cleaned, /1d20|\?/);
});

test('removes leaked inline action options from combat narration', () => {
  assert.ok(fs.existsSync(modulePath), 'narration-sanitizer.js should exist');
  const { cleanInvalidCombatNarration } = require(modulePath);

  const cleaned = cleanInvalidCombatNarration(
    'Sneak Attack 1d6: Thorne’s strike lands. 1️⃣ Attack the unknown beast 2️⃣ Cast a healing or protective spell 3️⃣ Hold position and watch for openings.'
  );

  assert.equal(cleaned, 'Sneak Attack 1d6: Thorne’s strike lands.');
  assert.doesNotMatch(cleaned, /1️⃣|2️⃣|3️⃣|Attack the unknown beast|Cast a healing or protective spell|Hold position/);
});

test('removes unsourced noncombat check result labels while preserving consequences', () => {
  assert.ok(fs.existsSync(modulePath), 'narration-sanitizer.js should exist');
  const { cleanInvalidCombatNarration } = require(modulePath);

  const cleaned = cleanInvalidCombatNarration(
    'Strength check succeeds — Merren is restrained in place. Social pressure lands — the boatman hesitates. Improvised grapple fails — Merren cannot break Kael’s hold.'
  );

  assert.equal(cleaned, 'Merren is restrained in place. The boatman hesitates. Merren cannot break Kael’s hold.');
  assert.doesNotMatch(cleaned, /check succeeds|pressure lands|grapple fails/i);
});
