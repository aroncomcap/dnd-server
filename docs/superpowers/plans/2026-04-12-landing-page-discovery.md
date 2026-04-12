# Landing Page & Discovery System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Immersive landing page at `/` with anonymous play flow (soft signup nudges at 30/60/90 min, hard gate at 120 min), 10-hour welcome bonus, and session merge on signup.

**Architecture:** New `landing.html` replaces the lobby at `/`. Current lobby moves to `/lobby`. Anonymous sessions tracked via JWT cookie + `anonymous_sessions` DB table. Billing ticker extended to track anonymous playtime and emit signup nudges. Auth module extended with anonymous session creation and merge-on-signup logic. No new dependencies.

**Tech Stack:** Existing Express/Socket.io/PostgreSQL/JWT stack. No new libraries needed — anonymous JWTs use the same `jsonwebtoken` already in use.

**File changes:**
- Create: `public/landing.html` — marketing/conversion landing page
- Modify: `server.js` — route `/` to landing page, `/lobby` to lobby, anonymous socket handling
- Modify: `db.js` — `anonymous_sessions` table, new DB functions, welcome bonus (600 min)
- Modify: `auth.js` — anonymous session creation, merge-on-signup, export `setTokenCookie`
- Modify: `billing.js` — anonymous playtime tracking, signup nudge events
- Modify: `public/game.html` — signup prompt modal, socket handlers for nudge/gate events

---

## Task 1: DB Schema — Anonymous Sessions Table + Welcome Bonus

**Files:**
- Modify: `db.js`

- [ ] **Step 1: Add `anonymous_sessions` table to `initDB()`**

Add after the `feature_requests` seed block (after line 148), still inside `initDB()`:

```js
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
```

- [ ] **Step 2: Add anonymous session DB functions**

Add before the `module.exports` block:

```js
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
```

- [ ] **Step 3: Change welcome bonus from 300 to 600 minutes**

In `createUser()` (line 276), change the balance insert to credit 600 free minutes:

```js
  // Create balance row if not exists — 600 free minutes welcome bonus (10 hours)
  await pool.query(
    `INSERT INTO user_balances (user_id, free_minutes_remaining) VALUES ($1, 600) ON CONFLICT (user_id) DO NOTHING`,
    [id]
  );
```

- [ ] **Step 4: Export new functions**

Add to `module.exports`:

```js
  createAnonSession,
  getAnonSession,
  updateAnonMinutes,
  convertAnonSession,
  countRecentAnonSessions,
```

- [ ] **Step 5: Commit**

```bash
git add db.js
git commit -m "feat: add anonymous_sessions table and 10hr welcome bonus"
```

---

## Task 2: Auth — Anonymous Session Creation + Merge on Signup

**Files:**
- Modify: `auth.js`

- [ ] **Step 1: Add anonymous session helpers**

Add after the `registerLimiter` block (after line 34), before `JWT_EXPIRY`:

```js
const ANON_JWT_EXPIRY = '24h';
const MAX_ANON_SESSIONS_PER_IP = 3;
```

Add after the `requireAdmin` function (after line 87):

```js
// ── Anonymous Sessions ──────────────────────────────────────────────────────

function generateAnonToken(anonId) {
  return jwt.sign(
    { anonId, anonymous: true },
    JWT_SECRET,
    { expiresIn: ANON_JWT_EXPIRY }
  );
}

async function createAnonymousSession(ip) {
  const count = await db.countRecentAnonSessions(ip);
  if (count >= MAX_ANON_SESSIONS_PER_IP) {
    return { error: 'Too many anonymous sessions. Please create an account.' };
  }
  const id = `anon_${crypto.randomUUID()}`;
  await db.createAnonSession(id, ip);
  const token = generateAnonToken(id);
  return { id, token };
}
```

- [ ] **Step 2: Extend `authMiddleware` to recognize anonymous tokens**

Replace the existing `authMiddleware` function:

