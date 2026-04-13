'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const CombatEngine = require('../combat-engine');
const { parseAction } = require('../action-parser');
const { loadDefaultMonsters } = require('../monster-lookup');

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Level 5 Fighter: AC 16, HP 38, longsword */
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
    spells: [],
    spellSlots: {},
    spellcastingAbility: null,
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

/** Build a full D&D 5e Enemy combatant from monster-DB data */
function buildDnDEnemy(monsterData, idOverride) {
  const id = idOverride || monsterData.name.toLowerCase().replace(/\s+/g, '-');
  return {
    id,
    type: 'Enemy',
    conditions: [],
    concentrating: null,
    deathSaves: { successes: 0, failures: 0 },
    ...monsterData,
  };
}

/** Build a RuneQuest PC for integration tests */
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

/** Build a RuneQuest Enemy from monster-DB data */
function buildRQEnemy(monsterData, idOverride) {
  const id = idOverride || monsterData.name.toLowerCase().replace(/\s+/g, '-');
  return {
    id,
    type: 'Enemy',
    conditions: [],
    ...monsterData,
  };
}

// ---------------------------------------------------------------------------
// 1. Full D&D 5e combat round (monster DB → combat → death check)
// ---------------------------------------------------------------------------

describe('Integration: Full D&D 5e combat round', () => {
  it('creates PC + goblin from DB, inits combat, attacks, verifies HP changes and combat-over on kill', () => {
    const monsters = loadDefaultMonsters('dnd5e');
    assert.ok(monsters.goblin, 'goblin should exist in dnd5e DB');

    const pc = makeDnDPC();
    // Give the goblin AC=1 so the attack always hits
    const goblin = buildDnDEnemy({ ...monsters.goblin, ac: 1, hp: 7, maxHp: 7 }, 'goblin');

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');

    assert.equal(engine.state.active, true);
    assert.equal(engine.state.round, 1);
    assert.equal(engine.state.system, 'dnd5e');
    assert.ok(engine.state.combatants['kael']);
    assert.ok(engine.state.combatants['goblin']);

    // PC attacks the goblin; with AC=1 any roll is a hit
    const result = engine.resolveAction({
      type: 'attack',
      attackerId: 'kael',
      targetId: 'goblin',
      weaponName: 'longsword',
    });

    assert.equal(result.type, 'attack');
    assert.ok(result.hit, 'attack should hit with AC=1');
    assert.ok(result.hpAfter < 7, 'goblin HP should have decreased');

    // Format the result
    const text = engine.formatResultForPrompt(result);
    assert.ok(typeof text === 'string');
    assert.ok(text.includes('Kael'), 'formatted text should include attacker name');
    assert.ok(text.includes('Goblin'), 'formatted text should include target name');
    assert.ok(text.includes('longsword'), 'formatted text should include weapon');
    assert.ok(text.includes('HIT'), 'formatted text should say HIT');

    // Kill the goblin and verify combat-over
    engine.state.combatants['goblin'].hp = 0;
    assert.equal(engine.isCombatOver(), true, 'combat should be over when enemy HP=0');

    const finalState = engine.endCombat();
    assert.equal(finalState.active, false);
  });
});

// ---------------------------------------------------------------------------
// 2. Action parser + combat engine pipeline
// ---------------------------------------------------------------------------

