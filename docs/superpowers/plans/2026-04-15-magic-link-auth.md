# Magic Link Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the lobby behind email-based authentication using magic links, so players can return to their games.

**Architecture:** Add `POST /auth/magic-link` and `GET /auth/magic-link/:token` routes to auth.js. Use Resend for transactional email. Lobby page (`index.html`) shows auth form when unauthenticated, full lobby when authenticated. Game page redirects to lobby if not authenticated. Remove anonymous session system.

**Tech Stack:** Resend (email), JWT (tokens), bcrypt (optional passwords), Express routes

---

### Task 1: Add Resend dependency and DB schema changes

**Files:**
- Modify: `package.json` — add `resend` dependency
- Modify: `db.js:62-71` — add columns to users table, add `findOrCreateUserByEmail` helper

- [ ] **Step 1: Install resend**

```bash
cd "/Users/aron/Dropbox (Personal)/claude/dnd-server"
npm install resend
```

- [ ] **Step 2: Add schema migration columns in db.js**

In `db.js`, after the users table CREATE (around line 71), add:

```javascript
    ALTER TABLE users ADD COLUMN IF NOT EXISTS magic_link_nonce TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS has_password BOOLEAN DEFAULT FALSE;
```

- [ ] **Step 3: Add findOrCreateUserByEmail helper in db.js**

After `getUserById` (line 329), add:

```javascript
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
```

Export all four new functions from the module.exports at the bottom of db.js.

- [ ] **Step 4: Verify syntax**

```bash
node -c db.js
```

Expected: no output (syntax OK)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json db.js
git commit -m "feat: add resend dep, magic_link_nonce/has_password columns, findOrCreateUserByEmail helper"
```

---

### Task 2: Add magic link routes to auth.js

**Files:**
- Modify: `auth.js` — add `POST /auth/magic-link`, `GET /auth/magic-link/:token`, `POST /auth/set-password`

- [ ] **Step 1: Add Resend import and rate limiter at top of auth.js**

After the existing imports (line 15), add:

```javascript
const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
```

After `registerLimiter` (line 34), add:

```javascript
const magicLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // 5 magic link requests per 15 min per IP
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
});
```

- [ ] **Step 2: Add POST /auth/magic-link route**

After the `/auth/me` route (line 279), add:

```javascript
// ── Magic Link Auth ──────────────────────────────────────────────────────────