```js
async function authMiddleware(req, res, next) {
  const token = req.cookies?.tt_token;
  if (!token) {
    req.user = null;
    req.anonSession = null;
    return next();
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.anonymous) {
      req.user = null;
      req.anonSession = await db.getAnonSession(decoded.anonId);
    } else {
      req.user = await db.getUserById(decoded.userId);
      req.anonSession = null;
    }
    next();
  } catch {
    req.user = null;
    req.anonSession = null;
    next();
  }
}
```

- [ ] **Step 3: Add merge logic to registration route**

In the `POST /auth/register` handler, after `const user = await db.getUserById(id);` (line 188), add merge logic:

```js
    // Merge anonymous session if one exists
    const anonToken = req.cookies?.tt_token;
    if (anonToken) {
      try {
        const decoded = jwt.verify(anonToken, JWT_SECRET);
        if (decoded.anonymous && decoded.anonId) {
          const anonSession = await db.getAnonSession(decoded.anonId);
          if (anonSession && !anonSession.converted_to_user_id) {
            await db.convertAnonSession(decoded.anonId, id);
            // Adjust welcome bonus: subtract anonymous playtime already used
            const minutesUsed = anonSession.minutes_used || 0;
            if (minutesUsed > 0) {
              const remaining = Math.max(0, 600 - minutesUsed);
              await db.pool.query(
                'UPDATE user_balances SET free_minutes_remaining = $1 WHERE user_id = $2',
                [remaining, id]
              );
            }
          }
        }
      } catch { /* invalid anon token — ignore */ }
    }
```

- [ ] **Step 4: Add merge logic to Google OAuth callback**

In the Google OAuth callback (line 228), after `setTokenCookie(res, token);`, add:

```js
    // Merge anonymous session
    const anonCookie = req.cookies?.tt_token;
    if (anonCookie) {
      try {
        const anonDecoded = jwt.verify(anonCookie, JWT_SECRET);
        if (anonDecoded.anonymous && anonDecoded.anonId) {
          const anonSession = await db.getAnonSession(anonDecoded.anonId);
          if (anonSession && !anonSession.converted_to_user_id) {
            await db.convertAnonSession(anonDecoded.anonId, user.id);
            const minutesUsed = anonSession.minutes_used || 0;
            if (minutesUsed > 0) {
              const remaining = Math.max(0, 600 - minutesUsed);
              await db.pool.query(
                'UPDATE user_balances SET free_minutes_remaining = $1 WHERE user_id = $2',
                [remaining, user.id]
              );
            }
          }
        }
      } catch { /* ignore */ }
    }
```

- [ ] **Step 5: Add merge logic to Discord OAuth callback**

Same merge block as Step 4, in the Discord OAuth callback (line 240), after `setTokenCookie(res, token);`.

- [ ] **Step 6: Export new functions and `setTokenCookie`**

Update `module.exports`:

```js
module.exports = {
  router, authMiddleware, requireAuth, requireAdmin,
  generateToken, setTokenCookie, jwtSecret: JWT_SECRET,
  createAnonymousSession, generateAnonToken,
};
```

- [ ] **Step 7: Commit**

```bash
git add auth.js
git commit -m "feat: anonymous session creation and merge-on-signup"
```

---

## Task 3: Server Routes — Landing Page + Lobby + Anonymous Socket Auth

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add landing page route**

Add before the `express.static` line (line 46):

```js
// Landing page at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Lobby (was previously the root)
app.get('/lobby', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
```

- [ ] **Step 2: Add anonymous session API endpoint**

Add near the other API routes (after the `/api/balance` route, around line 1500):

```js
// Create anonymous session (called by game client when no auth)
app.post('/api/anonymous-session', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const { createAnonymousSession, setTokenCookie } = require('./auth');
  const result = await createAnonymousSession(ip);
  if (result.error) {
    return res.status(429).json({ error: result.error });
  }
  // Set the anonymous JWT as cookie
  res.cookie('tt_token', result.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  });
  res.json({ anonId: result.id });
});
```

- [ ] **Step 3: Extend socket auth middleware to handle anonymous JWTs**

In the socket.io auth middleware (around line 1580), extend the JWT decode block:

```js
io.use((socket, next) => {
  const cookieHeader = socket.handshake.headers.cookie;
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').reduce((acc, c) => {
      const [key, val] = c.trim().split('=');
      acc[key] = val;
      return acc;
    }, {});
    const token = cookies['tt_token'];
    if (token) {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET || require('./auth').jwtSecret);
        if (decoded.anonymous) {
          socket.anonId = decoded.anonId;
          socket.userId = null;
        } else {
          socket.userId = decoded.userId;
          socket.userEmail = decoded.email;
          socket.anonId = null;
        }
      } catch (e) {
        // Invalid token — allow connection but mark as unauthenticated
      }
    }
  }
  next();
});
```

- [ ] **Step 4: Block anonymous users past 120 minutes in `player_action` handler**

In the `player_action` handler (around line 1729), add a check before the existing spectator check:

```js
    // Block anonymous users past 120-minute limit
    if (socket.anonId && !socket.userId) {
      const anonSession = await db.getAnonSession(socket.anonId);
      if (anonSession && anonSession.minutes_used >= 120) {
        socket.emit('signup_required', {
          minutesUsed: anonSession.minutes_used,
          message: 'Create a free account to keep playing. It takes 10 seconds.',
        });
        return;
      }
    }
```

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: landing page route, anonymous session endpoint, socket auth"
```

---

## Task 4: Billing Ticker — Anonymous Playtime Tracking + Signup Nudges

**Files:**
- Modify: `billing.js`

- [ ] **Step 1: Add signup nudge thresholds constant**

Add after the existing constants at top of file:

```js
const SIGNUP_NUDGE_THRESHOLDS = [30, 60, 90]; // minutes — soft prompts
const SIGNUP_HARD_GATE = 120;                  // minutes — must sign up
```

- [ ] **Step 2: Add anonymous billing to the `tick()` method**

Add at the beginning of the `tick()` method, after the `connectedCount === 0` check:

```js
    // Track anonymous playtime and emit signup nudges
    const sockets = await this.io.in(gameId).fetchSockets();
    for (const s of sockets) {
      if (s.anonId && !s.userId) {
        await this.db.updateAnonMinutes(s.anonId, 1);
        const anonSession = await this.db.getAnonSession(s.anonId);
        if (!anonSession) continue;
        const used = anonSession.minutes_used;

        // Soft nudges at 30/60/90 min
        if (SIGNUP_NUDGE_THRESHOLDS.includes(used)) {
          s.emit('signup_nudge', {
            minutesUsed: used,
            minutesUntilGate: SIGNUP_HARD_GATE - used,
          });
        }

        // Hard gate at 120 min
        if (used >= SIGNUP_HARD_GATE) {
          s.emit('signup_required', {
            minutesUsed: used,
            message: 'Create a free account to keep playing. It takes 10 seconds.',
          });
        }
      }
    }
```

Place this block right after the `if (connectedCount === 0) return;` line and before the `const game = await this.db.getGame(gameId);` line. The anonymous tracking runs even when billing is disabled (it's about signup gating, not payment).

- [ ] **Step 3: Commit**

```bash
git add billing.js
git commit -m "feat: anonymous playtime tracking and signup nudge events"
```

---

## Task 5: Signup Modal in Game Client

**Files:**
- Modify: `public/game.html`

- [ ] **Step 1: Add signup modal HTML**

Add before the closing `</body>` tag:

```html
<!-- Signup Prompt Modal -->
<div id="signup-modal" style="display:none; position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,0.85); display:none; align-items:center; justify-content:center;">
  <div style="background:#2a1a0a; border:2px solid var(--gold); border-radius:16px; padding:32px; max-width:420px; width:90%; text-align:center;">
    <h2 style="font-family:'Cinzel Decorative',cursive; color:var(--gold-light); font-size:1.3rem; margin-bottom:12px;">Save Your Adventure</h2>
    <p id="signup-modal-text" style="color:var(--parchment); font-size:1rem; margin-bottom:24px;">
      Create a free account to keep your characters, your story, and your 10 free hours.
    </p>
    <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:16px;">
      <a id="signup-google-btn" href="/auth/google" style="display:inline-block; padding:12px 20px; background:#4285f4; color:#fff; border-radius:8px; text-decoration:none; font-weight:600;">Continue with Google</a>
      <a id="signup-discord-btn" href="/auth/discord" style="display:inline-block; padding:12px 20px; background:#5865F2; color:#fff; border-radius:8px; text-decoration:none; font-weight:600;">Continue with Discord</a>
      <a id="signup-email-btn" href="/login.html" style="display:inline-block; padding:12px 20px; background:var(--gold); color:#1a0f05; border-radius:8px; text-decoration:none; font-weight:600;">Sign Up with Email</a>
    </div>
    <button id="signup-dismiss-btn" onclick="document.getElementById('signup-modal').style.display='none'" style="background:none; border:none; color:var(--parchment-dark); cursor:pointer; font-size:0.9rem; text-decoration:underline;">Maybe Later</button>
  </div>
