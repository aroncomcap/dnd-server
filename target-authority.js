'use strict';

function hpValue(combatant) {
  const hp = combatant?.hp ?? combatant?.totalHp ?? combatant?.maxHp;
  const num = Number(hp);
  return Number.isFinite(num) ? num : null;
}

function maxHpValue(combatant) {
  const hp = combatant?.maxHp ?? combatant?.totalHp ?? combatant?.hp;
  const num = Number(hp);
  return Number.isFinite(num) ? num : null;
}

function parseCr(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value).trim();
  const fraction = text.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fraction) {
    const top = Number(fraction[1]);
    const bottom = Number(fraction[2]);
    return bottom ? top / bottom : 0;
  }
  const num = Number(text);
  return Number.isFinite(num) ? num : 0;
}

function isEnemy(combatant) {
  return combatant?.type === 'Enemy';
}

function isAlly(combatant) {
  return !!combatant && combatant.type !== 'Enemy';
}

function isAlive(combatant) {
  if (!combatant || combatant.dead) return false;
  const hp = hpValue(combatant);
  return hp == null || hp > 0;
}

function isDownedAlly(combatant) {
  if (!isAlly(combatant)) return false;
  const hp = hpValue(combatant);
  return !!combatant.dead || (hp != null && hp <= 0);
}

function livingEnemies(combatants = {}) {
  return Object.values(combatants).filter(c => isEnemy(c) && isAlive(c));
}

function livingAllies(combatants = {}) {
  return Object.values(combatants).filter(c => isAlly(c) && isAlive(c));
}

function downedAllies(combatants = {}) {
  return Object.values(combatants).filter(isDownedAlly);
}

function enemyThreatScore(enemy) {
  return (parseCr(enemy.cr) * 1000) +
    ((maxHpValue(enemy) || hpValue(enemy) || 0) * 4) +
    (Number(enemy.ac) || 0);
}

function defaultAttackTargetId(combatants = {}) {
  const enemies = livingEnemies(combatants);
  enemies.sort((a, b) => enemyThreatScore(b) - enemyThreatScore(a));
  return enemies[0]?.id || null;
}

function defaultSupportTargetId(combatants = {}, actorId = null) {
  const allies = livingAllies(combatants);
  if (!allies.length) return actorId || null;

  const injured = allies
    .map(c => {
      const hp = hpValue(c);
      const maxHp = maxHpValue(c);
      const missing = hp != null && maxHp != null ? Math.max(0, maxHp - hp) : 0;
      return { combatant: c, missing };
    })
    .sort((a, b) => b.missing - a.missing);

  if (injured[0]?.missing > 0) return injured[0].combatant.id;
  if (actorId && combatants[actorId] && isAlly(combatants[actorId])) return actorId;
  return allies[0]?.id || actorId || null;
}

function normalizeTargetPreferences(preferences = {}) {
  return {
    attackTargetId: preferences.attackTargetId || preferences.attack || preferences.enemyTargetId || null,
    supportTargetId: preferences.supportTargetId || preferences.support || preferences.allyTargetId || null,
  };
}

function getPreferredAttackTargetId(combatants = {}, preferences = {}) {
  const prefs = normalizeTargetPreferences(preferences);
  const preferred = combatants[prefs.attackTargetId];
  if (preferred && isEnemy(preferred) && isAlive(preferred)) return preferred.id;
  return defaultAttackTargetId(combatants);
}

function getPreferredSupportTargetId(combatants = {}, actorId = null, preferences = {}) {
  const prefs = normalizeTargetPreferences(preferences);
  const preferred = combatants[prefs.supportTargetId];
  if (preferred && isAlly(preferred) && isAlive(preferred)) return preferred.id;
  return defaultSupportTargetId(combatants, actorId);
}

function isHealingSpell(spell = {}) {
  const name = String(spell.name || '').toLowerCase();
  return !!(
    spell.healing ||
    spell.effect === 'heal' ||
    spell.type === 'heal' ||
    /\b(?:heal|healing word|cure|mend|restore|lay on hands)\b/.test(name)
  );
}

