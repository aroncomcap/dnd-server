'use strict';

const { d20, advantage, disadvantage, rollDie } = require('./dice');
const {
  getAttackBonus,
  getAttacksPerAction,
  getDamageFormula,
  findAttackProfile,
  profileIsUsable,
  hasFlatModifier,
} = require('../combat-stats');

// ---------------------------------------------------------------------------
// Core math helpers
// ---------------------------------------------------------------------------

/** Standard 5e ability modifier formula. */
function getAbilityMod(score) {
  if (score === undefined || score === null || isNaN(score)) return 0;
  return Math.floor((score - 10) / 2);
}

/**
 * Saving throw modifier for a combatant and ability.
 * Adds proficiency bonus when the combatant is proficient.
 */
function getSaveMod(combatant, ability) {
  const abilities = combatant.abilities || {};
  const mod = getAbilityMod(abilities[ability]);
  const proficient = (combatant.saveProficiencies || []).includes(ability);
  const prof = combatant.proficiencyBonus || 2;
  return proficient ? mod + prof : mod;
}

/** Spell Save DC: 8 + proficiency + spellcasting ability modifier. */
function getSpellSaveDC(caster, spell = null) {
  if (spell) {
    const profile = findAttackProfile(caster, 'spell', spell.name);
    if (profile && profileIsUsable(profile) && Number.isFinite(Number(profile.saveDC))) {
      return Number(profile.saveDC);
    }
    if (Number.isFinite(Number(spell.saveDC))) return Number(spell.saveDC);
  }
  const ability = caster.spellcastingAbility;
  const abilities = caster.abilities || {};
  const mod = ability ? getAbilityMod(abilities[ability]) : 0;
  return 8 + (caster.proficiencyBonus || 2) + mod;
}

/** Attack modifier: ability modifier + proficiency bonus. */
function getAttackMod(combatant, weapon) {
  return getAttackBonus(combatant, weapon, 'weapon');
}

/** Roll initiative: d20 + DEX modifier. */
function rollInitiative(combatant) {
  const abilities = combatant.abilities || {};
  return d20() + getAbilityMod(abilities.dex);
}

// ---------------------------------------------------------------------------
// Advantage / disadvantage logic
// ---------------------------------------------------------------------------

/**
 * Determine whether an attack has advantage, disadvantage, or neither
 * based on attacker/target conditions and weapon properties.
 *
 * Returns: 'advantage' | 'disadvantage' | 'normal'
 * (advantage and disadvantage cancel each other out)
 */
function _getAdvantageState(attacker, target, weapon, conditions = []) {
  const attackerConds = [
    ...(attacker.conditions || []),
    ...conditions.filter(c => c.target === attacker.id).map(c => c.type),
  ];
  if (!target) return { type: 'attack', hit: false, error: 'No target', totalDamage: 0, damageType: weapon.damageType || 'bludgeoning' };
  const targetConds = target.conditions || [];

  const isRanged = (weapon.properties || []).includes('ranged');
  const isMelee = !isRanged;

  let advSources = 0;
  let disSources = 0;

  // Prone target: adv on melee, disadv on ranged
  if (targetConds.includes('prone')) {
    if (isMelee) advSources++;
    else disSources++;
  }

  // Stunned / paralyzed / unconscious target = advantage
  if (
    targetConds.includes('stunned') ||
    targetConds.includes('paralyzed') ||
    targetConds.includes('unconscious')
  ) {
    advSources++;
  }

  // Blinded target = advantage for attacker
  if (targetConds.includes('blinded')) advSources++;

  // Blinded attacker = disadvantage
  if (attackerConds.includes('blinded')) disSources++;

  // Invisible attacker = advantage
  if (attackerConds.includes('invisible')) advSources++;

  // Restrained or prone attacker = disadvantage
  if (attackerConds.includes('restrained') || attackerConds.includes('prone')) disSources++;

  if (advSources > 0 && disSources > 0) return 'normal'; // cancel out
  if (advSources > 0) return 'advantage';
  if (disSources > 0) return 'disadvantage';
  return 'normal';
}

// ---------------------------------------------------------------------------
// resolveAttack
// ---------------------------------------------------------------------------

/**
 * Resolve a weapon attack from attacker against target.
 *
 * @param {object} attacker
 * @param {object} target
 * @param {object} weapon
 * @param {string[]} conditions  - extra condition strings (legacy param, kept for compat)
 * @param {object[]} activeEffects - e.g. [{ type: 'bless', targets: ['kael'] }]
 * @returns {object} attack result
 */
