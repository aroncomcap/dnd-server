'use strict';

const { roll, d20, rollDie } = require('./dice');

// ---------------------------------------------------------------------------
// Hit Location Table (d20)
// ---------------------------------------------------------------------------

const HIT_LOCATION_TABLE = {
  1: 'rightLeg', 2: 'rightLeg', 3: 'rightLeg', 4: 'rightLeg',
  5: 'leftLeg',  6: 'leftLeg',  7: 'leftLeg',  8: 'leftLeg',
  9: 'abdomen', 10: 'abdomen', 11: 'abdomen',
  12: 'chest',
  13: 'rightArm', 14: 'rightArm', 15: 'rightArm',
  16: 'leftArm',  17: 'leftArm',  18: 'leftArm',
  19: 'head', 20: 'head',
};

// ---------------------------------------------------------------------------
// Fumble Tables (d20)
// ---------------------------------------------------------------------------

const MELEE_FUMBLE_TABLE = {
  1:  'Lose next attack. Off balance — no parry until next SR.',
  2:  'Lose next attack. Off balance — no parry until next SR.',
  3:  'Lose next attack. Stumble — lose 1 SR next round.',
  4:  'Lose next attack. Stumble — lose 1 SR next round.',
  5:  'Drop weapon. Must spend 5 SR to recover.',
  6:  'Drop weapon. Must spend 5 SR to recover.',
  7:  'Drop weapon. Weapon lands 1d3 meters away.',
  8:  'Drop weapon. Weapon lands 1d3 meters away.',
  9:  'Weapon stuck in ground/wall. STR roll to free (5 SR).',
  10: 'Weapon stuck in ground/wall. STR roll to free (5 SR).',
  11: 'Shield strap breaks (if shield) or weapon knocked away 1d6 meters.',
  12: 'Shield strap breaks (if shield) or weapon knocked away 1d6 meters.',
  13: 'Hit nearest ally in random hit location for normal damage.',
  14: 'Hit nearest ally in random hit location for normal damage.',
  15: 'Hit self in random hit location for half damage.',
  16: 'Hit self in random hit location for half damage.',
  17: 'Fall prone. Must spend 5 SR and movement to stand.',
  18: 'Fall prone. Must spend 5 SR and movement to stand.',
  19: 'Weapon breaks (if breakable). Unbreakable weapons: drop + fall prone.',
  20: 'Weapon breaks AND hit self in random location for full damage.',
};

const RANGED_FUMBLE_TABLE = {
  1:  'Bowstring breaks or weapon jams. 1d6 rounds to fix.',
  2:  'Bowstring breaks or weapon jams. 1d6 rounds to fix.',
  3:  'Bowstring breaks or weapon jams. 1d6 rounds to fix.',
  4:  'Lose ammunition. Arrow/bolt/stone lost or broken.',
  5:  'Lose ammunition. Arrow/bolt/stone lost or broken.',
  6:  'Lose ammunition. Arrow/bolt/stone lost or broken.',
  7:  'Weapon misfires or slips. Lose next attack.',
  8:  'Weapon misfires or slips. Lose next attack.',
  9:  'Weapon misfires or slips. Lose next attack.',
  10: 'Hit nearest ally for normal damage.',
  11: 'Hit nearest ally for normal damage.',
  12: 'Hit nearest ally for normal damage.',
  13: 'Drop weapon. Must spend 5 SR to recover.',
  14: 'Drop weapon. Must spend 5 SR to recover.',
  15: 'Drop weapon. Must spend 5 SR to recover.',
  16: 'Wild shot hits random bystander or object in area.',
  17: 'Wild shot hits random bystander or object in area.',
  18: 'Weapon string snaps/mechanism breaks. Field repair (10 minutes).',
  19: 'Weapon string snaps/mechanism breaks. Field repair (10 minutes).',
  20: 'Weapon destroyed. Bow snaps, sling tears, etc.',
};

