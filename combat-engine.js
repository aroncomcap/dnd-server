'use strict';

const dnd5e = require('./resolvers/dnd5e-resolver');
const runequest = require('./resolvers/runequest-resolver');
const { getAttacksPerAction } = require('./combat-stats');

// ---------------------------------------------------------------------------
// CombatEngine
// ---------------------------------------------------------------------------

class CombatEngine {
  constructor() {
    this.state = {
      active: false,
      round: 0,
      system: null,
      turnIndex: 0,
      initiativeOrder: [],   // [{ id, name, init, type }]
      combatants: {},        // { [id]: combatantData }
      activeEffects: [],     // [{ name, caster, targets, effect, duration, roundApplied }]
      pendingReaction: null,
      log: [],
    };
  }

  // -------------------------------------------------------------------------
  // getResolver
  // -------------------------------------------------------------------------

  /** Returns the resolver module for the current system. */
  getResolver() {
    if (this.state.system === 'runequest') return runequest;
    return dnd5e;
  }

  // -------------------------------------------------------------------------
  // initCombat
  // -------------------------------------------------------------------------

  /**
   * Set up a new combat encounter.
   * @param {object[]} pcs     - PC combatant objects (already have combatStats)
   * @param {object[]} enemies - Enemy combatant objects
   * @param {string}   system  - 'dnd5e' or 'runequest'
   * @returns {object} state
   */
  initCombat(pcs, enemies, system) {
    this.state.system = system;
    const resolver = this.getResolver();

    // Store all combatants
    this.state.combatants = {};
    for (const c of [...pcs, ...enemies]) {
      this.state.combatants[c.id] = { ...c };
    }

    // Roll initiative for each combatant
    const initiativeOrder = [];
    for (const c of [...pcs, ...enemies]) {
      const init = resolver.rollInitiative(c);
      initiativeOrder.push({
        id: c.id,
        name: c.name,
        init,
        type: c.type,
      });
    }

    // Sort: D&D = highest first (descending), RuneQuest = lowest first (ascending / strike rank)
    if (system === 'runequest') {
      initiativeOrder.sort((a, b) => a.init - b.init);
    } else {
      initiativeOrder.sort((a, b) => b.init - a.init);
    }

    this.state.initiativeOrder = initiativeOrder;
    this.state.round = 1;
    this.state.turnIndex = 0;
    this.state.active = true;
    this.state.activeEffects = [];
    this.state.pendingReaction = null;
    this.state.log = [];

    return this.state;
  }

  // -------------------------------------------------------------------------
  // getCombatant / getCurrentTurn
  // -------------------------------------------------------------------------

  /** Get a combatant by id. */
  getCombatant(id) {
    return this.state.combatants[id];
  }

  /** Get the combatant whose turn it currently is. */
  getCurrentTurn() {
    const entry = this.state.initiativeOrder[this.state.turnIndex];
    if (!entry) return null;
    return this.state.combatants[entry.id];
  }

  // -------------------------------------------------------------------------
  // advanceTurn
  // -------------------------------------------------------------------------

  /**
   * Advance to the next living combatant.
   * Increments round on wrap; calls expireEffects() on round wrap.
   */
  advanceTurn() {
    const order = this.state.initiativeOrder;
    const total = order.length;
    if (total === 0) return;

    const resolver = this.getResolver();
    let attempts = 0;

    do {
      this.state.turnIndex++;
      if (this.state.turnIndex >= total) {
        this.state.turnIndex = 0;
        this.state.round++;
        this.expireEffects();
      }
      attempts++;
      if (attempts > total) break; // safety: avoid infinite loop if all dead

      const current = this.state.combatants[order[this.state.turnIndex].id];
      if (!current) continue;
      const deathStatus = resolver.checkDeath(current);
      if (deathStatus.status !== 'dead') break;
    } while (true);
  }

  // -------------------------------------------------------------------------
  // resolveAction
  // -------------------------------------------------------------------------

