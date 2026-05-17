---
milestone: v1.0
milestone_name: Production Stabilization
status: validating
current_phase: 5
current_plan: 05-02
progress:
  phases_total: 5
  phases_complete: 4
  plans_total: 6
  plans_complete: 5
updated_at: 2026-05-17
---

# State: They Still Sing / Tavern Table

## Current Position

Phase: 5 - Browser Campaign Verification
Plan: 05-02
Status: Intent/review stabilization batch is locally verified; commit, deploy, and production campaign rerun are pending
Last activity: 2026-05-17 - Player intent preservation, actionable GM feedback, Retcon OOC mode, Redo Options regeneration, and traceable OOC/review bug logging were implemented and locally verified.

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
- Player intent parsing now distinguishes dialogue and advancement from combat, defaults ambiguous input to non-hostile progress, and prevents nearby scene/combat text from overriding the player's stated intent.
- Prompting and narration extraction now preserve quest beats, treat merchant/watch/checkpoint scenes as brief social/routing scenes, and only detour into combat on clear violence or unavoidable hard failure.
- Tune GM feedback is now actionable: Rules, Context, Redo Options, Retcon, and Review. Review/Retcon/Redo Options can log bug reports with slug, source, and decision trace metadata for later Codex repair.
- Local verification passed syntax checks, focused parser/UI regression tests, full `npm test`, and `git diff --check`.
- Railway production still points at deployment `1d9e218d-0120-4d23-a5a2-5417805daac7` from 2026-05-13; no newer build has been deployed yet.

## Blockers / Concerns

- Browser campaign E2E has not been rerun against a deployment containing the current intent/review stabilization batch.
- Current working tree contains intentional source/test changes that are locally verified but not committed or deployed.
- Production logs show a separate runtime issue: `Combat engine error (falling back to AI): Invalid dice notation: "none"` during spell resolution.

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

Commit, push, and deploy the current intentional source/test batch, then run the final browser validation gate against the new deployment:

1. `git add action-parser.js combat-engine.js db.js narration-pipeline.js prompt-builder.js public/game.html server.js tests/action-parser.test.js tests/game-ui-regression.test.js .planning/STATE.md .planning/ROADMAP.md .planning/REQUIREMENTS.md .planning/phases/05-browser-campaign-verification/05-01-PLAN.md .planning/phases/05-browser-campaign-verification/05-01-SUMMARY.md`
2. `git commit -m "fix: preserve player intent in encounter flow"`
3. `git push`
4. `railway deployment list`
5. `npx playwright test tests/e2e/campaign-verbose.spec.ts --project=chromium`
