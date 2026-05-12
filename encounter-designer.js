'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Ferocity table.
 * hpMult / dprMult scale monster HP and DPR budgets.
 * deathFreq is roughly "every N rounds one PC death-saves".
 * encPerDay is [min, max] encounters per adventuring day.
 * shortRests is average short rests per day.
 */
const FEROCITY = {
  1: { label: 'Deadly',    targetRounds: 4.5, hpMult: 1.5, dprMult: 1.8, deathFreq: 4,  encPerDay: [6, 8], shortRests: 2   },
  2: { label: 'Dangerous', targetRounds: 4,   hpMult: 1.3, dprMult: 1.4, deathFreq: 7,  encPerDay: [5, 7], shortRests: 2   },
  3: { label: 'Balanced',  targetRounds: 3.5, hpMult: 1.0, dprMult: 1.0, deathFreq: 10, encPerDay: [4, 6], shortRests: 1.5 },
  4: { label: 'Light',     targetRounds: 2.5, hpMult: 0.7, dprMult: 0.7, deathFreq: 14, encPerDay: [3, 5], shortRests: 1   },
  5: { label: 'Easy',      targetRounds: 2,   hpMult: 0.5, dprMult: 0.5, deathFreq: 18, encPerDay: [2, 4], shortRests: 1   },
};

/** Position multipliers for how far into the adventuring day an encounter falls. */
const POSITION_MULT = {
  early: 0.8,
  mid:   1.0,
  late:  1.3,
  boss:  1.8,
};

// ---------------------------------------------------------------------------
// Dice helpers
// ---------------------------------------------------------------------------

/**
 * Parse dice notation like "2d6+3", "1d8", "1d8+1+1d4", "4d10" into the
 * average expected result.
 *
 * Average of NdX = N × (X+1)/2
 * Flat modifiers (positive or negative) are summed directly.
 *
 * @param {string} notation
 * @returns {number}
 */