  /**
   * Route an action to the correct resolver and update state.
   *
   * Action shapes:
   *   attack:    { type, attackerId, targetId, weaponName }
   *   spell:     { type, casterId, targetIds, spellName, slotLevel }
   *   dodge:     { type, actorId }
   *   disengage: { type, actorId }
   *   dash:      { type, actorId }
   *
   * @param {object} action
   * @returns {object} result
   */
  resolveAction(action) {
    const resolver = this.getResolver();
    let result;

    switch (action.type) {
      case 'attack': {
        const attacker = this.state.combatants[action.attackerId];
        const target   = this.state.combatants[action.targetId];
        if (!attacker) { result = { type: 'error', message: `Unknown attacker: ${action.attackerId}` }; break; }
        if (!target) { result = { type: 'error', message: `Unknown target: ${action.targetId}` }; break; }
        const weaponName = action.weaponName || action.weapon;
        const weapon   = (attacker.weapons || []).find(w => w.name === weaponName || w.name?.toLowerCase() === weaponName?.toLowerCase())
          || (attacker.weapons || [])[0];

        if (this.state.system === 'runequest') {
          result = resolver.resolveAttack(attacker, target, weapon, action.defenseChoice || 'none');
          // Apply damage if hit
          if (result.attackResult !== 'miss' && result.attackResult !== 'fumble' && result.hitLocation) {
            const dmgResult = resolver.applyDamage(target, result.damage, result.hitLocation);
            result.damageApplied = dmgResult;
            result.hpBefore = dmgResult.locationHpBefore;
            // Update stored combatant (already mutated by applyDamage)
            this.state.combatants[action.targetId] = target;
          }
        } else {
          const attackCount = getAttacksPerAction(attacker, weapon, 'weapon');
          const attacks = [];
          for (let i = 0; i < attackCount; i++) {
            if (resolver.checkDeath(target).status === 'dead') break;
            const attackResult = resolver.resolveAttack(attacker, target, weapon, [], this.state.activeEffects);
            attackResult.attackNumber = i + 1;
            attackResult.attackCount = attackCount;
            if (attackResult.hit) {
              const hpBefore = target.hp;
              const dmgResult = resolver.applyDamage(target, attackResult.totalDamage, attackResult.damageType, this.state.activeEffects);
              attackResult.hpBefore = hpBefore;
              attackResult.hpAfter  = dmgResult.hp;
              this.state.combatants[action.targetId].hp = dmgResult.hp;
              target.hp = dmgResult.hp;
            }
            attacks.push(attackResult);
          }

          if (attacks.length === 1) {
            result = attacks[0];
          } else {
            result = {
              type: 'multiattack',
              attacker: attacker.id,
              attackerName: attacker.name,
              target: target.id,
              targetName: target.name,
              weapon: weapon.name,
              attacks,
            };
          }
        }
        break;
      }

      case 'spell': {
        const casterId = action.casterId || action.attackerId;
        const caster  = this.state.combatants[casterId];
        if (!caster) { result = { type: 'error', message: `Unknown caster: ${casterId}` }; break; }
        const targetIds = action.targetIds || (action.targetId ? [action.targetId] : []);
        const targets = targetIds.map(id => this.state.combatants[id]).filter(Boolean);
        const spellName = action.spellName || action.spell;
        const spell   = (caster.spells || []).find(s => s.name === spellName || s.name?.toLowerCase() === spellName?.toLowerCase());

        if (!spell) {
          result = { type: 'error', message: `Spell "${spellName}" not found on ${caster?.name}` };
          break;
        }

        result = resolver.resolveSpell(caster, spell, targets, [], this.state.activeEffects);

        // Deduct spell slot
        const level = action.slotLevel || spell.level || 1;
        if (caster.spellSlots && caster.spellSlots[level] > 0) {
          this.state.combatants[casterId].spellSlots[level]--;
          result.slotUsed = true;
        }

        // Apply healing
        if (result.type === 'heal') {
          for (const t of result.targets) {
            const combatant = this.state.combatants[t.id];
            if (combatant) {
              const hpBefore = combatant.hp;
              combatant.hp = Math.min(combatant.maxHp, combatant.hp + t.healing);
              t.hpBefore = hpBefore;
              t.hpAfter  = combatant.hp;
            }
          }
        }

        // Apply save-based damage
        if (result.type === 'spell-save') {
          for (const t of result.targets) {
            const combatant = this.state.combatants[t.id];
            if (combatant && t.damage > 0) {
              const hpBefore = combatant.hp;
              combatant.hp = Math.max(0, combatant.hp - t.damage);
              t.hpBefore = hpBefore;
              t.hpAfter  = combatant.hp;
            }
          }
        }

        // Apply spell-attack damage (attack-roll spells)
        if (result.type === 'spell-attack') {
          for (const atk of result.attacks || []) {
            if (atk.hit) {
              const combatant = this.state.combatants[atk.target];
              if (combatant) {
                const hpBefore = combatant.hp;
                const dmgResult = resolver.applyDamage(combatant, atk.totalDamage, atk.damageType, this.state.activeEffects);
                atk.hpBefore = hpBefore;
                atk.hpAfter  = dmgResult.hp;
                combatant.hp = dmgResult.hp;
              }
            }
          }
        }

        // Handle concentration — mark caster and add effect if spell requires it
        if (spell.concentration) {
          this.breakConcentration(casterId);
          this.state.combatants[casterId].concentrating = { name: spell.name };
          this.addActiveEffect({
            name: spell.name,
            caster: casterId,
            targets: targetIds,
            effect: result,
            duration: { type: 'concentration' },
          });
        }

        break;
      }

      case 'dodge': {
        const actor = this.state.combatants[action.actorId];
        result = {
          type: 'dodge',
          actorId: action.actorId,
          actorName: actor ? actor.name : action.actorId,
          description: `${actor ? actor.name : action.actorId} takes the Dodge action.`,
        };
        if (actor) actor.conditions = [...(actor.conditions || []), 'dodging'];
        break;
      }

      case 'disengage': {
        const actor = this.state.combatants[action.actorId];
        result = {
          type: 'disengage',
          actorId: action.actorId,
          actorName: actor ? actor.name : action.actorId,
          description: `${actor ? actor.name : action.actorId} takes the Disengage action.`,
        };
        break;
      }

      case 'dash': {
        const actor = this.state.combatants[action.actorId];
        result = {
          type: 'dash',
          actorId: action.actorId,
          actorName: actor ? actor.name : action.actorId,
          description: `${actor ? actor.name : action.actorId} takes the Dash action.`,
        };
        break;
      }

      case 'death_save': {
        const actor = this.state.combatants[action.actorId || action.attackerId];
        if (!actor) { result = { type: 'error', message: `Unknown actor for death save` }; break; }
        result = resolver.resolveDeathSave(actor);
        result.actorId = actor.id;
        result.actorName = actor.name;
        // Update combatant state
        actor.deathSaves = { successes: result.successes, failures: result.failures };
        if (result.revived) actor.hp = result.hp;
        break;
      }

      default:
        result = { type: 'unknown', action };
    }

    this.state.log.push(result);
    return result;
  }

