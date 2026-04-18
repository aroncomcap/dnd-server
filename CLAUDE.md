# Tavern Table — CLAUDE.md
<!-- Last updated: 2026-04-12 -->

## Project Overview
Multiplayer RPG game server with AI Game Master (Claude as DM). Express.js + Socket.io + PostgreSQL on Railway. Discord bot integration. Supports D&D 5e, RuneQuest, and Custom systems.

**URL:** https://dnd-server-production-9b61.up.railway.app
**Repo:** github.com/aroncomcap/dnd-server
**DB:** Railway PostgreSQL
**Discord Bot:** TotMTable#4445

## Stack
- Express.js, Socket.io, PostgreSQL (pg pool), Passport.js auth
- Anthropic Claude API (Haiku ONLY — hardcoded, never use Sonnet/Opus for game calls)
- Together AI FLUX.1-schnell for images ($0.003/image)
- Stripe for payments
- Single-page HTML files (no framework), vanilla JS, CSS
- Railway deployment (main branch auto-deploys via `railway up`)

## Key Files
| File | Lines | Purpose |
|------|-------|---------|
| `server.js` | ~2500 | Express server, Socket.io, game engine, Claude API, system prompts |
| `public/index.html` | ~480 | Lobby (game browser, join code input, redesigned grid) |
| `public/new-game.html` | ~420 | Game creation form (name, system, scene, party direction) |
| `public/game.html` | ~3000 | Game UI, all client JS, CSS |
| `discord-bot.js` | ~900 | Discord bot with /tt and /tavern commands |
| `db.js` | ~520 | PostgreSQL schema, queries, billing functions |
| `auth.js` | ~250 | Passport.js auth (email, Google, Discord OAuth) |
| `billing.js` | ~225 | Billing ticker, spectator mode, balance tracking |
| `payments.js` | ~75 | Stripe checkout integration |
| `map-engine.js` | ~190 | Map graph, fog of war, auto-positioning |
| `public/map-renderer.js` | ~250 | Client SVG map renderer (3 styles) |
| `public/login.html` | — | Login/register page (email, Google, Discord) |
| `public/admin.html` | — | Admin panel (billing, users, promo codes, feature requests) |
| `public/purchase.html` | — | Stripe checkout page (3 tiers) |
| `public/redeem.html` | — | Promo code redemption page |

## Architecture Patterns

### System Prompt Strategy
- **Turn 1:** Full system prompt (~2100 tokens) with all rules, format examples, persona
- **Turn 2+:** Aggressively trimmed prompt (~600 tokens) — persona, characters, settings, short format reminder
- Both variants include: persona, character block, campaign source material, verbosity/ferocity/pillars
- Trimmed prompt MUST explicitly demand ---OPTIONS--- block or Claude omits it
- Rules corrections inject into EVERY prompt — keep them concise

### Chat History & Memory
- Max 16 messages in history (was 80, then 30 — keep it small)
- Structured blocks (OPTIONS/SCENE/WORLD) stripped before storage — only narration saved
- Rolling story summary: background Haiku call every ~7 turns summarizes oldest messages
- Summary injected as "STORY SO FAR:" in system prompt
- World state (locations, NPCs, accomplishments) persists separately in DB

### Prompt Caching
- System prompt uses Anthropic `cache_control: { type: "ephemeral" }` for ~90% cost reduction on repeat calls

### Image Generation
- Composite scene prompts assembled SERVER-SIDE from stored `visualDesc` on characters/NPCs/locations
- Claude outputs minimal scene tags: `ACTION:`, `MOOD:`, `NPC:` (~15 tokens)
- Event-driven triggers: location change, killshot, new NPC meeting — NOT timer-based
- Character tokens: 512x512, generated on registration
- World art (NPCs/locations): generated on first discovery, stored in world state

### Combat State Persistence
- Combat state (combatants, HP, conditions, round, turn order, effects) is persisted to DB via `persistCombatState(gameId)` after every combat action
- On game reload (eviction or restart), combat state is restored from DB via `combatEngine.loadState()`
- On client rejoin during active combat, `combat_started` + `combat_update` events are emitted with current state
- `isCombatOver()` returns `{ over: boolean, reason: string }` — NOT a boolean

