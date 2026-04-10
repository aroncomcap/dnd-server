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

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
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

// ── Middleware: attach user to request from JWT cookie (non-blocking) ────────

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

// ── Passport: Discord Strategy ──────────────────────────────────────────────

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

// ── Routes: Email/Password ──────────────────────────────────────────────────

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

// ── Routes: Google OAuth ────────────────────────────────────────────────────

router.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));
router.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', { session: false }, (err, user) => {
    if (err || !user) return res.redirect('/login.html?error=google_failed');
    const token = generateToken(user);
    setTokenCookie(res, token);
    res.redirect('/');
  })(req, res, next);
});

// ── Routes: Discord OAuth ───────────────────────────────────────────────────

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
