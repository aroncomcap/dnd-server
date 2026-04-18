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

    ALTER TABLE users ADD COLUMN IF NOT EXISTS magic_link_nonce TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS has_password BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_nonce TEXT;

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
    ALTER TABLE games ADD COLUMN IF NOT EXISTS last_image_url TEXT;
  `);

  // ── Rules Corrections table ──────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rules_corrections (
      id SERIAL PRIMARY KEY,
      game_id TEXT REFERENCES games(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE rules_corrections ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT false;
    ALTER TABLE rules_corrections ADD COLUMN IF NOT EXISTS is_master BOOLEAN DEFAULT false;
    ALTER TABLE rules_corrections ADD COLUMN IF NOT EXISTS created_by_user_id TEXT;
    ALTER TABLE rules_corrections ADD COLUMN IF NOT EXISTS original_rule_id INT;
    ALTER TABLE rules_corrections ADD COLUMN IF NOT EXISTS game_system TEXT DEFAULT 'dnd5e';
    CREATE INDEX IF NOT EXISTS idx_rules_shared ON rules_corrections (is_private, is_master, game_system) WHERE is_private = false AND is_master = true;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_master_text ON rules_corrections (text, game_system) WHERE is_master = true AND game_id IS NULL;
  `);

  // Seed common rules templates (one-time, skipped if exists)
  const templates = [
    { text: 'Natural 1 on attack rolls is always a miss, regardless of modifiers', category: 'combat', system: 'dnd5e' },
    { text: 'Critical hits deal maximum weapon damage plus rolled damage dice', category: 'combat', system: 'dnd5e' },
    { text: 'Potions can be consumed as a bonus action instead of a full action', category: 'combat', system: 'dnd5e' },
    { text: 'Flanking grants advantage on melee attack rolls', category: 'combat', system: 'dnd5e' },
    { text: 'Players can spend inspiration to reroll any single d20', category: 'general', system: 'dnd5e' },
    { text: 'Short rests are 10 minutes instead of 1 hour', category: 'pacing', system: 'dnd5e' },
    { text: 'No player-vs-player combat without mutual consent', category: 'social', system: 'all' },
    { text: 'Death saving throws are rolled privately by the DM', category: 'combat', system: 'dnd5e' },
    { text: 'Spell components are not tracked unless they have a gold cost', category: 'general', system: 'dnd5e' },
    { text: 'Characters can attempt to intimidate in combat as a bonus action (DC 12 + target CR)', category: 'combat', system: 'dnd5e' },
  ];

  for (const tmpl of templates) {
    await pool.query(
      'INSERT INTO rules_corrections (text, category, is_master, is_private, created_by_user_id, game_id, game_system, created_at) VALUES ($1, $2, true, false, NULL, NULL, $3, NOW()) ON CONFLICT (text, game_system) WHERE is_master = true AND game_id IS NULL DO NOTHING',
      [tmpl.text, tmpl.category, tmpl.system]
    );
  }

  // ── Feature Requests table ──────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feature_requests (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL UNIQUE,
      description TEXT,
      status TEXT DEFAULT 'proposed',
      priority TEXT DEFAULT 'medium',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Seed the streaming feature request if it doesn't exist
  await pool.query(`
    INSERT INTO feature_requests (title, description, status, priority)
    VALUES (
      'Streaming responses',
      'Stream Claude responses word-by-word for perceived speed improvement. Pros: feels faster, dramatic text reveal. Cons: OPTIONS/SCENE/WORLD blocks still wait for completion, more complex code, zero actual time savings. Thinking timer already provides feedback.',
      'deferred',
      'low'
    )
    ON CONFLICT (title) DO NOTHING;
  `);
  await pool.query(`
    INSERT INTO feature_requests (title, description, status, priority) VALUES
    ('DALL-E 3 for key moments', 'Use DALL-E 3 ($0.04/img) for killshots and boss introductions for higher quality dramatic images. Keep FLUX ($0.003/img) for routine scenes. ~$0.20/session extra for 3-4 key moments.', 'proposed', 'low'),
    ('img2img with character reference', 'When Together AI adds img2img support for FLUX.1-schnell, pass actual character token images as references for visual consistency. Currently using text visualDesc anchoring.', 'proposed', 'medium')
    ON CONFLICT (title) DO NOTHING;
  `);

  // ── Anonymous Sessions ──────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS anonymous_sessions (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      minutes_used INT DEFAULT 0,
      last_active TIMESTAMPTZ DEFAULT NOW(),
      converted_to_user_id TEXT REFERENCES users(id),
      ip_address TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_anon_sessions_ip ON anonymous_sessions(ip_address);
  `);

  // ── Monster Sources ─────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS monster_sources (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      name TEXT NOT NULL,
      system TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      game_id TEXT REFERENCES games(id) ON DELETE CASCADE,
      monsters JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS game_monster_sources (
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES monster_sources(id) ON DELETE CASCADE,
      priority INT NOT NULL DEFAULT 0,
      PRIMARY KEY (game_id, source_id)
    );
  `);

  // ── Monster Templates (cached narrative templates per monster × event × persona) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS monster_templates (
      id SERIAL PRIMARY KEY,
      monster_slug TEXT NOT NULL,
      event_type TEXT NOT NULL,
      persona TEXT NOT NULL DEFAULT 'epic',
      templates JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(monster_slug, event_type, persona)
    );
  `);

  // ── Killshots (Hall of Fame) ────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS killshots (
      id SERIAL PRIMARY KEY,
      game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
      game_name TEXT,
      character_name TEXT NOT NULL,
      player_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      enemy_name TEXT NOT NULL,
      moment_type TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      drama_score INT DEFAULT 5,
      game_system TEXT DEFAULT 'dnd5e',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_killshots_created ON killshots(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_killshots_drama ON killshots(drama_score DESC);
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
    'SELECT id, name, system, created_at, host_user_id, last_image_url FROM games ORDER BY created_at DESC'
  );
  return rows;
}

async function updateGameContext(gameId, context) {
  await pool.query(
    'UPDATE games SET custom_context = $2 WHERE id = $1',
    [gameId, context]
  );
}

async function updateGameImage(gameId, imageUrl) {
  await pool.query('UPDATE games SET last_image_url = $1 WHERE id = $2', [imageUrl, gameId]);
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
  // Create balance row if not exists — 600 free minutes welcome bonus (10 hours)
  await pool.query(
    `INSERT INTO user_balances (user_id, free_minutes_remaining) VALUES ($1, 600) ON CONFLICT (user_id) DO NOTHING`,
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

async function findOrCreateUserByEmail(email) {
  const normalized = email.toLowerCase().trim();
  let user = await getUserByEmail(normalized);
  if (!user) {
    const id = crypto.randomUUID();
    await createUser({
      id,
      email: normalized,
      passwordHash: null,
      displayName: normalized.split('@')[0],
      authProvider: 'magic-link',
      authProviderId: null,
    });
    user = await getUserById(id);
  }
  return user;
}

async function setMagicLinkNonce(userId, nonce) {
  await pool.query('UPDATE users SET magic_link_nonce = $1 WHERE id = $2', [nonce, userId]);
}

async function clearMagicLinkNonce(userId) {
  await pool.query('UPDATE users SET magic_link_nonce = NULL WHERE id = $1', [userId]);
}

async function setUserPassword(userId, passwordHash) {
  await pool.query('UPDATE users SET password_hash = $1, has_password = TRUE WHERE id = $2', [passwordHash, userId]);
}

async function setPasswordResetNonce(userId, nonce) {
  await pool.query('UPDATE users SET password_reset_nonce = $1 WHERE id = $2', [nonce, userId]);
}

async function clearPasswordResetNonce(userId) {
  await pool.query('UPDATE users SET password_reset_nonce = NULL WHERE id = $1', [userId]);
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

async function checkAndResetFree(userId) {
  const { rows } = await pool.query(
    `UPDATE user_balances
     SET free_minutes_remaining = 300,
         free_reset_date = (DATE_TRUNC('month', NOW()) + INTERVAL '1 month')::DATE
     WHERE user_id = $1 AND free_reset_date <= CURRENT_DATE
     RETURNING *`,
    [userId]
  );
  return rows.length > 0; // true if reset happened
}

async function expireOldCredits(userId) {
  // Find expired admin/promo purchase records
  const { rows } = await pool.query(
    `SELECT id, minutes_credited FROM purchases
     WHERE user_id = $1 AND expires_at IS NOT NULL AND expires_at < NOW()
     AND credit_type IN ('admin', 'promo')`,
    [userId]
  );

  if (!rows.length) return 0;

  // Sum up expired minutes and deduct from paid_minutes_remaining
  let totalExpired = rows.reduce((sum, r) => sum + r.minutes_credited, 0);

  // Don't deduct more than they have
  const balance = await getUserBalance(userId);
  const toDeduct = Math.min(totalExpired, balance.paid_minutes_remaining);

  if (toDeduct > 0) {
    await pool.query(
      'UPDATE user_balances SET paid_minutes_remaining = paid_minutes_remaining - $1 WHERE user_id = $2',
      [toDeduct, userId]
    );
  }

  // Mark these purchases as expired so they aren't processed again
  await pool.query(
    `UPDATE purchases SET credit_type = 'expired'
     WHERE user_id = $1 AND expires_at IS NOT NULL AND expires_at < NOW()
     AND credit_type IN ('admin', 'promo')`,
    [userId]
  );

  return toDeduct;
}

async function deductMinutes(userId, minutes) {
  // Reset free minutes if the monthly reset date has passed
  await checkAndResetFree(userId);

  // Deduct free minutes first, then paid.
  // NOTE: Within paid minutes, ideally we'd deduct from soonest-expiring credits
  // first (per-purchase tracking). For now we treat paid_minutes_remaining as a
  // single pool — the expireOldCredits() function handles bulk removal of expired
  // admin/promo credits, which is sufficient for the common case.
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

async function redeemPromoCode(userId, code) {
  const { rows } = await pool.query('SELECT * FROM promo_codes WHERE code = $1', [code]);
  if (!rows.length) return { error: 'Invalid promo code' };
  if (rows[0].redeemed_by) return { error: 'This code has already been redeemed' };

  const minutes = rows[0].minutes_granted;
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year

  // Mark redeemed
  await pool.query(
    'UPDATE promo_codes SET redeemed_by = $1, redeemed_at = NOW(), expires_at = $2 WHERE code = $3',
    [userId, expiresAt, code]
  );

  // Credit balance
  await pool.query(
    'UPDATE user_balances SET paid_minutes_remaining = paid_minutes_remaining + $1 WHERE user_id = $2',
    [minutes, userId]
  );

  // Record in purchases
  await pool.query(
    `INSERT INTO purchases (id, user_id, provider, minutes_credited, credit_type, expires_at)
     VALUES ($1, $2, 'promo', $3, 'promo', $4)`,
    [crypto.randomUUID(), userId, minutes, expiresAt]
  );

  const balance = await getUserBalance(userId);
  return { success: true, minutesCredited: minutes, balance };
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

// ── Rules Corrections ─────────────────────────────────────────────────────────
async function getRulesCorrections(gameId) {
  const { rows } = await pool.query('SELECT * FROM rules_corrections WHERE game_id = $1 ORDER BY created_at', [gameId]);
  return rows;
}

async function addRuleCorrection(gameId, text, category) {
  // Get the game's system
  const gameResult = await pool.query('SELECT system FROM games WHERE id = $1', [gameId]);
  const gameSystem = gameResult.rows.length ? gameResult.rows[0].system : 'dnd5e';

  const { rows } = await pool.query(
    'INSERT INTO rules_corrections (game_id, text, category, game_system) VALUES ($1, $2, $3, $4) RETURNING *',
    [gameId, text, category || 'general', gameSystem]
  );
  return rows[0];
}

async function updateRuleCorrection(id, text) {
  await pool.query('UPDATE rules_corrections SET text = $1, updated_at = NOW() WHERE id = $2', [text, id]);
}

async function deleteRuleCorrection(id) {
  await pool.query('DELETE FROM rules_corrections WHERE id = $1', [id]);
}

async function searchSharedRules(search, category, gameSystem = null, limit = 20, offset = 0) {
  const { rows } = await pool.query(`
    SELECT rc.id, rc.text, rc.category, rc.created_at, rc.game_system,
           u.display_name AS author_name,
           (SELECT COUNT(*) FROM rules_corrections WHERE original_rule_id = rc.id) AS usage_count
    FROM rules_corrections rc
    LEFT JOIN users u ON u.id = rc.created_by_user_id
    WHERE rc.is_master = true AND rc.is_private = false
      AND ($1::text IS NULL OR rc.text ILIKE '%' || $1 || '%')
      AND ($2::text IS NULL OR rc.category = $2)
      AND ($3::text IS NULL OR rc.game_system = $3 OR rc.game_system = 'all')
    ORDER BY usage_count DESC, rc.created_at DESC
    LIMIT $4 OFFSET $5
  `, [search || null, category || null, gameSystem || null, limit, offset]);
  return rows;
}

async function addRuleCorrectionFull(gameId, text, category, userId, originalRuleId = null, isMaster = false, isPrivate = false, gameSystem = 'dnd5e') {
  const result = await pool.query(
    'INSERT INTO rules_corrections (game_id, text, category, created_by_user_id, original_rule_id, is_master, is_private, game_system, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) RETURNING id',
    [gameId || null, text, category || 'general', userId || null, originalRuleId, isMaster, isPrivate, gameSystem]
  );
  return result.rows[0];
}

async function copyRuleToGame(ruleId, targetGameId, userId) {
  const sourceRule = await pool.query('SELECT * FROM rules_corrections WHERE id = $1', [ruleId]);
  if (!sourceRule.rows.length) throw new Error('Rule not found');

  // Get target game's system
  const gameResult = await pool.query('SELECT system FROM games WHERE id = $1', [targetGameId]);
  if (!gameResult.rows.length) throw new Error('Game not found');

  const rule = sourceRule.rows[0];
  const targetSystem = gameResult.rows[0].system;
  return addRuleCorrectionFull(targetGameId, rule.text, rule.category, userId, ruleId, false, false, targetSystem);
}

async function setRulePrivacy(ruleId, isPrivate, userId) {
  // Check ownership
  const rule = await pool.query('SELECT created_by_user_id FROM rules_corrections WHERE id = $1', [ruleId]);
  if (!rule.rows.length) throw new Error('Rule not found');
  if (rule.rows[0].created_by_user_id !== userId) throw new Error('Not authorized');

  await pool.query('UPDATE rules_corrections SET is_private = $1 WHERE id = $2', [isPrivate, ruleId]);
}

async function promoteToMaster(ruleId, userId) {
  // Check ownership
  const rule = await pool.query('SELECT created_by_user_id FROM rules_corrections WHERE id = $1', [ruleId]);
  if (!rule.rows.length) throw new Error('Rule not found');
  if (rule.rows[0].created_by_user_id !== userId) throw new Error('Not authorized');

  await pool.query('UPDATE rules_corrections SET is_master = true WHERE id = $1', [ruleId]);
}

async function getExportableRules(gameId) {
  const { rows } = await pool.query('SELECT * FROM rules_corrections WHERE game_id = $1 ORDER BY created_at DESC', [gameId]);
  return rows;
}

// ── Anonymous Sessions ───────────────────────────────────────────────────────
async function createAnonSession(id, ip) {
  await pool.query(
    'INSERT INTO anonymous_sessions (id, ip_address) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
    [id, ip]
  );
}

async function getAnonSession(id) {
  const { rows } = await pool.query('SELECT * FROM anonymous_sessions WHERE id = $1', [id]);
  return rows[0] || null;
}

async function updateAnonMinutes(id, minutes) {
  await pool.query(
    `UPDATE anonymous_sessions SET minutes_used = minutes_used + $2, last_active = NOW() WHERE id = $1`,
    [id, minutes]
  );
}

async function convertAnonSession(anonId, userId) {
  await pool.query(
    'UPDATE anonymous_sessions SET converted_to_user_id = $1 WHERE id = $2',
    [userId, anonId]
  );
}

async function countRecentAnonSessions(ip) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) as cnt FROM anonymous_sessions
     WHERE ip_address = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
    [ip]
  );
  return parseInt(rows[0].cnt);
}

// ── Killshots (Hall of Fame) ──────────────────────────────────────────────────
async function getRandomKillshots(limit = 3) {
  const { rows } = await pool.query(`
    SELECT * FROM killshots
    WHERE image_url IS NOT NULL
    ORDER BY RANDOM() * (drama_score::FLOAT) DESC
    LIMIT $1
  `, [limit]);
  return rows;
}

async function saveKillshot(gameId, gameName, characterName, playerUserId, enemyName, momentType, description, imageUrl, dramaScore, gameSystem) {
  await pool.query(`
    INSERT INTO killshots (game_id, game_name, character_name, player_user_id, enemy_name,
      moment_type, description, image_url, drama_score, game_system)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [gameId, gameName, characterName, playerUserId, enemyName,
      momentType, description, imageUrl, dramaScore, gameSystem]);
}

