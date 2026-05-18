'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildFullPrompt, buildMinimalPrompt } = require('../prompt-builder');
const { createEncounterPlan } = require('../planner-state');

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
    encounterPlan: null,
    encounterPlanIndex: 0,
    lastCombatConclusion: {
      reason: 'enemies_defeated',
      defeated: ['Ashenvale Beast'],
      summary: 'Ashenvale Beast was defeated and the village is safe.',
    },
  };
}

function makeEncounterPlan() {
  return createEncounterPlan({
    encounters: [
      { pillar: 'combat', position: 'early', monsters: [{ name: 'Goblin', count: 2, slug: 'goblin' }] },
      { pillar: 'social', type: 'parley', dc: 14, successesNeeded: 2, maxFailures: 2 },
    ],
    summary: { totalEncounters: 2, combatCount: 1, socialCount: 1, explorationCount: 0 },
  });
}

describe('prompt-builder resolved combat state', () => {
  it('includes permanent resolved combat state in minimal prompts', () => {
    const prompt = buildMinimalPrompt({ system: 'dnd5e' }, makeGameState());
    assert.ok(prompt.includes('RESOLVED COMBAT STATE'));
    assert.ok(prompt.includes('Ashenvale Beast'));
    assert.ok(prompt.includes('Do not revive') || prompt.includes('do not revive'));
  });

  it('includes encounter plan guidance in minimal prompts at the current planner index', () => {
    const gs = makeGameState();
    gs.encounterPlan = makeEncounterPlan();
    gs.encounterPlanIndex = 1;
    gs._encounterPacingDirective = 'DIRECTOR: advance now.';

    const prompt = buildMinimalPrompt({ system: 'dnd5e' }, gs);

    assert.match(prompt, /ENCOUNTER PLAN: Encounter 2 of 2/);
    assert.match(prompt, /DIRECTOR: advance now\./);
  });

  it('includes encounter plan guidance in full story prompts', () => {
    const gs = makeGameState();
    gs.encounterPlan = makeEncounterPlan();
    gs.encounterPlanIndex = 1;

    const prompt = buildFullPrompt('game-1', { system: 'dnd5e' }, () => gs, require('../encounter-designer'));

    assert.match(prompt, /ENCOUNTER PLAN: Encounter 2 of 2/);
  });

  it('requires lead payoff instead of endless breadcrumb handoffs', () => {
    const minimal = buildMinimalPrompt({ system: 'dnd5e' }, makeGameState());
    const full = buildFullPrompt('game-1', { system: 'dnd5e' }, () => makeGameState(), require('../encounter-designer'));

    for (const prompt of [minimal, full]) {
      assert.match(prompt, /Do not end a response by only pointing to the next lead/);
      assert.match(prompt, /A strong non-combat turn has payoff, pressure, and personality/);
      assert.match(prompt, /Never repeat a prior clue as the main event/);
      assert.match(prompt, /After several turns on one objective/);
    }
  });

  it('forbids unsourced noncombat check result labels', () => {
    const minimal = buildMinimalPrompt({ system: 'dnd5e' }, makeGameState());
    const full = buildFullPrompt('game-1', { system: 'dnd5e' }, () => makeGameState(), require('../encounter-designer'));

    for (const prompt of [minimal, full]) {
      assert.match(prompt, /Do not write check-result labels/);
      assert.match(prompt, /unless the server supplied a resolved check/);
    }
  });
});
