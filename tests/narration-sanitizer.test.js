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

test('removes leaked inline options even when the third option is omitted', () => {
  assert.ok(fs.existsSync(modulePath), 'narration-sanitizer.js should exist');
  const { cleanInvalidCombatNarration } = require(modulePath);

  const cleaned = cleanInvalidCombatNarration(
    'Below the quay, something scrapes hard against stone. 1️⃣ Rush the stair before Sable moves 2️⃣ Force the woman to answer for Sable'
  );

  assert.equal(cleaned, 'Below the quay, something scrapes hard against stone.');
  assert.doesNotMatch(cleaned, /1️⃣|2️⃣|Rush the stair|Force the woman/);
});

test('removes malformed structured marker tails from visible narration', () => {
  assert.ok(fs.existsSync(modulePath), 'narration-sanitizer.js should exist');
  const { cleanInvalidCombatNarration } = require(modulePath);

  const cleaned = cleanInvalidCombatNarration(
    'The foreman sees the proof and reaches for the ledger. ENEMIES: 3 dockhands draw blades and close on the party. OPTIONS---'
  );

  assert.equal(cleaned, 'The foreman sees the proof and reaches for the ledger.');
  assert.doesNotMatch(cleaned, /OPTIONS---|ENEMIES:/);
});

test('removes inline scene fields from visible narration', () => {
  assert.ok(fs.existsSync(modulePath), 'narration-sanitizer.js should exist');
  const { cleanInvalidCombatNarration } = require(modulePath);

  const cleaned = cleanInvalidCombatNarration(
    'The ledger room erupts as the proof lands. Action: Garrick enters the ledger room Mood: tense NPC: Dockmaster Venn'
  );

  assert.equal(cleaned, 'The ledger room erupts as the proof lands.');
  assert.doesNotMatch(cleaned, /Action:|Mood:|NPC:/);
});

test('removes bare options marker tail from visible narration', () => {
  assert.ok(fs.existsSync(modulePath), 'narration-sanitizer.js should exist');
  const { cleanInvalidCombatNarration } = require(modulePath);

  const cleaned = cleanInvalidCombatNarration('The runner freezes with the manifest in hand. OPTIONS');

  assert.equal(cleaned, 'The runner freezes with the manifest in hand.');
  assert.doesNotMatch(cleaned, /\bOPTIONS\b/);
});

test('removes unsourced noncombat check result labels while preserving consequences', () => {
  assert.ok(fs.existsSync(modulePath), 'narration-sanitizer.js should exist');
  const { cleanInvalidCombatNarration } = require(modulePath);

  const cleaned = cleanInvalidCombatNarration(
    'Strength check succeeds — Merren is restrained in place. Social pressure lands — the boatman hesitates. Improvised grapple fails — Merren cannot break Kael’s hold. DEX contest implied — Theren gets aboard. NO ROLL — pressure forces a confession. No roll this turn. INTIMIDATION/CHALLENGE — the lead is forced into the open.'
  );

  assert.equal(cleaned, 'Merren is restrained in place. The boatman hesitates. Merren cannot break Kael’s hold. Theren gets aboard. Pressure forces a confession. The lead is forced into the open.');
  assert.doesNotMatch(cleaned, /check succeeds|pressure lands|grapple fails|DEX contest implied|NO ROLL|No roll this turn|INTIMIDATION\/CHALLENGE/i);
});

test('removes unsourced save-needed labels while preserving the narrated consequence', () => {
  assert.ok(fs.existsSync(modulePath), 'narration-sanitizer.js should exist');
  const { cleanInvalidCombatNarration } = require(modulePath);

  const cleaned = cleanInvalidCombatNarration(
    'Seln hurls the ledger toward the lantern. Dex save needed — the lantern tips toward spilled tar-paper notes.'
  );

  assert.equal(cleaned, 'Seln hurls the ledger toward the lantern. The lantern tips toward spilled tar-paper notes.');
  assert.doesNotMatch(cleaned, /Dex save needed/i);
});
