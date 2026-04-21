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

    const token = generateToken(user);
    setTokenCookie(res, token);
    res.json({ user: { id: user.id, email: user.email, displayName: user.display_name, isAdmin: user.is_admin } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/login', loginLimiter, (req, res, next) => {
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

    const sessionToken = generateToken(user);
    setTokenCookie(res, sessionToken);
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

// ── Routes: Google OAuth ────────────────────────────────────────────────────

router.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));
router.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', { session: false }, async (err, user) => {
    try {
      if (err || !user) return res.redirect('/login.html?error=google_failed');
      const token = generateToken(user);
      setTokenCookie(res, token);
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
        } catch { /* ignore JWT decode errors */ }
      }
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
      const token = generateToken(user);
      setTokenCookie(res, token);
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
        } catch { /* ignore JWT decode errors */ }
      }
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
  createAnonymousSession, generateAnonToken,
};