function resolveAttack(attacker, target, weapon, conditions = [], activeEffects = []) {
  const attackSource = weapon.source === 'spell' ? 'spell' : 'weapon';
  const modifier = getAttackBonus(attacker, weapon, attackSource);
  const advState = _getAdvantageState(attacker, target, weapon, conditions);

  // Roll d20 (with adv/disadv)
  let rollResult;
  let advantageRolls = null;

  if (advState === 'advantage') {
    const adv = advantage();
    rollResult = adv.result;
    advantageRolls = { rolls: adv.rolls, mode: 'advantage' };
  } else if (advState === 'disadvantage') {
    const dis = disadvantage();
    rollResult = dis.result;
    advantageRolls = { rolls: dis.rolls, mode: 'disadvantage' };
  } else {
    rollResult = d20();
  }

  // Bless adds 1d4 to attack roll
  let effectBonus = 0;
  const bless = activeEffects.find(
    e => e.type === 'bless' && Array.isArray(e.targets) && e.targets.includes(attacker.id)
  );
  if (bless) {
    effectBonus = rollDamageFormula('1d4').total;
  }

  const total = rollResult + modifier + effectBonus;

  const critical = rollResult === 20;
  const fumble = rollResult === 1;

  // Critical = always hit; fumble = always miss
  const hit = critical || (!fumble && total >= target.ac);

  // Damage
  let damageRoll = 0;
  let totalDamage = 0;
  let damageFormula = getDamageFormula(attacker, weapon, attackSource);
  let damageDiceTotal = 0;
  let damageModifier = 0;

  if (hit) {
    const damage = rollDamageFormula(damageFormula, critical);
    damageDiceTotal = damage.diceTotal;
    damageModifier = damage.modifier;
    damageRoll = damage.total;
    totalDamage = Math.max(1, damageRoll);
  }

  const result = {
    type: 'attack',
    attacker: attacker.id,
    attackerName: attacker.name,
    target: target.id,
    targetName: target.name,
    weapon: weapon.name,
    roll: rollResult,
    modifier,
    effectBonus,
    total,
    targetAC: target.ac,
    hit,
    critical,
    fumble,
    damageRoll,
    damageDiceTotal,
    damageModifier,
    damageFormula,
    totalDamage,
    damageType: weapon.damageType || 'bludgeoning',
  };

  if (advantageRolls) {
    result.advantageRolls = advantageRolls;
  }

  return result;
}

function rollDamageFormula(formula, critical = false) {
  const notation = typeof formula === 'string' && formula.trim() ? formula.trim() : '1d4';
  const tokens = notation.match(/([+-]?(?:\d*d\d+|\d+))/gi);
  if (!tokens) {
    throw new SyntaxError(`Invalid dice notation: "${notation}"`);
  }

  const rolls = [];
  let modifier = 0;
  for (const token of tokens) {
    const sign = token.startsWith('-') ? -1 : 1;
    const raw = token.replace(/^[+-]/, '');
    const diceMatch = raw.match(/^(\d*)d(\d+)$/i);
    if (diceMatch) {
      const count = diceMatch[1] === '' ? 1 : parseInt(diceMatch[1], 10);
      const faces = parseInt(diceMatch[2], 10);
      const rollCount = count * (critical ? 2 : 1);
      for (let i = 0; i < rollCount; i++) {
        rolls.push(sign * rollDie(faces));
      }
    } else {
      const flat = parseInt(raw, 10);
      if (isNaN(flat)) throw new SyntaxError(`Unrecognised token in dice notation: "${token}"`);
      modifier += sign * flat;
    }
  }

  const diceTotal = rolls.reduce((sum, value) => sum + value, 0);
  return { rolls, diceTotal, modifier, total: diceTotal + modifier };
}

// ---------------------------------------------------------------------------
// resolveSpell
// ---------------------------------------------------------------------------

/**
 * Resolve a spell cast by caster against one or more targets.
 * Handles: healing, save-based damage, attack-roll spells, buff/other.
 */