  // -------------------------------------------------------------------------
  // Active Effects
  // -------------------------------------------------------------------------

  /**
   * Add a buff/debuff with duration tracking.
   * @param {object} effect - { name, caster, targets, effect, duration: { type, count? } }
   */
  addActiveEffect(effect) {
    this.state.activeEffects.push({
      ...effect,
      roundApplied: this.state.round,
    });
  }

  /**
   * Remove expired effects (round-based duration).
   * concentration and permanent effects are NOT removed here.
   */
  expireEffects() {
    this.state.activeEffects = this.state.activeEffects.filter(e => {
      const d = e.duration;
      if (!d || d.type === 'permanent' || d.type === 'concentration') return true;
      if (d.type === 'rounds') {
        return (this.state.round - e.roundApplied) < d.count;
      }
      return true;
    });
  }

  /**
   * Remove all concentration effects cast by the given caster id.
   * Also clears combatant.concentrating.
   * @param {string} casterId
   */
  breakConcentration(casterId) {
    this.state.activeEffects = this.state.activeEffects.filter(
      e => !(e.caster === casterId && e.duration && e.duration.type === 'concentration')
    );
    const caster = this.state.combatants[casterId];
    if (caster) caster.concentrating = null;
  }

  // -------------------------------------------------------------------------
  // getReactionTriggers
  // -------------------------------------------------------------------------

