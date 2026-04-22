'use strict';

const { Pool } = require('pg');

/**
 * Test database setup helper
 * Provides isolated test database with automatic schema initialization and cleanup
 */

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/tavern_test';

let pool = null;

/**
 * Initialize test database pool and create schema
 */
async function initTestDb() {
  pool = new Pool({
    connectionString: TEST_DB_URL,
    ssl: TEST_DB_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
  });

  try {
    // Test connection first
    const client = await pool.connect();
    client.release();

    // Create all required tables
    await createSchema();
    return pool;
  } catch (err) {
    await pool.end();
    throw new Error(`Test database unavailable at ${TEST_DB_URL}: ${err.message}`);
  }
}

/**
 * Create database schema for tests
 */
async function createSchema() {
  if (!pool) throw new Error('Pool not initialized');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      system TEXT NOT NULL DEFAULT 'dnd5e',
      custom_context TEXT DEFAULT '',
      image_style TEXT DEFAULT 'fantasy illustration',
      model TEXT DEFAULT 'claude-haiku-4-5-20251001',
      billing_mode TEXT DEFAULT 'host_pays',
      host_user_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS characters (
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (game_id, name)
    );

    CREATE TABLE IF NOT EXISTS game_state (
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (game_id, key)
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      password_hash TEXT,
      display_name TEXT,
      auth_provider TEXT NOT NULL DEFAULT 'email',
      auth_provider_id TEXT,
      is_admin BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_balances (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      free_minutes_remaining INT DEFAULT 600,
      paid_minutes_remaining INT DEFAULT 0,
      free_reset_date DATE DEFAULT (DATE_TRUNC('month', NOW()) + INTERVAL '1 month')::DATE,
      total_minutes_used INT DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_tx_id TEXT,
      product_id TEXT,
      minutes_credited INT NOT NULL,
      amount_cents INT DEFAULT 0,
      credit_type TEXT DEFAULT 'purchase',
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rules_corrections (
      id SERIAL PRIMARY KEY,
      game_id TEXT REFERENCES games(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      category TEXT,
      is_private BOOLEAN DEFAULT FALSE,
      is_master BOOLEAN DEFAULT FALSE,
      created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      original_rule_id INT,
      game_system TEXT DEFAULT 'dnd5e',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (original_rule_id) REFERENCES rules_corrections(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS channel_links (
      channel_id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS promo_codes (
      code TEXT PRIMARY KEY,
      minutes_granted INT DEFAULT 2400,
      redeemed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      redeemed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

/**
 * Clear all data from test tables
 */
async function clearTestData() {
  if (!pool) throw new Error('Pool not initialized');

  const tables = [
    'channel_links',
    'promo_codes',
    'purchases',
    'user_balances',
    'rules_corrections',
    'game_state',
    'characters',
    'games',
    'users'
  ];

  for (const table of tables) {
    await pool.query(`TRUNCATE TABLE ${table} CASCADE`);
  }
}

/**
 * Drop all test tables (used in teardown)
 */
async function dropSchema() {
  if (!pool) throw new Error('Pool not initialized');

  const tables = [
    'channel_links',
    'promo_codes',
    'purchases',
    'user_balances',
    'rules_corrections',
    'game_state',
    'characters',
    'games',
    'users'
  ];

  for (const table of tables) {
    await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
}

/**
 * Close database connection pool
 */
async function closeTestDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Get the pool (for direct queries if needed)
 */
function getPool() {
  if (!pool) throw new Error('Pool not initialized. Call initTestDb first.');
  return pool;
}

/**
 * Execute a single query and return results
 */
async function query(sql, params = []) {
  const pool = getPool();
  return pool.query(sql, params);
}

module.exports = {
  initTestDb,
  clearTestData,
  dropSchema,
  closeTestDb,
  getPool,
  query,
  createSchema,
};
