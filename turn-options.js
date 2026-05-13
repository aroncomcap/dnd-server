function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function getNameAliases(name) {
  const normalized = normalizeName(name);
  if (!normalized) return [];

  const parts = normalized.split(' ').filter(Boolean);
  const aliases = new Set([normalized]);
  const titleWords = new Set(['brother', 'lady', 'lord', 'sister', 'sir']);

  for (const part of parts) {
    if (part.length >= 4 && !titleWords.has(part)) aliases.add(part);
  }
  if (parts.length > 1 && titleWords.has(parts[0]) && parts[1]?.length >= 4) {
    aliases.add(parts[1]);
  }

  return [...aliases];
}

function getPreferredName(name) {
  const titleWords = new Set(['brother', 'lady', 'lord', 'sister', 'sir']);
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return parts.find(part => !titleWords.has(part.toLowerCase())) || parts[0] || 'The next hero';
}

function splitStandardActions(value) {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function findNearestEnemy(context = {}) {
  if (context.nearestEnemy?.name) return context.nearestEnemy;
  const combatants = context.combatants || context.combatEngine?.state?.combatants || {};
  return Object.values(combatants).find(c => {
    const hp = c.hp ?? c.totalHp ?? c.maxHp;
    return c.type === 'Enemy' && (hp === undefined || hp > 0);
  }) || null;
}

function isOffensiveStandardAction(action) {
  return /\b(?:attack|strike|shoot|sacred flame|fire bolt|eldritch blast|dissonant whispers|vicious mockery|toll the dead|ray of frost|fireball|burning hands|guiding bolt|inflict wounds|magic missile|spirit guardians|moonbeam|heat metal|shatter|turn undead)\b/i.test(action || '');
}

function scoreStandardAction(action, context = {}) {
  const lower = String(action || '').toLowerCase();
  const inCombat = !!findNearestEnemy(context);
  if (inCombat && /\b(?:attack|strike|shoot|sacred flame|fire bolt|eldritch blast|dissonant whispers|vicious mockery|toll the dead|ray of frost|fireball|burning hands|guiding bolt|inflict wounds|magic missile|spirit guardians|moonbeam|heat metal|shatter|turn undead|channel divinity)\b/.test(lower)) return 100;
  if (inCombat && /\b(?:dodge|help|protect|shield)\b/.test(lower)) return 85;
  if (/\b(?:bless|cure|heal|healing word|silence)\b/.test(lower)) return 75;
  if (!inCombat && /\b(?:search|inspect|check|sneak|scout|pass without trace|investigate)\b/.test(lower)) return 95;
  return 50;
}

function iconForStandardAction(action) {
  const lower = String(action || '').toLowerCase();
  if (/\b(?:dodge|shield|protect|defend)\b/.test(lower)) return '🛡️';
  if (/\b(?:cast|spell|channel divinity|turn undead|bless|cure|heal|sacred flame|spirit guardians)\b/.test(lower)) return '✨';
  if (/\b(?:help|aid)\b/.test(lower)) return '🤝';
  if (/\b(?:search|check|inspect|investigate|sneak|scout)\b/.test(lower)) return '🔎';
  return '🗡️';
}

function decorateStandardAction(action, targetPlayer, context = {}) {
  const preferred = getPreferredName(targetPlayer);
  const enemy = findNearestEnemy(context);
  const includeActorLabel = context.includeActorLabel !== false;
  let text = String(action || '').trim().replace(/\s+/g, ' ').replace(/[.]+$/, '');

  const attackWith = text.match(/^attack\s+with\s+(.+)$/i);
  if (attackWith && enemy?.name) {
    text = `Attack ${enemy.name} with ${attackWith[1].trim()}`;
  }

  const shootWith = text.match(/^shoot\s+(.+)$/i);
  if (shootWith && enemy?.name) {
    text = `Shoot ${enemy.name} with ${shootWith[1].trim()}`;
  }

  const cast = text.match(/^cast\s+(.+)$/i);
  if (cast && enemy?.name && isOffensiveStandardAction(text) && !/\b(?:on|at|against|toward|towards)\b/i.test(text)) {
    text = `Cast ${cast[1].trim()} at ${enemy.name}`;
  }

  if (includeActorLabel && preferred && !mentionsAlias(text, normalizeName(targetPlayer))) {
    text = `${preferred}: ${text}`;
  }

  return `${iconForStandardAction(action)} ${text}.`;
}

function buildStandardActionOptions(standardActions, context = {}) {
  const actions = splitStandardActions(standardActions);
  if (!actions.length) return [];
  const targetPlayer = context.targetPlayer || context.playerName || context.characterName || '';
  return actions
    .map((action, index) => ({ action, index, score: scoreStandardAction(action, context) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .map(({ action }) => decorateStandardAction(action, targetPlayer, context));
}

function mentionsAlias(text, alias) {
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(alias)}([^a-z0-9]|$)`, 'i');
  return pattern.test(String(text || '').toLowerCase());
}

function findMismatchedNames(options, targetPlayer, partyNames) {
  const target = normalizeName(targetPlayer);
  const targetAliases = new Set(getNameAliases(targetPlayer));
  const mismatches = new Set();

  for (const name of partyNames || []) {
    const normalized = normalizeName(name);
    if (!normalized || normalized === target) continue;

    const aliases = getNameAliases(name)
      .filter(alias => !targetAliases.has(alias));
    if (!aliases.length) continue;

    const mentioned = (options || []).some(option =>
      aliases.some(alias => mentionsAlias(option, alias))
    );
    if (mentioned) mismatches.add(name);
  }

  return [...mismatches];
}

function buildFallbackOptionsForPlayer(targetPlayer, context = {}) {
  const name = String(targetPlayer || 'The next hero').trim() || 'The next hero';
  const firstName = getPreferredName(name);
  const standardActions = context.standardActions || context.character?.standardActions || context.character?.data?.standardActions;
  const standardOptions = buildStandardActionOptions(standardActions, {
    ...context,
    targetPlayer: name,
  });
  if (standardOptions.length >= 3) return standardOptions;

  return [
    `🗡️ ${firstName} takes point and checks the immediate danger.`,
    `🛡️ ${firstName} regroups with the party and protects anyone exposed.`,
    `🔥 ${firstName} tries a bold move using the scene's strange details.`,
  ];
}

function sanitizeOptionsForPlayer(options, targetPlayer, partyNames, context = {}) {
  const cleanOptions = Array.isArray(options)
    ? options.filter(option => typeof option === 'string' && option.trim()).slice(0, 3)
    : [];

  if (!targetPlayer || cleanOptions.length === 0) {
    return { options: cleanOptions, retargeted: false, mismatchedNames: [] };
  }

  const mismatchedNames = findMismatchedNames(cleanOptions, targetPlayer, partyNames);
  const previousPlayer = normalizeName(context.previousPlayer);
  const target = normalizeName(targetPlayer);
  const targetAliases = getNameAliases(targetPlayer);
  const mentionsTarget = cleanOptions.some(option =>
    targetAliases.some(alias => mentionsAlias(option, alias))
  );
  const carriesPreviousActor = previousPlayer && previousPlayer !== target && !mentionsTarget &&
    cleanOptions.some(option => /\b(?:you|your|yours)\b/i.test(option));

  if (mismatchedNames.length === 0 && !carriesPreviousActor) {
    return { options: cleanOptions, retargeted: false, mismatchedNames: [] };
  }

  return {
    options: buildFallbackOptionsForPlayer(targetPlayer, context),
    retargeted: true,
    mismatchedNames: mismatchedNames.length ? mismatchedNames : [context.previousPlayer].filter(Boolean),
  };
}

module.exports = {
  buildStandardActionOptions,
  buildFallbackOptionsForPlayer,
  findMismatchedNames,
  getPreferredName,
  sanitizeOptionsForPlayer,
};
