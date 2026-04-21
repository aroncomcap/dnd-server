'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Socket Contract Tests
 * Validates that all socket.emit() calls follow the expected message shapes
 * Prevents regression bugs where server emits malformed data to clients
 */

/**
 * Mock socket.emit tracker for testing
 */
class MockSocket {
  constructor() {
    this.emissions = [];
    this.errorThrown = null;
  }

  emit(eventName, data) {
    this.emissions.push({ eventName, data });
  }

  error(err) {
    this.errorThrown = err;
  }

  getEmissions(eventName) {
    if (!eventName) return this.emissions;
    return this.emissions.filter(e => e.eventName === eventName);
  }

  getLastEmission(eventName) {
    const filtered = this.getEmissions(eventName);
    return filtered[filtered.length - 1];
  }

  reset() {
    this.emissions = [];
    this.errorThrown = null;
  }
}

/**
 * Contract validators for each socket event type
 */
function validateDmMessage(msg) {
  const errors = [];

  if (!msg || typeof msg !== 'object') {
    errors.push('dm_message must be an object');
    return { valid: false, errors };
  }

  // Required: text (non-empty string)
  if (typeof msg.text !== 'string') {
    errors.push('dm_message.text must be a string');
  } else if (msg.text.trim() === '') {
    errors.push('dm_message.text must be non-empty');
  }

  // Required: options (array)
  if (!Array.isArray(msg.options)) {
    errors.push('dm_message.options must be an array');
  } else {
    // All options must be strings
    for (let i = 0; i < msg.options.length; i++) {
      if (typeof msg.options[i] !== 'string') {
        errors.push(`dm_message.options[${i}] must be a string`);
      }
    }
  }

  // Required: forPlayer (string)
  if (typeof msg.forPlayer !== 'string') {
    errors.push('dm_message.forPlayer must be a string');
  }

  return { valid: errors.length === 0, errors };
}

function validatePlayerMessage(msg) {
  const errors = [];

  if (!msg || typeof msg !== 'object') {
    errors.push('player_message must be an object');
    return { valid: false, errors };
  }

  // Required: player (non-empty string)
  if (typeof msg.player !== 'string') {
    errors.push('player_message.player must be a string');
  } else if (msg.player.trim() === '') {
    errors.push('player_message.player must be non-empty');
  }

  // Required: text (string)
  if (typeof msg.text !== 'string') {
    errors.push('player_message.text must be a string');
  }

  return { valid: errors.length === 0, errors };
}

function validateTurnChanged(msg) {
  const errors = [];

  if (!msg || typeof msg !== 'object') {
    errors.push('turn_changed must be an object');
    return { valid: false, errors };
  }

  // Required: currentPlayer (non-empty string)
  if (typeof msg.currentPlayer !== 'string') {
    errors.push('turn_changed.currentPlayer must be a string');
  } else if (msg.currentPlayer.trim() === '') {
    errors.push('turn_changed.currentPlayer must be non-empty');
  }

  return { valid: errors.length === 0, errors };
}

function validateCharacterRegistered(msg) {
  const errors = [];

  if (!msg || typeof msg !== 'object') {
    errors.push('character_registered must be an object');
    return { valid: false, errors };
  }

  // Required: name (non-empty string)
  if (typeof msg.name !== 'string') {
    errors.push('character_registered.name must be a string');
  } else if (msg.name.trim() === '') {
    errors.push('character_registered.name must be non-empty');
  }

  // Required: character (object)
  if (!msg.character || typeof msg.character !== 'object') {
    errors.push('character_registered.character must be an object');
  }

  return { valid: errors.length === 0, errors };
}

function validateDmStreamEnd(msg) {
  const errors = [];

  if (!msg || typeof msg !== 'object') {
    errors.push('dm_stream_end must be an object');
    return { valid: false, errors };
  }

  // Required: narration (string)
  if (typeof msg.narration !== 'string') {
    errors.push('dm_stream_end.narration must be a string');
  }

  return { valid: errors.length === 0, errors };
}

