'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const CombatEngine = require('../combat-engine.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDnDPC(overrides = {}) {
  return {
    id: 'kael',
    name: 'Kael',
    type: 'PC',
    level: 5,
    ac: 16,
    hp: 38,
    maxHp: 38,
    speed: 30,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 13, cha: 8 },
    saveProficiencies: ['str', 'con'],
    proficiencyBonus: 3,
    weapons: [
      { name: 'longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing', properties: [] },
    ],
    spells: [
      { name: 'fireball', level: 3, save: 'dex', damage: '8d6', damageType: 'fire' },
      { name: 'cure wounds', level: 1, healing: '1d8', effect: 'heal' },
    ],
    spellSlots: { 1: 4, 2: 3, 3: 2 },
    spellcastingAbility: 'int',
    features: [],
    conditions: [],
    concentrating: null,
    deathSaves: { successes: 0, failures: 0 },
    inspiration: false,
    resistances: [],
    vulnerabilities: [],
    immunities: [],
    ...overrides,
  };
}

function makeDnDEnemy(overrides = {}) {
  return {
    id: 'goblin',
    name: 'Goblin',
    type: 'Enemy',
    level: 1,
    ac: 13,
    hp: 7,
    maxHp: 7,
    speed: 30,
    abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
    saveProficiencies: [],
    proficiencyBonus: 2,
    weapons: [
      { name: 'scimitar', attackMod: 'dex', damage: '1d6', damageType: 'slashing', properties: [] },
    ],
    spells: [],
    spellSlots: {},
    spellcastingAbility: null,
    features: [],
    conditions: [],
    concentrating: null,
    resistances: [],
    vulnerabilities: [],
    immunities: [],
    ...overrides,
  };
}

function makeRQPC(overrides = {}) {
  return {
    id: 'orlanth',
    name: 'Orlanth',
    type: 'PC',
    characteristics: { str: 14, dex: 13, con: 12, siz: 13, int: 12, pow: 15, cha: 11 },
    totalHp: 13,
    maxTotalHp: 13,
    hitLocations: {
      head:     { hp: 4, maxHp: 4, armor: 0 },
      chest:    { hp: 5, maxHp: 5, armor: 3 },
      abdomen:  { hp: 4, maxHp: 4, armor: 3 },
      rightArm: { hp: 3, maxHp: 3, armor: 2 },
      leftArm:  { hp: 3, maxHp: 3, armor: 2 },
      rightLeg: { hp: 4, maxHp: 4, armor: 2 },
      leftLeg:  { hp: 4, maxHp: 4, armor: 2 },
    },
    weapons: [
      { name: 'broadsword', type: 'slashing', damage: '1d8+1', skill: 65, parry: 55 },
    ],
    skills: { dodge: 40 },
    runePoints: 3,
    magicPoints: 12,
    runeSpells: [],
    spiritSpells: [],
    conditions: [],
    ...overrides,
  };
}