</div>
```

- [ ] **Step 2: Add socket handlers for signup nudge/gate events**

Add in the socket event handlers section (near the other `socket.on` listeners):

```js
socket.on('signup_nudge', (data) => {
  const modal = document.getElementById('signup-modal');
  const text = document.getElementById('signup-modal-text');
  const dismiss = document.getElementById('signup-dismiss-btn');
  dismiss.style.display = 'inline';
  if (data.minutesUsed >= 90) {
    text.textContent = `You've been playing for ${Math.floor(data.minutesUsed / 60)}+ hours! Sign up now — you'll need an account in ${data.minutesUntilGate} minutes to keep playing.`;
  } else if (data.minutesUsed >= 60) {
    text.textContent = 'Enjoying the adventure? Create a free account to save your progress and keep your 10 free hours.';
  } else {
    text.textContent = 'Create a free account to keep your characters, your story, and your 10 free hours.';
  }
  modal.style.display = 'flex';
});

socket.on('signup_required', (data) => {
  const modal = document.getElementById('signup-modal');
  const text = document.getElementById('signup-modal-text');
  const dismiss = document.getElementById('signup-dismiss-btn');
  text.textContent = 'Create a free account to keep playing. It takes 10 seconds.';
  dismiss.style.display = 'none'; // Can't dismiss the hard gate
  modal.style.display = 'flex';
});