const NATURAL_FUMBLE_TABLE = {
  1:  'Fall prone. Spend 5 SR and movement to stand.',
  2:  'Fall prone. Spend 5 SR and movement to stand.',
  3:  'Fall prone. Spend 5 SR and movement to stand.',
  4:  'Fall prone. Spend 5 SR and movement to stand.',
  5:  'Twist limb. Lose next attack from pain.',
  6:  'Twist limb. Lose next attack from pain.',
  7:  'Twist limb. Lose next attack from pain.',
  8:  'Twist limb. Lose next attack from pain.',
  9:  'Bite tongue / claw stuck. Lose next attack.',
  10: 'Bite tongue / claw stuck. Lose next attack.',
  11: 'Bite tongue / claw stuck. Lose next attack.',
  12: 'Bite tongue / claw stuck. Lose next attack.',
  13: 'Overextend. Opponent gets free attack at +20%.',
  14: 'Overextend. Opponent gets free attack at +20%.',
  15: 'Overextend. Opponent gets free attack at +20%.',
  16: 'Collide with obstacle. Take 1d3 damage to random location.',
  17: 'Collide with obstacle. Take 1d3 damage to random location.',
  18: 'Collide with obstacle. Take 1d3 damage to random location.',
  19: 'Hit self in random location for full damage.',
  20: 'Hit self in random location for full damage.',
};

const SPELL_FUMBLE_TABLE = {
  1:  'Spell fails. Magic Points still spent.',
  2:  'Spell fails. Magic Points still spent.',
  3:  'Spell fails. Magic Points still spent.',
  4:  'Spell fails. Magic Points still spent.',
  5:  'Spell fails. Lose an additional 1d3 Magic Points.',
  6:  'Spell fails. Lose an additional 1d3 Magic Points.',
  7:  'Spell fails. Lose an additional 1d3 Magic Points.',
  8:  'Spell fails. Lose an additional 1d3 Magic Points.',
  9:  'Spell targets random nearby creature instead.',
  10: 'Spell targets random nearby creature instead.',
  11: 'Spell targets random nearby creature instead.',
  12: 'Spell targets random nearby creature instead.',
  13: 'Spell backfires — offensive spell hits caster instead.',
  14: 'Spell backfires — offensive spell hits caster instead.',
  15: 'Spell backfires — offensive spell hits caster instead.',
  16: 'Caster stunned for 1 round. All magic disrupted.',
  17: 'Caster stunned for 1 round. All magic disrupted.',
  18: 'Caster stunned for 1 round. All magic disrupted.',
  19: 'Catastrophic failure. Lose 1d6 Magic Points AND spell hits caster.',
  20: 'Catastrophic failure. Lose 1d6 Magic Points AND spell hits caster.',
};

// ---------------------------------------------------------------------------
// Constants for parry
// ---------------------------------------------------------------------------

const SHIELD_ABSORPTION = 12;
const WEAPON_ABSORPTION = 6;

// Weapon types that get specific special effects
const IMPALING_WEAPONS = new Set(['spear', 'rapier', 'lance', 'arrow', 'javelin', 'dagger', 'impaling']);
const SLASHING_WEAPONS = new Set(['sword', 'broadsword', 'axe', 'scimitar', 'kopis', 'slashing']);
const CRUSHING_WEAPONS = new Set(['mace', 'hammer', 'maul', 'club', 'staff', 'crushing']);

// ---------------------------------------------------------------------------
// getAttackResult
// ---------------------------------------------------------------------------

/**
 * Determine attack result given a d100 roll and the combatant's skill%.
 *
 * @param {number} rollValue  - 1-100 (100 represents 00)
 * @param {number} skill      - skill percentage
 * @returns {'critical'|'special'|'hit'|'miss'|'fumble'}
 */
function getAttackResult(rollValue, skill) {
  // Fumble check: 96-100 for skills < 100; only 100 for skills >= 100
  if (skill >= 100) {
    if (rollValue === 100) return 'fumble';
  } else {
    if (rollValue >= 96) return 'fumble';
  }

  const criticalThreshold = Math.max(1, Math.floor(skill / 20));
  const specialThreshold  = Math.floor(skill / 5);

  if (rollValue <= criticalThreshold) return 'critical';
  if (rollValue <= specialThreshold)  return 'special';
  if (rollValue <= skill)             return 'hit';
  return 'miss';
}

