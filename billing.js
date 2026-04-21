// billing.js — Metered billing engine for Tavern Table
// Runs a per-game ticker that deducts minutes from payer balances,
// emits warnings at thresholds, and manages spectator mode on expiry.

const FULL_RATE_MINUTES = 1;          // 1 minute deducted per tick (= $1/hr)
const SPECTATOR_WINDOW_MS = 5 * 60 * 1000; // 5 minutes of spectator before hard pause
const WARNING_THRESHOLDS = [30, 10, 1]; // minutes remaining

const SIGNUP_NUDGE_THRESHOLDS = [30, 60, 90]; // minutes — soft prompts
const SIGNUP_HARD_GATE = 120;                  // minutes — must sign up

function isBillingEnabled() {
  return process.env.BILLING_ENABLED === 'true';
}

class BillingTicker {
  /**
   * @param {import('socket.io').Server} io
   * @param {object} db — the db module (getUserBalance, deductMinutes, getGame, etc.)
   */
  constructor(io, db) {
    this.io = io;
    this.db = db;
    this.tickers = {};          // gameId → intervalId
    this.spectatorTimers = {};  // gameId → { userId → setTimeout id }
    this.autonomousTicks = {};  // gameId → count (for half-rate deduction)
    this.expiryTickCounts = {};  // gameId → count (for hourly expiry checks)
    this.gameStates = {};       // gameId → reference to in-memory game state
    this.payers = {};           // gameId → payerId passed at start
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Begin billing for a game.
   * @param {string} gameId
   * @param {string} payerId — host_user_id (or null if unknown)
   * @param {object} gameState — reference to in-memory game state object
   */
  startForGame(gameId, payerId, gameState) {
    if (this.tickers[gameId]) return; // already running

    this.autonomousTicks[gameId] = 0;
    this.payers[gameId] = payerId;
    this.gameStates[gameId] = gameState;

    this.tickers[gameId] = setInterval(async () => {
      try {
        await this.tick(gameId);
      } catch (err) {
        console.error(`[billing] tick error for game ${gameId}:`, err.message);
      }
    }, 60_000); // every 60 seconds
  }

  /**
   * Stop billing for a game (reset, all disconnected, etc.)
   */
  stopForGame(gameId) {
    if (this.tickers[gameId]) {
      clearInterval(this.tickers[gameId]);
      delete this.tickers[gameId];
    }
    delete this.autonomousTicks[gameId];
    delete this.expiryTickCounts[gameId];
    delete this.payers[gameId];
    delete this.gameStates[gameId];

    // Clear any lingering spectator timers for this game
    if (this.spectatorTimers[gameId]) {
      for (const userId of Object.keys(this.spectatorTimers[gameId])) {
        clearTimeout(this.spectatorTimers[gameId][userId]);
      }
      delete this.spectatorTimers[gameId];
    }
  }

  /**
   * Stop all tickers (used on graceful shutdown).
   */
  stopAll() {
    for (const gameId of Object.keys(this.tickers)) {
      this.stopForGame(gameId);
    }
  }

  // ── Core tick ──────────────────────────────────────────────────────────────

  async tick(gameId) {
    const gs = this.gameStates[gameId];
    if (!gs) return;
    if (gs.paused) return;

    // Check if anyone is connected
    const room = this.io.sockets.adapter.rooms.get(gameId);
    const connectedCount = room ? room.size : 0;
    if (connectedCount === 0) return;

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

    const game = await this.db.getGame(gameId);
    if (!game) return;

    const isAutonomous = gs.isAutonomous || false;
    const billingMode = game.billing_mode || 'host_pays';

    // Autonomous = half rate: only deduct every other tick
    if (isAutonomous) {
      this.autonomousTicks[gameId] = (this.autonomousTicks[gameId] || 0) + 1;
      if (this.autonomousTicks[gameId] % 2 !== 0) return; // skip odd ticks
    }

    // If billing is disabled, we still ran the tracking logic above but skip actual deductions
    if (!isBillingEnabled()) return;

    // Determine who to bill
    let userIds = [];
    if (billingMode === 'host_pays') {
      if (game.host_user_id) userIds = [game.host_user_id];
    } else {
      // player_pays: bill each connected user (reuse sockets from earlier)
      userIds = [...new Set(sockets.map(s => s.userId).filter(Boolean))];
    }

    // Run expiry checks once per hour (every 60 ticks) to avoid per-tick DB overhead
    this.expiryTickCounts[gameId] = (this.expiryTickCounts[gameId] || 0) + 1;
    if (this.expiryTickCounts[gameId] % 60 === 0) {
      for (const userId of userIds) {
        await this.db.checkAndResetFree(userId);
        await this.db.expireOldCredits(userId);
      }
    }

    for (const userId of userIds) {

      const balance = await this.db.getUserBalance(userId);
      if (!balance) continue;

      const totalRemaining = balance.free_minutes_remaining + balance.paid_minutes_remaining;

      // Emit warnings at thresholds (before deduction)
      for (const threshold of WARNING_THRESHOLDS) {
        if (totalRemaining <= threshold + 1 && totalRemaining > threshold) {
          const level = threshold <= 1 ? 'critical' : threshold <= 10 ? 'urgent' : 'warning';
          this.io.to(gameId).emit('billing_warning', {
            userId,
            minutesRemaining: totalRemaining - 1,
            level,
          });
        }
      }

      // Deduct
      await this.db.deductMinutes(userId, FULL_RATE_MINUTES);

      // Re-fetch balance after deduction
      const newBalance = await this.db.getUserBalance(userId);
      const newTotal = newBalance.free_minutes_remaining + newBalance.paid_minutes_remaining;

      // Emit balance update so the client can show remaining time
      this.io.to(gameId).emit('balance_update', {
        userId,
        freeMinutes: newBalance.free_minutes_remaining,
        paidMinutes: newBalance.paid_minutes_remaining,
      });

      // If balance hit zero, enter spectator mode
      if (newTotal <= 0) {
        this._enterSpectatorMode(gameId, userId);
      }
    }
  }

  // ── Spectator mode ─────────────────────────────────────────────────────────

  _enterSpectatorMode(gameId, userId) {
    const gs = this.gameStates[gameId];
    if (!gs) return;

    // Mark in game state
    if (!gs.billing) gs.billing = {};
    if (!gs.billing.spectatorMode) gs.billing.spectatorMode = {};
    gs.billing.spectatorMode[userId] = {
      enteredAt: Date.now(),
      expiresAt: Date.now() + SPECTATOR_WINDOW_MS,
    };

    this.io.to(gameId).emit('spectator_mode', {
      userId,
      expiresAt: Date.now() + SPECTATOR_WINDOW_MS,
    });

    // Start 5-minute timer — after which the game pauses for this user
    if (!this.spectatorTimers[gameId]) this.spectatorTimers[gameId] = {};
    this.spectatorTimers[gameId][userId] = setTimeout(() => {
      this.io.to(gameId).emit('billing_pause', {
        userId,
        reason: 'Time expired. Add time to continue.',
      });
    }, SPECTATOR_WINDOW_MS);
  }

  /**
   * Restore a player from spectator mode (e.g. after they add time).
   */
  restorePlayer(gameId, userId) {
    const gs = this.gameStates[gameId];

    // Clear spectator state
    if (gs?.billing?.spectatorMode?.[userId]) {
      delete gs.billing.spectatorMode[userId];
    }

    // Clear the 5-minute hard-pause timer
    if (this.spectatorTimers[gameId]?.[userId]) {
      clearTimeout(this.spectatorTimers[gameId][userId]);
      delete this.spectatorTimers[gameId][userId];
    }

    this.io.to(gameId).emit('spectator_restored', { userId });
  }

  /**
   * Check if a user is currently in spectator mode for a game.
   */
  isSpectator(gameId, userId) {
    const gs = this.gameStates[gameId];
    return !!gs?.billing?.spectatorMode?.[userId];
  }
}

module.exports = { BillingTicker, isBillingEnabled };