socket.on('auth_upgraded', () => {
  document.getElementById('signup-modal').style.display = 'none';
});
```

- [ ] **Step 3: Request anonymous session on page load if not authenticated**

Add to the initialization code that runs on page load (in the existing `DOMContentLoaded` or equivalent init block):

```js
// Check auth status — if not logged in, create anonymous session
async function ensureSession() {
  const resp = await fetch('/auth/me');
  const data = await resp.json();
  if (!data.user) {
    // No auth — create anonymous session
    await fetch('/api/anonymous-session', { method: 'POST' });
  }
}
ensureSession();
```

- [ ] **Step 4: Commit**

```bash
git add public/game.html
git commit -m "feat: signup modal with nudge/gate handlers and anonymous session init"
```

---

## Task 6: Landing Page

**Files:**
- Create: `public/landing.html`

- [ ] **Step 1: Create the landing page**

Create `public/landing.html` with the full immersive design. This is the largest file in the plan — a single-page marketing site with 5 sections:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Tavern Table — Your Story Begins Here</title>
<meta name="description" content="An AI Dungeon Master runs your adventure. Bring friends or go solo. No downloads, no prep. Play free for 10 hours."/>
<link href="https://fonts.googleapis.com/css2?family=Cinzel+Decorative:wght@700&family=Crimson+Pro:ital,wght@0,300;0,400;0,600;1,400&display=swap" rel="stylesheet"/>
<style>
  :root {
    --parchment: #f5ead6;
    --parchment-dark: #e8d5b0;
    --ink: #2c1a0e;
    --ink-light: #5c3d1e;
    --gold: #c8922a;
    --gold-light: #f0c060;
    --red: #8b2020;
    --bg-dark: #1a0f05;
    --shadow: rgba(44,26,14,0.35);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    background: var(--bg-dark);
    font-family: 'Crimson Pro', serif;
    color: var(--parchment);
    overflow-x: hidden;
  }

  /* ── Nav ── */
  nav {
    position: fixed; top: 0; right: 0; z-index: 100;
    padding: 16px 24px;
    display: flex; gap: 16px;
  }
  nav a {
    color: var(--parchment-dark); text-decoration: none; font-size: 0.95rem;
    transition: color 0.2s;
  }
  nav a:hover { color: var(--gold-light); }

  /* ── Hero ── */
  .hero {
    min-height: 100vh;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center;
    padding: 40px 20px;
    background:
      radial-gradient(ellipse at 50% 40%, rgba(200,146,42,0.08) 0%, transparent 60%),
      radial-gradient(ellipse at 20% 80%, #2d1a08 0%, transparent 50%),
      radial-gradient(ellipse at 80% 20%, #2d1a08 0%, transparent 50%),
      var(--bg-dark);
  }
  .hero h1 {
    font-family: 'Cinzel Decorative', cursive;
    font-size: clamp(1.8rem, 5vw, 3.2rem);
    color: var(--gold-light);
    letter-spacing: 0.05em;
    text-shadow: 0 0 40px rgba(200,146,42,0.5);
    margin-bottom: 16px;
  }
  .hero p {
    font-size: clamp(1rem, 2.5vw, 1.3rem);
    color: var(--parchment-dark);
    max-width: 600px;
    line-height: 1.6;
    margin-bottom: 36px;
  }
  .cta {
    display: inline-block;
    padding: 16px 40px;
    background: linear-gradient(135deg, var(--gold), var(--gold-light));
    color: var(--bg-dark);
    font-family: 'Cinzel Decorative', cursive;
    font-size: 1.1rem;
    font-weight: 700;
    text-decoration: none;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(200,146,42,0.4);
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .cta:hover { transform: translateY(-2px); box-shadow: 0 6px 30px rgba(200,146,42,0.6); }

  /* ── Sections ── */
  section { padding: 80px 20px; max-width: 1000px; margin: 0 auto; }
  section h2 {
    font-family: 'Cinzel Decorative', cursive;
    font-size: 1.6rem;
    color: var(--gold-light);
    text-align: center;
    margin-bottom: 48px;
    text-shadow: 0 0 20px rgba(200,146,42,0.3);
  }

  /* ── How It Works ── */
  .steps {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 24px;
  }
  .step-card {
    background: rgba(245,234,214,0.06);
    border: 1px solid rgba(200,146,42,0.2);
    border-radius: 12px;
    padding: 28px 24px;
    text-align: center;
  }
  .step-card .step-num {
    font-family: 'Cinzel Decorative', cursive;
    font-size: 2rem;
    color: var(--gold);
    margin-bottom: 12px;
  }
  .step-card h3 {
    color: var(--gold-light);
    font-size: 1.1rem;
    margin-bottom: 8px;
  }
  .step-card p { color: var(--parchment-dark); font-size: 0.95rem; line-height: 1.5; }

  /* ── Features ── */
  .feature {
    display: flex; align-items: center; gap: 40px;
    margin-bottom: 60px;
  }
  .feature:nth-child(even) { flex-direction: row-reverse; }
  .feature-text { flex: 1; }
  .feature-text h3 {
    font-family: 'Cinzel Decorative', cursive;
    color: var(--gold-light);
    font-size: 1.2rem;
    margin-bottom: 12px;
  }
  .feature-text p { color: var(--parchment-dark); line-height: 1.6; }
  .feature-img {
    flex: 1;
    background: rgba(245,234,214,0.06);
    border: 1px solid rgba(200,146,42,0.15);
    border-radius: 12px;
    min-height: 200px;
    display: flex; align-items: center; justify-content: center;
    color: var(--parchment-dark);
    font-style: italic;
    font-size: 0.9rem;
  }
  @media (max-width: 700px) {
    .feature, .feature:nth-child(even) { flex-direction: column; }
  }

  /* ── Pricing ── */
  .pricing-intro { text-align: center; color: var(--parchment-dark); font-size: 1.1rem; margin-bottom: 32px; line-height: 1.6; }
  .pricing-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 20px;
    max-width: 700px;
    margin: 0 auto;
  }
  .price-card {
    background: rgba(245,234,214,0.06);
    border: 1px solid rgba(200,146,42,0.2);
    border-radius: 12px;
    padding: 24px;
    text-align: center;
    position: relative;
  }
  .price-card.best { border-color: var(--gold); }
  .price-card.best::before {
    content: 'BEST VALUE';
    position: absolute; top: -10px; left: 50%; transform: translateX(-50%);
    background: var(--gold); color: var(--bg-dark);
    font-size: 0.7rem; font-weight: 700; padding: 2px 12px; border-radius: 4px;
  }
  .price-card h3 { color: var(--gold-light); font-size: 1.1rem; margin-bottom: 8px; }
  .price-card .price { font-size: 1.8rem; color: var(--parchment); font-weight: 700; }
  .price-card .rate { color: var(--parchment-dark); font-size: 0.85rem; margin-top: 4px; }

  /* ── Final CTA ── */
  .final-cta {
    text-align: center;
    padding: 80px 20px;
  }
  .final-cta h2 {
    font-family: 'Cinzel Decorative', cursive;
    font-size: 1.6rem;
    color: var(--gold-light);
    margin-bottom: 24px;
    text-shadow: 0 0 20px rgba(200,146,42,0.3);
  }
</style>
</head>
<body>

<nav>
  <a href="/login.html">Login</a>
</nav>

<!-- Hero -->
<div class="hero">
  <h1>Your Story Begins Here</h1>
  <p>An AI Dungeon Master runs your adventure. Bring friends or go solo. No downloads, no prep.</p>
  <a href="/lobby" class="cta">Start Your Adventure</a>
</div>

<!-- How It Works -->
<section>
  <h2>How It Works</h2>
  <div class="steps">
    <div class="step-card">
      <div class="step-num">I</div>
      <h3>Choose Your Character</h3>
      <p>Create a hero from scratch or paste in an existing character sheet. The AI handles the rest.</p>
    </div>
    <div class="step-card">
      <div class="step-num">II</div>
      <h3>The AI Crafts Your Story</h3>
      <p>A living world reacts to every choice. Combat, diplomacy, exploration — all narrated in real time.</p>
    </div>
    <div class="step-card">
      <div class="step-num">III</div>
      <h3>Play With Friends Anywhere</h3>
      <p>Share a link or play from Discord. No scheduling apps, no setup. Just adventure.</p>
    </div>
  </div>
</section>

<!-- Features -->
<section>
  <h2>Your Adventure Awaits</h2>
  <div class="feature">
    <div class="feature-text">
      <h3>Every Choice Matters</h3>
      <p>Pick from suggested actions or type anything you can imagine. The AI adapts the world to your creativity — there are no rails here.</p>
    </div>
    <div class="feature-img">[Screenshot: action options UI]</div>
  </div>
  <div class="feature">
    <div class="feature-text">
      <h3>See Your World</h3>
      <p>Scene images generated on the fly. An auto-drawn map tracks where you've been and what lies ahead.</p>
    </div>
    <div class="feature-img">[Screenshot: scene image + map]</div>
  </div>
  <div class="feature">
    <div class="feature-text">
      <h3>Play From Discord</h3>
      <p>Full gameplay right in your Discord server. Roll dice, make choices, and adventure together without leaving the chat.</p>
    </div>
    <div class="feature-img">[Screenshot: Discord gameplay]</div>
  </div>
  <div class="feature">
    <div class="feature-text">
      <h3>Any System, Any Setting</h3>
      <p>D&amp;D 5th Edition, RuneQuest, or your own homebrew. Upload a PDF and the AI learns your world.</p>
    </div>
    <div class="feature-img">[Screenshot: system selection]</div>
  </div>
</section>

<!-- Pricing -->
<section>
  <h2>Free to Start</h2>
  <p class="pricing-intro">
    10 free hours to start your journey. 5 free hours every month after that.<br/>
    Need more time?
  </p>
  <div class="pricing-cards">
    <div class="price-card">
      <h3>1 Hour</h3>
      <div class="price">$1.00</div>
      <div class="rate">$1.00/hr</div>
    </div>
    <div class="price-card">
      <h3>5 Hours</h3>
      <div class="price">$4.50</div>
      <div class="rate">$0.90/hr</div>
    </div>
    <div class="price-card best">
      <h3>20 Hours</h3>
      <div class="price">$15.00</div>
      <div class="rate">$0.75/hr</div>
    </div>
  </div>
</section>

<!-- Final CTA -->
<div class="final-cta">
  <h2>Your Party Is Waiting</h2>
  <a href="/lobby" class="cta">Start Your Adventure</a>
</div>

</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add public/landing.html
git commit -m "feat: immersive landing page with hero, features, pricing sections"
```