function avgDice(notation) {
  if (typeof notation !== 'string' || !notation.trim()) return 0;

  // Tokenise: split on +/-, keep sign.  e.g. "1d8+1+1d4" → ["1d8","+1","+1d4"]
  const tokenPattern = /([+-]?(?:\d*d\d+|\d+))/gi;
  const tokens = notation.match(tokenPattern);
  if (!tokens) return 0;

  let total = 0;
  for (const token of tokens) {
    const sign = token.startsWith('-') ? -1 : 1;
    const raw  = token.replace(/^[+-]/, '');
    const diceMatch = raw.match(/^(\d*)d(\d+)$/i);
    if (diceMatch) {
      const count = diceMatch[1] === '' ? 1 : parseInt(diceMatch[1], 10);
      const faces = parseInt(diceMatch[2], 10);
      total += sign * count * (faces + 1) / 2;
    } else {
      const flat = parseInt(raw, 10);
      if (!isNaN(flat)) total += sign * flat;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Ability score helpers
// ---------------------------------------------------------------------------

/** @param {number} score @returns {number} modifier */
function abilityMod(score) {
  return Math.floor((score - 10) / 2);
}

// ---------------------------------------------------------------------------
// DPR estimation
// ---------------------------------------------------------------------------

/**
 * Estimate a single character's DPR.
 *
 * combatStats shape (matches stat-parser.js output):
 * {
 *   level, class, hp, maxHp, ac,
 *   abilities: { str, dex, con, int, wis, cha },
 *   proficiencyBonus,
 *   attackMod,        // total attack bonus (already includes everything)
 *   weapons: [{ name, attackMod, damage, damageType, properties }],
 *   spells:  [{ name, level, damage, save, damageType }],
 *   spellSlots: { 1: N, 2: N, ... },
 *   spellcastingAbility,
 *   features: string[],
 *   cantrip,          // optional: { name, damage }
 * }
 *
 * @param {object} combatStats
 * @param {number} [targetAC=13]
 * @returns {{ weaponDPR, cantripDPR, spellBurstDPR, amortizedSpellDPR, effectiveDPR }}
 */
function estimateCharacterDPR(combatStats, targetAC = 13) {
  const stats = combatStats || {};

  // ---- derive key values ----
  const level    = stats.level || 1;
  const prof     = stats.proficiencyBonus || Math.ceil(1 + level / 4);
  const abilities = stats.abilities || {};

  // Determine primary attack modifier (to-hit bonus without prof, just ability)
  // We accept an explicit attackMod numeric field, or derive from weapons.
  let attackBonus = 0; // total to-hit bonus
  const weapons   = Array.isArray(stats.weapons) ? stats.weapons : [];

  // Pick best weapon for DPR
  let weaponDPR = 0;
  for (const w of weapons) {
    const dmgStr = w.damage || '1d4';
    const dmgAvg = avgDice(dmgStr);

    // Determine to-hit bonus for this weapon
    let toHit = 0;
    if (typeof w.attackMod === 'number') {
      toHit = w.attackMod;
    } else if (typeof w.attackMod === 'string' && abilities[w.attackMod] !== undefined) {
      toHit = abilityMod(abilities[w.attackMod]) + prof;
    } else if (typeof stats.attackMod === 'number') {
      toHit = stats.attackMod;
    } else {
      // fallback: guess STR for melee
      const strMod = abilityMod(abilities.str || 10);
      const dexMod = abilityMod(abilities.dex || 10);
      toHit = Math.max(strMod, dexMod) + prof;
    }

    // Ability mod to damage — same ability as attack
    let dmgMod = 0;
    if (typeof w.attackMod === 'string' && abilities[w.attackMod] !== undefined) {
      dmgMod = abilityMod(abilities[w.attackMod]);
    } else {
      dmgMod = abilityMod(Math.max(abilities.str || 10, abilities.dex || 10));
    }

    const hitProb  = Math.min(0.95, Math.max(0.05, (21 - (targetAC - toHit)) / 20));
    const attackCount = hasExtraAttack(stats) ? 2 : 1;
    let dpr = (dmgAvg + dmgMod) * hitProb * attackCount;

    // Sneak Attack bonus (Rogue)
    const sneakDmg = parseSneakAttack(stats);
    if (sneakDmg > 0) {
      dpr += sneakDmg * hitProb; // once per turn
    }

    if (dpr > weaponDPR) {
      weaponDPR = dpr;
      attackBonus = toHit;
    }
  }

  if (weapons.length === 0) {
    // Unarmed or unknown — rough estimate
    const strMod = abilityMod(abilities.str || 10);
    attackBonus  = strMod + prof;
    const hitProb = Math.min(0.95, Math.max(0.05, (21 - (targetAC - attackBonus)) / 20));
    weaponDPR    = (1 + strMod) * hitProb;
  }

  // ---- Cantrip DPR ----
  let cantripDPR = 0;
  const cantrip = stats.cantrip || findBestCantrip(stats);
  if (cantrip) {
    const dmgAvg = avgDice(cantrip.damage || '1d10');
    const spellMod = getSpellcastingMod(stats, abilities, prof);
    const saveOrAtk = cantrip.save
      ? 0.6   // assume 60% save fail rate
      : Math.min(0.95, Math.max(0.05, (21 - (targetAC - (spellMod + prof))) / 20));
    cantripDPR = dmgAvg * saveOrAtk;
  }

  // ---- Leveled spell DPR ----
  // Find best damage spell
  let spellBurstDPR = 0;
  let amortizedSpellDPR = 0;
  const spells = Array.isArray(stats.spells) ? stats.spells : [];
  const spellSlots = stats.spellSlots || {};
  const spellMod = getSpellcastingMod(stats, abilities, prof);

  let bestSpellDmg = 0;
  let totalSlots = 0;
  for (const sp of spells) {
    if (!sp.damage) continue;
    const dmg = avgDice(sp.damage) * 0.6; // 0.6 effectiveness (save, concentration, etc.)
    if (dmg > bestSpellDmg) bestSpellDmg = dmg;
  }
  for (const n of Object.values(spellSlots)) {
    totalSlots += (n || 0);
  }

  if (bestSpellDmg > 0) {
    spellBurstDPR = bestSpellDmg;
    // Amortize over 4 rounds using available slots
    const usableSlots = Math.min(totalSlots, 2); // typically use 2 big spells per fight
    amortizedSpellDPR = (bestSpellDmg * usableSlots) / 4;
  }

  // ---- Effective DPR ----
  const baseDPR      = Math.max(weaponDPR, cantripDPR);
  const effectiveDPR = baseDPR + amortizedSpellDPR * 0.5;

  return {
    weaponDPR:        Math.round(weaponDPR * 100) / 100,
    cantripDPR:       Math.round(cantripDPR * 100) / 100,
    spellBurstDPR:    Math.round(spellBurstDPR * 100) / 100,
    amortizedSpellDPR: Math.round(amortizedSpellDPR * 100) / 100,
    effectiveDPR:     Math.round(effectiveDPR * 100) / 100,
  };
}

/** @param {object} stats @returns {boolean} */
function hasExtraAttack(stats) {
  const features = Array.isArray(stats.features) ? stats.features : [];
  return features.some(f => /extra attack/i.test(f));
}

/**
 * Parse Sneak Attack dice from features array.
 * Looks for "Sneak Attack Xd6" patterns.
 * @param {object} stats
 * @returns {number} average sneak attack damage
 */
function parseSneakAttack(stats) {
  const features = Array.isArray(stats.features) ? stats.features : [];
  for (const f of features) {
    const m = f.match(/sneak\s*attack\s+(\d+d6)/i);
    if (m) return avgDice(m[1]);
    const m2 = f.match(/sneak\s*attack[:\s]+(\d+d\d+)/i);
    if (m2) return avgDice(m2[1]);
  }
  return 0;
}

/** Find the first cantrip from spells list (level 0 or named as cantrip). */
function findBestCantrip(stats) {
  const spells = Array.isArray(stats.spells) ? stats.spells : [];
  let best = null;
  for (const sp of spells) {
    if (sp.level === 0 && sp.damage) {
      if (!best || avgDice(sp.damage) > avgDice(best.damage)) best = sp;
    }
  }
  return best;
}

/**
 * Get spellcasting modifier for the character.
 * @param {object} stats
 * @param {object} abilities
 * @param {number} prof
 * @returns {number}
 */
function getSpellcastingMod(stats, abilities, prof) {
  const ability = stats.spellcastingAbility || guessSpellcastingAbility(stats);
  const score   = (abilities && abilities[ability]) || 10;
  return abilityMod(score) + prof;
}

function guessSpellcastingAbility(stats) {
  const cls = (stats.class || '').toLowerCase();
  if (['wizard', 'artificer'].includes(cls)) return 'int';
  if (['cleric', 'druid', 'ranger'].includes(cls)) return 'wis';
  return 'cha'; // bard, sorcerer, warlock, paladin
}

/**
 * Calculate DPR for entire party.
 * @param {object[]} partyStats  Array of combatStats objects
 * @param {number}   [targetAC=13]
 * @returns {{ totalDPR: number, characters: object[] }}
 */
function calculatePartyDPR(partyStats, targetAC = 13) {
  const characters = partyStats.map(cs => ({
    ...estimateCharacterDPR(cs, targetAC),
    name: cs.name || cs.id || 'unknown',
  }));
  const totalDPR = characters.reduce((sum, c) => sum + c.effectiveDPR, 0);
  return { totalDPR: Math.round(totalDPR * 100) / 100, characters };
}

// ---------------------------------------------------------------------------
// Budget calculation
// ---------------------------------------------------------------------------

/**
 * Calculate how many total HP monsters in this encounter should have.
 *
 * Budget = partyDPR × targetRounds × hpMult × positionMult × correction
 *
 * @param {number} partyDPR
 * @param {number} ferocity  1–5
 * @param {string} [position='mid']
 * @param {number} [correction=1.0]
 * @returns {number}
 */
function calculateMonsterHPBudget(partyDPR, ferocity, position, correction) {
  const f = FEROCITY[ferocity] || FEROCITY[3];
  const posMult = POSITION_MULT[position] || 1.0;
  const corr = correction || 1.0;
  // Base budget: enough HP to survive targetRounds at party's DPR
  // Add 30% buffer because DPR estimates are theoretical maximums
  const buffer = 1.3;
  return Math.round(partyDPR * f.targetRounds * f.hpMult * posMult * corr * buffer);
}

/**
 * Calculate how much total damage monsters should be able to deal per round.
 *
 * Budget = (partyTotalHP / deathFreq) × positionMult / targetRounds × dprMult
 *
 * @param {number} partyTotalHP
 * @param {number} ferocity  1–5
 * @param {string} [position='mid']
 * @returns {number}
 */
function calculateMonsterDPRBudget(partyTotalHP, ferocity, position = 'mid') {
  const f    = FEROCITY[ferocity] || FEROCITY[3];
  const pMult = POSITION_MULT[position] || POSITION_MULT.mid;
  return Math.round((partyTotalHP / f.deathFreq) * pMult / f.targetRounds * f.dprMult);
}

// ---------------------------------------------------------------------------
// Monster DPR estimation
// ---------------------------------------------------------------------------

/**
 * Estimate a monster's DPR against a typical party (AC 14).
 * @param {object} monster
 * @returns {number}
 */
function estimateMonsterDPR(monster) {
  const targetAC = 14;
  const weapons  = Array.isArray(monster.weapons) ? monster.weapons : [];
  if (weapons.length === 0) {
    // Rough fallback from CR
    const cr = monster.cr || 0;
    return Math.max(1, Math.round(cr * 5));
  }

  // Parse multiattack from features. The multiattack feature doubles the DPR
  // of a single-weapon monster (e.g. "Multiattack (2 slams)" or "Multiattack (5 bites)").
  // We cap the multiplier at 2 — multiattack effectively doubles a monster's DPR.
  const features = Array.isArray(monster.features) ? monster.features : [];
  let hasMultiattack = false;
  for (const f of features) {
    if (/multiattack/i.test(f)) { hasMultiattack = true; break; }
  }
  // Only apply multiattack multiplier when there's a single primary attack weapon
  // (recharge/cone/save weapons don't count as the primary multiattack weapon)
  const primaryWeapons = weapons.filter(w => {
    const props = Array.isArray(w.properties) ? w.properties : [];
    return !props.includes('recharge-5-6') && !props.includes('cone') && w.attackMod !== null;
  });
  const applyMultiattack = primaryWeapons.length === 1 && hasMultiattack;

  let totalDPR = 0;
  for (const w of weapons) {
    const props = Array.isArray(w.properties) ? w.properties : [];
    // Recharge/cone weapons are situational — amortize at 50% effectiveness
    const isRecharge = props.includes('recharge-5-6') || props.includes('cone');
    const effectiveness = isRecharge ? 0.5 : 1.0;

    const dmgAvg = avgDice(w.damage || '1d4');
    const abilities = monster.abilities || {};

    let toHit = 0;
    if (typeof w.attackMod === 'number') {
      toHit = w.attackMod;
    } else if (typeof w.attackMod === 'string' && abilities[w.attackMod] !== undefined) {
      const prof = monster.proficiencyBonus || 2;
      toHit = abilityMod(abilities[w.attackMod]) + prof;
    } else {
      toHit = 3; // reasonable default
    }

    // For save-based attacks (attackMod null), use 0.6 hit probability
    const hitProb = w.attackMod === null
      ? 0.6
      : Math.min(0.95, Math.max(0.05, (21 - (targetAC - toHit)) / 20));

    // Ability mod to damage (not applied to recharge/save weapons — damage already includes it)
    let dmgMod = 0;
    if (!isRecharge && w.attackMod !== null && typeof w.attackMod === 'string' && abilities[w.attackMod] !== undefined) {
      dmgMod = abilityMod(abilities[w.attackMod]);
    }

    const weaponDPR = (dmgAvg + dmgMod) * hitProb * effectiveness;
    // Multiattack doubles primary weapon DPR (capped at 2× regardless of attack count)
    totalDPR += (applyMultiattack && !isRecharge) ? weaponDPR * 2 : weaponDPR;
  }

  // ---- Spell DPR for monsters ----
  const spells = Array.isArray(monster.spells) ? monster.spells : [];
  const spellSlots = monster.spellSlots || {};
  const spellcastingAbility = monster.spellcastingAbility;
  if (spellcastingAbility) {
    const abilities = monster.abilities || {};
    const prof = monster.proficiencyBonus || 2;
    let bestSpellDmg = 0;
    let totalSlots = 0;
    for (const sp of spells) {
      if (!sp || !sp.damage) continue;
      const dmg = avgDice(sp.damage) * 0.6;
      if (dmg > bestSpellDmg) bestSpellDmg = dmg;
    }
    for (const n of Object.values(spellSlots)) totalSlots += (n || 0);
    if (bestSpellDmg > 0) {
      // Allow up to 4 spell uses for powerful monsters with many slots
      const usableSlots = Math.min(totalSlots, 4);
      const amortizedSpellDPR = (bestSpellDmg * usableSlots) / 4;
      totalDPR += amortizedSpellDPR;
    }
  }

  return Math.round(totalDPR * 100) / 100;
}

// ---------------------------------------------------------------------------
// Monster selection
// ---------------------------------------------------------------------------

/**
 * Select a set of monsters that fit within the HP and DPR budgets.
 *
 * Strategy:
 *  1. Find an "anchor" monster whose HP is 20–70% of hpBudget.
 *  2. Fill remaining HP budget with weaker "filler" monsters (hp < anchor.hp).
 *  3. Stop when DPR budget is also exhausted or no affordable monsters remain.
 *
 * @param {number}  hpBudget
 * @param {number}  dprBudget
 * @param {object}  monsterDB      slug → monster object
 * @param {object}  [options]
 * @param {string}  [options.environment]  hint (not filtered strictly here)
 * @param {number}  [options.maxCR]        cap monster CR
 * @returns {Array<{slug, name, count, hp, cr, estimatedDPR}>}
 */
function selectMonsters(hpBudget, dprBudget, monsterDB, options = {}) {
  const { previousMonsters, partyLevel } = options || {};
  const prevSet = new Set((previousMonsters || []).map(s => s.toLowerCase()));

  const candidates = Object.entries(monsterDB)
    .map(([slug, m]) => ({ slug, ...m, name: m.name || slug, hp: m.hp || 1, cr: m.cr || 0, estimatedDPR: estimateMonsterDPR(m) }))
    .filter(m => m.hp > 0 && m.weapons?.length > 0)
    .filter(m => options.maxCR === undefined || m.cr <= options.maxCR)
    .filter(m => !prevSet.has(m.slug)); // Avoid repeats from recent encounters

  if (candidates.length === 0) {
    // Fallback: allow repeats if we've used everything
    return selectMonstersFromList(hpBudget, Object.entries(monsterDB)
      .map(([slug, m]) => ({ slug, ...m, name: m.name || slug, hp: m.hp || 1, cr: m.cr || 0, estimatedDPR: estimateMonsterDPR(m) }))
      .filter(m => m.hp > 0 && m.weapons?.length > 0));
  }

  return selectMonstersFromList(hpBudget, candidates);
}

function selectMonstersFromList(hpBudget, candidates) {
  if (candidates.length === 0) return [];

  // Strategy: pick randomly between compositions
  const strategy = Math.random();
  const results = [];
  let remainingHP = hpBudget;

  if (strategy < 0.4) {
    // Strategy A: One strong anchor (40-70% budget) + weaker fillers
    const anchors = candidates.filter(m => m.hp >= hpBudget * 0.3 && m.hp <= hpBudget * 0.7);
    if (anchors.length > 0) {
      const anchor = anchors[Math.floor(Math.random() * Math.min(3, anchors.length))];
      results.push({ slug: anchor.slug, name: anchor.name, count: 1, hp: anchor.hp, cr: anchor.cr || 0, estimatedDPR: anchor.estimatedDPR });
      remainingHP -= anchor.hp;
    }
  } else if (strategy < 0.7) {
    // Strategy B: Medium group of similar CR
    const midRange = candidates.filter(m => m.hp >= hpBudget * 0.15 && m.hp <= hpBudget * 0.4);
    if (midRange.length > 0) {
      const pick = midRange[Math.floor(Math.random() * Math.min(5, midRange.length))];
      const count = Math.max(2, Math.min(5, Math.floor(hpBudget / pick.hp)));
      results.push({ slug: pick.slug, name: pick.name, count, hp: pick.hp, cr: pick.cr || 0, estimatedDPR: pick.estimatedDPR });
      remainingHP -= pick.hp * count;
    }
  }
  // else: Strategy C falls through to filler-only (swarm of weak creatures)

  // Fill remaining budget
  if (remainingHP > 10) {
    const fillers = candidates.filter(m => m.hp <= remainingHP && !results.some(r => r.slug === m.slug));
    if (fillers.length > 0) {
      const filler = fillers[Math.floor(Math.random() * Math.min(8, fillers.length))];
      const count = Math.max(1, Math.min(6, Math.floor(remainingHP / filler.hp)));
      results.push({ slug: filler.slug, name: filler.name, count, hp: filler.hp, cr: filler.cr || 0, estimatedDPR: filler.estimatedDPR });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Encounter designers
// ---------------------------------------------------------------------------

/**
 * Design a complete combat encounter.
 *
 * @param {object[]} partyStats
 * @param {number}   ferocity      1–5
 * @param {string}   position      early|mid|late|boss
 * @param {object}   monsterDB     slug → monster
 * @param {object}   [options]     { correction, targetAC, maxCR }
 * @returns {object}
 */
function designCombatEncounter(partyStats, ferocity, position, monsterDB, options = {}) {
  const targetAC   = options.targetAC || 13;
  const correction = options.correction || 1.0;

  const { totalDPR } = calculatePartyDPR(partyStats, targetAC);
  const partyTotalHP  = partyStats.reduce((sum, cs) => sum + (cs.maxHp || cs.hp || 20), 0);

  const hpBudget  = calculateMonsterHPBudget(totalDPR, ferocity, position, correction);
  const dprBudget = calculateMonsterDPRBudget(partyTotalHP, ferocity, position);

  const f = FEROCITY[ferocity] || FEROCITY[3];
  const monsters = selectMonsters(hpBudget, dprBudget, monsterDB, options);

  const totalMonsterHP  = monsters.reduce((sum, m) => sum + m.hp * m.count, 0);
  const totalMonsterDPR = monsters.reduce((sum, m) => sum + m.estimatedDPR * m.count, 0);
  const estimatedRounds = totalDPR > 0 ? totalMonsterHP / totalDPR : f.targetRounds;

  return {
    pillar:          'combat',
    ferocity,
    position,
    monsters,
    hpBudget,
    dprBudget,
    totalMonsterHP,
    totalMonsterDPR: Math.round(totalMonsterDPR * 100) / 100,
    estimatedRounds: Math.round(estimatedRounds * 10) / 10,
    difficultyRating: ferocity,
  };
}

// DC tables keyed by ferocity
const SOCIAL_DC    = { 1: 19, 2: 17, 3: 14, 4: 12, 5: 9 };
const SOCIAL_ROLLS = {
  1: { successesNeeded: 4, maxFailures: 2 },
  2: { successesNeeded: 4, maxFailures: 2 },
  3: { successesNeeded: 3, maxFailures: 3 },
  4: { successesNeeded: 3, maxFailures: 3 },
  5: { successesNeeded: 2, maxFailures: 3 },
};

const SOCIAL_TYPES = [
  'Negotiate with a merchant guild',
  'Persuade a reluctant witness',
  'Deceive a gate guard',
  'Charm a noble at a banquet',
  'Intimidate a crime boss',
  'Bargain with a fey creature',
];

/**
 * Design a social encounter (skill challenge).
 *
 * @param {number} ferocity  1–5
 * @param {string} position  early|mid|late|boss
 * @returns {object}
 */
function designSocialEncounter(ferocity, position) {
  const dc      = SOCIAL_DC[ferocity]    || SOCIAL_DC[3];
  const rolls   = SOCIAL_ROLLS[ferocity] || SOCIAL_ROLLS[3];
  const posIdx  = ['early','mid','late','boss'].indexOf(position);
  const typeIdx = Math.max(0, posIdx) % SOCIAL_TYPES.length;

  return {
    pillar:          'social',
    type:            SOCIAL_TYPES[typeIdx],
    dc,
    successesNeeded: rolls.successesNeeded,
    maxFailures:     rolls.maxFailures,
    difficultyRating: ferocity,
  };
}

const TRAP_DAMAGE = { 1: '4d10', 2: '3d10', 3: '2d10', 4: '1d10', 5: '1d6' };
const TRAP_DETECT = { 1: 18, 2: 16, 3: 14, 4: 12, 5: 10 };

const EXPLORATION_TYPES = [
  'Trapped chest',
  'Pitfall corridor',
  'Pressure-plate dart trap',
  'Poisoned door handle',
  'Collapsing bridge',
  'Arcane alarm ward',
];

/**
 * Design an exploration encounter (trap / hazard).
 *
 * @param {number} ferocity  1–5
 * @param {string} position  early|mid|late|boss
 * @returns {object}
 */
function designExplorationEncounter(ferocity, position) {
  const dc          = SOCIAL_DC[ferocity]    || SOCIAL_DC[3]; // same DC table
  const trapDice    = TRAP_DAMAGE[ferocity]  || TRAP_DAMAGE[3];
  const detectionDC = TRAP_DETECT[ferocity]  || TRAP_DETECT[3];
  const posIdx      = ['early','mid','late','boss'].indexOf(position);
  const typeIdx     = Math.max(0, posIdx) % EXPLORATION_TYPES.length;

  return {
    pillar:          'exploration',
    type:            EXPLORATION_TYPES[typeIdx],
    dc,
    trapDamage:      trapDice,
    trapDice,
    detectionDC,
    difficultyRating: ferocity,
  };
}

// ---------------------------------------------------------------------------
// Adventuring day designer
// ---------------------------------------------------------------------------

function buildWeightedPillarSequence(counts, weights) {
  const pillars = ['combat', 'social', 'exploration'];
  const remaining = { ...counts };
  const placed = { combat: 0, social: 0, exploration: 0 };
  const total = pillars.reduce((sum, pillar) => sum + (remaining[pillar] || 0), 0);
  const weightSum = pillars.reduce((sum, pillar) => sum + (weights[pillar] || 0), 0) || 1;
  const sequence = [];

  for (let slot = 0; slot < total; slot++) {
    let best = null;
    let bestScore = -Infinity;

    for (const pillar of pillars) {
      if ((remaining[pillar] || 0) <= 0) continue;
      const targetShare = (weights[pillar] || 0) / weightSum;
      const deficit = targetShare * (slot + 1) - placed[pillar];
      const tieBreaker = targetShare + (remaining[pillar] / total) * 0.01;
      const score = deficit + tieBreaker * 0.001;
      if (score > bestScore) {
        best = pillar;
        bestScore = score;
      }
    }

    sequence.push(best);
    remaining[best]--;
    placed[best]++;
  }

  return sequence;
}

/**
 * Design a full adventuring day.
 *
 * @param {object[]} partyStats
 * @param {number}   ferocity    1–5
 * @param {object}   pillars     { combat: %, social: %, exploration: % }  (should sum ~100)
 * @param {object}   monsterDB   slug → monster
 * @param {object}   [options]   { correction, targetAC, maxCR }
 * @returns {{ encounters: object[], summary: object }}
 */
function designAdventuringDay(partyStats, ferocity, pillars, monsterDB, options = {}) {
  const f = FEROCITY[ferocity] || FEROCITY[3];

  // Choose encounter count — midpoint of range
  const [minEnc, maxEnc] = f.encPerDay;
  const totalEncounters  = Math.round((minEnc + maxEnc) / 2);

  // Normalise pillars
  const p = {
    combat:      (pillars && pillars.combat      != null) ? pillars.combat      : 33,
    social:      (pillars && pillars.social      != null) ? pillars.social      : 33,
    exploration: (pillars && pillars.exploration != null) ? pillars.exploration : 34,
  };
  const pSum = p.combat + p.social + p.exploration || 100;
  const combatCount = Math.max(1, Math.round(totalEncounters * p.combat / pSum));
  const socialCount = Math.max(0, Math.round(totalEncounters * p.social / pSum));
  const exploCount  = Math.max(0, totalEncounters - combatCount - socialCount);

  const pool = buildWeightedPillarSequence(
    { combat: combatCount, social: socialCount, exploration: exploCount },
    p
  );

  // Assign positions (first ~30% = early, middle ~40% = mid, next ~20% = late, last = boss)
  const n = pool.length;
  const encounters = [];
  const shortRestEvery = Math.max(1, Math.round(n / (f.shortRests + 1)));
  const usedMonsters = []; // Track slugs used in this day's encounters
  const lastCombatSlot = pool.lastIndexOf('combat');

  for (let i = 0; i < n; i++) {
    const ratio = i / n;
    let position;
    if (i === lastCombatSlot && pool[i] === 'combat') {
      position = 'boss';
    } else if (ratio < 0.3) {
      position = 'early';
    } else if (ratio < 0.7) {
      position = 'mid';
    } else {
      position = 'late';
    }

    let enc;
    switch (pool[i]) {
      case 'combat':
        enc = designCombatEncounter(partyStats, ferocity, position, monsterDB, { ...options, previousMonsters: usedMonsters });
        // Track used monsters to avoid repeats in subsequent encounters
        for (const m of enc.monsters || []) usedMonsters.push(m.slug);
        break;
      case 'social':
        enc = designSocialEncounter(ferocity, position);
        break;
      default:
        enc = designExplorationEncounter(ferocity, position);
    }

    enc.index = i + 1;
    enc.ofTotal = n;
    encounters.push(enc);

    // Insert short rest marker after every shortRestEvery encounters (except last)
    if ((i + 1) % shortRestEvery === 0 && i < n - 1) {
      encounters.push({ pillar: 'rest', type: 'short', index: i + 1, ofTotal: n });
    }
  }

  // Long rest at end
  encounters.push({ pillar: 'rest', type: 'long' });

  // Summary
  const combatEncs = encounters.filter(e => e.pillar === 'combat');
  const socialEncs = encounters.filter(e => e.pillar === 'social');
  const exploEncs  = encounters.filter(e => e.pillar === 'exploration');
  const shortRests = encounters.filter(e => e.pillar === 'rest' && e.type === 'short');

  return {
    encounters,
    summary: {
      ferocity,
      ferocityLabel:    f.label,
      totalEncounters:  n,
      combatCount:      combatEncs.length,
      socialCount:      socialEncs.length,
      explorationCount: exploEncs.length,
      shortRestCount:   shortRests.length,
      pillars: {
        combat:      Math.round(combatEncs.length / n * 100),
        social:      Math.round(socialEncs.length / n * 100),
        exploration: Math.round(exploEncs.length / n * 100),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Rolling DPR / difficulty correction
// ---------------------------------------------------------------------------

/**
 * Weighted average of recent combat DPR observations.
 * Weights (newest first): [0.35, 0.25, 0.20, 0.12, 0.08]
 *
 * @param {number[]} history  DPR values, newest last (up to 5)
 * @returns {number}
 */
function updateRollingDPR(history) {
  if (!Array.isArray(history) || history.length === 0) return 0;
  const weights = [0.35, 0.25, 0.20, 0.12, 0.08];
  // Reverse so index 0 = newest
  const recent = [...history].reverse().slice(0, 5);
  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < recent.length; i++) {
    weightedSum += recent[i] * weights[i];
    weightTotal += weights[i];
  }
  return Math.round((weightedSum / weightTotal) * 100) / 100;
}

/**
 * Update the correction factor based on actual vs predicted rounds.
 *
 * ratio = actualRounds / predictedRounds
 * < 0.6  → +0.15 (monsters too weak, more HP)
 * < 0.8  → +0.10
 * > 1.5  → -0.15 (monsters too strong)
 * > 1.2  → -0.10
 * else     no change
 *
 * Clamped to [0.5, 2.0].
 *
 * @param {number} currentCorrection
 * @param {{ actualRounds: number, predictedRounds: number }} outcome
 * @returns {number}
 */
function applyDifficultyCorrection(currentCorrection, outcome) {
  const ratio = outcome.actualRounds / outcome.predictedRounds;
  let delta = 0;
  if      (ratio < 0.6) delta = +0.15;
  else if (ratio < 0.8) delta = +0.10;
  else if (ratio > 1.5) delta = -0.15;
  else if (ratio > 1.2) delta = -0.10;

  return Math.min(2.0, Math.max(0.5, currentCorrection + delta));
}

// ---------------------------------------------------------------------------
// Prompt formatter
// ---------------------------------------------------------------------------

/**
 * Format the current encounter plan as a single-line string for injection
 * into an AI prompt.
 *
 * @param {object} plan           Return value of designAdventuringDay()
 * @param {number} currentIndex   0-based index of the next encounter
 * @returns {string}
 */
function formatPlanForPrompt(plan, currentIndex) {
  const { encounters, summary } = plan;

  // Skip rest entries when counting
  const fightEncs = encounters.filter(e => e.pillar !== 'rest');
  const total     = fightEncs.length;
  const next      = fightEncs[currentIndex];

  if (!next) {
    return `ENCOUNTER PLAN: All ${total} encounters complete. Proceed to long rest.`;
  }

  const pos     = currentIndex + 1;
  let nextDesc  = '';

  if (next.pillar === 'combat') {
    const monsterStr = (next.monsters || [])
      .map(m => `${m.count}x ${m.name}`)
      .join(', ');
    const hp  = next.totalMonsterHP || 0;
    const rnd = next.estimatedRounds || '?';
    const diffLabel = FEROCITY[next.ferocity] ? FEROCITY[next.ferocity].label : 'Unknown';
    // Provide the exact ENEMIES format the AI should output
    const enemiesBlock = (next.monsters || [])
      .map(m => `- ${m.displayName || m.name} | ${m.count} | ${m.slug}`)
      .join('\n');
    nextDesc = `Next: COMBAT (${diffLabel}). Monsters: ${monsterStr || 'TBD'} (~${hp} HP, est. ${rnd} rounds). When you introduce this combat, include this EXACT block in ---WORLD---:\nENEMIES:\n${enemiesBlock}`;
  } else if (next.pillar === 'social') {
    nextDesc = `Next: SOCIAL (${next.type}, DC ${next.dc}, ${next.successesNeeded} successes/${next.maxFailures} failures).`;
  } else {
    nextDesc = `Next: EXPLORATION (${next.type}, DC ${next.dc}).`;
  }

  // Short rest hint
  const restHint = encounters.find(e =>
    e.pillar === 'rest' && e.type === 'short' && e.index === next.index
  ) ? ' After this, offer a short rest.' : '';

  // Pillar progress so far
  const done = fightEncs.slice(0, currentIndex);
  const cCount = done.filter(e => e.pillar === 'combat').length;
  const sCount = done.filter(e => e.pillar === 'social').length;
  const eCount = done.filter(e => e.pillar === 'exploration').length;
  const totalDone = done.length || 1;
  const pillarsStr = `C${Math.round(cCount/totalDone*100)}%/S${Math.round(sCount/totalDone*100)}%/E${Math.round(eCount/totalDone*100)}%`;

  return `ENCOUNTER PLAN: Encounter ${pos} of ${total}. ${nextDesc}${restHint} Pillar progress: ${pillarsStr}.`;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  avgDice,
  estimateCharacterDPR,
  calculatePartyDPR,
  calculateMonsterHPBudget,
  calculateMonsterDPRBudget,
  estimateMonsterDPR,
  selectMonsters,
  selectMonstersFromList,
  designCombatEncounter,
  designSocialEncounter,
  designExplorationEncounter,
  designAdventuringDay,
  updateRollingDPR,
  applyDifficultyCorrection,
  formatPlanForPrompt,
  FEROCITY,
  POSITION_MULT,
};
