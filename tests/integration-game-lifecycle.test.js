'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const testDb = require('./test-db-setup');

// Note: These tests exercise the database directly since we're testing persistence,
// not the full Express/Socket.io stack. For that, see integration-api-endpoints.test.js

describe('Integration: Game Lifecycle — Creation, State Persistence, Reload', async (t) => {
  let pool;
  let skipTests = false;

  before(async () => {
    try {
      pool = await testDb.initTestDb();
    } catch (err) {
      console.log('⊘ Skipping integration-game-lifecycle tests: PostgreSQL not available');
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
  // Test 1: Create game and verify DB row
  // ─────────────────────────────────────────────────────────────────────────────

  it('creates game and verifies DB row exists with correct config', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();
    const gameData = {
      id: gameId,
      name: 'Tavern Quest',
      system: 'dnd5e',
      custom_context: 'A campaign in the Sword Coast',
      billing_mode: 'host_pays',
      host_user_id: 'user-123',
    };

    // Insert game
    await testDb.query(
      `INSERT INTO games (id, name, system, custom_context, billing_mode, host_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [gameData.id, gameData.name, gameData.system, gameData.custom_context, gameData.billing_mode, gameData.host_user_id]
    );

    // Verify game exists
    const result = await testDb.query('SELECT * FROM games WHERE id = $1', [gameId]);
    assert.equal(result.rows.length, 1, 'game should exist');
    assert.equal(result.rows[0].name, 'Tavern Quest');
    assert.equal(result.rows[0].system, 'dnd5e');
    assert.equal(result.rows[0].custom_context, 'A campaign in the Sword Coast');
    assert.equal(result.rows[0].billing_mode, 'host_pays');
    assert.equal(result.rows[0].host_user_id, 'user-123');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2: Load game state from DB
  // ─────────────────────────────────────────────────────────────────────────────

  it('loads game state from DB after creation', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();

    // Create game
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Test Game', 'dnd5e']
    );

    // Set initial game state
    const initialState = {
      ferocity: 3,
      verbosity: 'brief',
      pillars: { exploration: 33, combat: 33, social: 34 },
      dmPersona: 'epic',
      chatHistory: [],
    };

    await testDb.query(
      `INSERT INTO game_state (game_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (game_id, key) DO UPDATE SET value = $3`,
      [gameId, 'settings', JSON.stringify(initialState)]
    );

    // Load game state back
    const result = await testDb.query(
      'SELECT value FROM game_state WHERE game_id = $1 AND key = $2',
      [gameId, 'settings']
    );

    assert.equal(result.rows.length, 1, 'state row should exist');
    const loaded = result.rows[0].value;
    assert.equal(loaded.ferocity, 3);
    assert.equal(loaded.verbosity, 'brief');
    assert.equal(loaded.pillars.combat, 33);
    assert.equal(loaded.dmPersona, 'epic');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3: Register character with combatStats
  // ─────────────────────────────────────────────────────────────────────────────

  it('registers character with combatStats to DB', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();
    const charName = 'Kael';

    // Create game
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Test Game', 'dnd5e']
    );

    // Register character with JSONB data
    const charData = {
      statsText: 'AC 16, HP 38, STR +3',
      combatStats: {
        ac: 16,
        hp: 38,
        maxHp: 38,
        abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 13, cha: 8 },
        proficiencyBonus: 3,
        weapons: [
          { name: 'longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing' },
        ],
      },
      personality: 'Brave fighter',
      backstory: 'A seasoned warrior',
    };

    await testDb.query(
      `INSERT INTO characters (game_id, name, data)
       VALUES ($1, $2, $3)`,
      [gameId, charName, JSON.stringify(charData)]
    );

    // Verify character exists with combatStats
    const result = await testDb.query(
      'SELECT data FROM characters WHERE game_id = $1 AND name = $2',
      [gameId, charName]
    );

    assert.equal(result.rows.length, 1, 'character should exist');
    const loaded = result.rows[0].data;
    assert.equal(loaded.combatStats.ac, 16);
    assert.equal(loaded.combatStats.hp, 38);
    assert.equal(loaded.combatStats.abilities.str, 16);
    assert.equal(loaded.combatStats.weapons[0].name, 'longsword');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4: Update game settings (ferocity, pillars, etc)
  // ─────────────────────────────────────────────────────────────────────────────

  it('updates game settings and persists to DB', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();

    // Create game
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Test Game', 'dnd5e']
    );

    // Set initial settings
    const initial = {
      ferocity: 3,
      verbosity: 'brief',
      pillars: { exploration: 33, combat: 33, social: 34 },
    };

    await testDb.query(
      `INSERT INTO game_state (game_id, key, value) VALUES ($1, $2, $3)`,
      [gameId, 'settings', JSON.stringify(initial)]
    );

    // Update settings
    const updated = {
      ferocity: 5,
      verbosity: 'verbose',
      pillars: { exploration: 20, combat: 50, social: 30 },
    };

    await testDb.query(
      `UPDATE game_state SET value = $1 WHERE game_id = $2 AND key = $3`,
      [JSON.stringify(updated), gameId, 'settings']
    );

    // Verify update
    const result = await testDb.query(
      'SELECT value FROM game_state WHERE game_id = $1 AND key = $2',
      [gameId, 'settings']
    );

    const loaded = result.rows[0].value;
    assert.equal(loaded.ferocity, 5, 'ferocity should be updated to 5');
    assert.equal(loaded.verbosity, 'verbose', 'verbosity should be updated to verbose');
    assert.equal(loaded.pillars.combat, 50, 'combat pillar should be 50');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 5: Persist character to DB with HP changes
  // ─────────────────────────────────────────────────────────────────────────────

  it('persists character HP changes to DB', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();
    const charName = 'Kael';

    // Create game
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Test Game', 'dnd5e']
    );

    // Create character with full HP
    const charData = {
      statsText: 'AC 16, HP 38',
      combatStats: {
        ac: 16,
        hp: 38,
        maxHp: 38,
      },
    };

    await testDb.query(
      `INSERT INTO characters (game_id, name, data) VALUES ($1, $2, $3)`,
      [gameId, charName, JSON.stringify(charData)]
    );

    // Simulate damage — update HP
    charData.combatStats.hp = 20;

    await testDb.query(
      `UPDATE characters SET data = $1 WHERE game_id = $2 AND name = $3`,
      [JSON.stringify(charData), gameId, charName]
    );

    // Verify HP was reduced
    const result = await testDb.query(
      'SELECT data FROM characters WHERE game_id = $1 AND name = $2',
      [gameId, charName]
    );

    const loaded = result.rows[0].data;
    assert.equal(loaded.combatStats.hp, 20, 'HP should be reduced to 20');
    assert.equal(loaded.combatStats.maxHp, 38, 'maxHp should remain unchanged');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 6: Reload character from DB with exact match
  // ─────────────────────────────────────────────────────────────────────────────

  it('reloads character from DB and data matches exactly', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();
    const charName = 'Kael';

    // Create game
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Test Game', 'dnd5e']
    );

    // Create complex character object
    const originalData = {
      statsText: 'AC 16, HP 38',
      personality: 'Brave and honorable',
      backstory: 'A knight from the north',
      combatStats: {
        ac: 16,
        hp: 38,
        maxHp: 38,
        speed: 30,
        abilities: {
          str: 16, dex: 12, con: 14, int: 10, wis: 13, cha: 8,
        },
        proficiencyBonus: 3,
        weapons: [
          { name: 'longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing' },
        ],
        spells: [],
        spellSlots: {},
        conditions: [],
        deathSaves: { successes: 0, failures: 0 },
      },
      visualDesc: 'A tall human male with steel armor',
    };

    await testDb.query(
      `INSERT INTO characters (game_id, name, data) VALUES ($1, $2, $3)`,
      [gameId, charName, JSON.stringify(originalData)]
    );

    // Reload character
    const result = await testDb.query(
      'SELECT data FROM characters WHERE game_id = $1 AND name = $2',
      [gameId, charName]
    );

    const reloadedData = result.rows[0].data;

    // Deep equality check
    assert.deepEqual(reloadedData, originalData, 'reloaded data should match original exactly');
    assert.equal(reloadedData.combatStats.abilities.str, 16);
    assert.equal(reloadedData.combatStats.weapons.length, 1);
    assert.equal(reloadedData.visualDesc, 'A tall human male with steel armor');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 7: Multiple characters in same game
  // ─────────────────────────────────────────────────────────────────────────────

  it('manages multiple characters in same game', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();

    // Create game
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Party Quest', 'dnd5e']
    );

    // Create three characters
    const characters = [
      { name: 'Kael', class: 'Fighter', hp: 38 },
      { name: 'Mira', class: 'Rogue', hp: 24 },
      { name: 'Thorin', class: 'Dwarf Cleric', hp: 32 },
    ];

    for (const char of characters) {
      const data = {
        class: char.class,
        combatStats: { hp: char.hp, maxHp: char.hp },
      };
      await testDb.query(
        `INSERT INTO characters (game_id, name, data) VALUES ($1, $2, $3)`,
        [gameId, char.name, JSON.stringify(data)]
      );
    }

    // Query all characters
    const result = await testDb.query(
      'SELECT name, data FROM characters WHERE game_id = $1 ORDER BY name',
      [gameId]
    );

    assert.equal(result.rows.length, 3, 'should have 3 characters');
    assert.equal(result.rows[0].name, 'Kael');
    assert.equal(result.rows[1].name, 'Mira');
    assert.equal(result.rows[2].name, 'Thorin');
    assert.equal(result.rows[0].data.class, 'Fighter');
    assert.equal(result.rows[1].data.combatStats.hp, 24);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 8: Game state survives round-trip serialization
  // ─────────────────────────────────────────────────────────────────────────────

  it('complex game state survives round-trip DB serialization', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();

    // Create game
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Complex Game', 'dnd5e']
    );

    // Create a complex state object with nested arrays and objects
    const complexState = {
      ferocity: 3,
      verbosity: 'brief',
      pillars: { exploration: 33, combat: 33, social: 34 },
      dmPersona: 'epic',
      chatHistory: [
        { role: 'dm', text: 'You enter a tavern.' },
        { role: 'player', text: 'I look around.' },
      ],
      world: {
        locations: [
          { name: 'Tavern', description: 'A lively tavern', npcs: ['Bartender'] },
          { name: 'Forest', description: 'Dark woods', npcs: [] },
        ],
        npcs: {
          Bartender: { role: 'vendor', disposition: 'friendly' },
        },
      },
      map: {
        nodes: [{ id: 1, name: 'Start' }, { id: 2, name: 'End' }],
        edges: [{ from: 1, to: 2 }],
      },
    };

    // Save state
    await testDb.query(
      `INSERT INTO game_state (game_id, key, value) VALUES ($1, $2, $3)`,
      [gameId, 'settings', JSON.stringify(complexState)]
    );

    // Reload state
    const result = await testDb.query(
      'SELECT value FROM game_state WHERE game_id = $1 AND key = $2',
      [gameId, 'settings']
    );

    const reloaded = result.rows[0].value;

    // Verify deep structure is intact
    assert.deepEqual(reloaded, complexState, 'complex state should survive round-trip');
    assert.equal(reloaded.chatHistory.length, 2);
    assert.equal(reloaded.world.locations[0].name, 'Tavern');
    assert.equal(reloaded.world.npcs.Bartender.disposition, 'friendly');
    assert.equal(reloaded.map.edges[0].from, 1);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 9: Game deletion cascades to characters and state
  // ─────────────────────────────────────────────────────────────────────────────

  it('deleting game cascades to characters and state', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();

    // Create game with character and state
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Temp Game', 'dnd5e']
    );

    await testDb.query(
      `INSERT INTO characters (game_id, name, data) VALUES ($1, $2, $3)`,
      [gameId, 'Kael', JSON.stringify({ class: 'Fighter' })]
    );

    await testDb.query(
      `INSERT INTO game_state (game_id, key, value) VALUES ($1, $2, $3)`,
      [gameId, 'settings', JSON.stringify({ ferocity: 3 })]
    );

    // Verify data exists
    let result = await testDb.query('SELECT id FROM games WHERE id = $1', [gameId]);
    assert.equal(result.rows.length, 1);

    result = await testDb.query('SELECT name FROM characters WHERE game_id = $1', [gameId]);
    assert.equal(result.rows.length, 1);

    result = await testDb.query('SELECT key FROM game_state WHERE game_id = $1', [gameId]);
    assert.equal(result.rows.length, 1);

    // Delete game
    await testDb.query('DELETE FROM games WHERE id = $1', [gameId]);

    // Verify everything is gone
    result = await testDb.query('SELECT id FROM games WHERE id = $1', [gameId]);
    assert.equal(result.rows.length, 0, 'game should be deleted');

    result = await testDb.query('SELECT name FROM characters WHERE game_id = $1', [gameId]);
    assert.equal(result.rows.length, 0, 'characters should cascade-delete');

    result = await testDb.query('SELECT key FROM game_state WHERE game_id = $1', [gameId]);
    assert.equal(result.rows.length, 0, 'state should cascade-delete');
  });
});