  /**
   * Detect reaction opportunities for a combatant given an event.
   *
   * @param {string} combatantId
   * @param {object} event - { type, damage?, attackTotal?, targetAC? }
   * @returns {object[]} array of reaction options
   */
  getReactionTriggers(combatantId, event) {
    const combatant = this.state.combatants[combatantId];
    if (!combatant) return [];
    if (event.type !== 'damage') return [];
    if (!combatant.concentrating) return [];

    const triggers = [];

    // Always offer concentration check on damage
    triggers.push({
      type: 'concentrationCheck',
      description: 'Roll CON save to maintain concentration',
      dc: Math.max(10, Math.floor((event.damage || 0) / 2)),
    });

    // Inspiration: offer advantage on concentration save
    if (combatant.inspiration) {
      triggers.push({
        type: 'useInspiration',
        description: 'Use inspiration for advantage on CON save',
      });
    }

    // Shield spell reaction (D&D only)
    if (this.state.system === 'dnd5e') {
      const shieldSpell = (combatant.spells || []).find(s => s.name === 'Shield' || s.name === 'shield');
      const hasSlot = shieldSpell &&
        Object.entries(combatant.spellSlots || {}).some(([lvl, cnt]) => parseInt(lvl, 10) >= 1 && cnt > 0);
      // Only offer if attack would miss with +5 AC
      if (hasSlot && event.attackTotal !== undefined) {
        const wouldMissWithShield = event.attackTotal < (combatant.ac + 5);
        const currentlyHit = event.attackTotal >= combatant.ac;
        if (currentlyHit && wouldMissWithShield) {
          triggers.push({
            type: 'castShield',
            description: 'Cast Shield as a reaction (+5 AC, negates hit)',
          });
        }
      }
    }

    return triggers;
  }

  // -------------------------------------------------------------------------
  // isCombatOver / endCombat
  // -------------------------------------------------------------------------

  /**
   * Check if combat is over: all enemies dead OR all PCs down.
   * @returns {boolean}
   */
  isCombatOver() {
    const resolver = this.getResolver();
    const combatants = Object.values(this.state.combatants);

    const pcs      = combatants.filter(c => c.type === 'PC');
    const enemies  = combatants.filter(c => c.type !== 'PC');

    const allEnemiesDead = enemies.length > 0 &&
      enemies.every(e => resolver.checkDeath(e).status === 'dead');

    if (allEnemiesDead) return { over: true, reason: 'enemies_defeated' };

    const allPCsDown = pcs.length > 0 &&
      pcs.every(p => {
        const status = resolver.checkDeath(p).status;
        return status === 'dead' || status === 'unconscious';
      });

    if (allPCsDown) return { over: true, reason: 'party_defeated' };

    return { over: false, reason: null };
  }

  // -------------------------------------------------------------------------
  // getCombatSummary
  // -------------------------------------------------------------------------

