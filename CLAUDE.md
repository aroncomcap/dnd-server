# Tavern Table — CLAUDE.md
<!-- Last updated: 2026-04-11 -->

## Project Overview
Multiplayer RPG game server with AI Game Master (Claude as DM). Express.js + Socket.io + PostgreSQL on Railway. Discord bot integration.

**URL:** https://dnd-server-production-9b61.up.railway.app
**Repo:** github.com/aroncomcap/dnd-server
**DB:** Railway PostgreSQL
**Discord Bot:** TotMTable#4445

## Stack
- Express.js, Socket.io, PostgreSQL (pg pool), Passport.js auth
- Anthropic Claude API (Haiku ONLY — hardcoded, never use Sonnet/Opus for game calls)
- Together AI FLUX.1-schnell for images ($0.003/image)
- Single-page HTML files (no framework), vanilla JS, CSS
- Railway deployment (main branch auto-deploys via `railway up`)

## Key Files
| File | Lines | Purpose |
|------|-------|---------|
| `server.js` | ~1500 | Express server, Socket.io, game engine, Claude API, system prompts |
| `public/game.html` | ~2800 | Game UI, all client JS, CSS |
| `discord-bot.js` | ~900 | Discord bot with /tt and /tavern commands |
| `db.js` | ~350 | PostgreSQL schema, queries, billing functions |
| `auth.js` | ~200 | Passport.js auth (email, Google, Discord) |
| `billing.js` | ~150 | Billing ticker, spectator mode |
| `payments.js` | ~80 | Stripe checkout integration |
| `map-engine.js` | ~180 | Map graph, fog of war, auto-positioning |
| `public/map-renderer.js` | ~250 | Client SVG map renderer (3 styles) |

## Architecture Patterns

### System Prompt Strategy
- **Turn 1:** Full system prompt (~2100 tokens) with all rules, format examples, persona
- **Turn 2+:** Aggressively trimmed prompt (~400-600 tokens) — persona, characters, settings, short format reminder
- Both variants include: persona, character block, campaign source material, verbosity/ferocity/pillars
- Trimmed prompt MUST explicitly demand ---OPTIONS--- block or Claude omits it

### Chat History & Memory
- Max 16 messages in history (was 80, then 30 — keep it small)
- Structured blocks (OPTIONS/SCENE/WORLD) stripped before storage — only narration saved
- Rolling story summary: background Haiku call every ~7 turns summarizes oldest messages
- Summary injected as "STORY SO FAR:" in system prompt
- World state (locations, NPCs, accomplishments) persists separately in DB

### Prompt Caching
- System prompt uses Anthropic cache_control: `{ type: "ephemeral" }` for 90% cost reduction on repeat calls

### Image Generation
- Composite scene prompts assembled SERVER-SIDE from stored `visualDesc` on characters/NPCs/locations
- Claude outputs minimal scene tags: `ACTION:`, `MOOD:`, `NPC:` (~15 tokens)
- Event-driven triggers: location change, killshot, new NPC — NOT timer-based
- Character tokens: 512x512, generated on registration
- World art (NPCs/locations): generated on first discovery, stored in world state

### Cost Safety
- 60 calls/hour rate limit per game
- 2 consecutive idle turns → auto-pause
- Timer won't start if no clients connected
- Timer killed on last client disconnect (5s grace)
- Billing toggle: `BILLING_ENABLED` env var (default: OFF)
- Cost logging: every API call logged with model, tokens, cost, elapsed time

## Database
- Schema auto-creates in `db.js initDB()` — no migration tool
- Tables: games, characters, game_state (key-value per game), channel_links, users, user_balances, purchases, promo_codes, feature_requests
- game_state stores: chatHistory, world, map, ferocity, verbosity, pillars, dmPersona, storySummary, turnOrder, discord_bindings
- All settings persist to DB via `db.setState(gameId, key, value)`

## Game Systems
- D&D 5e: standard adventuring day, XP + milestones, spell slots, initiative
- RuneQuest: scenes instead of encounters, Rune Points/POW, strike ranks, skill improvement rolls
- Custom: generic challenge-rest cycle

## DM Personas
- **Epic** (default): literary, dramatic, atmospheric
- **Over the Top**: comedic, Critical Role energy, zany NPCs, fourth wall breaks

## Settings (per game, all persisted)
- Verbosity: verbose (100 words max), brief (50), terse (20) — excludes game mechanics
- Ferocity: 1-5 (1=deadly+generous treasure, 5=easy+minimal treasure)
- Pillars: exploration/combat/social % weighting
- DM Persona: epic/overthetop
- Map Style: parchment/dark/tactical
- Turn Timer: seconds (default 180)
- Billing Mode: host_pays/player_pays

## Discord Commands (/tt shortcut)
join, games, register, claim, action, start, party, world, map, reveal, skip, timer, verbosity, ferocity, pillars, persona, catchup, catchphrase, ooc, redeem, balance, addtime, reset

## Deployment
```bash
cd /Users/aron/Downloads/dnd-server
git push origin main && railway up --detach
```
Check logs: `railway logs`
Check costs: GET /api/costs

## Environment Variables (Railway)
- ANTHROPIC_API_KEY — Claude API
- TOGETHER_API_KEY — FLUX image generation
- DATABASE_URL — PostgreSQL (auto-set by Railway Postgres addon)
- DISCORD_BOT_TOKEN — Discord bot
- BILLING_ENABLED — "true" to enforce billing (default: off)
- STRIPE_SECRET_KEY — Stripe payments (optional)
- STRIPE_WEBHOOK_SECRET — Stripe webhook verification (optional)
- JWT_SECRET — auth token signing (auto-generated if not set)
- GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — Google OAuth (optional)
- DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET — Discord OAuth (optional)

## Common Gotchas
- System prompt is in TWO places: `buildSystemPrompt()` and `buildTrimmedPrompt()` — update BOTH
- `parseResponse()` is order-independent (single-pass marker extraction) — works regardless of Claude's output order
- Nav was `position: fixed` but now uses flex flow — don't re-add fixed positioning
- `#screen-game` must have `display: flex` ONLY in `.active` state — otherwise it leaks into other tabs
- Minimum font size: 0.75rem — don't go smaller
- Options buttons render markdown via innerHTML — `**bold**` → `<strong>bold</strong>`
- Chat history stores ONLY narration (structured blocks stripped) — keep it lean
- `selectCharacter()` must call `updateActionArea()` — forgetting this breaks turn controls
