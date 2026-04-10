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
};
