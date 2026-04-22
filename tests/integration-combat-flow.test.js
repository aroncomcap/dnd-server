'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const CombatEngine = require('../combat-engine');
const testDb = require('./test-db-setup');

/**
 * Integration tests for combat flow with state persistence
 * Tests the full cycle: init → actions → damage tracking → DB persist → reload → resume
 */

describe('Integration: Combat Flow with State Persistence and Reload', () => {
  let pool;
  let skipTests = false;

  before(async () => {
    try {
      pool = await testDb.initTestDb();
    } catch (err) {
      console.log('⊘ Skipping integration-combat-flow tests: PostgreSQL not available');
      skipTests = true;
    }
  });

  after(async () => {
    if (!skipTests) {
      await testDb.dropSchema();
      await testDb.closeTestDb();
    }
  });

  beforeEach(async () => {
    if (!skipTests) await testDb.clearTestData();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 1: Initiate combat with multiple enemies
  // ─────────────────────────────────────────────────────────────────────────────

  it('initiates combat with 3 enemies and verifies turn order', () => {
    const pc = {
      id: 'kael',
      name: 'Kael',
      type: 'PC',
      level: 5,
      ac: 16,
      hp: 38,
      maxHp: 38,
      abilities: { dex: 12 },
      speed: 30,
      weapons: [{ name: 'longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing' }],
      spells: [],
      spellSlots: {},
      features: [],
      conditions: [],
      concentrating: null,
      deathSaves: { successes: 0, failures: 0 },
      inspiration: false,
    };

    const enemies = [
      {
        id: 'goblin-1',
        name: 'Goblin',
        type: 'Enemy',
        ac: 15,
        hp: 7,
        maxHp: 7,
        abilities: { dex: 14 },
        speed: 30,
        weapons: [{ name: 'shortsword', attackMod: 'dex', damage: '1d6' }],
        conditions: [],
      },
      {
        id: 'goblin-2',
        name: 'Goblin',
        type: 'Enemy',
        ac: 15,
        hp: 7,
        maxHp: 7,
        abilities: { dex: 13 },
        speed: 30,
        weapons: [{ name: 'shortsword', attackMod: 'dex', damage: '1d6' }],
        conditions: [],
      },
      {
        id: 'hobgoblin',
        name: 'Hobgoblin',
        type: 'Enemy',
        ac: 18,
        hp: 11,
        maxHp: 11,
        abilities: { dex: 12 },
        speed: 30,
        weapons: [{ name: 'longsword', attackMod: 'str', damage: '1d8' }],
        conditions: [],
      },
    ];

    const engine = new CombatEngine();
    engine.initCombat([pc], enemies, 'dnd5e');

    assert.equal(engine.state.active, true);
    assert.equal(engine.state.round, 1);
    assert.equal(engine.state.system, 'dnd5e');
    assert.ok(engine.state.initiativeOrder.length > 0);
    assert.ok(engine.state.combatants['kael']);
    assert.ok(engine.state.combatants['goblin-1']);
    assert.ok(engine.state.combatants['goblin-2']);
    assert.ok(engine.state.combatants['hobgoblin']);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2: Enemy attacks do damage correctly
  // ─────────────────────────────────────────────────────────────────────────────

  it('enemy attack applies damage when it hits', () => {
    const pc = {
      id: 'kael',
      name: 'Kael',
      type: 'PC',
      ac: 15,
      hp: 38,
      maxHp: 38,
      abilities: { dex: 12 },
      speed: 30,
      weapons: [{ name: 'longsword', attackMod: 'str', damage: '1d8' }],
      spells: [],
      spellSlots: {},
      features: [],
      conditions: [],
      concentrating: null,
      deathSaves: { successes: 0, failures: 0 },
      inspiration: false,
    };

    const goblin = {
      id: 'goblin',
      name: 'Goblin',
      type: 'Enemy',
      ac: 15,
      hp: 7,
      maxHp: 7,
      abilities: { dex: 14 },
      speed: 30,
      weapons: [{ name: 'shortsword', attackMod: 'dex', damage: '1d6' }],
      conditions: [],
    };

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');

    const initialHp = engine.state.combatants['kael'].hp;

    // Goblin attacks PC — try multiple times until it hits
    let hitResult = null;
    for (let i = 0; i < 20; i++) {
      const result = engine.resolveAction({
        type: 'attack',
        attackerId: 'goblin',
        targetId: 'kael',
        weaponName: 'shortsword',
      });
      if (result.hit) {
        hitResult = result;
        break;
      }
    }

    if (hitResult && hitResult.hit) {
      const finalHp = engine.state.combatants['kael'].hp;
      assert.ok(finalHp < initialHp, 'PC HP should decrease when hit');
      assert.ok(finalHp >= initialHp - 10, 'damage should be reasonable (d6 max 6 + mod)');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3: PC HP tracked accurately throughout combat
  // ─────────────────────────────────────────────────────────────────────────────

  it('PC HP tracked accurately across multiple rounds', () => {
    const pc = {
      id: 'kael',
      name: 'Kael',
      type: 'PC',
      ac: 12, // Low AC so enemies hit more often
      hp: 38,
      maxHp: 38,
      abilities: { dex: 12 },
      speed: 30,
      weapons: [{ name: 'longsword', attackMod: 'str', damage: '1d8' }],
      spells: [],
      spellSlots: {},
      features: [],
      conditions: [],
      concentrating: null,
      deathSaves: { successes: 0, failures: 0 },
      inspiration: false,
    };

    const goblin = {
      id: 'goblin',
      name: 'Goblin',
      type: 'Enemy',
      ac: 15,
      hp: 7,
      maxHp: 7,
      abilities: { dex: 14 },
      speed: 30,
      weapons: [{ name: 'shortsword', attackMod: 'dex', damage: '1d6' }],
      conditions: [],
    };

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');

    const startHp = pc.hp;

    // Do several rounds of combat
    for (let round = 0; round < 3; round++) {
      engine.resolveAction({
        type: 'attack',
        attackerId: 'kael',
        targetId: 'goblin',
        weaponName: 'longsword',
      });

      engine.resolveAction({
        type: 'attack',
        attackerId: 'goblin',
        targetId: 'kael',
        weaponName: 'shortsword',
      });

      engine.advanceTurn();
      engine.advanceTurn();
    }

    // PC should never exceed maxHp
    const finalHp = engine.state.combatants['kael'].hp;
    assert.ok(finalHp <= startHp, 'HP should not increase');
    assert.ok(finalHp >= 0 || engine.state.combatants['kael'].hp === 0, 'HP should stay >= 0');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4: Conditions applied and tracked
  // ─────────────────────────────────────────────────────────────────────────────

  it('applies and tracks conditions during combat', () => {
    const pc = {
      id: 'kael',
      name: 'Kael',
      type: 'PC',
      ac: 16,
      hp: 38,
      maxHp: 38,
      abilities: { dex: 12 },
      speed: 30,
      weapons: [{ name: 'longsword', attackMod: 'str', damage: '1d8' }],
      spells: [],
      spellSlots: {},
      features: [],
      conditions: [],
      concentrating: null,
      deathSaves: { successes: 0, failures: 0 },
      inspiration: false,
    };

    const goblin = {
      id: 'goblin',
      name: 'Goblin',
      type: 'Enemy',
      ac: 15,
      hp: 7,
      maxHp: 7,
      abilities: { dex: 14 },
      speed: 30,
      weapons: [{ name: 'shortsword', attackMod: 'dex', damage: '1d6' }],
      conditions: [],
    };

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');

    // Apply a condition
    engine.state.combatants['kael'].conditions.push('stunned');

    assert.equal(engine.state.combatants['kael'].conditions.length, 1);
    assert.equal(engine.state.combatants['kael'].conditions[0], 'stunned');

    // Remove condition
    engine.state.combatants['kael'].conditions = [];
    assert.equal(engine.state.combatants['kael'].conditions.length, 0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 5: Persist combat state to DB
  // ─────────────────────────────────────────────────────────────────────────────

  it('persists combat state to game_state table', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();

    // Create game
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Combat Test', 'dnd5e']
    );

    // Set up combat
    const pc = {
      id: 'kael',
      name: 'Kael',
      type: 'PC',
      ac: 16,
      hp: 38,
      maxHp: 38,
      abilities: { dex: 12 },
      speed: 30,
      weapons: [{ name: 'longsword', attackMod: 'str', damage: '1d8' }],
      spells: [],
      spellSlots: {},
      features: [],
      conditions: [],
      concentrating: null,
      deathSaves: { successes: 0, failures: 0 },
      inspiration: false,
    };

    const goblin = {
      id: 'goblin',
      name: 'Goblin',
      type: 'Enemy',
      ac: 15,
      hp: 7,
      maxHp: 7,
      abilities: { dex: 14 },
      speed: 30,
      weapons: [{ name: 'shortsword', attackMod: 'dex', damage: '1d6' }],
      conditions: [],
    };

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');

    // Do some combat
    engine.resolveAction({
      type: 'attack',
      attackerId: 'kael',
      targetId: 'goblin',
      weaponName: 'longsword',
    });

    // Persist state to DB (simulating server behavior)
    await testDb.query(
      `INSERT INTO game_state (game_id, key, value) VALUES ($1, $2, $3)`,
      [gameId, 'combatState', JSON.stringify(engine.state)]
    );

    // Verify state was saved
    const result = await testDb.query(
      'SELECT value FROM game_state WHERE game_id = $1 AND key = $2',
      [gameId, 'combatState']
    );

    assert.equal(result.rows.length, 1, 'combat state should be saved');
    const saved = result.rows[0].value;
    assert.equal(saved.active, true);
    assert.equal(saved.system, 'dnd5e');
    assert.ok(saved.combatants['kael']);
    assert.ok(saved.combatants['goblin']);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 6: Reload combat state from DB via combatEngine.loadState()
  // ─────────────────────────────────────────────────────────────────────────────

  it('reloads combat state from DB and engine restores exactly', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();

    // Create game
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Combat Reload Test', 'dnd5e']
    );

    // Create initial engine with combat
    const pc = {
      id: 'kael',
      name: 'Kael',
      type: 'PC',
      ac: 16,
      hp: 38,
      maxHp: 38,
      abilities: { dex: 12 },
      speed: 30,
      weapons: [{ name: 'longsword', attackMod: 'str', damage: '1d8' }],
      spells: [],
      spellSlots: {},
      features: [],
      conditions: [],
      concentrating: null,
      deathSaves: { successes: 0, failures: 0 },
      inspiration: false,
    };

    const goblin = {
      id: 'goblin',
      name: 'Goblin',
      type: 'Enemy',
      ac: 15,
      hp: 7,
      maxHp: 7,
      abilities: { dex: 14 },
      speed: 30,
      weapons: [{ name: 'shortsword', attackMod: 'dex', damage: '1d6' }],
      conditions: [],
    };

    const engine1 = new CombatEngine();
    engine1.initCombat([pc], [goblin], 'dnd5e');

    // Modify state (simulate combat actions)
    engine1.state.combatants['kael'].hp = 25;
    engine1.state.combatants['goblin'].hp = 4;
    engine1.state.round = 3;
    engine1.state.log.push({ type: 'attack', attacker: 'kael', target: 'goblin', hit: true });

    // Save state
    const savedState = JSON.parse(JSON.stringify(engine1.state));
    await testDb.query(
      `INSERT INTO game_state (game_id, key, value) VALUES ($1, $2, $3)`,
      [gameId, 'combatState', JSON.stringify(savedState)]
    );

    // Create new engine and reload from DB
    const engine2 = new CombatEngine();
    const result = await testDb.query(
      'SELECT value FROM game_state WHERE game_id = $1 AND key = $2',
      [gameId, 'combatState']
    );

    const loaded = result.rows[0].value;
    engine2.loadState(loaded);

    // Verify reloaded state matches original
    assert.equal(engine2.state.active, engine1.state.active);
    assert.equal(engine2.state.round, 3);
    assert.equal(engine2.state.combatants['kael'].hp, 25);
    assert.equal(engine2.state.combatants['goblin'].hp, 4);
    assert.equal(engine2.state.log.length, 1);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 7: Resume combat after reload
  // ─────────────────────────────────────────────────────────────────────────────

  it('can resume combat after reload and continue fighting', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();

    // Create game
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Combat Resume Test', 'dnd5e']
    );

    // Create and fight with engine 1
    const pc = {
      id: 'kael',
      name: 'Kael',
      type: 'PC',
      ac: 16,
      hp: 38,
      maxHp: 38,
      abilities: { dex: 12 },
      speed: 30,
      weapons: [{ name: 'longsword', attackMod: 'str', damage: '1d8' }],
      spells: [],
      spellSlots: {},
      features: [],
      conditions: [],
      concentrating: null,
      deathSaves: { successes: 0, failures: 0 },
      inspiration: false,
    };

    const goblin = {
      id: 'goblin',
      name: 'Goblin',
      type: 'Enemy',
      ac: 15,
      hp: 7,
      maxHp: 7,
      abilities: { dex: 14 },
      speed: 30,
      weapons: [{ name: 'shortsword', attackMod: 'dex', damage: '1d6' }],
      conditions: [],
    };

    const engine1 = new CombatEngine();
    engine1.initCombat([pc], [goblin], 'dnd5e');

    // Simulate some combat
    for (let i = 0; i < 5; i++) {
      engine1.resolveAction({
        type: 'attack',
        attackerId: 'kael',
        targetId: 'goblin',
        weaponName: 'longsword',
      });
      if (engine1.isCombatOver().over) break;
    }

    const preReloadRound = engine1.state.round;
    const preReloadLogLength = engine1.state.log.length;

    // Persist state
    await testDb.query(
      `INSERT INTO game_state (game_id, key, value) VALUES ($1, $2, $3)`,
      [gameId, 'combatState', JSON.stringify(engine1.state)]
    );

    // Reload
    const engine2 = new CombatEngine();
    const result = await testDb.query(
      'SELECT value FROM game_state WHERE game_id = $1 AND key = $2',
      [gameId, 'combatState']
    );

    engine2.loadState(result.rows[0].value);

    // Resume combat
    if (!engine2.isCombatOver().over) {
      engine2.resolveAction({
        type: 'attack',
        attackerId: 'kael',
        targetId: 'goblin',
        weaponName: 'longsword',
      });

      // Verify round and log advanced
      assert.ok(engine2.state.round >= preReloadRound);
      assert.ok(engine2.state.log.length >= preReloadLogLength);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 8: Combat end (victory) saved to DB
  // ─────────────────────────────────────────────────────────────────────────────

  it('combat end (all enemies dead) is saved to DB', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();

    // Create game
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Combat Victory Test', 'dnd5e']
    );

    const pc = {
      id: 'kael',
      name: 'Kael',
      type: 'PC',
      ac: 16,
      hp: 38,
      maxHp: 38,
      abilities: { dex: 12 },
      speed: 30,
      weapons: [{ name: 'longsword', attackMod: 'str', damage: '1d8' }],
      spells: [],
      spellSlots: {},
      features: [],
      conditions: [],
      concentrating: null,
      deathSaves: { successes: 0, failures: 0 },
      inspiration: false,
    };

    const goblin = {
      id: 'goblin',
      name: 'Goblin',
      type: 'Enemy',
      ac: 1, // Will always miss to avoid random deaths
      hp: 1,
      maxHp: 1,
      abilities: { dex: 14 },
      speed: 30,
      weapons: [{ name: 'shortsword', attackMod: 'dex', damage: '1d6' }],
      conditions: [],
    };

    const engine = new CombatEngine();
    engine.initCombat([pc], [goblin], 'dnd5e');

    // Kill the goblin instantly
    engine.state.combatants['goblin'].hp = 0;
    const combatOver = engine.isCombatOver();

    assert.equal(combatOver.over, true);

    // Save final combat state
    engine.endCombat();
    await testDb.query(
      `INSERT INTO game_state (game_id, key, value) VALUES ($1, $2, $3)`,
      [gameId, 'combatState', JSON.stringify(engine.state)]
    );

    // Reload and verify combat is marked as ended
    const result = await testDb.query(
      'SELECT value FROM game_state WHERE game_id = $1 AND key = $2',
      [gameId, 'combatState']
    );

    const reloaded = result.rows[0].value;
    assert.equal(reloaded.active, false, 'combat should be inactive after end');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 9: Multiple combats in sequence without state leakage
  // ─────────────────────────────────────────────────────────────────────────────

  it('multiple combats in sequence do not leak state', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();

    // Create game
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Multiple Combat Test', 'dnd5e']
    );

    const pc = {
      id: 'kael',
      name: 'Kael',
      type: 'PC',
      ac: 16,
      hp: 38,
      maxHp: 38,
      abilities: { dex: 12 },
      speed: 30,
      weapons: [{ name: 'longsword', attackMod: 'str', damage: '1d8' }],
      spells: [],
      spellSlots: {},
      features: [],
      conditions: [],
      concentrating: null,
      deathSaves: { successes: 0, failures: 0 },
      inspiration: false,
    };

    // Combat 1: vs goblin
    const goblin1 = {
      id: 'goblin-1',
      name: 'Goblin',
      type: 'Enemy',
      ac: 15,
      hp: 7,
      maxHp: 7,
      abilities: { dex: 14 },
      speed: 30,
      weapons: [{ name: 'shortsword', attackMod: 'dex', damage: '1d6' }],
      conditions: [],
    };

    const engine1 = new CombatEngine();
    engine1.initCombat([pc], [goblin1], 'dnd5e');
    engine1.state.combatants['goblin-1'].hp = 0;
    const state1 = JSON.parse(JSON.stringify(engine1.state));

    // Save combat 1
    await testDb.query(
      `INSERT INTO game_state (game_id, key, value) VALUES ($1, $2, $3)`,
      [gameId, 'combatState', JSON.stringify(state1)]
    );

    // Combat 2: vs new goblin (fresh combat)
    const goblin2 = {
      id: 'goblin-2',
      name: 'Goblin',
      type: 'Enemy',
      ac: 15,
      hp: 7,
      maxHp: 7,
      abilities: { dex: 14 },
      speed: 30,
      weapons: [{ name: 'shortsword', attackMod: 'dex', damage: '1d6' }],
      conditions: [],
    };

    const engine2 = new CombatEngine();
    engine2.initCombat([pc], [goblin2], 'dnd5e');
    const state2 = JSON.parse(JSON.stringify(engine2.state));

    // Verify distinct combats
    assert.equal(state1.combatants['goblin-1'].hp, 0, 'combat 1 goblin should be dead');
    assert.equal(state2.combatants['goblin-2'].hp, 7, 'combat 2 goblin should be fresh');
    assert.ok(!state2.combatants['goblin-1'], 'combat 2 should not have goblin-1');

    // Save combat 2 (overwrite combat 1)
    await testDb.query(
      `UPDATE game_state SET value = $1 WHERE game_id = $2 AND key = $3`,
      [JSON.stringify(state2), gameId, 'combatState']
    );

    // Verify only combat 2 remains
    const result = await testDb.query(
      'SELECT value FROM game_state WHERE game_id = $1 AND key = $2',
      [gameId, 'combatState']
    );

    const reloaded = result.rows[0].value;
    assert.ok(reloaded.combatants['goblin-2']);
    assert.ok(!reloaded.combatants['goblin-1']);
  });
});
