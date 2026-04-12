# Landing Page & Discovery System Design

## Overview

Replace the functional lobby at `/` with an immersive landing page that converts cold visitors into players. Anonymous play with zero friction — no signup required for the first 2 hours. Soft auth nudges at 30-minute intervals, hard gate at 120 minutes. 10-hour welcome bonus on signup, 5 free hours/month ongoing. Designed to work as the hub for all discovery channels (shared links, app store, Discord, social content) and future-proofed for iOS app distribution.

## Landing Page (`/`)

### Route Changes

- `GET /` → new `public/landing.html` (marketing/conversion page)
- `GET /lobby` → current `public/index.html` (game creation/listing, requires no auth)
- All existing game URLs (`/game/:id`) unchanged

### Page Structure (Single Scroll, Parchment/Dark Fantasy Aesthetic)

**1. Hero Section**
- Full-bleed dark parchment background
- Heading: "Your Story Begins Here" (Cinzel Decorative)
- Subtitle: "An AI Dungeon Master runs your adventure. Bring friends or go solo. No downloads, no prep."
- Single golden CTA button: **"Start Your Adventure"**
- Button action: `GET /lobby` (anonymous session created on first game join if not authed)

**2. How It Works**
- Three parchment cards with icons:
  1. "Choose Your Character" — character creation screenshot
  2. "The AI Crafts Your Story" — narration/scene image screenshot
  3. "Play With Friends Anywhere" — multiplayer/Discord screenshot
- Minimal text per card (1 sentence each)

**3. Feature Showcase**
- Scrolling "chapter" sections, each with a thematic heading + screenshot/GIF:
  - "Every Choice Matters" — action options UI
  - "See Your World" — scene images + auto-map
  - "Play From Discord" — Discord bot gameplay
  - "Any System, Any Setting" — D&D 5e / RuneQuest / Custom
- Each section alternates image left/right

**4. Pricing**
- Heading: "Free to Start"
- Copy: "10 free hours to start your journey. 5 free hours every month after that. Need more?"
- Three purchase cards (same as current `/purchase` page): 1hr/$1.00, 5hr/$4.50, 20hr/$15.00
- Subtext: "That's less than a dollar an hour for unlimited adventure."

**5. Final CTA**
- "Your Party Is Waiting." + same golden "Start Your Adventure" button

**6. Navigation**
- No navbar. Small top-right links only: "Login" | "About"
- Footer: minimal — links to Discord, login, terms (if needed)

### Visual Design

- Same design system as `game.html`: CSS variables (`--bg-dark`, `--gold`, `--gold-light`, `--parchment`), Cinzel Decorative headings, Crimson Pro body text
- Dark background with parchment card sections
- Responsive: single column on mobile, side-by-side on desktop for feature sections
- No external CSS frameworks — inline styles like all other pages

## Anonymous Play System

### Session Lifecycle

```
Visitor lands on /
  → Clicks "Start Your Adventure"
  → Redirected to /lobby
  → Creates or joins a game
  → On first socket connection without auth:
      Server creates anonymous session (JWT with anonymous:true in cookie)
  → Plays freely for up to 120 minutes
  → Soft signup prompts at 30, 60, 90 minutes
  → Hard gate at 120 minutes (game pauses)
  → On signup: anonymous session merges into new user account
```

### Anonymous Session Creation

When a socket connects to a game and has no `tt_token` cookie (or the token is invalid):

1. Server generates `anon_<uuidv4>` as session ID
2. Creates row in `anonymous_sessions` table
3. Issues JWT: `{ sub: anon_id, anonymous: true, exp: 24h }`
4. Sets `tt_token` cookie (same as regular auth, httpOnly, 24h expiry)
5. Game engine treats anonymous users identically to authed users for gameplay

### Signup Nudges

Server tracks cumulative anonymous playtime via `anonymous_sessions.minutes_used` (incremented by billing ticker).

| Minutes Played | Action |
|---|---|
| 30 | `signup_nudge` socket event — soft modal, dismissible |
| 60 | `signup_nudge` socket event — slightly more urgent copy |
| 90 | `signup_nudge` socket event — "Last chance before signup required" |
| 120 | `signup_required` socket event — hard gate modal, game pauses, not dismissible |

**Nudge modal content:**
- Heading: "Save Your Adventure"
- Copy: "Create a free account to keep your characters, your story, and your 10 free hours."
- Buttons: Google one-tap | Discord | Email signup | "Maybe Later" (dismiss, not shown at 120 min)
- The modal overlays the game UI. On dismiss, play continues immediately.

**Hard gate at 120 min:**
- Same modal but no dismiss button
- Copy changes to: "Create a free account to keep playing. It takes 10 seconds."
- Game actions are blocked server-side (socket ignores `player_action` from anonymous users past 120 min)

### Anonymous → Authenticated Merge

When an anonymous user signs up (any provider):

1. Check if email already exists in `users` table — if so, link to existing account
2. Otherwise create new user account
3. Set `anonymous_sessions.converted_to_user_id = new_user_id`
4. Transfer game participation:
   - Update any `characters` rows where the player was identified by anon session
   - Update any in-memory game state references
5. Set `user_balances.free_minutes_remaining = 600 - anonymous_sessions.minutes_used`
6. Replace anonymous JWT with real user JWT
7. Emit `auth_upgraded` socket event — client refreshes auth state without page reload

### Edge Cases

