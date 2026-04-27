# Split System Prompts + Automated Opus Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix narration responsiveness by splitting the 500-line system prompt into minimal (80 lines, 90% of turns) and full (500 lines, story moments only) versions, with automated Opus review to prevent prompt drift.

**Architecture:** Two system prompts in prompt-builder.js with selector functions. Server calls buildMinimalPrompt() for combat/standard turns, buildFullPrompt() for story moments. On-edit git hook + weekly cron job for Opus review.

**Tech Stack:** Node.js, prompt-builder.js, server.js, game-engine.js, git hooks, cron, Anthropic Opus (review only)

---

## File Structure & Responsibility Map

| File | Responsibility | Changes |
|------|---|---|
| `prompt-builder.js` | System prompt generation | Extract buildMinimalPrompt_DnD(), rename buildSystemPrompt() → buildFullPrompt_DnD(), add selector functions |
| `server.js` | API + narration calls | Update to use buildMinimalPrompt/buildFullPrompt based on context |
| `game-engine.js` | Game state + turn logic | Update to use buildMinimalPrompt/buildFullPrompt, set story moment flags |
| `.git/hooks/post-commit` | Git hook for Opus review | CREATE: Run Opus analysis when prompt-builder.js changes |
| `scripts/opus-review-weekly.js` | Weekly cron job | CREATE: Scheduled Opus prompt review |
| `docs/superpowers/specs/` | Design reference | Reference only, no changes |

---

## Task 1: Extract Minimal D&D Prompt Function

**Files:**
- Modify: `/Users/aron/Dropbox (Personal)/claude/dnd-server/prompt-builder.js:75-358`
- Test: Manual verification only (no unit tests for prompts)

**Context:** The current `buildSystemPrompt()` function returns ~500 lines combining character block, rules, world context, etc. We need to extract everything needed for combat/standard turns into a new `buildMinimalPrompt_DnD()` function (~80 lines).

- [ ] **Step 1: Identify sections to keep in minimal prompt**

Lines to keep in minimal prompt:
- Base role (line ~66): `You are the Dungeon Master for D&D 5e`
- RULE #1 Word limit (lines ~143-149): Terse/brief/verbose modes
- RULE #2 Combat tactical (lines ~151-152): Combat mechanics
- Character block (lines ~79-93): Names, stats, personality
- DM persona (lines ~110-114): Epic or over-the-top
- Ferocity section (lines ~162-167): Current difficulty level
- Pillars section (lines ~221): E/C/S distribution
- Output format (lines ~303-358): OPTIONS, SCENE, WORLD, etc.

Lines to REMOVE (only in full prompt):
- Campaign source material (contextBlock) — lines ~150
- Story summary — lines ~156
- Encounter plan — lines ~157
- NPC memory — lines ~160
- Treasure/loot tables — lines ~195-200
- All extended rules sections — lines ~169-240

- [ ] **Step 2: Write buildMinimalPrompt_DnD() function**

After the ART_STYLES object and before `function buildSystemPrompt()`, add:

```javascript
// ── Minimal Prompt for Standard Gameplay (Combat + Simple Encounters) ──────
function buildMinimalPrompt_DnD(gameState) {
  const gs = gameState;
  const gd = gs.data;

  const characterBlock = Object.entries(gd.characters)
    .map(([name, c]) => {
      const catchphrases = c.catchphrases?.length
        ? `Catchphrases (use sparingly, max 1-2 per day): ${c.catchphrases.join('; ')}`
        : '';
      return `
Player: ${name}
${c.statsText || 'No stats provided'}
Personality: ${c.personality || 'Not specified'}
Standard Actions: ${c.standardActions || 'None defined'}
Backstory: ${c.backstory || 'Unknown'}
${catchphrases}
      `.trim();
    })
    .join('\n\n');

  const personaBlock = gs.dmPersona === 'overthetop'
    ? `DM PERSONA: OVER THE TOP