function makeRQEnemy(overrides = {}) {
  return {
    id: 'broo',
    name: 'Broo',
    type: 'Enemy',
    characteristics: { str: 12, dex: 10, con: 11, siz: 12, int: 9, pow: 10, cha: 6 },
    totalHp: 11,
    maxTotalHp: 11,
    hitLocations: {
      head:     { hp: 3, maxHp: 3, armor: 0 },
      chest:    { hp: 4, maxHp: 4, armor: 1 },
      abdomen:  { hp: 3, maxHp: 3, armor: 1 },
      rightArm: { hp: 2, maxHp: 2, armor: 0 },
      leftArm:  { hp: 2, maxHp: 2, armor: 0 },
      rightLeg: { hp: 3, maxHp: 3, armor: 0 },
      leftLeg:  { hp: 3, maxHp: 3, armor: 0 },
    },
    weapons: [
      { name: 'axe', type: 'slashing', damage: '1d6+1', skill: 45, parry: 35 },
    ],
    skills: { dodge: 25 },
    runePoints: 0,
    magicPoints: 8,
    runeSpells: [],
    spiritSpells: [],
    conditions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CombatEngine', () => {
  describe('constructor', () => {
    it('initializes with empty/inactive state', () => {
      const engine = new CombatEngine();
      assert.equal(engine.state.active, false);
      assert.equal(engine.state.round, 0);
      assert.equal(engine.state.system, null);
      assert.equal(engine.state.turnIndex, 0);
      assert.deepEqual(engine.state.initiativeOrder, []);
      assert.deepEqual(engine.state.combatants, {});
      assert.deepEqual(engine.state.activeEffects, []);
      assert.equal(engine.state.pendingReaction, null);
      assert.deepEqual(engine.state.log, []);
    });
  });

  describe('getResolver', () => {
    it('returns dnd5e resolver when system is dnd5e', () => {
      const engine = new CombatEngine();
      engine.state.system = 'dnd5e';
      const resolver = engine.getResolver();
      assert.ok(typeof resolver.resolveAttack === 'function');
      assert.ok(typeof resolver.rollInitiative === 'function');
    });

    it('returns runequest resolver when system is runequest', () => {
      const engine = new CombatEngine();
      engine.state.system = 'runequest';
      const resolver = engine.getResolver();
      assert.ok(typeof resolver.resolveAttack === 'function');
      assert.ok(typeof resolver.rollInitiative === 'function');
    });
  });

  describe('initCombat (D&D 5e)', () => {
    it('sets active=true, round=1, system=dnd5e', () => {
      const engine = new CombatEngine();
      const pc = makeDnDPC();
      const enemy = makeDnDEnemy();
      engine.initCombat([pc], [enemy], 'dnd5e');
      assert.equal(engine.state.active, true);
      assert.equal(engine.state.round, 1);
      assert.equal(engine.state.system, 'dnd5e');
    });

    it('populates state.combatants keyed by id', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      assert.ok(engine.state.combatants['kael']);
      assert.ok(engine.state.combatants['goblin']);
    });

    it('sorts D&D initiative descending (highest first)', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const order = engine.state.initiativeOrder;
      assert.equal(order.length, 2);
      if (order.length >= 2) {
        assert.ok(order[0].init >= order[1].init);
      }
    });

    it('each entry in initiativeOrder has id, name, init, type', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      for (const entry of engine.state.initiativeOrder) {
        assert.ok(typeof entry.id === 'string');
        assert.ok(typeof entry.name === 'string');
        assert.ok(typeof entry.init === 'number');
        assert.ok(typeof entry.type === 'string');
      }
    });

    it('sets active=true, round=1, system=runequest for RQ', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeRQPC()], [makeRQEnemy()], 'runequest');
      assert.equal(engine.state.active, true);
      assert.equal(engine.state.round, 1);
      assert.equal(engine.state.system, 'runequest');
    });

    it('sorts RuneQuest initiative ascending (lowest strike rank first)', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeRQPC()], [makeRQEnemy()], 'runequest');
      const order = engine.state.initiativeOrder;
      assert.equal(order.length, 2);
      if (order.length >= 2) {
        assert.ok(order[0].init <= order[1].init);
      }
    });
  });

  describe('getCombatant', () => {
    it('returns the combatant by id', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const c = engine.getCombatant('kael');
      assert.equal(c.name, 'Kael');
    });

    it('returns undefined for unknown id', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      assert.equal(engine.getCombatant('nobody'), undefined);
    });
  });

  describe('getCurrentTurn', () => {
    it('returns the combatant at turnIndex 0', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const current = engine.getCurrentTurn();
      const first = engine.state.initiativeOrder[0];
      assert.equal(current.id, first.id);
    });
  });

  describe('advanceTurn', () => {
    it('increments turnIndex', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      engine.advanceTurn();
      assert.equal(engine.state.turnIndex, 1);
    });

    it('wraps around and increments round', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      // advance through all combatants
      engine.advanceTurn(); // index 1
      engine.advanceTurn(); // wraps to 0, round 2
      assert.equal(engine.state.round, 2);
      assert.equal(engine.state.turnIndex, 0);
    });

    it('skips dead combatants', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      // Find the enemy in initiative order and kill it
      const enemyEntry = engine.state.initiativeOrder.find(e => e.type === 'Enemy');
      engine.state.combatants[enemyEntry.id].hp = 0;
      // Find the PC entry
      const pcEntry = engine.state.initiativeOrder.find(e => e.type === 'PC');
      const pcIndex = engine.state.initiativeOrder.indexOf(pcEntry);
      // Start from PC's turn, advance — should skip dead enemy and wrap back
      engine.state.turnIndex = pcIndex;
      engine.advanceTurn();
      // Should end up back at the PC (only living combatant)
      assert.equal(engine.state.combatants[engine.state.initiativeOrder[engine.state.turnIndex].id].type, 'PC');
    });
  });

  describe('resolveAction (attack, D&D 5e)', () => {
    it('resolves attack and logs result', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const action = {
        type: 'attack',
        attackerId: 'kael',
        targetId: 'goblin',
        weaponName: 'longsword',
      };
      const result = engine.resolveAction(action);
      assert.ok(result);
      assert.equal(result.type, 'attack');
      assert.equal(engine.state.log.length, 1);
    });

    it('updates target HP when attack hits', () => {
      const engine = new CombatEngine();
      // Make sure the attack always hits: set AC to 1 on goblin
      engine.initCombat([makeDnDPC()], [makeDnDEnemy({ ac: 1 })], 'dnd5e');
      const goblinBefore = engine.state.combatants['goblin'].hp;
      const action = {
        type: 'attack',
        attackerId: 'kael',
        targetId: 'goblin',
        weaponName: 'longsword',
      };
      const result = engine.resolveAction(action);
      if (result.hit) {
        assert.ok(engine.state.combatants['goblin'].hp < goblinBefore);
      }
    });

    it('requires a valid living enemy target before resolving an attack', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const goblinBefore = engine.state.combatants.goblin.hp;

      const result = engine.resolveAction({
        type: 'attack',
        attackerId: 'kael',
        targetId: 'missing-target',
        weaponName: 'longsword',
      });

      assert.equal(result.type, 'target_required');
      assert.equal(result.requiresTarget, true);
      assert.equal(result.targetRole, 'enemy');
      assert.equal(engine.state.combatants.goblin.hp, goblinBefore);
    });

    it('allows enemies to attack living PCs instead of treating PCs as invalid enemy targets', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC({ ac: 1 })], [makeDnDEnemy()], 'dnd5e');

      const result = engine.resolveAction({
        type: 'attack',
        attackerId: 'goblin',
        targetId: 'kael',
        weaponName: 'scimitar',
      });

      assert.equal(result.type, 'attack');
      assert.notEqual(result.type, 'target_required');
      assert.equal(result.attackerName, 'Goblin');
      assert.equal(result.targetName, 'Kael');
    });

    it('resolves Extra Attack profiles as multiple weapon attacks in one Attack action', () => {
      const engine = new CombatEngine();
      const pc = makeDnDPC({
        abilities: { str: 30, dex: 12, con: 14, int: 10, wis: 13, cha: 8 },
        proficiencyBonus: 10,
        features: ['Extra Attack'],
        weapons: [
          { name: 'longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing', properties: [] },
        ],
        attackProfiles: [
          {
            id: 'weapon-longsword',
            source: 'weapon',
            name: 'longsword',
            enabled: true,
            carried: true,
            attackBonus: 20,
            damageFormula: '1d8+10',
            attacksPerAction: 2,
          },
        ],
      });
      engine.initCombat([pc], [makeDnDEnemy({ ac: 1, hp: 50, maxHp: 50 })], 'dnd5e');

      const result = engine.resolveAction({
        type: 'attack',
        attackerId: 'kael',
        targetId: 'goblin',
        weaponName: 'longsword',
      });

      assert.equal(result.type, 'multiattack');
      assert.equal(result.attacks.length, 2);
      assert.ok(result.attacks.every(attack => attack.type === 'attack'), 'each profile attack should be a normal attack result');
      assert.ok(engine.state.combatants.goblin.hp < 50, 'enemy should take damage from the attack sequence');
    });

    it('honors an explicit two-attack action even when the profile is single-attack', () => {
      const engine = new CombatEngine();
      const pc = makeDnDPC({
        abilities: { str: 30, dex: 12, con: 14, int: 10, wis: 13, cha: 8 },
        proficiencyBonus: 10,
        weapons: [
          { name: 'longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing', properties: [] },
        ],
      });
      engine.initCombat([pc], [makeDnDEnemy({ ac: 1, hp: 50, maxHp: 50 })], 'dnd5e');

      const result = engine.resolveAction({
        type: 'attack',
        attackerId: 'kael',
        targetId: 'goblin',
        weaponName: 'longsword',
        attackCountOverride: 2,
      });

      assert.equal(result.type, 'multiattack');
      assert.equal(result.attacks.length, 2);
    });
  });

  describe('resolveAction (spell)', () => {
    it('known offensive spells with stale healing metadata still resolve as attacks', () => {
      const engine = new CombatEngine();
      const pc = makeDnDPC({
        spells: [
          { name: 'Fire Bolt', level: 0, attack: true, damage: '1d10', healing: '1d10', effect: 'heal', damageType: 'healing' },
        ],
        spellSlots: {},
        spellcastingAbility: 'int',
      });
      const enemy = makeDnDEnemy({ id: 'azer', name: 'Azer', hp: 20, maxHp: 20, ac: 10 });
      engine.initCombat([pc], [enemy], 'dnd5e');

      const result = engine.resolveAction({
        type: 'spell',
        attackerId: 'kael',
        spell: 'Fire Bolt',
        targetId: 'azer',
      });

      assert.equal(result.type, 'spell-attack');
      assert.equal(result.spell, 'Fire Bolt');
      assert.equal(result.attacks.length, 1);
      assert.equal(result.attacks[0].target, 'azer');
      assert.equal(result.attacks[0].damageType, 'fire');
    });

    it('resolves a healing spell', () => {
      const engine = new CombatEngine();
      const pc = makeDnDPC({ hp: 20 });
      engine.initCombat([pc], [makeDnDEnemy()], 'dnd5e');
      const action = {
        type: 'spell',
        casterId: 'kael',
        targetIds: ['kael'],
        spellName: 'cure wounds',
        slotLevel: 1,
      };
      const result = engine.resolveAction(action);
      assert.ok(result);
      assert.equal(result.type, 'heal');
    });

    it('deducts a spell slot', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const slotsBefore = engine.state.combatants['kael'].spellSlots[1];
      engine.resolveAction({
        type: 'spell',
        casterId: 'kael',
        targetIds: ['kael'],
        spellName: 'cure wounds',
        slotLevel: 1,
      });
      assert.equal(engine.state.combatants['kael'].spellSlots[1], slotsBefore - 1);
    });

    it('does not spend a spell slot when a target-required spell has no valid target', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const slotsBefore = engine.state.combatants.kael.spellSlots[3];

      const result = engine.resolveAction({
        type: 'spell',
        casterId: 'kael',
        targetId: null,
        spellName: 'fireball',
        slotLevel: 3,
      });

      assert.equal(result.type, 'target_required');
      assert.equal(result.targetRole, 'enemy');
      assert.equal(engine.state.combatants.kael.spellSlots[3], slotsBefore);
    });

    it('requires Revivify-style spells to target a downed ally, not a living enemy', () => {
      const engine = new CombatEngine();
      const pc = makeDnDPC({
        spells: [
          { name: 'Revivify', level: 3, effect: 'revive' },
        ],
      });
      engine.initCombat([pc], [makeDnDEnemy()], 'dnd5e');
      const slotsBefore = engine.state.combatants.kael.spellSlots[3];

      const result = engine.resolveAction({
        type: 'spell',
        casterId: 'kael',
        targetId: 'goblin',
        spellName: 'Revivify',
        slotLevel: 3,
      });

      assert.equal(result.type, 'target_required');
      assert.equal(result.targetRole, 'downed_ally');
      assert.equal(engine.state.combatants.kael.spellSlots[3], slotsBefore);
    });

    it('applies direct damage spells to target HP', () => {
      const engine = new CombatEngine();
      const pc = makeDnDPC({
        spells: [
          { name: 'Magic Missile', level: 1, damage: '3d4+3', damageType: 'force', autoHit: true },
        ],
      });
      const enemy = makeDnDEnemy({ hp: 30, maxHp: 30 });
      engine.initCombat([pc], [enemy], 'dnd5e');

      const result = engine.resolveAction({
        type: 'spell',
        casterId: 'kael',
        targetIds: ['goblin'],
        spellName: 'Magic Missile',
      });

      assert.equal(result.type, 'spell-damage');
      assert.ok(result.targets[0].damage > 0);
      assert.equal(result.targets[0].hpBefore, 30);
      assert.equal(engine.state.combatants.goblin.hp, result.targets[0].hpAfter);
      assert.ok(engine.state.combatants.goblin.hp < 30);
    });

    it('casting Spirit Guardians marks the caster concentrating and stores an ongoing effect', () => {
      const engine = new CombatEngine();
      const pc = makeDnDPC({
        spells: [
          { name: 'Spirit Guardians', level: 3, damage: '3d8', damageType: 'radiant', concentration: true, aoe: true, save: 'wis', saveDC: 15 },
        ],
      });
      const enemy = makeDnDEnemy({ hp: 40, maxHp: 40 });
      engine.initCombat([pc], [enemy], 'dnd5e');

      const result = engine.resolveAction({
        type: 'spell',
        attackerId: 'kael',
        spell: 'Spirit Guardians',
        targetId: 'goblin',
      });

      assert.equal(result.type, 'buff');
      assert.equal(engine.state.combatants.kael.concentrating.name, 'Spirit Guardians');
      assert.ok(engine.state.combatants.kael.conditions.includes('concentrating'));
      assert.equal(engine.state.activeEffects.length, 1);
      assert.equal(engine.state.activeEffects[0].name, 'Spirit Guardians');
      assert.equal(engine.state.activeEffects[0].caster, 'kael');
      assert.equal(engine.state.combatants.goblin.hp, 40, 'ongoing area spell should tick on turn timing, not immediately on cast');
    });

    it('applies Spirit Guardians when an enemy starts its turn', () => {
      const engine = new CombatEngine();
      const pc = makeDnDPC({
        spells: [
          { name: 'Spirit Guardians', level: 3, damage: '3d8', damageType: 'radiant', concentration: true, aoe: true, save: 'wis', saveDC: 15 },
        ],
      });
      const enemy = makeDnDEnemy({ hp: 40, maxHp: 40 });
      engine.initCombat([pc], [enemy], 'dnd5e');
      engine.state.initiativeOrder = [
        { id: 'kael', name: 'Kael', init: 20, type: 'PC' },
        { id: 'goblin', name: 'Goblin', init: 10, type: 'Enemy' },
      ];
      engine.state.turnIndex = 0;

      engine.resolveAction({
        type: 'spell',
        attackerId: 'kael',
        spell: 'Spirit Guardians',
        targetId: 'goblin',
      });

      const effects = engine.advanceTurn();

      assert.ok(Array.isArray(effects));
      assert.equal(effects.length, 1);
      assert.equal(effects[0].type, 'spell-save');
      assert.equal(effects[0].spell, 'Spirit Guardians');
      assert.equal(effects[0].ongoing, true);
      assert.equal(effects[0].trigger, 'startOfTurn');
      assert.ok(engine.state.combatants.goblin.hp < 40, 'enemy should take damage from the start-of-turn aura');
    });

    it('applies targeted ongoing spell effects at end of turn when configured', () => {
      const engine = new CombatEngine();
      const pc = makeDnDPC({
        spells: [
          { name: 'End Thorn', level: 2, damage: '2d6', damageType: 'necrotic', concentration: true, save: 'con', saveDC: 15, trigger: 'endOfTurn' },
        ],
      });
      const enemy = makeDnDEnemy({ hp: 40, maxHp: 40 });
      engine.initCombat([pc], [enemy], 'dnd5e');
      engine.state.initiativeOrder = [
        { id: 'kael', name: 'Kael', init: 20, type: 'PC' },
        { id: 'goblin', name: 'Goblin', init: 10, type: 'Enemy' },
      ];
      engine.state.turnIndex = 0;

      engine.resolveAction({
        type: 'spell',
        attackerId: 'kael',
        spell: 'End Thorn',
        targetId: 'goblin',
      });
      const startEffects = engine.advanceTurn();
      const endEffects = engine.advanceTurn();

      assert.equal(startEffects.length, 0);
      assert.equal(endEffects.length, 1);
      assert.equal(endEffects[0].spell, 'End Thorn');
      assert.equal(endEffects[0].trigger, 'endOfTurn');
      assert.ok(engine.state.combatants.goblin.hp < 40, 'target should take configured end-of-turn damage');
    });

    it('breaking concentration removes the condition and stops ongoing ticks', () => {
      const engine = new CombatEngine();
      const pc = makeDnDPC({
        spells: [
          { name: 'Spirit Guardians', level: 3, damage: '3d8', damageType: 'radiant', concentration: true, aoe: true, save: 'wis', saveDC: 15 },
        ],
      });
      const enemy = makeDnDEnemy({ hp: 40, maxHp: 40 });
      engine.initCombat([pc], [enemy], 'dnd5e');
      engine.state.initiativeOrder = [
        { id: 'kael', name: 'Kael', init: 20, type: 'PC' },
        { id: 'goblin', name: 'Goblin', init: 10, type: 'Enemy' },
      ];
      engine.state.turnIndex = 0;

      engine.resolveAction({
        type: 'spell',
        attackerId: 'kael',
        spell: 'Spirit Guardians',
        targetId: 'goblin',
      });
      engine.breakConcentration('kael');
      const effects = engine.advanceTurn();

      assert.equal(engine.state.combatants.kael.concentrating, null);
      assert.ok(!engine.state.combatants.kael.conditions.includes('concentrating'));
      assert.equal(effects.length, 0);
      assert.equal(engine.state.combatants.goblin.hp, 40);
    });

    it('shows concentration spells with duration immediately after the caster in display initiative', () => {
      const engine = new CombatEngine();
      const pc = makeDnDPC({
        spells: [
          { name: 'Bless', level: 1, concentration: true, duration: '1 minute', effect: 'buff' },
        ],
      });
      const enemy = makeDnDEnemy();
      engine.initCombat([pc], [enemy], 'dnd5e');
      engine.state.initiativeOrder = [
        { id: 'kael', name: 'Kael', init: 20, type: 'PC' },
        { id: 'goblin', name: 'Goblin', init: 10, type: 'Enemy' },
      ];

      engine.resolveAction({
        type: 'spell',
        casterId: 'kael',
        targetIds: ['kael'],
        spellName: 'Bless',
      });

      const order = engine.getDisplayInitiativeOrder();

      assert.deepEqual(order.map(entry => entry.type), ['PC', 'Effect', 'Enemy']);
      assert.equal(order[1].name, 'Bless');
      assert.equal(order[1].casterId, 'kael');
      assert.equal(order[1].remainingTurns, 10);
    });

    it('counts down and expires timed concentration spells by round', () => {
      const engine = new CombatEngine();
      const pc = makeDnDPC({
        spells: [
          { name: 'Short Ward', level: 1, concentration: true, duration: '2 rounds', effect: 'buff' },
        ],
      });
      const enemy = makeDnDEnemy();
      engine.initCombat([pc], [enemy], 'dnd5e');
      engine.state.initiativeOrder = [
        { id: 'kael', name: 'Kael', init: 20, type: 'PC' },
        { id: 'goblin', name: 'Goblin', init: 10, type: 'Enemy' },
      ];

      engine.resolveAction({
        type: 'spell',
        casterId: 'kael',
        targetIds: ['kael'],
        spellName: 'Short Ward',
      });
      assert.equal(engine.getDisplayInitiativeOrder()[1].remainingTurns, 2);

      engine.advanceTurn();
      engine.advanceTurn();
      assert.equal(engine.state.round, 2);
      assert.equal(engine.getDisplayInitiativeOrder()[1].remainingTurns, 1);

      engine.advanceTurn();
      engine.advanceTurn();
      assert.equal(engine.state.round, 3);
      assert.equal(engine.state.activeEffects.length, 0);
      assert.equal(engine.state.combatants.kael.concentrating, null);
      assert.ok(!engine.state.combatants.kael.conditions.includes('concentrating'));
      assert.deepEqual(engine.getDisplayInitiativeOrder().map(entry => entry.type), ['PC', 'Enemy']);
    });
  });

  describe('resolveAction (dodge / disengage / dash)', () => {
    it('resolves a dodge action and logs it', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const result = engine.resolveAction({ type: 'dodge', actorId: 'kael' });
      assert.ok(result);
      assert.equal(result.type, 'dodge');
      assert.equal(engine.state.log.length, 1);
    });

    it('resolves a disengage action and logs it', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const result = engine.resolveAction({ type: 'disengage', actorId: 'kael' });
      assert.equal(result.type, 'disengage');
    });

    it('resolves a dash action and logs it', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const result = engine.resolveAction({ type: 'dash', actorId: 'kael' });
      assert.equal(result.type, 'dash');
    });
  });

  describe('addActiveEffect + expireEffects', () => {
    it('adds an effect to activeEffects', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      engine.addActiveEffect({
        name: 'bless',
        caster: 'kael',
        targets: ['kael'],
        effect: { type: 'bless' },
        duration: { type: 'rounds', count: 3 },
      });
      assert.equal(engine.state.activeEffects.length, 1);
      assert.equal(engine.state.activeEffects[0].name, 'bless');
      assert.equal(engine.state.activeEffects[0].roundApplied, 1);
    });

    it('expires round-based effects when duration elapsed', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      engine.addActiveEffect({
        name: 'bless',
        caster: 'kael',
        targets: ['kael'],
        effect: {},
        duration: { type: 'rounds', count: 1 },
      });
      engine.state.round = 2;
      engine.expireEffects();
      assert.equal(engine.state.activeEffects.length, 0);
    });

    it('does not expire round-based effects before duration', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      engine.addActiveEffect({
        name: 'bless',
        caster: 'kael',
        targets: ['kael'],
        effect: {},
        duration: { type: 'rounds', count: 3 },
      });
      engine.state.round = 2;
      engine.expireEffects();
      assert.equal(engine.state.activeEffects.length, 1);
    });

    it('does not expire permanent effects', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      engine.addActiveEffect({
        name: 'permanent-buff',
        caster: 'kael',
        targets: ['kael'],
        effect: {},
        duration: { type: 'permanent' },
      });
      engine.state.round = 100;
      engine.expireEffects();
      assert.equal(engine.state.activeEffects.length, 1);
    });

    it('does not expire concentration effects via expireEffects', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      engine.addActiveEffect({
        name: 'bless',
        caster: 'kael',
        targets: ['kael'],
        effect: {},
        duration: { type: 'concentration' },
      });
      engine.state.round = 100;
      engine.expireEffects();
      assert.equal(engine.state.activeEffects.length, 1);
    });
  });

  describe('breakConcentration', () => {
    it('removes all concentration effects for the caster', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      engine.addActiveEffect({
        name: 'bless',
        caster: 'kael',
        targets: ['kael'],
        effect: {},
        duration: { type: 'concentration' },
      });
      engine.addActiveEffect({
        name: 'hex',
        caster: 'kael',
        targets: ['goblin'],
        effect: {},
        duration: { type: 'concentration' },
      });
      engine.addActiveEffect({
        name: 'bless',
        caster: 'goblin',
        targets: ['goblin'],
        effect: {},
        duration: { type: 'concentration' },
      });
      engine.breakConcentration('kael');
      // kael's 2 concentration effects gone; goblin's remains
      assert.equal(engine.state.activeEffects.length, 1);
      assert.equal(engine.state.activeEffects[0].caster, 'goblin');
    });

    it('does not remove non-concentration effects', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      engine.addActiveEffect({
        name: 'bless',
        caster: 'kael',
        targets: ['kael'],
        effect: {},
        duration: { type: 'rounds', count: 3 },
      });
      engine.breakConcentration('kael');
      assert.equal(engine.state.activeEffects.length, 1);
    });
  });

  describe('getReactionTriggers', () => {
    it('returns concentration check option when damage event and caster is concentrating', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      // Mark kael as concentrating
      engine.state.combatants['kael'].concentrating = { name: 'bless' };
      const triggers = engine.getReactionTriggers('kael', { type: 'damage', damage: 8 });
      const types = triggers.map(t => t.type);
      assert.ok(types.includes('concentrationCheck'));
    });

    it('returns inspiration option if combatant has inspiration', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC({ inspiration: true })], [makeDnDEnemy()], 'dnd5e');
      engine.state.combatants['kael'].concentrating = { name: 'bless' };
      const triggers = engine.getReactionTriggers('kael', { type: 'damage', damage: 8 });
      const types = triggers.map(t => t.type);
      assert.ok(types.includes('useInspiration'));
    });

    it('returns empty array when not concentrating', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const triggers = engine.getReactionTriggers('kael', { type: 'damage', damage: 5 });
      assert.equal(triggers.length, 0);
    });

    it('returns empty array for non-damage events', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      engine.state.combatants['kael'].concentrating = { name: 'bless' };
      const triggers = engine.getReactionTriggers('kael', { type: 'movement' });
      assert.equal(triggers.length, 0);
    });
  });

  describe('isCombatOver', () => {
    it('returns false when both sides alive', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      assert.deepStrictEqual(engine.isCombatOver(), { over: false, reason: null });
    });

    it('returns true when all enemies dead', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      engine.state.combatants['goblin'].hp = 0;
      assert.deepStrictEqual(engine.isCombatOver(), { over: true, reason: 'enemies_defeated' });
    });

    it('returns true when all PCs down (hp=0)', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      engine.state.combatants['kael'].hp = 0;
      assert.deepStrictEqual(engine.isCombatOver(), { over: true, reason: 'party_defeated' });
    });
  });

  describe('endCombat', () => {
    it('sets active=false and returns final state', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const finalState = engine.endCombat();
      assert.equal(engine.state.active, false);
      assert.equal(finalState.active, false);
    });
  });

  describe('formatResultForPrompt', () => {
    it('formats a D&D attack result as a readable string', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const result = {
        type: 'attack',
        attackerName: 'Kael',
        targetName: 'Goblin',
        weapon: 'longsword',
        roll: 15,
        modifier: 6,
        total: 21,
        targetAC: 13,
        hit: true,
        critical: false,
        fumble: false,
        damageRoll: 9,
        totalDamage: 9,
        damageType: 'slashing',
        hpBefore: 7,
        hpAfter: 0,
      };
      const text = engine.formatResultForPrompt(result);
      assert.ok(typeof text === 'string');
      assert.ok(text.includes('Kael'));
      assert.ok(text.includes('Goblin'));
      assert.ok(text.includes('longsword'));
      assert.ok(text.toLowerCase().includes('hit') || text.includes('HIT'));
    });

    it('formats D&D attack rolls with d20, bonus, total, damage dice, bonus, and damage total', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const result = {
        type: 'attack',
        attackerName: 'Sable Vey',
        targetName: 'Lingering Hostile Will',
        weapon: 'rapier',
        roll: 11,
        modifier: 6,
        effectBonus: 0,
        total: 17,
        targetAC: 13,
        hit: true,
        critical: false,
        fumble: false,
        damageRoll: 5,
        damageDiceTotal: 2,
        damageModifier: 3,
        damageFormula: '1d8+3',
        totalDamage: 5,
        damageType: 'piercing',
        hpBefore: 45,
        hpAfter: 40,
      };

      const text = engine.formatResultForPrompt(result);

      assert.match(text, /To hit: d20 11 \+ 6 = 17 vs AC 13/i);
      assert.match(text, /Damage: 1d8\+3 \(2 \+ 3 = 5\) piercing/i);
      assert.doesNotMatch(text, /rolls 17\. HIT! 5 piercing damage/i);
    });

    it('formats a D&D attack miss', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const result = {
        type: 'attack',
        attackerName: 'Kael',
        targetName: 'Goblin',
        weapon: 'longsword',
        roll: 4,
        modifier: 6,
        total: 10,
        targetAC: 13,
        hit: false,
        critical: false,
        fumble: false,
        damageRoll: 0,
        totalDamage: 0,
        damageType: 'slashing',
      };
      const text = engine.formatResultForPrompt(result);
      assert.ok(text.toLowerCase().includes('miss') || text.includes('MISS'));
    });

    it('formats save spell damage with dice, bonus, total, and target save math', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const result = {
        type: 'spell-save',
        casterName: 'Mirelle',
        spell: 'Sacred Flame',
        saveDC: 14,
        damageRoll: 7,
        damageDiceTotal: 7,
        damageModifier: 0,
        damageFormula: '1d8',
        damageType: 'radiant',
        targets: [{
          id: 'will',
          name: 'Lingering Hostile Will',
          saveRoll: 9,
          saveMod: 2,
          saveTotal: 11,
          saved: false,
          damage: 7,
        }],
      };

      const text = engine.formatResultForPrompt(result);

      assert.match(text, /Damage: 1d8 \(7 \+ 0 = 7\) radiant/i);
      assert.match(text, /save d20 9 \+ 2 = 11 vs DC 14/i);
    });

    it('formats direct spell damage with dice, bonus, total, and target damage', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const result = {
        type: 'spell-damage',
        casterName: 'Orrin',
        spell: 'Magic Missile',
        damageRoll: 10,
        damageDiceTotal: 7,
        damageModifier: 3,
        damageFormula: '3d4+3',
        damageType: 'force',
        targets: [{
          id: 'sunborn',
          name: 'Sunborn',
          damage: 10,
          hpBefore: 30,
          hpAfter: 20,
        }],
      };

      const text = engine.formatResultForPrompt(result);

      assert.match(text, /Damage: 3d4\+3 \(7 \+ 3 = 10\) force/i);
      assert.match(text, /Sunborn: 10 force damage/i);
      assert.match(text, /Sunborn HP: 30→20/i);
    });

    it('cleans duplicated damage type text from spell damage formulas', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const result = {
        type: 'spell-damage',
        casterName: 'Seraphine',
        spell: 'Magic Missile',
        damageRoll: 8,
        damageDiceTotal: 5,
        damageModifier: 3,
        damageFormula: '3d4+3force',
        damageType: 'force',
        targets: [{ id: 'armor', name: 'Animated Armor', damage: 8 }],
      };

      const text = engine.formatResultForPrompt(result);

      assert.match(text, /Damage: 3d4\+3 \(5 \+ 3 = 8\) force/i);
      assert.doesNotMatch(text, /3d4\+3force/i);
    });

    it('preserves readable spaces in descriptive spell damage formulas', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const result = {
        type: 'spell-damage',
        casterName: 'Kael',
        spell: 'Magic Missile',
        damageRoll: 5,
        damageDiceTotal: 1,
        damageModifier: 4,
        damageFormula: '3 darts dealing 1d4+1 force each',
        damageType: 'force',
        targets: [{ id: 'axe-beak', name: 'Axe Beak', damage: 5 }],
      };

      const text = engine.formatResultForPrompt(result);

      assert.match(text, /Damage: 3 darts dealing 1d4\+1 each \(1 \+ 4 = 5\) force/i);
      assert.doesNotMatch(text, /3dartsdealing/i);
    });

    it('formats a heal result', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const result = {
        type: 'heal',
        casterName: 'Kael',
        spell: 'cure wounds',
        totalHealing: 10,
        targets: [{ id: 'kael', name: 'Kael', healing: 10 }],
      };
      const text = engine.formatResultForPrompt(result);
      assert.ok(text.includes('Kael'));
      assert.ok(text.includes('10'));
    });

    it('formats a dodge action', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const result = { type: 'dodge', actorName: 'Kael' };
      const text = engine.formatResultForPrompt(result);
      assert.ok(text.toLowerCase().includes('dodge'));
    });

    it('formats resolved death saves instead of leaking raw JSON', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC({ hp: 0 })], [makeDnDEnemy()], 'dnd5e');
      const result = engine.resolveAction({ type: 'death_save', actorId: 'kael' });
      const text = engine.formatResultForPrompt(result);
      assert.equal(result.type, 'death_save');
      assert.match(text, /Kael .*death save/i);
      assert.doesNotMatch(text, /^\{/);
    });

    it('does not keep rolling death saves for a dead PC', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC({ hp: 0, deathSaves: { successes: 0, failures: 3 } })], [makeDnDEnemy()], 'dnd5e');
      const result = engine.resolveAction({ type: 'death_save', actorId: 'kael' });
      assert.equal(result.type, 'death_save');
      assert.equal(result.dead, true);
      assert.equal(result.alreadyDead, true);
      assert.equal(engine.state.combatants.kael.dead, true);
    });

    it('formats a RuneQuest attack result', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeRQPC()], [makeRQEnemy()], 'runequest');
      const result = {
        type: 'attack',
        attackerName: 'Orlanth',
        targetName: 'Broo',
        weapon: 'broadsword',
        roll: 35,
        attackResult: 'hit',
        hitLocation: 'chest',
        damage: 6,
        specialEffect: null,
        fumbleResult: null,
      };
      const text = engine.formatResultForPrompt(result);
      assert.ok(text.includes('Orlanth'));
      assert.ok(text.includes('broadsword'));
      assert.ok(text.includes('chest'));
    });
  });

  describe('getCombatSummary', () => {
    it('returns per-character damage dealt and taken', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy({ ac: 1 })], 'dnd5e');
      // Resolve an attack that will always hit (AC 1)
      engine.resolveAction({ type: 'attack', attackerId: 'kael', targetId: 'goblin', weaponName: 'longsword' });
      const summary = engine.getCombatSummary();
      assert.ok(summary.rounds >= 1);
      assert.ok(summary.characters['kael']);
      assert.ok(summary.characters['goblin']);
      assert.strictEqual(typeof summary.characters['kael'].damageDealt, 'number');
      assert.strictEqual(typeof summary.characters['goblin'].damageTaken, 'number');
    });

    it('tracks healing from heal spells', () => {
      const engine = new CombatEngine();
      const pc = makeDnDPC({ hp: 20 });
      engine.initCombat([pc], [makeDnDEnemy()], 'dnd5e');
      engine.resolveAction({
        type: 'spell',
        casterId: 'kael',
        targetIds: ['kael'],
        spellName: 'cure wounds',
        slotLevel: 1,
      });
      const summary = engine.getCombatSummary();
      assert.ok(summary.characters['kael'].healed > 0, 'healed should be > 0 after cure wounds');
      assert.strictEqual(summary.characters['kael'].spellSlotsUsed, 1);
    });

    it('initializes all combatants with zero values', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const summary = engine.getCombatSummary();
      assert.strictEqual(summary.characters['kael'].damageDealt, 0);
      assert.strictEqual(summary.characters['kael'].damageTaken, 0);
      assert.strictEqual(summary.characters['kael'].healed, 0);
      assert.strictEqual(summary.characters['kael'].spellSlotsUsed, 0);
      assert.strictEqual(summary.characters['goblin'].damageDealt, 0);
      assert.strictEqual(summary.characters['goblin'].damageTaken, 0);
    });

    it('accumulates damage over multiple attacks', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy({ ac: 1, hp: 100, maxHp: 100 })], 'dnd5e');
      engine.resolveAction({ type: 'attack', attackerId: 'kael', targetId: 'goblin', weaponName: 'longsword' });
      engine.resolveAction({ type: 'attack', attackerId: 'kael', targetId: 'goblin', weaponName: 'longsword' });
      const summary = engine.getCombatSummary();
      // damageDealt should equal damageTaken (all hits land on goblin)
      assert.strictEqual(summary.characters['kael'].damageDealt, summary.characters['goblin'].damageTaken);
    });

    it('returns correct rounds count', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      assert.strictEqual(engine.getCombatSummary().rounds, 1);
      engine.state.round = 3;
      assert.strictEqual(engine.getCombatSummary().rounds, 3);
    });
  });

  describe('getCombatStateForPrompt', () => {
    it('returns a string containing round number', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const text = engine.getCombatStateForPrompt();
      assert.ok(typeof text === 'string');
      assert.ok(text.includes('Round 1') || text.includes('Round'));
    });

    it('includes ACTIVE COMBAT header', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const text = engine.getCombatStateForPrompt();
      assert.ok(text.includes('ACTIVE COMBAT'));
    });

    it('lists combatant names', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const text = engine.getCombatStateForPrompt();
      assert.ok(text.includes('Kael'));
      assert.ok(text.includes('Goblin'));
    });

    it('includes DEAD label for dead combatants', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      engine.state.combatants['goblin'].hp = 0;
      const text = engine.getCombatStateForPrompt();
      assert.ok(text.includes('DEAD'));
    });

    it('includes active effects section when effects exist', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      engine.addActiveEffect({
        name: 'bless',
        caster: 'kael',
        targets: ['kael'],
        effect: {},
        duration: { type: 'rounds', count: 3 },
      });
      const text = engine.getCombatStateForPrompt();
      assert.ok(text.includes('ACTIVE EFFECTS') || text.includes('bless'));
    });

    it('includes current turn name', () => {
      const engine = new CombatEngine();
      engine.initCombat([makeDnDPC()], [makeDnDEnemy()], 'dnd5e');
      const text = engine.getCombatStateForPrompt();
      const current = engine.getCurrentTurn();
      assert.ok(text.includes(current.name));
    });
  });
});