- **Anonymous user returns later:** Cookie persists for 24h. If they return to the same game within 24h, they resume with their existing anonymous session and accumulated time.
- **Cookie expires / new device:** New anonymous session starts. Previous anonymous characters are orphaned (acceptable — they hadn't signed up, so no expectation of persistence).
- **Multiple anonymous games:** Same anon session across games. Minutes accumulate globally.
- **Anonymous user on /purchase:** Redirect to signup first, then to purchase after auth completes.

## Free Tier Changes

### Current Model
- 300 free minutes/month (5 hours)
- Resets on 1st of each month

### New Model
- **Welcome bonus:** 600 free minutes (10 hours) on account creation
- **Monthly refresh:** 300 free minutes/month (5 hours), resets on 1st of each month
- **Anonymous play:** deducted from the 600 welcome minutes before signup

### Implementation

No new columns needed. On account creation:

```js
// In db.js createUserBalance()
free_minutes_remaining = 600  // was 300
```

On monthly reset (existing logic in billing ticker):

```js
// In billing.js or db.js resetFreeMinutes()
free_minutes_remaining = 300  // unchanged
```

Anonymous minutes deducted: when merging anonymous session, subtract `minutes_used` from the 600:

```js
free_minutes_remaining = Math.max(0, 600 - anonymousSession.minutes_used)
```

## Data Model

### New Table: `anonymous_sessions`

```sql
CREATE TABLE IF NOT EXISTS anonymous_sessions (
  id TEXT PRIMARY KEY,                              -- anon_<uuid>
  created_at TIMESTAMPTZ DEFAULT NOW(),
  minutes_used INT DEFAULT 0,
  last_active TIMESTAMPTZ DEFAULT NOW(),
  converted_to_user_id TEXT REFERENCES users(id),   -- set on signup
  ip_address TEXT                                    -- for abuse prevention
);
```

### Index

```sql
CREATE INDEX IF NOT EXISTS idx_anon_sessions_ip ON anonymous_sessions(ip_address);
```

The IP index enables rate-limiting anonymous session creation (prevent abuse by clearing cookies to reset the 120-min limit).

### Abuse Prevention

- Max 3 anonymous sessions per IP per 24 hours
- After 3 sessions from same IP without signup, require auth to create games
- Anonymous sessions auto-expire and are cleaned up after 7 days (background job or on-demand)

## Server Changes

### `server.js`

- `GET /` → serve `public/landing.html`
- `GET /lobby` → serve current `public/index.html`
- Socket connection handler: detect missing/invalid auth → create anonymous session
- Socket `player_action` handler: check if anonymous user past 120 min → reject with `signup_required` event
- New socket events emitted: `signup_nudge`, `signup_required`, `auth_upgraded`

### `auth.js`

- New function: `createAnonymousSession(ip)` → creates row + returns JWT
- New function: `mergeAnonymousSession(anonId, userId)` → transfers data, credits balance
- New middleware: `authOrAnonymous` — like `authMiddleware` but also accepts anonymous JWTs
- Modify signup/login routes: check for existing anonymous session cookie → merge on success

### `db.js`

- Add `anonymous_sessions` table to `initDB()`
- New functions: `createAnonSession(id, ip)`, `getAnonSession(id)`, `updateAnonMinutes(id, minutes)`, `convertAnonSession(anonId, userId)`
- Modify `createUserBalance()`: initial `free_minutes_remaining = 600`

### `billing.js`

- Billing ticker: also increment `anonymous_sessions.minutes_used` for anonymous players
- At 30/60/90 min thresholds: emit `signup_nudge` to the anonymous player's socket
- At 120 min: emit `signup_required`, block further actions

### `public/game.html`

- New signup prompt modal (overlays game UI)
- Socket handlers for `signup_nudge` and `signup_required`
- `auth_upgraded` handler: refresh auth state, dismiss modal, resume play
- Modal contains: Google one-tap button, Discord OAuth button, email/password form, "Maybe Later" dismiss (hidden at 120 min)

## App Store Future-Proofing

This design maps cleanly to a future iOS/Android app:

| Web | App |
|---|---|
| Landing page | App Store listing (landing page = "Learn More" URL) |
| Anonymous cookie session | Anonymous device session (same concept, stored locally) |
| Stripe checkout | RevenueCat IAP ($1.49/hr tier, 30% cut absorbed) |
| Google/Discord OAuth | Same + Apple Sign-In (required for App Store) |
| `/game/:id` URLs | Universal links — open app if installed, web if not |
| Socket.io transport | Same — works in Capacitor/webview |

### Universal Links Prep

Reserve URL pattern for future universal links:
- `taverntable.com/game/:id` → opens app to game
- `taverntable.com/invite/:code` → future invite flow

No implementation needed now — just don't use these URL patterns for anything else.

## Implementation Phases

### Phase 1: Landing Page
- Create `public/landing.html` with all sections
- Move lobby to `/lobby` route
- Update `server.js` routing
- Capture screenshots/GIFs for feature showcase sections

### Phase 2: Anonymous Sessions
- `anonymous_sessions` table in `db.js`
- Anonymous JWT creation in `auth.js`
- Socket connection handler for anonymous users
- Billing ticker tracks anonymous minutes

### Phase 3: Signup Nudges + Hard Gate
- `signup_nudge` / `signup_required` socket events from billing ticker
- Signup modal in `game.html`
- Server-side action blocking at 120 min

### Phase 4: Session Merge
- `mergeAnonymousSession()` in `auth.js`
- Character/game transfer on signup
- Welcome bonus calculation (600 - anonymous minutes used)
- `auth_upgraded` socket event

### Phase 5: Free Tier Update
- Change initial balance from 300 to 600 minutes
- Update `/purchase` page copy to reflect "10 free hours"
- Update any references to "5 free hours" in the codebase

### Phase 6: Abuse Prevention
- IP-based anonymous session rate limiting
- Anonymous session cleanup job
- Monitor for cookie-clearing abuse patterns
