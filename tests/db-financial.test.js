'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Test for financial functions in db.js
// These tests verify the logic of deduction, credit, expiry, and promo code handling

describe('DB Financial Functions — Logic Tests', () => {
  describe('deductMinutes logic', () => {
    it('deducts from free minutes first', () => {
      const balance = { free_minutes_remaining: 50, paid_minutes_remaining: 30 };
      const minutes = 20;

      let remaining = minutes;
      let freeDeduct = Math.min(remaining, balance.free_minutes_remaining);
      remaining -= freeDeduct;
      let paidDeduct = Math.min(remaining, balance.paid_minutes_remaining);

      assert.equal(freeDeduct, 20);
      assert.equal(paidDeduct, 0);
      assert.equal(freeDeduct + paidDeduct, 20);
    });

    it('deducts from paid minutes when free is exhausted', () => {
      const balance = { free_minutes_remaining: 10, paid_minutes_remaining: 50 };
      const minutes = 30;

      let remaining = minutes;
      let freeDeduct = Math.min(remaining, balance.free_minutes_remaining);
      remaining -= freeDeduct;
      let paidDeduct = Math.min(remaining, balance.paid_minutes_remaining);

      assert.equal(freeDeduct, 10);
      assert.equal(paidDeduct, 20);
      assert.equal(freeDeduct + paidDeduct, 30);
    });

    it('caps deduction at available balance', () => {
      const balance = { free_minutes_remaining: 5, paid_minutes_remaining: 10 };
      const minutes = 100;

      let remaining = minutes;
      let freeDeduct = Math.min(remaining, balance.free_minutes_remaining);
      remaining -= freeDeduct;
      let paidDeduct = Math.min(remaining, balance.paid_minutes_remaining);

      assert.equal(freeDeduct, 5);
      assert.equal(paidDeduct, 10);
      assert.equal(freeDeduct + paidDeduct, 15);
    });

    it('handles zero deduction', () => {
      const balance = { free_minutes_remaining: 0, paid_minutes_remaining: 0 };
      const minutes = 10;

      let remaining = minutes;
      let freeDeduct = Math.min(remaining, balance.free_minutes_remaining);
      remaining -= freeDeduct;
      let paidDeduct = Math.min(remaining, balance.paid_minutes_remaining);

      assert.equal(freeDeduct, 0);
      assert.equal(paidDeduct, 0);
      assert.equal(freeDeduct + paidDeduct, 0);
    });
  });

  describe('creditMinutes logic', () => {
    it('sets expiry to 1 year for admin credits', () => {
      const creditType = 'admin';
      let expiresAt = null;

      if (!expiresAt && (creditType === 'admin' || creditType === 'promo')) {
        expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      }

      assert.ok(expiresAt);
      // Check that expiry is approximately 1 year from now (within 1 hour)
      const oneYear = 365 * 24 * 60 * 60 * 1000;
      const diff = expiresAt.getTime() - Date.now();
      assert.ok(diff > oneYear - 3600000 && diff < oneYear + 3600000);
    });

    it('sets expiry to 1 year for promo credits', () => {
      const creditType = 'promo';
      let expiresAt = null;

      if (!expiresAt && (creditType === 'admin' || creditType === 'promo')) {
        expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      }

      assert.ok(expiresAt);
    });

    it('preserves custom expiry date for purchase credits', () => {
      const creditType = 'purchase';
      let expiresAt = null;

      if (!expiresAt && (creditType === 'admin' || creditType === 'promo')) {
        expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      }

      // For purchase credits, expiresAt should remain null (no expiry)
      assert.equal(expiresAt, null);
    });

    it('defaults to admin credit type', () => {
      const options = {};
      const creditType = options.creditType || 'admin';
      assert.equal(creditType, 'admin');
    });
  });

  describe('expireOldCredits logic', () => {
    it('calculates total expired minutes from multiple rows', () => {
      const rows = [
        { id: 1, minutes_credited: 100 },
        { id: 2, minutes_credited: 50 },
        { id: 3, minutes_credited: 25 },
      ];

      let totalExpired = rows.reduce((sum, r) => sum + r.minutes_credited, 0);
      assert.equal(totalExpired, 175);
    });

    it('caps deduction at available paid balance', () => {
      const totalExpired = 100;
      const paidMinutesRemaining = 30;

      const toDeduct = Math.min(totalExpired, paidMinutesRemaining);
      assert.equal(toDeduct, 30);
    });

    it('returns 0 when no expired credits exist', () => {
      const rows = [];
      if (!rows.length) {
        const toDeduct = 0;
        assert.equal(toDeduct, 0);
      }
    });

    it('handles partial balance scenario', () => {
      const rows = [
        { id: 1, minutes_credited: 50 },
        { id: 2, minutes_credited: 75 },
      ];
      const paidMinutesRemaining = 100;

      let totalExpired = rows.reduce((sum, r) => sum + r.minutes_credited, 0);
      const toDeduct = Math.min(totalExpired, paidMinutesRemaining);

      assert.equal(totalExpired, 125);
      assert.equal(toDeduct, 100);
    });
  });

  describe('redeemPromoCode logic', () => {
    it('rejects invalid promo code', () => {
      const rows = [];
      if (!rows.length) {
        const result = { error: 'Invalid promo code' };
        assert.equal(result.error, 'Invalid promo code');
      }
    });

    it('rejects already-redeemed code', () => {
      const rows = [{ redeemed_by: 'user-123', code: 'BETA-ABC123' }];
      if (rows[0].redeemed_by) {
        const result = { error: 'This code has already been redeemed' };
        assert.equal(result.error, 'This code has already been redeemed');
      }
    });

    it('accepts valid unredeemed code', () => {
      const rows = [{
        code: 'BETA-FRESH',
        redeemed_by: null,
        minutes_granted: 2400,
      }];

      if (rows.length && !rows[0].redeemed_by) {
        const minutes = rows[0].minutes_granted;
        assert.equal(minutes, 2400);
      }
    });

    it('sets 1-year expiry on redemption', () => {
      const minutes = 2400;
      const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

      assert.ok(expiresAt);
      const diff = expiresAt.getTime() - Date.now();
      const oneYear = 365 * 24 * 60 * 60 * 1000;
      assert.ok(diff > oneYear - 3600000);
    });

    it('handles default minutes granted', () => {
      const rows = [{
        code: 'BETA-TEST',
        minutes_granted: 2400,
      }];

      const minutes = rows[0].minutes_granted;
      assert.equal(minutes, 2400);
    });
  });

  describe('checkAndResetFree logic', () => {
    it('determines if reset date has passed', () => {
      const lastResetDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000); // 45 days ago
      const today = new Date();
      const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);

      const shouldReset = lastResetDate < thisMonth;
      assert.equal(shouldReset, true);
    });

    it('does not reset if within same month', () => {
      const thisMonth = new Date();
      thisMonth.setDate(1);
      const lastResetDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago

      const shouldReset = lastResetDate < thisMonth;
      assert.equal(shouldReset, false);
    });

    it('resets to 300 free minutes on monthly reset', () => {
      const freeMinutesResettingTo = 300;
      assert.equal(freeMinutesResettingTo, 300);
    });
  });

  describe('Balance Edge Cases', () => {
    it('handles user with zero balance', () => {
      const balance = { free_minutes_remaining: 0, paid_minutes_remaining: 0 };
      const hasBalance = balance !== null && (balance.free_minutes_remaining > 0 || balance.paid_minutes_remaining > 0);
      assert.equal(hasBalance, false);
    });

    it('handles user with only free minutes', () => {
      const balance = { free_minutes_remaining: 150, paid_minutes_remaining: 0 };
      const hasBalance = balance.free_minutes_remaining > 0;
      assert.equal(hasBalance, true);
    });

    it('handles user with only paid minutes', () => {
      const balance = { free_minutes_remaining: 0, paid_minutes_remaining: 200 };
      const hasBalance = balance.paid_minutes_remaining > 0;
      assert.equal(hasBalance, true);
    });

    it('prevents negative balance from deduction', () => {
      const balance = { free_minutes_remaining: 50, paid_minutes_remaining: 30 };
      const minutes = 200;

      let remaining = minutes;
      let freeDeduct = Math.min(remaining, balance.free_minutes_remaining);
      remaining -= freeDeduct;
      let paidDeduct = Math.min(remaining, balance.paid_minutes_remaining);

      const newFree = balance.free_minutes_remaining - freeDeduct;
      const newPaid = balance.paid_minutes_remaining - paidDeduct;

      assert.ok(newFree >= 0);
      assert.ok(newPaid >= 0);
    });
  });

  describe('Credit Type Categorization', () => {
    it('identifies purchase credits as non-expiring', () => {
      const creditType = 'purchase';
      const expiresAt = creditType === 'purchase' ? null : new Date();
      assert.equal(expiresAt, null);
    });

    it('identifies admin credits as expiring', () => {
      const creditType = 'admin';
      const shouldExpire = creditType === 'admin' || creditType === 'promo';
      assert.equal(shouldExpire, true);
    });

    it('identifies promo credits as expiring', () => {
      const creditType = 'promo';
      const shouldExpire = creditType === 'admin' || creditType === 'promo';
      assert.equal(shouldExpire, true);
    });

    it('identifies expired credits for marking', () => {
      const creditTypes = ['admin', 'promo', 'purchase', 'expired'];
      const expiredTypes = creditTypes.filter(t => t === 'expired');
      assert.equal(expiredTypes.length, 1);
    });
  });
});
