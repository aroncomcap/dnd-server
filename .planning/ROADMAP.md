# Roadmap: They Still Sing / Tavern Table

## Overview

This milestone turns the existing live app into a verified production baseline. The work starts by stabilizing the planning/repo surface, then locks down narration parsing and targeted tests, resolves the remaining Node test-health issue, preserves player intent through encounter interpretation, and finishes with live smoke plus browser campaign validation against `theystillsing.com`.

After the stabilization gate, the next product milestone is a provider-agnostic LLM layer with player-visible narration A/B testing so model quality can be compared against real cost and latency.

## Milestones

- 🚧 **v1.0 Production Stabilization** - Phases 1-5 (in progress)
- 🧭 **v1.1 LLM Model Lab** - Phase 6 (design ready)

## Phases

**Phase Numbering:**
- Integer phases are planned milestone work.
- Decimal phases are urgent insertions if production issues appear mid-run.

- [x] **Phase 1: GSD Bootstrap And Repo Hygiene** - Make planning discoverable and keep generated artifacts isolated.
- [x] **Phase 2: Narration Regression Baseline** - Verify parser/client narration hardening and focused tests.
- [x] **Phase 3: Node Test Health** - Resolve or quarantine the remaining integration deserialization failure.
- [x] **Phase 4: Live Production Smoke** - Prove the deployed auth/socket/game loop completes.
- [ ] **Phase 5: Browser Campaign Verification** - Run the long browser campaign with the patched harness and capture any real remaining failures.
- [ ] **Phase 5.1: Director-First Combat Recovery And Target Authority** - Fix target-required actions, combat trapping, and story recovery controls found by the production campaign gate.
- [ ] **Phase 6: Model Abstraction And Narration A/B Testing** - Replace Anthropic runtime calls with an OpenAI-first provider abstraction and compare narration models using player-visible feedback, cost, latency, and reliability.

## Phase Details

### Phase 1: GSD Bootstrap And Repo Hygiene
**Goal**: Initialize GSD planning state and separate real source/planning changes from generated artifacts.
**Depends on**: Nothing (first phase)
**Requirements**: [HYGIENE-01, HYGIENE-02, HYGIENE-03]
**Success Criteria** (what must be TRUE):
  1. `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, and `.planning/STATE.md` exist.
  2. `roadmap.analyze` can see incomplete phases.
  3. Generated Playwright artifacts are identified separately from source/planning changes.
  4. No unrelated dirty file is overwritten or committed accidentally.
**Plans**: 1 plan

Plans:
- [x] 01-01: Bootstrap planning docs and validate GSD discovery.

### Phase 2: Narration Regression Baseline
**Goal**: Confirm the deployed narration parser/client hardening is covered by narrow tests and syntax checks.
**Depends on**: Phase 1
**Requirements**: [NARR-01, NARR-02, NARR-03, TEST-01, TEST-02]
**Success Criteria** (what must be TRUE):
  1. Focused parser and UI regression tests pass.
  2. `server.js`, `narration-pipeline.js`, and related touched modules pass syntax checks.
  3. Tests prove inline or jammed structured AI markers do not leak into player-facing narration.
**Plans**: 1 plan

Plans:
- [x] 02-01: Run and record focused narration/test verification.

### Phase 3: Node Test Health
**Goal**: Make the Node test suite actionable by fixing or isolating the remaining integration deserialization failure.
**Depends on**: Phase 2
**Requirements**: [TEST-03]
**Success Criteria** (what must be TRUE):
  1. `npm test` passes, or the failing integration file is quarantined with a documented root cause and narrow follow-up.
  2. The deserialization failure is not confused with the recent narration or browser harness changes.
  3. The chosen resolution preserves useful integration coverage.
**Plans**: 1 plan

Plans:
- [x] 03-01: Investigate and resolve/quarantine Node test-runner deserialization failure.

### Phase 4: Live Production Smoke
**Goal**: Prove the deployed production game loop works end to end with real auth, sockets, party generation, narration, and player turns.
**Depends on**: Phase 3
**Requirements**: [LIVE-01, LIVE-02, LIVE-03]
**Success Criteria** (what must be TRUE):
  1. `/lobby` returns HTTP 200 from production.
  2. `test-game-flow.js` completes without interruption against `https://theystillsing.com`.
  3. Smoke output shows authenticated game creation, party readiness, opening narration, and multiple action responses.
  4. The smoke script submits actions for the current turn holder.
