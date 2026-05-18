'use strict';

function monsterSlugFromName(name) {
  return String(name || 'hostile-creature')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'hostile-creature';
}

function normalizePlaceholderText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ');
}

function isPlaceholderEnemyName(value) {
  const text = normalizePlaceholderText(value);
  if (!text) return true;
  if (/^[-–—]+$/.test(text)) return true;
  return /^(?:none|null|undefined|n\/a|na|nothing|no enemy|no enemies|no hostile|no hostiles|no hostile creatures|no combat|not applicable)$/i.test(text);
}

function looksLikePlayerActionText(value) {
  const text = String(value || '').trim();
  const lower = text.toLowerCase();
  if (!text) return false;
  if (/^(?:approach|ask|talk|speak|explain|offer|negotiate|parley|persuade|convince|bargain|search|inspect|investigate|move|press|continue|proceed|head|travel|follow)\b/i.test(text)) {
    return true;
  }
  if (/\b(?:ask for|offer peace|make your case|seek passage|safe passage|goods|lead|terms|cooperate|cooperation)\b/i.test(lower)) {
    return true;
  }
  const words = lower.split(/\s+/).filter(Boolean);
  return words.length >= 8 && /[.!?;:]/.test(text);
}

function normalizeEnemyEntry(entry = {}) {
  const displayName = String(entry.displayName || entry.name || entry.slug || '').trim();
  const rawSlug = String(entry.slug || '').trim();
  if (
    isPlaceholderEnemyName(displayName) ||
    (rawSlug && isPlaceholderEnemyName(rawSlug)) ||
    looksLikePlayerActionText(displayName)
  ) return null;

  const customSlug = monsterSlugFromName(displayName);
  const slug = rawSlug && rawSlug !== 'custom' ? rawSlug : customSlug;
  return {
    displayName,
    count: Math.max(1, Number(entry.count) || 1),
    slug,
    hint: entry.hint || (rawSlug === 'custom' ? displayName : null),
  };
}

function normalizeEnemyEntries(entries = []) {
  return (entries || []).map(normalizeEnemyEntry).filter(Boolean);
}

module.exports = {
  monsterSlugFromName,
  isPlaceholderEnemyName,
  looksLikePlayerActionText,
  normalizeEnemyEntry,
  normalizeEnemyEntries,
};
