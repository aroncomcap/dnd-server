'use strict';

// ---------------------------------------------------------------------------
// CLI test harness for encounter-designer.js
// Usage: node test-encounter-designer.js [scenario]
// Scenarios: standard-party | low-level | high-level | solo | all
// ---------------------------------------------------------------------------

const path = require('path');
const { calculatePartyDPR, designAdventuringDay, FEROCITY } = require('./encounter-designer');
const monsterDB = require('./monsters/monsters-5e-srd.json');

// ---------------------------------------------------------------------------
// Party fixtures
// ---------------------------------------------------------------------------

const PARTIES = {
  'standard-party': {
    label: 'Standard Party (Level 5)',
    ferocity: 3,
    pillars: { combat: 33, social: 33, exploration: 34 },
    members: [
      {
        name: 'Fighter',
        id: 'fighter',
        system: 'dnd5e',
        class: 'fighter',
        level: 5,
        ac: 17,
        hp: 44,
        maxHp: 44,
        abilities: { str: 18, dex: 13, con: 16, int: 9, wis: 11, cha: 10 },
        proficiencyBonus: 3,
        weapons: [
          { name: 'Longsword', attackMod: 7, damage: '1d8+4', damageType: 'slashing', properties: ['versatile'] },
        ],
        spells: [],
        spellSlots: {},
        spellcastingAbility: null,
        features: ['Extra Attack', 'Action Surge', 'Second Wind'],
      },
      {
        name: 'Cleric',
        id: 'cleric',
        system: 'dnd5e',
        class: 'cleric',
        level: 5,
        ac: 16,
        hp: 38,
        maxHp: 38,
        abilities: { str: 14, dex: 10, con: 14, int: 11, wis: 18, cha: 12 },
        proficiencyBonus: 3,
        weapons: [
          { name: 'Mace', attackMod: 5, damage: '1d6+2', damageType: 'bludgeoning', properties: [] },
        ],
        spells: [
          { name: 'Guiding Bolt', level: 1, damage: '4d6', damageType: 'radiant', save: null },
          { name: 'Spiritual Weapon', level: 2, damage: '1d8+4', damageType: 'force', save: null },
          { name: 'Flame Strike', level: 5, damage: '4d6+4d6', damageType: 'fire+radiant', save: 'dex' },
        ],
        spellSlots: { 1: 4, 2: 3, 3: 2 },
        spellcastingAbility: 'wis',
        features: ['Channel Divinity', 'Divine Strike'],
      },
      {
        name: 'Rogue',
        id: 'rogue',
        system: 'dnd5e',
        class: 'rogue',
        level: 5,
        ac: 15,
        hp: 33,
        maxHp: 33,
        abilities: { str: 10, dex: 18, con: 13, int: 13, wis: 11, cha: 12 },
        proficiencyBonus: 3,
        weapons: [
          { name: 'Rapier', attackMod: 7, damage: '1d8+4', damageType: 'piercing', properties: ['finesse'] },
        ],
        spells: [],
        spellSlots: {},
        spellcastingAbility: null,
        features: ['Sneak Attack 3d6', 'Uncanny Dodge', 'Evasion', 'Cunning Action'],
      },
      {
        name: 'Wizard',
        id: 'wizard',
        system: 'dnd5e',
        class: 'wizard',
        level: 5,
        ac: 12,
        hp: 26,
        maxHp: 26,
        abilities: { str: 8, dex: 14, con: 12, int: 18, wis: 12, cha: 10 },
        proficiencyBonus: 3,
        weapons: [],
        spells: [
          { name: 'Fire Bolt',  level: 0, damage: '2d10', damageType: 'fire', save: null },
          { name: 'Fireball',   level: 3, damage: '8d6',  damageType: 'fire', save: 'dex' },
          { name: 'Scorching Ray', level: 2, damage: '2d6+2d6+2d6', damageType: 'fire', save: null },
        ],
        spellSlots: { 1: 4, 2: 3, 3: 2 },
        spellcastingAbility: 'int',
        features: ['Arcane Recovery'],
      },
    ],
  },

  'low-level': {
    label: 'Low-Level Party (Level 1)',
    ferocity: 5,
    pillars: { combat: 50, social: 25, exploration: 25 },
    members: [
      {
        name: 'Fighter',
        id: 'fighter-l1',
        system: 'dnd5e',
        class: 'fighter',
        level: 1,
        ac: 16,
        hp: 12,
        maxHp: 12,
        abilities: { str: 16, dex: 12, con: 15, int: 9, wis: 10, cha: 9 },
        proficiencyBonus: 2,
        weapons: [
          { name: 'Longsword', attackMod: 5, damage: '1d8+3', damageType: 'slashing', properties: ['versatile'] },
        ],
        spells: [],
        spellSlots: {},
        spellcastingAbility: null,
        features: ['Second Wind'],
      },
      {
        name: 'Cleric',
        id: 'cleric-l1',
        system: 'dnd5e',
        class: 'cleric',
        level: 1,
        ac: 14,
        hp: 9,
        maxHp: 9,
        abilities: { str: 13, dex: 10, con: 12, int: 10, wis: 16, cha: 11 },
        proficiencyBonus: 2,
        weapons: [
          { name: 'Mace', attackMod: 3, damage: '1d6+1', damageType: 'bludgeoning', properties: [] },
        ],
        spells: [
          { name: 'Guiding Bolt', level: 1, damage: '4d6', damageType: 'radiant', save: null },
          { name: 'Sacred Flame', level: 0, damage: '1d8', damageType: 'radiant', save: 'dex' },
        ],
        spellSlots: { 1: 2 },
        spellcastingAbility: 'wis',
        features: ['Channel Divinity'],
      },
      {
        name: 'Rogue',
        id: 'rogue-l1',
        system: 'dnd5e',
        class: 'rogue',
        level: 1,
        ac: 14,
        hp: 8,
        maxHp: 8,
        abilities: { str: 10, dex: 16, con: 11, int: 12, wis: 10, cha: 11 },
        proficiencyBonus: 2,
        weapons: [
          { name: 'Shortsword', attackMod: 5, damage: '1d6+3', damageType: 'piercing', properties: ['finesse', 'light'] },
        ],
        spells: [],
        spellSlots: {},
        spellcastingAbility: null,
        features: ['Sneak Attack 1d6', 'Cunning Action'],
      },
      {
        name: 'Wizard',
        id: 'wizard-l1',
        system: 'dnd5e',
        class: 'wizard',
        level: 1,
        ac: 11,
        hp: 7,
        maxHp: 7,
        abilities: { str: 8, dex: 12, con: 10, int: 16, wis: 11, cha: 10 },
        proficiencyBonus: 2,
        weapons: [],
        spells: [
          { name: 'Fire Bolt',    level: 0, damage: '1d10', damageType: 'fire', save: null },
          { name: 'Magic Missile', level: 1, damage: '3d4+3', damageType: 'force', save: null },
          { name: 'Burning Hands', level: 1, damage: '3d6', damageType: 'fire', save: 'dex' },
        ],
        spellSlots: { 1: 2 },
        spellcastingAbility: 'int',
        features: [],
      },
    ],
  },

  'high-level': {
    label: 'High-Level Party (Level 10)',
    ferocity: 1,
    pillars: { combat: 50, social: 20, exploration: 30 },
    members: [
      {
        name: 'Fighter',
        id: 'fighter-l10',
        system: 'dnd5e',
        class: 'fighter',
        level: 10,
        ac: 19,
        hp: 88,
        maxHp: 88,
        abilities: { str: 20, dex: 14, con: 18, int: 10, wis: 12, cha: 10 },
        proficiencyBonus: 4,
        weapons: [
          { name: 'Greatsword +2', attackMod: 11, damage: '2d6+7', damageType: 'slashing', properties: ['heavy', 'two-handed'] },
        ],
        spells: [],
        spellSlots: {},
        spellcastingAbility: null,
        features: ['Extra Attack', 'Indomitable', 'Action Surge', 'Second Wind'],
      },
      {
        name: 'Cleric',
        id: 'cleric-l10',
        system: 'dnd5e',
        class: 'cleric',
        level: 10,
        ac: 18,
        hp: 70,
        maxHp: 70,
        abilities: { str: 14, dex: 10, con: 15, int: 11, wis: 20, cha: 13 },
        proficiencyBonus: 4,
        weapons: [
          { name: 'War Pick', attackMod: 6, damage: '1d8+2', damageType: 'piercing', properties: [] },
        ],
        spells: [
          { name: 'Guiding Bolt', level: 1, damage: '4d6', damageType: 'radiant', save: null },
          { name: 'Holy Aura',    level: 8, damage: '4d6', damageType: 'radiant', save: 'str' },
          { name: 'Flame Strike', level: 5, damage: '4d6+4d6', damageType: 'fire+radiant', save: 'dex' },
        ],
        spellSlots: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 },
        spellcastingAbility: 'wis',
        features: ['Channel Divinity', 'Divine Strike', 'Divine Intervention'],
      },
      {
        name: 'Rogue',
        id: 'rogue-l10',
        system: 'dnd5e',
        class: 'rogue',
        level: 10,
        ac: 16,
        hp: 65,
        maxHp: 65,
        abilities: { str: 10, dex: 20, con: 14, int: 14, wis: 12, cha: 12 },
        proficiencyBonus: 4,
        weapons: [
          { name: 'Rapier +1', attackMod: 10, damage: '1d8+6', damageType: 'piercing', properties: ['finesse'] },
        ],
        spells: [],
        spellSlots: {},
        spellcastingAbility: null,
        features: ['Sneak Attack 5d6', 'Uncanny Dodge', 'Evasion', 'Cunning Action', 'Elusive'],
      },
      {
        name: 'Wizard',
        id: 'wizard-l10',
        system: 'dnd5e',
        class: 'wizard',
        level: 10,
        ac: 13,
        hp: 52,
        maxHp: 52,
        abilities: { str: 8, dex: 14, con: 13, int: 20, wis: 13, cha: 10 },
        proficiencyBonus: 4,
        weapons: [],
        spells: [
          { name: 'Fire Bolt',      level: 0,  damage: '3d10', damageType: 'fire', save: null },
          { name: 'Fireball',       level: 3,  damage: '8d6',  damageType: 'fire', save: 'dex' },
          { name: 'Cone of Cold',   level: 5,  damage: '8d8',  damageType: 'cold', save: 'con' },
          { name: 'Disintegrate',   level: 6,  damage: '10d6+40', damageType: 'force', save: 'dex' },
        ],
        spellSlots: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 },
        spellcastingAbility: 'int',
        features: ['Arcane Recovery', 'Sculpt Spells', 'Empowered Evocation'],
      },
    ],
  },

  'solo': {
    label: 'Solo Fighter (Level 5)',
    ferocity: 3,
    pillars: { combat: 60, social: 20, exploration: 20 },
    members: [
      {
        name: 'Fighter',
        id: 'fighter-solo',
        system: 'dnd5e',
        class: 'fighter',
        level: 5,
        ac: 18,
        hp: 52,
        maxHp: 52,
        abilities: { str: 18, dex: 13, con: 16, int: 10, wis: 11, cha: 10 },
        proficiencyBonus: 3,
        weapons: [
          { name: 'Longsword', attackMod: 7, damage: '1d8+4', damageType: 'slashing', properties: ['versatile'] },
          { name: 'Hand Crossbow', attackMod: 4, damage: '1d6+1', damageType: 'piercing', properties: ['ranged', 'light'] },
        ],
        spells: [],
        spellSlots: {},
        spellcastingAbility: null,
        features: ['Extra Attack', 'Action Surge', 'Second Wind', 'Indomitable'],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const PILLAR_ICONS = {
  combat:      '⚔️ ',
  social:      '💬',
  exploration: '🗺️ ',
  rest:        '',
};

function formatDifficultyLabel(ferocity) {
  return (FEROCITY[ferocity] || {}).label || 'Unknown';
}

function formatEncounterLine(enc, idx) {
  const num = String(idx).padStart(2, ' ');

  if (enc.pillar === 'combat') {
    const monsterStr = (enc.monsters || [])
      .map(m => `${m.count}x ${m.name}`)
      .join(' + ');
    const hp    = enc.totalMonsterHP || 0;
    const rnd   = enc.estimatedRounds || '?';
    const diff  = formatDifficultyLabel(enc.ferocity).toLowerCase();
    const label = enc.position === 'boss' ? 'Combat/Boss' : 'Combat';
    return `  ${num}. [${PILLAR_ICONS.combat} ${label}] ${monsterStr || 'TBD'} — ${hp} HP, est. ${rnd} rounds (${diff})`;
  }

  if (enc.pillar === 'social') {
    const rolls = `${enc.successesNeeded} successes before ${enc.maxFailures} failures`;
    return `  ${num}. [${PILLAR_ICONS.social} Social] ${enc.type} — DC ${enc.dc}, ${rolls}`;
  }

  if (enc.pillar === 'exploration') {
    return `  ${num}. [${PILLAR_ICONS.exploration} Exploration] ${enc.type} — DC ${enc.detectionDC}, ${enc.trapDice} damage`;
  }

  return '';
}

function formatRestLine(rest) {
  if (rest.type === 'short') return '     → ☕ Short Rest';
  if (rest.type === 'long')  return '     → 🛏️  Long Rest';
  return '';
}

function formatDPRBreakdown(dprResult, partyStats) {
  const lines = [];
  let totalHP = 0;

  for (let i = 0; i < dprResult.characters.length; i++) {
    const c  = dprResult.characters[i];
    const cs = partyStats[i];
    const lvl = cs.level || '?';
    const cls = (cs.class || 'Unknown');
    const clsLabel = cls.charAt(0).toUpperCase() + cls.slice(1);

    // Build a note about primary damage source
    let note = '';
    if (cs.weapons && cs.weapons.length > 0) {
      const w = cs.weapons[0];
      const hasExtra = (cs.features || []).some(f => /extra attack/i.test(f));
      const sneak = (cs.features || []).find(f => /sneak attack (\d+d6)/i.test(f));
      if (sneak) {
        const m = sneak.match(/sneak attack (\d+d6)/i);
        note = `${w.name} + Sneak Attack ${m ? m[1] : ''}`;
      } else if (hasExtra) {
        note = `${w.name} + Extra Attack`;
      } else {
        note = w.name;
      }
    } else if (cs.spells && cs.spells.length > 0) {
      const cantrip = cs.spells.find(s => s.level === 0);
      const best    = cs.spells.filter(s => s.level > 0).sort((a, b) => b.level - a.level)[0];
      if (cantrip && best) note = `${cantrip.name} + ${best.name} amortized`;
      else if (cantrip) note = cantrip.name;
      else if (best)    note = best.name;
    }

    lines.push(`  ${c.name} (Lv${lvl}): ${c.effectiveDPR} DPR${note ? ' (' + note + ')' : ''}`);
    totalHP += cs.maxHp || cs.hp || 0;
  }

  lines.push(`  Total Party DPR: ${dprResult.totalDPR} | Party HP: ${totalHP}`);
  return { lines, totalHP };
}

// ---------------------------------------------------------------------------
// Run a single scenario
// ---------------------------------------------------------------------------

function runScenario(key) {
  const scenario = PARTIES[key];
  if (!scenario) {
    console.error(`Unknown scenario: ${key}`);
    console.error(`Available: ${Object.keys(PARTIES).join(', ')}, all`);
    process.exit(1);
  }

  const { label, ferocity, pillars, members } = scenario;
  const ferocityLabel = formatDifficultyLabel(ferocity);

  console.log('');
  console.log(`${'═'.repeat(3)} SCENARIO: ${label} ${'═'.repeat(3)}`);
  console.log('');

  // --- DPR Analysis ---
  console.log('Party DPR Analysis:');
  const dprResult = calculatePartyDPR(members);
  const { lines: dprLines, totalHP } = formatDPRBreakdown(dprResult, members);
  dprLines.forEach(l => console.log(l));
  console.log('');

  // --- Adventuring Day ---
  const pillarStr = `E${pillars.exploration}/C${pillars.combat}/S${pillars.social}`;
  console.log(`Adventuring Day (Ferocity ${ferocity}/${ferocityLabel}, Pillars ${pillarStr}):`);

  const plan = designAdventuringDay(members, ferocity, pillars, monsterDB);
  const { encounters, summary } = plan;

  let encIdx = 0;
  for (const enc of encounters) {
    if (enc.pillar === 'rest') {
      console.log(formatRestLine(enc));
    } else {
      encIdx += 1;
      console.log(formatEncounterLine(enc, encIdx));
    }
  }

  console.log('');

  // --- Summary ---
  const combatEncs = encounters.filter(e => e.pillar === 'combat');
  const socialEncs = encounters.filter(e => e.pillar === 'social');
  const exploEncs  = encounters.filter(e => e.pillar === 'exploration');
  const shortRests = encounters.filter(e => e.pillar === 'rest' && e.type === 'short');
  const longRests  = encounters.filter(e => e.pillar === 'rest' && e.type === 'long');

  const totalMonsterHP = combatEncs.reduce((sum, e) => sum + (e.totalMonsterHP || 0), 0);
  const totalRounds    = combatEncs.reduce((sum, e) => sum + (e.estimatedRounds || 0), 0);

  // Estimated HP drain: total monster DPR × rounds / party HP
  const totalMonsterDPR = combatEncs.reduce((sum, e) => sum + (e.totalMonsterDPR || 0), 0);
  const hpDrainPct = totalHP > 0
    ? Math.min(100, Math.round(totalMonsterDPR * totalRounds / totalHP * 100))
    : 0;

  console.log('Summary:');
  console.log(`  Encounters: ${summary.totalEncounters} (Combat ${summary.combatCount}, Social ${summary.socialCount}, Exploration ${summary.explorationCount})`);
  console.log(`  Short Rests: ${shortRests.length} | Long Rests: ${longRests.length}`);
  console.log(`  Total Monster HP: ${totalMonsterHP}`);
  console.log(`  Est. Total Combat Rounds: ${Math.round(totalRounds * 10) / 10}`);
  console.log(`  Est. Party HP Drain: ${hpDrainPct}%`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const arg = process.argv[2] || 'standard-party';

if (arg === 'all') {
  for (const key of Object.keys(PARTIES)) {
    runScenario(key);
  }
} else {
  runScenario(arg);
}