### Game Eviction
- Games with no connected clients for 1 hour are purged from RAM
- DB data (characters, chat history, world state, combat state) is always preserved — eviction is RAM-only
- Games reload from DB on next connection, including active combat

### Cost Safety
- 60 calls/hour rate limit per game
- 2 consecutive idle turns → auto-pause
- Timer won't start if no clients connected
- Timer killed on last client disconnect (5s grace)
- Billing toggle: `BILLING_ENABLED` env var (default: OFF, safe for dev)
- Cost logging: every API call logged with model, tokens, cost, elapsed time

## Database

Schema auto-creates in `db.js initDB()` — no migration tool needed. `ALTER TABLE … ADD COLUMN IF NOT EXISTS` handles upgrades safely.

### Tables
| Table | Purpose |
|-------|---------|
| `games` | Game instances (id, name, system, custom_context, billing_mode, host_user_id) |
| `characters` | Per-game character data (JSONB) |
| `game_state` | Key-value store per game (chatHistory, world, map, ferocity, verbosity, pillars, dmPersona, storySummary, turnOrder, discord_bindings) |
| `channel_links` | Discord channel → game mappings |
| `users` | Auth users (email, password_hash, display_name, auth_provider, auth_provider_id, is_admin) |
| `user_balances` | Per-user billing (free_minutes_remaining, paid_minutes_remaining, free_reset_date, total_minutes_used) |
| `purchases` | Payment and credit records (Stripe, admin grants, promo redemptions) |
| `promo_codes` | BETA-XXXXXX codes (minutes_granted, redeemed_by, expires_at) |
| `feature_requests` | Admin-visible feature backlog (title, description, status, priority) |
| `rules_corrections` | Persistent house rules per game (text, category) |

### First-user bootstrap
The first user to register is automatically granted `is_admin = TRUE`.

## Auth System
- **Primary:** Magic link (enter email → get link → click → authenticated)
- **Optional:** Password (user can set one after first login for faster access)
- **OAuth:** Google, Discord (same as before)
- **No anonymous access** — lobby is gated, game pages redirect to lobby
- JWT tokens stored in `tt_token` cookie (7-day expiry, httpOnly)
- Magic link tokens: JWT with 15-minute expiry, single-use (nonce in DB)
- Routes: `POST /auth/magic-link`, `GET /auth/magic-link/:token`, `POST /auth/set-password`, `/auth/login`, `/auth/google`, `/auth/discord`, `/auth/logout`
- Rate limit: 5 magic link requests per 15 min per IP
- Email: Resend (`RESEND_API_KEY` env var). Falls back to console.log in dev.
- `authMiddleware` — attaches user to req if JWT present (non-blocking)
- `requireAuth` — 401 if not authenticated
- `requireAdmin` — 403 if not admin

## Billing System
- Global toggle: `BILLING_ENABLED=true` env var (default: OFF)
- When enabled, players need minutes to play; when off, all play is free
- Billing modes per game: `host_pays` (host's balance consumed) / `player_pays` (each player's balance)
- **Free tier:** 300 minutes/month, auto-reset on the 1st of each month
- **Spectator mode:** Players with zero balance can watch but cannot act
- `BillingTicker` class handles per-game metering (start/stop/deduct)
- Credit types: `free` (monthly), `purchase` (Stripe), `admin` (manual grant), `promo` (promo code)
- Admin and promo credits expire after 1 year; Stripe purchase credits do not expire
- `expireOldCredits()` deducts expired admin/promo minutes in bulk

## Payments (Stripe)
- 3 purchase tiers (configured in `payments.js` and `/purchase.html`)
- Stripe Checkout sessions created at `POST /api/checkout`
- Webhook at `POST /api/webhooks/stripe` (must receive raw body — registered BEFORE `express.json()`)
- On successful payment: `creditMinutes()` called with `credit_type: 'purchase'`
- `STRIPE_WEBHOOK_SECRET` used to verify all webhook events

