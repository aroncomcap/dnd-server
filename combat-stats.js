'use strict';

function slugify(value) {
  return String(value || 'attack')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'attack';
}

function abilityMod(score) {
  if (score === undefined || score === null || isNaN(score)) return 0;
  return Math.floor((Number(score) - 10) / 2);
}

function signed(value) {
  const n = Number(value) || 0;
  if (n === 0) return '';
  return n > 0 ? `+${n}` : `${n}`;
}

function hasFlatModifier(notation) {
  if (typeof notation !== 'string') return false;
  const tokens = notation.match(/([+-]?(?:\d*d\d+|\d+))/gi) || [];
  return tokens.some(token => !/^[+-]?\d*d\d+$/i.test(token));
}

function appendFlatModifier(notation, bonus) {
  const formula = String(notation || '1d4').replace(/\s+/g, '');
  return `${formula}${signed(bonus)}`;
}

function inferWeaponAbility(combatant, weapon = {}) {
  if (typeof weapon.attackMod === 'string' && combatant?.abilities?.[weapon.attackMod] !== undefined) {
    return weapon.attackMod;
  }

  const props = (weapon.properties || []).map(p => String(p).toLowerCase());
  const name = String(weapon.name || '').toLowerCase();
  const abilities = combatant?.abilities || {};
  const str = abilityMod(abilities.str);
  const dex = abilityMod(abilities.dex);

  if (props.includes('finesse')) return dex > str ? 'dex' : 'str';
  if (props.includes('ranged') || /bow|crossbow|sling|dart|firearm/.test(name)) return 'dex';
  return 'str';
}

function getBaseAttacksPerAction(stats = {}) {
  if (Number.isFinite(Number(stats.attacksPerAction)) && Number(stats.attacksPerAction) > 0) {
    return Math.max(1, Math.floor(Number(stats.attacksPerAction)));
  }

  const features = Array.isArray(stats.features) ? stats.features : [];
  let attacks = 1;
  for (const feature of features) {
    const text = String(feature || '');
    const explicit = text.match(/(?:extra attack|multiattack)[^0-9]*(\d+)/i);
    if (explicit) {
      attacks = Math.max(attacks, Number(explicit[1]));
      continue;
    }
    if (/extra attack|multiattack/i.test(text)) attacks = Math.max(attacks, 2);
  }
  return attacks;
}

function getSpellcastingAbility(stats = {}) {
  if (stats.spellcastingAbility) return stats.spellcastingAbility;
  const cls = String(stats.class || '').toLowerCase();
  if (/wizard|artificer/.test(cls)) return 'int';
  if (/cleric|druid|ranger/.test(cls)) return 'wis';
  if (/bard|paladin|sorcerer|warlock/.test(cls)) return 'cha';
  return 'int';
}

function getSpellAttackBonus(stats = {}, spell = {}) {
  if (Number.isFinite(Number(spell.attackMod))) return Number(spell.attackMod);
  if (Number.isFinite(Number(stats.spellAttackBonus))) return Number(stats.spellAttackBonus);
  const ability = spell.attackMod && stats.abilities?.[spell.attackMod] !== undefined
    ? spell.attackMod
    : getSpellcastingAbility(stats);
  return abilityMod(stats.abilities?.[ability]) + (Number(stats.proficiencyBonus) || 2);
}

function getSpellSaveDC(stats = {}, spell = {}) {
  if (Number.isFinite(Number(spell.saveDC))) return Number(spell.saveDC);
  if (Number.isFinite(Number(stats.spellSaveDC))) return Number(stats.spellSaveDC);
  const ability = getSpellcastingAbility(stats);
  return 8 + (Number(stats.proficiencyBonus) || 2) + abilityMod(stats.abilities?.[ability]);
}

function getWeaponAttackBonus(combatant = {}, weapon = {}) {
  if (Number.isFinite(Number(weapon.attackMod))) return Number(weapon.attackMod);
  if (Number.isFinite(Number(weapon.attackBonus))) return Number(weapon.attackBonus);
  if (Number.isFinite(Number(combatant.attackBonus))) return Number(combatant.attackBonus);
  const ability = inferWeaponAbility(combatant, weapon);
  const magic = Number(weapon.magicBonus ?? weapon.enhancementBonus ?? 0) || 0;
  return abilityMod(combatant.abilities?.[ability]) + (Number(combatant.proficiencyBonus) || 2) + magic;
}

function getWeaponDamageFormula(combatant = {}, weapon = {}) {
  const damage = String(weapon.damage || '1d4').replace(/\s+/g, '');
  const extra = Number(weapon.damageBonus ?? weapon.magicDamageBonus ?? weapon.magicBonus ?? 0) || 0;
  if (hasFlatModifier(damage)) return appendFlatModifier(damage, extra);

  const props = (weapon.properties || []).map(p => String(p).toLowerCase());
  const ability = inferWeaponAbility(combatant, weapon);
  const abilityBonus = props.includes('off-hand') ? 0 : abilityMod(combatant.abilities?.[ability]);
  return appendFlatModifier(damage, abilityBonus + extra);
}

