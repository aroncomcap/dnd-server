---
milestone: v1.0
milestone_name: Production Stabilization
status: verifying
current_phase: 5.1
current_plan: 05.1-01
progress:
  phases_total: 6
  phases_complete: 4
  plans_total: 6
  plans_complete: 6
updated_at: 2026-05-17
---

# State: They Still Sing / Tavern Table

## Current Position

Phase: 5.1 - Director-First Combat Recovery And Target Authority
Plan: context gathering
Status: Phase 5.1 implemented locally and verified; production deploy/campaign rerun pending
Last activity: 2026-05-17 - Implemented target authority, deterministic tactical combat fast path, persistent target selectors, `Move to Next Beat`, and optional `Finish Cinematically`. Full `npm test` passed with 866 tests.

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
- Railway production now points at deployment `f38acd5c-4ac1-4d36-862a-435bca5c0c52` from 2026-05-17.
- The fresh production campaign run reached live play but exposed target authority defects: invalid/placeholder targets, target-required actions resolving instead of prompting, and social scenes being pulled into combat by generic attack controls.
- The long campaign run was stopped after actionable evidence to avoid additional production AI spend.
- Phase 5.1 local implementation now routes parseable tactical combat through server-side rules by default, skipping narration LLM calls for low-value combat actions.
- Enemy turns now use deterministic server tactics by default; `ENEMY_TACTICS_LLM=true` can opt back into model-generated enemy tactics.
- Target-required actions now return `target_required` before dice, turn advancement, or spell-slot spending when the target is missing or illegal.
- Combat target preferences are persisted per player and surfaced as attack/support selectors in the action area.
- `Move to Next Beat` replaces the reset-game affordance for stuck-scene recovery.

## Blockers / Concerns

- Browser campaign E2E has been rerun against the fresh deployment and produced actionable target/combat defects.
- Generated Playwright artifacts from the interrupted production campaign remain dirty under `test-results/` and should not be committed casually.
- `gsd-sdk` is not installed in this Codex shell, so GSD autonomous routing is being followed manually from repo-local `.planning` files.

## Decisions

- Bootstrap GSD around the current stabilization loop before adding new product work.
- Keep long browser/AI-credit checks behind narrow validation.
- Preserve existing app architecture and auth/game APIs during stabilization.
- Phase 6 execution is authorized to run unattended with AI SDK under the local `llm` adapter, `gpt-5.4-mini`/`gpt-5.4` narration split at 70/30, full prompt/output capture during the model lab, periodic raw-text cleanup, subtle player feedback after narrations, and commit/push/deploy/test autonomy.
- Commit immediately before Phase 6 runtime changes is the final Claude-based baseline.
- Combat remains round-by-round by default once initiative starts.
- Cinematic combat finish is optional, visible throughout combat, recommended only when the fight is nearly decided, available for any player to propose, and proceeds immediately when there is only one active player.
- The recovery button label is `Move to Next Beat`; it is for bugs/logical dead ends and should preserve durable campaign state while clearing ephemeral scene/combat state.
- Tactical combat should use deterministic server output by default. AI narration is reserved for story/director moments, ambiguous creative actions, meaningful aftermath, and explicit flavor needs.

## Deferred Ideas

- Richer lobby/game discovery enhancements.
- Broader observability improvements.
- Auth-provider strategy revisit if Passport/OAuth maintenance becomes the real blocker.
- LLM model lab execution should wait until the Phase 5 browser campaign gate is closed, then use `.planning/phases/06-model-abstraction-narration-ab-testing/06-AI-SPEC.md` as the design contract.

## Next Recommended Run

Commit, push, deploy, and rerun the production campaign gate for Phase 5.1. Keep generated Playwright artifacts out of the commit.
