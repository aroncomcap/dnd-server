'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildMinimalPrompt } = require('../prompt-builder');

function makeGameState() {
  return {
    data: {
      characters: {
        Kael: {
          class: 'Fighter',
          level: 2,
          personality: 'Steady under pressure.',
          standardActions: 'Attack, protect allies',
          backstory: 'A veteran guard.',
        },
      },
    },
    dmPersona: 'epic',
    verbosity: 'brief',
    ferocity: 3,
    pillars: { exploration: 33, combat: 33, social: 34 },
    lastCombatConclusion: {
      reason: 'enemies_defeated',
      defeated: ['Ashenvale Beast'],
      summary: 'Ashenvale Beast was defeated and the village is safe.',
    },
  };
}

describe('prompt-builder resolved combat state', () => {
  it('includes permanent resolved combat state in minimal prompts', () => {
    const prompt = buildMinimalPrompt({ system: 'dnd5e' }, makeGameState());
    assert.ok(prompt.includes('RESOLVED COMBAT STATE'));
    assert.ok(prompt.includes('Ashenvale Beast'));
    assert.ok(prompt.includes('Do not revive') || prompt.includes('do not revive'));
  });
});
