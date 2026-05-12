function normalizeNarrationWhitespace(text) {
  return String(text || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+\./g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+\n/g, '\n')
    .trim();
}

function cleanInvalidCombatNarration(text) {
  let cleaned = String(text || '');

  cleaned = cleaned.replace(
    /\b([^.\n]*?\bcasts\s+[^—.\n]+)\s+—\s+rolls\s+(?:—|-|unknown)\s*,?\s*HIT!?\s*No immediate damage\./gi,
    '$1. No immediate damage.'
  );

  cleaned = cleaned.replace(
    /\b([^.\n]*?)\s+—\s+rolls\s+unknown\.?\s+HIT\/MISS!\s+Damage unknown\.?\s+target unknown\.?\s*/gi,
    '$1. '
  );

  return normalizeNarrationWhitespace(cleaned);
}

module.exports = {
  cleanInvalidCombatNarration,
};