  /**
   * Return per-character damage/healing statistics accumulated from the combat log.
   * @returns {{ rounds: number, characters: Object }}
   */
  getCombatSummary() {
    // Initialize all combatants with zero stats
    const characters = {};
    for (const [id, c] of Object.entries(this.state.combatants)) {
      characters[id] = {
        name: c.name,
        type: c.type,
        damageDealt: 0,
        damageTaken: 0,
        healed: 0,
        spellSlotsUsed: 0,
      };
    }

    // Helper to ensure a character entry exists (guards against missing combatants)
    const ensure = (id) => {
      if (!characters[id]) {
        const c = this.state.combatants[id];
        characters[id] = {
          name: c ? c.name : id,
          type: c ? c.type : 'Unknown',
          damageDealt: 0,
          damageTaken: 0,
          healed: 0,
          spellSlotsUsed: 0,
        };
      }
    };

    for (const entry of this.state.log) {
      // Track spell slot usage on any log entry that has slotUsed
      if (entry.slotUsed) {
        const casterId = entry.caster;
        if (casterId) {
          ensure(casterId);
          characters[casterId].spellSlotsUsed++;
        }
      }

      switch (entry.type) {
        case 'attack': {
          if (entry.hit && entry.totalDamage > 0) {
            const attId = entry.attacker;
            const tgtId = entry.target;
            if (attId) { ensure(attId); characters[attId].damageDealt += entry.totalDamage; }
            if (tgtId) { ensure(tgtId); characters[tgtId].damageTaken += entry.totalDamage; }
          }
          break;
        }

        case 'multiattack': {
          for (const attack of entry.attacks || []) {
            if (attack.hit && attack.totalDamage > 0) {
              const attId = attack.attacker;
              const tgtId = attack.target;
              if (attId) { ensure(attId); characters[attId].damageDealt += attack.totalDamage; }
              if (tgtId) { ensure(tgtId); characters[tgtId].damageTaken += attack.totalDamage; }
            }
          }
          break;
        }

        case 'spell-save': {
          const casterId = entry.caster;
          for (const t of entry.targets || []) {
            if (t.damage > 0) {
              if (casterId) { ensure(casterId); characters[casterId].damageDealt += t.damage; }
              if (t.id) { ensure(t.id); characters[t.id].damageTaken += t.damage; }
            }
          }
          break;
        }

        case 'spell-attack': {
          const casterId = entry.caster;
          for (const atk of entry.attacks || []) {
            if (atk.hit && atk.totalDamage > 0) {
              if (casterId) { ensure(casterId); characters[casterId].damageDealt += atk.totalDamage; }
              const tgtId = atk.target;
              if (tgtId) { ensure(tgtId); characters[tgtId].damageTaken += atk.totalDamage; }
            }
          }
          break;
        }

        case 'heal': {
          const casterId = entry.caster;
          if (casterId) {
            ensure(casterId);
            characters[casterId].healed += entry.totalHealing || 0;
          }
          break;
        }

        default:
          break;
      }
    }

    return {
      rounds: this.state.round,
      characters,
    };
  }

  /**
   * End the combat encounter.
   * @returns {object} final state
   */
  endCombat() {
    this.state.active = false;
    return this.state;
  }

  /**
   * Restore combat state from a persisted snapshot (DB).
   * @param {object} saved - previously persisted this.state
   */
  loadState(saved) {
    if (!saved || !saved.active) return;
    this.state = { ...saved };
  }

  // -------------------------------------------------------------------------
  // formatResultForPrompt
  // -------------------------------------------------------------------------

