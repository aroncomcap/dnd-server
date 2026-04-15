# Combat State Persistence & Resync Fix

**Date:** 2026-04-14
**Status:** Approved

## Problem

Combat state (combatant HP, conditions, round, turn order) lives only in RAM via `CombatEngine`. When a game is evicted from memory (1hr idle), the server restarts, or a client reconnects, all combat data is lost. HP resets to max, conditions disappear, and the AI DM receives contradictory state — breaking mechanical integrity.

Secondary: missing ability scores on combatants produce `d20NaN` in formatted roll strings.

## Fix 1: Persist Combat State to DB

**Save trigger:** After every combat state change — `initCombat`, `resolveAction` (attack/spell/etc), `nextTurn`, `endCombat`.

**Pattern:** Fire-and-forget, matching existing codebase pattern:
```js
db.setState(gameId, 'combatState', gs.combatEngine.state).catch(() => {});
```

**Restore:** In `getGameState()` / `loadGameData()`, check for persisted `combatState`. If it exists and `active === true`, hydrate the CombatEngine with that state instead of creating a fresh instance.

**Cleanup:** On `endCombat`, persist `{ active: false }` to clear stale state.

**Files:** `server.js` (save calls + restore logic), `combat-engine.js` (add `loadState()` method), `db.js` (no changes — uses existing `setState`/`loadGameData`)

## Fix 2: Send Combat State on Client Rejoin

**Location:** `server.js` `join_game` handler.

After emitting `game_joined`, check `gs.combatEngine.state.active`. If true, emit:
1. `combat_started` with initiative order and enemy summary
2. `combat_update` with current round, turn, all combatant HP/conditions, and recent combat log

This ensures reconnecting clients immediately see the combat overlay with correct state.

**Files:** `server.js` (join_game handler)

## Fix 3: Validate Combatant Data Before Dice Resolution

**Location:** `resolvers/dnd5e-resolver.js`

Guard `getAttackMod()` and related functions:
- If `combatant.abilities[ability]` is undefined, default ability score to 10 (mod +0)
- If `combatant.proficiencyBonus` is undefined, default to +2
- Log a warning when defaults are used for traceability

Same guards in `getSaveMod()` and any other function that reads ability scores.

**Files:** `resolvers/dnd5e-resolver.js`

## Files Touched

| File | Change |
|------|--------|
| `server.js` | Add combat state save after engine calls; restore on game load; emit combat state on rejoin |
| `combat-engine.js` | Add `loadState(saved)` method to hydrate from DB |
| `resolvers/dnd5e-resolver.js` | Guard against undefined abilities/proficiency, default to safe values |

## Non-Goals

- No new DB tables or schema changes (uses existing `game_state` key-value store)
- No changes to combat logic or game mechanics
- No client-side changes (client already handles `combat_started` and `combat_update` events)