function isCantrip(spell = {}) {
  const props = (spell.properties || []).map(p => String(p).toLowerCase());
  return spell.level === 0 ||
    props.includes('cantrip') ||
    /\b(cantrip|fire bolt|eldritch blast|ray of frost|vicious mockery|sacred flame|shillelagh|chill touch|acid splash|toll the dead)\b/i.test(spell.name || '');
}

function cantripDiceCount(level) {
  const lvl = Number(level) || 1;
  if (lvl >= 17) return 4;
  if (lvl >= 11) return 3;
  if (lvl >= 5) return 2;
  return 1;
}

function scaleCantripDamageFormula(formula, level) {
  const desired = cantripDiceCount(level);
  return String(formula || '1d10').replace(/(\d*)d(\d+)/i, (_match, count, faces) => {
    const current = count ? Number(count) : 1;
    return `${Math.max(current, desired)}d${faces}`;
  });
}

function findAttackProfile(combatant = {}, sourceOrWeapon, nameArg) {
  const source = typeof sourceOrWeapon === 'string' ? sourceOrWeapon : 'weapon';
  const name = typeof sourceOrWeapon === 'string' ? nameArg : sourceOrWeapon?.name;
  const id = `${source}-${slugify(name)}`;
  return (combatant.attackProfiles || []).find(profile =>
    profile.id === id ||
    (profile.source === source && String(profile.name || '').toLowerCase() === String(name || '').toLowerCase())
  ) || null;
}

function profileIsUsable(profile) {
  if (!profile) return true;
  if (profile.enabled === false) return false;
  if (profile.source === 'weapon' && profile.carried === false) return false;
  return true;
}

function mergeProfile(autoProfile, existing) {
  const base = {
    ...autoProfile,
    enabled: true,
    carried: autoProfile.source === 'weapon' ? true : undefined,
    manual: false,
    auto: {
      attackBonus: autoProfile.attackBonus,
      damageFormula: autoProfile.damageFormula,
      attacksPerAction: autoProfile.attacksPerAction,
      saveDC: autoProfile.saveDC,
    },
  };

  if (!existing) return base;

  const merged = {
    ...base,
    enabled: existing.enabled !== undefined ? !!existing.enabled : base.enabled,
    carried: existing.carried !== undefined ? !!existing.carried : base.carried,
    notes: existing.notes || base.notes || '',
    manual: !!existing.manual,
  };

  if (existing.manual) {
    if (Number.isFinite(Number(existing.attackBonus))) merged.attackBonus = Number(existing.attackBonus);
    if (typeof existing.damageFormula === 'string' && existing.damageFormula.trim()) merged.damageFormula = existing.damageFormula.trim();
    if (Number.isFinite(Number(existing.attacksPerAction)) && Number(existing.attacksPerAction) > 0) {
      merged.attacksPerAction = Math.max(1, Math.floor(Number(existing.attacksPerAction)));
    }
    if (Number.isFinite(Number(existing.saveDC))) merged.saveDC = Number(existing.saveDC);
  }

  return merged;
}

function normalizeDnd5eCombatStats(stats) {
  if (!stats || typeof stats !== 'object') return stats;
  if (stats.system && stats.system !== 'dnd5e') return stats;

  const normalized = { ...stats, system: 'dnd5e' };
  normalized.weapons = Array.isArray(stats.weapons) ? stats.weapons.map(w => ({ ...w })) : [];
  normalized.spells = Array.isArray(stats.spells) ? stats.spells.map(s => ({ ...s })) : [];
  normalized.features = Array.isArray(stats.features) ? [...stats.features] : [];
  normalized.abilities = { ...(stats.abilities || {}) };
  normalized.proficiencyBonus = Number(stats.proficiencyBonus) || (normalized.level >= 17 ? 6 : normalized.level >= 13 ? 5 : normalized.level >= 9 ? 4 : normalized.level >= 5 ? 3 : 2);
  normalized.attacksPerAction = getBaseAttacksPerAction(normalized);

  const existingById = new Map((stats.attackProfiles || []).map(profile => [profile.id, profile]));
  const profiles = [];

  for (const weapon of normalized.weapons) {
    const id = `weapon-${slugify(weapon.name)}`;
    const autoProfile = {
      id,
      source: 'weapon',
      name: weapon.name,
      label: `Attack with ${weapon.name}`,
      attackBonus: getWeaponAttackBonus(normalized, weapon),
      damageFormula: getWeaponDamageFormula(normalized, weapon),
      damageType: weapon.damageType || 'bludgeoning',
      attacksPerAction: normalized.attacksPerAction,
    };
    profiles.push(mergeProfile(autoProfile, existingById.get(id)));
  }

  for (const spell of normalized.spells) {
    if (!spell.damage && !spell.healing) continue;
    const id = `spell-${slugify(spell.name)}`;
    const cantrip = isCantrip(spell);
    const damageFormula = cantrip
      ? scaleCantripDamageFormula(spell.damage || spell.healing || '1d10', normalized.level)
      : String(spell.damage || spell.healing || '1d6').replace(/\s+/g, '');
    const autoProfile = {
      id,
      source: 'spell',
      name: spell.name,
      label: spell.attack ? `Cast ${spell.name}` : `${spell.name}${spell.save ? ` (DC ${getSpellSaveDC(normalized, spell)})` : ''}`,
      attackBonus: spell.attack ? getSpellAttackBonus(normalized, spell) : null,
      saveDC: spell.save ? getSpellSaveDC(normalized, spell) : null,
      damageFormula,
      damageType: spell.damageType || (spell.healing ? 'healing' : 'force'),
      attacksPerAction: spell.attack && /eldritch blast/i.test(spell.name || '') ? cantripDiceCount(normalized.level) : 1,
      cantrip,
    };
    profiles.push(mergeProfile(autoProfile, existingById.get(id)));
  }

  normalized.attackProfiles = profiles;
  return normalized;
}

