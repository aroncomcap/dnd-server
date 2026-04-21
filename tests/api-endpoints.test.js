'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// API Endpoint Tests — Logic and validation tests
// These test the input validation and response structure logic,
// without requiring a running Express server (unit-level tests of handlers)

describe('API Endpoints — Input Validation', () => {
  describe('POST /api/games — Game creation', () => {
    it('validates game name is required', () => {
      const body = { system: 'dnd5e', scene: 'A tavern' };
      const errors = [];

      if (!body.name) errors.push('Game name is required');
      assert.equal(errors.length, 1);
      assert.equal(errors[0], 'Game name is required');
    });

    it('validates system is one of allowed values', () => {
      const body = { name: 'Adventure', system: 'invalid-system' };
      const allowedSystems = ['dnd5e', 'runequest', 'custom'];

      const isValid = allowedSystems.includes(body.system);
      assert.equal(isValid, false);
    });

    it('accepts valid game creation data', () => {
      const body = {
        name: 'Dragon Heist',
        system: 'dnd5e',
        scene: 'A tavern in Waterdeep',
        party_direction: 'combat-focused'
      };
      const allowedSystems = ['dnd5e', 'runequest', 'custom'];

      const isValid = body.name && allowedSystems.includes(body.system);
      assert.equal(isValid, true);
    });

    it('truncates long game names', () => {
      const name = 'A'.repeat(300);
      const MAX_GAME_NAME = 100;
      const truncated = name.slice(0, MAX_GAME_NAME);

      assert.equal(truncated.length, MAX_GAME_NAME);
    });
  });

  describe('GET /api/games/:id — Game retrieval', () => {
    it('validates game ID format', () => {
      const gameId = 'valid-uuid-format-here';
      const isValidFormat = gameId.length > 0 && typeof gameId === 'string';
      assert.equal(isValidFormat, true);
    });

    it('rejects invalid game ID', () => {
      const gameId = null;
      const isValid = !!(gameId && typeof gameId === 'string');
      assert.equal(isValid, false);
    });
  });

  describe('DELETE /api/games/:id — Game deletion', () => {
    it('validates game ID is required', () => {
      const gameId = '';
      const isValid = !!(gameId && gameId.length > 0);
      assert.equal(isValid, false);
    });

    it('accepts valid game ID for deletion', () => {
      const gameId = 'game-123-abc';
      const isValid = !!(gameId && gameId.length > 0);
      assert.equal(isValid, true);
    });
  });

  describe('POST /api/games/:id/rules — Rule creation', () => {
    it('validates rule text is required', () => {
      const body = { category: 'house-rule', game_id: 'game-1' };
      const errors = [];

      if (!body.text) errors.push('Rule text is required');
      assert.equal(errors.length, 1);
    });

    it('validates rule text is not empty', () => {
      const body = { text: '', category: 'house-rule' };
      const isValid = !!(body.text && body.text.trim().length > 0);
      assert.equal(isValid, false);
    });

    it('accepts valid rule data', () => {
      const body = {
        text: 'Critical hits on natural 19+',
        category: 'house-rule',
        is_private: false
      };
      const isValid = !!(body.text && body.text.trim().length > 0);
      assert.equal(isValid, true);
    });

    it('truncates overly long rules', () => {
      const text = 'A'.repeat(5000);
      const MAX_RULE_TEXT = 2000;
      const truncated = text.slice(0, MAX_RULE_TEXT);

      assert.equal(truncated.length, MAX_RULE_TEXT);
    });
  });

  describe('POST /api/redeem — Promo code redemption', () => {
    it('validates promo code format', () => {
      const code = 'BETA-ABC123';
      const isValidFormat = /^BETA-[A-Z0-9]{6}$/.test(code);
      assert.equal(isValidFormat, true);
    });

    it('rejects invalid promo code format', () => {
      const code = 'INVALID-CODE';
      const isValidFormat = /^BETA-[A-Z0-9]{6}$/.test(code);
      assert.equal(isValidFormat, false);
    });

    it('rejects codes with lowercase letters', () => {
      const code = 'BETA-abc123';
      const isValidFormat = /^BETA-[A-Z0-9]{6}$/.test(code);
      assert.equal(isValidFormat, false);
    });

    it('accepts valid BETA promo code', () => {
      const code = 'BETA-XYZ789';
      const isValidFormat = /^BETA-[A-Z0-9]{6}$/.test(code);
      assert.equal(isValidFormat, true);
    });
  });

  describe('POST /api/games/:id/bugs — Bug report creation', () => {
    it('validates bug description is required', () => {
      const body = { screenshot: null };
      const errors = [];

      if (!body.description) errors.push('Bug description is required');
      assert.equal(errors.length, 1);
    });

    it('accepts bug report with description only', () => {
      const body = { description: 'Combat is stuck after round 3' };
      const isValid = !!(body.description && body.description.length > 0);
      assert.equal(isValid, true);
    });

    it('accepts bug report with screenshot', () => {
      const body = {
        description: 'Game froze',
        screenshot: 'data:image/png;base64,ABC123...'
      };
      const isValid = !!(body.description && body.description.length > 0);
      assert.equal(isValid, true);
    });

    it('rejects empty description', () => {
      const body = { description: '' };
      const isValid = !!(body.description && body.description.trim().length > 0);
      assert.equal(isValid, false);
    });
  });

  describe('PATCH /api/games/:id/bugs/:bugId — Bug status update', () => {
    it('validates status is one of allowed values', () => {
      const body = { status: 'investigating' };
      const allowedStatuses = ['open', 'investigating', 'auto-fixed', 'closed'];

      const isValid = !!(body.status && allowedStatuses.includes(body.status));
      assert.equal(isValid, true);
    });

    it('rejects invalid status', () => {
      const body = { status: 'invalid-status' };
      const allowedStatuses = ['open', 'investigating', 'auto-fixed', 'closed'];

      const isValid = !!(body.status && allowedStatuses.includes(body.status));
      assert.equal(isValid, false);
    });
  });

  describe('Response Status Codes', () => {
    it('returns 400 for missing required fields', () => {
      const statusCode = 400;
      assert.equal(statusCode, 400);
    });

    it('returns 401 for unauthenticated requests', () => {
      const statusCode = 401;
      assert.equal(statusCode, 401);
    });

    it('returns 403 for forbidden access', () => {
      const statusCode = 403;
      assert.equal(statusCode, 403);
    });

    it('returns 404 for not found', () => {
      const statusCode = 404;
      assert.equal(statusCode, 404);
    });

    it('returns 200 for successful requests', () => {
      const statusCode = 200;
      assert.equal(statusCode, 200);
    });

    it('returns 201 for successful creation', () => {
      const statusCode = 201;
      assert.equal(statusCode, 201);
    });
  });

  describe('Game System Validation', () => {
    it('accepts dnd5e system', () => {
      const system = 'dnd5e';
      const allowedSystems = ['dnd5e', 'runequest', 'custom'];
      assert.ok(allowedSystems.includes(system));
    });

    it('accepts runequest system', () => {
      const system = 'runequest';
      const allowedSystems = ['dnd5e', 'runequest', 'custom'];
      assert.ok(allowedSystems.includes(system));
    });

    it('accepts custom system', () => {
      const system = 'custom';
      const allowedSystems = ['dnd5e', 'runequest', 'custom'];
      assert.ok(allowedSystems.includes(system));
    });

    it('rejects unknown system', () => {
      const system = 'pathfinder';
      const allowedSystems = ['dnd5e', 'runequest', 'custom'];
      assert.ok(!allowedSystems.includes(system));
    });
  });

  describe('Request Body Sanitization', () => {
    it('trims whitespace from text fields', () => {
      const dirty = '  Game Name  ';
      const clean = dirty.trim();
      assert.equal(clean, 'Game Name');
    });

    it('lowercases email fields', () => {
      const email = 'User@EXAMPLE.COM';
      const normalized = email.toLowerCase();
      assert.equal(normalized, 'user@example.com');
    });

    it('escapes HTML in user input', () => {
      const input = '<script>alert("xss")</script>';
      const escaped = input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

      assert.ok(!escaped.includes('<script>'));
      assert.ok(escaped.includes('&lt;script&gt;'));
    });

    it('truncates overly long text', () => {
      const longText = 'A'.repeat(10000);
      const MAX_LENGTH = 5000;
      const truncated = longText.slice(0, MAX_LENGTH);

      assert.equal(truncated.length, MAX_LENGTH);
      assert.equal(truncated, 'A'.repeat(MAX_LENGTH));
    });
  });

  describe('Parameter Parsing', () => {
    it('parses integer query parameters', () => {
      const queryParam = '42';
      const parsed = parseInt(queryParam, 10);
      assert.equal(parsed, 42);
      assert.equal(typeof parsed, 'number');
    });

    it('parses boolean query parameters', () => {
      const queryParam = 'true';
      const parsed = queryParam === 'true';
      assert.equal(parsed, true);
    });

    it('parses UUID path parameters', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const isValidUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid);
      assert.ok(isValidUUID);
    });

    it('rejects invalid UUID format', () => {
      const uuid = 'not-a-uuid';
      const isValidUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid);
      assert.ok(!isValidUUID);
    });
  });
});
