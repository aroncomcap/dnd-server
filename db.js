const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ── Schema ───────────────────────────────────────────────────────────────────
async function initDB() {
  // Drop old single-game tables and recreate with multi-game schema
  const { rows } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'characters' AND column_name = 'game_id'
  `);

  if (!rows.length) {
    // Old schema exists — drop and recreate
    await pool.query(`
      DROP TABLE IF EXISTS game_state CASCADE;
      DROP TABLE IF EXISTS characters CASCADE;
    `);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      system TEXT NOT NULL DEFAULT 'dnd5e',
      custom_context TEXT DEFAULT '',
      image_style TEXT DEFAULT 'fantasy illustration',
      model TEXT DEFAULT 'claude-haiku-4-5-20251001',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Add model column if upgrading from older schema
    ALTER TABLE games ADD COLUMN IF NOT EXISTS model TEXT DEFAULT 'claude-haiku-4-5-20251001';
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
    CREATE TABLE IF NOT EXISTS channel_links (
      channel_id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ── Billing tables ──────────────────────────────────────────
  await pool.query(`
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
      free_minutes_remaining INT DEFAULT 300,
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

    CREATE TABLE IF NOT EXISTS promo_codes (
      code TEXT PRIMARY KEY,
      minutes_granted INT DEFAULT 2400,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      redeemed_by TEXT REFERENCES users(id),
      redeemed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ
    );

    -- Add billing columns to games table
    ALTER TABLE games ADD COLUMN IF NOT EXISTS billing_mode TEXT DEFAULT 'host_pays';
    ALTER TABLE games ADD COLUMN IF NOT EXISTS host_user_id TEXT;
  `);
}

// ── Games ────────────────────────────────────────────────────────────────────
async function createGame(id, name, system, customContext = '') {
  await pool.query(
    `INSERT INTO games (id, name, system, custom_context) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET name = $2, system = $3, custom_context = $4`,
    [id, name, system, customContext]
  );
}

async function getGame(id) {
  const { rows } = await pool.query('SELECT * FROM games WHERE id = $1', [id]);
  return rows[0] || null;
}

async function listGames() {
  const { rows } = await pool.query(
    'SELECT id, name, system, created_at FROM games ORDER BY created_at DESC'
  );
  return rows;
}

async function updateGameContext(gameId, context) {
  await pool.query(
    'UPDATE games SET custom_context = $2 WHERE id = $1',
    [gameId, context]
  );
}

async function deleteGame(id) {
  await pool.query('DELETE FROM games WHERE id = $1', [id]);
}

// ── Characters ───────────────────────────────────────────────────────────────
async function getCharacters(gameId) {
  const { rows } = await pool.query(
    'SELECT name, data FROM characters WHERE game_id = $1 ORDER BY created_at',
    [gameId]
  );
  const chars = {};
  for (const row of rows) chars[row.name] = row.data;
  return chars;
}

async function upsertCharacter(gameId, name, data) {
  await pool.query(
    `INSERT INTO characters (game_id, name, data, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (game_id, name) DO UPDATE SET data = $3, updated_at = NOW()`,
    [gameId, name, JSON.stringify(data)]
  );
}

// ── Game State (key-value, scoped per game) ──────────────────────────────────
async function getState(gameId, key, defaultValue = null) {
  const { rows } = await pool.query(
    'SELECT value FROM game_state WHERE game_id = $1 AND key = $2',
    [gameId, key]
  );
  return rows.length ? rows[0].value : defaultValue;
}

async function setState(gameId, key, value) {
  await pool.query(
    `INSERT INTO game_state (game_id, key, value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (game_id, key) DO UPDATE SET value = $3, updated_at = NOW()`,
    [gameId, key, JSON.stringify(value)]
  );
}

// ── Load all game data ───────────────────────────────────────────────────────
async function loadGameData(gameId) {
  const characters = await getCharacters(gameId);
  const chatHistory = await getState(gameId, 'chatHistory', []);
  const currentTurnIndex = await getState(gameId, 'currentTurnIndex', 0);
  const turnOrder = await getState(gameId, 'turnOrder', []);
  return { characters, chatHistory, currentTurnIndex, turnOrder };
}

// ── Save helpers ─────────────────────────────────────────────────────────────
async function saveChatHistory(gameId, chatHistory) {
  await setState(gameId, 'chatHistory', chatHistory);
}

async function saveTurnState(gameId, currentTurnIndex, turnOrder) {
  await setState(gameId, 'currentTurnIndex', currentTurnIndex);
  await setState(gameId, 'turnOrder', turnOrder);
}

// ── Channel Links ────────────────────────────────────────────────────────────
async function linkChannel(channelId, guildId, gameId) {
  await pool.query(
    `INSERT INTO channel_links (channel_id, guild_id, game_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (channel_id) DO UPDATE SET game_id = $3, guild_id = $2`,
    [channelId, guildId, gameId]
  );
}

async function getChannelGame(channelId) {
  const { rows } = await pool.query(
    'SELECT game_id FROM channel_links WHERE channel_id = $1', [channelId]
  );
  return rows[0]?.game_id || null;
}

async function getGameChannels(gameId) {
  const { rows } = await pool.query(
    'SELECT channel_id FROM channel_links WHERE game_id = $1', [gameId]
  );
  return rows.map(r => r.channel_id);
}

// ── Users ─────────────────────────────────────────────────────────────────────
async function createUser({ id, email, passwordHash, displayName, authProvider, authProviderId }) {
  await pool.query(
    `INSERT INTO users (id, email, password_hash, display_name, auth_provider, auth_provider_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (email) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, users.display_name),
       auth_provider = EXCLUDED.auth_provider,
       auth_provider_id = EXCLUDED.auth_provider_id`,
    [id, email, passwordHash, displayName, authProvider, authProviderId]
  );
  // Create balance row if not exists
  await pool.query(
    `INSERT INTO user_balances (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [id]
  );
  // First user becomes admin
  const { rows } = await pool.query('SELECT COUNT(*) as cnt FROM users');
  if (parseInt(rows[0].cnt) === 1) {
    await pool.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [id]);
  }
}

async function getUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getUserByProvider(provider, providerId) {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE auth_provider = $1 AND auth_provider_id = $2',
    [provider, providerId]
  );
  return rows[0] || null;
}

async function getUserBalance(userId) {
  const { rows } = await pool.query('SELECT * FROM user_balances WHERE user_id = $1', [userId]);
  return rows[0] || null;
}

async function deductMinutes(userId, minutes) {
  // Deduct free minutes first, then paid
  const balance = await getUserBalance(userId);
  if (!balance) return null;

  let remaining = minutes;
  let freeDeduct = Math.min(remaining, balance.free_minutes_remaining);
  remaining -= freeDeduct;
  let paidDeduct = Math.min(remaining, balance.paid_minutes_remaining);

  await pool.query(
    `UPDATE user_balances SET
       free_minutes_remaining = free_minutes_remaining - $2,
       paid_minutes_remaining = paid_minutes_remaining - $3,
       total_minutes_used = total_minutes_used + $4
     WHERE user_id = $1`,
    [userId, freeDeduct, paidDeduct, freeDeduct + paidDeduct]
  );
  return { freeDeducted: freeDeduct, paidDeducted: paidDeduct, totalDeducted: freeDeduct + paidDeduct };
}

async function creditMinutes(userId, minutes, { provider = 'admin', providerTxId = null, productId = null, amountCents = 0, creditType = 'admin', expiresAt = null } = {}) {
  const id = crypto.randomUUID();
  if (!expiresAt && (creditType === 'admin' || creditType === 'promo')) {
    expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year
  }
  await pool.query(
    `INSERT INTO purchases (id, user_id, provider, provider_tx_id, product_id, minutes_credited, amount_cents, credit_type, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, userId, provider, providerTxId, productId, minutes, amountCents, creditType, expiresAt]
  );
  await pool.query(
    `UPDATE user_balances SET paid_minutes_remaining = paid_minutes_remaining + $2 WHERE user_id = $1`,
    [userId, minutes]
  );
}

async function resetFreeMinutes() {
  // Called monthly — resets all users' free minutes
  await pool.query(
    `UPDATE user_balances
     SET free_minutes_remaining = 300,
         free_reset_date = (DATE_TRUNC('month', NOW()) + INTERVAL '1 month')::DATE
     WHERE free_reset_date <= CURRENT_DATE`
  );
}

async function listUsers() {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.auth_provider, u.is_admin, u.created_at,
            b.free_minutes_remaining, b.paid_minutes_remaining, b.total_minutes_used
     FROM users u LEFT JOIN user_balances b ON u.id = b.user_id
     ORDER BY u.created_at DESC`
  );
  return rows;
}

module.exports = {
  pool,
  initDB,
  createGame,
  getGame,
  listGames,
  updateGameContext,
  deleteGame,
  getCharacters,
  upsertCharacter,
  getState,
  setState,
  loadGameData,
  saveChatHistory,
  linkChannel,
  getChannelGame,
  getGameChannels,
  saveTurnState,
  createUser,
  getUserByEmail,
  getUserById,
  getUserByProvider,
  getUserBalance,
  deductMinutes,
  creditMinutes,
  resetFreeMinutes,
  listUsers,
};
