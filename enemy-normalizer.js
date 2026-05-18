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
  return /^(?:none|null|undefined|n\/a|na|nothing|no enemy|no enemies|no hostile|no hostiles|no hostile creatures|no combat|not applicable)$/i.test(text);
}

function normalizeEnemyEntry(entry = {}) {
  const displayName = String(entry.displayName || entry.name || entry.slug || '').trim();
  const rawSlug = String(entry.slug || '').trim();
  if (isPlaceholderEnemyName(displayName) || isPlaceholderEnemyName(rawSlug)) return null;

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
  normalizeEnemyEntry,
  normalizeEnemyEntries,
};
