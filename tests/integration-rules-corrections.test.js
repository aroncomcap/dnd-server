'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const testDb = require('./test-db-setup');

/**
 * Integration tests for rules corrections (house rules)
 * Tests: rule injection, persistence, master rules, game system filtering
 */

describe('Integration: Rules Corrections — Persistence and Injection', () => {
  let pool;
  let skipTests = false;

  before(async () => {
    try {
      pool = await testDb.initTestDb();
    } catch (err) {
      console.log('⊘ Skipping integration-rules-corrections tests: PostgreSQL not available');
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
  // Test 1: Add rule correction to game
  // ─────────────────────────────────────────────────────────────────────────────

  it('adds house rule to game and verifies DB row', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();
    const userId = crypto.randomUUID();

    // Create game
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Test Game', 'dnd5e']
    );

    // Create user
    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [userId, `user@test.com`, 'email']
    );

    // Add rule correction
    const ruleText = 'Inspiration can be used twice per rest period.';
    const result = await testDb.query(
      `INSERT INTO rules_corrections
       (game_id, text, category, is_private, is_master, created_by_user_id, game_system)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [gameId, ruleText, 'mechanics', false, false, userId, 'dnd5e']
    );

    assert.ok(result.rows[0].id, 'rule should be inserted with ID');

    // Verify rule exists
    const verify = await testDb.query(
      'SELECT text, category, game_id FROM rules_corrections WHERE id = $1',
      [result.rows[0].id]
    );

    assert.equal(verify.rows[0].text, ruleText);
    assert.equal(verify.rows[0].category, 'mechanics');
    assert.equal(verify.rows[0].game_id, gameId);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2: Rules appear in game state for injection into prompts
  // ─────────────────────────────────────────────────────────────────────────────

  it('retrieves all rules for game for prompt injection', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();
    const userId = crypto.randomUUID();

    // Create game and user
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Test Game', 'dnd5e']
    );

    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [userId, `user@test.com`, 'email']
    );

    // Add three rules
    const rules = [
      'Inspiration can be used twice per rest.',
      'Crits on 18+ (not just 20).',
      'Long rests take 6 hours, not 8.',
    ];

    for (const ruleText of rules) {
      await testDb.query(
        `INSERT INTO rules_corrections
         (game_id, text, category, created_by_user_id, game_system)
         VALUES ($1, $2, $3, $4, $5)`,
        [gameId, ruleText, 'mechanics', userId, 'dnd5e']
      );
    }

    // Retrieve all rules for game
    const result = await testDb.query(
      'SELECT text FROM rules_corrections WHERE game_id = $1 ORDER BY id',
      [gameId]
    );

    assert.equal(result.rows.length, 3, 'should retrieve all 3 rules');
    assert.equal(result.rows[0].text, rules[0]);
    assert.equal(result.rows[1].text, rules[1]);
    assert.equal(result.rows[2].text, rules[2]);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3: Multiple rules all included in single prompt injection string
  // ─────────────────────────────────────────────────────────────────────────────

  it('concatenates multiple rules into a single injection string', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();
    const userId = crypto.randomUUID();

    // Setup
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Test Game', 'dnd5e']
    );

    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [userId, `user@test.com`, 'email']
    );

    // Add rules
    const rules = [
      'Inspiration can be used twice per rest.',
      'Crits on 18+ (not just 20).',
    ];

    for (const ruleText of rules) {
      await testDb.query(
        `INSERT INTO rules_corrections
         (game_id, text, category, created_by_user_id, game_system)
         VALUES ($1, $2, $3, $4, $5)`,
        [gameId, ruleText, 'mechanics', userId, 'dnd5e']
      );
    }

    // Retrieve and concatenate as server would
    const result = await testDb.query(
      'SELECT text FROM rules_corrections WHERE game_id = $1 ORDER BY id',
      [gameId]
    );

    const injectionText = result.rows.map(r => r.text).join('\n');

    // Verify both rules are in injection string
    assert.ok(injectionText.includes('Inspiration can be used twice per rest.'));
    assert.ok(injectionText.includes('Crits on 18+'));
    assert.equal(injectionText.split('\n').length, 2);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4: Rules persist to DB and reload
  // ─────────────────────────────────────────────────────────────────────────────

  it('rules persist to DB and reload with exact text match', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const ruleText = 'When you roll a 1 on an attack, you must roll again and use the lower result.';

    // Setup
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Test Game', 'dnd5e']
    );

    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [userId, `user@test.com`, 'email']
    );

    // Insert rule
    await testDb.query(
      `INSERT INTO rules_corrections
       (game_id, text, category, created_by_user_id, game_system)
       VALUES ($1, $2, $3, $4, $5)`,
      [gameId, ruleText, 'mechanics', userId, 'dnd5e']
    );

    // Simulate game restart — fetch fresh from DB
    const result = await testDb.query(
      'SELECT text FROM rules_corrections WHERE game_id = $1',
      [gameId]
    );

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].text, ruleText, 'rule text should match exactly after reload');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 5: Master rules filter by game_system
  // ─────────────────────────────────────────────────────────────────────────────

  it('master rules filter by game system (dnd5e vs runequest)', async () => {
    if (skipTests) return;
    // Create master rules for different systems
    const dnd5eRuleId = 1; // Will be auto-assigned
    const rqRuleId = 2;

    // DnD 5e master rule
    await testDb.query(
      `INSERT INTO rules_corrections
       (game_id, text, is_master, is_private, game_system)
       VALUES (NULL, $1, true, false, $2)`,
      ['Inspiration: extra use per rest', 'dnd5e']
    );

    // RuneQuest master rule
    await testDb.query(
      `INSERT INTO rules_corrections
       (game_id, text, is_master, is_private, game_system)
       VALUES (NULL, $1, true, false, $2)`,
      ['Rune points double on crits', 'runequest']
    );

    // Universal rule
    await testDb.query(
      `INSERT INTO rules_corrections
       (game_id, text, is_master, is_private, game_system)
       VALUES (NULL, $1, true, false, $2)`,
      ['Characters can always try creative solutions', 'all']
    );

    // Query rules for DnD 5e game
    const dnd5eRules = await testDb.query(
      `SELECT text FROM rules_corrections
       WHERE is_master = true AND (game_system = $1 OR game_system = $2)
       ORDER BY text`,
      ['dnd5e', 'all']
    );

    // Query rules for RuneQuest game
    const rqRules = await testDb.query(
      `SELECT text FROM rules_corrections
       WHERE is_master = true AND (game_system = $1 OR game_system = $2)
       ORDER BY text`,
      ['runequest', 'all']
    );

    // DnD5e should get dnd5e + all
    assert.equal(dnd5eRules.rows.length, 2);
    assert.ok(dnd5eRules.rows.some(r => r.text.includes('Inspiration')));
    assert.ok(dnd5eRules.rows.some(r => r.text.includes('creative solutions')));

    // RuneQuest should get runequest + all
    assert.equal(rqRules.rows.length, 2);
    assert.ok(rqRules.rows.some(r => r.text.includes('Rune points')));
    assert.ok(rqRules.rows.some(r => r.text.includes('creative solutions')));
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 6: Private rules visible only to creator's games
  // ─────────────────────────────────────────────────────────────────────────────

  it('private rules visible only in creator game, not other games', async () => {
    if (skipTests) return;
    const userId1 = crypto.randomUUID();
    const userId2 = crypto.randomUUID();
    const game1Id = crypto.randomUUID();
    const game2Id = crypto.randomUUID();

    // Create users and games
    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [userId1, `user1@test.com`, 'email']
    );

    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [userId2, `user2@test.com`, 'email']
    );

    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [game1Id, 'User1 Game', 'dnd5e']
    );

    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [game2Id, 'User2 Game', 'dnd5e']
    );

    // User1 creates private rule in their game
    await testDb.query(
      `INSERT INTO rules_corrections
       (game_id, text, is_private, created_by_user_id, game_system)
       VALUES ($1, $2, true, $3, $4)`,
      [game1Id, 'Secret house rule for User1 only', userId1, 'dnd5e']
    );

    // Query rules visible to game 1 (should include private rule)
    const game1Rules = await testDb.query(
      `SELECT text FROM rules_corrections WHERE game_id = $1`,
      [game1Id]
    );

    // Query rules visible to game 2 (should NOT include private rule)
    const game2Rules = await testDb.query(
      `SELECT text FROM rules_corrections WHERE game_id = $1`,
      [game2Id]
    );

    assert.equal(game1Rules.rows.length, 1, 'game1 should have private rule');
    assert.equal(game2Rules.rows.length, 0, 'game2 should not see private rule');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 7: Rule copy tracks original_rule_id
  // ─────────────────────────────────────────────────────────────────────────────

  it('copying rule tracks original_rule_id for attribution', async () => {
    if (skipTests) return;
    const gameId1 = crypto.randomUUID();
    const gameId2 = crypto.randomUUID();
    const userId = crypto.randomUUID();

    // Setup
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId1, 'Source Game', 'dnd5e']
    );

    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId2, 'Target Game', 'dnd5e']
    );

    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [userId, `user@test.com`, 'email']
    );

    // Create original rule
    const origResult = await testDb.query(
      `INSERT INTO rules_corrections
       (game_id, text, created_by_user_id, game_system)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [gameId1, 'Inspiration can be used twice per rest', userId, 'dnd5e']
    );

    const originalRuleId = origResult.rows[0].id;

    // Copy rule to another game
    await testDb.query(
      `INSERT INTO rules_corrections
       (game_id, text, created_by_user_id, original_rule_id, game_system)
       VALUES ($1, $2, $3, $4, $5)`,
      [gameId2, 'Inspiration can be used twice per rest', userId, originalRuleId, 'dnd5e']
    );

    // Verify copy tracks original
    const copiedRule = await testDb.query(
      'SELECT text, original_rule_id FROM rules_corrections WHERE game_id = $1 ORDER BY id DESC LIMIT 1',
      [gameId2]
    );

    assert.equal(copiedRule.rows[0].original_rule_id, originalRuleId);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 8: Update rule text
  // ─────────────────────────────────────────────────────────────────────────────

  it('updates rule text and persists change', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();
    const userId = crypto.randomUUID();

    // Setup
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Test Game', 'dnd5e']
    );

    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [userId, `user@test.com`, 'email']
    );

    // Create rule
    const result = await testDb.query(
      `INSERT INTO rules_corrections
       (game_id, text, created_by_user_id, game_system)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [gameId, 'Original text', userId, 'dnd5e']
    );

    const ruleId = result.rows[0].id;

    // Update rule
    const updatedText = 'Updated text with more detail';
    await testDb.query(
      'UPDATE rules_corrections SET text = $1 WHERE id = $2',
      [updatedText, ruleId]
    );

    // Verify update
    const verify = await testDb.query(
      'SELECT text FROM rules_corrections WHERE id = $1',
      [ruleId]
    );

    assert.equal(verify.rows[0].text, updatedText);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 9: Delete rule
  // ─────────────────────────────────────────────────────────────────────────────

  it('deletes rule and it no longer appears in game rules', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();
    const userId = crypto.randomUUID();

    // Setup
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Test Game', 'dnd5e']
    );

    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [userId, `user@test.com`, 'email']
    );

    // Create two rules
    const r1 = await testDb.query(
      `INSERT INTO rules_corrections
       (game_id, text, created_by_user_id, game_system)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [gameId, 'Rule 1', userId, 'dnd5e']
    );

    const r2 = await testDb.query(
      `INSERT INTO rules_corrections
       (game_id, text, created_by_user_id, game_system)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [gameId, 'Rule 2', userId, 'dnd5e']
    );

    const ruleId1 = r1.rows[0].id;
    const ruleId2 = r2.rows[0].id;

    // Verify both exist
    let rules = await testDb.query(
      'SELECT id FROM rules_corrections WHERE game_id = $1 ORDER BY id',
      [gameId]
    );
    assert.equal(rules.rows.length, 2);

    // Delete rule 1
    await testDb.query(
      'DELETE FROM rules_corrections WHERE id = $1',
      [ruleId1]
    );

    // Verify only rule 2 remains
    rules = await testDb.query(
      'SELECT id, text FROM rules_corrections WHERE game_id = $1',
      [gameId]
    );

    assert.equal(rules.rows.length, 1);
    assert.equal(rules.rows[0].id, ruleId2);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 10: All rules for game (game-specific + master + universal)
  // ─────────────────────────────────────────────────────────────────────────────

  it('retrieves all applicable rules (game-specific + master + universal)', async () => {
    if (skipTests) return;
    const gameId = crypto.randomUUID();
    const userId = crypto.randomUUID();

    // Setup
    await testDb.query(
      `INSERT INTO games (id, name, system) VALUES ($1, $2, $3)`,
      [gameId, 'Test Game', 'dnd5e']
    );

    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [userId, `user@test.com`, 'email']
    );

    // Add game-specific rule
    await testDb.query(
      `INSERT INTO rules_corrections
       (game_id, text, created_by_user_id, game_system)
       VALUES ($1, $2, $3, $4)`,
      [gameId, 'Game-specific rule', userId, 'dnd5e']
    );

    // Add master dnd5e rule
    await testDb.query(
      `INSERT INTO rules_corrections
       (game_id, text, is_master, game_system)
       VALUES (NULL, $1, true, $2)`,
      ['Master dnd5e rule', 'dnd5e']
    );

    // Add universal master rule
    await testDb.query(
      `INSERT INTO rules_corrections
       (game_id, text, is_master, game_system)
       VALUES (NULL, $1, true, $2)`,
      ['Universal rule', 'all']
    );

    // Retrieve all rules applicable to this game
    const result = await testDb.query(
      `SELECT text FROM rules_corrections
       WHERE game_id = $1 OR (is_master = true AND (game_system = $2 OR game_system = $3))
       ORDER BY text`,
      [gameId, 'dnd5e', 'all']
    );

    assert.equal(result.rows.length, 3, 'should get game-specific + 2 master rules');
    const texts = result.rows.map(r => r.text);
    assert.ok(texts.includes('Game-specific rule'));
    assert.ok(texts.includes('Master dnd5e rule'));
    assert.ok(texts.includes('Universal rule'));
  });
});