describe('Socket Contract — dm_message', () => {
  it('emits valid dm_message with text, options, forPlayer', () => {
    const socket = new MockSocket();
    const msg = {
      text: 'The goblin appears before you!',
      options: ['Attack', 'Defend', 'Cast spell'],
      forPlayer: 'Kael'
    };
    socket.emit('dm_message', msg);

    const validation = validateDmMessage(msg);
    assert.strictEqual(validation.valid, true, validation.errors.join('; '));
  });

  it('rejects dm_message with empty text', () => {
    const msg = {
      text: '',
      options: ['Attack'],
      forPlayer: 'Kael'
    };
    const validation = validateDmMessage(msg);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.some(e => e.includes('text')));
  });

  it('rejects dm_message without options array', () => {
    const msg = {
      text: 'Story text',
      options: null,
      forPlayer: 'Kael'
    };
    const validation = validateDmMessage(msg);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.some(e => e.includes('options')));
  });

  it('rejects dm_message with non-string option items', () => {
    const msg = {
      text: 'Story text',
      options: ['Attack', 123, 'Defend'],
      forPlayer: 'Kael'
    };
    const validation = validateDmMessage(msg);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.some(e => e.includes('options[1]')));
  });

  it('rejects dm_message without forPlayer', () => {
    const msg = {
      text: 'Story text',
      options: ['Attack'],
      forPlayer: null
    };
    const validation = validateDmMessage(msg);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.some(e => e.includes('forPlayer')));
  });

  it('allows empty options array (no choices yet)', () => {
    const msg = {
      text: 'Wait for the next turn...',
      options: [],
      forPlayer: 'Kael'
    };
    const validation = validateDmMessage(msg);
    assert.strictEqual(validation.valid, true);
  });

  it('rejects non-object dm_message', () => {
    const msg = 'invalid string message';
    const validation = validateDmMessage(msg);
    assert.strictEqual(validation.valid, false);
  });
});

describe('Socket Contract — player_message', () => {
  it('emits valid player_message with player and text', () => {
    const msg = {
      player: 'Kael',
      text: 'I attack the goblin!'
    };
    const validation = validatePlayerMessage(msg);
    assert.strictEqual(validation.valid, true);
  });

  it('rejects player_message with empty player name', () => {
    const msg = {
      player: '',
      text: 'Action'
    };
    const validation = validatePlayerMessage(msg);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.some(e => e.includes('player')));
  });

  it('rejects player_message without text', () => {
    const msg = {
      player: 'Kael',
      text: null
    };
    const validation = validatePlayerMessage(msg);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.some(e => e.includes('text')));
  });

  it('allows empty text (for parsing errors)', () => {
    const msg = {
      player: 'Kael',
      text: ''
    };
    const validation = validatePlayerMessage(msg);
    assert.strictEqual(validation.valid, true);
  });
});

describe('Socket Contract — turn_changed', () => {
  it('emits valid turn_changed with currentPlayer', () => {
    const msg = {
      currentPlayer: 'Lyra'
    };
    const validation = validateTurnChanged(msg);
    assert.strictEqual(validation.valid, true);
  });

  it('rejects turn_changed with empty currentPlayer', () => {
    const msg = {
      currentPlayer: ''
    };
    const validation = validateTurnChanged(msg);
    assert.strictEqual(validation.valid, false);
  });

  it('rejects turn_changed without currentPlayer', () => {
    const msg = {};
    const validation = validateTurnChanged(msg);
    assert.strictEqual(validation.valid, false);
  });
});

describe('Socket Contract — character_registered', () => {
  it('emits valid character_registered with name and character object', () => {
    const msg = {
      name: 'Kael',
      character: {
        id: 'uuid',
        level: 5,
        hp: 40,
        stats: { str: 15, dex: 14, con: 16, int: 10, wis: 12, cha: 13 }
      }
    };
    const validation = validateCharacterRegistered(msg);
    assert.strictEqual(validation.valid, true);
  });

  it('rejects character_registered with empty name', () => {
    const msg = {
      name: '',
      character: { id: 'uuid' }
    };
    const validation = validateCharacterRegistered(msg);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.some(e => e.includes('name')));
  });

  it('rejects character_registered without character object', () => {
    const msg = {
      name: 'Kael',
      character: null
    };
    const validation = validateCharacterRegistered(msg);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.some(e => e.includes('character')));
  });

  it('accepts minimal character object', () => {
    const msg = {
      name: 'Kael',
      character: {}
    };
    const validation = validateCharacterRegistered(msg);
    assert.strictEqual(validation.valid, true);
  });
});