## Promo Code System
- Format: `BETA-XXXXXX` (6 random chars)
- Default grant: 2400 minutes (40 hours)
- Each code is single-use; tracks `redeemed_by` and `redeemed_at`
- Redemption paths: web (`/redeem.html`) and Discord (`/redeem <code>`)
- Admin page (`/admin`) can generate new codes
- Expiry: 1 year from redemption date

## Admin Page (`/admin`)
Requires `is_admin = TRUE`. Features:
- **Billing toggle:** Enable/disable billing globally
- **User management:** View all users, balances, usage; manually credit minutes
- **Promo codes:** Generate new codes, view redemption status
- **Feature requests:** View/update status of backlog items

## Smart PDF Extraction
- PDFs uploaded via the character import flow
- Haiku is called to summarize the PDF into a structured character/world summary (~2000 tokens vs full raw dump)
- `pdf-parse` v2 API: `new PDFParse({ data: buffer }).getText()` — note the class-based API (not the old function call)
- Summaries stored in character `data.pdfSummary`

## PDF Download / Import
- Characters can be exported as JSON
- JSON can be imported between games (character transfer)
- Import validates structure before accepting

## Rules Corrections
- Players/DM can add house rules via OOC comments or the Party tab editor
- Rules are stored in `rules_corrections` table per game
- Injected into EVERY prompt (full and trimmed) — keep rules short; they cost tokens every call
- Editable from the Party tab in game UI

## Pre-gen Party
- Claude generates 4 balanced characters with a direction input from the host
- Produces name, class, background, stats, and visual description
- Skips the manual character registration flow

## DM Personas
- **Epic** (default): literary, dramatic, atmospheric narration
- **Over the Top**: comedic, Critical Role energy, zany NPCs, fourth-wall breaks

## Game Systems
- **D&D 5e:** standard adventuring day, XP + milestones, spell slots, initiative, long/short rests
- **RuneQuest:** scenes instead of encounters, Rune Points/POW, strike ranks, skill improvement rolls
- **Custom:** generic challenge-rest cycle

## Game Features

### Encounter Pacing
- Scales with ferocity setting (1-5)
- Ferocity 1: deadly combat + generous treasure; Ferocity 5: easy combat + minimal treasure

### Resource Tracking
- Spell slots, HP, hit dice
- Magic consumables (potions, scrolls, wands)
- Tracked per character in JSONB `data` field

### Rest Mechanics
- Short and long rest prompts with appropriate resource recovery
- Integrated into encounter pacing system

### Tension Escalation
- DM tracks scene tension; escalates drama before climax
- Configurable via pillars (exploration/combat/social %)

### Character Advancement
- Level-up choice prompts surfaced to player (ASI, subclass, feats)
- Advancement tracked in character data

### Skill Challenges
- Structured multi-roll challenges with success/failure thresholds

### Turn Order Overlay
- Initiative/strike rank displayed during combat
- Overlay visible to all clients in real-time

### Auto-switch (Solo Play)
- Solo players automatically switch to whichever character's turn it is
- No manual character selection needed during solo sessions

### Catchphrases
- Per-character catchphrases registered via `/catchphrase` command
- DM may use them at dramatically appropriate moments

### OOC Comments
- Players can send out-of-character comments (`/ooc`)
- OOC messages visible to all but not narrated by DM
- OOC can trigger rules corrections if flagged

## Discord Commands (`/tt` shortcut)
`join`, `games`, `register`, `claim`, `action`, `start`, `party`, `world`, `map`, `reveal`, `skip`, `timer`, `verbosity`, `ferocity`, `pillars`, `persona`, `catchup`, `catchphrase`, `ooc`, `redeem`, `balance`, `addtime`, `reset`

## Settings (per game, all persisted to DB)
| Setting | Options | Default |
|---------|---------|---------|
| Verbosity | verbose (100w), brief (50w), terse (20w) | brief |
| Ferocity | 1–5 | 3 |
| Pillars | exploration/combat/social % | 33/33/33 |
| DM Persona | epic / overthetop | epic |
| Map Style | parchment / dark / tactical | parchment |
| Turn Timer | seconds | 180 |
| Billing Mode | host_pays / player_pays | host_pays |