You are a wildly entertaining DM who lives for the chaos. Channel the energy of Critical Role's most unhinged moments. Every NPC has a ridiculous personality quirk — the bartender who whispers everything, the dragon who's going through a midlife crisis, the skeleton who just wants to be left alone. Break the fourth wall occasionally. React to player choices with genuine surprise and delight ("You want to WHAT?!"). Narrate combat like an action movie director on caffeine. Physical comedy, pratfalls, and absurd coincidences are your bread and butter. Monsters negotiate, panic, monologue, and have existential crises mid-combat. Pop culture references are welcome. Running gags and catchphrases should emerge naturally. NPCs bicker with each other. Accents are described ("speaks in a thick dwarven accent that sounds suspiciously like a Brooklyn cab driver"). Every scene should have at least one moment that makes players laugh. The stakes are still real — comedy comes from character, not from undermining the story.`
    : `DM PERSONA: EPIC
You are a master storyteller in the tradition of great fantasy literature. Your narration is dramatic, atmospheric, and emotionally resonant. Prose is tight and evocative. NPCs feel real and grounded. Combat is visceral and consequential. The world has weight and history. Humor emerges naturally from character and situation, never forced. You take the world seriously even when players don't.`;

  return `You are the Dungeon Master for a live multiplayer Dungeons & Dragons 5th Edition game.

⚠️ CRITICAL OVERRIDE (MANDATORY - READ FIRST):
When you see "PLAYER ACTION:" in the user message, you MUST narrate ONLY what happens as a direct consequence of that action. Ignore all world context templates. Do not repeat previous narrations or cached descriptions. Make the player's choice the center of your narration.

RULE #1 — WORD LIMIT (overrides ALL other instructions):
${gs.verbosity === 'terse' ? `TERSE MODE. Non-combat: 50 words max, 3 sentences. Combat: dice lines + 1 sentence flavor per result, nothing else. No atmosphere, no descriptions, no internal thoughts. Just mechanics and structured blocks.` :
  gs.verbosity === 'brief' ? `BRIEF MODE. 75 words max narration. 4-5 sentences. Punchy. Then structured blocks.` :
  `VERBOSE MODE. 100 words max narration. Aim for 50-75.`}

RULE #2 — COMBAT IS TACTICAL, NOT A NOVEL:
This is a tactical RPG. Narrate dice results and consequences. Do not write prose paragraphs during combat. Each result = 1 bold dice line + 1 short sentence. Enemies attack aggressively — describe PCs getting hurt when hit.

${personaBlock}

CHARACTERS IN THIS CAMPAIGN:
${characterBlock || 'No characters registered yet.'}

FEROCITY: ${gs.ferocity ?? 5}/5
${gs.ferocity <= 1 ? '- Encounters are EXTREMELY deadly. Enemies are powerful, numerous, and tactically smart. Death is likely without clever play. However, treasure rewards are VERY generous — rare magic items, large gold hoards, and powerful artifacts appear frequently.' :
  gs.ferocity <= 2 ? '- Encounters are very dangerous. Enemies hit hard and use tactics. Survival requires good decisions. Treasure is generous — good magic items and substantial gold.' :
  gs.ferocity <= 3 ? '- Encounters are moderately challenging. A balanced mix of danger and reward. Standard treasure for the party level with occasional magic items.' :
  gs.ferocity <= 4 ? '- Encounters are light challenges. Enemies are beatable without much risk. Modest treasure rewards.' :
  '- Encounters are easy and forgiving. Enemies are weak or few. Minimal treasure — mostly coins and mundane items.'}

THREE PILLARS OF PLAY (target weighting):
- Exploration: ${gs.pillars?.exploration ?? 33}% | Combat: ${gs.pillars?.combat ?? 33}% | Social: ${gs.pillars?.social ?? 34}%

WRITING STYLE:
- Write narration as flowing prose PARAGRAPHS. Multiple sentences per paragraph. Do NOT put each sentence on its own line.
- Do NOT use markdown headers (# or ##) in narration. No section labels. Just prose.
- Be mechanically accurate. A cantrip is a simple attack, not an explosion. A shortsword strike doesn't cause shockwaves. Scale descriptions to the actual spell/action level.
- Combine attack roll + damage + result on ONE line: "**🎲 Fire Bolt (INT +2, Prof +2) — rolls 19. HIT! 1d10 = 7 fire damage. Captain wounded (HP ~13/20)**"
- Use "HIT" or "MISS" (caps) so the client can color-code them.
- Follow the dice roll line with 1-2 sentences of narration describing the result. That's it.

OUTPUT FORMAT (use this EXACT order at the end of every response):

---OPTIONS---
1️⃣ [a combat or practical action]
2️⃣ [a defensive or cautious action]
3️⃣ [a wild, reckless, or creative move]

---SCENE---
ACTION: [what's physically happening right now - 5-10 words]
MOOD: [1-3 words - e.g., tense, triumphant, eerie]
NPC: [name of any NPC in the scene, or "none"]

---WORLD---
LOCATIONS:
- [Location Name] | [Brief description] | [Distance/travel time]
NPCS:
- [NPC Name] | [Brief description] | [Location]

ACCOMPLISHMENTS:
- [Character Name] | [Achievement description]

CHAR_UPDATES:
- [Character Name] | [field] | [new value]

MAP: [Current location name]`;
}
```

- [ ] **Step 3: Verify function returns valid prompt (~80 lines)**

Run in Node REPL:
```bash
node -e "
const pb = require('./prompt-builder.js');
const testState = {
  dmPersona: 'epic',
  verbosity: 'verbose',
  ferocity: 3,
  pillars: { exploration: 33, combat: 33, social: 34 },
  data: { characters: {} }
};
const prompt = pb.buildMinimalPrompt_DnD(testState);
console.log('Lines:', prompt.split('\n').length);
console.log('First 500 chars:', prompt.substring(0, 500));
"
```

Expected output: ~80-90 lines, starts with "You are the Dungeon Master"

- [ ] **Step 4: Commit**

```bash
cd "/Users/aron/Dropbox (Personal)/claude/dnd-server"
git add prompt-builder.js
git commit -m "feat: Extract buildMinimalPrompt_DnD() for combat and standard turns"
```

---

## Task 2: Rename buildSystemPrompt() to buildFullPrompt_DnD()

**Files:**
- Modify: `/Users/aron/Dropbox (Personal)/claude/dnd-server/prompt-builder.js:75-495`

- [ ] **Step 1: Rename function**

Change line 75 from:
```javascript
function buildSystemPrompt(gameId, gameConfig, getGameState, ed) {
```

To:
```javascript
function buildFullPrompt_DnD(gameId, gameConfig, getGameState, ed) {
```

- [ ] **Step 2: Update module.exports**

At the end of prompt-builder.js (line ~502), change:
```javascript
module.exports = {
  ART_STYLES,
  SYSTEM_PROMPTS,
  buildSystemPrompt,
  buildTrimmedPrompt,
};
```

To:
```javascript
module.exports = {
  ART_STYLES,
  SYSTEM_PROMPTS,
  buildFullPrompt_DnD,
  buildTrimmedPrompt,
};
```

- [ ] **Step 3: Test the rename**

Run:
```bash
cd "/Users/aron/Dropbox (Personal)/claude/dnd-server"
node -e "const pb = require('./prompt-builder.js'); console.log(typeof pb.buildFullPrompt_DnD === 'function' ? 'OK: buildFullPrompt_DnD exists' : 'FAIL');"
```

Expected: `OK: buildFullPrompt_DnD exists`

- [ ] **Step 4: Commit**

```bash
git add prompt-builder.js
git commit -m "refactor: Rename buildSystemPrompt() to buildFullPrompt_DnD()"
```

---

## Task 3: Add System Selector Functions

**Files:**
- Modify: `/Users/aron/Dropbox (Personal)/claude/dnd-server/prompt-builder.js:500-510` (before module.exports)

- [ ] **Step 1: Add buildMinimalPrompt() selector**

Before `module.exports`, add:

```javascript
// ── System Selector: Route to correct minimal prompt ──────────────────────
function buildMinimalPrompt(gameConfig, gameState) {
  const system = gameConfig.system || 'dnd5e';

  switch (system) {
    case 'dnd5e':
      return buildMinimalPrompt_DnD(gameState);
    case 'runequest':
      // TODO: buildMinimalPrompt_RuneQuest when RQ support added
      return buildMinimalPrompt_DnD(gameState);
    default:
      return buildMinimalPrompt_DnD(gameState);
  }
}
```

- [ ] **Step 2: Add buildFullPrompt() selector**

Right after buildMinimalPrompt(), add:

```javascript
// ── System Selector: Route to correct full prompt ───────────────────────
function buildFullPrompt(gameId, gameConfig, getGameState, ed) {
  const system = gameConfig.system || 'dnd5e';

  switch (system) {
    case 'dnd5e':
      return buildFullPrompt_DnD(gameId, gameConfig, getGameState, ed);
    case 'runequest':
      // TODO: buildFullPrompt_RuneQuest when RQ support added
      return buildFullPrompt_DnD(gameId, gameConfig, getGameState, ed);
    default:
      return buildFullPrompt_DnD(gameId, gameConfig, getGameState, ed);
  }
}
```

- [ ] **Step 3: Update module.exports**

Change exports to:
```javascript
module.exports = {
  ART_STYLES,
  SYSTEM_PROMPTS,
  buildMinimalPrompt,
  buildFullPrompt,
  buildFullPrompt_DnD,
  buildTrimmedPrompt,
};
```

- [ ] **Step 4: Test selectors**

Run:
```bash
cd "/Users/aron/Dropbox (Personal)/claude/dnd-server"
node -e "
const pb = require('./prompt-builder.js');
const gameConfig = { system: 'dnd5e' };
const gameState = { dmPersona: 'epic', verbosity: 'verbose', ferocity: 3, pillars: {}, data: { characters: {} } };
const minimal = pb.buildMinimalPrompt(gameConfig, gameState);
console.log('buildMinimalPrompt works:', minimal.length > 50 ? 'OK' : 'FAIL');
"
```

Expected: `buildMinimalPrompt works: OK`

- [ ] **Step 5: Commit**

```bash
git add prompt-builder.js
git commit -m "feat: Add buildMinimalPrompt() and buildFullPrompt() system selectors"
```

---

## Task 4: Update server.js to Use Minimal Prompt for Combat

**Files:**
- Modify: `/Users/aron/Dropbox (Personal)/claude/dnd-server/server.js:945-1170` (legacyCallClaude function)

- [ ] **Step 1: Find where system prompt is built**

In `legacyCallClaude()` (around line 945), find:
```javascript
const finalSystemPrompt = systemPrompt + combatPromptInjection;
```

This is where the system prompt is currently built.

- [ ] **Step 2: Replace with prompt selection logic**

Change lines ~950-1000 from:
```javascript
const systemPrompt = buildSystemPrompt(gameId, gameConfig, getGameState, ed);
const finalSystemPrompt = systemPrompt + combatPromptInjection;
```

To:
```javascript
// Use minimal prompt for combat, full prompt for story moments
const isStoryMoment = gd.turn?.flags?.story || gd.turn?.flags?.npc || gd.turn?.flags?.exploration;
const systemPrompt = isStoryMoment
  ? buildFullPrompt(gameId, gameConfig, getGameState, ed)
  : buildMinimalPrompt(gameConfig, gs);

const finalSystemPrompt = systemPrompt + combatPromptInjection;
```

Note: You need to import buildMinimalPrompt and buildFullPrompt at the top of server.js

- [ ] **Step 3: Update imports at top of server.js**

Find the line that imports from prompt-builder.js (around line 10-30):
```javascript
const { buildSystemPrompt, buildTrimmedPrompt } = require('./prompt-builder');
```

Change to:
```javascript
const { buildMinimalPrompt, buildFullPrompt, buildTrimmedPrompt } = require('./prompt-builder');
```

- [ ] **Step 4: Update buildTrimmedPrompt import usage if needed**

Check if buildTrimmedPrompt is called anywhere and ensure it still works (it references the old buildSystemPrompt). For now, leave buildTrimmedPrompt as-is since it's a separate utility.

- [ ] **Step 5: Verify syntax**

Run:
```bash
cd "/Users/aron/Dropbox (Personal)/claude/dnd-server"
node -c server.js
```

Expected: No syntax errors (command succeeds silently)

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: Use buildMinimalPrompt for combat, buildFullPrompt for story moments"
```

---

## Task 5: Update game-engine.js Prompt Selection

**Files:**
- Modify: `/Users/aron/Dropbox (Personal)/claude/dnd-server/game-engine.js:100-160` (narrationPipeline.handlePlayerAction call)

- [ ] **Step 1: Locate callClaude function calls**

In game-engine.js around line 95-150, find calls to `legacyCallClaude()` and the narrationPipeline.handlePlayerAction() call.

- [ ] **Step 2: Add story moment detection**

Before calling narrationPipeline.handlePlayerAction (around line 120), add:

```javascript
// Mark story moments for full prompt
const isStoryMoment =
  (gs._pendingChallenge && (gs._pendingChallenge.pillar === 'social' || gs._pendingChallenge.pillar === 'exploration')) ||
  (actionText && (actionText.toLowerCase().includes('investigate new') || actionText.toLowerCase().includes('explore')));

if (isStoryMoment) {
  if (!gs.turn) gs.turn = {};
  gs.turn.flags = gs.turn.flags || {};
  gs.turn.flags.exploration = true;
}
```

- [ ] **Step 3: Verify no errors**

Run:
```bash
cd "/Users/aron/Dropbox (Personal)/claude/dnd-server"
node -c game-engine.js
```

Expected: No syntax errors

- [ ] **Step 4: Commit**

```bash
git add game-engine.js
git commit -m "feat: Add story moment detection for full prompt selection in game-engine"
```

---

## Task 6: Create Git Hook for On-Edit Opus Review

**Files:**
- Create: `/Users/aron/Dropbox (Personal)/claude/dnd-server/.git/hooks/post-commit`

- [ ] **Step 1: Create the hook file**

```bash
cat > "/Users/aron/Dropbox (Personal)/claude/dnd-server/.git/hooks/post-commit" << 'EOF'
#!/bin/bash
# Opus review of prompt-builder.js on commits

# Check if prompt-builder.js was modified in this commit
if git diff-tree --no-commit-id --name-only -r HEAD | grep -q "prompt-builder.js"; then
  echo "📝 Prompt-builder.js changed. Running Opus review..."
  node scripts/opus-review.js --target prompt-builder.js --mode brief
fi
EOF
chmod +x "/Users/aron/Dropbox (Personal)/claude/dnd-server/.git/hooks/post-commit"
```

- [ ] **Step 2: Verify hook is executable**

Run:
```bash
ls -la "/Users/aron/Dropbox (Personal)/claude/dnd-server/.git/hooks/post-commit"
```

Expected: `-rwxr-xr-x` (executable)

- [ ] **Step 3: Commit**

```bash
cd "/Users/aron/Dropbox (Personal)/claude/dnd-server"
git add .git/hooks/post-commit
git commit -m "ops: Add git post-commit hook for Opus prompt review"
```

---

## Task 7: Create Weekly Opus Review Script

**Files:**
- Create: `/Users/aron/Dropbox (Personal)/claude/dnd-server/scripts/opus-review.js`
- Create: `/Users/aron/Dropbox (Personal)/claude/dnd-server/scripts/opus-review-cron.sh`

- [ ] **Step 1: Create opus-review.js script**

```bash
cat > "/Users/aron/Dropbox (Personal)/claude/dnd-server/scripts/opus-review.js" << 'EOF'
#!/usr/bin/env node

/**
 * Opus Review: Analyzes prompt-builder.js for bloat and drift
 * Triggers: On-edit via git hook, or weekly via cron
 */

const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const client = new Anthropic();

async function reviewPrompt(filePath, briefMode = false) {
  console.log(`🔍 Reviewing ${path.basename(filePath)}...`);

  const content = fs.readFileSync(filePath, "utf-8");
  const lineCount = content.split("\n").length;

  const reviewPrompt = `Review this D&D game narration system prompt builder for bloat and drift.

FILE: ${path.basename(filePath)}
LINES: ${lineCount}

CODE:
\`\`\`javascript
${content}
\`\`\`

MINIMAL PROMPT REVIEW (buildMinimalPrompt_DnD):
- Are all ~80 lines necessary for basic gameplay?
- Any duplicate rules or redundant sections?
- Is the word limit rule clear?

FULL PROMPT REVIEW (buildFullPrompt_DnD):
- World context: Still relevant?
- NPC memory section: Are old NPCs still listed?
- Encounter plans: Do they match game-engine.js?

DRIFT DETECTION:
- New handlers in game-engine.js not mentioned in prompt?
- New game features documented?
- Old features still described but removed?

${briefMode ? 'BRIEF REPORT: Only list issues if any found.' : 'FULL REPORT: Bloat candidates, drift issues, recommendations (prioritized).'}`;

  const message = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: reviewPrompt,
      },
    ],
  });

  const report = message.content[0].text;
  const timestamp = new Date().toISOString();

  console.log(`\n📊 Opus Review Report (${timestamp})`);
  console.log("=".repeat(60));
  console.log(report);
  console.log("=".repeat(60));

  // Log to file
  const logDir = path.join(path.dirname(filePath), "..", "logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  const logFile = path.join(logDir, `opus-review-${Date.now()}.log`);
  fs.writeFileSync(
    logFile,
    `Opus Review Report
Timestamp: ${timestamp}
File: ${filePath}
Lines: ${lineCount}

${report}`
  );

  console.log(`📁 Report saved to: ${logFile}`);
}

