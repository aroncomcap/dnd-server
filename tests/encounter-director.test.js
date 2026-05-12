'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PACING_TURN_LIMIT,
  getNextPlannedEncounter,
  planNeedsAdventuringDay,
  prepareEncounterPacing,
} = require('../encounter-director');
const { createEncounterPlan } = require('../planner-state');

function makeDay() {
  return {
    encounters: [
      { pillar: 'combat', position: 'early', monsters: [{ name: 'Goblin', count: 2, slug: 'goblin' }] },
      { pillar: 'rest', type: 'short' },
      { pillar: 'social', type: 'negotiation', dc: 14, successesNeeded: 2, maxFailures: 2 },
      { pillar: 'exploration', type: 'trap', dc: 15 },
    ],
    summary: { totalEncounters: 3, combatCount: 1, socialCount: 1, explorationCount: 1 },
  };
}

test('planNeedsAdventuringDay asks for a plan when none exists or the active day is spent', () => {
  assert.equal(planNeedsAdventuringDay(null), true);

  const plan = createEncounterPlan(makeDay());
  plan.days[0].encounters.forEach(enc => {
    if (!enc.rest) {
      enc.status = 'resolved';
      enc.completed = true;
    }
  });
  plan.days[0].currentIndex = plan.days[0].encounters.length;

  assert.equal(planNeedsAdventuringDay(plan), true);
});

test('getNextPlannedEncounter skips rests and resolved beats', () => {
  const plan = createEncounterPlan(makeDay());
  plan.days[0].encounters[0].status = 'resolved';
  plan.days[0].encounters[0].completed = true;
  plan.days[0].currentIndex = 1;

  const next = getNextPlannedEncounter(plan);

  assert.equal(next.index, 2);
  assert.equal(next.encounter.pillar, 'social');
});

test('prepareEncounterPacing forces the next planned beat after two quiet turns', () => {
  const plan = createEncounterPlan(makeDay());
  const gs = { encounterPlan: plan, _turnsSinceLastEncounter: PACING_TURN_LIMIT - 1 };

  const result = prepareEncounterPacing(gs);

  assert.equal(result.shouldAdvance, true);
  assert.equal(result.encounter.pillar, 'combat');
  assert.equal(gs._pendingChallenge.pillar, 'combat');
  assert.match(gs._encounterPacingDirective, /MUST introduce the next planned combat/i);
});
