function normalizeNarrationWhitespace(text) {
  return String(text || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+\./g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+\n/g, '\n')
    .trim();
}

function stripLeakedInlineOptions(text) {
  return String(text || '').replace(
    /\s*1\uFE0F?\u20E3\s+\S[\s\S]*?2\uFE0F?\u20E3\s+\S[\s\S]*?(?:3\uFE0F?\u20E3\s+\S[\s\S]*)?$/u,
    ''
  );
}

function cleanInvalidCombatNarration(text) {
  let cleaned = String(text || '');

  cleaned = stripLeakedInlineOptions(cleaned);

  cleaned = cleaned.replace(
    /\b([^.\n]*?\bcasts\s+[^—.\n]+)\s+—\s+rolls\s+(?:—|-|unknown)\s*,?\s*HIT!?\s*No immediate damage\./gi,
    '$1. No immediate damage.'
  );

  cleaned = cleaned.replace(
    /\b([^.\n]*?)\s+—\s+rolls\s+unknown\.?\s+HIT\/MISS!\s+Damage unknown\.?\s+target unknown\.?\s*/gi,
    '$1. '
  );

  cleaned = cleaned.replace(
    /\b([^.\n]*?\b(?:cure wounds|healing word|bless|shield|guidance|bardic inspiration|dodge|help|dash|disengage|second wind)\b[^—.\n]*)\s+(?:—|-)\s+rolls?[^!\n]*(?:HIT|MISS)!?\s*/gi,
    '$1 '
  );

  return normalizeNarrationWhitespace(cleaned);
}

module.exports = {
  cleanInvalidCombatNarration,
};
