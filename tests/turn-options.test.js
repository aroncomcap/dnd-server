const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const modulePath = path.join(__dirname, '..', 'turn-options.js');

test('retargets stale options that name a different party member', () => {
  assert.ok(fs.existsSync(modulePath), 'turn-options.js should exist');
  const { sanitizeOptionsForPlayer } = require(modulePath);
  const partyNames = ['Brannic Ashforge', 'Sister Elowen Vale', 'Tamsin Quickstep', 'Kael Voss'];
  const staleOptions = [
    '🗡️ Tamsin strides into the crypt entrance and attacks any remaining threat in the mist.',
    '🛡️ Tamsin stays on the front line, blocking the doorway and watching for a counterattack.',
    '🔥 Tamsin whirls her blade and uses the silver chain to snap shut the passage.',
  ];

  const result = sanitizeOptionsForPlayer(staleOptions, 'Kael Voss', partyNames);

  assert.equal(result.retargeted, true);
  assert.equal(result.options.length, 3);
  for (const option of result.options) {
    assert.match(option, /Kael/i);
    assert.doesNotMatch(option, /Tamsin/i);
  }
});

test('keeps options that are already generic or targeted to the current player', () => {
  assert.ok(fs.existsSync(modulePath), 'turn-options.js should exist');
  const { sanitizeOptionsForPlayer } = require(modulePath);
  const partyNames = ['Tamsin Quickstep', 'Kael Voss'];
  const options = [
    '🗡️ Kael Voss checks the crypt entrance for hidden danger.',
    '🛡️ Regroup and make sure the party is safe.',
    '🔥 Use the strange silver chain to test the lingering mist.',
  ];

  const result = sanitizeOptionsForPlayer(options, 'Kael Voss', partyNames);

  assert.equal(result.retargeted, false);
  assert.deepEqual(result.options, options);
});