## Security
- XSS escaping on all user-supplied content rendered to HTML
- `requireAuth` / `requireAdmin` middleware on all protected routes
- Rate limiting via `express-rate-limit` (60 req/hr game limit)
- Input validation and `truncate()` helper before DB writes
- Stripe webhook signature verification (`STRIPE_WEBHOOK_SECRET`)
- Memory eviction: idle games purged after 1 hour
- `/health` endpoint for Railway health checks

## Deployment
```bash
cd "/Users/aron/Dropbox (Personal)/claude/dnd-server"
git push origin main && railway up --detach
```
Check logs: `railway logs`
Check costs: `GET /api/costs`

## Environment Variables (Railway)
| Variable | Purpose | Required |
|----------|---------|----------|
| `ANTHROPIC_API_KEY` | Claude API | Yes |
| `TOGETHER_API_KEY` | FLUX image generation | Yes |
| `DATABASE_URL` | PostgreSQL (auto-set by Railway addon) | Yes |
| `DISCORD_BOT_TOKEN` | Discord bot | Yes |
| `JWT_SECRET` | Auth token signing (auto-generated if missing) | Recommended |
| `BILLING_ENABLED` | `"true"` to enforce billing (default: off) | No |
| `STRIPE_SECRET_KEY` | Stripe payments | For payments |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook verification | For payments |
| `GOOGLE_CLIENT_ID` | Google OAuth | For Google login |
| `GOOGLE_CLIENT_SECRET` | Google OAuth | For Google login |
| `DISCORD_CLIENT_ID` | Discord OAuth | For Discord login |
| `DISCORD_CLIENT_SECRET` | Discord OAuth | For Discord login |
| `RESEND_API_KEY` | Resend email service | For magic links |
| `BASE_URL` | Server URL for magic links | Recommended |
| `EMAIL_FROM` | Sender email address | Optional |

## Encounter Difficulty Module

DPR-based encounter balancing that designs encounters calibrated to the party's actual power.

### Key File
- `encounter-designer.js` — DPR estimation, monster HP/DPR budgets, monster selection, social/exploration DC scaling, adventuring day planning, difficulty self-correction

### How It Works
1. Estimates party DPR from combatStats (weapons, spells, features like Extra Attack/Sneak Attack)
2. Tracks rolling DPR from actual combat history (last 5 fights, weighted average)
3. Calculates monster HP budget: `partyDPR × targetRounds × ferocityMult × positionMult × correction`
4. Selects monsters from the database that fit the budget
5. Plans full adventuring days with pillar distribution, rest cadence, and escalation curve
6. Injects plan into AI prompt so the DM follows structured difficulty guidance
7. Self-corrects: if combats consistently shorter/longer than predicted, adjusts future budgets

### Ferocity → Difficulty Mapping
| Ferocity | Target Rounds | HP Mult | PC Death Every N Combats |
|----------|---------------|---------|--------------------------|
| 1 Deadly | 4-5 | 1.5x | 3-5 |
| 3 Balanced | 3-4 | 1.0x | 9-12 |
| 5 Easy | 2-3 | 0.5x | 17-20 |

### Testing
```bash
node test-encounter-designer.js standard-party  # Level 5 party, ferocity 3
node test-encounter-designer.js all              # All scenarios
```

### Host Tab
Encounter Planner panel shows day timeline with difficulty controls (harder/easier, insert rest, skip to boss, regenerate).

## Combat Engine

Server-side combat engine that owns all dice rolls, math, HP tracking, and conditions. The AI narrates pre-resolved results — it does NOT simulate combat rules.

### Testing
```bash
npm test           # node --test tests/*.test.js (310 tests)
npm run test:watch # watch mode
```

