// auth.js — Passport.js auth module for Tavern Table
// Supports: email/password (bcrypt), Google OAuth, Discord OAuth
// NOTE: Apple OAuth (passport-apple) is intentionally skipped for now —
//   Apple Sign-In requires a paid Apple Developer account, domain verification,
//   and a complex key/certificate setup. Can be added later.

const express = require('express');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const DiscordStrategy = require('passport-discord').Strategy;
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./db');
const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const rateLimit = require('express-rate-limit');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 registrations per hour per IP
  message: { error: 'Too many registrations. Try again later.' },
  standardHeaders: true,
});

const magicLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
});

const ANON_JWT_EXPIRY = '24h';
const MAX_ANON_SESSIONS_PER_IP = 3;

const JWT_EXPIRY = '7d';
const PERSISTENT_LOGIN_MAX_AGE_MS = parseInt(
  process.env.LOGIN_COOKIE_MAX_AGE_MS || String(10 * 365 * 24 * 60 * 60 * 1000),
  10
);
const BCRYPT_ROUNDS = 12;
const WELCOME_BONUS_MINUTES = 600;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function mergeAnonymousSession(req, userId) {
  if (!req.cookies?.tt_token) return;
  try {
    const decoded = jwt.verify(req.cookies.tt_token, JWT_SECRET);
    if (decoded.anonymous && decoded.anonId) {
      const anonSession = await db.getAnonSession(decoded.anonId);
      if (anonSession && !anonSession.converted_to_user_id) {
        await db.convertAnonSession(decoded.anonId, userId);
        // Adjust welcome bonus: subtract anonymous playtime already used
        const minutesUsed = anonSession.minutes_used || 0;
        if (minutesUsed > 0) {
          const remaining = Math.max(0, WELCOME_BONUS_MINUTES - minutesUsed);
          await db.pool.query(
            'UPDATE user_balances SET free_minutes_remaining = $1 WHERE user_id = $2',
            [remaining, userId]
          );
        }
      }
    }
  } catch { /* invalid anon token — ignore */ }
}


function generateToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email, isAdmin: user.is_admin },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function shouldUseSecureCookie() {
  if (process.env.COOKIE_SECURE === 'false') return false;
  if (process.env.COOKIE_SECURE === 'true') return true;
  return process.env.NODE_ENV === 'production' ||
    Boolean(process.env.RAILWAY_ENVIRONMENT) ||
    (process.env.BASE_URL || '').startsWith('https://');
}

function getTokenCookieOptions({ includeMaxAge = true } = {}) {
  const options = {
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'lax',
    path: '/',
  };
  if (includeMaxAge) options.maxAge = PERSISTENT_LOGIN_MAX_AGE_MS;
  return options;
}

function setTokenCookie(res, token) {
  res.cookie('tt_token', token, getTokenCookieOptions());
}

function createPersistentSessionToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function hashAuthSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function issuePersistentLogin(res, user) {
  const token = createPersistentSessionToken();
  await db.createAuthSession({
    id: crypto.randomUUID(),
    userId: user.id,
    tokenHash: hashAuthSessionToken(token),
  });
  setTokenCookie(res, token);
  return token;
}

async function resolveAuthToken(token) {
  if (!token) return { user: null, anonSession: null };

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.anonymous) {
      return {
        user: null,
        anonSession: await db.getAnonSession(decoded.anonId),
        decoded,
      };
    }
    return {
      user: await db.getUserById(decoded.userId),
      anonSession: null,
      decoded,
    };
  } catch {
    // Fall through to persistent opaque sessions.
  }

  const tokenHash = hashAuthSessionToken(token);
  const session = await db.getAuthSessionByHash(tokenHash);
  if (!session) return { user: null, anonSession: null };

  const user = await db.getUserById(session.user_id);
  if (!user) return { user: null, anonSession: null };
  await db.touchAuthSession(tokenHash);
  return { user, anonSession: null, session };
}

