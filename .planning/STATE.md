---
milestone: v1.0
milestone_name: Production Stabilization
status: validating
current_phase: 5
current_plan: 05-01
progress:
  phases_total: 5
  phases_complete: 4
  plans_total: 5
  plans_complete: 4
updated_at: 2026-05-11
---

# State: They Still Sing / Tavern Table

## Current Position

Phase: 5 - Browser Campaign Verification
Plan: 05-01
Status: Browser campaign found a production turn-stall; local fix applied and deploy/rerun pending
Last activity: 2026-05-11 - Phase 6 AI design contract created for OpenAI-first model abstraction and player-visible narration A/B testing while Phase 5 remains the active stabilization gate.

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-05-11)

**Core value:** Players must be able to sign in, find or create a game, and receive reliable AI Game Master narration without broken turns, leaked system markers, or stalled flows.
**Current focus:** Production stabilization and verification.

## Recent Work

- Deployed commit `ac2e1fe` with narration stream parsing hardening.
- Confirmed production `/lobby` returned HTTP 200 after deploy.
- Authenticated live socket smoke completed against production, including game creation, party readiness, opening narration, and multiple turn-aware action responses.
- `npm test` now passes locally with 754 tests after serializing Node's test runner to avoid the Node 24 multi-file deserialization failure.
- Combat conclusion state is now recorded and injected into subsequent narration prompts so completed fights are treated as permanent state.
- Browser campaign harness now fails with actionable diagnostics on response stalls instead of timing out globally.
- Browser campaign rerun against production reached session 1 turn 2, then stalled with narration completed but the send button still pending and no usable action controls.
- Local turn-flow fix now advances turns before emitting the completed DM payload, makes turn persistence non-blocking for UI progress, and prevents duplicate sends while an action is in flight.
- `AGENTS.md` was created at repo root and remains untracked until explicitly committed.
- Phase 6 AI design contract created for OpenAI-first model abstraction and player-visible narration A/B testing.

## Blockers / Concerns

- Production `/lobby` returned HTTP 200 on 2026-05-10 through Cloudflare/Railway.
- Browser campaign E2E has not been rerun against a deployment containing the local turn-flow fix.
- Generated Playwright artifacts remain dirty and should not be committed casually.
- Working tree contains generated/test artifacts that should not be committed casually.

## Decisions

- Bootstrap GSD around the current stabilization loop before adding new product work.
- Keep long browser/AI-credit checks behind narrow validation.
- Preserve existing app architecture and auth/game APIs during stabilization.
- Phase 6 execution is authorized to run unattended with AI SDK under the local `llm` adapter, `gpt-5.4-mini`/`gpt-5.4` narration split at 70/30, full prompt/output capture during the model lab, periodic raw-text cleanup, subtle player feedback after narrations, and commit/push/deploy/test autonomy.
- Commit immediately before Phase 6 runtime changes is the final Claude-based baseline.

## Deferred Ideas

- Richer lobby/game discovery enhancements.
- Broader observability improvements.
- Auth-provider strategy revisit if Passport/OAuth maintenance becomes the real blocker.
- LLM model lab execution should wait until the Phase 5 browser campaign gate is closed, then use `.planning/phases/06-model-abstraction-narration-ab-testing/06-AI-SPEC.md` as the design contract.

## Next Recommended Run

Deploy or otherwise run against an environment containing the local turn-flow fix, then run final browser validation gate:

1. `npx playwright test tests/e2e/campaign-verbose.spec.ts --project=chromium`
