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
    const newLevel = calculateLevel(charData.xp);
    
    const leveledUp = newLevel > currentLevel;
    if (leveledUp) {
      charData.level = newLevel;
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
  calculateLevel,
  xpToNextLevel,
  XP_THRESHOLDS
};
