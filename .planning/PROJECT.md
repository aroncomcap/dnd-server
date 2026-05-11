# They Still Sing / Tavern Table

## What This Is

They Still Sing is a multiplayer tabletop RPG web app where players create or join games and an AI Game Master runs the session in real time. It uses Express, Socket.IO, PostgreSQL, Passport auth, Anthropic narration/extraction, Together scene images, and Railway/Cloudflare production hosting.

The current product is already live at `theystillsing.com`. The immediate milestone is production stabilization: prove the newly deployed auth, lobby, narration, and game-flow fixes work end to end, then clean up the remaining test and repo-health issues.

The next planned product expansion is an OpenAI-first, provider-agnostic LLM layer with player-visible narration A/B testing so model quality can be compared against live cost, latency, and reliability.

## Core Value

Players must be able to sign in, find or create a game, and receive reliable AI Game Master narration without broken turns, leaked system markers, or stalled flows.

## Current Milestone: v1.0 Production Stabilization

**Goal:** Turn the live app into a verified, repeatably testable production baseline after the recent auth, lobby, and narration fixes.

**Target features:**
- Complete live post-deploy smoke validation for authenticated game creation, party generation, turn advancement, and streamed narration.
- Rerun and stabilize browser campaign coverage against the deployed site.
- Resolve or explicitly quarantine the remaining Node test-runner integration failure.
- Keep the repo clean by separating generated artifacts from source and planning changes.

## Requirements

### Validated

- ✓ Live Railway deploy pipeline works and recently deployed commit `ac2e1fe` successfully.
- ✓ `/lobby` returns HTTP 200 from production behind Cloudflare/Railway.
- ✓ Returning users route to a game-card lobby, while users without games are routed toward new-game creation.
- ✓ Game cards support delete confirmation requiring typed `CONFIRM`.
- ✓ Client navigation tabs are bound and covered by regression tests.
- ✓ Narration parser and browser renderer strip structured AI markers before player display in unit/regression coverage.

### Active

- [ ] Live socket smoke completes after deploy without manual interruption.
- [ ] Browser campaign E2E completes with fresh post-fix code or produces a precise, actionable failure.
- [ ] `npm test` either passes fully or the remaining integration deserialization failure is isolated with an explicit plan.
- [ ] Generated Playwright artifacts and transient worktree metadata are not mixed into source/planning commits.
- [ ] GSD planning state is initialized enough for `gsd-autonomous` to discover and execute phases.

### Out of Scope

- New gameplay features — this milestone is stabilization, not expansion.
- LLM provider replacement and narration experimentation — designed for v1.1 Phase 6 after the stabilization gate.
- Large auth-provider replacement — keep Passport/local/OAuth patterns unless a focused phase decides otherwise.
- Visual redesign beyond fixing broken states — UI work here should support verification and usability, not restyle the product.
- Mobile/native app work — web production stability comes first.

## Context

- Repository: `github.com/aroncomcap/dnd-server`.
- Deployment: Railway service/project `dnd-server`, domain `theystillsing.com` via Cloudflare.
- Runtime: Node.js app with Express, Socket.IO, PostgreSQL, Passport, Anthropic, Together, Resend, Stripe, and Discord integration.
- Current source of project knowledge before GSD bootstrap: `CLAUDE.md`, README, tests, and recent commits.
- Recent relevant commits:
  - `defc299` — gameplay UI regressions.
  - `ac2e1fe` — narration stream parsing hardening.
- Current known dirty/generated artifacts include Playwright report/test-results output and a deleted `.claude/worktrees/feature-work`; these should not be treated as product work without review.

## Constraints

- **Production safety:** Live smoke tests can spend AI credits; prefer narrow checks before long campaigns.
- **Architecture:** Preserve existing Express/Socket.IO/Passport/PostgreSQL patterns.
- **Testing:** Use existing `npm test`, Playwright scripts, and focused Node tests before inventing new harnesses.
- **Git hygiene:** Do not commit generated reports or unrelated dirty files.
- **Auth:** Preserve API compatibility for `/auth/*`, `/lobby`, `/new-game`, `/game/:id`, and game/socket flows.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Bootstrap GSD around stabilization first | The repo is live and has unresolved validation work; planning should capture the real open loop before new feature work. | Pending |
| Treat long browser campaign as a verification phase | It is costly and slow, so it should run after narrow smoke and parser/unit checks are green. | Pending |
| Keep generated artifacts out of milestone commits | Prevents noisy diffs and accidental deletion/reversion of user or tool output. | Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition**:
1. Requirements invalidated? Move to Out of Scope with reason.
2. Requirements validated? Move to Validated with phase reference.
3. New requirements emerged? Add to Active.
4. Decisions to log? Add to Key Decisions.
5. "What This Is" still accurate? Update if drifted.

**After each milestone**:
1. Full review of all sections.
2. Core Value check: still the right priority?
3. Audit Out of Scope: reasons still valid?
4. Update Context with current state.

---
*Last updated: 2026-05-11 after Phase 6 LLM model lab design*
