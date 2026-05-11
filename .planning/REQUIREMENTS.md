# Requirements: They Still Sing / Tavern Table

**Defined:** 2026-05-10
**Core Value:** Players must be able to sign in, find or create a game, and receive reliable AI Game Master narration without broken turns, leaked system markers, or stalled flows.

## v1.0 Requirements

Requirements for the Production Stabilization milestone.

### Live Validation

- [x] **LIVE-01**: Production `/lobby` is reachable and serves the deployed app through Cloudflare/Railway.
- [x] **LIVE-02**: Authenticated socket smoke test creates a game, generates a party, receives opening narration, and receives responses for multiple player actions.
- [x] **LIVE-03**: Live smoke follows actual turn order so out-of-turn submissions do not create false failures.

### Browser Campaign Coverage

- [x] **E2E-01**: Campaign browser test waits only for new completed DM messages, not stale/tip/idle states.
- [x] **E2E-02**: Campaign browser test clicks only visible/enabled action controls.
- [ ] **E2E-03**: Fresh post-deploy campaign run either reaches its target or records the exact remaining product failure. Current production run recorded a turn-stall; local fix is pending deploy/rerun.

### Narration Reliability

- [x] **NARR-01**: Streamed narration never displays `---OPTIONS---`, `---SCENE---`, or `---WORLD---` markers to players.
- [x] **NARR-02**: Server parsing handles inline or jammed structured markers from model output.
- [x] **NARR-03**: Client rendering has a defensive sanitizer for structured marker leakage.

### Test Health

- [x] **TEST-01**: Focused parser/UI regression tests pass locally.
- [x] **TEST-02**: Source syntax checks pass for touched server/client pipeline modules.
- [x] **TEST-03**: `npm test` is fully green, or the remaining Node test-runner deserialization failure is documented/quarantined with a narrow remediation plan.

### Repo Hygiene

- [x] **HYGIENE-01**: Planning files exist and `gsd-autonomous` can discover incomplete phases.
- [x] **HYGIENE-02**: Generated Playwright artifacts are not committed as source changes.
- [x] **HYGIENE-03**: Unrelated worktree metadata changes are not overwritten without confirmation.

## v1.1 Requirements

Deferred beyond this stabilization pass.

### Product Expansion

- **PROD-01**: Improve game discovery beyond access-list card grid.
- **PROD-02**: Add richer join-code flows if live usage shows confusion.
- **PROD-03**: Revisit auth provider strategy only if Passport/OAuth maintenance becomes a blocker.

## Out of Scope

| Feature | Reason |
|---------|--------|
| New RPG mechanics | Stabilization must first prove the current game loop works reliably. |
| Broad visual redesign | Current risk is correctness and flow reliability, not brand exploration. |
| Replacing Passport.js | Existing auth is already integrated; provider replacement is not required for this milestone. |
| Full production observability redesign | Useful later, but current scope is verification and broken-test cleanup. |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| HYGIENE-01 | Phase 1 | Done |
| HYGIENE-02 | Phase 1 | Done |
| HYGIENE-03 | Phase 1 | Done |
| NARR-01 | Phase 2 | Done |
| NARR-02 | Phase 2 | Done |
| NARR-03 | Phase 2 | Done |
| TEST-01 | Phase 2 | Done |
| TEST-02 | Phase 2 | Done |
| TEST-03 | Phase 3 | Done |
| LIVE-01 | Phase 4 | Done |
| LIVE-02 | Phase 4 | Done |
| LIVE-03 | Phase 4 | Done |
| E2E-01 | Phase 5 | Done |
| E2E-02 | Phase 5 | Done |
| E2E-03 | Phase 5 | Pending |

**Coverage:**
- v1.0 requirements: 15 total
- Mapped to phases: 15
- Unmapped: 0

---
*Requirements defined: 2026-05-10*
*Last updated: 2026-05-10 after GSD bootstrap*
