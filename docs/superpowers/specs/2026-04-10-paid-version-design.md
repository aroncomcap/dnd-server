# Paid Version Design — Hourly Playtime Billing

## Overview

Metered billing system charging $1/hour of playtime with 5 free hours/month. Supports multiple auth providers, host-controlled billing, spectator mode on expiry, and autonomous play at half cost. Built for web now with app store distribution later via RevenueCat.

## Authentication

Four providers, all available simultaneously. Player picks their preferred method at signup:

- **Email/password** — standard signup
- **Google OAuth** — one-tap login
- **Apple OAuth** — Sign in with Apple (required for App Store)
- **Discord OAuth** — natural fit since the Discord bot is already integrated

All providers link to a single user account. A player who signs in with Google and later with Discord (same email) gets the same account. User accounts stored in a new `users` table.

Auth library: **Clerk** or **NextAuth/Auth.js** are options, but since this is a plain Express app (not Next.js), use **Passport.js** with strategies for all four providers. Sessions via signed cookies or JWT.

## Billing Model

### Who Pays
Host sets the billing mode per game:
- **Host pays** — host's balance covers all players' time
- **Each player pays** — individual balances deducted
- **Host choice per game** — default is host pays

### Playtime Measurement
**Per-game session time.** The meter starts at "Begin Adventure" and runs for all connected players while the game is active (not paused). Tracked server-side in 1-minute increments.

- Game active + players connected = meter running
- Game paused = meter stopped
- All players disconnected = meter stopped (existing 5s grace period applies)
- Autonomous play (no human actions, Claude auto-acting) = **half rate ($0.50/hr)**

### Pricing
- **Web:** $1.00/hour of playtime
- **App Store (future):** $1.49/hour (covers Apple/Google 30% cut)
- **Autonomous play:** $0.50/hour (half rate, since no human interaction)

### Free Tier
5 hours free per month per account. Resets on the 1st of each month. Shared across all games.

## What Happens When Time Runs Out

1. **At 30 minutes remaining:** yellow warning banner in header + Discord notification
2. **At 10 minutes remaining:** orange warning, "Add time" button prominent
3. **At 1 minute remaining:** red warning, urgent notification
4. **At 0 minutes:**
   - Game does NOT pause immediately
   - Player enters **spectator mode** for 5 minutes:
     - Cannot send actions or select options
     - Claude takes over their character (auto-action mode)
     - Player can still see all narration
     - Banner: "⏳ Time expired — watching for 5 more minutes. Add time to resume control."
   - After 5-minute spectator window: hard pause, "Add time to continue" screen

## Payment Processing — RevenueCat

RevenueCat unifies billing across web (Stripe) and future app stores (Apple/Google) under one API.

### Setup
- RevenueCat account with a "Tavern Table" project
- Stripe connected for web payments
- Products defined in RevenueCat:
  - `playtime_1hr` — $1.00 (web) / $1.49 (app stores)
  - `playtime_5hr` — $4.50 (web) / $6.99 (app stores) — bulk discount
  - `playtime_20hr` — $15.00 (web) / $22.99 (app stores) — bigger discount

### Flow
1. Player clicks "Add Time" → RevenueCat purchase flow (Stripe Checkout on web)
2. On success, webhook credits the player's account with purchased hours
3. Balance tracked server-side in `user_balances` table
4. Every minute, server deducts from the payer's balance (host or individual per game setting)

## Data Model

### New Tables

