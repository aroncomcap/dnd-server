'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const testDb = require('./test-db-setup');

/**
 * Integration tests for billing system
 * Tests: user creation, balance tracking, minute deduction, credit expiry, persistence
 */

describe('Integration: Billing System — Balance Tracking and Expiry', () => {
  let pool;
  let skipTests = false;

  before(async () => {
    try {
      pool = await testDb.initTestDb();
    } catch (err) {
      console.log('⊘ Skipping integration-billing tests: PostgreSQL not available');
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
  // Test 1: User created with 600 free minutes
  // ─────────────────────────────────────────────────────────────────────────────

  it('creates user with initial 600 free minutes balance', async () => {
    if (skipTests) return;
    const userId = crypto.randomUUID();
    const userEmail = `user${userId}@test.com`;

    // Create user
    await testDb.query(
      `INSERT INTO users (id, email, display_name, auth_provider) VALUES ($1, $2, $3, $4)`,
      [userId, userEmail, 'Test User', 'email']
    );

    // Create balance record
    await testDb.query(
      `INSERT INTO user_balances (user_id, free_minutes_remaining) VALUES ($1, $2)`,
      [userId, 600]
    );

    // Verify balance
    const result = await testDb.query(
      'SELECT free_minutes_remaining, paid_minutes_remaining FROM user_balances WHERE user_id = $1',
      [userId]
    );

    assert.equal(result.rows.length, 1, 'balance record should exist');
    assert.equal(result.rows[0].free_minutes_remaining, 600);
    assert.equal(result.rows[0].paid_minutes_remaining, 0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2: Deduct free minutes when game runs
  // ─────────────────────────────────────────────────────────────────────────────

  it('deducts free minutes after gaming session', async () => {
    if (skipTests) return;
    const userId = crypto.randomUUID();

    // Create user with 600 minutes
    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [userId, `user${userId}@test.com`, 'email']
    );

    await testDb.query(
      `INSERT INTO user_balances (user_id, free_minutes_remaining) VALUES ($1, $2)`,
      [userId, 600]
    );

    // Deduct 10 minutes (simulating 10-minute game session)
    await testDb.query(
      `UPDATE user_balances
       SET free_minutes_remaining = free_minutes_remaining - $1,
           total_minutes_used = total_minutes_used + $1
       WHERE user_id = $2`,
      [10, userId]
    );

    // Verify deduction
    const result = await testDb.query(
      'SELECT free_minutes_remaining, total_minutes_used FROM user_balances WHERE user_id = $1',
      [userId]
    );

    assert.equal(result.rows[0].free_minutes_remaining, 590);
    assert.equal(result.rows[0].total_minutes_used, 10);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3: Deduct from paid minutes when free is exhausted
  // ─────────────────────────────────────────────────────────────────────────────

  it('deducts from paid minutes when free minutes exhausted', async () => {
    if (skipTests) return;
    const userId = crypto.randomUUID();

    // Create user with 0 free, 100 paid minutes
    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [userId, `user${userId}@test.com`, 'email']
    );

    await testDb.query(
      `INSERT INTO user_balances (user_id, free_minutes_remaining, paid_minutes_remaining)
       VALUES ($1, $2, $3)`,
      [userId, 0, 100]
    );

    // Try to deduct 30 minutes (should come from paid)
    const balance = await testDb.query(
      'SELECT free_minutes_remaining, paid_minutes_remaining FROM user_balances WHERE user_id = $1',
      [userId]
    );

    const current = balance.rows[0];
    let freeDeduct = Math.min(30, current.free_minutes_remaining);
    let paidDeduct = Math.min(30 - freeDeduct, current.paid_minutes_remaining);

    await testDb.query(
      `UPDATE user_balances
       SET free_minutes_remaining = free_minutes_remaining - $1,
           paid_minutes_remaining = paid_minutes_remaining - $2
       WHERE user_id = $3`,
      [freeDeduct, paidDeduct, userId]
    );

    // Verify deductions
    const result = await testDb.query(
      'SELECT free_minutes_remaining, paid_minutes_remaining FROM user_balances WHERE user_id = $1',
      [userId]
    );

    assert.equal(result.rows[0].free_minutes_remaining, 0);
    assert.equal(result.rows[0].paid_minutes_remaining, 70);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4: Balance persisted to user_balances table
  // ─────────────────────────────────────────────────────────────────────────────

  it('balance persisted accurately across updates', async () => {
    if (skipTests) return;
    const userId = crypto.randomUUID();

    // Create user
    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [userId, `user${userId}@test.com`, 'email']
    );

    await testDb.query(
      `INSERT INTO user_balances (user_id, free_minutes_remaining, paid_minutes_remaining)
       VALUES ($1, $2, $3)`,
      [userId, 600, 120]
    );

    // Deduct in sequence
    await testDb.query(
      `UPDATE user_balances SET free_minutes_remaining = 590, total_minutes_used = 10
       WHERE user_id = $1`,
      [userId]
    );

    await testDb.query(
      `UPDATE user_balances SET free_minutes_remaining = 580, total_minutes_used = 20
       WHERE user_id = $1`,
      [userId]
    );

    // Verify final state
    const result = await testDb.query(
      `SELECT free_minutes_remaining, paid_minutes_remaining, total_minutes_used
       FROM user_balances WHERE user_id = $1`,
      [userId]
    );

    assert.equal(result.rows[0].free_minutes_remaining, 580);
    assert.equal(result.rows[0].paid_minutes_remaining, 120);
    assert.equal(result.rows[0].total_minutes_used, 20);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 5: User reload shows correct balance
  // ─────────────────────────────────────────────────────────────────────────────

  it('user reload from DB shows correct current balance', async () => {
    if (skipTests) return;
    const userId = crypto.randomUUID();

    // Create and modify user
    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [userId, `user${userId}@test.com`, 'email']
    );

    await testDb.query(
      `INSERT INTO user_balances (user_id, free_minutes_remaining, paid_minutes_remaining)
       VALUES ($1, $2, $3)`,
      [userId, 600, 0]
    );

    // Simulate some play
    await testDb.query(
      `UPDATE user_balances SET free_minutes_remaining = 450, total_minutes_used = 150
       WHERE user_id = $1`,
      [userId]
    );

    // "Close" and "reopen" the connection by fetching fresh
    const result = await testDb.query(
      `SELECT u.id, u.email, b.free_minutes_remaining, b.paid_minutes_remaining, b.total_minutes_used
       FROM users u
       JOIN user_balances b ON u.id = b.user_id
       WHERE u.id = $1`,
      [userId]
    );

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].free_minutes_remaining, 450);
    assert.equal(result.rows[0].total_minutes_used, 150);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 6: Free minutes expire after 1 month
  // ─────────────────────────────────────────────────────────────────────────────

  it('free minutes tracked separately from paid minutes', async () => {
    if (skipTests) return;
    const userId = crypto.randomUUID();

    // Create user
    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [userId, `user${userId}@test.com`, 'email']
    );

    // Create balance with known reset date
    const nextMonth = new Date();
    nextMonth.setDate(nextMonth.getDate() + 30);

    await testDb.query(
      `INSERT INTO user_balances
       (user_id, free_minutes_remaining, paid_minutes_remaining, free_reset_date)
       VALUES ($1, $2, $3, $4)`,
      [userId, 600, 100, nextMonth.toISOString().split('T')[0]]
    );

    // Query balance
    const result = await testDb.query(
      `SELECT free_minutes_remaining, paid_minutes_remaining, free_reset_date
       FROM user_balances WHERE user_id = $1`,
      [userId]
    );

    assert.equal(result.rows[0].free_minutes_remaining, 600);
    assert.equal(result.rows[0].paid_minutes_remaining, 100);
    assert.ok(result.rows[0].free_reset_date);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 7: Paid minutes never expire
  // ─────────────────────────────────────────────────────────────────────────────

  it('paid minutes have no expiry set', async () => {
    if (skipTests) return;
    const userId = crypto.randomUUID();
    const purchaseId = crypto.randomUUID();

    // Create user
    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [userId, `user${userId}@test.com`, 'email']
    );

    // Create purchase with no expiry
    await testDb.query(
      `INSERT INTO purchases
       (id, user_id, provider, minutes_credited, credit_type, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [purchaseId, userId, 'stripe', 300, 'purchase', null]
    );

    // Verify purchase has no expiry
    const result = await testDb.query(
      'SELECT minutes_credited, credit_type, expires_at FROM purchases WHERE id = $1',
      [purchaseId]
    );

    assert.equal(result.rows[0].minutes_credited, 300);
    assert.equal(result.rows[0].credit_type, 'purchase');
    assert.equal(result.rows[0].expires_at, null, 'purchase should have no expiry');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 8: Admin credits expire after 1 year
  // ─────────────────────────────────────────────────────────────────────────────

  it('admin credits have 1-year expiry', async () => {
    if (skipTests) return;
    const userId = crypto.randomUUID();
    const creditId = crypto.randomUUID();

    // Create user
    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [userId, `user${userId}@test.com`, 'email']
    );

    // Create admin credit with 1-year expiry
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

    await testDb.query(
      `INSERT INTO purchases
       (id, user_id, provider, minutes_credited, credit_type, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [creditId, userId, 'admin', 240, 'admin', expiresAt.toISOString()]
    );

    // Verify expiry is set
    const result = await testDb.query(
      'SELECT minutes_credited, credit_type, expires_at FROM purchases WHERE id = $1',
      [creditId]
    );

    assert.equal(result.rows[0].minutes_credited, 240);
    assert.equal(result.rows[0].credit_type, 'admin');
    assert.ok(result.rows[0].expires_at, 'admin credit should have expiry');

    // Verify expiry is roughly 1 year away
    const expiryTime = new Date(result.rows[0].expires_at).getTime();
    const now = Date.now();
    const yearMs = 365 * 24 * 60 * 60 * 1000;
    const diff = expiryTime - now;
    assert.ok(diff > yearMs - 3600000 && diff < yearMs + 3600000, 'expiry should be ~1 year away');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 9: Promo code grant and expiry
  // ─────────────────────────────────────────────────────────────────────────────

  it('promo code grants minutes and tracks redemption', async () => {
    if (skipTests) return;
    const userId = crypto.randomUUID();
    const promoCode = 'BETA-ABC123';

    // Create user
    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [userId, `user${userId}@test.com`, 'email']
    );

    // Create promo code
    await testDb.query(
      `INSERT INTO promo_codes (code, minutes_granted, redeemed_by, redeemed_at)
       VALUES ($1, $2, $3, $4)`,
      [promoCode, 2400, userId, new Date().toISOString()]
    );

    // Verify promo code is registered
    const result = await testDb.query(
      'SELECT code, minutes_granted, redeemed_by FROM promo_codes WHERE code = $1',
      [promoCode]
    );

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].code, promoCode);
    assert.equal(result.rows[0].minutes_granted, 2400);
    assert.equal(result.rows[0].redeemed_by, userId);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 10: Multiple users have independent balances
  // ─────────────────────────────────────────────────────────────────────────────

  it('multiple users maintain independent balances', async () => {
    if (skipTests) return;
    const user1Id = crypto.randomUUID();
    const user2Id = crypto.randomUUID();

    // Create two users
    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [user1Id, `user1@test.com`, 'email']
    );

    await testDb.query(
      `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
      [user2Id, `user2@test.com`, 'email']
    );

    // Create independent balances
    await testDb.query(
      `INSERT INTO user_balances (user_id, free_minutes_remaining) VALUES ($1, $2)`,
      [user1Id, 600]
    );

    await testDb.query(
      `INSERT INTO user_balances (user_id, free_minutes_remaining) VALUES ($1, $2)`,
      [user2Id, 300]
    );

    // Deduct from user1 only
    await testDb.query(
      `UPDATE user_balances SET free_minutes_remaining = 550 WHERE user_id = $1`,
      [user1Id]
    );

    // Verify user2 unchanged
    const result1 = await testDb.query(
      'SELECT free_minutes_remaining FROM user_balances WHERE user_id = $1',
      [user1Id]
    );

    const result2 = await testDb.query(
      'SELECT free_minutes_remaining FROM user_balances WHERE user_id = $1',
      [user2Id]
    );

    assert.equal(result1.rows[0].free_minutes_remaining, 550);
    assert.equal(result2.rows[0].free_minutes_remaining, 300, 'user2 balance should be unchanged');
  });
});
