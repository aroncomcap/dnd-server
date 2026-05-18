'use strict';

function hpValue(combatant = {}) {
  const hp = combatant.hp ?? combatant.totalHp ?? 0;
  const num = Number(hp);
  return Number.isFinite(num) ? num : 0;
}

function maxHpValue(combatant = {}, fallbackHp = 1) {
  const hp = combatant.maxHp ?? combatant.totalHp ?? fallbackHp;
  const num = Number(hp);
  return Number.isFinite(num) && num > 0 ? num : fallbackHp;
}

function livingPcs(pcs = []) {
  return pcs.filter(p => hpValue(p) > 0);
}

function chooseEnemyTargetId(pcs = []) {
  const candidates = livingPcs(pcs)
    .map(p => {
      const hp = hpValue(p);
      const maxHp = maxHpValue(p, hp || 1);
      const hpRatio = maxHp > 0 ? hp / maxHp : 1;
      return {
        ...p,
        hpRatio,
        score: (p.concentrating ? 100 : 0) + ((1 - hpRatio) * 50) + (20 - Math.min(hp, 20)),
      };
    })
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.id || null;
}

function resolveEnemyDecisionTarget(decisionTargetId, pcs = []) {
  const live = livingPcs(pcs);
  if (decisionTargetId && live.some(p => p.id === decisionTargetId)) return decisionTargetId;
  return chooseEnemyTargetId(live);
}

module.exports = {
  chooseEnemyTargetId,
  resolveEnemyDecisionTarget,
};