function resolveSpell(caster, spell, targets, conditions = [], activeEffects = []) {
  const spellAbility = caster.spellcastingAbility;
  const spellMod = spellAbility ? getAbilityMod((caster.abilities || {})[spellAbility]) : 0;

  // --- Healing ---
  if (spell.healing || spell.effect === 'heal') {
    const notation = getDamageFormula(caster, spell, 'spell') || spell.healing || '1d4';
    const healRoll = rollDamageFormula(notation);
    const totalHealing = Math.max(1, healRoll.total + (hasFlatModifier(notation) ? 0 : spellMod));
    return {
      type: 'heal',
      caster: caster.id,
      casterName: caster.name,
      spell: spell.name,
      healingRoll: healRoll.total,
      healingMod: spellMod,
      totalHealing,
      targets: targets.map(t => ({ id: t.id, name: t.name, healing: totalHealing })),
    };
  }

  // --- Save-based ---
  if (spell.save) {
    const saveDC = getSpellSaveDC(caster, spell);
    const damageFormula = getDamageFormula(caster, spell, 'spell');
    const damageRoll = rollDamageFormula(damageFormula);
    const fullDamage = damageRoll.total;

    const resolvedTargets = targets.map(target => {
      const saveMod = getSaveMod(target, spell.save);
      const saveRoll = d20();
      const saveTotal = saveRoll + saveMod;
      const saved = saveTotal >= saveDC;
      const damage = saved ? Math.floor(fullDamage / 2) : fullDamage;
      return {
        id: target.id,
        name: target.name,
        saveRoll,
        saveMod,
        saveTotal,
        saved,
        fullDamage,
        damage,
        damageType: spell.damageType || 'force',
      };
    });

    return {
      type: 'spell-save',
      caster: caster.id,
      casterName: caster.name,
      spell: spell.name,
      saveDC,
      damageRoll: fullDamage,
      damageDiceTotal: damageRoll.diceTotal,
      damageModifier: damageRoll.modifier,
      damageRolls: damageRoll.rolls,
      damageFormula,
      damageType: spell.damageType || 'force',
      targets: resolvedTargets,
    };
  }

  // --- Attack-roll spell ---
  if (spell.attack) {
    const attackWeapon = {
      name: spell.name,
      attackMod: Number.isFinite(Number(findAttackProfile(caster, 'spell', spell.name)?.attackBonus))
        ? Number(findAttackProfile(caster, 'spell', spell.name).attackBonus)
        : (spell.attackMod || spellAbility || 'int'),
      damage: getDamageFormula(caster, spell, 'spell'),
      damageType: spell.damageType || 'force',
      properties: spell.properties || [],
      source: 'spell',
    };
    const results = targets.map(t => resolveAttack(caster, t, attackWeapon, conditions, activeEffects));
    return {
      type: 'spell-attack',
      caster: caster.id,
      casterName: caster.name,
      spell: spell.name,
      attacks: results,
    };
  }

  // --- Buff / other ---
  return {
    type: 'buff',
    caster: caster.id,
    casterName: caster.name,
    spell: spell.name,
    effect: spell.effect || null,
    targets: targets.map(t => ({ id: t.id, name: t.name })),
  };
}

// ---------------------------------------------------------------------------
// applyDamage
// ---------------------------------------------------------------------------

/**
 * Apply damage to a target, accounting for resistance, vulnerability, immunity.
 */
function applyDamage(target, damage, damageType, activeEffects = []) {
  const immune = (target.immunities || []).includes(damageType);
  const resistant = !immune && (target.resistances || []).includes(damageType);
  const vulnerable = !immune && (target.vulnerabilities || []).includes(damageType);

  let effectiveDamage = damage;
  if (immune) {
    effectiveDamage = 0;
  } else if (resistant) {
    effectiveDamage = Math.floor(damage / 2);
  } else if (vulnerable) {
    effectiveDamage = damage * 2;
  }

  const hpBefore = target.hp;
  const hp = Math.max(0, hpBefore - effectiveDamage);

  return {
    id: target.id,
    name: target.name,
    hpBefore,
    hp,
    maxHp: target.maxHp,
    effectiveDamage,
    damageType,
    resistant,
    vulnerable,
    immune,
  };
}

// ---------------------------------------------------------------------------
// checkDeath
// ---------------------------------------------------------------------------

/**
 * Determine the living status of a combatant.
 * Enemies/NPCs die instantly at 0 HP; PCs fall unconscious.
 */
function checkDeath(combatant) {
  if (combatant.hp > 0) return { status: 'alive', id: combatant.id, name: combatant.name };
  if (combatant.type === 'PC') return { status: 'unconscious', id: combatant.id, name: combatant.name };
  return { status: 'dead', id: combatant.id, name: combatant.name };
}

