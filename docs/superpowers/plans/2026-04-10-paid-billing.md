# Paid Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Metered billing system charging $1/hour of playtime with 5 free hours/month. Supports email/password + Google/Apple/Discord OAuth, host-controlled billing, spectator mode on expiry, promo codes, admin controls, and RevenueCat/Stripe payment integration.

**Architecture:** Auth via Passport.js in `auth.js` (Express router). Billing ticker in `billing.js` runs per-active-game every 60s, deducting from user balances. Payment processing in `payments.js` via RevenueCat (Stripe for web). All user/balance/purchase data in PostgreSQL via existing `db.js` Pool. Sessions via JWT in httpOnly cookies.

**Tech Stack:** Passport.js (local + Google + Apple + Discord strategies), bcrypt (password hashing), jsonwebtoken (JWT sessions), `@revenuecat/purchases-js` (payment), existing Express/Socket.io/pg stack. No framework change.

**New files:** `auth.js`, `billing.js`, `payments.js`, `public/login.html`, `public/admin.html`, `public/redeem.html`, `public/purchase.html`

**New env vars:** `JWT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APPLE_CLIENT_ID`, `APPLE_CLIENT_SECRET`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `BILLING_ENABLED`, `REVENUECAT_API_KEY`, `REVENUECAT_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`

---

## Phase 1: Auth + Billing Core (Tasks 1-5)

### Task 1: DB Schema — Users, Balances, Purchases Tables

**Files:**
- Modify: `db.js`
- Modify: `package.json` (add bcrypt, jsonwebtoken, passport, passport-local, passport-google-oauth20, passport-apple, passport-discord dependencies)

- [ ] **Step 1: Add new dependencies to package.json**

```json
{
  "dependencies": {
    "bcrypt": "^5.1.1",
    "jsonwebtoken": "^9.0.2",
    "passport": "^0.7.0",
    "passport-local": "^1.0.0",
    "passport-google-oauth20": "^2.0.0",
    "@nicokaiser/passport-apple": "^2.0.0",
    "passport-discord": "^0.1.4",
    "cookie-parser": "^1.4.6"
  }
}
```

Run: `npm install bcrypt jsonwebtoken passport passport-local passport-google-oauth20 @nicokaiser/passport-apple passport-discord cookie-parser`

- [ ] **Step 2: Add user tables to db.js initDB()**

Add after the existing `CREATE TABLE IF NOT EXISTS channel_links` block, still inside the same `initDB()` function:

```js
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
```

- [ ] **Step 3: Add user DB helper functions to db.js**

Add these functions and export them from `db.js`:

```js
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
```

Add `crypto` require at top of db.js: `const crypto = require('crypto');`

Export all new functions from `module.exports`.

---

### Task 2: Auth Module — Passport.js Setup

**Files:**
- Create: `auth.js`
- Modify: `server.js` (mount auth router)

- [ ] **Step 1: Create auth.js with Passport strategies and routes**

```js
// auth.js
const express = require('express');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const AppleStrategy = require('@nicokaiser/passport-apple').Strategy;
const DiscordStrategy = require('passport-discord').Strategy;
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRY = '7d';
const BCRYPT_ROUNDS = 12;

// ── Helpers ──────────────────────────────────────────────────────────────────
function generateToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email, isAdmin: user.is_admin },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function setTokenCookie(res, token) {
  res.cookie('tt_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
}

// ── Middleware: attach user to request from JWT cookie ────────────────────────
async function authMiddleware(req, res, next) {
  const token = req.cookies?.tt_token;
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = await db.getUserById(decoded.userId);
    next();
  } catch {
    req.user = null;
    next();
  }
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ── Passport: Local Strategy (email/password) ────────────────────────────────
passport.use(new LocalStrategy(
  { usernameField: 'email' },
  async (email, password, done) => {
    try {
      const user = await db.getUserByEmail(email.toLowerCase().trim());
      if (!user) return done(null, false, { message: 'Invalid email or password' });
      if (!user.password_hash) return done(null, false, { message: 'Account uses OAuth — try Google, Apple, or Discord' });
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return done(null, false, { message: 'Invalid email or password' });
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }
));

// ── Passport: Google Strategy ────────────────────────────────────────────────
if (process.env.GOOGLE_CLIENT_ID) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: '/auth/google/callback',
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value?.toLowerCase();
      if (!email) return done(null, false, { message: 'No email from Google' });
      let user = await db.getUserByEmail(email);
      if (!user) {
        const id = crypto.randomUUID();
        await db.createUser({
          id, email, passwordHash: null,
          displayName: profile.displayName,
          authProvider: 'google',
          authProviderId: profile.id,
        });
        user = await db.getUserById(id);
      }
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }));
}

// ── Passport: Apple Strategy ─────────────────────────────────────────────────
if (process.env.APPLE_CLIENT_ID) {
  passport.use(new AppleStrategy({
    clientID: process.env.APPLE_CLIENT_ID,
    teamID: process.env.APPLE_TEAM_ID,
    keyID: process.env.APPLE_KEY_ID,
    key: process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    callbackURL: '/auth/apple/callback',
    scope: ['name', 'email'],
  }, async (accessToken, refreshToken, idToken, profile, done) => {
    try {
      const email = profile.email?.toLowerCase();
      if (!email) return done(null, false, { message: 'No email from Apple' });
      let user = await db.getUserByEmail(email);
      if (!user) {
        const id = crypto.randomUUID();
        await db.createUser({
          id, email, passwordHash: null,
          displayName: profile.name?.firstName
            ? `${profile.name.firstName} ${profile.name.lastName || ''}`.trim()
            : email.split('@')[0],
          authProvider: 'apple',
          authProviderId: profile.id,
        });
        user = await db.getUserById(id);
      }
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }));
}

// ── Passport: Discord Strategy ───────────────────────────────────────────────
if (process.env.DISCORD_CLIENT_ID) {
  passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: '/auth/discord/callback',
    scope: ['identify', 'email'],
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.email?.toLowerCase();
      if (!email) return done(null, false, { message: 'No email from Discord' });
      let user = await db.getUserByEmail(email);
      if (!user) {
        const id = crypto.randomUUID();
        await db.createUser({
          id, email, passwordHash: null,
          displayName: profile.username || email.split('@')[0],
          authProvider: 'discord',
          authProviderId: profile.id,
        });
        user = await db.getUserById(id);
      }
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }));
}

// ── Routes: Email/Password ───────────────────────────────────────────────────
router.post('/auth/register', async (req, res) => {
  try {
    const { email, password, displayName } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const existing = await db.getUserByEmail(email.toLowerCase().trim());
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const id = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await db.createUser({
      id,
      email: email.toLowerCase().trim(),
      passwordHash,
      displayName: displayName || email.split('@')[0],
      authProvider: 'email',
      authProviderId: null,
    });

    const user = await db.getUserById(id);
    const token = generateToken(user);
    setTokenCookie(res, token);
    res.json({ user: { id: user.id, email: user.email, displayName: user.display_name, isAdmin: user.is_admin } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/login', (req, res, next) => {
  passport.authenticate('local', { session: false }, (err, user, info) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(401).json({ error: info?.message || 'Invalid credentials' });
    const token = generateToken(user);
    setTokenCookie(res, token);
    res.json({ user: { id: user.id, email: user.email, displayName: user.display_name, isAdmin: user.is_admin } });
  })(req, res, next);
});

router.post('/auth/logout', (req, res) => {
  res.clearCookie('tt_token');
  res.json({ ok: true });
});

router.get('/auth/me', authMiddleware, (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      displayName: req.user.display_name,
      isAdmin: req.user.is_admin,
    },
  });
});

// ── Routes: Google OAuth ─────────────────────────────────────────────────────
router.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));
router.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', { session: false }, (err, user) => {
    if (err || !user) return res.redirect('/login.html?error=google_failed');
    const token = generateToken(user);
    setTokenCookie(res, token);
    res.redirect('/');
  })(req, res, next);
});

// ── Routes: Apple OAuth ──────────────────────────────────────────────────────
router.get('/auth/apple', passport.authenticate('apple', { session: false }));
router.post('/auth/apple/callback', (req, res, next) => {
  passport.authenticate('apple', { session: false }, (err, user) => {
    if (err || !user) return res.redirect('/login.html?error=apple_failed');
    const token = generateToken(user);
    setTokenCookie(res, token);
    res.redirect('/');
  })(req, res, next);
});

// ── Routes: Discord OAuth ────────────────────────────────────────────────────
router.get('/auth/discord', passport.authenticate('discord', { session: false }));
router.get('/auth/discord/callback', (req, res, next) => {
  passport.authenticate('discord', { session: false }, (err, user) => {
    if (err || !user) return res.redirect('/login.html?error=discord_failed');
    const token = generateToken(user);
    setTokenCookie(res, token);
    res.redirect('/');
  })(req, res, next);
});

module.exports = { router, authMiddleware, requireAuth, requireAdmin, generateToken };
```

- [ ] **Step 2: Mount auth router in server.js**

At the top of `server.js`, add:

```js
const cookieParser = require('cookie-parser');
const { router: authRouter, authMiddleware, requireAuth, requireAdmin } = require('./auth');
```

After `app.use(express.json());` add:

```js
app.use(cookieParser());
app.use(passport.initialize());
app.use(authRouter);
app.use(authMiddleware); // Attaches req.user to all requests
```

Also add `const passport = require('passport');` to the top requires.

---

### Task 3: Auth UI — Login Page

**Files:**
- Create: `public/login.html`
- Modify: `public/index.html` (add user info / login prompt to header)