```sql
-- User accounts
CREATE TABLE users (
  id TEXT PRIMARY KEY, -- UUID
  email TEXT UNIQUE,
  display_name TEXT,
  auth_provider TEXT, -- 'email', 'google', 'apple', 'discord'
  auth_provider_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- User balances (minutes of playtime)
CREATE TABLE user_balances (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  free_minutes_remaining INT DEFAULT 300, -- 5 hours = 300 minutes
  paid_minutes_remaining INT DEFAULT 0,
  free_reset_date DATE DEFAULT (DATE_TRUNC('month', NOW()) + INTERVAL '1 month'),
  total_minutes_used INT DEFAULT 0
);

-- Purchase history
CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  provider TEXT, -- 'stripe', 'apple', 'google'
  provider_tx_id TEXT,
  product_id TEXT,
  minutes_credited INT,
  amount_cents INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Per-game billing config
-- Add to existing games table:
ALTER TABLE games ADD COLUMN billing_mode TEXT DEFAULT 'host_pays'; -- 'host_pays', 'player_pays'
ALTER TABLE games ADD COLUMN host_user_id TEXT REFERENCES users(id);
```

### Game State Additions

```json
{
  "billing": {
    "sessionStartedAt": "2026-04-10T12:00:00Z",
    "minutesThisSession": 0,
    "isAutonomous": false,
    "spectatorMode": {},
    "warnings": []
  }
}
```

## Server Logic

### Billing Ticker
A `setInterval` runs every 60 seconds per active game:
1. Check if game is active (not paused, has connected players)
2. Determine rate: full ($1/hr = 1 min deducted) or autonomous ($0.50/hr = 1 min per 2 minutes)
3. Determine payer: host (if host_pays) or each connected player
4. Deduct from payer's balance (free minutes first, then paid)
5. Check remaining balance, emit warnings at thresholds
6. If balance hits 0: enter spectator mode for that player/all players
7. After 5 minutes in spectator mode: pause game

### Spectator Mode
When a player's time expires:
- Server sets `spectatorMode[userId] = true`
- Client receives `spectator_mode` event
- UI hides action controls (same as "not your turn" but permanent)
- Shows: "⏳ Time expired — watching for 5 more minutes. Add time to resume."
- Claude auto-acts for the spectating player
- After 5 minutes: `game_paused` event, hard stop

### Autonomous Play Billing
When all human players are disconnected but the game hasn't paused yet (within the 2-turn idle limit), billing switches to half rate. The `isAutonomous` flag tracks this. When a human reconnects, billing returns to full rate.

Additionally, a host can explicitly enable "autonomous mode" — Claude runs the game without human input, auto-acting for all characters. Billed at $0.50/hr.

## UI Changes

### Header Balance Indicator
Small text in the header bar (next to deploy timestamp):
- Green: "4h 23m remaining"
- Yellow: "28m remaining"
- Red: "2m remaining!"

### Host Tab — Billing Section
- Current balance display
- "Add Time" button → RevenueCat purchase flow
- Billing mode selector (host pays / each player pays)
- Usage history

### Spectator Mode Banner
Full-width banner above the chat when in spectator mode:
- "⏳ Your time has expired. Claude is playing for you. Add time to resume control."
- "Add Time" button
- Countdown: "Spectating: 3:42 remaining before pause"

### "Add Time" Purchase Page
Simple page at `/purchase`:
- Three product cards (1hr / 5hr / 20hr)
- RevenueCat Checkout integration
- Current balance shown
- Purchase history

## Discord Integration

- `/tt balance` — show your remaining playtime
- `/tt addtime` — link to web purchase page
- Balance warnings sent as DMs to the affected player
- Spectator mode announced in game channel

## Future App Store Notes

- RevenueCat handles iOS/Android in-app purchases with the same product IDs
- App store pricing set at $1.49/hr tier ($0.49 premium covers 30% cut)
- User accounts sync across web and apps via RevenueCat customer ID
- Apple requires Sign in with Apple if any social login is offered (already included)
- Google Play requires Google OAuth for streamlined billing (already included)

## Implementation Phases

### Phase 1: Auth + Billing Core (build first)
- User accounts with all 4 auth providers
- Balance tracking
- Billing ticker
- Spectator mode
- Stripe/RevenueCat integration for web purchases

### Phase 2: UI + Polish
- Header balance indicator
- Purchase page
- Host tab billing controls
- Spectator mode banner
- Discord balance commands

### Phase 3: App Store Prep (future)
- RevenueCat app store products
- React Native or PWA wrapper
- App store submission
