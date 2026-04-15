# Magic Link Auth — Email-Gated Lobby

**Date:** 2026-04-15
**Goal:** Require email-based authentication before players can create or join games. Players can return to their games by logging in with their email.

## Auth Flow

### First-time user
1. Visits `/lobby` → sees email field, "Send Magic Link" button, Google/Discord OAuth buttons
2. Enters email → `POST /auth/magic-link` → creates user record (if new) with email, no password → sends email with signed JWT link
3. User clicks link → `GET /auth/magic-link/:token` → validates token, sets `tt_token` cookie (7-day JWT), redirects to `/lobby`
4. User is now authenticated — sees lobby with "Create Game" and "Your Games"

### Returning user (no password)
Same flow — enter email, get magic link, click it.

### Returning user (password set)
Lobby shows email + password fields. "Login" button. Also "Send Magic Link instead" fallback.

### OAuth users (Google/Discord)
Same as today — click button, OAuth flow, JWT set, lands in lobby.

## Lobby Page — Two States

### State 1: Not authenticated
- Email input + "Send Magic Link" button
- Divider: "— or —"
- Google OAuth button, Discord OAuth button
- Small text: "Enter your email to get a login link. No password needed."
- No game creation visible, no game list

### State 2: Authenticated
- Same as current lobby: game creation form, "Your Games" list, all controls
- Top-right shows user email + "Set Password" link (if no password) + "Logout"

## Route Protection

- `GET /lobby` — serves page always, client JS checks `/auth/me` to decide which state
- `POST /api/games` — requires auth middleware (401 if not)
- `GET /game/:id` — requires auth, redirects to `/lobby` if not authenticated
- Remove `POST /api/anonymous-session` endpoint entirely
- Remove anonymous session creation logic from client

## Magic Link Token

**Email service:** Resend (free tier: 100 emails/day). One env var `RESEND_API_KEY`, one npm package (`resend`).

**Token:**
- JWT signed with `JWT_SECRET`, 15-minute expiry
- Payload: `{ email, purpose: 'magic-link' }`
- Link format: `https://dnd-server-production-9b61.up.railway.app/auth/magic-link/<token>`
- On click: validate token, find/create user by email, verify nonce matches, set 7-day session JWT, redirect to `/lobby`
- Single-use: `magic_link_nonce` stored in user record, cleared after use

**Email content:**
- From: `Tavern Table <noreply@yourdomain.com>` (or Resend shared domain initially)
- Subject: "Your Tavern Table login link"
- Body: Link + "This link expires in 15 minutes."

## Data Model Changes

### Users table — additions
- `magic_link_nonce TEXT` — for single-use token validation, nullable
- `has_password BOOLEAN DEFAULT false` — toggles login UI between magic-link-only and password+magic-link

Existing columns unchanged: `email`, `password_hash`, `auth_provider`, `auth_provider_id`, `is_admin`, `display_name`.

### Anonymous sessions — phase out
- Stop creating new anonymous sessions
- Keep table/data (existing anonymous games still accessible if user registers with same context)
- Orphaned anonymous games are acceptable — users can recreate

### New env var
- `RESEND_API_KEY` — Resend transactional email API key

### No changes to
- `games` table — `host_user_id` already links to users
- `characters` table — already linked via `game_id`

## Set Password (Optional Upgrade)

**Where:** Lobby top-right when authenticated, or simple inline UI.

**Flow:**
1. User clicks "Set Password" → shows password + confirm fields + "Save" button
2. `POST /auth/set-password` — requires auth, hashes password, stores in `password_hash`, sets `has_password = true`
3. Next visit: lobby shows email + password fields with "Login" button, plus "Send Magic Link instead" link

**Login logic:**
- Email only + "Send Magic Link" → always works for any user
- Email + password + "Login" → validates against `password_hash`
- Wrong password → "Incorrect password. Send a magic link instead?"

## Files to Modify

| File | Changes |
|------|---------|
| `auth.js` | Add `POST /auth/magic-link` (send link), `GET /auth/magic-link/:token` (validate + login), `POST /auth/set-password`. Remove anonymous session route. |
| `db.js` | Add `magic_link_nonce` and `has_password` columns to users table. Add `findOrCreateUserByEmail()` helper. |
| `server.js` | Add auth middleware to `POST /api/games` and game page route. Remove `POST /api/anonymous-session`. |
| `public/index.html` | Lobby: two-state UI (auth gate vs authenticated lobby). Remove `ensureSession()` anonymous logic. |
| `public/game.html` | Add auth check on load — redirect to `/lobby` if not authenticated. |
| `public/login.html` | May be consolidated into lobby page or kept as fallback. |
| `package.json` | Add `resend` dependency. |
| Railway env vars | Add `RESEND_API_KEY`. |

## What This Replaces

- Anonymous session system (`POST /api/anonymous-session`, `anonymous_sessions` table usage)
- Unauthenticated game creation and joining
- The separate `/login.html` page becomes secondary (lobby handles auth inline)