function isOffensiveSpell(spell = {}, query = '') {
  const text = `${spell.name || ''} ${query || ''}`.toLowerCase();
  return !!(
    spell.damage ||
    spell.attack ||
    spell.save ||
    spell.type === 'damage' ||
    /\b(?:acid splash|burning hands|chill touch|chromatic orb|dissonant whispers|eldritch blast|fire bolt|fireball|guiding bolt|heat metal|inflict wounds|lightning bolt|magic missile|moonbeam|ray of frost|sacred flame|scorching ray|shatter|spirit guardians|toll the dead|vicious mockery)\b/.test(text)
  );
}

function spellTargetRole(spell = {}, query = '') {
  const text = `${spell.name || ''} ${query || ''}`.toLowerCase();
  if (/\b(?:revivify|raise dead|resurrection|resurrect|reincarnate)\b/.test(text)) return 'downed_ally';
  if (isHealingSpell(spell)) return 'ally';
  if (isOffensiveSpell(spell, query)) return 'enemy';
  if (/\b(?:shield|misty step|mirror image|blur|expeditious retreat)\b/.test(text)) return 'self';
  return 'ally';
}

function validTargetsForRole(combatants = {}, role, actorId = null) {
  if (role === 'enemy') return livingEnemies(combatants);
  if (role === 'downed_ally') return downedAllies(combatants);
  if (role === 'self') return combatants[actorId] ? [combatants[actorId]] : [];
  if (role === 'ally') return livingAllies(combatants);
  return Object.values(combatants).filter(isAlive);
}

function roleLabel(role) {
  if (role === 'enemy') return 'living enemy';
  if (role === 'downed_ally') return 'downed or dead ally';
  if (role === 'self') return 'self target';
  if (role === 'ally') return 'living ally';
  return 'valid target';
}

function targetIsValid(combatant, role, actorId = null) {
  if (!combatant) return false;
  if (role === 'enemy') return isEnemy(combatant) && isAlive(combatant);
  if (role === 'ally') return isAlly(combatant) && isAlive(combatant);
  if (role === 'downed_ally') return isDownedAlly(combatant);
  if (role === 'self') return combatant.id === actorId && isAlive(combatant);
  return isAlive(combatant);
}

function makeTargetRequiredResult(action, combatants, details = {}) {
  const actorId = details.actorId || action.actorId || action.attackerId || action.casterId;
  const actor = combatants[actorId];
  const role = details.role || 'target';
  const actionName = details.actionName || action.spell || action.weapon || action.description || action.type || 'action';
  const availableTargets = validTargetsForRole(combatants, role, actorId)
    .map(c => ({ id: c.id, name: c.name, hp: hpValue(c), maxHp: maxHpValue(c), type: c.type }));
  const target = combatants[action.targetId];
  const reason = details.reason || (target
    ? `${target.name} is not a valid ${roleLabel(role)} for ${actionName}.`
    : `${actionName} needs a ${roleLabel(role)} before it can resolve.`);

  return {
    type: 'target_required',
    requiresTarget: true,
    actorId,
    actorName: actor?.name || actorId,
    actionType: action.type,
    actionName,
    targetRole: role,
    attemptedTargetId: action.targetId || null,
    availableTargets,
    message: reason,
  };
}