---

## Task 7: Update Lobby + OAuth Redirects

**Files:**
- Modify: `public/index.html`
- Modify: `auth.js`

- [ ] **Step 1: Update lobby page title**

In `public/index.html`, the `<title>` already says "Lobby" which is correct. No change needed to the lobby content — it works as-is at the new `/lobby` route.

- [ ] **Step 2: Update OAuth redirects to go to `/lobby` instead of `/`**

In `auth.js`, the Google and Discord OAuth callbacks currently redirect to `/` (lines 232, 244). Update both:

Google callback (line 232):
```js
    res.redirect('/lobby');
```

Discord callback (line 244):
```js
    res.redirect('/lobby');
```

- [ ] **Step 3: Ensure `express.static` doesn't serve `index.html` at `/`**

The `express.static` middleware auto-serves `index.html` at `/`. Since we added an explicit `app.get('/')` route BEFORE `express.static` in Task 3, our route takes precedence. Verify this by checking that the `app.get('/')` route is defined before `app.use(express.static(...))`.

If the static middleware is somehow first, move the landing page route above it.

- [ ] **Step 4: Commit**

```bash
git add auth.js public/index.html
git commit -m "feat: redirect OAuth callbacks to /lobby, verify route precedence"
```

---

## Task 8: Update References to Free Tier in Codebase

