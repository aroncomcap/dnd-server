#!/usr/bin/env node
'use strict';

/**
 * Monster DPR Validation — checks that monster stats produce expected
 * DPR values relative to their CR. Flags outliers for adjustment.
 *
 * Usage: node validate-monsters.js [system]
 *   system: dnd5e (default) | runequest
 */

const { estimateMonsterDPR, avgDice } = require('./encounter-designer');
const { getAbilityMod } = require('./resolvers/dnd5e-resolver');

const system = process.argv[2] || 'dnd5e';
const file = system === 'runequest' ? './monsters/monsters-rq-core.json' : './monsters/monsters-5e-srd.json';
const monsters = require(file);

// Expected DPR ranges by CR (approximate, from D&D 5e DMG monster creation guidelines)
const EXPECTED_DPR_BY_CR = {
  0:     [0, 2],
  0.125: [1, 4],
  0.25:  [2, 6],
  0.5:   [3, 8],
  1:     [5, 12],
  2:     [8, 18],
  3:     [10, 22],
  4:     [12, 26],
  5:     [15, 32],
  6:     [18, 36],
  7:     [20, 40],
  8:     [22, 44],
  9:     [25, 48],
  10:    [28, 52],
  11:    [30, 56],
  12:    [32, 60],
  13:    [35, 68],
  14:    [38, 72],
  15:    [42, 80],
  16:    [45, 88],
  17:    [50, 96],
  20:    [60, 120],
  24:    [80, 160],
  30:    [100, 200],
};

function getExpectedRange(cr) {
  const exact = EXPECTED_DPR_BY_CR[cr];
  if (exact) return exact;
  // Interpolate
  const crs = Object.keys(EXPECTED_DPR_BY_CR).map(Number).sort((a, b) => a - b);
  let lower = crs[0], upper = crs[crs.length - 1];
  for (const c of crs) {
    if (c <= cr) lower = c;
    if (c >= cr && upper === crs[crs.length - 1]) upper = c;
  }
  if (lower === upper) return EXPECTED_DPR_BY_CR[lower];
  const lRange = EXPECTED_DPR_BY_CR[lower];
  const uRange = EXPECTED_DPR_BY_CR[upper];
  const pct = (cr - lower) / (upper - lower);
  return [
    Math.round(lRange[0] + (uRange[0] - lRange[0]) * pct),
    Math.round(lRange[1] + (uRange[1] - lRange[1]) * pct),
  ];
}

// Expected HP ranges by CR
const EXPECTED_HP_BY_CR = {
  0: [1, 6], 0.125: [1, 10], 0.25: [4, 15], 0.5: [8, 25],
  1: [15, 40], 2: [25, 60], 3: [35, 80], 4: [45, 100], 5: [55, 120],
  6: [65, 140], 7: [75, 160], 8: [85, 180], 9: [95, 200], 10: [105, 220],
  11: [115, 240], 12: [125, 260], 13: [135, 280], 14: [145, 300],
  15: [155, 320], 16: [165, 340], 17: [175, 360], 20: [200, 450],
  24: [250, 600], 30: [400, 900],
};

console.log(`\n🐉 Monster DPR Validation — ${system}`);
console.log(`   ${Object.keys(monsters).length} monsters\n`);
console.log('   Name                      | CR    | HP    | Est DPR | Expected DPR | HP Range     | Status');
console.log('   ' + '-'.repeat(95));

let issues = 0;
let total = 0;
const notes = [];

for (const [slug, m] of Object.entries(monsters).sort((a, b) => (a[1].cr || 0) - (b[1].cr || 0))) {
  total++;
  const cr = m.cr || 0;
  const hp = m.hp || 0;
  const dpr = estimateMonsterDPR(m);
  const [minDPR, maxDPR] = getExpectedRange(cr);
  const [minHP, maxHP] = EXPECTED_HP_BY_CR[cr] || [0, 999];

  let status = '✅';
  const problems = [];

  if (dpr < minDPR * 0.7) {
    problems.push(`DPR too low (${dpr} < ${minDPR})`);
    status = '⚠️';
  }
  if (dpr > maxDPR * 1.3) {
    problems.push(`DPR too high (${dpr} > ${maxDPR})`);
    status = '⚠️';
  }
  if (hp < minHP * 0.7) {
    problems.push(`HP too low (${hp} < ${minHP})`);
    status = '⚠️';
  }
  if (hp > maxHP * 1.3) {
    problems.push(`HP too high (${hp} > ${maxHP})`);
    status = '⚠️';
  }

  // Check weapon damage makes sense
  for (const w of (m.weapons || [])) {
    const avg = avgDice(w.damage);
    if (avg <= 0) {
      problems.push(`${w.name} has 0 avg damage`);
      status = '❌';
    }
  }

  if (problems.length > 0) issues++;

  const name = (m.name || slug).padEnd(25).slice(0, 25);
  const crStr = String(cr).padStart(5);
  const hpStr = String(hp).padStart(5);
  const dprStr = String(dpr).padStart(7);
  const expStr = `${minDPR}-${maxDPR}`.padStart(12);
  const hpRange = `${minHP}-${maxHP}`.padStart(12);

  console.log(`   ${name} | ${crStr} | ${hpStr} | ${dprStr} | ${expStr} | ${hpRange} | ${status}${problems.length ? ' ' + problems.join(', ') : ''}`);

  if (problems.length > 0) {
    notes.push({ slug, name: m.name, cr, hp, dpr, problems });
  }
}

console.log('\n' + '═'.repeat(100));
console.log(`   ${total} monsters validated, ${issues} with issues (${Math.round((issues / total) * 100)}%)`);

if (notes.length > 0) {
  console.log('\n   Monsters needing attention:');
  for (const n of notes) {
    console.log(`   - ${n.name} (CR ${n.cr}): ${n.problems.join(', ')}`);
  }
}

console.log('═'.repeat(100));
