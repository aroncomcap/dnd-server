#!/usr/bin/env node
'use strict';

/**
 * Open5e Import Script — fetches creatures from the Open5e API and transforms
 * them into our monster schema.
 *
 * Usage:
 *   node import-open5e.js creatures srd-2014         # Import SRD 2014 creatures
 *   node import-open5e.js creatures srd-2014 --dry-run  # Preview without writing
 *   node import-open5e.js creatures tob               # Import Tome of Beasts
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OPEN5E_BASE = 'https://api.open5e.com/v2';
const PAGE_SIZE = 50;

const SOURCE_LABELS = {
  'srd-2014': 'D&D 5e SRD 2014',
  'tob': 'Tome of Beasts',
  'tob2': 'Tome of Beasts 2',
  'tob3': 'Tome of Beasts 3',
  'cc': 'Creature Codex',
};

// ── CLI parsing ───────────────────────────────────────────────────────────────

const [,, type, source, ...flags] = process.argv;
const dryRun = flags.includes('--dry-run');

if (!type || !source) {
  console.error('Usage: node import-open5e.js creatures <source> [--dry-run]');
  console.error('Sources: srd-2014, tob, tob2, tob3, cc');
  process.exit(1);
}

if (type !== 'creatures') {
  console.error(`Unknown type: ${type}. Only "creatures" is supported.`);
  process.exit(1);
}

const label = SOURCE_LABELS[source] || source;
console.log(`\nImporting ${label} creatures from Open5e...`);
if (dryRun) console.log('  [DRY RUN — no files will be written]\n');

// ── CR parsing ────────────────────────────────────────────────────────────────

function parseCR(cr) {
  if (typeof cr === 'number') return cr;
  if (!cr) return 0;
  const s = String(cr).trim();
  if (s === '1/8') return 0.125;
  if (s === '1/4') return 0.25;
  if (s === '1/2') return 0.5;
  return parseFloat(s) || 0;
}

// ── Speed parsing ─────────────────────────────────────────────────────────────

function parseSpeed(speed) {
  if (!speed) return 30;
  if (typeof speed === 'number') return speed;
  if (typeof speed === 'object') {
    return speed.walk || speed.swim || speed.fly || 30;
  }
  const m = String(speed).match(/(\d+)/);
  return m ? parseInt(m[1]) : 30;
}

// ── Action / weapon parsing ───────────────────────────────────────────────────

function parseActions(creature) {
  const weapons = [];
  const features = [];

  for (const action of (creature.actions || [])) {
    if (/multiattack/i.test(action.name || '')) {
      features.push('Multiattack');
      continue;
    }

    const desc = action.desc || action.description || '';

    // Look for attack bonus and damage in description
    const attackMatch = desc.match(/(\+\d+) to hit/i);
    const damageMatch = desc.match(/(\d+d\d+(?:\s*[+-]\s*\d+)?)\)?\s+(\w+)\s+damage/i);

    if (attackMatch && damageMatch) {
      const attackBonus = parseInt(attackMatch[1]);
      const strScore = creature.ability_scores?.strength ?? creature.strength ?? 10;
      const dexScore = creature.ability_scores?.dexterity ?? creature.dexterity ?? 10;
      const strMod = Math.floor((strScore - 10) / 2);
      const dexMod = Math.floor((dexScore - 10) / 2);
      const prof = creature.proficiency_bonus || 2;

      // Determine if str or dex based
      const attackMod = Math.abs(attackBonus - prof - strMod) <= 1 ? 'str' : 'dex';

      weapons.push({
        name: (action.name || 'attack').toLowerCase(),
        attackMod,
        damage: damageMatch[1].replace(/\s+/g, ''),
        damageType: damageMatch[2].toLowerCase(),
        properties: [],
      });
    } else if (action.attack_bonus !== undefined && action.damage_dice) {
      // Structured action data (some Open5e v2 endpoints provide this)
      const strScore = creature.ability_scores?.strength ?? creature.strength ?? 10;
      const dexScore = creature.ability_scores?.dexterity ?? creature.dexterity ?? 10;
      const strMod = Math.floor((strScore - 10) / 2);
      const prof = creature.proficiency_bonus || 2;
      const attackBonus = action.attack_bonus;
      const attackMod = Math.abs(attackBonus - prof - strMod) <= 1 ? 'str' : 'dex';

      weapons.push({
        name: (action.name || 'attack').toLowerCase(),
        attackMod,
        damage: action.damage_dice,
        damageType: (action.damage_type || 'bludgeoning').toLowerCase(),
        properties: [],
      });
    }
  }

  // Traits → features
  for (const trait of (creature.traits || [])) {
    if (trait.name && !/^(?:False Appearance|Languages)$/i.test(trait.name)) {
      features.push(trait.name);
    }
  }

  return { weapons, features };
}

// ── Saving throw proficiency parsing ─────────────────────────────────────────

function parseSaveProficiencies(creature) {
  const saveProficiencies = [];
  const saves = creature.saving_throws || {};
  const abilityMap = {
    str: 'strength', dex: 'dexterity', con: 'constitution',
    int: 'intelligence', wis: 'wisdom', cha: 'charisma',
  };

  for (const [abbr, fullName] of Object.entries(abilityMap)) {
    // Check if saving throw bonus exceeds what pure ability would give
    const saveBonus = saves[abbr] ?? saves[fullName] ?? saves[abbr + '_save'] ?? null;
    if (saveBonus !== null && saveBonus !== undefined) {
      const score = creature.ability_scores?.[fullName] ?? creature[fullName] ?? 10;
      const abilityMod = Math.floor((score - 10) / 2);
      const prof = creature.proficiency_bonus || 2;
      // If save bonus is significantly higher than raw ability mod, assume proficiency
      if (saveBonus > abilityMod) {
        saveProficiencies.push(abbr);
      }
    }
  }

  return saveProficiencies;
}

// ── Damage modifier list parsing ──────────────────────────────────────────────

function parseDamageList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(r => String(r).toLowerCase()).filter(Boolean);
  return String(raw).split(/[,;]/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

// ── Main creature transform ───────────────────────────────────────────────────

function transformCreature(creature) {
  const { weapons, features } = parseActions(creature);

  const strScore = creature.ability_scores?.strength ?? creature.strength ?? 10;
  const dexScore = creature.ability_scores?.dexterity ?? creature.dexterity ?? 10;
  const conScore = creature.ability_scores?.constitution ?? creature.constitution ?? 10;
  const intScore = creature.ability_scores?.intelligence ?? creature.intelligence ?? 10;
  const wisScore = creature.ability_scores?.wisdom ?? creature.wisdom ?? 10;
  const chaScore = creature.ability_scores?.charisma ?? creature.charisma ?? 10;

  const hp = creature.hit_points || 1;
  const ac = creature.armor_class || 10;
  const cr = parseCR(creature.challenge_rating_decimal ?? creature.challenge_rating_text ?? creature.challenge_rating ?? 0);

  return {
    name: creature.name,
    cr,
    ac,
    hp,
    maxHp: hp,
    speed: parseSpeed(creature.speed),
    abilities: {
      str: strScore,
      dex: dexScore,
      con: conScore,
      int: intScore,
      wis: wisScore,
      cha: chaScore,
    },
    weapons,
    features,
    resistances: parseDamageList(creature.damage_resistances),
    immunities: parseDamageList(creature.damage_immunities),
    vulnerabilities: parseDamageList(creature.damage_vulnerabilities),
    saveProficiencies: parseSaveProficiencies(creature),
    // Personality fields — to be filled later
    personality: '',
    combatStyle: 'aggressive',
    tactics: '',
    morale: 'normal',
  };
}

// ── Fetch all pages ───────────────────────────────────────────────────────────

async function fetchAllCreatures(source) {
  const creatures = [];
  let page = 1;
  let totalPages = null;

  while (true) {
    const url = `${OPEN5E_BASE}/creatures/?format=json&document__key=${encodeURIComponent(source)}&limit=${PAGE_SIZE}&page=${page}`;
    process.stdout.write(`  Fetching page ${page}...`);

    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new Error(`Network error on page ${page}: ${err.message}`);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} on page ${page}: ${res.statusText}`);
    }

    const json = await res.json();
    const results = json.results || [];
    console.log(` ${results.length} creatures`);

    creatures.push(...results);

    // Determine total pages from count
    if (totalPages === null && json.count) {
      totalPages = Math.ceil(json.count / PAGE_SIZE);
    }

    if (!json.next || results.length === 0) break;
    page++;
  }

  return creatures;
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  let raw;
  try {
    raw = await fetchAllCreatures(source);
  } catch (err) {
    console.error(`\nFetch error: ${err.message}`);
    process.exit(1);
  }

  console.log(`\n  Total: ${raw.length} creatures fetched`);

  if (raw.length === 0) {
    console.log('  No creatures found for this source key. Check the source name.');
    console.log('  Try: srd-2014, tob, tob2, tob3, cc');
    process.exit(1);
  }

  const transformed = [];
  let skipped = 0;
  const failures = [];

  for (const creature of raw) {
    try {
      const monster = transformCreature(creature);

      // Skip creatures with no weapons and no features — likely decorative/incomplete
      if (monster.weapons.length === 0 && monster.features.length === 0) {
        skipped++;
        continue;
      }

      transformed.push(monster);
    } catch (err) {
      failures.push({ name: creature.name || '?', error: err.message });
      skipped++;
    }
  }

  console.log(`  Transformed: ${transformed.length} (${skipped} skipped — no attacks or parse error)`);

  if (failures.length > 0) {
    console.log(`\n  Parse failures (${failures.length}):`);
    for (const f of failures.slice(0, 10)) {
      console.log(`    - ${f.name}: ${f.error}`);
    }
    if (failures.length > 10) console.log(`    ... and ${failures.length - 10} more`);
  }

  const outPath = path.join(__dirname, 'monsters', `monsters-${source}.json`);

  if (dryRun) {
    console.log(`\n  [DRY RUN] Would write ${transformed.length} creatures to: ${outPath}`);
    if (transformed.length > 0) {
      console.log('\n  Sample (first creature):');
      console.log(JSON.stringify(transformed[0], null, 2).split('\n').map(l => '    ' + l).join('\n'));
    }
    process.exit(0);
  }

  // Convert array to slug-keyed object
  const slugged = {};
  for (const monster of transformed) {
    const slug = monster.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    slugged[slug] = monster;
  }

  // Write output
  try {
    fs.writeFileSync(outPath, JSON.stringify(slugged, null, 2));
    console.log(`  Written to: monsters/monsters-${source}.json`);
  } catch (err) {
    console.error(`  Write error: ${err.message}`);
    process.exit(1);
  }

  // Run validator
  console.log('\n  Running validator...');
  try {
    const output = execSync(`node ${path.join(__dirname, 'validate-monsters.js')}`, {
      cwd: __dirname,
      encoding: 'utf8',
      timeout: 30000,
    });
    console.log(output.trim().split('\n').map(l => '  ' + l).join('\n'));
  } catch (err) {
    // Validator may exit non-zero if there are outliers — that's OK
    const out = (err.stdout || err.message || '').trim();
    if (out) console.log(out.split('\n').map(l => '  ' + l).join('\n'));
  }

  console.log(`\n  Run: node validate-monsters.js to check DPR accuracy\n`);
})();
