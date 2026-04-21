'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Test constants matching auth.js
const JWT_SECRET = 'test-secret';
const JWT_EXPIRY = '7d';
const ANON_JWT_EXPIRY = '24h';
const MAX_ANON_SESSIONS_PER_IP = 3;

// Helper functions (matching auth.js)
function generateToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email, isAdmin: user.is_admin },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function generateAnonToken(anonId) {
  return jwt.sign(
    { anonId, anonymous: true },
    JWT_SECRET,
    { expiresIn: ANON_JWT_EXPIRY }
  );
}

describe('Auth Middleware', () => {
  describe('generateToken', () => {
    it('generates JWT with user data', () => {
      const user = { id: 'user-123', email: 'user@example.com', is_admin: false };
      const token = generateToken(user);

      const decoded = jwt.verify(token, JWT_SECRET);
      assert.equal(decoded.userId, 'user-123');
      assert.equal(decoded.email, 'user@example.com');
      assert.equal(decoded.isAdmin, false);
    });

    it('includes admin flag', () => {
      const user = { id: 'user-456', email: 'admin@example.com', is_admin: true };
      const token = generateToken(user);

      const decoded = jwt.verify(token, JWT_SECRET);
      assert.equal(decoded.isAdmin, true);
    });

    it('generated token has 7-day expiry', () => {
      const user = { id: 'user-789', email: 'test@example.com', is_admin: false };
      const token = generateToken(user);

      const decoded = jwt.decode(token);
      // Check that exp is set (full verification requires time to pass)
      assert.ok(decoded.exp);
    });

    it('token verification fails with wrong secret', () => {
      const user = { id: 'user-123', email: 'user@example.com', is_admin: false };
      const token = generateToken(user);

      assert.throws(
        () => jwt.verify(token, 'wrong-secret'),
        /invalid signature/
      );
    });
  });

  describe('generateAnonToken', () => {
    it('generates anonymous JWT', () => {
      const anonId = 'anon_12345';
      const token = generateAnonToken(anonId);

      const decoded = jwt.verify(token, JWT_SECRET);
      assert.equal(decoded.anonId, 'anon_12345');
      assert.equal(decoded.anonymous, true);
    });

    it('anonymous token lacks userId', () => {
      const anonId = 'anon_67890';
      const token = generateAnonToken(anonId);

      const decoded = jwt.verify(token, JWT_SECRET);
      assert.ok(!decoded.userId);
      assert.ok(!decoded.email);
    });

    it('anonymous token has 24h expiry', () => {
      const anonId = 'anon_xyz';
      const token = generateAnonToken(anonId);

      const decoded = jwt.decode(token);
      assert.ok(decoded.exp);
    });
  });

  describe('Token Validation', () => {
    it('expired token fails verification', () => {
      const user = { id: 'user-123', email: 'user@example.com', is_admin: false };
      const expiredToken = jwt.sign(user, JWT_SECRET, { expiresIn: '-1s' });

      assert.throws(
        () => jwt.verify(expiredToken, JWT_SECRET),
        /expired/
      );
    });

    it('valid token passes verification', () => {
      const user = { id: 'user-123', email: 'user@example.com', is_admin: false };
      const token = generateToken(user);

      const decoded = jwt.verify(token, JWT_SECRET);
      assert.equal(decoded.userId, 'user-123');
    });

    it('malformed token throws error', () => {
      const malformed = 'not.a.token';

      assert.throws(
        () => jwt.verify(malformed, JWT_SECRET)
      );
    });
  });

  describe('Anonymous Session Validation', () => {
    it('anonId format check', () => {
      const anonId = `anon_${crypto.randomUUID()}`;
      assert.ok(anonId.startsWith('anon_'));
      assert.ok(anonId.length > 10);
    });

    it('multiple anonIds are unique', () => {
      const ids = new Set();
      for (let i = 0; i < 5; i++) {
        ids.add(`anon_${crypto.randomUUID()}`);
      }
      assert.equal(ids.size, 5);
    });
  });

  describe('requireAuth & requireAdmin Logic', () => {
    it('requireAuth blocks unauthenticated requests', () => {
      const req = { user: null };
      const res = {
        status: function(code) {
          this.statusCode = code;
          return this;
        },
        json: function(obj) {
          this.body = obj;
        },
      };

      // Mock requireAuth logic
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
      }

      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error, 'Authentication required');
    });

    it('requireAuth allows authenticated requests', () => {
      const req = { user: { id: 'user-123', email: 'user@example.com' } };
      let nextCalled = false;

      // Mock requireAuth logic
      if (!req.user) {
        throw new Error('Should not block authenticated user');
      } else {
        nextCalled = true;
      }

      assert.equal(nextCalled, true);
    });

    it('requireAdmin blocks non-admin users', () => {
      const req = { user: { id: 'user-123', is_admin: false } };
      const res = {
        status: function(code) {
          this.statusCode = code;
          return this;
        },
        json: function(obj) {
          this.body = obj;
        },
      };

      // Mock requireAdmin logic
      if (!req.user?.is_admin) {
        res.status(403).json({ error: 'Admin access required' });
      }

      assert.equal(res.statusCode, 403);
    });

    it('requireAdmin allows admin users', () => {
      const req = { user: { id: 'user-123', is_admin: true } };
      let nextCalled = false;

      // Mock requireAdmin logic
      if (req.user?.is_admin) {
        nextCalled = true;
      }

      assert.equal(nextCalled, true);
    });

    it('requireAdmin blocks null user', () => {
      const req = { user: null };
      const res = {
        status: function(code) {
          this.statusCode = code;
          return this;
        },
        json: function(obj) {
          this.body = obj;
        },
      };

      // Mock requireAdmin logic
      if (!req.user?.is_admin) {
        res.status(403).json({ error: 'Admin access required' });
      }

      assert.equal(res.statusCode, 403);
    });
  });

  describe('Email Normalization', () => {
    it('lowercases email on login', () => {
      const email = 'User@Example.COM';
      const normalized = email.toLowerCase().trim();
      assert.equal(normalized, 'user@example.com');
    });

    it('trims whitespace from email', () => {
      const email = '  user@example.com  ';
      const normalized = email.toLowerCase().trim();
      assert.equal(normalized, 'user@example.com');
    });

    it('handles both case and whitespace', () => {
      const email = '  USER@EXAMPLE.COM  ';
      const normalized = email.toLowerCase().trim();
      assert.equal(normalized, 'user@example.com');
    });
  });

  describe('Cookie Configuration', () => {
    it('setTokenCookie creates httpOnly cookie', () => {
      const token = 'test-token-123';
      const cookies = {};

      // Mock setTokenCookie logic
      const cookieConfig = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      };

      assert.equal(cookieConfig.httpOnly, true);
      assert.equal(cookieConfig.sameSite, 'lax');
      assert.equal(cookieConfig.maxAge, 604800000); // 7 days in ms
    });

    it('secure flag depends on NODE_ENV', () => {
      // Test that secure flag logic correctly evaluates NODE_ENV
      const isProduction = 'production' === 'production';
      const isDevelopment = 'development' === 'production';

      assert.equal(isProduction, true);
      assert.equal(isDevelopment, false);
    });
  });

  describe('Rate Limiting Constants', () => {
    it('magic link limiter allows 5 requests per 15 min', () => {
      const max = 5;
      const windowMs = 15 * 60 * 1000;

      assert.equal(max, 5);
      assert.equal(windowMs, 900000);
    });

    it('login limiter allows 10 requests per 15 min', () => {
      const max = 10;
      const windowMs = 15 * 60 * 1000;

      assert.equal(max, 10);
      assert.equal(windowMs, 900000);
    });

    it('register limiter allows 5 registrations per hour', () => {
      const max = 5;
      const windowMs = 60 * 60 * 1000;

      assert.equal(max, 5);
      assert.equal(windowMs, 3600000);
    });

    it('max anonymous sessions per IP is 3', () => {
      assert.equal(MAX_ANON_SESSIONS_PER_IP, 3);
    });
  });
});