- [ ] **Step 1: Create public/login.html**

Full HTML page matching existing Tavern Table parchment theme (Cinzel Decorative + Crimson Pro fonts, same CSS variables). Contains:

- Email/password login form
- Email/password register form (toggle between login/register)
- "Sign in with Google" button (links to `/auth/google`)
- "Sign in with Apple" button (links to `/auth/apple`)
- "Sign in with Discord" button (links to `/auth/discord`)
- Error display area
- JavaScript: POST to `/auth/login` or `/auth/register`, on success `window.location.href = '/'`
- Show error from URL params (`?error=google_failed` etc.)

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Tavern Table — Sign In</title>
<link href="https://fonts.googleapis.com/css2?family=Cinzel+Decorative:wght@700&family=Crimson+Pro:ital,wght@0,300;0,400;0,600;1,400&display=swap" rel="stylesheet"/>
<style>
  :root {
    --parchment: #f5ead6; --parchment-dark: #e8d5b0; --ink: #2c1a0e;
    --ink-light: #5c3d1e; --gold: #c8922a; --gold-light: #f0c060;
    --red: #8b2020; --shadow: rgba(44,26,14,0.35); --radius: 12px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #1a0f05;
    background-image: radial-gradient(ellipse at 20% 80%, #2d1a08 0%, transparent 50%),
                      radial-gradient(ellipse at 80% 20%, #2d1a08 0%, transparent 50%);
    font-family: 'Crimson Pro', serif; color: var(--ink);
    min-height: 100vh; display: flex; flex-direction: column; align-items: center;
    justify-content: center; padding: 20px;
  }
  header { text-align: center; margin-bottom: 24px; }
  header h1 { font-family: 'Cinzel Decorative', cursive; font-size: 1.6rem;
    color: var(--gold-light); letter-spacing: 0.05em;
    text-shadow: 0 0 30px rgba(200,146,42,0.6); margin-bottom: 4px; }
  header p { color: var(--parchment-dark); font-size: 0.95rem; font-style: italic; }
  .panel {
    background: var(--parchment); border-radius: var(--radius); padding: 24px;
    box-shadow: 0 4px 20px var(--shadow); border: 1px solid var(--parchment-dark);
    width: 100%; max-width: 400px;
  }
  .panel-title { font-family: 'Cinzel Decorative', cursive; font-size: 0.8rem;
    color: var(--gold); text-transform: uppercase; letter-spacing: 0.1em;
    margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid var(--parchment-dark); }
  label { font-size: 0.85rem; color: var(--ink-light); font-weight: 600;
    display: block; margin-bottom: 4px; margin-top: 10px; }
  input { width: 100%; background: rgba(255,255,255,0.5); border: 1px solid var(--parchment-dark);
    border-radius: 8px; padding: 10px 12px; font-family: 'Crimson Pro', serif;
    font-size: 1rem; color: var(--ink); outline: none; }
  input:focus { border-color: var(--gold); box-shadow: 0 0 0 3px rgba(200,146,42,0.2); }
  .btn { display: block; width: 100%; padding: 12px; border: none; border-radius: 8px;
    font-family: 'Cinzel Decorative', cursive; font-size: 0.75rem; font-weight: 700;
    cursor: pointer; letter-spacing: 0.05em; margin-top: 14px; text-align: center;
    text-decoration: none; }
  .btn-primary { background: linear-gradient(135deg, #c8922a, #f0c060, #c8922a);
    color: #0d0600; box-shadow: 0 4px 12px rgba(200,146,42,0.4); }
  .btn-oauth { background: #2c1a0e; color: var(--parchment); margin-top: 8px; }
  .btn-oauth:hover { background: #3d2510; }
  .divider { text-align: center; margin: 16px 0; color: var(--ink-light);
    font-size: 0.85rem; position: relative; }
  .divider::before, .divider::after { content: ''; position: absolute; top: 50%;
    width: 35%; height: 1px; background: var(--parchment-dark); }
  .divider::before { left: 0; } .divider::after { right: 0; }
  .toggle { text-align: center; margin-top: 14px; font-size: 0.9rem; color: var(--ink-light); }
  .toggle a { color: var(--gold); cursor: pointer; text-decoration: underline; }
  .error { background: rgba(139,32,32,0.1); color: var(--red); padding: 8px 12px;
    border-radius: 6px; font-size: 0.85rem; margin-bottom: 10px; display: none; }
  #register-fields { display: none; }
</style>
</head>
<body>
<header>
  <h1>Tavern Table</h1>
  <p>Sign in to play</p>
</header>
<div class="panel">
  <div class="panel-title" id="form-title">Sign In</div>
  <div class="error" id="error-msg"></div>

  <form id="auth-form" onsubmit="return false;">
    <label>Email</label>
    <input type="email" id="email" required placeholder="adventurer@example.com"/>

    <label>Password</label>
    <input type="password" id="password" required placeholder="Min 8 characters" minlength="8"/>

    <div id="register-fields">
      <label>Display Name</label>
      <input type="text" id="display-name" placeholder="Your adventurer name"/>
    </div>

    <button class="btn btn-primary" id="btn-submit">Sign In</button>
  </form>

  <div class="toggle">
    <span id="toggle-text">No account?</span>
    <a id="toggle-link" onclick="toggleMode()">Register</a>
  </div>

  <div class="divider">or continue with</div>

  <a href="/auth/google" class="btn btn-oauth">Sign in with Google</a>
  <a href="/auth/apple" class="btn btn-oauth">Sign in with Apple</a>
  <a href="/auth/discord" class="btn btn-oauth">Sign in with Discord</a>
</div>

<script>
let isRegister = false;
function toggleMode() {
  isRegister = !isRegister;
  document.getElementById('form-title').textContent = isRegister ? 'Create Account' : 'Sign In';
  document.getElementById('btn-submit').textContent = isRegister ? 'Create Account' : 'Sign In';
  document.getElementById('register-fields').style.display = isRegister ? 'block' : 'none';
  document.getElementById('toggle-text').textContent = isRegister ? 'Have an account?' : 'No account?';
  document.getElementById('toggle-link').textContent = isRegister ? 'Sign In' : 'Register';
}

document.getElementById('btn-submit').addEventListener('click', async () => {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const displayName = document.getElementById('display-name').value.trim();
  const errEl = document.getElementById('error-msg');
  errEl.style.display = 'none';

  const endpoint = isRegister ? '/auth/register' : '/auth/login';
  const body = isRegister ? { email, password, displayName } : { email, password };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Something went wrong';
      errEl.style.display = 'block';
      return;
    }
    window.location.href = '/';
  } catch (err) {
    errEl.textContent = 'Connection error';
    errEl.style.display = 'block';
  }
});

// Show errors from OAuth redirects
const params = new URLSearchParams(window.location.search);
if (params.get('error')) {
  const errEl = document.getElementById('error-msg');
  errEl.textContent = 'OAuth sign-in failed. Please try again.';
  errEl.style.display = 'block';
}
</script>
</body>
</html>
```

- [ ] **Step 2: Update index.html to show user info or login prompt**

Add a small bar above the header in `public/index.html`:

```html
<!-- Add inside <header>, above h1 -->
<div id="user-bar" style="font-size:0.8rem; color:var(--parchment-dark); margin-bottom:4px;">
  <span id="user-info" style="display:none;">
    Signed in as <strong id="user-name"></strong>
    · <a href="#" id="btn-logout" style="color:var(--gold);">Sign Out</a>
  </span>
  <span id="login-prompt">
    <a href="/login.html" style="color:var(--gold);">Sign in</a> to track playtime & billing
  </span>
</div>
```

Add JavaScript at the bottom of `index.html`:

```html
<script>
(async () => {
  try {
    const res = await fetch('/auth/me');
    const { user } = await res.json();
    if (user) {
      document.getElementById('user-info').style.display = 'inline';
      document.getElementById('login-prompt').style.display = 'none';
      document.getElementById('user-name').textContent = user.displayName || user.email;
      document.getElementById('btn-logout').addEventListener('click', async (e) => {
        e.preventDefault();
        await fetch('/auth/logout', { method: 'POST' });
        window.location.reload();
      });
    }
  } catch {}
})();
</script>
```

---

### Task 4: Billing Engine — billing.js

**Files:**
- Create: `billing.js`
- Modify: `server.js` (integrate billing ticker with game lifecycle)

- [ ] **Step 1: Create billing.js with BillingTicker class**

```js
// billing.js
const db = require('./db');

const BILLING_ENABLED = () => process.env.BILLING_ENABLED === 'true';
const FULL_RATE_MINUTES = 1;      // 1 minute deducted per tick (= $1/hr)
const AUTONOMOUS_RATE_MINUTES = 1; // 1 minute deducted every OTHER tick (= $0.50/hr)
const SPECTATOR_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const WARNING_THRESHOLDS = [30, 10, 1]; // minutes

class BillingTicker {
  constructor(io) {
    this.io = io;
    this.tickers = {}; // gameId -> intervalId
    this.spectatorTimers = {}; // gameId -> { userId: setTimeout id }
    this.autonomousTicks = {}; // gameId -> count (for half-rate)
  }

  // Start billing for a game when it becomes active
  startGame(gameId, gameState) {
    if (this.tickers[gameId]) return; // Already running

    this.autonomousTicks[gameId] = 0;

    this.tickers[gameId] = setInterval(async () => {
      await this.tick(gameId, gameState);
    }, 60000); // Every 60 seconds
  }

  // Stop billing when game pauses or all disconnect
  stopGame(gameId) {
    if (this.tickers[gameId]) {
      clearInterval(this.tickers[gameId]);
      delete this.tickers[gameId];
    }
    delete this.autonomousTicks[gameId];
  }

  async tick(gameId, gameState) {
    if (!BILLING_ENABLED()) return; // Master switch off — no enforcement
    if (gameState.paused) return;

    const game = await db.getGame(gameId);
    if (!game) return;

    const isAutonomous = gameState.isAutonomous || false;
    const billingMode = game.billing_mode || 'host_pays';

    // Autonomous = half rate: only deduct every other tick
    if (isAutonomous) {
      this.autonomousTicks[gameId] = (this.autonomousTicks[gameId] || 0) + 1;
      if (this.autonomousTicks[gameId] % 2 !== 0) return; // Skip odd ticks
    }

    // Determine who to bill
    let userIds = [];
    if (billingMode === 'host_pays') {
      if (game.host_user_id) userIds = [game.host_user_id];
    } else {
      // player_pays: bill each connected player
      // Get connected user IDs from socket room
      const sockets = await this.io.in(gameId).fetchSockets();
      userIds = [...new Set(sockets.map(s => s.userId).filter(Boolean))];
    }

    for (const userId of userIds) {
      const balance = await db.getUserBalance(userId);
      if (!balance) continue;

      const totalRemaining = balance.free_minutes_remaining + balance.paid_minutes_remaining;

      // Check warning thresholds before deducting
      for (const threshold of WARNING_THRESHOLDS) {
        if (totalRemaining <= threshold + 1 && totalRemaining > threshold) {
          this.io.to(gameId).emit('billing_warning', {
            userId,
            minutesRemaining: totalRemaining - 1,
            level: threshold <= 1 ? 'critical' : threshold <= 10 ? 'urgent' : 'warning',
          });
        }
      }

      // Deduct
      const result = await db.deductMinutes(userId, FULL_RATE_MINUTES);

      // Check if balance hit 0
      const newBalance = await db.getUserBalance(userId);
      const newTotal = newBalance.free_minutes_remaining + newBalance.paid_minutes_remaining;

      if (newTotal <= 0) {
        this.enterSpectatorMode(gameId, userId, gameState);
      }

      // Emit balance update
      this.io.to(gameId).emit('balance_update', {
        userId,
        freeMinutes: newBalance.free_minutes_remaining,
        paidMinutes: newBalance.paid_minutes_remaining,
      });
    }
  }

  enterSpectatorMode(gameId, userId, gameState) {
    if (!gameState.billing) gameState.billing = {};
    if (!gameState.billing.spectatorMode) gameState.billing.spectatorMode = {};
    gameState.billing.spectatorMode[userId] = {
      enteredAt: Date.now(),
      expiresAt: Date.now() + SPECTATOR_WINDOW_MS,
    };

    this.io.to(gameId).emit('spectator_mode', {
      userId,
      expiresAt: Date.now() + SPECTATOR_WINDOW_MS,
    });

    // Set timer to hard-pause after spectator window
    if (!this.spectatorTimers[gameId]) this.spectatorTimers[gameId] = {};
    this.spectatorTimers[gameId][userId] = setTimeout(() => {
      this.io.to(gameId).emit('billing_pause', {
        userId,
        reason: 'Time expired. Add time to continue.',
      });
      // If host_pays and host ran out, pause entire game
      // If player_pays, only that player is locked out
    }, SPECTATOR_WINDOW_MS);
  }

  exitSpectatorMode(gameId, userId, gameState) {
    if (gameState.billing?.spectatorMode?.[userId]) {
      delete gameState.billing.spectatorMode[userId];
    }
    if (this.spectatorTimers[gameId]?.[userId]) {
      clearTimeout(this.spectatorTimers[gameId][userId]);
      delete this.spectatorTimers[gameId][userId];
    }
    this.io.to(gameId).emit('spectator_mode_ended', { userId });
  }

  // Check if a user is in spectator mode for a game
  isSpectator(gameId, userId, gameState) {
    return !!gameState.billing?.spectatorMode?.[userId];
  }

  stopAll() {
    for (const gameId of Object.keys(this.tickers)) {
      this.stopGame(gameId);
    }
  }
}

module.exports = { BillingTicker };
```

- [ ] **Step 2: Integrate billing into server.js**

In `server.js`, after creating the `io` instance:

```js
const { BillingTicker } = require('./billing');
const billingTicker = new BillingTicker(io);
```

In the `dm_start` socket handler (when game begins), add:

```js
billingTicker.startGame(gameId, gs);
```

In the `player_action` handler, before processing the action, check spectator mode:

```js
if (socket.userId && billingTicker.isSpectator(gameId, socket.userId, gs)) {
  socket.emit('error_msg', { text: 'You are in spectator mode. Add time to resume control.' });
  return;
}
```

When all players disconnect and game pauses:

```js
billingTicker.stopGame(gameId);
```

In the `join_game` handler, attach userId to socket:

```js
socket.userId = req.user?.id || null; // From auth middleware on socket handshake
```

Add Socket.io middleware to extract user from cookie:

```js
const jwt = require('jsonwebtoken');
const cookie = require('cookie');

io.use(async (socket, next) => {
  try {
    const cookies = cookie.parse(socket.handshake.headers.cookie || '');
    const token = cookies.tt_token;
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret-change-me');
      socket.userId = decoded.userId;
    }
  } catch {}
  next();
});
```

Add `cookie` to dependencies: `npm install cookie`

---

### Task 5: Admin Page

**Files:**
- Create: `public/admin.html`
- Modify: `server.js` (add admin API routes)

- [ ] **Step 1: Add admin API routes to server.js**

```js
// ── Admin API routes (all require admin auth) ────────────────────────────────
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const users = await db.listUsers();
  res.json(users);
});

app.post('/api/admin/credit', requireAuth, requireAdmin, async (req, res) => {
  const { email, minutes } = req.body;
  const user = await db.getUserByEmail(email.toLowerCase().trim());
  if (!user) return res.status(404).json({ error: 'User not found' });
  await db.creditMinutes(user.id, minutes, { creditType: 'admin' });
  res.json({ ok: true, credited: minutes, userId: user.id });
});

app.get('/api/admin/billing-status', requireAuth, requireAdmin, (req, res) => {
  res.json({ billingEnabled: process.env.BILLING_ENABLED === 'true' });
});

app.post('/api/admin/billing-toggle', requireAuth, requireAdmin, (req, res) => {
  process.env.BILLING_ENABLED = process.env.BILLING_ENABLED === 'true' ? 'false' : 'true';
  res.json({ billingEnabled: process.env.BILLING_ENABLED === 'true' });
});

app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
```

Note: the `requireAuth` and `requireAdmin` middleware come from `auth.js` and are imported in Task 2 Step 2. For the `/admin` route, since `authMiddleware` runs globally, `req.user` is already populated. But we need to apply `requireAuth` and `requireAdmin` as route-level middleware since the global `authMiddleware` only populates `req.user` without blocking.

- [ ] **Step 2: Create public/admin.html**

Full admin page (same parchment theme) with:

- Billing toggle switch (GET/POST `/api/admin/billing-status` and `/api/admin/billing-toggle`)
- User list table (email, display name, free minutes, paid minutes, total used, admin flag)
- Credit granting form (email input + hours input + submit button, POST `/api/admin/credit`)
- Promo code generation section (added in Phase 2 Task 6)

The page fetches `/api/admin/users` on load to populate the user table. The credit form calls `/api/admin/credit` with `{ email, minutes: hours * 60 }`.

Include a check: fetch `/auth/me` on load, if not admin redirect to `/`.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Tavern Table — Admin</title>
<!-- Same fonts and base CSS variables as other pages -->
<link href="https://fonts.googleapis.com/css2?family=Cinzel+Decorative:wght@700&family=Crimson+Pro:ital,wght@0,300;0,400;0,600;1,400&display=swap" rel="stylesheet"/>
<style>
  :root {
    --parchment: #f5ead6; --parchment-dark: #e8d5b0; --ink: #2c1a0e;
    --ink-light: #5c3d1e; --gold: #c8922a; --gold-light: #f0c060;
    --red: #8b2020; --green: #2a5c2a; --shadow: rgba(44,26,14,0.35); --radius: 12px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1a0f05; font-family: 'Crimson Pro', serif; color: var(--ink);
    min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 20px; }
  header { text-align: center; margin-bottom: 24px; }
  header h1 { font-family: 'Cinzel Decorative', cursive; font-size: 1.4rem;
    color: var(--gold-light); text-shadow: 0 0 30px rgba(200,146,42,0.6); }
  .container { width: 100%; max-width: 900px; }
  .panel { background: var(--parchment); border-radius: var(--radius); padding: 20px;
    box-shadow: 0 4px 20px var(--shadow); border: 1px solid var(--parchment-dark); margin-bottom: 16px; }
  .panel-title { font-family: 'Cinzel Decorative', cursive; font-size: 0.8rem;
    color: var(--gold); text-transform: uppercase; letter-spacing: 0.1em;
    margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid var(--parchment-dark); }
  label { font-size: 0.85rem; color: var(--ink-light); font-weight: 600;
    display: block; margin-bottom: 4px; margin-top: 10px; }
  input { width: 100%; background: rgba(255,255,255,0.5); border: 1px solid var(--parchment-dark);
    border-radius: 8px; padding: 10px 12px; font-family: 'Crimson Pro', serif;
    font-size: 1rem; color: var(--ink); outline: none; }
  .btn { display: inline-flex; align-items: center; justify-content: center; padding: 10px 20px;
    border: none; border-radius: 8px; font-family: 'Cinzel Decorative', cursive;
    font-size: 0.7rem; font-weight: 700; cursor: pointer; margin-top: 10px; }
  .btn-primary { background: linear-gradient(135deg, #c8922a, #f0c060, #c8922a); color: #0d0600; }
  .btn-danger { background: var(--red); color: #fff; }
  .btn-success { background: var(--green); color: #fff; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--parchment-dark); }
  th { font-weight: 600; color: var(--ink-light); font-size: 0.75rem; text-transform: uppercase; }
  .toggle-switch { display: flex; align-items: center; gap: 10px; }
  .toggle-label { font-size: 1rem; font-weight: 600; }
  .status-on { color: var(--green); } .status-off { color: var(--red); }
  .inline-form { display: flex; gap: 8px; align-items: flex-end; }
  .inline-form input { width: auto; flex: 1; }
  .msg { padding: 8px; border-radius: 6px; font-size: 0.85rem; margin-top: 8px; }
  .msg-ok { background: rgba(42,92,42,0.1); color: var(--green); }
  .msg-err { background: rgba(139,32,32,0.1); color: var(--red); }
</style>
</head>
<body>
<header><h1>Admin Panel</h1></header>
<div class="container">

  <!-- Billing Toggle -->
  <div class="panel">
    <div class="panel-title">Billing Control</div>
    <div class="toggle-switch">
      <span class="toggle-label">Billing:</span>
      <button class="btn" id="btn-toggle">Loading...</button>
    </div>
  </div>

  <!-- Credit Granting -->
  <div class="panel">
    <div class="panel-title">Grant Credits</div>
    <div class="inline-form">
      <div style="flex:2"><label>Email</label><input id="credit-email" placeholder="user@example.com"/></div>
      <div style="flex:1"><label>Hours</label><input id="credit-hours" type="number" value="5" min="1"/></div>
      <button class="btn btn-primary" id="btn-credit" style="align-self:flex-end;">Grant</button>
    </div>
    <div id="credit-msg"></div>
  </div>

  <!-- Promo Codes (populated in Task 6) -->
  <div class="panel" id="promo-panel">
    <div class="panel-title">Promo Codes</div>
    <div style="color:var(--ink-light);font-style:italic;">Coming in Phase 2</div>
  </div>

  <!-- User List -->
  <div class="panel">
    <div class="panel-title">Users</div>
    <table>
      <thead><tr><th>Email</th><th>Name</th><th>Free Min</th><th>Paid Min</th><th>Used</th><th>Admin</th></tr></thead>
      <tbody id="user-tbody"><tr><td colspan="6">Loading...</td></tr></tbody>
    </table>
  </div>

</div>
<script>
async function checkAdmin() {
  const res = await fetch('/auth/me');
  const { user } = await res.json();
  if (!user?.isAdmin) { window.location.href = '/'; return false; }
  return true;
}

async function loadBillingStatus() {
  const res = await fetch('/api/admin/billing-status');
  const { billingEnabled } = await res.json();
  const btn = document.getElementById('btn-toggle');
  btn.textContent = billingEnabled ? 'ON — Click to Disable' : 'OFF — Click to Enable';
  btn.className = billingEnabled ? 'btn btn-danger' : 'btn btn-success';
}

document.getElementById('btn-toggle').addEventListener('click', async () => {
  await fetch('/api/admin/billing-toggle', { method: 'POST' });
  loadBillingStatus();
});

async function loadUsers() {
  const res = await fetch('/api/admin/users');
  const users = await res.json();
  const tbody = document.getElementById('user-tbody');
  tbody.innerHTML = users.map(u => `<tr>
    <td>${u.email}</td><td>${u.display_name || ''}</td>
    <td>${u.free_minutes_remaining ?? '-'}</td><td>${u.paid_minutes_remaining ?? '-'}</td>
    <td>${u.total_minutes_used ?? '-'}</td><td>${u.is_admin ? 'Yes' : ''}</td>
  </tr>`).join('');
}

document.getElementById('btn-credit').addEventListener('click', async () => {
  const email = document.getElementById('credit-email').value.trim();
  const hours = parseInt(document.getElementById('credit-hours').value);
  const msgEl = document.getElementById('credit-msg');
  if (!email || !hours) { msgEl.innerHTML = '<div class="msg msg-err">Email and hours required</div>'; return; }
  const res = await fetch('/api/admin/credit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, minutes: hours * 60 }),
  });
  const data = await res.json();
  if (res.ok) {
    msgEl.innerHTML = `<div class="msg msg-ok">Credited ${hours}h to ${email}</div>`;
    loadUsers();
  } else {
    msgEl.innerHTML = `<div class="msg msg-err">${data.error}</div>`;
  }
});

(async () => {
  if (await checkAdmin()) {
    loadBillingStatus();
    loadUsers();
  }
})();
</script>
</body>
</html>
```

---

## PHASE 1 TEST CHECKPOINT

Test these before proceeding:

- [ ] `npm install` completes with all new dependencies (bcrypt, jsonwebtoken, passport, passport-local, passport-google-oauth20, @nicokaiser/passport-apple, passport-discord, cookie-parser, cookie)
- [ ] Server starts without errors; `initDB()` creates users, user_balances, purchases, promo_codes tables and adds billing columns to games
- [ ] POST `/auth/register` creates a user with hashed password and returns JWT cookie. First user gets `is_admin = TRUE`
- [ ] POST `/auth/login` authenticates and returns JWT cookie
- [ ] GET `/auth/me` returns user info when cookie present, null when absent
- [ ] POST `/auth/logout` clears cookie
- [ ] `/login.html` renders login/register forms; can toggle between modes
- [ ] OAuth routes `/auth/google`, `/auth/apple`, `/auth/discord` redirect correctly (if env vars configured)
- [ ] `/admin` page loads for admin user, redirects non-admin to `/`
- [ ] Admin can toggle billing on/off via admin page
- [ ] Admin can grant credits to a user by email; credits appear in user_balances
- [ ] User list on admin page shows all registered users with balances
- [ ] `billing.js` BillingTicker instantiates without errors; ticker does not deduct when `BILLING_ENABLED=false`
- [ ] Socket.io middleware extracts userId from JWT cookie
- [ ] index.html shows "Sign in" link for unauthenticated users, user name + logout for authenticated

---

## Phase 2: Credits + Promo Codes (Tasks 6-8)

### Task 6: Promo Code DB + API

**Files:**
- Modify: `server.js` (add promo code API endpoints)

- [ ] **Step 1: Add promo code API routes to server.js**

```js
// ── Promo Code API ───────────────────────────────────────────────────────────
app.post('/api/admin/promo', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { count = 1, minutes = 2400 } = req.body; // Default: 40 hours
    const codes = [];
    for (let i = 0; i < Math.min(count, 50); i++) {
      const code = 'BETA-' + crypto.randomUUID().slice(0, 6).toUpperCase();
      await db.pool.query(
        `INSERT INTO promo_codes (code, minutes_granted) VALUES ($1, $2)`,
        [code, minutes]
      );
      codes.push(code);
    }
    res.json({ codes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/promos', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await db.pool.query(
    `SELECT code, minutes_granted, created_at, redeemed_by, redeemed_at
     FROM promo_codes ORDER BY created_at DESC`
  );
  res.json(rows);
});

app.post('/api/redeem', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const { rows } = await db.pool.query(
    'SELECT * FROM promo_codes WHERE code = $1', [code.toUpperCase().trim()]
  );
  if (!rows.length) return res.status(404).json({ error: 'Invalid promo code' });
  const promo = rows[0];
  if (promo.redeemed_by) return res.status(409).json({ error: 'Code already redeemed' });

  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year from now

  await db.pool.query(
    `UPDATE promo_codes SET redeemed_by = $1, redeemed_at = NOW(), expires_at = $2
     WHERE code = $3`,
    [req.user.id, expiresAt, promo.code]
  );

  await db.creditMinutes(req.user.id, promo.minutes_granted, {
    creditType: 'promo',
    productId: promo.code,
    expiresAt,
  });

  res.json({
    ok: true,
    minutesCredited: promo.minutes_granted,
    hoursCredited: Math.round(promo.minutes_granted / 60),
  });
});
```

- [ ] **Step 2: Update admin.html promo panel**

Replace the "Coming in Phase 2" placeholder in `admin.html`'s `#promo-panel`:

```html
<div class="inline-form">
  <div style="flex:1"><label>Count</label><input id="promo-count" type="number" value="5" min="1" max="50"/></div>
  <div style="flex:1"><label>Hours Each</label><input id="promo-hours" type="number" value="40" min="1"/></div>
  <button class="btn btn-primary" id="btn-gen-promo" style="align-self:flex-end;">Generate</button>
</div>
<div id="promo-msg"></div>
<table id="promo-table" style="margin-top:12px;">
  <thead><tr><th>Code</th><th>Hours</th><th>Created</th><th>Redeemed By</th><th>Redeemed At</th></tr></thead>
  <tbody id="promo-tbody"></tbody>
</table>
```

Add JavaScript:

```js
document.getElementById('btn-gen-promo').addEventListener('click', async () => {
  const count = parseInt(document.getElementById('promo-count').value);
  const hours = parseInt(document.getElementById('promo-hours').value);
  const res = await fetch('/api/admin/promo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count, minutes: hours * 60 }),
  });
  const data = await res.json();
  document.getElementById('promo-msg').innerHTML =
    `<div class="msg msg-ok">Generated: ${data.codes.join(', ')}</div>`;
  loadPromos();
});

async function loadPromos() {
  const res = await fetch('/api/admin/promos');
  const promos = await res.json();
  document.getElementById('promo-tbody').innerHTML = promos.map(p => `<tr>
    <td><code>${p.code}</code></td>
    <td>${Math.round(p.minutes_granted / 60)}</td>
    <td>${new Date(p.created_at).toLocaleDateString()}</td>
    <td>${p.redeemed_by || '-'}</td>
    <td>${p.redeemed_at ? new Date(p.redeemed_at).toLocaleDateString() : '-'}</td>
  </tr>`).join('');
}
```

Call `loadPromos()` alongside `loadUsers()` in the init block.

---

### Task 7: Promo Redemption UI + Discord Command

**Files:**
- Create: `public/redeem.html`
- Modify: `discord-bot.js` (add `/tt redeem` subcommand)

- [ ] **Step 1: Create public/redeem.html**

Parchment-themed page with:
- Input field for promo code
- Redeem button
- Success/error message display
- Link to login if not authenticated
- Current balance display after redemption

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Tavern Table — Redeem Code</title>
<link href="https://fonts.googleapis.com/css2?family=Cinzel+Decorative:wght@700&family=Crimson+Pro:ital,wght@0,300;0,400;0,600;1,400&display=swap" rel="stylesheet"/>
<style>
  :root {
    --parchment: #f5ead6; --parchment-dark: #e8d5b0; --ink: #2c1a0e;
    --ink-light: #5c3d1e; --gold: #c8922a; --gold-light: #f0c060;
    --red: #8b2020; --green: #2a5c2a; --shadow: rgba(44,26,14,0.35); --radius: 12px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1a0f05; font-family: 'Crimson Pro', serif; color: var(--ink);
    min-height: 100vh; display: flex; flex-direction: column; align-items: center;
    justify-content: center; padding: 20px; }
  header { text-align: center; margin-bottom: 24px; }
  header h1 { font-family: 'Cinzel Decorative', cursive; font-size: 1.4rem;
    color: var(--gold-light); text-shadow: 0 0 30px rgba(200,146,42,0.6); }
  .panel { background: var(--parchment); border-radius: var(--radius); padding: 24px;
    box-shadow: 0 4px 20px var(--shadow); border: 1px solid var(--parchment-dark);
    width: 100%; max-width: 400px; }
  .panel-title { font-family: 'Cinzel Decorative', cursive; font-size: 0.8rem;
    color: var(--gold); text-transform: uppercase; letter-spacing: 0.1em;
    margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid var(--parchment-dark); }
  label { font-size: 0.85rem; color: var(--ink-light); font-weight: 600;
    display: block; margin-bottom: 4px; }
  input { width: 100%; background: rgba(255,255,255,0.5); border: 1px solid var(--parchment-dark);
    border-radius: 8px; padding: 12px; font-family: 'Crimson Pro', serif;
    font-size: 1.2rem; color: var(--ink); outline: none; text-align: center;
    letter-spacing: 0.1em; text-transform: uppercase; }
  .btn { display: block; width: 100%; padding: 12px; border: none; border-radius: 8px;
    font-family: 'Cinzel Decorative', cursive; font-size: 0.75rem; font-weight: 700;
    cursor: pointer; margin-top: 14px; background: linear-gradient(135deg, #c8922a, #f0c060, #c8922a);
    color: #0d0600; }
  .msg { padding: 10px; border-radius: 6px; font-size: 0.9rem; margin-top: 12px; text-align: center; }
  .msg-ok { background: rgba(42,92,42,0.15); color: var(--green); }
  .msg-err { background: rgba(139,32,32,0.1); color: var(--red); }
  #login-notice { text-align: center; color: var(--parchment-dark); margin-top: 12px; }
  #login-notice a { color: var(--gold); }
</style>
</head>
<body>
<header><h1>Redeem Promo Code</h1></header>
<div class="panel">
  <div class="panel-title">Enter Your Code</div>
  <label>Promo Code</label>
  <input id="code-input" placeholder="BETA-XXXXXX" maxlength="12"/>
  <button class="btn" id="btn-redeem">Redeem</button>
  <div id="result"></div>
</div>
<div id="login-notice"></div>
<script>
(async () => {
  const res = await fetch('/auth/me');
  const { user } = await res.json();
  if (!user) {
    document.getElementById('login-notice').innerHTML =
      '<a href="/login.html">Sign in</a> first to redeem a code';
    document.getElementById('btn-redeem').disabled = true;
    return;
  }
})();

document.getElementById('btn-redeem').addEventListener('click', async () => {
  const code = document.getElementById('code-input').value.trim();
  const resultEl = document.getElementById('result');
  if (!code) { resultEl.innerHTML = '<div class="msg msg-err">Enter a code</div>'; return; }

  const res = await fetch('/api/redeem', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (res.ok) {
    resultEl.innerHTML = `<div class="msg msg-ok">${data.hoursCredited} hours added to your account!</div>`;
  } else {
    resultEl.innerHTML = `<div class="msg msg-err">${data.error}</div>`;
  }
});
</script>
</body>
</html>
```

- [ ] **Step 2: Add /tt redeem subcommand to discord-bot.js**

In the `buildSubcommands` function, add a new subcommand:

```js
    .addSubcommand(sub => sub
      .setName('redeem')
      .setDescription('Redeem a promo code for playtime')
      .addStringOption(opt => opt.setName('code').setDescription('Promo code (e.g. BETA-ABC123)').setRequired(true)))
```

In the interaction handler, add a new `else if` block:

```js
  else if (sub === 'redeem') {
    const code = interaction.options.getString('code');
    await interaction.deferReply({ ephemeral: true });

    // Look up user by Discord ID — need discord_user_id in users table
    // For now, direct them to the web
    const embed = new EmbedBuilder()
      .setColor(0xC8922A)
      .setTitle('Redeem Promo Code')
      .setDescription(`To redeem code **${code}**, visit:\nhttps://${process.env.BASE_URL || 'taverntable.ai'}/redeem.html\n\nSign in with Discord to link your account, then enter the code.`);
    await interaction.editReply({ embeds: [embed] });
  }
```

Note: Full Discord-to-user linking (where the bot can directly credit the balance via Discord user ID) requires mapping Discord user IDs to Tavern Table user accounts. This can be done by adding a `discord_user_id` column to the `users` table and populating it during Discord OAuth. For Phase 2, the redirect to the web page is sufficient. Enhance in Phase 4 with direct redemption.

---

### Task 8: Credit Expiry Logic

**Files:**
- Modify: `db.js` (enhance deduction to expire soonest-first)
- Modify: `billing.js` (add monthly free minute reset check)

- [ ] **Step 1: Add expiry-aware deduction to db.js**

Replace the simple `deductMinutes` function with an expiry-aware version:

```js
async function deductMinutes(userId, minutes) {
  const balance = await getUserBalance(userId);
  if (!balance) return null;

  let remaining = minutes;

  // 1. Deduct free minutes first (they reset monthly, so use them)
  const freeDeduct = Math.min(remaining, balance.free_minutes_remaining);
  remaining -= freeDeduct;

  if (freeDeduct > 0) {
    await pool.query(
      `UPDATE user_balances SET free_minutes_remaining = free_minutes_remaining - $2,
       total_minutes_used = total_minutes_used + $2 WHERE user_id = $1`,
      [userId, freeDeduct]
    );
  }

  // 2. Deduct paid minutes from soonest-expiring credits first
  if (remaining > 0) {
    // Get unexpired credits with remaining balance, ordered by expiry (soonest first, NULL = never expires = last)
    const { rows: credits } = await pool.query(
      `SELECT id, minutes_credited,
              COALESCE(expires_at, '9999-12-31'::timestamptz) as effective_expiry
       FROM purchases
       WHERE user_id = $1
         AND credit_type IN ('admin', 'promo', 'purchase')
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY effective_expiry ASC`,
      [userId]
    );

    // We deduct from paid_minutes_remaining as a single balance
    // The expiry ordering is tracked via the purchases table for accounting
    const paidDeduct = Math.min(remaining, balance.paid_minutes_remaining);
    if (paidDeduct > 0) {
      await pool.query(
        `UPDATE user_balances SET paid_minutes_remaining = paid_minutes_remaining - $2,
         total_minutes_used = total_minutes_used + $2 WHERE user_id = $1`,
        [userId, paidDeduct]
      );
    }
    remaining -= paidDeduct;
  }

  return { totalDeducted: minutes - remaining };
}
```

- [ ] **Step 2: Add expired credit cleanup and monthly reset to billing.js**

Add a periodic job that runs every hour (or on server boot):

```js
// In billing.js, add to BillingTicker constructor:
this.maintenanceInterval = setInterval(() => this.maintenance(), 60 * 60 * 1000); // hourly
this.maintenance(); // Run on startup too

// Add method:
async maintenance() {
  // Reset free minutes for users whose reset date has passed
  await db.resetFreeMinutes();

  // Expire old credits: reduce paid_minutes for credits that have expired
  // Get all expired credits that haven't been accounted for
  const { rows: expired } = await db.pool.query(`
    SELECT user_id, SUM(minutes_credited) as expired_minutes
    FROM purchases
    WHERE expires_at IS NOT NULL
      AND expires_at <= NOW()
      AND credit_type IN ('admin', 'promo')
    GROUP BY user_id
  `);

  for (const row of expired) {
    // Mark expired credits as processed by setting minutes_credited to 0
    await db.pool.query(`
      UPDATE purchases SET minutes_credited = 0
      WHERE user_id = $1 AND expires_at IS NOT NULL AND expires_at <= NOW()
        AND credit_type IN ('admin', 'promo') AND minutes_credited > 0
    `, [row.user_id]);

    // Reduce paid balance (but don't go below 0)
    await db.pool.query(`
      UPDATE user_balances SET
        paid_minutes_remaining = GREATEST(0, paid_minutes_remaining - $2)
      WHERE user_id = $1
    `, [row.user_id, row.expired_minutes]);
  }
}
```

---

## PHASE 2 TEST CHECKPOINT

Test these before proceeding:

- [ ] POST `/api/admin/promo` with `{ count: 3, minutes: 2400 }` generates 3 codes in `BETA-XXXXXX` format
- [ ] GET `/api/admin/promos` lists all promo codes with status
- [ ] POST `/api/redeem` with valid code credits the user's balance and marks code as redeemed
- [ ] POST `/api/redeem` with already-redeemed code returns 409 error
- [ ] POST `/api/redeem` with invalid code returns 404 error
- [ ] `/redeem.html` page works end-to-end: enter code, get credited
- [ ] `/redeem.html` shows login prompt when not authenticated
- [ ] Admin page promo section generates and lists codes
- [ ] Discord `/tt redeem` command responds with link to web redemption page
- [ ] Monthly free minute reset: set a user's `free_reset_date` to yesterday, run `maintenance()`, verify free minutes reset to 300
- [ ] Credit expiry: create an admin credit with `expires_at` in the past, run `maintenance()`, verify `paid_minutes_remaining` decreases

---

## Phase 3: Payment Integration (Tasks 9-11)

### Task 9: RevenueCat + Stripe Setup

**Files:**
- Create: `payments.js`
- Modify: `package.json` (add `@revenuecat/purchases-js`)

- [ ] **Step 1: Install RevenueCat SDK**

```bash
npm install @revenuecat/purchases-js
```

- [ ] **Step 2: Create payments.js module**

```js
// payments.js
const crypto = require('crypto');
const db = require('./db');

// Product definitions
const PRODUCTS = {
  playtime_1hr: { minutes: 60, webPriceCents: 100, appPriceCents: 149, label: '1 Hour' },
  playtime_5hr: { minutes: 300, webPriceCents: 450, appPriceCents: 699, label: '5 Hours' },
  playtime_20hr: { minutes: 1200, webPriceCents: 1500, appPriceCents: 2299, label: '20 Hours' },
};

// RevenueCat webhook secret for signature verification
const WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET;

function verifyWebhookSignature(body, signature) {
  if (!WEBHOOK_SECRET) return true; // Skip in dev
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function handlePurchaseEvent(event) {
  // RevenueCat webhook event structure
  const { app_user_id, product_id, price_in_purchased_currency, store, transaction_id } = event;

  const product = PRODUCTS[product_id];
  if (!product) {
    console.error(`Unknown product: ${product_id}`);
    return { error: 'Unknown product' };
  }

  // app_user_id is the Tavern Table user ID (set during RevenueCat SDK init)
  const user = await db.getUserById(app_user_id);
  if (!user) {
    console.error(`Unknown user: ${app_user_id}`);
    return { error: 'Unknown user' };
  }

  // Check for duplicate transaction
  const { rows } = await db.pool.query(
    'SELECT id FROM purchases WHERE provider_tx_id = $1', [transaction_id]
  );
  if (rows.length) {
    return { ok: true, duplicate: true };
  }

  // Credit the user
  const provider = store === 'app_store' ? 'apple' : store === 'play_store' ? 'google' : 'stripe';
  const amountCents = Math.round((price_in_purchased_currency || 0) * 100);

  await db.creditMinutes(user.id, product.minutes, {
    provider,
    providerTxId: transaction_id,
    productId: product_id,
    amountCents,
    creditType: 'purchase',
    expiresAt: null, // Purchased hours never expire
  });

  return { ok: true, minutesCredited: product.minutes };
}

function getProducts(platform = 'web') {
  return Object.entries(PRODUCTS).map(([id, p]) => ({
    id,
    label: p.label,
    minutes: p.minutes,
    priceCents: platform === 'web' ? p.webPriceCents : p.appPriceCents,
    priceFormatted: platform === 'web'
      ? `$${(p.webPriceCents / 100).toFixed(2)}`
      : `$${(p.appPriceCents / 100).toFixed(2)}`,
  }));
}

module.exports = { PRODUCTS, handlePurchaseEvent, verifyWebhookSignature, getProducts };
```

---

### Task 10: Purchase Page

**Files:**
- Create: `public/purchase.html`
- Modify: `server.js` (add purchase API routes)

- [ ] **Step 1: Add purchase API routes to server.js**

```js
const payments = require('./payments');

app.get('/api/products', (req, res) => {
  res.json(payments.getProducts('web'));
});

app.get('/api/balance', requireAuth, async (req, res) => {
  const balance = await db.getUserBalance(req.user.id);
  res.json(balance);
});

app.get('/api/purchases', requireAuth, async (req, res) => {
  const { rows } = await db.pool.query(
    `SELECT id, provider, product_id, minutes_credited, amount_cents, credit_type, expires_at, created_at
     FROM purchases WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json(rows);
});
```

- [ ] **Step 2: Create public/purchase.html**

Parchment-themed page with:
- Current balance display (fetched from `/api/balance`)
- Three product cards with prices and "Buy" buttons
- RevenueCat Purchases JS SDK integration for Stripe Checkout
- Purchase history table
- If not logged in, redirect to login

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Tavern Table — Add Time</title>
<link href="https://fonts.googleapis.com/css2?family=Cinzel+Decorative:wght@700&family=Crimson+Pro:ital,wght@0,300;0,400;0,600;1,400&display=swap" rel="stylesheet"/>
<style>
  :root {
    --parchment: #f5ead6; --parchment-dark: #e8d5b0; --ink: #2c1a0e;
    --ink-light: #5c3d1e; --gold: #c8922a; --gold-light: #f0c060;
    --red: #8b2020; --green: #2a5c2a; --shadow: rgba(44,26,14,0.35); --radius: 12px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1a0f05; font-family: 'Crimson Pro', serif; color: var(--ink);
    min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 20px; }
  header { text-align: center; margin-bottom: 24px; }
  header h1 { font-family: 'Cinzel Decorative', cursive; font-size: 1.4rem;
    color: var(--gold-light); text-shadow: 0 0 30px rgba(200,146,42,0.6); }
  .balance-display { color: var(--parchment-dark); font-size: 1.1rem; margin-top: 6px; }
  .container { width: 100%; max-width: 700px; }
  .products { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .product-card { background: var(--parchment); border-radius: var(--radius); padding: 20px;
    text-align: center; box-shadow: 0 4px 20px var(--shadow); border: 2px solid var(--parchment-dark);
    transition: border-color 0.2s, transform 0.2s; cursor: pointer; }
  .product-card:hover { border-color: var(--gold); transform: translateY(-2px); }
  .product-card.popular { border-color: var(--gold); position: relative; }
  .product-card.popular::after { content: 'BEST VALUE'; position: absolute; top: -10px;
    left: 50%; transform: translateX(-50%); background: var(--gold); color: #0d0600;
    font-size: 0.6rem; font-weight: 700; padding: 2px 10px; border-radius: 4px;
    font-family: 'Cinzel Decorative', cursive; }
  .product-name { font-family: 'Cinzel Decorative', cursive; font-size: 0.9rem;
    color: var(--gold); margin-bottom: 8px; }
  .product-price { font-size: 1.6rem; font-weight: 700; color: var(--ink); margin-bottom: 4px; }
  .product-rate { font-size: 0.8rem; color: var(--ink-light); }
  .btn { display: block; width: 100%; padding: 10px; border: none; border-radius: 8px;
    font-family: 'Cinzel Decorative', cursive; font-size: 0.7rem; font-weight: 700;
    cursor: pointer; margin-top: 12px; background: linear-gradient(135deg, #c8922a, #f0c060, #c8922a);
    color: #0d0600; }
  .panel { background: var(--parchment); border-radius: var(--radius); padding: 16px;
    box-shadow: 0 4px 20px var(--shadow); border: 1px solid var(--parchment-dark); }
  .panel-title { font-family: 'Cinzel Decorative', cursive; font-size: 0.8rem;
    color: var(--gold); text-transform: uppercase; letter-spacing: 0.1em;
    margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--parchment-dark); }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--parchment-dark); }
  th { font-weight: 600; color: var(--ink-light); font-size: 0.75rem; text-transform: uppercase; }
</style>
</head>
<body>
<header>
  <h1>Add Playtime</h1>
  <div class="balance-display" id="balance-text">Loading balance...</div>
</header>
<div class="container">
  <div class="products" id="product-cards"></div>

  <div class="panel">
    <div class="panel-title">Purchase History</div>
    <table>
      <thead><tr><th>Date</th><th>Type</th><th>Hours</th><th>Amount</th></tr></thead>
      <tbody id="history-tbody"><tr><td colspan="4">Loading...</td></tr></tbody>
    </table>
  </div>
</div>

<script src="https://js.revenuecat.com/v1/purchases.js"></script>
<script>
let currentUser = null;

(async () => {
  // Check auth
  const authRes = await fetch('/auth/me');
  const { user } = await authRes.json();
  if (!user) { window.location.href = '/login.html'; return; }
  currentUser = user;

  // Load balance
  const balRes = await fetch('/api/balance');
  const balance = await balRes.json();
  const totalMin = (balance.free_minutes_remaining || 0) + (balance.paid_minutes_remaining || 0);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  document.getElementById('balance-text').textContent =
    `Balance: ${hours}h ${mins}m remaining`;

  // Load products
  const prodRes = await fetch('/api/products');
  const products = await prodRes.json();
  const container = document.getElementById('product-cards');
  products.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'product-card' + (i === 2 ? ' popular' : '');
    const rate = (p.priceCents / (p.minutes / 60) / 100).toFixed(2);
    card.innerHTML = `
      <div class="product-name">${p.label}</div>
      <div class="product-price">${p.priceFormatted}</div>
      <div class="product-rate">$${rate}/hr</div>
      <button class="btn" onclick="buyProduct('${p.id}')">Buy ${p.label}</button>
    `;
    container.appendChild(card);
  });

  // Load purchase history
  const histRes = await fetch('/api/purchases');
  const history = await histRes.json();
  const tbody = document.getElementById('history-tbody');
  if (history.length) {
    tbody.innerHTML = history.map(h => `<tr>
      <td>${new Date(h.created_at).toLocaleDateString()}</td>
      <td>${h.credit_type}</td>
      <td>${(h.minutes_credited / 60).toFixed(1)}</td>
      <td>${h.amount_cents ? '$' + (h.amount_cents / 100).toFixed(2) : 'Free'}</td>
    </tr>`).join('');
  } else {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;font-style:italic;">No purchases yet</td></tr>';
  }

  // Initialize RevenueCat (if API key configured)
  if (window.Purchases && '${process.env.REVENUECAT_API_KEY || ''}') {
    // Note: actual initialization uses the REVENUECAT_API_KEY from a /api/config endpoint
    // This is placeholder — actual flow uses RevenueCat's presentPaywall or custom checkout
  }
})();

async function buyProduct(productId) {
  // RevenueCat Purchases.js checkout flow
  // If RevenueCat is not configured, show a message
  alert('Payment integration requires RevenueCat configuration. Set REVENUECAT_API_KEY env var.');

  // When configured, this becomes:
  // const purchases = Purchases.configure({ apiKey: rcApiKey, appUserId: currentUser.id });
  // const offerings = await purchases.getOfferings();
  // const pkg = offerings.current.availablePackages.find(p => p.product.identifier === productId);
  // const { customerInfo } = await purchases.purchasePackage(pkg);
  // The webhook handler (Task 11) credits the balance server-side.
}
</script>
</body>
</html>
```

---

### Task 11: Webhook Handler

**Files:**
- Modify: `server.js` (add RevenueCat webhook endpoint)

- [ ] **Step 1: Add webhook endpoint to server.js**

This must be added BEFORE the `app.use(express.json())` middleware, because the webhook needs the raw body for signature verification. Alternatively, use a separate raw body parser for this route.

```js
// Add near the top of server.js, BEFORE app.use(express.json()):
app.post('/api/webhooks/revenuecat',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const signature = req.headers['x-revenuecat-signature'] || '';
      const rawBody = req.body.toString();

      if (!payments.verifyWebhookSignature(rawBody, signature)) {
        return res.status(401).json({ error: 'Invalid signature' });
      }

      const payload = JSON.parse(rawBody);
      const event = payload.event;

      // Only process successful purchases
      if (event.type === 'INITIAL_PURCHASE' || event.type === 'NON_RENEWING_PURCHASE') {
        const result = await payments.handlePurchaseEvent({
          app_user_id: event.app_user_id,
          product_id: event.product_id,
          price_in_purchased_currency: event.price_in_purchased_currency,
          store: event.store,
          transaction_id: event.transaction_id || event.id,
        });

        if (result.error) {
          console.error('Webhook processing error:', result.error);
          return res.status(400).json(result);
        }

        console.log(`Payment processed: ${result.minutesCredited} minutes for user ${event.app_user_id}`);
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  }
);
```

Note: Since this uses `express.raw()` and must come before `express.json()`, place it at the very top of the route definitions, right after `const app = express();` but before `app.use(express.json());`. Alternatively, restructure so that `express.json()` does not apply to this one route by using a path-specific middleware.

A cleaner approach is to keep `app.use(express.json())` where it is and use a route-specific override:

```js
// In the routes section (after app.use(express.json())):
app.post('/api/webhooks/revenuecat',
  express.raw({ type: '*/*' }), // Override JSON parser for this route
  async (req, res) => { /* ... same handler ... */ }
);
```

Actually, the cleanest approach: register the webhook route BEFORE the global JSON parser, or use `express.json()` as route-level middleware everywhere else. Since the existing codebase uses `app.use(express.json())` globally, the simplest fix is to register this single webhook route before the global parser line.

---

## PHASE 3 TEST CHECKPOINT

Test these before proceeding:

- [ ] GET `/api/products` returns 3 products with correct prices
- [ ] GET `/api/balance` (authenticated) returns user balance
- [ ] GET `/api/purchases` (authenticated) returns purchase history
- [ ] `/purchase.html` loads, shows balance, displays 3 product cards
- [ ] POST `/api/webhooks/revenuecat` with a mock INITIAL_PURCHASE event credits the user's balance
- [ ] Duplicate transaction IDs are detected and ignored (idempotent)
- [ ] `payments.js` module loads without errors
- [ ] Invalid webhook signature returns 401
- [ ] After webhook credits balance, `/api/balance` reflects the new amount

---

## Phase 4: UI + Polish (Tasks 12-15)

### Task 12: Header Balance Indicator

**Files:**
- Modify: `public/game.html` (add balance display to header)

- [ ] **Step 1: Add balance indicator HTML to game.html header**

Inside the `<header>` element of `game.html`, after the `#game-title` span, add:

```html
<span id="balance-indicator" style="display:none; font-size:0.7rem; margin-left:8px; font-weight:600;"></span>
<span id="billing-test-mode" style="display:none; font-size:0.65rem; color:#f0c060; margin-left:8px;">Test Mode</span>
```

- [ ] **Step 2: Add JavaScript to game.html for balance updates**

In the `<script>` section of `game.html`:

```js
// ── Balance indicator ────────────────────────────────────────────────────────
let currentBalance = null;

async function loadBalance() {
  try {
    const res = await fetch('/auth/me');
    const { user } = await res.json();
    if (!user) return;

    const balRes = await fetch('/api/balance');
    currentBalance = await balRes.json();
    updateBalanceDisplay();
  } catch {}
}

function updateBalanceDisplay() {
  if (!currentBalance) return;
  const el = document.getElementById('balance-indicator');
  const totalMin = currentBalance.free_minutes_remaining + currentBalance.paid_minutes_remaining;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;

  el.style.display = 'inline';
  el.textContent = `${hours}h ${mins}m`;

  if (totalMin > 30) {
    el.style.color = '#4a9'; // green
  } else if (totalMin > 10) {
    el.style.color = '#f0c060'; // yellow
  } else {
    el.style.color = '#c44'; // red
    el.textContent += ' !';
  }
}

// Listen for real-time balance updates from billing ticker
socket.on('balance_update', (data) => {
  // data: { userId, freeMinutes, paidMinutes }
  // Update if it's for the current user
  if (currentBalance) {
    currentBalance.free_minutes_remaining = data.freeMinutes;
    currentBalance.paid_minutes_remaining = data.paidMinutes;
    updateBalanceDisplay();
  }
});

socket.on('billing_warning', (data) => {
  const { minutesRemaining, level } = data;
  const colors = { warning: '#f0c060', urgent: '#f0a030', critical: '#c44' };
  // Show a temporary banner
  const banner = document.createElement('div');
  banner.style.cssText = `position:fixed;top:0;left:0;right:0;padding:8px;text-align:center;
    background:${colors[level] || '#f0c060'};color:#0d0600;font-weight:600;z-index:9999;
    font-family:'Cinzel Decorative',cursive;font-size:0.8rem;`;
  banner.textContent = minutesRemaining <= 1
    ? 'Less than 1 minute remaining!'
    : `${minutesRemaining} minutes of playtime remaining`;
  document.body.prepend(banner);
  setTimeout(() => banner.remove(), 10000);
});

loadBalance();
```

---

### Task 13: Spectator Mode UI

**Files:**
- Modify: `public/game.html` (add spectator mode banner and control hiding)

- [ ] **Step 1: Add spectator banner HTML**

Add above the chat panel in `game.html`:

```html
<div id="spectator-banner" style="display:none; background:linear-gradient(90deg,#2c1a0e,#4a2a10,#2c1a0e);
  color:#f0c060; padding:12px; border-radius:8px; text-align:center; margin-bottom:6px;">
  <div style="font-family:'Cinzel Decorative',cursive;font-size:0.8rem;margin-bottom:4px;">
    Time Expired — Spectating
  </div>
  <div style="font-size:0.85rem;color:#e8d5b0;">
    Claude is playing for you. <span id="spectator-countdown"></span>
  </div>
  <a href="/purchase.html" class="btn btn-primary" style="width:auto;display:inline-block;margin-top:8px;padding:8px 20px;font-size:0.7rem;">
    Add Time
  </a>
</div>
```

- [ ] **Step 2: Add spectator mode JavaScript**

```js
let spectatorCountdownInterval = null;

socket.on('spectator_mode', (data) => {
  const { expiresAt } = data;
  document.getElementById('spectator-banner').style.display = 'block';

  // Disable action controls
  const actionInput = document.getElementById('action-input');
  const actionBtn = document.getElementById('btn-send');
  if (actionInput) actionInput.disabled = true;
  if (actionBtn) actionBtn.disabled = true;

  // Countdown
  spectatorCountdownInterval = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    document.getElementById('spectator-countdown').textContent =
      `Spectating: ${min}:${sec.toString().padStart(2, '0')} before pause`;
    if (remaining <= 0) clearInterval(spectatorCountdownInterval);
  }, 1000);

  // Hide option buttons
  document.querySelectorAll('.option-btn').forEach(b => b.style.display = 'none');
});

socket.on('spectator_mode_ended', () => {
  document.getElementById('spectator-banner').style.display = 'none';
  const actionInput = document.getElementById('action-input');
  const actionBtn = document.getElementById('btn-send');
  if (actionInput) actionInput.disabled = false;
  if (actionBtn) actionBtn.disabled = false;
  if (spectatorCountdownInterval) clearInterval(spectatorCountdownInterval);
});

socket.on('billing_pause', (data) => {
  // Hard pause — show full-screen overlay
  document.getElementById('spectator-banner').innerHTML = `
    <div style="font-family:'Cinzel Decorative',cursive;font-size:1rem;margin-bottom:8px;">
      Game Paused — Time Expired
    </div>
    <div style="font-size:0.9rem;color:#e8d5b0;margin-bottom:12px;">
      ${data.reason}
    </div>
    <a href="/purchase.html" class="btn btn-primary" style="width:auto;display:inline-block;padding:10px 24px;">
      Add Time to Continue
    </a>
  `;
});
```

---

### Task 14: Host Tab Billing Controls

**Files:**
- Modify: `public/game.html` (add billing section to host/settings tab)

- [ ] **Step 1: Add billing controls to the host settings panel**

In `game.html`, inside the settings/host tab (the panel that contains game configuration options), add a billing section:

```html
<div class="panel-title" style="margin-top:16px;">Billing</div>
<div id="billing-controls">
  <label>Billing Mode</label>
  <select id="billing-mode" style="margin-bottom:8px;">
    <option value="host_pays">Host Pays (you cover all players)</option>
    <option value="player_pays">Each Player Pays</option>
  </select>

  <div style="display:flex;gap:12px;margin-bottom:8px;">
    <div>
      <span style="font-size:0.8rem;color:var(--ink-light);">Your Balance:</span>
      <strong id="host-balance">--</strong>
    </div>
    <div>
      <span style="font-size:0.8rem;color:var(--ink-light);">Session Time:</span>
      <strong id="session-time">0m</strong>
    </div>
  </div>

  <a href="/purchase.html" class="btn btn-primary" style="font-size:0.7rem;">Add Time</a>
</div>
```

- [ ] **Step 2: Add billing controls JavaScript**

```js
// Billing mode selector
document.getElementById('billing-mode')?.addEventListener('change', (e) => {
  socket.emit('set_billing_mode', { mode: e.target.value });
});

socket.on('billing_mode_changed', (data) => {
  const select = document.getElementById('billing-mode');
  if (select) select.value = data.mode;
});

// Update host balance display
function updateHostBalanceDisplay() {
  if (!currentBalance) return;
  const totalMin = currentBalance.free_minutes_remaining + currentBalance.paid_minutes_remaining;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  const el = document.getElementById('host-balance');
  if (el) el.textContent = `${hours}h ${mins}m`;
}
```

- [ ] **Step 3: Add set_billing_mode socket handler to server.js**

```js
socket.on('set_billing_mode', async (data) => {
  const gameId = socket.gameId;
  if (!gameId) return;
  const { mode } = data;
  if (!['host_pays', 'player_pays'].includes(mode)) return;
  await db.pool.query('UPDATE games SET billing_mode = $1 WHERE id = $2', [mode, gameId]);
  io.to(gameId).emit('billing_mode_changed', { mode });
});
```

---

### Task 15: Discord Billing Commands

**Files:**
- Modify: `discord-bot.js` (add `/tt balance` and `/tt addtime` subcommands, add warning DMs)

- [ ] **Step 1: Add balance and addtime subcommands**

In `buildSubcommands`, add:

```js
    .addSubcommand(sub => sub
      .setName('balance')
      .setDescription('Check your remaining playtime'))
    .addSubcommand(sub => sub
      .setName('addtime')
      .setDescription('Get a link to add more playtime'))
```

- [ ] **Step 2: Add handlers for the new subcommands**

```js
  else if (sub === 'balance') {
    await interaction.deferReply({ ephemeral: true });
    // Direct users to web — Discord user ID to TT user mapping needed for direct lookup
    const embed = new EmbedBuilder()
      .setColor(0xC8922A)
      .setTitle('Check Balance')
      .setDescription(`Check your playtime balance at:\nhttps://${process.env.BASE_URL || 'taverntable.ai'}/purchase.html\n\nSign in with Discord to see your balance.`);
    await interaction.editReply({ embeds: [embed] });
  }

  else if (sub === 'addtime') {
    const embed = new EmbedBuilder()
      .setColor(0xC8922A)
      .setTitle('Add Playtime')
      .setDescription(`Purchase more playtime at:\nhttps://${process.env.BASE_URL || 'taverntable.ai'}/purchase.html\n\nPackages:\n- 1 Hour: $1.00\n- 5 Hours: $4.50\n- 20 Hours: $15.00`);
    await interaction.reply({ embeds: [embed] });
  }
```

- [ ] **Step 3: Add billing warning broadcast function to discord-bot.js**

Export a new function for the billing ticker to call:

```js
async function onBillingWarning(gameId, data) {
  await broadcastToChannels(gameId, async (channel) => {
    const level = data.level === 'critical' ? '!!!!' : data.level === 'urgent' ? '!!' : '';
    const color = data.level === 'critical' ? 0xCC4444 : data.level === 'urgent' ? 0xF0A030 : 0xF0C060;
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${data.minutesRemaining} minutes remaining ${level}`)
      .setDescription(`Playtime is running low. [Add time](https://${process.env.BASE_URL || 'taverntable.ai'}/purchase.html) to keep playing.`);
    await channel.send({ embeds: [embed] });
  });
}

async function onSpectatorMode(gameId, data) {
  await broadcastToChannels(gameId, async (channel) => {
    const embed = new EmbedBuilder()
      .setColor(0xCC4444)
      .setTitle('Time Expired — Spectator Mode')
      .setDescription('Claude is now playing for the party. [Add time](https://' +
        (process.env.BASE_URL || 'taverntable.ai') + '/purchase.html) to resume control.\n\nGame will pause in 5 minutes.');
    await channel.send({ embeds: [embed] });
  });
}
```

Add to `module.exports`: `onBillingWarning, onSpectatorMode`

Update `billing.js` to call these Discord functions when emitting warnings and spectator mode events.

---

## PHASE 4 TEST CHECKPOINT

Test these before proceeding:

- [ ] Balance indicator appears in game.html header with correct color coding (green > 30m, yellow 10-30m, red < 10m)
- [ ] Balance updates in real-time as billing ticker deducts (when BILLING_ENABLED=true)
- [ ] Warning banners appear at 30/10/1 minute thresholds and auto-dismiss after 10s
- [ ] Spectator mode banner appears when balance hits 0, with countdown timer
- [ ] Action input and option buttons are disabled during spectator mode
- [ ] Spectator mode ends when balance is replenished (spectator_mode_ended event)
- [ ] Billing pause overlay shows after 5-minute spectator window with "Add Time" link
- [ ] Host billing mode selector saves to DB and syncs across all connected clients
- [ ] Host balance display updates in settings tab
- [ ] Discord `/tt balance` returns link to purchase page
- [ ] Discord `/tt addtime` returns purchase link with product info
- [ ] Discord channels receive billing warning embeds at thresholds
- [ ] Discord channels receive spectator mode announcement

---

## Phase 5: App Store Prep (Task 16)

### Task 16: App Store Documentation + Configuration

**Files:**
- Create: `docs/app-store-prep.md`

This task produces documentation only, no code changes.

- [ ] **Step 1: Document RevenueCat product configuration**

Write `docs/app-store-prep.md` with:

1. **RevenueCat Dashboard Setup**
   - Create project "Tavern Table"
   - Connect Stripe for web billing
   - Product IDs: `playtime_1hr`, `playtime_5hr`, `playtime_20hr`
   - Web prices: $1.00, $4.50, $15.00
   - App store prices: $1.49, $6.99, $22.99
   - Webhook URL: `https://<domain>/api/webhooks/revenuecat`
   - Enable webhook signature verification

2. **PWA Manifest**
   - Create `public/manifest.json` with app name, icons, theme color
   - Add `<link rel="manifest">` to all HTML pages
   - Service worker for offline capability (future)

3. **iOS App Store Checklist**
   - Apple Developer account
   - Sign in with Apple configured (already implemented)
   - App Store Connect product setup matching RevenueCat product IDs
   - App review guidelines compliance (no direct links to web purchase to avoid rejection)
   - In-app purchase pricing at $1.49/hr tier

4. **Google Play Store Checklist**
   - Google Play Console setup
   - Google OAuth configured (already implemented)
   - Google Play Billing integration via RevenueCat
   - Play Store pricing matching RevenueCat product IDs

5. **Cross-Platform Sync**
   - RevenueCat customer ID = Tavern Table user ID
   - Purchases on any platform sync via RevenueCat webhook
   - Balance is stored server-side (single source of truth)

---

## PHASE 5 TEST CHECKPOINT

Test these before proceeding:

- [ ] `docs/app-store-prep.md` is complete and covers all platforms
- [ ] RevenueCat product IDs in documentation match those in `payments.js`
- [ ] PWA manifest exists at `public/manifest.json` (if created)
- [ ] All HTML pages reference the manifest (if created)