// ---------------------------------------------------------------------------
// rollHitLocation
// ---------------------------------------------------------------------------

/**
 * Roll a d20 and look up the hit location.
 * @returns {{ roll: number, location: string }}
 */
function rollHitLocation() {
  const r = d20();
  return { roll: r, location: HIT_LOCATION_TABLE[r] };
}

// ---------------------------------------------------------------------------
// maximizeDamage
// ---------------------------------------------------------------------------

/**
 * Return the maximum possible result for a dice notation string.
 * Each die contributes its maximum face value; flat modifiers are added as-is.
 *
 * @param {string} notation - e.g. '1d8+1+1d4'
 * @returns {number}
 */
function maximizeDamage(notation) {
  if (typeof notation !== 'string' || !notation.trim()) {
    throw new TypeError(`maximizeDamage() expects a non-empty string, got: ${JSON.stringify(notation)}`);
  }

  const tokenPattern = /([+-]?(?:\d*d\d+|\d+))/gi;
  const tokens = notation.match(tokenPattern);
  if (!tokens) throw new SyntaxError(`Invalid dice notation: "${notation}"`);

  let total = 0;
  for (const token of tokens) {
    const sign = token.startsWith('-') ? -1 : 1;
    const raw = token.replace(/^[+-]/, '');
    const match = raw.match(/^(\d*)d(\d+)$/i);
    if (match) {
      const count = match[1] === '' ? 1 : parseInt(match[1], 10);
      const faces = parseInt(match[2], 10);
      total += sign * count * faces;
    } else {
      total += sign * parseInt(raw, 10);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// getSpecialEffect
// ---------------------------------------------------------------------------

/**
 * Return the special effect for a weapon + attack result, or null.
 *
 * @param {object} weapon
 * @param {string} attackResult
 * @returns {object|null}
 */
function getSpecialEffect(weapon, attackResult) {
  if (attackResult === 'miss' || attackResult === 'fumble') return null;

  if (attackResult === 'critical') {
    return {
      type: 'critical',
      ignoreArmor: true,
      maximizeDamage: true,
    };
  }

  if (attackResult === 'special') {
    const weaponType = (weapon.type || '').toLowerCase();
    const weaponName = (weapon.name || '').toLowerCase();

    // Check impaling
    const isImpaling = IMPALING_WEAPONS.has(weaponType) ||
      [...IMPALING_WEAPONS].some(w => weaponName.includes(w));
    if (isImpaling) {
      return {
        type: 'impale',
        maximizeDamage: true,
        weaponStuck: true,
        description: 'Impale: max weapon damage + impale damage, weapon stuck in target',
      };
    }

    // Check slashing
    const isSlashing = SLASHING_WEAPONS.has(weaponType) ||
      [...SLASHING_WEAPONS].some(w => weaponName.includes(w));
    if (isSlashing) {
      return {
        type: 'slash',
        maximizeDamage: true,
        bleeding: 1, // 1 HP/round
        description: 'Slash: max damage + bleeding 1 HP/round',
      };
    }

    // Check crushing
    const isCrushing = CRUSHING_WEAPONS.has(weaponType) ||
      [...CRUSHING_WEAPONS].some(w => weaponName.includes(w));
    if (isCrushing) {
      return {
        type: 'crush',
        maximizeDamage: true,
        knockback: true,
        description: 'Crush: max damage + knockback',
      };
    }

    // Generic special for unknown weapon types
    return {
      type: 'special',
      maximizeDamage: true,
      description: 'Special hit: maximum damage',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// resolveFumble
// ---------------------------------------------------------------------------

/**
 * Roll on the appropriate fumble table.
 *
 * @param {'melee'|'ranged'|'natural'|'spell'} weaponType
 * @returns {{ roll: number, description: string, weaponType: string }}
 */
function resolveFumble(weaponType) {
  const tables = {
    melee:   MELEE_FUMBLE_TABLE,
    ranged:  RANGED_FUMBLE_TABLE,
    natural: NATURAL_FUMBLE_TABLE,
    spell:   SPELL_FUMBLE_TABLE,
  };

  const table = tables[weaponType] || MELEE_FUMBLE_TABLE;
  const r = d20();

  return {
    roll: r,
    description: table[r],
    weaponType,
  };
}

// ---------------------------------------------------------------------------
// resolveAttack
// ---------------------------------------------------------------------------

/**
 * Resolve a RuneQuest attack.
 *
 * @param {object} attacker
 * @param {object} target
 * @param {object} weapon
 * @param {string} defenseChoice - 'dodge'|'parry'|'none'
 * @returns {object}
 */
function resolveAttack(attacker, target, weapon, defenseChoice) {
  const skillRoll = rollDie(100);
  const attackResult = getAttackResult(skillRoll, weapon.skill || 0);

  // No hit location or damage on miss/fumble
  if (attackResult === 'miss') {
    return {
      type: 'attack',
      attacker: attacker.id,
      attackerName: attacker.name,
      target: target.id,
      targetName: target.name,
      weapon: weapon.name,
      roll: skillRoll,
      attackResult,
      hitLocation: null,
      damage: 0,
      specialEffect: null,
      fumbleResult: null,
    };
  }

  if (attackResult === 'fumble') {
    const weaponType = _getWeaponFumbleType(weapon);
    const fumbleResult = resolveFumble(weaponType);
    return {
      type: 'attack',
      attacker: attacker.id,
      attackerName: attacker.name,
      target: target.id,
      targetName: target.name,
      weapon: weapon.name,
      roll: skillRoll,
      attackResult,
      hitLocation: null,
      damage: 0,
      specialEffect: null,
      fumbleResult,
    };
  }

  // Hit / special / critical — roll hit location and damage
  const locationResult = rollHitLocation();
  const specialEffect  = getSpecialEffect(weapon, attackResult);

  let damage;
  if (specialEffect && specialEffect.maximizeDamage) {
    damage = maximizeDamage(weapon.damage || '1d6');
  } else {
    damage = roll(weapon.damage || '1d6').total;
  }

  return {
    type: 'attack',
    attacker: attacker.id,
    attackerName: attacker.name,
    target: target.id,
    targetName: target.name,
    weapon: weapon.name,
    roll: skillRoll,
    attackResult,
    hitLocation: locationResult.location,
    hitLocationRoll: locationResult.roll,
    damage: Math.max(1, damage),
    specialEffect,
    fumbleResult: null,
  };
}

/** Determine fumble table type for a weapon */
function _getWeaponFumbleType(weapon) {
  if (!weapon) return 'melee';
  const props = (weapon.properties || []);
  if (props.includes('ranged') || (weapon.type || '') === 'ranged') return 'ranged';
  if ((weapon.type || '') === 'natural') return 'natural';
  if ((weapon.type || '') === 'spell') return 'spell';
  return 'melee';
}

// ---------------------------------------------------------------------------
// resolveDefense
// ---------------------------------------------------------------------------

/**
 * Resolve a defense attempt (dodge or parry).
 *
 * @param {object} defender
 * @param {'dodge'|'parry'} defenseType
 * @param {object|null} weapon       - weapon or shield used to parry (null for dodge)
 * @param {number} incomingDamage
 * @param {string} incomingAttackResult - 'critical'|'special'|'hit'
 * @returns {object}
 */
function resolveDefense(defender, defenseType, weapon, incomingDamage, incomingAttackResult) {
  const defRoll = rollDie(100);

  if (defenseType === 'dodge') {
    const dodgeSkill = (defender.skills && defender.skills.dodge) || 0;
    const defenseResult = getAttackResult(defRoll, dodgeSkill);
    const success = defenseResult === 'critical' || defenseResult === 'special' || defenseResult === 'hit';

    return {
      type: 'defense',
      defenseType: 'dodge',
      roll: defRoll,
      defenseResult,
      success,
      parryResult: null,
      damageAbsorbed: success ? incomingDamage : 0,
      remainingDamage: success ? 0 : incomingDamage,
      attackerWeaponDamaged: false,
    };
  }

  // Parry
  const parrySkill = (weapon && (weapon.parry || weapon.skill)) ||
    (() => {
      // Try to find matching weapon in defender's weapon list
      const w = (defender.weapons || []).find(w => w.parry);
      return w ? w.parry : 0;
    })();

  const defenseResult = getAttackResult(defRoll, parrySkill);
  const success = defenseResult === 'critical' || defenseResult === 'special' || defenseResult === 'hit';

  if (!success) {
    return {
      type: 'defense',
      defenseType: 'parry',
      roll: defRoll,
      defenseResult,
      success: false,
      parryResult: null,
      damageAbsorbed: 0,
      remainingDamage: incomingDamage,
      attackerWeaponDamaged: false,
    };
  }

  // Determine absorption based on parry result and weapon/shield type
  const isShield = !weapon || weapon.type === 'shield';
  const baseAbsorption = weapon
    ? (weapon.absorption !== undefined ? weapon.absorption : (isShield ? SHIELD_ABSORPTION : WEAPON_ABSORPTION))
    : WEAPON_ABSORPTION;

  let damageAbsorbed;
  let parryResult;
  let attackerWeaponDamaged = false;

  if (defenseResult === 'critical') {
    // Critical parry: full stop (no damage gets through) AND attacker weapon damaged
    // UNLESS attacker's attack was also critical, in which case parry still absorbs
    if (incomingAttackResult === 'critical') {
      // Critical attack vs critical parry: absorb double absorption
      damageAbsorbed = Math.min(baseAbsorption * 2, incomingDamage);
    } else {
      damageAbsorbed = incomingDamage; // all absorbed
      attackerWeaponDamaged = true;
    }
    parryResult = 'critical';
  } else if (defenseResult === 'special') {
    damageAbsorbed = Math.min(baseAbsorption * 2, incomingDamage);
    parryResult = 'special';
  } else {
    damageAbsorbed = Math.min(baseAbsorption, incomingDamage);
    parryResult = 'normal';
  }

  const remainingDamage = Math.max(0, incomingDamage - damageAbsorbed);

  return {
    type: 'defense',
    defenseType: 'parry',
    roll: defRoll,
    defenseResult,
    success: true,
    parryResult,
    damageAbsorbed,
    remainingDamage,
    attackerWeaponDamaged,
  };
}

// ---------------------------------------------------------------------------
// applyDamage
// ---------------------------------------------------------------------------

/**
 * Apply damage to a specific hit location, accounting for armor.
 * Mutates target.hitLocations[locationKey].hp and target.totalHp.
 *
 * @param {object} target
 * @param {number} rawDamage
 * @param {string} locationKey
 * @returns {object}
 */
function applyDamage(target, rawDamage, locationKey) {
  const location = target.hitLocations[locationKey];
  if (!location) throw new Error(`Unknown hit location: ${locationKey}`);

  const armor = location.armor || 0;
  const effectiveDamage = Math.max(0, rawDamage - armor);

  const locationHpBefore = location.hp;
  const locationHpAfter  = locationHpBefore - effectiveDamage;
  const locationMaxHp    = location.maxHp;

  // Mutate target
  location.hp = locationHpAfter;
  target.totalHp = (target.totalHp || 0) - effectiveDamage;

  // Determine limb status
  let limbStatus = 'ok';
  if (locationHpAfter <= -locationMaxHp) {
    limbStatus = 'severed';
  } else if (locationHpAfter <= 0) {
    limbStatus = 'useless';
  }

  return {
    location: locationKey,
    armor,
    rawDamage,
    effectiveDamage,
    locationHpBefore,
    locationHpAfter,
    locationMaxHp,
    totalHp: target.totalHp,
    limbStatus,
  };
}

// ---------------------------------------------------------------------------
// checkDeath
// ---------------------------------------------------------------------------

/**
 * Determine the living status of a RuneQuest combatant.
 *
 * @param {object} combatant
 * @returns {{ status: string, id: string, name: string, reason?: string }}
 */
function checkDeath(combatant) {
  if (combatant.totalHp <= 0) {
    return {
      status: 'dead',
      id: combatant.id,
      name: combatant.name,
      reason: 'Total HP at or below 0',
    };
  }

  const head = combatant.hitLocations && combatant.hitLocations.head;
  if (head && head.hp <= 0) {
    return {
      status: 'unconscious',
      id: combatant.id,
      name: combatant.name,
      reason: 'Head location reduced to 0 HP',
    };
  }

  const chest = combatant.hitLocations && combatant.hitLocations.chest;
  if (chest && chest.hp <= 0) {
    return {
      status: 'seriously_wounded',
      id: combatant.id,
      name: combatant.name,
      reason: 'Chest location reduced to 0 HP',
    };
  }

  return { status: 'alive', id: combatant.id, name: combatant.name };
}

// ---------------------------------------------------------------------------
// rollInitiative (Strike Rank)
// ---------------------------------------------------------------------------

/**
 * DEX Strike Rank table.
 * @param {number} dex
 * @returns {number}
 */
function _dexSR(dex) {
  if (dex <= 5)  return 5;
  if (dex <= 8)  return 4;
  if (dex <= 12) return 3;
  if (dex <= 15) return 2;
  if (dex <= 18) return 1;
  return 0; // 19+
}

/**
 * SIZ Strike Rank table.
 * @param {number} siz
 * @returns {number}
 */
function _sizSR(siz) {
  if (siz <= 5)  return 3;
  if (siz <= 8)  return 2;
  if (siz <= 12) return 1;
  if (siz <= 15) return 1;
  if (siz <= 20) return 0;
  return 0; // 21+
}

/**
 * Calculate a combatant's strike rank (lower = faster).
 * Deterministic — no dice roll.
 *
 * @param {object} combatant
 * @returns {number}
 */
function rollInitiative(combatant) {
  const dex = combatant.characteristics.dex;
  const siz = combatant.characteristics.siz;
  return _dexSR(dex) + _sizSR(siz);
}

// ---------------------------------------------------------------------------
// getAvailableActions
// ---------------------------------------------------------------------------

/**
 * Return list of available actions for a combatant on their SR.
 *
 * @param {object} combatant
 * @returns {object[]}
 */
function getAvailableActions(combatant) {
  const actions = [];

  // Weapon attacks
  for (const weapon of (combatant.weapons || [])) {
    if (weapon.type !== 'shield') {
      actions.push({ type: 'attack', name: weapon.name, weapon });
    }
  }

  // Parry (all weapons + shields can parry)
  for (const weapon of (combatant.weapons || [])) {
    if (weapon.parry || weapon.skill) {
      actions.push({ type: 'parry', name: `Parry (${weapon.name})`, weapon });
    }
  }

  // Dodge
  const dodgeSkill = (combatant.skills && combatant.skills.dodge) || 0;
  actions.push({ type: 'dodge', name: 'Dodge', skill: dodgeSkill });

  // Rune spells (require rune points)
  if ((combatant.runePoints || 0) > 0) {
    for (const spell of (combatant.runeSpells || [])) {
      if (spell.cost <= combatant.runePoints) {
        actions.push({ type: 'runeSpell', name: spell.name, spell });
      }
    }
  }

  // Spirit spells (require magic points)
  if ((combatant.magicPoints || 0) > 0) {
    for (const spell of (combatant.spiritSpells || [])) {
      if (spell.cost <= combatant.magicPoints) {
        actions.push({ type: 'spiritSpell', name: spell.name, spell });
      }
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getAttackResult,
  rollHitLocation,
  resolveAttack,
  resolveDefense,
  applyDamage,
  checkDeath,
  rollInitiative,
  getAvailableActions,
  resolveFumble,
  getSpecialEffect,
  maximizeDamage,
  HIT_LOCATION_TABLE,
  MELEE_FUMBLE_TABLE,
  RANGED_FUMBLE_TABLE,
  NATURAL_FUMBLE_TABLE,
  SPELL_FUMBLE_TABLE,
};