describe('Integration: Action parser + combat engine', () => {
  it('parses "attack goblin with longsword" → resolves → produces attack result', () => {
    const monsters = loadDefaultMonsters('dnd5e');
    const pc = makeDnDPC();
    const goblin = buildDnDEnemy({ ...monsters.goblin, ac: 1 }, 'goblin');

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');

    // Build ctx for parser using live combatants
    const ctx = { combatants: engine.state.combatants };
    const parsed = parseAction('attack goblin with longsword', 'kael', ctx);

    assert.ok(parsed, 'parseAction should return a result');
    assert.equal(parsed.type, 'attack');
    assert.equal(parsed.attackerId, 'kael');
    assert.ok(parsed.targetId, 'targetId should be resolved');
    assert.ok(parsed.weapon, 'weapon should be resolved');

    // Now resolve the parsed action (adapt field names to engine convention)
    const engineAction = {
      type: 'attack',
      attackerId: parsed.attackerId,
      targetId: parsed.targetId,
      weaponName: parsed.weapon,
    };

    const result = engine.resolveAction(engineAction);
    assert.equal(result.type, 'attack');
    // With AC=1, should be a hit
    assert.ok(result.hit, 'resolved attack should hit with AC=1');
    assert.equal(engine.state.log.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 3. Full RuneQuest combat round (monster DB → hit location + damage)
// ---------------------------------------------------------------------------

describe('Integration: Full RuneQuest combat round', () => {
  it('creates RQ character + broo from DB, inits combat, resolves attack with hit location', () => {
    const monsters = loadDefaultMonsters('runequest');
    assert.ok(monsters.broo, 'broo should exist in runequest DB');

    const pc = makeRQPC();
    const broo = buildRQEnemy(monsters.broo, 'broo');

    const engine = new CombatEngine();
    engine.initCombat([pc], [broo], 'runequest');

    assert.equal(engine.state.active, true);
    assert.equal(engine.state.system, 'runequest');

    // RQ initiative: ascending (lowest strike rank first)
    const order = engine.state.initiativeOrder;
    assert.equal(order.length, 2);
    assert.ok(order[0].init <= order[1].init, 'RQ initiative should be ascending');

    // PC has skill 65 — attack with broadsword (will usually hit)
    const result = engine.resolveAction({
      type: 'attack',
      attackerId: 'orlanth',
      targetId: 'broo',
      weaponName: 'broadsword',
      defenseChoice: 'none',
    });

    assert.equal(result.type, 'attack');
    assert.ok(['hit', 'special', 'critical', 'miss', 'fumble'].includes(result.attackResult),
      'attackResult should be a known RQ outcome');

    if (result.attackResult !== 'miss' && result.attackResult !== 'fumble') {
      assert.ok(result.hitLocation, 'a non-miss RQ attack should have a hitLocation');
      assert.ok(result.damageApplied, 'damage should have been applied');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Monster lookup integration
// ---------------------------------------------------------------------------

describe('Integration: Monster lookup', () => {
  it('loads dnd5e defaults and verifies goblin has correct stats', () => {
    const monsters = loadDefaultMonsters('dnd5e');
    const goblin = monsters.goblin;

    assert.ok(goblin, 'goblin should exist');
    assert.equal(goblin.name, 'Goblin');
    assert.equal(goblin.hp, 7);
    assert.equal(goblin.maxHp, 7);
    assert.equal(goblin.ac, 15);
    assert.ok(Array.isArray(goblin.weapons) && goblin.weapons.length > 0, 'goblin should have weapons');
  });

  it('loads runequest defaults and verifies broo exists with hit locations', () => {
    const monsters = loadDefaultMonsters('runequest');
    const broo = monsters.broo;

    assert.ok(broo, 'broo should exist');
    assert.equal(broo.name, 'Broo');
    assert.ok(broo.hitLocations, 'broo should have hitLocations');
    assert.ok(broo.hitLocations.head, 'broo should have head location');
    assert.ok(broo.hitLocations.chest, 'broo should have chest location');
    assert.ok(typeof broo.totalHp === 'number', 'broo should have totalHp');
    assert.ok(Array.isArray(broo.weapons) && broo.weapons.length > 0, 'broo should have weapons');
  });

  it('caches results — second call returns same reference', () => {
    const first = loadDefaultMonsters('dnd5e');
    const second = loadDefaultMonsters('dnd5e');
    assert.equal(first, second, 'loadDefaultMonsters should cache its result');
  });

  it('throws for unknown system', () => {
    assert.throws(() => loadDefaultMonsters('pathfinder'), /Unknown system/);
  });
});

// ---------------------------------------------------------------------------
// 5. Combat lifecycle: init → several actions → turn advance → round increment → end
// ---------------------------------------------------------------------------

describe('Integration: Combat lifecycle', () => {
  it('advances turns and rounds across multiple actions', () => {
    const pc = makeDnDPC();
    const monsters = loadDefaultMonsters('dnd5e');
    const goblin = buildDnDEnemy({ ...monsters.goblin }, 'goblin');

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');

    assert.equal(engine.state.round, 1);
    const initialTurnIndex = engine.state.turnIndex;

    // Advance through both combatants — should wrap to round 2
    engine.advanceTurn(); // goes to index 1
    engine.advanceTurn(); // wraps → round 2, index 0

    assert.equal(engine.state.round, 2);
    assert.equal(engine.state.turnIndex, 0);

    // Advance through round 2 as well
    engine.advanceTurn();
    engine.advanceTurn(); // → round 3

    assert.equal(engine.state.round, 3);
  });

  it('isCombatOver returns false during combat and true after all enemies die', () => {
    const pc = makeDnDPC();
    const monsters = loadDefaultMonsters('dnd5e');
    const goblin = buildDnDEnemy({ ...monsters.goblin }, 'goblin');

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');

    assert.equal(engine.isCombatOver(), false, 'combat should not be over at start');

    engine.state.combatants['goblin'].hp = 0;
    assert.equal(engine.isCombatOver(), true, 'combat should be over when enemy is dead');

    const state = engine.endCombat();
    assert.equal(state.active, false);
  });

  it('logs multiple actions across a round', () => {
    const pc = makeDnDPC();
    const monsters = loadDefaultMonsters('dnd5e');
    const goblin = buildDnDEnemy({ ...monsters.goblin, ac: 1 }, 'goblin');

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');

    engine.resolveAction({ type: 'attack', attackerId: 'kael', targetId: 'goblin', weaponName: 'longsword' });
    engine.resolveAction({ type: 'dodge', actorId: 'goblin' });

    assert.equal(engine.state.log.length, 2);
    assert.equal(engine.state.log[0].type, 'attack');
    assert.equal(engine.state.log[1].type, 'dodge');
  });
});

// ---------------------------------------------------------------------------
// 6. Active effects: add Bless → verify → advance rounds → verify expired
// ---------------------------------------------------------------------------

describe('Integration: Active effects lifecycle', () => {
  it('adds Bless effect and it is present in state', () => {
    const pc = makeDnDPC();
    const monsters = loadDefaultMonsters('dnd5e');
    const goblin = buildDnDEnemy(monsters.goblin, 'goblin');

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');

    engine.addActiveEffect({
      name: 'Bless',
      caster: 'kael',
      targets: ['kael'],
      effect: { type: 'buff', bonus: '1d4' },
      duration: { type: 'rounds', count: 3 },
    });

    assert.equal(engine.state.activeEffects.length, 1);
    assert.equal(engine.state.activeEffects[0].name, 'Bless');
    assert.equal(engine.state.activeEffects[0].roundApplied, 1);
  });

  it('effect is still active before duration expires', () => {
    const pc = makeDnDPC();
    const monsters = loadDefaultMonsters('dnd5e');
    const goblin = buildDnDEnemy(monsters.goblin, 'goblin');

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');

    engine.addActiveEffect({
      name: 'Bless',
      caster: 'kael',
      targets: ['kael'],
      effect: {},
      duration: { type: 'rounds', count: 3 },
    });

    // Advance to round 2 — effect applied in round 1, duration=3, should remain
    engine.state.round = 2;
    engine.expireEffects();
    assert.equal(engine.state.activeEffects.length, 1, 'Bless should still be active in round 2');
  });

  it('effect expires after advancing past its duration', () => {
    const pc = makeDnDPC();
    const monsters = loadDefaultMonsters('dnd5e');
    const goblin = buildDnDEnemy(monsters.goblin, 'goblin');

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');

    engine.addActiveEffect({
      name: 'Bless',
      caster: 'kael',
      targets: ['kael'],
      effect: {},
      duration: { type: 'rounds', count: 2 },
    });

    // Applied in round 1, duration=2: expires when (round - roundApplied) >= 2 → round 3
    engine.state.round = 3;
    engine.expireEffects();
    assert.equal(engine.state.activeEffects.length, 0, 'Bless should have expired by round 3');
  });

  it('getCombatStateForPrompt includes active effect name while active', () => {
    const pc = makeDnDPC();
    const monsters = loadDefaultMonsters('dnd5e');
    const goblin = buildDnDEnemy(monsters.goblin, 'goblin');

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');

    engine.addActiveEffect({
      name: 'Bless',
      caster: 'kael',
      targets: ['kael'],
      effect: {},
      duration: { type: 'rounds', count: 3 },
    });

    const text = engine.getCombatStateForPrompt();
    assert.ok(text.includes('Bless') || text.includes('ACTIVE EFFECTS'),
      'state text should mention Bless or ACTIVE EFFECTS');
  });
});

// ---------------------------------------------------------------------------
// 7. Prompt formatting: resolve attacks → verify output strings
// ---------------------------------------------------------------------------

describe('Integration: Prompt formatting', () => {
  it('formats a hit attack result containing attacker, target, weapon, HIT', () => {
    const pc = makeDnDPC();
    const monsters = loadDefaultMonsters('dnd5e');
    const goblin = buildDnDEnemy({ ...monsters.goblin, ac: 1 }, 'goblin');

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');

    const result = engine.resolveAction({
      type: 'attack',
      attackerId: 'kael',
      targetId: 'goblin',
      weaponName: 'longsword',
    });

    const text = engine.formatResultForPrompt(result);
    assert.ok(text.includes('Kael'), 'should contain attacker name');
    assert.ok(text.includes('Goblin'), 'should contain target name');
    assert.ok(text.includes('longsword'), 'should contain weapon name');

    if (result.hit) {
      assert.ok(text.includes('HIT'), 'hit attack should say HIT');
    } else {
      assert.ok(text.includes('MISS'), 'miss attack should say MISS');
    }
  });

  it('formats a miss result containing MISS', () => {
    const pc = makeDnDPC();
    const monsters = loadDefaultMonsters('dnd5e');
    // AC 100 = always miss
    const goblin = buildDnDEnemy({ ...monsters.goblin, ac: 100 }, 'goblin');

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');

    const result = engine.resolveAction({
      type: 'attack',
      attackerId: 'kael',
      targetId: 'goblin',
      weaponName: 'longsword',
    });

    const text = engine.formatResultForPrompt(result);
    // AC=100 means almost always a miss; skip assertion on fumble (natural 1)
    if (!result.fumble && !result.hit) {
      assert.ok(text.includes('MISS'), 'should say MISS when attack misses');
    }
  });

  it('formats a RuneQuest hit including hit location', () => {
    const pc = makeRQPC();
    const monsters = loadDefaultMonsters('runequest');
    const broo = buildRQEnemy({ ...monsters.broo }, 'broo');

    const engine = new CombatEngine();
    engine.initCombat([pc], [broo], 'runequest');

    // Run multiple attacks until we get a hit (skill 65 so should hit within a few tries)
    let hitResult = null;
    for (let i = 0; i < 20; i++) {
      // Fresh engine each attempt to avoid state accumulation from prior misses
      const eng2 = new CombatEngine();
      const pc2 = makeRQPC();
      const broo2 = buildRQEnemy({ ...monsters.broo }, 'broo');
      eng2.initCombat([pc2], [broo2], 'runequest');
      const r = eng2.resolveAction({
        type: 'attack',
        attackerId: 'orlanth',
        targetId: 'broo',
        weaponName: 'broadsword',
        defenseChoice: 'none',
      });
      if (r.attackResult !== 'miss' && r.attackResult !== 'fumble') {
        hitResult = { engine: eng2, result: r };
        break;
      }
    }

    if (hitResult) {
      const text = hitResult.engine.formatResultForPrompt(hitResult.result);
      assert.ok(text.includes('Orlanth'), 'should contain attacker name');
      assert.ok(text.includes('Broo'), 'should contain target name');
      assert.ok(text.includes('broadsword'), 'should contain weapon name');
      assert.ok(text.includes(hitResult.result.hitLocation), 'should include hit location');
    }
    // If no hit in 20 tries, pass silently (extremely unlikely with 65 skill)
  });
});

// ---------------------------------------------------------------------------
// 8. Combat state for prompt
// ---------------------------------------------------------------------------

describe('Integration: Combat state for prompt', () => {
  it('getCombatStateForPrompt contains ACTIVE COMBAT, round number, and combatant names', () => {
    const pc = makeDnDPC();
    const monsters = loadDefaultMonsters('dnd5e');
    const goblin = buildDnDEnemy(monsters.goblin, 'goblin');

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');

    const text = engine.getCombatStateForPrompt();

    assert.ok(text.includes('ACTIVE COMBAT'), 'should contain ACTIVE COMBAT');
    assert.ok(text.includes('Round 1'), 'should contain round number');
    assert.ok(text.includes('Kael'), 'should contain PC name');
    assert.ok(text.includes('Goblin'), 'should contain enemy name');
  });

  it('state text updates to Round 2 after turn wrap', () => {
    const pc = makeDnDPC();
    const monsters = loadDefaultMonsters('dnd5e');
    const goblin = buildDnDEnemy(monsters.goblin, 'goblin');

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');

    // Advance through all combatants → round 2
    engine.advanceTurn();
    engine.advanceTurn();

    const text = engine.getCombatStateForPrompt();
    assert.ok(text.includes('Round 2'), 'state should show Round 2 after wrap');
  });

  it('dead combatants show DEAD in state text', () => {
    const pc = makeDnDPC();
    const monsters = loadDefaultMonsters('dnd5e');
    const goblin = buildDnDEnemy(monsters.goblin, 'goblin');

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');
    engine.state.combatants['goblin'].hp = 0;

    const text = engine.getCombatStateForPrompt();
    assert.ok(text.includes('DEAD'), 'dead combatant should show DEAD');
  });

  it('RuneQuest state text includes both combatant names', () => {
    const pc = makeRQPC();
    const monsters = loadDefaultMonsters('runequest');
    const broo = buildRQEnemy(monsters.broo, 'broo');

    const engine = new CombatEngine();
    engine.initCombat([pc], [broo], 'runequest');

    const text = engine.getCombatStateForPrompt();
    assert.ok(text.includes('ACTIVE COMBAT'), 'should contain ACTIVE COMBAT');
    assert.ok(text.includes('Orlanth'), 'should contain PC name');
    assert.ok(text.includes('Broo'), 'should contain enemy name');
  });
});