### Key Files
| File | Purpose |
|------|---------|
| `combat-engine.js` | CombatEngine class — state management, lifecycle, turn routing, effect tracking, prompt formatting |
| `resolvers/dice.js` | Crypto-secure RNG: d4–d100, `roll(notation)`, `advantage()`, `disadvantage()` |
| `resolvers/dnd5e-resolver.js` | D&D 5e: attacks, spells, saves, damage, death saves, concentration, conditions |
| `resolvers/runequest-resolver.js` | RuneQuest: percentile rolls, parry/dodge, hit locations, full fumble/special/critical tables |
| `stat-parser.js` | Haiku: statsText → combatStats JSON extraction (auto-triggers on first combat) |
| `action-parser.js` | Tier 1 pattern matching + Tier 2 Haiku fallback for player intent parsing |
| `monster-lookup.js` | Layered monster source resolution: DB → JSON defaults → AI fallback |
| `monsters/monsters-5e-srd.json` | ~55 D&D 5e SRD monsters (goblin through kraken) |
| `monsters/monsters-rq-core.json` | ~20 RuneQuest creatures (broo through baboon) |

### Combat Flow
1. AI introduces enemies with `ENEMIES:` block in `---WORLD---` → server parses entries
2. `initiateCombat()` looks up monster stats, parses PC combatStats if missing, calls `combatEngine.initCombat()`
3. Player acts → `action-parser` extracts intent → engine resolves with real dice
4. Enemy turns → Haiku picks tactics → engine resolves each action mechanically
5. All results formatted as text → injected into AI prompt → AI narrates around facts
6. Combat ends: all enemies dead, AI includes `COMBAT_END`, or TPK

### Monster Sources (checked in order)
1. Game-level overrides (DB per game)
2. Campaign sources (DB, shareable)
3. System defaults (JSON files, in-memory at startup)
4. AI fallback (Haiku generates, saves to game overrides)

### Socket Events (combat)
| Event | Direction | Purpose |
|-------|-----------|---------|
| `combat_started` | server → client | Initiative order, enemy summary |
| `combat_update` | server → client | Round, turn, HP/conditions, combat log |
| `combat_ended` | server → client | Final state, victory/defeat |
| `reaction_prompt` | server → player | Concentration save, Shield, etc. |
| `reaction_response` | player → server | Player's reaction choice |

### Gotchas
- `combatStats` is structured JSON alongside `statsText` — both must stay in sync
- When `CHAR_UPDATES` fires during combat, `combatStats` should be re-parsed
- Reaction system can pause resolution mid-turn (Shield, concentration saves, parry/dodge)
- RuneQuest uses strike ranks (lower = faster), D&D uses initiative (higher = faster)
- Combat prompt injection replaces normal COMBAT section when `combatState.active`
- `preTaggedOptions` are parsed async during player think time — no latency impact

## Common Gotchas
- **System prompt lives in TWO places:** `buildSystemPrompt()` (turn 1) and `buildTrimmedPrompt()` (turn 2+) — update BOTH
- **Rules corrections inject into every prompt** — every rule costs tokens on every call; keep them concise
- **`parseResponse()` is order-independent** (single-pass marker extraction) — works regardless of Claude's output order
- **`pdf-parse` v2 uses class API:** `new PDFParse({ data: buffer }).getText()` — not the old function-call style
- **Stripe webhook must be registered BEFORE `express.json()`** to receive the raw body needed for signature verification
- **Auto-switch:** Solo players auto-switch to whichever character's turn it is — no manual selection needed
- **Game eviction:** Games with no clients for 1 hour are purged from RAM; DB data is always preserved
- **Billing default is OFF:** Set `BILLING_ENABLED=true` to enable; safe to develop/test without it
- **First user auto-admin:** The first account registered becomes admin automatically
- Nav uses flex flow (not `position: fixed`) — don't re-add fixed positioning
- `#screen-game` must have `display: flex` ONLY in `.active` state — otherwise it leaks into other tabs
- Minimum font size: 0.75rem — don't go smaller
- Options buttons render markdown via innerHTML — `**bold**` → `<strong>bold</strong>`
- Chat history stores ONLY narration (structured blocks stripped) — keep it lean
- `selectCharacter()` must call `updateActionArea()` — forgetting this breaks turn controls
