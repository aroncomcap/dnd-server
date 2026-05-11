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

function buildFallbackOptionsForPlayer(targetPlayer) {
  const name = String(targetPlayer || 'The next hero').trim() || 'The next hero';
  const firstName = name.split(/\s+/)[0] || name;

  return [
    `🗡️ ${firstName} takes point and checks the immediate danger.`,
    `🛡️ ${firstName} regroups with the party and protects anyone exposed.`,
    `🔥 ${firstName} tries a bold move using the scene's strange details.`,
  ];
}

function sanitizeOptionsForPlayer(options, targetPlayer, partyNames) {
  const cleanOptions = Array.isArray(options)
    ? options.filter(option => typeof option === 'string' && option.trim()).slice(0, 3)
    : [];

  if (!targetPlayer || cleanOptions.length === 0) {
    return { options: cleanOptions, retargeted: false, mismatchedNames: [] };
  }

  const mismatchedNames = findMismatchedNames(cleanOptions, targetPlayer, partyNames);
  if (mismatchedNames.length === 0) {
    return { options: cleanOptions, retargeted: false, mismatchedNames: [] };
  }

  return {
    options: buildFallbackOptionsForPlayer(targetPlayer),
    retargeted: true,
    mismatchedNames,
  };
}

module.exports = {
  buildFallbackOptionsForPlayer,
  findMismatchedNames,
  sanitizeOptionsForPlayer,
};