**Files:**
- Modify: `public/purchase.html`
- Modify: `public/admin.html`
- Modify: `db.js`

- [ ] **Step 1: Search for "300" and "5 free" references**

Search codebase for hardcoded references to the old 300-minute / 5-hour free tier and update them to 600/10 for initial signup. The monthly reset stays at 300 — that's correct.

In `db.js`, the `checkAndResetFree` function (line 312) resets to 300. This is correct — monthly refresh is 5 hours.

In `db.js`, the `user_balances` CREATE TABLE (line 75) has `DEFAULT 300`. This default only applies if a row is inserted without specifying `free_minutes_remaining`, which only happens in the `createUser` function (which we already changed in Task 1 to use 600). The DEFAULT in the schema is a fallback — update it for consistency:

```sql
free_minutes_remaining INT DEFAULT 600,
```

- [ ] **Step 2: Update purchase.html free tier copy**

Search `purchase.html` for references to "5 free hours" or "300 minutes" and update to reference the 10-hour welcome bonus. The monthly 5 hours is still accurate for returning users, so messaging should say: "10 free hours to start. 5 free hours every month."

- [ ] **Step 3: Commit**

```bash
git add db.js public/purchase.html public/admin.html
git commit -m "feat: update free tier references to 10hr welcome bonus"
```

---

## Task 9: Integration Testing + Smoke Test

**Files:**
- No new files — manual verification

- [ ] **Step 1: Start the server locally**

```bash
cd /Users/aron/Downloads/dnd-server && node server.js
```

Verify it starts without errors.

- [ ] **Step 2: Test landing page**

Visit `http://localhost:3000/` — should serve the landing page, not the lobby.

- [ ] **Step 3: Test lobby**

Visit `http://localhost:3000/lobby` — should serve the old lobby page.

- [ ] **Step 4: Test anonymous session creation**

```bash
curl -X POST http://localhost:3000/api/anonymous-session -c cookies.txt
```

Should return `{ "anonId": "anon_..." }` and set a cookie.

- [ ] **Step 5: Test the signup modal renders**

Open a game page, verify the signup modal HTML is present in the DOM (hidden by default).

- [ ] **Step 6: Commit final state**

```bash
git add -A
git commit -m "chore: integration verified — landing page + anonymous sessions working"
```