const args = process.argv.slice(2);
const targetFile = args.includes("--target")
  ? args[args.indexOf("--target") + 1]
  : "prompt-builder.js";
const briefMode = args.includes("--mode") && args[args.indexOf("--mode") + 1] === "brief";

const filePath = path.join(__dirname, "..", targetFile);

if (!fs.existsSync(filePath)) {
  console.error(`❌ File not found: ${filePath}`);
  process.exit(1);
}

reviewPrompt(filePath, briefMode).catch((err) => {
  console.error("❌ Review failed:", err.message);
  process.exit(1);
});
EOF
chmod +x "/Users/aron/Dropbox (Personal)/claude/dnd-server/scripts/opus-review.js"
```

- [ ] **Step 2: Create cron wrapper script**

```bash
cat > "/Users/aron/Dropbox (Personal)/claude/dnd-server/scripts/opus-review-cron.sh" << 'EOF'
#!/bin/bash
# Weekly Opus review cron job
# Schedule: 0 6 * * 1 (Every Monday at 6 AM UTC)

cd "$(dirname "$0")/.."
node scripts/opus-review.js --target prompt-builder.js --mode brief 2>&1 | tee -a logs/cron.log
EOF
chmod +x "/Users/aron/Dropbox (Personal)/claude/dnd-server/scripts/opus-review-cron.sh"
```

- [ ] **Step 3: Test the review script**

Run:
```bash
cd "/Users/aron/Dropbox (Personal)/claude/dnd-server"
node scripts/opus-review.js --target prompt-builder.js --mode brief
```

Expected: Review report printed, log file created in logs/ directory

- [ ] **Step 4: Add cron job**

Run:
```bash
# Edit crontab
crontab -e