  /**
   * Format a single combat action result as human-readable text.
   * @param {object} result
   * @returns {string}
   */
  formatResultForPrompt(result) {
    switch (result.type) {
      case 'attack': {
        if (this.state.system === 'runequest') {
          return this._formatRQAttack(result);
        }
        return this._formatDnDAttack(result);
      }
      case 'multiattack': {
        const lines = [`${result.attackerName} makes ${result.attacks?.length || 0} attacks with ${result.weapon}.`];
        for (const attack of result.attacks || []) {
          lines.push(this._formatDnDAttack(attack));
        }
        return lines.join('\n');
      }
      case 'spell-save': {
        const lines = [`${result.casterName} casts ${result.spell} (DC ${result.saveDC} save).`];
        for (const t of result.targets || []) {
          const outcome = t.saved ? 'SAVED' : 'FAILED';
          lines.push(`  ${t.name}: rolled ${t.saveTotal} vs DC ${result.saveDC} — ${outcome}. ${t.damage} ${result.damageType || ''} damage.`);
        }
        return lines.join('\n');
      }
      case 'spell-attack': {
        const lines = [`${result.casterName} casts ${result.spell}.`];
        for (const atk of result.attacks || []) {
          lines.push(this._formatDnDAttack(atk));
        }
        return lines.join('\n');
      }
      case 'heal': {
        const targetNames = (result.targets || []).map(t => {
          const healing = t.healing;
          const hpInfo = (t.hpBefore !== undefined && t.hpAfter !== undefined)
            ? ` HP: ${t.hpBefore}→${t.hpAfter}` : '';
          return `${t.name} (+${healing}${hpInfo})`;
        }).join(', ');
        return `${result.casterName} casts ${result.spell}. Heals ${result.totalHealing} HP. Targets: ${targetNames}.`;
      }
      case 'buff': {
        const targetNames = (result.targets || []).map(t => t.name).join(', ');
        return `${result.casterName} casts ${result.spell} on ${targetNames}.`;
      }
      case 'dodge':
        return result.description || `${result.actorName} takes the Dodge action.`;
      case 'disengage':
        return result.description || `${result.actorName} takes the Disengage action.`;
      case 'dash':
        return result.description || `${result.actorName} takes the Dash action.`;
      case 'death_save': {
        const name = result.actorName || result.combatantName || 'Unknown';
        const roll = result.roll || '?';
        if (result.revived) return `${name} rolls a NATURAL 20 on their death save! They regain 1 HP and are conscious!`;
        if (result.dead) return `${name} death save: rolled ${roll}. FAILURE (${result.failures}/3). ${name} has DIED.`;
        if (result.stabilized) return `${name} death save: rolled ${roll}. SUCCESS (${result.successes}/3). ${name} is STABILIZED.`;
        const outcome = roll >= 10 ? 'SUCCESS' : 'FAILURE';
        return `${name} death save: rolled ${roll}. ${outcome} (${result.successes} successes, ${result.failures} failures).`;
      }
      default:
        return JSON.stringify(result);
    }
  }

  /** Format a D&D 5e attack result. */
  _formatDnDAttack(result) {
    const modStr  = result.modifier >= 0 ? `+${result.modifier}` : `${result.modifier}`;
    const rollStr = `d20${modStr}=${result.total}`;
    const acStr   = `vs AC ${result.targetAC}`;

    if (result.fumble) {
      return `${result.attackerName} attacks ${result.targetName} with ${result.weapon}: ${rollStr} ${acStr}. FUMBLE!`;
    }

    if (!result.hit) {
      return `${result.attackerName} attacks ${result.targetName} with ${result.weapon}: ${rollStr} ${acStr}. MISS.`;
    }

    const critStr = result.critical ? ' (CRITICAL)' : '';
    const hpStr   = (result.hpBefore !== undefined && result.hpAfter !== undefined)
      ? ` ${result.targetName} HP: ${result.hpBefore}→${result.hpAfter}.`
      : '';

    return `${result.attackerName} attacks ${result.targetName} with ${result.weapon}: ${rollStr} ${acStr}. HIT${critStr}! ${result.totalDamage} ${result.damageType}.${hpStr}`;
  }

