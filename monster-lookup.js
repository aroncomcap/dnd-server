'use strict';

const path = require('path');
const fs = require('fs');

// ── In-memory cache ──────────────────────────────────────────────────────────
const cache = {};

// System slug → JSON filename mapping (primary + overlay with personality data)
const SYSTEM_FILES = {
  dnd5e:      'monsters-srd-2014.json',   // 321 SRD creatures from Open5e
  runequest:  'monsters-rq-core.json',
};
const OVERLAY_FILES = {
  dnd5e:      'monsters-5e-srd.json',     // 84 hand-built with personality/tactics/morale
};

/**
 * Load default monsters for a system from JSON file (cached after first load).
 * @param {string} system - 'dnd5e' or 'runequest'
 * @returns {object} Object keyed by monster slug
 */
function loadDefaultMonsters(system) {
  if (cache[system]) return cache[system];

  const filename = SYSTEM_FILES[system];
  if (!filename) {
    throw new Error(`Unknown system: ${system}. Supported: ${Object.keys(SYSTEM_FILES).join(', ')}`);
  }

  // Load base monsters (Open5e import — stats only)
  const filePath = path.join(__dirname, 'monsters', filename);
  const base = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  // Merge overlay if exists (hand-built personality/tactics/morale data)
  const overlayFile = OVERLAY_FILES[system];
  if (overlayFile) {
    try {
      const overlayPath = path.join(__dirname, 'monsters', overlayFile);
      const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
      for (const [slug, data] of Object.entries(overlay)) {
        if (base[slug]) {
          // Overlay has personality data — merge it onto the base stats
          if (data.personality) base[slug].personality = data.personality;
          if (data.combatStyle) base[slug].combatStyle = data.combatStyle;
          if (data.tactics) base[slug].tactics = data.tactics;
          if (data.morale) base[slug].morale = data.morale;
        } else {
          // Overlay has a monster not in base — add it entirely
          base[slug] = data;
        }
      }
    } catch (e) {
      // Overlay file missing or invalid — proceed with base only
    }
  }

  cache[system] = base;
  return cache[system];
}

/**
 * Generate monster stats with AI (Haiku).
 * @param {string} slug - Monster slug (e.g. "goblin")
 * @param {string} system - Game system
 * @param {object} anthropic - Anthropic client instance
 * @param {string|null} hint - Optional description hint
 * @returns {object|null} Monster data object or null on failure
 */
async function generateMonsterWithAI(slug, system, anthropic, hint = null) {
  const name = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const schemas = {
    dnd5e: `{
  "name": string, "cr": number, "ac": number, "hp": number, "maxHp": number, "speed": number,
  "abilities": { "str": int, "dex": int, "con": int, "int": int, "wis": int, "cha": int },
  "saveProficiencies": string[], "proficiencyBonus": int,
  "weapons": [{ "name": string, "attackMod": string, "damage": string, "damageType": string, "properties": string[] }],
  "spells": [], "spellSlots": {}, "features": string[],
  "conditions": [], "resistances": string[], "vulnerabilities": string[], "immunities": string[]
}`,
    runequest: `{
  "name": string,
  "characteristics": { "str": int, "con": int, "siz": int, "int": int, "pow": int, "dex": int, "cha": int },
  "hitLocations": { "head": {"hp": int, "maxHp": int, "armor": int}, "chest": {"hp": int, "maxHp": int, "armor": int}, "abdomen": {"hp": int, "maxHp": int, "armor": int}, "left-arm": {"hp": int, "maxHp": int, "armor": int}, "right-arm": {"hp": int, "maxHp": int, "armor": int}, "left-leg": {"hp": int, "maxHp": int, "armor": int}, "right-leg": {"hp": int, "maxHp": int, "armor": int} },
  "totalHp": int,
  "weapons": [{ "name": string, "skill": int, "damage": string, "sr": int }],
  "skills": { "dodge": int },
  "conditions": [], "runePoints": int, "maxRunePoints": int, "magicPoints": int, "maxMagicPoints": int,
  "runeSpells": string[], "spiritSpells": string[], "strikeRank": int
}`,
  };

  const schema = schemas[system] || schemas.dnd5e;
  const systemLabel = system === 'runequest' ? 'RuneQuest Glorantha' : 'D&D 5e SRD';

  const prompt = [
    `Generate accurate ${systemLabel} stats for the monster: "${name}"`,
    hint ? `Hint: ${hint}` : null,
    `Return ONLY valid JSON matching this schema exactly:`,
    schema,
    `No markdown, no explanation, just the JSON object.`,
  ].filter(Boolean).join('\n');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '';
    // Strip potential markdown fences
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(jsonText);
  } catch (err) {
    console.error(`[monster-lookup] AI generation failed for "${slug}":`, err.message);
    return null;
  }
}

/**
 * Layered monster lookup:
 * 1. DB (game_monster_sources) — unless skipDB
 * 2. System default JSON
 * 3. AI generation — unless skipAI
 *
 * @param {string} gameId
 * @param {string} system - 'dnd5e' or 'runequest'
 * @param {string} slug - Monster slug
 * @param {object} options
 * @param {object} [options.db] - db module (needs getMonsterFromSources, saveMonsterToGameOverrides)
 * @param {object} [options.anthropic] - Anthropic client
 * @param {boolean} [options.skipDB=false]
 * @param {boolean} [options.skipAI=false]
 * @param {string|null} [options.hint=null] - Hint passed to AI if generated
 * @returns {object|null} Monster data or null
 */
async function getMonsterStats(gameId, system, slug, options = {}) {
  const { db, anthropic, skipDB = false, skipAI = false, hint = null } = options;

  // 1. DB lookup
  if (!skipDB && db) {
    try {
      const dbMonster = await db.getMonsterFromSources(gameId, slug);
      if (dbMonster) return dbMonster;
    } catch (err) {
      console.error(`[monster-lookup] DB lookup failed for "${slug}":`, err.message);
    }
  }

  // 2. Default JSON
  try {
    const defaults = loadDefaultMonsters(system);
    if (defaults[slug]) return defaults[slug];
  } catch (err) {
    // Unknown system — skip silently
  }

  // 3. AI generation
  if (!skipAI && anthropic) {
    const generated = await generateMonsterWithAI(slug, system, anthropic, hint);
    if (generated) {
      // Persist to game overrides if DB available
      if (!skipDB && db) {
        try {
          await db.saveMonsterToGameOverrides(gameId, slug, generated);
        } catch (err) {
          console.error(`[monster-lookup] Failed to save AI monster to DB:`, err.message);
        }
      }
      return generated;
    }
  }

  return null;
}

module.exports = { getMonsterStats, loadDefaultMonsters, generateMonsterWithAI };