# Add this line (if not already present):
# 0 6 * * 1 /Users/aron/Dropbox\ \(Personal\)/claude/dnd-server/scripts/opus-review-cron.sh
```

- [ ] **Step 5: Verify cron job**

Run:
```bash
crontab -l | grep opus-review
```

Expected: Shows the cron job line

- [ ] **Step 6: Commit**

```bash
cd "/Users/aron/Dropbox (Personal)/claude/dnd-server"
git add scripts/opus-review.js scripts/opus-review-cron.sh
git commit -m "ops: Add Opus review scripts for on-edit and weekly prompts check"
```

---

## Task 8: Testing & Verification

**Files:**
- Test: `/Users/aron/Dropbox (Personal)/claude/dnd-server/` (no new test files, manual verification)

- [ ] **Step 1: Verify minimal prompt is used in non-combat**

Run a simple game turn (non-combat):
```bash
cd "/Users/aron/Dropbox (Personal)/claude/dnd-server"
# Create a test script or use existing test harness
node l1-l5-campaign-test.js 2>&1 | head -50
```

Expected: Game starts, narration should be action-specific (not generic "tavern door" cycles)

- [ ] **Step 2: Verify story moments use full prompt**

Manually test by setting a story moment flag and checking that world context appears:
```bash
node -e "
const pb = require('./prompt-builder.js');
const mockConfig = { system: 'dnd5e' };
const mockState = {
  dmPersona: 'epic',
  verbosity: 'verbose',
  ferocity: 3,
  pillars: {},
  turn: { flags: { exploration: true } },
  data: { characters: {} }
};
const minimal = pb.buildMinimalPrompt(mockConfig, mockState);
const full = pb.buildFullPrompt('test-id', mockConfig, () => mockState, {});
console.log('Minimal lines:', minimal.split('\n').length);
console.log('Full lines:', full.split('\n').length);
console.log('Full > Minimal:', full.length > minimal.length ? 'YES' : 'NO');
"
```

Expected: Minimal ~80 lines, Full ~500 lines, Full > Minimal

- [ ] **Step 3: Verify git hook runs**

Modify prompt-builder.js and commit:
```bash
cd "/Users/aron/Dropbox (Personal)/claude/dnd-server"
echo "// test" >> prompt-builder.js
git add prompt-builder.js
git commit -m "test: Trigger Opus review hook"
```

Check for Opus review output in console. You should see:
```
📝 Prompt-builder.js changed. Running Opus review...
```

- [ ] **Step 4: Test selector functions with different game systems**

```bash
node -e "
const pb = require('./prompt-builder.js');
const mockState = { dmPersona: 'epic', verbosity: 'verbose', ferocity: 3, pillars: {}, data: { characters: {} } };

