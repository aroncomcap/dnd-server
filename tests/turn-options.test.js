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

test('retargets unnamed second-person options after a different actor just moved', () => {
  assert.ok(fs.existsSync(modulePath), 'turn-options.js should exist');
  const { sanitizeOptionsForPlayer } = require(modulePath);
  const partyNames = ['Sir Aldren Vale', 'Vesper Quill'];
  const staleOptions = [
    '🗡️ Follow the blue-footprint claw through the frost trail, striking with Hex’s lingering spite.',
    '🛡️ Brace and steady your footing, keeping your cursed shadow in sight.',
    '🔥 Tear at the hex’s misbound curse and bait the blue presence back toward you.',
  ];

  const result = sanitizeOptionsForPlayer(staleOptions, 'Sir Aldren Vale', partyNames, {
    previousPlayer: 'Vesper Quill',
  });

  assert.equal(result.retargeted, true);
  assert.equal(result.options.length, 3);
  for (const option of result.options) {
    assert.match(option, /Aldren/i);
    assert.doesNotMatch(option, /Vesper|Hex|cursed shadow/i);
  }
});

test('fallback options prefer character standard actions over generic prompts', () => {
  assert.ok(fs.existsSync(modulePath), 'turn-options.js should exist');
  const { buildFallbackOptionsForPlayer } = require(modulePath);

  const options = buildFallbackOptionsForPlayer('Sister Elowen Vale', {
    character: {
      standardActions: 'Cast bless, Cast cure wounds, Cast pass without trace, Cast silence, Cast spirit guardians, Attack with mace, Use Channel Divinity: Invoke Duplicity, Use Channel Divinity: Turn Undead, Dodge, Help ally',
    },
  });

  assert.equal(options.length, 3);
  assert.match(options.join('\n'), /Elowen/i);
  assert.match(options.join('\n'), /Cast bless|Cast cure wounds|Cast pass without trace|Cast silence|Cast spirit guardians|Attack with mace|Channel Divinity|Dodge|Help ally/);
  assert.doesNotMatch(options.join('\n'), /scene's strange details|immediate danger|takes point/i);
});

test('combat fallback options exclude travel and exploration standard actions', () => {
  assert.ok(fs.existsSync(modulePath), 'turn-options.js should exist');
  const { buildFallbackOptionsForPlayer } = require(modulePath);

  const options = buildFallbackOptionsForPlayer('Garrick Moorland', {
    inCombat: true,
    nearestEnemy: { name: 'Cult acolytes', type: 'Enemy', hp: 15, maxHp: 22 },
    character: {
      standardActions: 'Press forward cautiously, Search the scene for useful details, Move on toward the objective, Attack with rapier, Dodge, Help ally',
    },
  });

  assert.equal(options.length, 3);
  assert.match(options.join('\n'), /Attack Cult acolytes with rapier|Dodge|Disengage from Cult acolytes/);
  assert.doesNotMatch(options.join('\n'), /Help ally|Help an exposed ally|Press forward|Search the scene|Move on toward|scene's strange details/i);
});
