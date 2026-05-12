'use strict';

function clone(value) {
  return JSON.parse(JSON.stringify(value || null));
}

function isRestEncounter(enc) {
  return enc?.rest || enc?.pillar === 'rest' || enc?.type === 'short' || enc?.type === 'long';
}

function normalizeRest(enc) {
  if (!isRestEncounter(enc)) return enc;
  const restType = enc.rest || enc.type || 'short';
  return {
    ...enc,
    pillar: 'rest',
    type: restType,
    rest: restType,
  };
}

function countPlayable(encounters) {
  return (encounters || []).filter(enc => !isRestEncounter(enc)).length;
}

function isResolvedOrSkipped(enc) {
  return enc?.status === 'resolved' || enc?.status === 'skipped';
}

function normalizeEncounter(enc, dayNumber, index, currentIndex) {
  const normalized = normalizeRest({ ...enc });
  normalized.id = normalized.id || `day-${dayNumber}-enc-${index + 1}`;

  if (!normalized.status) {
    normalized.status = normalized.completed ? 'resolved' : 'queued';
  }
  if (normalized.completed && normalized.status !== 'skipped') {
    normalized.status = 'resolved';
  }
  if (!normalized.completed && index === currentIndex && normalized.status === 'queued') {
    normalized.status = 'next';
  }
  normalized.completed = normalized.status === 'resolved';

  return normalized;
}

function normalizeDay(day, dayNumber, activeDayIndex = 0) {
  const currentIndex = Math.max(0, Number(day?.currentIndex || 0));
  const rawEncounters = Array.isArray(day?.encounters) ? day.encounters : [];
  const normalized = {
    id: day?.id || `day-${dayNumber}`,
    dayNumber,
    label: day?.label || `Day ${dayNumber}`,
    status: day?.status || (dayNumber - 1 === activeDayIndex ? 'active' : 'queued'),
    sourceMode: day?.sourceMode || 'sandbox',
    sourceMaterialCount: day?.sourceMaterialCount || 0,
    sourceMaterialNames: Array.isArray(day?.sourceMaterialNames) ? day.sourceMaterialNames : [],
    currentIndex,
    summary: day?.summary || {},
    encounters: rawEncounters.map((enc, index) => normalizeEncounter(enc, dayNumber, index, currentIndex)),
  };
  markCurrentEncounter(normalized);
  return normalized;
}

function markCurrentEncounter(day) {
  if (!day || !Array.isArray(day.encounters)) return day;

  let currentIndex = Math.max(0, Number(day.currentIndex || 0));
  while (currentIndex < day.encounters.length && isResolvedOrSkipped(day.encounters[currentIndex])) {
    currentIndex++;
  }
  day.currentIndex = Math.min(currentIndex, Math.max(day.encounters.length - 1, 0));

  day.encounters.forEach((enc, index) => {
    if (enc.status === 'resolved' || enc.status === 'skipped') {
      enc.completed = enc.status === 'resolved';
      return;
    }
    enc.status = index === day.currentIndex ? 'next' : 'queued';
    enc.completed = false;
  });

  return day;
}

function syncActiveDay(plan) {
  if (!plan || !Array.isArray(plan.days)) return plan;
  const activeDay = getActiveDay(plan);
  if (activeDay) {
    plan.mode = activeDay.sourceMode || plan.mode;
    plan.sourceMode = activeDay.sourceMode || plan.sourceMode;
    plan.sourceMaterialCount = activeDay.sourceMaterialCount ?? plan.sourceMaterialCount ?? 0;
    plan.sourceMaterialNames = Array.isArray(activeDay.sourceMaterialNames)
      ? activeDay.sourceMaterialNames
      : (plan.sourceMaterialNames || []);
  }
  plan.encounters = activeDay?.encounters || [];
  plan.summary = activeDay?.summary || {};
  plan._currentIndex = activeDay?.currentIndex || 0;
  plan.activeDayNumber = activeDay?.dayNumber || 0;
  plan.dayCount = plan.days.length;
  return plan;
}

