---
title: Split System Prompts + Automated Opus Review
date: 2026-04-27
status: approved
---

# Split System Prompts + Automated Opus Review Design

## Problem Statement

Haiku narration ignores player actions and cycles through generic descriptions (e.g., repeated "tavern door swings open" regardless of player choice). Root cause: 500-line system prompt with massive world context causes Claude to pattern-match on background descriptions instead of following "PLAYER ACTION:" instruction in user message.

## Solution Overview

Split the system prompt into two versions:
- **Minimal prompt** (~80 lines): D&D rules, character stats, current location, ferocity, pillars, output format. Used for 90% of turns.
- **Full prompt** (~500 lines): Minimal + world context, campaign lore, NPC memory, encounter plans. Used for story moments and exploration.

Add automated Opus review to detect prompt bloat and drift (triggered on-edit and weekly).

## Architecture

### System Prompt Split

**File: `prompt-builder.js`**

Export two functions:
- `buildMinimalPrompt(gameConfig, gameState)` — D&D rules + character stats + location only
- `buildFullPrompt(gameConfig, gameState)` — Minimal + world context

```javascript
function buildMinimalPrompt(gameConfig, gameState) {
  const system = gameConfig.system || 'dnd5e'

  switch(system) {
    case 'dnd5e':
      return buildMinimalPrompt_DnD(gameState)
    case 'runequest':
      return buildMinimalPrompt_RuneQuest(gameState)
    default:
      return buildMinimalPrompt_DnD(gameState)
  }
}

function buildFullPrompt(gameConfig, gameState) {
  const system = gameConfig.system || 'dnd5e'

  switch(system) {
    case 'dnd5e':
      return buildFullPrompt_DnD(gameState)
    case 'runequest':
      return buildFullPrompt_RuneQuest(gameState)
    default:
      return buildFullPrompt_DnD(gameState)
  }
}
```

### Minimal Prompt Contents (D&D)

~80 lines covering:
- Base role ("You are the DM for D&D 5e")
- RULE #1: Word limit (terse/brief/verbose)
- RULE #2: Combat is tactical
- Character block (names, stats, personality, backstory)
- Current level + ferocity + pillars
- Output format (OPTIONS, SCENE, WORLD, ACCOMPLISHMENTS, etc.)
- DM persona (epic or over-the-top)

**Omitted from minimal:**
- Campaign source material
- Story summary
- Encounter plan
- NPC memory
- Treasure tables
- All extended lore/world-building

### Full Prompt Contents (D&D)

Minimal prompt + all world context (current 500-line prompt).

### Prompt Selection Logic

**File: `server.js` and `game-engine.js`**

When calling Claude:

```javascript
// Combat turns: ALWAYS use minimal prompt
if (gs.combatEngine?.state?.active) {
  systemPrompt = buildMinimalPrompt(gameConfig, gs)
}

// Non-combat turns:
const isStoryMoment = turn.flags?.story || turn.flags?.npc || turn.flags?.exploration
const systemPrompt = isStoryMoment
  ? buildFullPrompt(gameConfig, gs)
  : buildMinimalPrompt(gameConfig, gs)
```

Story moment flags can be set by:
- Encounter plan: When `gs._pendingChallenge` or major story beat is active
- NPC interaction: When turn includes NPC dialogue or a named NPC action
- Exploration turn: When player chooses to investigate a new location (search for patterns in action text)
- Manual flag: `/story` command or game config sets `turn.flags.story = true`

Default behavior: Use minimal prompt unless one of the above conditions is true.

## Automated Opus Review

### Trigger 1: On-Edit (Git Hook)

When `prompt-builder.js` changes:
- Run Opus analysis
- Report bloat/drift findings
- Does NOT block merge (informational only)

### Trigger 2: Scheduled (Weekly Cron)

Every Monday 6 AM UTC:
- Run Opus analysis even if no changes
- Catches drift from code changes outside the prompt
- Report sent to logs

### Opus Review Process

**Prompt for Opus:**
```
Review this D&D game narration system prompt for bloat and drift.

MINIMAL PROMPT REVIEW (buildMinimalPrompt_DnD):
- Are all ~80 lines necessary for basic gameplay?
- Any duplicate rules or redundant sections?
- Is the word limit rule clear?
- Are character stats and location always up-to-date?

FULL PROMPT REVIEW (buildFullPrompt_DnD):
- World context: Still relevant? Outdated?
- NPC memory section: Are NPCs from old encounters still listed?
- Encounter plans: Do they match game-engine.js code?
- Story summary: Is it consistent with recent turns?

DRIFT DETECTION:
- New handlers in game-engine.js not mentioned in prompt?
- New game features (pillars, ferocity system) documented?
- Old features still described but removed from code?

REPORT:
- Bloat candidates (section | reason | line numbers)
- Drift issues (feature | status)
- Recommendations (prioritized)
```

## Implementation Order

1. Extract D&D minimal prompt from current `buildSystemPrompt()` into `buildMinimalPrompt_DnD()`
2. Rename current `buildSystemPrompt()` to `buildFullPrompt_DnD()`
3. Add system selector logic to `buildMinimalPrompt()` and `buildFullPrompt()`
4. Update `server.js` and `game-engine.js` to use prompt selection logic
5. Set up on-edit git hook for Opus review
6. Set up weekly cron job for Opus review

## Benefits

- **Fixes narration issue immediately**: Small prompt = Claude follows instructions instead of pattern-matching
- **Cheap**: 90% of turns use minimal prompt (fewer tokens)
- **Extensible**: RuneQuest or other systems can add their own minimal/full builders later
- **Maintainable**: Opus review catches prompt drift before it becomes a problem
- **No breaking changes**: Full prompt still available for story moments

## Testing

- Verify minimal prompt turns produce action-specific narration (not generic cycles)
- Verify combat turns still use server narration (no Claude calls)
- Verify story moment turns use full prompt and include world context
- Verify Opus review reports are generated on-edit and weekly

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Story moment detection fails | Start with conservative flags (explicit `/story` command); add heuristics later |
| Minimal prompt too small | Full prompt still available; easy to adjust minimal prompt size |
| Opus review is too noisy | Filter findings; only report if new issues detected |