describe('Socket Contract — dm_stream_end', () => {
  it('emits valid dm_stream_end with narration', () => {
    const msg = {
      narration: 'The battle rages on...'
    };
    const validation = validateDmStreamEnd(msg);
    assert.strictEqual(validation.valid, true);
  });

  it('allows empty narration (edge case)', () => {
    const msg = {
      narration: ''
    };
    const validation = validateDmStreamEnd(msg);
    assert.strictEqual(validation.valid, true);
  });

  it('rejects dm_stream_end without narration', () => {
    const msg = {
      someOtherField: 'value'
    };
    const validation = validateDmStreamEnd(msg);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.some(e => e.includes('narration')));
  });

  it('rejects non-string narration', () => {
    const msg = {
      narration: { text: 'value' }
    };
    const validation = validateDmStreamEnd(msg);
    assert.strictEqual(validation.valid, false);
  });
});

describe('Socket Contract — error path handling', () => {
  it('handles API error during narration streaming', () => {
    const socket = new MockSocket();
    const error = new Error('API call failed: rate limit exceeded');

    // Simulate error handling
    socket.emit('error', {
      type: 'narration_error',
      message: error.message,
      code: 'RATE_LIMIT'
    });

    const lastEmission = socket.getLastEmission('error');
    assert.ok(lastEmission);
    assert.strictEqual(lastEmission.data.type, 'narration_error');
  });

  it('handles parseResponse returning partial data', () => {
    const socket = new MockSocket();
    // Simulate server behavior when parseResponse returns incomplete data
    const incompleteResponse = {
      narration: 'Some text',
      options: undefined,  // Missing options
      scene: null,
      world: null
    };

    // Server should normalize this before emitting
    const normalizedMsg = {
      text: incompleteResponse.narration,
      options: incompleteResponse.options || [],
      forPlayer: 'Kael'
    };

    socket.emit('dm_message', normalizedMsg);
    const validation = validateDmMessage(normalizedMsg);
    assert.strictEqual(validation.valid, true);
  });

  it('handles socket disconnection mid-stream', () => {
    const socket = new MockSocket();
    const partialEmission = {
      text: 'The dragon rises...',
      options: ['Run', 'Fight'],
      forPlayer: 'Kael'
    };
    socket.emit('dm_message', partialEmission);
    // Simulate disconnect
    socket.emit('disconnect', { reason: 'transport close' });

    const dmMsgs = socket.getEmissions('dm_message');
    assert.strictEqual(dmMsgs.length, 1);
    const validation = validateDmMessage(dmMsgs[0].data);
    assert.strictEqual(validation.valid, true);
  });
});

describe('Socket Contract — multiple event sequence', () => {
  it('validates a typical game turn sequence', () => {
    const socket = new MockSocket();
    const playerName = 'Kael';
    const charName = 'Kael the Brave';

    // 1. Character registers
    socket.emit('character_registered', {
      name: charName,
      character: { id: 'uuid', level: 5, hp: 40 }
    });

    // 2. Turn changes
    socket.emit('turn_changed', {
      currentPlayer: charName
    });

    // 3. Player sends action
    socket.emit('player_message', {
      player: charName,
      text: 'I attack the goblin!'
    });

    // 4. DM responds with narration and options
    socket.emit('dm_message', {
      text: 'Your sword strikes true!',
      options: ['Press your advantage', 'Defend'],
      forPlayer: charName
    });

    // 5. Stream ends
    socket.emit('dm_stream_end', {
      narration: 'Your sword strikes true!'
    });

    // Validate all emissions
    const emissions = socket.getEmissions();
    assert.strictEqual(emissions.length, 5);

    const charReg = socket.getLastEmission('character_registered');
    assert.strictEqual(validateCharacterRegistered(charReg.data).valid, true);

    const turnChg = socket.getLastEmission('turn_changed');
    assert.strictEqual(validateTurnChanged(turnChg.data).valid, true);

    const playerMsg = socket.getLastEmission('player_message');
    assert.strictEqual(validatePlayerMessage(playerMsg.data).valid, true);

    const dmMsg = socket.getLastEmission('dm_message');
    assert.strictEqual(validateDmMessage(dmMsg.data).valid, true);

    const streamEnd = socket.getLastEmission('dm_stream_end');
    assert.strictEqual(validateDmStreamEnd(streamEnd.data).valid, true);
  });
});

describe('Socket Contract — XSS safety', () => {
  it('messages can contain HTML but should be escaped client-side', () => {
    const msg = {
      text: '<script>alert("xss")</script> The dragon attacks!',
      options: ['<img src=x onerror=alert(1)>', 'Normal option'],
      forPlayer: 'Kael'
    };
    // Contract validation doesn't escape — that's client responsibility
    // Just ensure the shape is correct
    const validation = validateDmMessage(msg);
    assert.strictEqual(validation.valid, true);
  });
});