function normalizeEncounterPlan(plan) {
  if (!plan) return null;

  const base = clone(plan);
  const sourceDays = Array.isArray(base.days) && base.days.length
    ? base.days
    : [{ ...base, dayNumber: 1, status: 'active' }];
  const activeDayIndex = Math.max(0, Math.min(Number(base.activeDayIndex || 0), sourceDays.length - 1));

  const normalized = {
    id: base.id || `plan-${Date.now().toString(36)}`,
    version: 2,
    mode: base.mode || base.sourceMode || 'sandbox',
    sourceMode: base.sourceMode || base.mode || 'sandbox',
    sourceMaterialCount: base.sourceMaterialCount || 0,
    sourceMaterialNames: Array.isArray(base.sourceMaterialNames) ? base.sourceMaterialNames : [],
    activeDayIndex,
    createdAt: base.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    days: sourceDays.map((day, index) => normalizeDay(
      {
        ...day,
        sourceMode: day.sourceMode || base.sourceMode || base.mode || 'sandbox',
        sourceMaterialCount: day.sourceMaterialCount ?? base.sourceMaterialCount ?? 0,
        sourceMaterialNames: day.sourceMaterialNames || base.sourceMaterialNames || [],
        status: index === activeDayIndex && day.status !== 'resolved' ? 'active' : (day.status || 'queued'),
      },
      day.dayNumber || index + 1,
      activeDayIndex
    )),
  };

  return syncActiveDay(normalized);
}

function createEncounterPlan(day, metadata = {}) {
  const now = new Date().toISOString();
  return normalizeEncounterPlan({
    id: metadata.id || `plan-${Date.now().toString(36)}`,
    version: 2,
    mode: metadata.mode || metadata.sourceMode || 'sandbox',
    sourceMode: metadata.sourceMode || metadata.mode || 'sandbox',
    sourceMaterialCount: metadata.sourceMaterialCount || 0,
    sourceMaterialNames: metadata.sourceMaterialNames || [],
    activeDayIndex: 0,
    createdAt: now,
    updatedAt: now,
    days: [{
      ...day,
      dayNumber: 1,
      label: metadata.label || 'Day 1',
      status: 'active',
      sourceMode: metadata.sourceMode || metadata.mode || 'sandbox',
      sourceMaterialCount: metadata.sourceMaterialCount || 0,
      sourceMaterialNames: metadata.sourceMaterialNames || [],
      currentIndex: 0,
    }],
  });
}

function appendAdventuringDay(plan, day, metadata = {}) {
  const normalized = normalizeEncounterPlan(plan) || createEncounterPlan(day, metadata);
  if (!plan) return normalized;

  const dayNumber = normalized.days.length + 1;
  normalized.days.push(normalizeDay({
    ...day,
    dayNumber,
    label: metadata.label || `Day ${dayNumber}`,
    status: 'queued',
    sourceMode: metadata.sourceMode || normalized.sourceMode || 'sandbox',
    sourceMaterialCount: metadata.sourceMaterialCount ?? normalized.sourceMaterialCount ?? 0,
    sourceMaterialNames: metadata.sourceMaterialNames || normalized.sourceMaterialNames || [],
    currentIndex: 0,
  }, dayNumber, normalized.activeDayIndex));
  normalized.updatedAt = new Date().toISOString();
  return syncActiveDay(normalized);
}

function getActiveDay(plan) {
  if (!plan || !Array.isArray(plan.days) || plan.days.length === 0) return null;
  const index = Math.max(0, Math.min(Number(plan.activeDayIndex || 0), plan.days.length - 1));
  return plan.days[index];
}

function scalePendingDifficulty(plan, modifier) {
  const normalized = normalizeEncounterPlan(plan);
  const activeDay = getActiveDay(normalized);
  if (!activeDay) return normalized;

  for (const enc of activeDay.encounters) {
    if (enc.completed || enc.status === 'resolved' || enc.status === 'skipped' || isRestEncounter(enc)) continue;
    if (enc.totalHP) enc.totalHP = Math.round(enc.totalHP * modifier);
    if (enc.estimatedDPR) enc.estimatedDPR = Math.round(enc.estimatedDPR * modifier);
  }
  normalized.updatedAt = new Date().toISOString();
  return syncActiveDay(normalized);
}