**Plans**: 1 plan

Plans:
- [x] 04-01: Run live smoke and record production result.

### Phase 5: Browser Campaign Verification
**Goal**: Validate the browser campaign path with the patched Playwright harness and capture any remaining product failures precisely.
**Depends on**: Phase 4
**Requirements**: [E2E-01, E2E-02, E2E-03, INTENT-01, INTENT-02, FEEDBACK-01, FEEDBACK-02]
**Success Criteria** (what must be TRUE):
  1. Campaign test uses new completed DM messages as the action-response condition.
  2. Campaign test only clicks enabled visible controls.
  3. A fresh Chromium campaign run either reaches target completion or produces an actionable failure artifact.
  4. Any generated reports remain uncommitted unless explicitly requested.
  5. Non-hostile player intent, partial commands, and scene-transition input do not auto-route to combat.
  6. Review/retcon/redo feedback produces actionable traceable signals for follow-up fixes.
**Plans**: 2 plans

Plans:
- [x] 05-01: Preserve player intent and actionable GM feedback.
- [x] 05-02: Deploy current stabilization batch, rerun production campaign E2E, and triage result.

### Phase 5.1: Director-First Combat Recovery And Target Authority
**Goal**: Restore the solo-DM feel by making the story director authoritative over combat entry/recovery, while giving the combat engine reliable target context before any target-required action resolves.
**Depends on**: Phase 5
**Requirements**: [TARGET-01, TARGET-02, RECOVERY-01, COMBAT-01, COMBAT-02]
**Success Criteria** (what must be TRUE):
  1. Target-required attacks, spells, features, and support actions validate a real target before resolution or resource spending.
  2. Each player can persist an attack target and support target; defaults are useful and remain stable until changed.
  3. `Move to Next Beat` clears ephemeral scene/combat state and advances the story beat without erasing durable campaign state.
  4. Combat remains round-by-round by default, with optional cinematic finish available by proposal/approval.
  5. The production campaign no longer falls into accidental targetless combat from social or routing scenes.
**Plans**: 1 plan

Plans:
- [x] 05.1-01: Target authority, recovery, and optional combat compression.

### Phase 6: Model Abstraction And Narration A/B Testing
**Goal**: Replace Anthropic as the runtime LLM dependency with an OpenAI-first model abstraction layer and run sticky, player-visible narration experiments that identify the best quality-per-dollar model.
**Depends on**: Phase 5
**Requirements**: [LLM-01, LLM-02, LLM-03, LLM-04, LLM-05, LLM-06, LLM-07]
**Success Criteria** (what must be TRUE):
  1. Game logic calls a local provider-agnostic `llm` interface instead of vendor SDKs directly.
  2. OpenAI Responses API handles streamed narration and structured extraction through normalized adapter methods.
  3. Narration experiments assign sticky variants per game/session while hiding model identity from players.
  4. Players can rate completed DM narrations with compact visible feedback controls.
  5. Telemetry records provider, model, task, latency, token usage, estimated cost, status, experiment variant, and feedback.
  6. Admin/reporting surfaces compare quality, cost per 100 turns, latency, failures, and feedback tags by variant.
  7. Anthropic is no longer required for production runtime LLM calls.
**AI Design Contract**: `.planning/phases/06-model-abstraction-narration-ab-testing/06-AI-SPEC.md`
**Plans**: 0 plans

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. GSD Bootstrap And Repo Hygiene | 1/1 | Complete | 2026-05-10 |
| 2. Narration Regression Baseline | 1/1 | Complete | 2026-05-10 |
| 3. Node Test Health | 1/1 | Complete | 2026-05-10 |
| 4. Live Production Smoke | 1/1 | Complete | 2026-05-10 |
| 5. Browser Campaign Verification | 2/2 | Fresh deploy succeeded; campaign found target/combat recovery defects | 2026-05-17 |
| 5.1. Director-First Combat Recovery And Target Authority | 1/1 | Local verification passed; production campaign rerun pending | - |
| 6. Model Abstraction And Narration A/B Testing | 0/0 | Design ready for planning after Phase 5 | - |