async function logout(req, res) {
  const token = req.cookies?.tt_token;
  if (token) {
    try {
      await db.revokeAuthSession(hashAuthSessionToken(token));
    } catch (err) {
      console.warn('Failed to revoke auth session during logout:', err.message);
    }
  }
  res.clearCookie('tt_token', getTokenCookieOptions({ includeMaxAge: false }));
  res.json({ ok: true });
}

// ── Middleware: attach user to request from JWT cookie (non-blocking) ────────

async function authMiddleware(req, res, next) {
  const token = req.cookies?.tt_token;
  if (!token) {
    req.user = null;
    req.anonSession = null;
    return next();
  }
  try {
    const resolved = await resolveAuthToken(token);
    req.user = resolved.user;
    req.anonSession = resolved.anonSession;
    next();
  } catch {
    req.user = null;
    req.anonSession = null;
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

// ── Passport: Local Strategy (email/password) ────────────────────────────────

passport.use(new LocalStrategy(
  { usernameField: 'email' },
  async (email, password, done) => {
    try {
      const user = await db.getUserByEmail(email.toLowerCase().trim());
      if (!user) return done(null, false, { message: 'Invalid email or password' });
      if (!user.password_hash) return done(null, false, { message: 'Account uses OAuth — try Google or Discord' });
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
    callbackURL: (process.env.BASE_URL || 'https://theystillsing.com') + '/auth/google/callback',
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

// ── Passport: Discord Strategy ──────────────────────────────────────────────

if (process.env.DISCORD_CLIENT_ID) {
  passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: (process.env.BASE_URL || 'https://theystillsing.com') + '/auth/discord/callback',
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

// ── Routes: Email/Password ──────────────────────────────────────────────────

router.post('/auth/register', registerLimiter, async (req, res) => {
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

    // Merge anonymous session if one exists
    await mergeAnonymousSession(req, id);

    await issuePersistentLogin(res, user);
    res.json({ user: { id: user.id, email: user.email, displayName: user.display_name, isAdmin: user.is_admin } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/login', loginLimiter, (req, res, next) => {
  passport.authenticate('local', { session: false }, async (err, user, info) => {
    try {
      if (err) return res.status(500).json({ error: err.message });
      if (!user) return res.status(401).json({ error: info?.message || 'Invalid credentials' });
      await issuePersistentLogin(res, user);
      res.json({ user: { id: user.id, email: user.email, displayName: user.display_name, isAdmin: user.is_admin } });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  })(req, res, next);
});

router.post('/auth/logout', logout);

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

// ── Magic Link Auth ──────────────────────────────────────────────────────────

router.post('/auth/magic-link', magicLinkLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

    if (!resend) return res.status(503).json({ error: 'Email service not configured. Please use password login or OAuth.' });

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

    try {
      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'Tavern Table <onboarding@resend.dev>',
        to: user.email,
        subject: 'Your Tavern Table login link',
        html: `<p>Click to log in to Tavern Table:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes.</p>`,
      });
    } catch (emailErr) {
      console.error('Email send error:', emailErr.message);
      return res.status(500).json({ error: 'Failed to send email. Please try again.' });
    }

    res.json({ ok: true, message: 'Check your email for a login link.' });
  } catch (err) {
    console.error('Magic link error:', err.message);
    res.status(500).json({ error: 'Failed to process magic link request' });
  }
});

router.get('/auth/magic-link/:token', async (req, res) => {
  try {
    const decoded = jwt.verify(req.params.token, JWT_SECRET);
    if (decoded.purpose !== 'magic-link') return res.redirect('/lobby?error=invalid_link');

    const user = await db.getUserByEmail(decoded.email);
    if (!user) return res.redirect('/lobby?error=invalid_link');
    if (user.magic_link_nonce !== decoded.nonce) return res.redirect('/lobby?error=link_used');

    await db.clearMagicLinkNonce(user.id);

    await issuePersistentLogin(res, user);
    res.redirect('/lobby');
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.redirect('/lobby?error=link_expired');
    res.redirect('/lobby?error=invalid_link');
  }
});

// ── Forgot Password Routes ───────────────────────────────────────────────────

router.post('/auth/forgot-password', magicLinkLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

    if (!resend) return res.status(503).json({ error: 'Email service not configured. Please contact support.' });

    const user = await db.getUserByEmail(email.toLowerCase().trim());
    if (!user) {
      // Don't reveal if email exists — for security
      return res.json({ ok: true, message: 'If that email exists, you will receive a password reset link.' });
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    await db.setPasswordResetNonce(user.id, nonce);

    const token = jwt.sign(
      { email: user.email, nonce, purpose: 'password-reset' },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const link = `${baseUrl}/reset-password.html?token=${token}`;

    try {
      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'Tavern Table <onboarding@resend.dev>',
        to: user.email,
        subject: 'Reset your Tavern Table password',
        html: `<p>Click to reset your password:</p><p><a href="${link}">Reset Password</a></p><p>This link expires in 15 minutes.</p>`,
      });
    } catch (emailErr) {
      console.error('Email send error:', emailErr.message);
      return res.status(500).json({ error: 'Failed to send email. Please try again.' });
    }

    res.json({ ok: true, message: 'If that email exists, you will receive a password reset link.' });
  } catch (err) {
    console.error('Forgot password error:', err.message);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

router.post('/auth/reset-password/:token', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const decoded = jwt.verify(req.params.token, JWT_SECRET);
    if (decoded.purpose !== 'password-reset') return res.status(400).json({ error: 'Invalid reset link' });

    const user = await db.getUserByEmail(decoded.email);
    if (!user) return res.status(400).json({ error: 'Invalid reset link' });
    if (user.password_reset_nonce !== decoded.nonce) return res.status(400).json({ error: 'Reset link has already been used' });

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await db.setUserPassword(user.id, passwordHash);
    await db.clearPasswordResetNonce(user.id);

    res.json({ ok: true, message: 'Password reset successfully. You can now log in.' });
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(400).json({ error: 'Reset link has expired' });
    console.error('Reset password error:', err.message);
    res.status(400).json({ error: 'Invalid reset link' });
  }
});

router.post('/auth/set-password', async (req, res) => {
  const token = req.cookies?.tt_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const { user } = await resolveAuthToken(token);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await db.setUserPassword(user.id, passwordHash);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Routes: Google OAuth ────────────────────────────────────────────────────

router.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));
router.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', { session: false }, async (err, user) => {
    try {
      if (err || !user) return res.redirect('/login.html?error=google_failed');
      await issuePersistentLogin(res, user);
      // Merge anonymous session
      await mergeAnonymousSession(req, user.id);
      res.redirect('/lobby');
    } catch (error) {
      console.error('Google OAuth callback error:', error.message);
      res.redirect('/login.html?error=google_failed');
    }
  })(req, res, next);
});

// ── Routes: Discord OAuth ───────────────────────────────────────────────────

router.get('/auth/discord', passport.authenticate('discord', { session: false }));
router.get('/auth/discord/callback', (req, res, next) => {
  passport.authenticate('discord', { session: false }, async (err, user) => {
    try {
      if (err || !user) return res.redirect('/login.html?error=discord_failed');
      await issuePersistentLogin(res, user);
      // Merge anonymous session
      await mergeAnonymousSession(req, user.id);
      res.redirect('/lobby');
    } catch (error) {
      console.error('Discord OAuth callback error:', error.message);
      res.redirect('/login.html?error=discord_failed');
    }
  })(req, res, next);
});

module.exports = {
  router, authMiddleware, requireAuth, requireAdmin,
  generateToken, setTokenCookie, jwtSecret: JWT_SECRET,
  issuePersistentLogin, resolveAuthToken, logout, hashAuthSessionToken,
  getTokenCookieOptions,
  createAnonymousSession, generateAnonToken,
};