function setBossAsNext(plan) {
  const normalized = normalizeEncounterPlan(plan);
  const activeDay = getActiveDay(normalized);
  if (!activeDay) return normalized;

  const bossIndex = activeDay.encounters.findIndex(enc => !isRestEncounter(enc) && enc.position === 'boss');
  if (bossIndex < 0) return normalized;

  activeDay.encounters.forEach((enc, index) => {
    if (enc.status === 'resolved') return;
    if (index < bossIndex && !isRestEncounter(enc)) {
      enc.status = 'skipped';
      enc.completed = false;
    } else if (index === bossIndex) {
      enc.status = 'next';
      enc.completed = false;
    } else if (enc.status !== 'skipped') {
      enc.status = 'queued';
      enc.completed = false;
    }
  });
  activeDay.currentIndex = bossIndex;
  normalized.updatedAt = new Date().toISOString();
  return syncActiveDay(normalized);
}

function insertRestAtCurrent(plan, restType = 'short') {
  const normalized = normalizeEncounterPlan(plan);
  const activeDay = getActiveDay(normalized);
  if (!activeDay) return normalized;

  const index = Math.max(0, Number(activeDay.currentIndex || 0));
  const restCount = activeDay.encounters.filter(isRestEncounter).length + 1;
  activeDay.encounters.splice(index, 0, normalizeEncounter({
    id: `day-${activeDay.dayNumber}-rest-${restCount}`,
    pillar: 'rest',
    type: restType,
    rest: restType,
    reason: 'Host inserted rest',
  }, activeDay.dayNumber, index, index));
  activeDay.currentIndex = index;
  markCurrentEncounter(activeDay);
  normalized.updatedAt = new Date().toISOString();
  return syncActiveDay(normalized);
}

function isDayComplete(day) {
  if (!day || !Array.isArray(day.encounters)) return false;
  const playable = day.encounters.filter(enc => !isRestEncounter(enc));
  return playable.length > 0 && playable.every(enc => enc.completed || isResolvedOrSkipped(enc));
}

function markDayResolved(day) {
  if (!day) return;
  day.status = 'resolved';
  day.currentIndex = Array.isArray(day.encounters) ? day.encounters.length : 0;
  for (const enc of day.encounters || []) {
    if (enc.status === 'skipped') continue;
    enc.status = 'resolved';
    enc.completed = true;
  }
}

function advanceCompletedDays(plan) {
  const normalized = normalizeEncounterPlan(plan);
  if (!normalized) return normalized;

  let activeIndex = Math.max(0, Math.min(Number(normalized.activeDayIndex || 0), normalized.days.length - 1));
  let changed = false;

  while (activeIndex < normalized.days.length - 1 && isDayComplete(normalized.days[activeIndex])) {
    markDayResolved(normalized.days[activeIndex]);
    activeIndex++;
    normalized.activeDayIndex = activeIndex;
    normalized.days[activeIndex].status = 'active';
    normalized.days[activeIndex].currentIndex = 0;
    markCurrentEncounter(normalized.days[activeIndex]);
    changed = true;
  }

  if (isDayComplete(normalized.days[activeIndex])) {
    markDayResolved(normalized.days[activeIndex]);
    changed = true;
  }

  normalized.days.forEach((day, index) => {
    if (index < activeIndex) day.status = 'resolved';
    if (index === activeIndex && day.status !== 'resolved') day.status = 'active';
    if (index > activeIndex && day.status !== 'resolved') day.status = 'queued';
  });

  if (changed) normalized.updatedAt = new Date().toISOString();
  return syncActiveDay(normalized);
}

function toHostPlan(plan) {
  const normalized = normalizeEncounterPlan(plan);
  if (!normalized) return null;
  const activeDay = getActiveDay(normalized);
  const days = normalized.days.map(day => ({
    id: day.id,
    dayNumber: day.dayNumber,
    label: day.label,
    status: day.status,
    sourceMode: day.sourceMode,
    encounterCount: countPlayable(day.encounters),
    restCount: day.encounters.filter(isRestEncounter).length,
    currentIndex: day.currentIndex,
  }));

  return {
    ...normalized,
    days,
    encounters: activeDay?.encounters || [],
    summary: activeDay?.summary || {},
    _currentIndex: activeDay?.currentIndex || 0,
    activeDayNumber: activeDay?.dayNumber || 0,
    dayCount: normalized.days.length,
  };
}

module.exports = {
  appendAdventuringDay,
  advanceCompletedDays,
  createEncounterPlan,
  getActiveDay,
  insertRestAtCurrent,
  normalizeEncounterPlan,
  scalePendingDifficulty,
  setBossAsNext,
  syncActiveDay,
  toHostPlan,
};