  /** Format a RuneQuest attack result. */
  _formatRQAttack(result) {
    const skillStr  = `roll ${result.roll}%`;
    const outcome   = result.attackResult.toUpperCase();

    if (result.attackResult === 'miss') {
      return `${result.attackerName} attacks ${result.targetName} with ${result.weapon}: ${skillStr}. MISS.`;
    }

    if (result.attackResult === 'fumble') {
      const fumbleDesc = result.fumbleResult ? result.fumbleResult.description : 'Fumble!';
      return `${result.attackerName} attacks ${result.targetName} with ${result.weapon}: ${skillStr}. FUMBLE — ${fumbleDesc}`;
    }

    const locStr    = result.hitLocation ? ` Hit location: ${result.hitLocation}.` : '';
    const dmgStr    = result.damage ? ` Damage: ${result.damage}.` : '';
    const armorStr  = (result.damageApplied && result.damageApplied.armor)
      ? ` Armor absorbed: ${result.damageApplied.armor}.` : '';
    const limbStr   = (result.damageApplied && result.damageApplied.limbStatus && result.damageApplied.limbStatus !== 'ok')
      ? ` Limb status: ${result.damageApplied.limbStatus}.` : '';
    const specialStr = result.specialEffect ? ` [${result.specialEffect.type.toUpperCase()}]` : '';

    return `${result.attackerName} attacks ${result.targetName} with ${result.weapon}: ${skillStr} — ${outcome}${specialStr}.${locStr}${dmgStr}${armorStr}${limbStr}`;
  }

  // -------------------------------------------------------------------------
  // getCombatStateForPrompt
  // -------------------------------------------------------------------------

  /**
   * Format the full combat state for injection into an AI prompt.
   * @returns {string}
   */
  getCombatStateForPrompt() {
    const s = this.state;
    const resolver = this.getResolver();
    const lines = [];

    // Header
    lines.push(`ACTIVE COMBAT — Round ${s.round}`);

    // Initiative order
    const initStr = s.initiativeOrder
      .map(e => `${e.name} (${e.init})`)
      .join(' → ');
    lines.push(`Initiative: ${initStr}`);

    // Current turn
    const current = this.getCurrentTurn();
    if (current) {
      lines.push(`Current turn: ${current.name}`);
    }

    lines.push('');
    lines.push('COMBATANT STATUS:');

    for (const entry of s.initiativeOrder) {
      const c = s.combatants[entry.id];
      if (!c) continue;
      const deathStatus = resolver.checkDeath(c);

      if (deathStatus.status === 'dead') {
        lines.push(`- ${c.name}: DEAD`);
        continue;
      }

      let statusLine;
      if (s.system === 'runequest') {
        statusLine = `- ${c.name}: HP ${c.totalHp}/${c.maxTotalHp}, status: ${deathStatus.status}`;
      } else {
        const conditions = (c.conditions || []).length > 0 ? `, ${c.conditions.join(', ')}` : '';
        const unconscious = deathStatus.status === 'unconscious' ? ', UNCONSCIOUS' : '';
        statusLine = `- ${c.name}: ${c.hp}/${c.maxHp} HP, AC ${c.ac}${unconscious}${conditions}`;
      }

      // Mark concentrating
      if (c.concentrating) {
        statusLine += ` [concentrating: ${c.concentrating.name}]`;
      }

      lines.push(statusLine);
    }

    // Active effects
    if (s.activeEffects.length > 0) {
      lines.push('');
      lines.push('ACTIVE EFFECTS:');
      for (const e of s.activeEffects) {
        const targets = Array.isArray(e.targets) ? e.targets.join(', ') : String(e.targets);
        let durStr;
        if (e.duration.type === 'concentration') {
          durStr = 'concentration';
        } else if (e.duration.type === 'permanent') {
          durStr = 'permanent';
        } else {
          const remaining = e.duration.count - (s.round - e.roundApplied);
          durStr = `${remaining} round${remaining !== 1 ? 's' : ''} remaining`;
        }
        lines.push(`- ${e.name} (${e.caster}, ${durStr}): ${targets}`);
      }
    }

    return lines.join('\n');
  }
}

module.exports = CombatEngine;