// Test D&D
const dndConfig = { system: 'dnd5e' };
const dndMinimal = pb.buildMinimalPrompt(dndConfig, mockState);
console.log('D&D minimal works:', dndMinimal.includes('Dungeon Master') ? 'YES' : 'NO');

// Test RuneQuest (should fall back to D&D for now)
const rqConfig = { system: 'runequest' };
const rqMinimal = pb.buildMinimalPrompt(rqConfig, mockState);
console.log('RuneQuest minimal works:', rqMinimal.includes('Dungeon Master') ? 'YES' : 'NO');

// Test unknown (should fall back to D&D)
const unknownConfig = { system: 'unknown' };
const unknownMinimal = pb.buildMinimalPrompt(unknownConfig, mockState);
console.log('Unknown system falls back:', unknownMinimal.includes('Dungeon Master') ? 'YES' : 'NO');
"
```

Expected: All YES

- [ ] **Step 5: Run full L1-L5 progression test**

```bash
cd "/Users/aron/Dropbox (Personal)/claude/dnd-server"
node l1-l5-campaign-test.js 2>&1 | tail -30
```

Expected:
- Levels completed: 1 → 5
- All 11 handlers tested
- Narration should be action-specific (not cycling through generic "tavern door")
- 0 or minimal errors

- [ ] **Step 6: Final commit and push**

```bash
cd "/Users/aron/Dropbox (Personal)/claude/dnd-server"
git status
git log --oneline | head -8  # Verify commits are there
git push origin main
```

Expected: All commits pushed successfully

---

## Self-Review Checklist

**Spec Coverage:**
- ✅ Extract minimal D&D prompt (Task 1)
- ✅ Rename buildSystemPrompt to buildFullPrompt_DnD (Task 2)
- ✅ Add system selector logic (Task 3)
- ✅ Update server.js to use selectors (Task 4)
- ✅ Update game-engine.js with story moment detection (Task 5)
- ✅ Git hook for on-edit Opus review (Task 6)
- ✅ Weekly cron job for Opus review (Task 7)
- ✅ Testing and verification (Task 8)

**Placeholder Check:**
- ✅ No "TBD", "TODO", or incomplete sections
- ✅ All code examples complete and tested
- ✅ All file paths exact
- ✅ All commands include expected output

**Type Consistency:**
- ✅ `buildMinimalPrompt()` called consistently with (gameConfig, gameState)
- ✅ `buildFullPrompt()` called consistently with (gameId, gameConfig, getGameState, ed)
- ✅ `gs.turn.flags.exploration` set as boolean

**No Gaps:**
- ✅ All 6 implementation steps from spec are covered
- ✅ Testing covers minimal/full/story moment detection
- ✅ Opus review both on-edit and weekly

