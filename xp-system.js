const { normalizeDnd5eCombatStats } = require('./combat-stats');

/**
 * XP and Leveling System
 * Awards XP for encounters and handles character leveling
 */

const XP_PER_LEVEL = {
  1: 300,   // 0 XP to 299
  2: 900,   // 300 XP to 899
  3: 2700,  // 900 XP to 2699
  4: 6500,  // 2700 XP to 6499
  5: 999999 // 6500+ XP (no level beyond 5)
};

// Calculate total XP required to reach a level
const XP_THRESHOLDS = {
  1: 0,
  2: 300,
  3: 1200,
  4: 3900,
  5: 10400
};

const CR_XP = {
  0: 10,
  0.125: 25,
  0.25: 50,
  0.5: 100,
  1: 200,
  2: 450,
  3: 700,
  4: 1100,
  5: 1800,
  6: 2300,
  7: 2900,
  8: 3900,
  9: 5000,
  10: 5900,
  11: 7200,
  12: 8400,
  13: 10000,
  14: 11500,
  15: 13000,
  16: 15000,
  17: 18000,
  18: 20000,
  19: 22000,
  20: 25000,
  21: 33000,
  22: 41000,
  23: 50000,
  24: 62000,
  25: 75000,
  26: 90000,
  27: 105000,
  28: 120000,
  29: 135000,
  30: 155000,
};

function parseChallengeRating(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  const fraction = trimmed.match(/(\d+)\s*\/\s*(\d+)/);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (denominator) return numerator / denominator;
  }

  const numeric = trimmed.match(/\d+(?:\.\d+)?/);
  if (!numeric) return null;
  const parsed = Number(numeric[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function remainingHP(combatant) {
  const hp = combatant?.hp ?? combatant?.currentHp ?? combatant?.totalHp;
  const parsed = Number(hp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isDefeatedEnemy(combatant) {
  if (!combatant || combatant.type === 'PC') return false;
  if (combatant.defeated || combatant.dead) return true;
  return remainingHP(combatant) <= 0;
}

function getCombatantList(combatants) {
  if (!combatants) return [];
  return Array.isArray(combatants) ? combatants : Object.values(combatants);
}

function getMonsterXP(combatant) {
  const explicitXP = Number(combatant?.xp ?? combatant?.experience);
  if (Number.isFinite(explicitXP) && explicitXP > 0) return explicitXP;

  const cr = parseChallengeRating(combatant?.cr ?? combatant?.challengeRating ?? combatant?.challenge_rating);
  if (cr === null) return 0;
  return CR_XP[cr] || 0;
}

function calculateEncounterXP(combatants) {
  const defeated = getCombatantList(combatants)
    .filter(isDefeatedEnemy)
    .map(enemy => ({
      ...enemy,
      xp: getMonsterXP(enemy),
    }));

  return {
    totalXP: defeated.reduce((sum, enemy) => sum + enemy.xp, 0),
    defeated,
  };
}

function syncCharacterLevelFields(charData, level) {
  if (!charData) return;
  charData.level = level;
  if (charData.combatStats) {
    charData.combatStats.level = level;
    if (!charData.combatStats.system || charData.combatStats.system === 'dnd5e') {
      charData.combatStats = normalizeDnd5eCombatStats(charData.combatStats);
    }
  }
  if (typeof charData.statsText === 'string') {
    if (/level\s+\d+/i.test(charData.statsText)) {
      charData.statsText = charData.statsText.replace(/level\s+\d+/i, `Level ${level}`);
    } else {
      charData.statsText = `Level ${level}\n${charData.statsText}`;
    }
  }
}

/**
 * Award XP to all characters in the party
 * @param {object} gameState - Game state
 * @param {number} xpAmount - XP to award each character
 * @return {Array} - Array of {character, leveledUp, newLevel}
 */
function awardXP(gameState, xpAmount) {
  const results = [];
  
  if (!gameState.data.characters) return results;
  
  for (const [charName, charData] of Object.entries(gameState.data.characters)) {
    if (!charData) continue;
    
    charData.xp = (charData.xp || 0) + xpAmount;
    const currentLevel = charData.level || 1;
    const calculatedLevel = calculateLevel(charData.xp);
    const newLevel = Math.max(currentLevel, calculatedLevel);
    
    const leveledUp = newLevel > currentLevel;
    if (leveledUp) {
      syncCharacterLevelFields(charData, newLevel);
    } else if (!charData.level) {
      syncCharacterLevelFields(charData, newLevel);
    }
    
    results.push({
      character: charName,
      xpGained: xpAmount,
      totalXP: charData.xp,
      leveledUp,
      newLevel: newLevel
    });
  }
  
  return results;
}

function awardCombatXP(gameState, combatants) {
  const encounter = calculateEncounterXP(combatants);
  const characters = gameState?.data?.characters || {};
  const partySize = Object.values(characters).filter(Boolean).length;

  if (!partySize || encounter.totalXP <= 0) {
    return {
      totalXP: encounter.totalXP,
      xpPerCharacter: 0,
      defeated: encounter.defeated,
      results: [],
    };
  }

  const xpPerCharacter = Math.ceil(encounter.totalXP / partySize);
  const results = awardXP(gameState, xpPerCharacter);

  for (const result of results) {
    const charData = characters[result.character];
    syncCharacterLevelFields(charData, result.newLevel);
  }

  return {
    totalXP: encounter.totalXP,
    xpPerCharacter,
    defeated: encounter.defeated,
    results,
  };
}

/**
 * Calculate character level based on total XP
 * @param {number} totalXP - Total experience points
 * @return {number} - Character level (1-5)
 */
function calculateLevel(totalXP) {
  if (totalXP >= XP_THRESHOLDS[5]) return 5;
  if (totalXP >= XP_THRESHOLDS[4]) return 4;
  if (totalXP >= XP_THRESHOLDS[3]) return 3;
  if (totalXP >= XP_THRESHOLDS[2]) return 2;
  return 1;
}

/**
 * Get XP needed to reach next level
 * @param {number} currentLevel - Current level
 * @param {number} currentXP - Current XP
 * @return {number} - XP remaining to next level
 */
function xpToNextLevel(currentLevel, currentXP) {
  if (currentLevel >= 5) return 0;
  
  const nextThreshold = XP_THRESHOLDS[currentLevel + 1];
  return Math.max(0, nextThreshold - currentXP);
}

module.exports = {
  awardXP,
  awardCombatXP,
  calculateEncounterXP,
  calculateLevel,
  getMonsterXP,
  xpToNextLevel,
  CR_XP,
  XP_THRESHOLDS
};
