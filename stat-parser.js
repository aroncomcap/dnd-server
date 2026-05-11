'use strict';

const llm = require('./llm');

// ---------------------------------------------------------------------------
// Schemas — describe the expected shape of combatStats for each system
// ---------------------------------------------------------------------------

const DND5E_SCHEMA = {
  system: 'dnd5e',
  level: 'number',
  ac: 'number',
  hp: 'number',
  maxHp: 'number',
  speed: 'number (default 30)',
  abilities: '{ str, dex, con, int, wis, cha } — each a number',
  saveProficiencies: 'array of ability names',
  proficiencyBonus: 'number',
  weapons: '[{ name, attackMod, damage, damageType, properties }]',
  spells: '[{ name, level, save?, damage?, damageType?, healing?, attack?, reaction?, concentration?, effect? }]',
  spellSlots: '{ 1: count, 2: count, ... }',
  spellcastingAbility: '"int"|"wis"|"cha" or null',
  features: 'array of strings',
};

const RUNEQUEST_SCHEMA = {
  system: 'runequest',
  characteristics: '{ str, con, siz, int, pow, dex, cha }',
  hitLocations: '{ head, chest, abdomen, rightArm, leftArm, rightLeg, leftLeg } — each { hp, maxHp, armor }',
  totalHp: 'number',
  weapons: '[{ name, skill: number, damage: dice, sr?, parry? }]',
  runePoints: 'number',
  maxRunePoints: 'number',
  magicPoints: 'number',
  maxMagicPoints: 'number',
  runeSpells: '[{ name, cost, effect }]',
  spiritSpells: '[{ name, cost, effect }]',
  skills: '{ dodge: number, ... }',
  strikeRank: 'number',
};

// ---------------------------------------------------------------------------
// Defaults applied after parsing
// ---------------------------------------------------------------------------

const DND5E_DEFAULTS = {
  conditions: [],
  concentrating: null,
  deathSaves: { successes: 0, failures: 0 },
  inspiration: false,
  resistances: [],
  vulnerabilities: [],
  immunities: [],
  speed: 30,
};

const RUNEQUEST_DEFAULTS = {
  conditions: [],
  runeSpells: [],
  spiritSpells: [],
  skills: {},
};

// ---------------------------------------------------------------------------
// Mock results (for testing without API)
// ---------------------------------------------------------------------------

function mockDnd5e() {
  return {
    system: 'dnd5e',
    level: 5,
    ac: 16,
    hp: 38,
    maxHp: 38,
    speed: 30,
    abilities: { str: 18, dex: 14, con: 16, int: 10, wis: 12, cha: 10 },
    saveProficiencies: ['str', 'con'],
    proficiencyBonus: 3,
    weapons: [
      { name: 'Longsword', attackMod: 7, damage: '1d8+4', damageType: 'slashing', properties: ['versatile'] },
    ],
    spells: [],
    spellSlots: {},
    spellcastingAbility: null,
    features: ['Action Surge', 'Second Wind', 'Extra Attack'],
  };
}

function mockRunequest() {
  return {
    system: 'runequest',
    characteristics: { str: 14, con: 13, siz: 12, int: 11, pow: 10, dex: 15, cha: 10 },
    hitLocations: {
      head:     { hp: 4, maxHp: 4, armor: 3 },
      chest:    { hp: 6, maxHp: 6, armor: 4 },
      abdomen:  { hp: 5, maxHp: 5, armor: 4 },
      rightArm: { hp: 3, maxHp: 3, armor: 3 },
      leftArm:  { hp: 3, maxHp: 3, armor: 3 },
      rightLeg: { hp: 4, maxHp: 4, armor: 3 },
      leftLeg:  { hp: 4, maxHp: 4, armor: 3 },
    },
    totalHp: 13,
    weapons: [
      { name: 'Broadsword', skill: 65, damage: '1d8+1', sr: 3, parry: true },
    ],
    runePoints: 3,
    maxRunePoints: 3,
    magicPoints: 10,
    maxMagicPoints: 10,
    runeSpells: [],
    spiritSpells: [{ name: 'Bladesharp 2', cost: 2, effect: '+2 attack, +4% damage' }],
    skills: { dodge: 35, scan: 45 },
    strikeRank: 4,
  };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPrompt(statsText, system) {
  const schema = system === 'runequest' ? RUNEQUEST_SCHEMA : DND5E_SCHEMA;
  return [
    `Extract structured combat stats from the following character description.`,
    ``,
    `Return ONLY valid JSON matching this schema (no markdown fences, no explanation):`,
    `${JSON.stringify(schema, null, 2)}`,
    ``,
    `Character stats:`,
    statsText,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Apply defaults — fills in missing top-level fields without overwriting
// ---------------------------------------------------------------------------

function applyDefaults(parsed, defaults) {
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in parsed)) {
      // Deep-clone arrays/objects so consumers can't mutate the defaults
      parsed[key] = JSON.parse(JSON.stringify(value));
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Parse free-form statsText into a structured combatStats object.
 *
 * @param {string} statsText   Raw character stat block text.
 * @param {'dnd5e'|'runequest'} system  Game system.
 * @param {{ mock?: boolean, gameId?: string }} [options]
 * @returns {Promise<object>}  Structured combatStats.
 */
async function parseStatsText(statsText, system, options = {}) {
  if (!statsText || typeof statsText !== 'string') {
    throw new TypeError('statsText must be a non-empty string');
  }
  if (system !== 'dnd5e' && system !== 'runequest') {
    throw new TypeError('system must be "dnd5e" or "runequest"');
  }

  let parsed;

  if (options.mock) {
    parsed = system === 'runequest' ? mockRunequest() : mockDnd5e();
  } else {
    const prompt = buildPrompt(statsText, system);
    const response = await llm.completeText({
      task: 'stat-parse',
      prompt,
      maxTokens: 1024,
      temperature: 0,
      gameId: options.gameId,
    });

    let raw = response.text.trim();

    // Strip markdown code fences if present
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    parsed = JSON.parse(raw);
  }

  // Ensure system field is always set correctly
  parsed.system = system;

  // Apply defaults for missing fields
  const defaults = system === 'runequest' ? RUNEQUEST_DEFAULTS : DND5E_DEFAULTS;
  applyDefaults(parsed, defaults);

  return parsed;
}

module.exports = { parseStatsText, DND5E_SCHEMA, RUNEQUEST_SCHEMA, buildPrompt };
