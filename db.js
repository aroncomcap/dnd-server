const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ── Schema ───────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS characters (
      name TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS game_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// ── Characters ───────────────────────────────────────────────────────────────
async function getCharacters() {
  const { rows } = await pool.query('SELECT name, data FROM characters ORDER BY created_at');
  const chars = {};
  for (const row of rows) chars[row.name] = row.data;
  return chars;
}

async function upsertCharacter(name, data) {
  await pool.query(
    `INSERT INTO characters (name, data, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (name) DO UPDATE SET data = $2, updated_at = NOW()`,
    [name, JSON.stringify(data)]
  );
}

// ── Game State (key-value) ───────────────────────────────────────────────────
async function getState(key, defaultValue = null) {
  const { rows } = await pool.query('SELECT value FROM game_state WHERE key = $1', [key]);
  return rows.length ? rows[0].value : defaultValue;
}

async function setState(key, value) {
  await pool.query(
    `INSERT INTO game_state (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

// ── Load all game data (for boot) ────────────────────────────────────────────
async function loadGameData() {
  const characters = await getCharacters();
  const chatHistory = await getState('chatHistory', []);
  const currentTurnIndex = await getState('currentTurnIndex', 0);
  const turnOrder = await getState('turnOrder', []);
  return { characters, chatHistory, currentTurnIndex, turnOrder };
}

// ── Save helpers ─────────────────────────────────────────────────────────────
async function saveChatHistory(chatHistory) {
  await setState('chatHistory', chatHistory);
}

async function saveTurnState(currentTurnIndex, turnOrder) {
  await setState('currentTurnIndex', currentTurnIndex);
  await setState('turnOrder', turnOrder);
}

module.exports = {
  pool,
  initDB,
  getCharacters,
  upsertCharacter,
  getState,
  setState,
  loadGameData,
  saveChatHistory,
  saveTurnState,
};