function applyTargetPreferences(action, combatants = {}, preferences = {}, actorId = null, options = {}) {
  if (!action || typeof action !== 'object') return action;
  const next = { ...action };
  const resolvedActorId = actorId || next.actorId || next.attackerId || next.casterId;
  const allowDefaultFallback = options.allowDefaultFallback !== false;

  if (next.type === 'attack') {
    const prefs = normalizeTargetPreferences(preferences);
    const preferred = combatants[prefs.attackTargetId] && targetIsValid(combatants[prefs.attackTargetId], 'enemy', resolvedActorId)
      ? prefs.attackTargetId
      : (allowDefaultFallback ? defaultAttackTargetId(combatants) : null);
    if (!targetIsValid(combatants[next.targetId], 'enemy', resolvedActorId) && preferred) {
      next.targetId = preferred;
      next.targetSource = 'preferred_attack';
    }
    return next;
  }

  if (next.type === 'spell') {
    const spell = options.spell || {};
    const role = spellTargetRole(spell, next.spell || next.spellName || '');
    if (role === 'enemy') {
      const prefs = normalizeTargetPreferences(preferences);
      const preferred = combatants[prefs.attackTargetId] && targetIsValid(combatants[prefs.attackTargetId], role, resolvedActorId)
        ? prefs.attackTargetId
        : (allowDefaultFallback ? defaultAttackTargetId(combatants) : null);
      if (!targetIsValid(combatants[next.targetId], role, resolvedActorId) && preferred) {
        next.targetId = preferred;
        next.targetSource = 'preferred_attack';
      }
    } else if (role === 'ally') {
      const prefs = normalizeTargetPreferences(preferences);
      const preferred = combatants[prefs.supportTargetId] && targetIsValid(combatants[prefs.supportTargetId], role, resolvedActorId)
        ? prefs.supportTargetId
        : (allowDefaultFallback ? defaultSupportTargetId(combatants, resolvedActorId) : null);
      if (!targetIsValid(combatants[next.targetId], role, resolvedActorId) && preferred) {
        next.targetId = preferred;
        next.targetSource = 'preferred_support';
      }
    } else if (role === 'self' && !next.targetId) {
      next.targetId = resolvedActorId;
      next.targetSource = 'self';
    }
  }

  return next;
}

function validateActionTarget(action, combatants = {}, options = {}) {
  if (!action || typeof action !== 'object') return { ok: true, action };
  const actorId = options.actorId || action.actorId || action.attackerId || action.casterId;
  const next = applyTargetPreferences(action, combatants, options.preferences || {}, actorId, {
    ...options,
    allowDefaultFallback: options.allowDefaultFallback === true,
  });

  if (next.type === 'attack') {
    if (!targetIsValid(combatants[next.targetId], 'enemy', actorId)) {
      return {
        ok: false,
        result: makeTargetRequiredResult(next, combatants, {
          actorId,
          role: 'enemy',
          actionName: next.weapon || 'Attack',
        }),
      };
    }
  }

  if (next.type === 'spell' && options.spell) {
    const targetIds = Array.isArray(next.targetIds)
      ? next.targetIds.filter(Boolean)
      : (next.targetId ? [next.targetId] : []);
    if (options.ongoing && targetIds.length === 0) return { ok: true, action: next };
    const role = spellTargetRole(options.spell, next.spell || next.spellName || '');
    if (role === 'self' && !next.targetId) next.targetId = actorId;
    const resolvedTargetIds = Array.isArray(next.targetIds)
      ? next.targetIds.filter(Boolean)
      : (next.targetId ? [next.targetId] : []);
    if (!resolvedTargetIds.length || resolvedTargetIds.some(id => !targetIsValid(combatants[id], role, actorId))) {
      return {
        ok: false,
        result: makeTargetRequiredResult(next, combatants, {
          actorId,
          role,
          actionName: options.spell.name || next.spell || 'Spell',
        }),
      };
    }
  }

  return { ok: true, action: next };
}

function buildTargetSuggestions(combatants = {}, actorId = null, preferences = {}) {
  const prefs = normalizeTargetPreferences(preferences);
  return {
    attackTargetId: getPreferredAttackTargetId(combatants, prefs),
    supportTargetId: getPreferredSupportTargetId(combatants, actorId, prefs),
    enemies: livingEnemies(combatants).map(c => ({
      id: c.id,
      name: c.name,
      hp: hpValue(c),
      maxHp: maxHpValue(c),
      ac: c.ac,
      type: c.type,
    })),
    allies: livingAllies(combatants).map(c => ({
      id: c.id,
      name: c.name,
      hp: hpValue(c),
      maxHp: maxHpValue(c),
      ac: c.ac,
      type: c.type,
    })),
  };
}

module.exports = {
  hpValue,
  isAlive,
  isEnemy,
  isAlly,
  livingEnemies,
  livingAllies,
  downedAllies,
  defaultAttackTargetId,
  defaultSupportTargetId,
  normalizeTargetPreferences,
  getPreferredAttackTargetId,
  getPreferredSupportTargetId,
  isHealingSpell,
  isOffensiveSpell,
  spellTargetRole,
  validTargetsForRole,
  targetIsValid,
  applyTargetPreferences,
  validateActionTarget,
  buildTargetSuggestions,
  makeTargetRequiredResult,
};