function getAttackBonus(combatant = {}, weaponOrSpell = {}, source = 'weapon') {
  const profile = findAttackProfile(combatant, source, weaponOrSpell.name);
  if (profile && profileIsUsable(profile) && Number.isFinite(Number(profile.attackBonus))) {
    return Number(profile.attackBonus);
  }
  if (source === 'spell') return getSpellAttackBonus(combatant, weaponOrSpell);
  return getWeaponAttackBonus(combatant, weaponOrSpell);
}

function getDamageFormula(combatant = {}, weaponOrSpell = {}, source = 'weapon') {
  const profile = findAttackProfile(combatant, source, weaponOrSpell.name);
  if (profile && profileIsUsable(profile) && profile.damageFormula) {
    return profile.damageFormula;
  }
  if (source === 'spell') {
    const formula = weaponOrSpell.damage || weaponOrSpell.healing || '1d6';
    return isCantrip(weaponOrSpell) ? scaleCantripDamageFormula(formula, combatant.level) : formula;
  }
  return getWeaponDamageFormula(combatant, weaponOrSpell);
}

function getAttacksPerAction(combatant = {}, weaponOrSpell = {}, source = 'weapon') {
  const profile = findAttackProfile(combatant, source, weaponOrSpell.name);
  if (!profileIsUsable(profile)) return 1;
  if (profile && Number.isFinite(Number(profile.attacksPerAction)) && Number(profile.attacksPerAction) > 0) {
    return Math.max(1, Math.floor(Number(profile.attacksPerAction)));
  }
  return source === 'weapon' ? getBaseAttacksPerAction(combatant) : 1;
}

function applyCombatProfileEdits(stats, edits) {
  if (!stats || typeof stats !== 'object') return stats;
  if (!Array.isArray(edits)) return normalizeDnd5eCombatStats(stats);
  const clean = edits
    .filter(profile => profile && typeof profile.id === 'string')
    .map(profile => ({
      id: profile.id,
      source: profile.source,
      name: profile.name,
      enabled: profile.enabled !== false,
      carried: profile.carried !== false,
      attackBonus: Number.isFinite(Number(profile.attackBonus)) ? Number(profile.attackBonus) : undefined,
      saveDC: Number.isFinite(Number(profile.saveDC)) ? Number(profile.saveDC) : undefined,
      damageFormula: typeof profile.damageFormula === 'string' ? profile.damageFormula.trim().slice(0, 60) : undefined,
      attacksPerAction: Number.isFinite(Number(profile.attacksPerAction)) ? Math.max(1, Math.floor(Number(profile.attacksPerAction))) : undefined,
      manual: !!profile.manual,
      notes: typeof profile.notes === 'string' ? profile.notes.trim().slice(0, 200) : '',
    }));
  return normalizeDnd5eCombatStats({ ...stats, attackProfiles: clean });
}

module.exports = {
  slugify,
  abilityMod,
  hasFlatModifier,
  inferWeaponAbility,
  getBaseAttacksPerAction,
  getWeaponAttackBonus,
  getWeaponDamageFormula,
  getSpellAttackBonus,
  getSpellSaveDC,
  isCantrip,
  scaleCantripDamageFormula,
  findAttackProfile,
  profileIsUsable,
  normalizeDnd5eCombatStats,
  getAttackBonus,
  getDamageFormula,
  getAttacksPerAction,
  applyCombatProfileEdits,
};
