# Summary 05-01: Preserve Player Intent And Actionable GM Feedback

## Outcome

Implemented and locally verified the intent-preservation and actionable feedback stabilization batch.

## Changed Areas

- `action-parser.js`: Added explicit dialogue and advance intents, broader non-hostile phrase handling, emoji-prefixed action parsing, and conservative fallbacks that default uncertain input to conversation or progress instead of combat.
- `combat-engine.js`: Allows dialogue and advance action types to resolve without forcing a combat/check shape.
- `db.js`: Extends bug reports with `slug`, `source`, and `decision_trace`, plus migrations and `getLlmRun()` for trace capture.
- `narration-pipeline.js`: Suppresses extracted enemies after non-hostile/progress input unless a hard combat signal exists.
- `prompt-builder.js`: Instructs the GM to preserve quest beats, keep merchant/watch/checkpoint scenes brief and social, and only emit combat enemies when initiative should truly start.
- `server.js`: Adds non-hostile progress guards, OOC self-assessment bug logging, actionable narration feedback tags, Retcon OOC mode support, and Redo Options regeneration with decision trace logging.
- `public/game.html`: Collapses Tune GM controls to actionable buttons, adds Retcon visual OOC mode, wires Redo Options, and improves combat log rendering for non-combat action types.
- `tests/action-parser.test.js`: Covers dialogue, advance, social/progress options, ambiguous defaults, and emoji-prefixed attack parsing.
- `tests/game-ui-regression.test.js`: Covers actionable Tune GM controls, Retcon OOC arming, Redo Options regeneration, and non-hostile/progress prompt guardrails.

## Validation

- Passed `node --check` for touched runtime modules.
- Passed focused parser/UI regression tests: `node --test tests/action-parser.test.js tests/game-ui-regression.test.js`.
- Passed full suite: `npm test`.
- Passed `git diff --check`.

## Follow-Up

- Commit and push the current intentional source/test batch.
- Confirm Railway creates a deployment newer than `2026-05-13 03:39:48 -04:00`.
- Rerun the production browser campaign gate against `theystillsing.com`.
- Track the production runtime issue seen in logs: `Invalid dice notation: "none"` during spell resolution.
