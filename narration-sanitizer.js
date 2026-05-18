function normalizeNarrationWhitespace(text) {
  return String(text || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+\./g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+\n/g, '\n')
    .trim();
}

function stripLeakedInlineOptions(text) {
  let cleaned = String(text || '').replace(
    /\s*1\uFE0F?\u20E3\s+\S[\s\S]*?2\uFE0F?\u20E3\s+\S[\s\S]*?(?:3\uFE0F?\u20E3\s+\S[\s\S]*)?$/u,
    ''
  );
  cleaned = cleaned.replace(/\s*1(?:\uFE0F?\u20E3|[.)])\s+\S[\s\S]*?2(?:\uFE0F?\u20E3|[.)])\s+\S[\s\S]*$/u, '');
  cleaned = cleaned.replace(/\s*1(?:\uFE0F?\u20E3|[.)])\s+\S[\s\S]*$/u, '');
  return cleaned;
}

function stripMalformedStructuredMarkerTail(text) {
  return String(text || '')
    .replace(/\s*(?:-{0,3}\s*)?(?:OPTIONS|SCENE|WORLD)\s*-{2,}[\s\S]*$/i, '')
    .replace(/\s*\bOPTIONS\s*$/i, '')
    .replace(/\s*\bAction:\s*[^.]*\s+Mood:\s*[^.]*\s+NPC:\s*[\s\S]*$/i, '');
}

function stripInlineEnemyBlocks(text) {
  return String(text || '').replace(/\s*\bENEMIES\s*:\s*[^.\n]*(?:\.|$)/gi, '');
}

function stripUnsupportedCheckResultLabels(text) {
  let cleaned = String(text || '').replace(
    /\b(?:(?:(?:Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma|Athletics|Acrobatics|Sleight of Hand|Stealth|Arcana|History|Investigation|Nature|Religion|Animal Handling|Insight|Medicine|Perception|Survival|Deception|Intimidation|Performance|Persuasion)\s+(?:check|contest|save)\s+(?:succeeds?|fails?|passes?|lands?|works?))|Investigation payoff|Social pressure lands?|Last-second pressure works?|Improvised grapple fails?)\s*(?:—|-|:)\s*/gi,
    ''
  );
  cleaned = cleaned.replace(
    /\b(?:NO ROLL|(?:STR|DEX|CON|INT|WIS|CHA)\s+(?:check|contest|save)\s+implied|(?:ATHLETICS|ACROBATICS|STEALTH|ARCANA|HISTORY|INVESTIGATION|INSIGHT|PERCEPTION|SURVIVAL|DECEPTION|INTIMIDATION|PERSUASION|CHALLENGE)(?:\/(?:ATHLETICS|ACROBATICS|STEALTH|ARCANA|HISTORY|INVESTIGATION|INSIGHT|PERCEPTION|SURVIVAL|DECEPTION|INTIMIDATION|PERSUASION|CHALLENGE))*)\s*(?:—|-|:)\s*/gi,
    ''
  );
  cleaned = cleaned.replace(/\b(?:str|dex|con|int|wis|cha|strength|dexterity|constitution|intelligence|wisdom|charisma)\s+save\s+needed\s*(?:—|-|:)\s*/gi, '');
  return cleaned;
}

function capitalizeSentenceStarts(text) {
  return String(text || '').replace(/(^|[.!?]\s+)([a-z])/g, (_, prefix, char) => `${prefix}${char.toUpperCase()}`);
}

function cleanInvalidCombatNarration(text) {
  let cleaned = String(text || '');

  cleaned = stripLeakedInlineOptions(cleaned);
  cleaned = stripMalformedStructuredMarkerTail(cleaned);
  cleaned = stripInlineEnemyBlocks(cleaned);
  cleaned = stripUnsupportedCheckResultLabels(cleaned);

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

  cleaned = cleaned.replace(/\b\d+d\d+\s*(?:[+-]\s*)?\?\s*/gi, '');
  cleaned = cleaned.replace(/\bNo roll(?: this turn)?\.?\s*/gi, '');

  return capitalizeSentenceStarts(normalizeNarrationWhitespace(cleaned));
}

module.exports = {
  cleanInvalidCombatNarration,
};