// ---------------------------------------------------------------------------
// resolveDeathSave
// ---------------------------------------------------------------------------

/**
 * Deterministic death save resolution given an explicit roll value.
 * Used for testing and internal implementation.
 */
function _resolveDeathSaveWithRoll(combatant, rollValue) {
  const saves = combatant.deathSaves || { successes: 0, failures: 0 };
  let successes = saves.successes;
  let failures = saves.failures;
  let stabilized = false;
  let dead = false;
  let hp = combatant.hp;

  const isSuccess = rollValue >= 10;

  if (rollValue === 20) {
    // Natural 20: stabilize and restore 1 HP
    stabilized = true;
    hp = 1;
    successes = 3; // mark as fully stabilized
  } else if (rollValue === 1) {
    // Natural 1: double failure
    failures += 2;
  } else if (isSuccess) {
    successes += 1;
  } else {
    failures += 1;
  }

  if (failures >= 3) dead = true;
  if (successes >= 3 && !stabilized) stabilized = true;

  return {
    roll: rollValue,
    success: isSuccess,
    stabilized,
    dead,
    hp,
    successes,
    failures,
  };
}

/**
 * Resolve a death saving throw by rolling a d20.
 */
function resolveDeathSave(combatant) {
  const rollValue = d20();
  return _resolveDeathSaveWithRoll(combatant, rollValue);
}

// ---------------------------------------------------------------------------
// resolveConcentrationCheck
// ---------------------------------------------------------------------------

/**
 * When a concentrating caster takes damage, they make a CON save.
 * DC = max(10, floor(damageTaken / 2)).
 */
function resolveConcentrationCheck(caster, damageTaken) {
  const dc = Math.max(10, Math.floor(damageTaken / 2));
  const saveMod = getSaveMod(caster, 'con');
  const rollValue = d20();
  const total = rollValue + saveMod;
  const success = total >= dc;

  return {
    dc,
    roll: rollValue,
    saveMod,
    total,
    success,
    spell: caster.concentrating ? caster.concentrating.name : null,
  };
}

// ---------------------------------------------------------------------------
// getAvailableActions
// ---------------------------------------------------------------------------

/**
 * Return a list of available actions for a combatant on their turn.
 * Includes weapons, spells (if spell slots available), dodge, disengage, dash.
 */
function getAvailableActions(combatant) {
  const actions = [];

  // Weapon attacks
  for (const weapon of (combatant.weapons || [])) {
    const profile = findAttackProfile(combatant, 'weapon', weapon.name);
    if (!profileIsUsable(profile)) continue;
    actions.push({
      type: 'weapon',
      name: weapon.name,
      label: `Attack with ${weapon.name}`,
      weapon,
      attacksPerAction: getAttacksPerAction(combatant, weapon, 'weapon'),
    });
  }

  // Spells — cantrips are always available; leveled spells require slots.
  const hasSlots = Object.values(combatant.spellSlots || {}).some(v => v > 0);
  for (const spell of (combatant.spells || [])) {
    const profile = findAttackProfile(combatant, 'spell', spell.name);
    if (!profileIsUsable(profile)) continue;
    const isFreeCantrip = spell.level === 0 || (spell.properties || []).includes('cantrip') || profile?.cantrip;
    const requiredLevel = spell.level || 1;
    const availableAtLevel = Object.entries(combatant.spellSlots || {}).some(
      ([lvl, count]) => parseInt(lvl, 10) >= requiredLevel && count > 0
    );
    if (isFreeCantrip || (hasSlots && availableAtLevel)) {
      actions.push({ type: 'spell', name: spell.name, label: `Cast ${spell.name}`, spell });
    }
  }

  // Basic actions always available
  actions.push({ type: 'dodge', name: 'Dodge' });
  actions.push({ type: 'disengage', name: 'Disengage' });
  actions.push({ type: 'dash', name: 'Dash' });

  return actions;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getAbilityMod,
  getSaveMod,
  getSpellSaveDC,
  getAttackMod,
  rollInitiative,
  resolveAttack,
  resolveSpell,
  applyDamage,
  checkDeath,
  resolveDeathSave,
  _resolveDeathSaveWithRoll,
  resolveConcentrationCheck,
  getAvailableActions,
  getAttacksPerAction,
};