router.post('/auth/magic-link', magicLinkLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

    const user = await db.findOrCreateUserByEmail(email);
    const nonce = crypto.randomBytes(16).toString('hex');
    await db.setMagicLinkNonce(user.id, nonce);

    const token = jwt.sign(
      { email: user.email, nonce, purpose: 'magic-link' },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const link = `${baseUrl}/auth/magic-link/${token}`;

    if (resend) {
      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'Tavern Table <onboarding@resend.dev>',
        to: user.email,
        subject: 'Your Tavern Table login link',
        html: `<p>Click to log in to Tavern Table:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes.</p>`,
      });
    } else {
      // Dev mode: log link to console
      console.log(`[magic-link] ${user.email}: ${link}`);
    }

    res.json({ ok: true, message: 'Check your email for a login link.' });
  } catch (err) {
    console.error('Magic link error:', err.message);
    res.status(500).json({ error: 'Failed to send login link' });
  }
});
```

- [ ] **Step 3: Add GET /auth/magic-link/:token route**

```javascript
router.get('/auth/magic-link/:token', async (req, res) => {
  try {
    const decoded = jwt.verify(req.params.token, JWT_SECRET);
    if (decoded.purpose !== 'magic-link') return res.redirect('/lobby?error=invalid_link');

    const user = await db.getUserByEmail(decoded.email);
    if (!user) return res.redirect('/lobby?error=invalid_link');
    if (user.magic_link_nonce !== decoded.nonce) return res.redirect('/lobby?error=link_used');

    // Clear nonce (single-use)
    await db.clearMagicLinkNonce(user.id);

    const sessionToken = generateToken(user);
    setTokenCookie(res, sessionToken);
    res.redirect('/lobby');
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.redirect('/lobby?error=link_expired');
    res.redirect('/lobby?error=invalid_link');
  }
});
```

- [ ] **Step 4: Add POST /auth/set-password route**

```javascript
router.post('/auth/set-password', async (req, res) => {
  // Requires existing auth
  const token = req.cookies?.tt_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.anonymous || !decoded.userId) return res.status(401).json({ error: 'Not authenticated' });

    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await db.setUserPassword(decoded.userId, passwordHash);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 5: Update /auth/me to include has_password**

In the `/auth/me` route (line 269-279), update the response to include `hasPassword`:

```javascript
router.get('/auth/me', authMiddleware, (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      displayName: req.user.display_name,
      isAdmin: req.user.is_admin,
      hasPassword: req.user.has_password || false,
    },
  });
});
```

- [ ] **Step 6: Verify syntax**

```bash
node -c auth.js
```

- [ ] **Step 7: Commit**

```bash
git add auth.js
git commit -m "feat: add magic link send/verify routes, set-password route, hasPassword in /auth/me"
```

---

### Task 3: Protect routes in server.js

**Files:**
- Modify: `server.js:131-133` — add auth redirect to game page
- Modify: `server.js:1976` — add requireAuth to POST /api/games
- Modify: `server.js:2368-2378` — remove anonymous session endpoint

- [ ] **Step 1: Add auth redirect to game page route**

Change `server.js:2434`:

```javascript
// Before:
app.get('/game/:gameId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

// After:
app.get('/game/:gameId', (req, res) => {
  if (!req.user) return res.redirect('/lobby');
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});
```

- [ ] **Step 2: Add requireAuth to POST /api/games**

Change `server.js:1976`:

```javascript
// Before:
app.post('/api/games', authMiddleware, async (req, res) => {

// After:
app.post('/api/games', requireAuth, async (req, res) => {
```

Also update the `hostId` line inside to remove anonymous fallback:

```javascript
// Before:
const hostId = req.user?.id || req.anonSession?.id || null;

// After:
const hostId = req.user.id;
```

- [ ] **Step 3: Remove anonymous session endpoint**

Delete or comment out the `POST /api/anonymous-session` block at `server.js:2368-2378`:

```javascript
// REMOVED: anonymous session creation — all users must authenticate
// app.post('/api/anonymous-session', async (req, res) => { ... });
```

- [ ] **Step 4: Clean up GET /api/games to remove anonymous fallback**

Change `server.js:1960`:

```javascript
// Before:
const userId = req.user?.id || req.anonSession?.id || null;

// After:
const userId = req.user?.id || null;
```

- [ ] **Step 5: Verify syntax**

```bash
node -c server.js
```

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: gate game page behind auth, requireAuth on game creation, remove anonymous session endpoint"
```

---

### Task 4: Rewrite lobby page with auth gate

**Files:**
- Modify: `public/index.html` — two-state lobby (auth form vs. authenticated lobby)

- [ ] **Step 1: Add auth gate section before the lobby content**

After the `<header>` tag, add a new `<div id="auth-gate">` section that shows when not authenticated. This contains:

```html
<div id="auth-gate" style="display:none; max-width:400px; width:100%;">
  <div class="panel" style="padding:24px;">
    <h2 style="font-family:'Cinzel Decorative',cursive;color:var(--gold-light);text-align:center;margin-bottom:16px;">Enter the Tavern</h2>

    <div id="auth-error" style="display:none;color:var(--red);background:rgba(139,32,32,0.1);padding:8px 12px;border-radius:8px;margin-bottom:12px;font-size:0.9rem;"></div>
    <div id="auth-success" style="display:none;color:#2a6;background:rgba(42,166,100,0.1);padding:8px 12px;border-radius:8px;margin-bottom:12px;font-size:0.9rem;"></div>

    <form id="magic-link-form">
      <input type="email" id="auth-email" placeholder="your@email.com" required
        style="width:100%;padding:10px 12px;border:1px solid var(--gold);border-radius:8px;background:var(--parchment);color:var(--ink);font-size:1rem;margin-bottom:8px;font-family:'Crimson Pro',serif;" />
      <div id="password-row" style="display:none;margin-bottom:8px;">
        <input type="password" id="auth-password" placeholder="Password"
          style="width:100%;padding:10px 12px;border:1px solid var(--gold);border-radius:8px;background:var(--parchment);color:var(--ink);font-size:1rem;font-family:'Crimson Pro',serif;" />
      </div>
      <button type="submit" id="btn-magic-link"
        style="width:100%;padding:10px;background:var(--gold);color:var(--ink);border:none;border-radius:8px;font-family:'Cinzel Decorative',cursive;font-size:1rem;cursor:pointer;">
        Send Magic Link
      </button>
      <button type="button" id="btn-password-login" style="display:none;width:100%;padding:10px;background:var(--gold);color:var(--ink);border:none;border-radius:8px;font-family:'Cinzel Decorative',cursive;font-size:1rem;cursor:pointer;margin-top:6px;">
        Login with Password
      </button>
    </form>

    <div style="text-align:center;color:var(--parchment-dark);margin:12px 0;font-size:0.85rem;">— or —</div>

    <div style="display:flex;gap:8px;">
      <a href="/auth/google" style="flex:1;display:block;text-align:center;padding:10px;background:#4285F4;color:white;border-radius:8px;text-decoration:none;font-size:0.9rem;">Google</a>
      <a href="/auth/discord" style="flex:1;display:block;text-align:center;padding:10px;background:#5865F2;color:white;border-radius:8px;text-decoration:none;font-size:0.9rem;">Discord</a>
    </div>

    <p style="text-align:center;color:var(--parchment-dark);font-size:0.8rem;margin-top:12px;">
      Enter your email to get a login link. No password needed.
    </p>
  </div>
</div>
```

- [ ] **Step 2: Wrap existing lobby content in a container**

Wrap the existing create-game panel and games list in `<div id="lobby-content" style="display:none;">...</div>`.

- [ ] **Step 3: Replace ensureSession and checkAuth with unified auth check**

Remove the existing `ensureSession()` and `checkAuth()` functions. Replace with:

```javascript
(async function initLobby() {
  const authGate = document.getElementById('auth-gate');
  const lobbyContent = document.getElementById('lobby-content');
  const bar = document.getElementById('auth-bar');

  try {
    const resp = await fetch('/auth/me');
    const data = await resp.json();

    if (data.user) {
      // Authenticated — show lobby
      authGate.style.display = 'none';
      lobbyContent.style.display = 'block';
      bar.innerHTML = `
        <span class="user-name">${data.user.email}</span>
        ${!data.user.hasPassword ? '<a href="#" id="btn-set-pw">Set Password</a>' : ''}
        <a href="/help">Help</a>
        <button id="btn-logout">Logout</button>
      `;
      document.getElementById('btn-logout')?.addEventListener('click', async () => {
        await fetch('/auth/logout', { method: 'POST' });
        window.location.reload();
      });
      document.getElementById('btn-set-pw')?.addEventListener('click', (e) => {
        e.preventDefault();
        const pw = prompt('Set a password (min 8 characters):');
        if (pw && pw.length >= 8) {
          fetch('/auth/set-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pw }),
          }).then(r => r.json()).then(d => {
            if (d.ok) alert('Password set! You can now log in with email + password.');
            else alert(d.error || 'Failed');
          });
        } else if (pw) {
          alert('Password must be at least 8 characters.');
        }
      });
      loadGames();
    } else {
      // Not authenticated — show auth gate
      authGate.style.display = 'block';
      lobbyContent.style.display = 'none';
      bar.innerHTML = '<a href="/help">Help</a>';
    }
  } catch {
    authGate.style.display = 'block';
    lobbyContent.style.display = 'none';
  }

  // Check URL params for magic link errors
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');
  if (error) {
    const errEl = document.getElementById('auth-error');
    const messages = {
      link_expired: 'That login link has expired. Request a new one.',
      link_used: 'That login link has already been used. Request a new one.',
      invalid_link: 'Invalid login link. Request a new one.',
    };
    errEl.textContent = messages[error] || 'Login failed. Try again.';
    errEl.style.display = 'block';
    authGate.style.display = 'block';
    // Clean URL
    window.history.replaceState({}, '', '/lobby');
  }
})();
```

- [ ] **Step 4: Add magic link form handler**

```javascript
document.getElementById('magic-link-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('auth-email').value.trim();
  if (!email) return;

  const btn = document.getElementById('btn-magic-link');
  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    const res = await fetch('/auth/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (res.ok) {
      document.getElementById('auth-success').textContent = 'Check your email for a login link!';
      document.getElementById('auth-success').style.display = 'block';
      document.getElementById('auth-error').style.display = 'none';
    } else {
      document.getElementById('auth-error').textContent = data.error || 'Failed to send link.';
      document.getElementById('auth-error').style.display = 'block';
    }
  } catch {
    document.getElementById('auth-error').textContent = 'Network error. Try again.';
    document.getElementById('auth-error').style.display = 'block';
  }

  btn.disabled = false;
  btn.textContent = 'Send Magic Link';
});