// ── Monster Sources ───────────────────────────────────────────────────────────
async function getMonsterFromSources(gameId, slug) {
  const result = await pool.query(`
    SELECT ms.monsters->$2 as monster, ms.name as source_name
    FROM game_monster_sources gms
    JOIN monster_sources ms ON ms.id = gms.source_id
    WHERE gms.game_id = $1 AND ms.monsters ? $2
    ORDER BY gms.priority ASC
    LIMIT 1
  `, [gameId, slug]);
  return result.rows[0]?.monster || null;
}

async function saveMonsterToGameOverrides(gameId, slug, monsterData) {
  let source = await pool.query(
    `SELECT id FROM monster_sources WHERE game_id = $1 AND scope = 'game' LIMIT 1`, [gameId]
  );
  if (source.rows.length === 0) {
    const id = require('crypto').randomUUID();
    await pool.query(
      `INSERT INTO monster_sources (id, name, system, scope, game_id, monsters) VALUES ($1, 'Game Overrides', 'any', 'game', $2, $3)`,
      [id, gameId, JSON.stringify({ [slug]: monsterData })]
    );
    await pool.query(
      `INSERT INTO game_monster_sources (game_id, source_id, priority) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING`,
      [gameId, id]
    );
  } else {
    await pool.query(
      `UPDATE monster_sources SET monsters = monsters || $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [source.rows[0].id, JSON.stringify({ [slug]: monsterData })]
    );
  }
}

// ── Monster Templates ─────────────────────────────────────────────────────────
async function getMonsterTemplates(monsterSlug, eventType, persona) {
  const { rows } = await pool.query(
    'SELECT templates FROM monster_templates WHERE monster_slug = $1 AND event_type = $2 AND persona = $3',
    [monsterSlug, eventType, persona]
  );
  return rows[0]?.templates || null;
}

async function saveMonsterTemplates(monsterSlug, eventType, persona, templates) {
  await pool.query(`
    INSERT INTO monster_templates (monster_slug, event_type, persona, templates)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (monster_slug, event_type, persona)
    DO UPDATE SET templates = $4
  `, [monsterSlug, eventType, persona, JSON.stringify(templates)]);
}

async function attachDefaultMonsterSource(gameId, system) {
  const source = await pool.query(
    `SELECT id FROM monster_sources WHERE scope = 'global' AND system = $1 LIMIT 1`, [system]
  );
  if (source.rows.length > 0) {
    await pool.query(
      `INSERT INTO game_monster_sources (game_id, source_id, priority) VALUES ($1, $2, 10) ON CONFLICT DO NOTHING`,
      [gameId, source.rows[0].id]
    );
  }
}

module.exports = {
  pool,
  initDB,
  createGame,
  getGame,
  listGames,
  updateGameContext,
  updateGameImage,
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
  findOrCreateUserByEmail,
  setMagicLinkNonce,
  clearMagicLinkNonce,
  setUserPassword,
  setPasswordResetNonce,
  clearPasswordResetNonce,
  getUserByProvider,
  getUserBalance,
  deductMinutes,
  creditMinutes,
  redeemPromoCode,
  resetFreeMinutes,
  checkAndResetFree,
  expireOldCredits,
  listUsers,
  getRulesCorrections,
  addRuleCorrection,
  updateRuleCorrection,
  deleteRuleCorrection,
  searchSharedRules,
  addRuleCorrectionFull,
  copyRuleToGame,
  setRulePrivacy,
  promoteToMaster,
  getExportableRules,
  createAnonSession,
  getAnonSession,
  updateAnonMinutes,
  convertAnonSession,
  countRecentAnonSessions,
  getRandomKillshots,
  saveKillshot,
  getMonsterFromSources,
  saveMonsterToGameOverrides,
  attachDefaultMonsterSource,
  getMonsterTemplates,
  saveMonsterTemplates,
};
