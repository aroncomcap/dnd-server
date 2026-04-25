# Test Audit - Validation Gaps Found

## Summary
Multiple tests have "holes" where they check surface behavior without validating actual outcomes. Similar to the verbose campaign issue (narration streaming "worked" but wasn't actually capturing text properly).

---

## 🔴 CRITICAL GAPS

### 1. Playwright Campaign Test (campaign-series.spec.ts:214)
**File:** `tests/e2e/campaign-series.spec.ts`
**Issue:** Level progression is CALCULATED, not VERIFIED

```javascript
// Current (WRONG):
currentLevel = 1 + Math.floor(totalTurns / turnsPerLevel);
expect(currentLevel).toBeGreaterThanOrEqual(targetLevel);  // ← passes if turns >= 90, regardless of actual leveling
```

**Problem:**
- Test plays 30 turns and ASSUMES player levels to 2
- Never queries actual player level from game state
- Test passes even if game engine is broken and never awards levels

**Fix Needed:**
- Query player level from game state via API or page DOM after each session
- Assert actual level matches expected level
- Verify XP/level progression mechanics work

**Severity:** CRITICAL - Core campaign progression mechanic is untested

---

### 2. Integration Game Lifecycle Test (integration-game-lifecycle.test.js:105)
**File:** `tests/integration-game-lifecycle.test.js`

```javascript
// Current (WRONG):
const loaded = result.rows[0].value;  // ← This is a JSON STRING
assert.equal(loaded.ferocity, 3);     // ← Accessing property on string!
```

**Problem:**
- `value` field is JSON-stringified in database
- Test tries to access `.ferocity` on a string, not object
- Test would fail if it actually ran properly

**Fix Needed:**
```javascript
const loaded = JSON.parse(result.rows[0].value);  // ← Parse first!
assert.equal(loaded.ferocity, 3);
```

**Severity:** HIGH - Test doesn't actually validate state persistence

---

## 🟡 MEDIUM GAPS

### 3. Socket.IO Streaming Events
**Context:** Discovered during verbose campaign testing

**Issue:** `dm_stream_chunk` events don't consistently carry text in `data.text` field
- Some chunks arrive empty
- Text occasionally in different fields
- No fallback handling in original code

**Current State:** Partially fixed with field name fallback (data.text || data.content || data.chunk || data.data)
**Remaining Issue:** Chunks from concurrent sessions can get jumbled (race condition)

**Fix Needed:**
- Add socket namespace/context tracking per game
- Ensure chunks are matched to correct turn/game
- Add queue or sequencing for multi-turn streams

---

## 📋 TEST COVERAGE GAPS

### Tests with Surface-Only Validation
These tests may PASS but don't validate actual behavior:

1. **action-parser.test.js** - Tests if parser runs, not if results are correct
2. **stat-parser.test.js** - Parses stats but doesn't verify accuracy
3. **socket-handlers.test.js** - Checks handler exists, not event behavior
4. **auth.test.js** - May not validate token expiry, permissions
5. **api-endpoints.test.js** - HTTP 200 response ≠ correct response body

---

## ✅ TESTS THAT LOOK SOLID

1. **combat-engine.test.js** - Properly validates state changes
2. **dice.test.js** - Validates actual dice roll ranges
3. **dnd5e-resolver.test.js** - Checks actual resolution outcomes

---

## Recommended Actions

**Priority 1 (Critical):**
- [ ] Fix Playwright campaign test to query actual player level
- [ ] Fix integration-game-lifecycle JSON parsing bug
- [ ] Add assertion that player level actually changes in game engine

**Priority 2 (High):**
- [ ] Audit all integration tests for JSON/object parsing issues
- [ ] Add actual output validation to API endpoint tests
- [ ] Fix socket streaming race condition between concurrent games

**Priority 3 (Medium):**
- [ ] Review action-parser, stat-parser for output accuracy
- [ ] Add token expiry/permission validation to auth tests
- [ ] Add response body validation to HTTP tests

---

## Testing Philosophy Going Forward

✅ **DO:** Validate actual outcomes, not just that code ran
✅ **DO:** Read/verify state after operations complete
✅ **DO:** Test edge cases and concurrent operations

❌ **DON'T:** Assume outcomes from input count (don't calculate levels, read them)
❌ **DON'T:** Test surface behavior (HTTP 200) without validating results
❌ **DON'T:** Skip deserialization/parsing steps (JSON.parse, etc.)

---

**Audit Date:** 2026-04-25
**Audit Scope:** All test files in `/tests/` directory
**Next Review:** After fixes are applied
