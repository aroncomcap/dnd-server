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
- [ ] **E2E-03**: Fresh post-deploy campaign run either reaches its target or records the exact remaining product failure. Current production run recorded a stale deployment; current intent/review stabilization batch is pending commit, deploy, and rerun.

### Narration Reliability

- [x] **NARR-01**: Streamed narration never displays `---OPTIONS---`, `---SCENE---`, or `---WORLD---` markers to players.
- [x] **NARR-02**: Server parsing handles inline or jammed structured markers from model output.
- [x] **NARR-03**: Client rendering has a defensive sanitizer for structured marker leakage.

### Test Health

- [x] **TEST-01**: Focused parser/UI regression tests pass locally.
- [x] **TEST-02**: Source syntax checks pass for touched server/client pipeline modules.
- [x] **TEST-03**: `npm test` is fully green, or the remaining Node test-runner deserialization failure is documented/quarantined with a narrow remediation plan.

### Intent And Feedback Stabilization

- [x] **INTENT-01**: Encounter parsing preserves non-hostile player intent. Speak, parley, negotiate, ask, offer peace, travel, acknowledgement, and scene-transition phrasing route to dialogue or progress unless the player explicitly chooses violence.
- [x] **INTENT-02**: Merchant, watch, checkpoint, routing, and social scenes stay brief and non-combat unless a hostile action or unavoidable hard failure requires initiative.
- [x] **FEEDBACK-01**: OOC/review self-assessment can log a bug with slug, source, and decision trace when the game identifies a programming improvement.
- [x] **FEEDBACK-02**: Player-visible GM feedback controls are actionable only, with Retcon arming OOC mode and Redo Options regenerating scene-specific options while logging a decision trace.

### Repo Hygiene

- [x] **HYGIENE-01**: Planning files exist and `gsd-autonomous` can discover incomplete phases.
- [x] **HYGIENE-02**: Generated Playwright artifacts are not committed as source changes.
- [x] **HYGIENE-03**: Unrelated worktree metadata changes are not overwritten without confirmation.

## v1.1 Requirements

Deferred beyond this stabilization pass.

### LLM Model Lab

- [ ] **LLM-01**: Runtime LLM calls go through a local provider-agnostic abstraction instead of direct Anthropic/OpenAI SDK usage in game logic.
- [ ] **LLM-02**: OpenAI is the primary production LLM provider and Anthropic is not required for production runtime calls.
- [ ] **LLM-03**: Streamed narration uses the abstraction layer and preserves the existing no-stall turn lifecycle guarantees.
- [ ] **LLM-04**: Structured extraction, validation, summaries, party generation, OOC, and side AI calls are migrated behind the abstraction with task-specific model routing.
- [ ] **LLM-05**: Narration A/B experiments assign sticky variants per game/session and compare OpenAI models on quality, latency, reliability, and estimated cost.
- [ ] **LLM-06**: Players see compact feedback controls after completed DM narrations without seeing model/provider identity.
- [ ] **LLM-07**: Admin/reporting can compare experiment variants by rating, feedback tags, cost per 100 turns, latency, failure rate, fallback rate, and marker/options compliance.

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
| INTENT-01 | Phase 5 | Done |
| INTENT-02 | Phase 5 | Done |
| FEEDBACK-01 | Phase 5 | Done |
| FEEDBACK-02 | Phase 5 | Done |
| LLM-01 | Phase 6 | Design ready |
| LLM-02 | Phase 6 | Design ready |
| LLM-03 | Phase 6 | Design ready |
| LLM-04 | Phase 6 | Design ready |
| LLM-05 | Phase 6 | Design ready |
| LLM-06 | Phase 6 | Design ready |
| LLM-07 | Phase 6 | Design ready |

**Coverage:**
- v1.0 requirements: 19 total
- Mapped to phases: 19
- v1.1 LLM requirements: 7 total
- Mapped to phases: 7
- Unmapped: 0

---
*Requirements defined: 2026-05-10*
*Last updated: 2026-05-17 after Phase 5 intent/review stabilization*
