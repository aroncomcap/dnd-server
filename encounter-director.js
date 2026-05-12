'use strict';

const plannerState = require('./planner-state');

const PACING_TURN_LIMIT = 2;

function isRestEncounter(enc) {
  return enc?.rest || enc?.pillar === 'rest' || enc?.type === 'short' || enc?.type === 'long';
}

function isResolved(enc) {
  return enc?.completed || enc?.status === 'resolved' || enc?.status === 'skipped';
}

function getNextPlannedEncounter(plan) {
  const normalized = plannerState.advanceCompletedDays(plan);
  const activeDay = plannerState.getActiveDay(normalized);
  if (!activeDay || activeDay.status === 'resolved') return null;

  const startIndex = Math.max(0, Number(activeDay.currentIndex || normalized?._currentIndex || 0));
  const fromCursor = activeDay.encounters.findIndex((enc, index) =>
    index >= startIndex && !isRestEncounter(enc) && !isResolved(enc)
  );
  const fallback = activeDay.encounters.findIndex(enc => !isRestEncounter(enc) && !isResolved(enc));
  const index = fromCursor >= 0 ? fromCursor : fallback;
  if (index < 0) return null;

  return { encounter: activeDay.encounters[index], index, activeDay, plan: normalized };
}

function planNeedsAdventuringDay(plan) {
  if (!plan) return true;
  return !getNextPlannedEncounter(plan);
}

function formatEncounterDirective(encounter, quietTurns) {
  const turnText = `${quietTurns} quiet turn${quietTurns === 1 ? '' : 's'}`;
  if (encounter.pillar === 'combat') {
    const enemies = (encounter.monsters || [])
      .map(m => `- ${m.displayName || m.name} | ${m.count || 1} | ${m.slug || 'custom'}`)
      .join('\n');
    return [
      `DIRECTOR PACING: ${turnText} without a real challenge. You MUST introduce the next planned combat now.`,
      `Do not narrate more searching, coins, atmosphere, or vague clues. Put immediate hostile pressure in the scene.`,
      enemies ? `Include this ENEMIES block in ---WORLD--- exactly:\nENEMIES:\n${enemies}` : '',
    ].filter(Boolean).join('\n');
  }
  if (encounter.pillar === 'social') {
    return [
      `DIRECTOR PACING: ${turnText} without a real challenge. You MUST introduce the next planned social challenge now.`,
      `An NPC, faction, witness, rival, or authority figure should confront the party with stakes, a DC ${encounter.dc || '?'} check, and meaningful consequences.`,
    ].join('\n');
  }
  return [
    `DIRECTOR PACING: ${turnText} without a real challenge. You MUST introduce the next planned exploration challenge now.`,
    `Present an immediate trap, puzzle, hazard, discovery under pressure, or navigation obstacle with DC ${encounter.dc || '?'}.`,
  ].join('\n');
}

function prepareEncounterPacing(gs, threshold = PACING_TURN_LIMIT) {
  if (!gs || gs.combatEngine?.state?.active) {
    if (gs) gs._turnsSinceLastEncounter = 0;
    return { shouldAdvance: false, reason: 'combat-active' };
  }

  if (planNeedsAdventuringDay(gs.encounterPlan)) {
    gs._encounterPacingDirective = '';
    return { shouldAdvance: false, needsPlan: true };
  }

  const next = getNextPlannedEncounter(gs.encounterPlan);
  gs.encounterPlan = next.plan;
  gs.encounterPlanIndex = next.index;
  gs._turnsSinceLastEncounter = Math.max(0, Number(gs._turnsSinceLastEncounter || 0)) + 1;

  if (gs._turnsSinceLastEncounter < threshold) {
    gs._encounterPacingDirective = `DIRECTOR PACING: Next planned beat is ${next.encounter.pillar}. After at most one brief connective response, advance into it.`;
    return { shouldAdvance: false, encounter: next.encounter, index: next.index };
  }

  gs._pendingChallenge = next.encounter;
  gs._pendingChallengeIndex = next.index;
  gs._encounterPacingDirective = formatEncounterDirective(next.encounter, gs._turnsSinceLastEncounter);
  return { shouldAdvance: true, encounter: next.encounter, index: next.index };
}

function clearPacingDirective(gs) {
  if (!gs) return;
  gs._pendingChallenge = null;
  gs._pendingChallengeIndex = null;
  gs._encounterPacingDirective = '';
  gs._turnsSinceLastEncounter = 0;
}

module.exports = {
  PACING_TURN_LIMIT,
  clearPacingDirective,
  getNextPlannedEncounter,
  planNeedsAdventuringDay,
  prepareEncounterPacing,
};