// Password login (shown for users with has_password)
document.getElementById('btn-password-login')?.addEventListener('click', async () => {
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  if (!email || !password) return;

  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) {
      window.location.reload();
    } else {
      const data = await res.json();
      document.getElementById('auth-error').textContent = data.error + ' Send a magic link instead?';
      document.getElementById('auth-error').style.display = 'block';
    }
  } catch {
    document.getElementById('auth-error').textContent = 'Network error.';
    document.getElementById('auth-error').style.display = 'block';
  }
});
```

- [ ] **Step 5: Verify the page loads without JS errors**

Open `https://dnd-server-production-9b61.up.railway.app/lobby` in a browser and check the console for errors.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat: lobby auth gate — email/magic-link required before game access"
```

---

### Task 5: Add auth check to game.html

**Files:**
- Modify: `public/game.html` — redirect to lobby if not authenticated

- [ ] **Step 1: Add auth check at the top of the script section**

Early in the `<script>` block in game.html (before the socket connection), add:

```javascript
// Auth gate — redirect to lobby if not logged in
(async () => {
  try {
    const res = await fetch('/auth/me');
    const data = await res.json();
    if (!data.user) {
      window.location.href = '/lobby';
      return;
    }
  } catch {
    window.location.href = '/lobby';
    return;
  }
})();
```

This is a client-side fallback — the server route already redirects in Task 3, but this catches direct socket.io connections.

- [ ] **Step 2: Commit**

```bash
git add public/game.html
git commit -m "feat: game page auth check — redirect to lobby if not authenticated"
```

---

### Task 6: Add RESEND_API_KEY to Railway and test end-to-end

**Files:** None (env var + manual test)

- [ ] **Step 1: Sign up for Resend and get API key**

Go to https://resend.com, create account, get API key from dashboard.

- [ ] **Step 2: Add env var to Railway**

```bash
cd "/Users/aron/Dropbox (Personal)/claude/dnd-server"
railway variables --set "RESEND_API_KEY=re_xxxxx" --service dnd-server
railway variables --set "BASE_URL=https://dnd-server-production-9b61.up.railway.app" --service dnd-server
```

- [ ] **Step 3: Deploy**

```bash
git push origin main
railway up --detach --service dnd-server
```

- [ ] **Step 4: Test the full flow**

1. Open `/lobby` — should see auth gate (email field, Google/Discord buttons)
2. Enter a test email → click "Send Magic Link"
3. Check email for magic link
4. Click link → should redirect to `/lobby` authenticated
5. Create a game → should work
6. Open `/game/<id>` in incognito → should redirect to `/lobby`
7. Log out → should return to auth gate
8. Log back in with same email → should see existing games

- [ ] **Step 5: Commit any fixes from testing**

```bash
git add -A
git commit -m "fix: auth flow adjustments from end-to-end testing"
```

---

### Task 7: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` — document new auth system

- [ ] **Step 1: Update the Auth System section in CLAUDE.md**

Replace the existing Auth System section with:

```markdown
## Auth System
- **Primary:** Magic link (enter email → get link → click → authenticated)
- **Optional:** Password (user can set one after first login for faster access)
- **OAuth:** Google, Discord (same as before)
- **No anonymous access** — lobby is gated, game pages redirect to lobby
- JWT tokens stored in `tt_token` cookie (7-day expiry, httpOnly)
- Magic link tokens: JWT with 15-minute expiry, single-use (nonce in DB)
- Routes: `POST /auth/magic-link`, `GET /auth/magic-link/:token`, `POST /auth/set-password`
- Rate limit: 5 magic link requests per 15 min per IP
- Email: Resend (`RESEND_API_KEY` env var). Falls back to console.log in dev.
```

- [ ] **Step 2: Add RESEND_API_KEY to env vars table**

Add to the Environment Variables table:

```markdown
| `RESEND_API_KEY` | Resend email service | For magic links |
| `BASE_URL` | Server URL for magic links | Recommended |
| `EMAIL_FROM` | Sender email address | Optional |
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with magic link auth system"
```
