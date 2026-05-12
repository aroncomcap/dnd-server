'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  appendAdventuringDay,
  advanceCompletedDays,
  createEncounterPlan,
  getActiveDay,
  insertRestAtCurrent,
  scalePendingDifficulty,
  setBossAsNext,
  toHostPlan,
} = require('../planner-state');

function makeDay(label = 'Generated day') {
  return {
    encounters: [
      { pillar: 'combat', position: 'early', monsters: [{ name: 'Goblin', count: 2 }], totalHP: 20, estimatedDPR: 8, estimatedRounds: 3 },
      { pillar: 'social', position: 'mid', dc: 14, difficultyRating: 'medium' },
      { pillar: 'combat', position: 'boss', monsters: [{ name: 'Ogre', count: 1 }], totalHP: 59, estimatedDPR: 13, estimatedRounds: 4 },
      { pillar: 'rest', type: 'long' },
    ],
    summary: {
      totalEncounters: 3,
      combatCount: 2,
      socialCount: 1,
      explorationCount: 0,
      shortRestCount: 0,
      ferocity: 3,
      ferocityLabel: 'Balanced',
    },
    label,
  };
}

test('createEncounterPlan stores exactly one active adventuring day at a time', () => {
  const plan = createEncounterPlan(makeDay(), {
    sourceMode: 'adaptive-module',
    sourceMaterialCount: 1,
    sourceMaterialNames: ['Temple.pdf'],
  });
  const hostPlan = toHostPlan(plan);

  assert.equal(plan.days.length, 1);
  assert.equal(hostPlan.activeDayNumber, 1);
  assert.equal(hostPlan.dayCount, 1);
  assert.equal(hostPlan.sourceMode, 'adaptive-module');
  assert.equal(hostPlan.sourceMaterialCount, 1);
  assert.equal(hostPlan.encounters.length, 4);
  assert.equal(hostPlan.encounters[0].status, 'next');
  assert.equal(hostPlan.encounters[0].id, 'day-1-enc-1');
  assert.equal(hostPlan._currentIndex, 0);
});

test('appendAdventuringDay queues the next day without replacing the active day', () => {
  const plan = createEncounterPlan(makeDay('Day 1'));
  const queued = appendAdventuringDay(plan, makeDay('Day 2'), { sourceMode: 'sandbox' });
  const hostPlan = toHostPlan(queued);

  assert.equal(queued.days.length, 2);
  assert.equal(getActiveDay(queued).dayNumber, 1);
  assert.equal(hostPlan.dayCount, 2);
  assert.equal(hostPlan.days[1].status, 'queued');
  assert.equal(hostPlan.days[1].encounterCount, 3);
  assert.equal(hostPlan.encounters[0].id, 'day-1-enc-1');
});

test('setBossAsNext skips unresolved lead-up encounters but keeps the boss playable', () => {
  const plan = createEncounterPlan(makeDay());
  const updated = setBossAsNext(plan);
  const hostPlan = toHostPlan(updated);

  assert.equal(hostPlan._currentIndex, 2);
  assert.equal(hostPlan.encounters[0].status, 'skipped');
  assert.equal(hostPlan.encounters[1].status, 'skipped');
  assert.equal(hostPlan.encounters[2].status, 'next');
  assert.equal(hostPlan.encounters[2].completed, false);
  assert.equal(hostPlan.encounters[2].position, 'boss');
});

test('scalePendingDifficulty changes only unresolved combat math', () => {
  const plan = createEncounterPlan(makeDay());
  plan.days[0].encounters[0].completed = true;
  plan.days[0].encounters[0].status = 'resolved';

  const updated = scalePendingDifficulty(plan, 1.2);
  const hostPlan = toHostPlan(updated);

  assert.equal(hostPlan.encounters[0].totalHP, 20);
  assert.equal(hostPlan.encounters[0].estimatedDPR, 8);
  assert.equal(hostPlan.encounters[2].totalHP, 71);
  assert.equal(hostPlan.encounters[2].estimatedDPR, 16);
});

test('insertRestAtCurrent inserts a short rest into the active day queue', () => {
  const plan = createEncounterPlan(makeDay());
  const updated = insertRestAtCurrent(plan);
  const hostPlan = toHostPlan(updated);

  assert.equal(hostPlan.encounters[0].pillar, 'rest');
  assert.equal(hostPlan.encounters[0].type, 'short');
  assert.equal(hostPlan.encounters[0].status, 'next');
  assert.equal(hostPlan.encounters[1].id, 'day-1-enc-1');
});

test('advanceCompletedDays activates the next queued adventuring day', () => {
  const plan = appendAdventuringDay(createEncounterPlan(makeDay('Day 1')), makeDay('Day 2'));
  plan.days[0].encounters.forEach(enc => {
    if (!enc.rest) {
      enc.status = 'resolved';
      enc.completed = true;
    }
  });
  plan.days[0].currentIndex = plan.days[0].encounters.length;

  const advanced = advanceCompletedDays(plan);
  const hostPlan = toHostPlan(advanced);

  assert.equal(hostPlan.activeDayNumber, 2);
  assert.equal(hostPlan.days[0].status, 'resolved');
  assert.equal(hostPlan.days[1].status, 'active');
  assert.equal(hostPlan.encounters[0].id, 'day-2-enc-1');
  assert.equal(hostPlan.encounters[0].status, 'next');
});

test('advanceCompletedDays marks the final day resolved when no queued day exists', () => {
  const plan = createEncounterPlan(makeDay('Day 1'));
  plan.days[0].encounters.forEach(enc => {
    if (!enc.rest) {
      enc.status = 'resolved';
      enc.completed = true;
    }
  });
  plan.days[0].currentIndex = plan.days[0].encounters.length;

  const advanced = advanceCompletedDays(plan);
  const hostPlan = toHostPlan(advanced);

  assert.equal(hostPlan.activeDayNumber, 1);
  assert.equal(hostPlan.days[0].status, 'resolved');
  assert.equal(hostPlan.encounters.every(enc => enc.status === 'resolved'), true);
});
