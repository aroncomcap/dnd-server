# Split Pipeline DM Architecture

**Date:** 2026-04-18
**Problem:** Claude Haiku as sole DM model fails at format compliance, rules following, and verbosity limits from turn 1 — not a context decay issue but a fundamental constraint overload.
**Solution:** Split each turn into specialized calls that match model strengths. Server-side combat narration via templates. Sonnet for creative narration. Haiku for structured extraction and validation.

---

## 1. Turn Routing

Every player action hits a router that determines the path:

```
Player Action
    │
    ▼
┌──────────────┐
│ Combat active?│
└──┬───────┬───┘
  YES      NO
   │        │
   ▼        ▼
FAST PATH  FULL PATH
```

### 1.1 Fast Path (Combat Turns)

Zero API calls for standard combat. Server assembles narration from cached templates.

```
Player Action
    │
    ▼
Combat Engine resolves (existing system, unchanged)
    │
    ▼
For each resolved result:
    ├─ Look up monster template (slug + event_type + persona)
    ├─ If cached → pick random template, substitute variables
    └─ If missing → generate batch via Haiku (background), use generic fallback now
    │
    ▼
Assemble full turn narration:
    [template line per result]
    [tactical options from character abilities]
    │
    ▼
Emit to client. Cost: $0.00
```

**Sonnet combat calls (special moments only):**
- Combat start scene (setting the stage)
- Killshot narration (already event-driven)
- Combat end aftermath
- Every ~3rd round for a "color" paragraph to break template monotony

When Sonnet is called for combat color, it receives the resolved results as context and narrates around them — same as current combat prompt injection, but only for flavor rounds.

### 1.2 Full Path (Non-Combat Turns)

Three calls — one streamed, two background:

```
Player Action
    │
    ▼
Call 1: Sonnet narration (streamed to player)
    │
    ├──────────────────┐
    ▼                  ▼
Call 2: Haiku       Call 3: Haiku
extraction          validation
(background)        (background)
    │                  │
    ▼                  ▼
Update world       Queue corrections
state + UI         for next turn
```

---

## 2. Call 1: Sonnet Narration

**Model:** claude-sonnet-4-6 (or latest Sonnet)
**Streamed:** Yes
**Token budget:** terse=400, brief=600, verbose=1500
**Temperature:** terse=0.4, brief=0.6, verbose=0.8

### 2.1 System Prompt (~800 tokens)

```
You are {persona_name}, the Game Master.

{persona_description — full block for epic or over_the_top}

PARTY:
{For each character:}
- {name} ({class}, level {N}): {personality}. {backstory — 1 sentence}.
  {catchphrases if any: "use sparingly"}
  Standard Actions: {standardActions}

STORY SO FAR:
{rolling summary from DB}

{CAMPAIGN SOURCE MATERIAL: if present, capped at MAX_CONTEXT_CHARS}

{HOUSE RULES & CORRECTIONS: if any}

{RECURRING NPCs: name (status, met Nx) — up to 5}

ENCOUNTER GUIDANCE: {encounter plan line — "Next: SOCIAL encounter" etc.}
Ferocity: {N}/5 — {1-line tone description}
Pillars: E{N}/C{N}/S{N}. Include a skill check or ability roll every 1-2 actions.

RULES:
- {verbosity}: {word limit} words max for narration
- Give exactly 3 options after narration:
  1️⃣ [practical/combat action]
  2️⃣ [cautious/defensive action]
  3️⃣ [wild/creative/reckless action]
- Use emoji prefixes as appropriate: 🗡️ ⚔️ 🛡️ 🔥 💀 🗣️ 🔍
- Write prose paragraphs. No markdown headers.
- Never roll dice or resolve combat mechanics yourself.
- When hostiles appear, describe the threat — combat engine handles the rest.
- Be mechanically accurate — scale descriptions to actual spell/ability power level.
{system_adaptation — 1-2 lines for D&D 5e / RuneQuest / Custom}
```

### 2.2 User Message

```
{chat history — last 10 messages, narration + player actions only}

{If pendingCorrections:}
[CORRECTION: {description}. {what should be true instead}.]

Player ({character_name}): {action text}
```

### 2.3 Expected Output

Narration paragraph(s) followed by 3 numbered options. Nothing else.

```
The merchant's eyes narrow as you slide the counterfeit coin across
the counter. "Interesting currency," she says, turning it in the
lamplight. Her other hand drifts below the counter. Two guards by
the door shift their weight.

1️⃣ 🗣️ Bluff — "Apologies, must have grabbed the wrong purse"
2️⃣ 🛡️ Back toward the door slowly, hand on weapon
3️⃣ 🔥 Snatch the coin back and bolt for the window
```

### 2.4 Parsing

Simple extraction:
1. Everything before the first option line = narration
2. Lines matching `^[1-3]️⃣` or `^[1-3][.)]` = options
3. If options missing (unlikely with Sonnet's simpler task) → one Haiku fallback call (existing pattern)

---

## 3. Call 2: Haiku World State Extraction

**Model:** claude-haiku-4-5-20251001
**Streamed:** No
**Background:** Yes (parallel with Call 3)
**Token budget:** max_tokens 500
**Temperature:** 0.0

### 3.1 Prompt

```
Extract world state changes from this narration. Return ONLY valid JSON.

CURRENT WORLD STATE:
{
  "locations": [{"name": "Tavern of the Broken Spoke", "description": "..."}],
  "npcs": [{"name": "Gretta the Barkeep", "description": "..."}],
  "map": "Tavern of the Broken Spoke"
}

NARRATION:
"{Sonnet's complete narration text}"

PLAYER ACTION:
"{what the player did}"

Return JSON:
{
  "scene": {
    "action": "5-10 word summary",
    "mood": "1-3 words",
    "npc": "name or null"
  },
  "locations": [
    {"name": "...", "description": "...", "distance": "...",
     "isNew": true, "img": "one sentence visual or null"}
  ],
  "npcs": [
    {"name": "...", "description": "...", "location": "...",
     "isNew": true, "img": "one sentence visual or null"}
  ],
  "enemies": [
    {"displayName": "...", "count": 1, "slug": "monster-db-slug"}
  ],
  "map": "current location name",
  "accomplishments": [
    {"character": "...", "achievement": "..."}
  ],
  "charUpdates": [
    {"character": "...", "field": "statsText|personality|backstory|standardActions", "value": "..."}
  ]
}

Rules:
- "isNew" = true ONLY if entity does NOT appear in CURRENT WORLD STATE
- "img" ONLY for isNew entities (or significantly transformed existing ones)
- "enemies" ONLY if hostile creatures are actively threatening the party
- "slug" must be a plausible monster database key (lowercase, hyphenated). Use "custom" with displayName as hint if unsure.
- Omit empty arrays entirely
- Return ONLY the JSON object, no explanation
```

### 3.2 Processing

1. Parse JSON response
2. If malformed → one retry: "Fix this JSON: {raw output}"
3. If retry fails → skip world update this turn (narration already delivered)
4. If `enemies` present → trigger `initiateCombat()` via existing flow
5. If `isNew` locations/NPCs with `img` → trigger Together AI image generation (existing flow)
6. Update world state in DB via existing persistence functions
7. Emit socket events: `map_update`, `world_update`, `combat_started` as needed

---

## 4. Call 3: Haiku Narration Validator

**Model:** claude-haiku-4-5-20251001
**Streamed:** No
**Background:** Yes (parallel with Call 2)
**Token budget:** max_tokens 300
**Temperature:** 0.0

### 4.1 Prompt

```
Check this narration against the current game state.
Return ONLY valid JSON.

GAME STATE:
- System: {D&D 5e / RuneQuest / Custom}
- Characters:
  {For each character:}
  - {name} (Level {N} {class}): HP {current}/{max},
    Spell slots: {remaining by level}, Features: {list},
    Conditions: {list or "none"}, Key items: {list}
- Story context: {last 3 turns summary}
- House rules: {list or "none"}
- Current location: {name} — {established details}
- Active conditions: {environmental hazards, time of day, weather}

NARRATION:
"{Sonnet's narration}"

OPTIONS:
"{the 3 options}"

Flag ONLY if the narration contradicts the game state above.
Examples of violations:
- Using a resource the character doesn't have (spell slot, item, ability)
- Referencing an ability the character doesn't possess
- Contradicting established facts from recent turns
- Violating a house rule
- A character acting impossibly for their condition (unconscious character speaks, restrained character moves freely)

Do NOT flag:
- Creative liberties with NPC behavior
- Dramatic embellishment
- Minor flavor inconsistencies
- Mechanical rule details (how spells work, action economy) — combat engine handles those

Return JSON:
{
  "violations": [
    {
      "type": "resource|continuity|house_rule|condition",
      "severity": "critical|minor",
      "description": "what went wrong",
      "correction": "what should be true instead"
    }
  ],
  "wordCount": 73,
  "passed": true
}

If no violations: {"violations": [], "wordCount": N, "passed": true}
```

### 4.2 Processing

1. Parse JSON response
2. If malformed → skip validation this turn (non-critical)
3. Severity routing:
   - **Critical** (resource errors, impossible actions, condition violations) → store in `gs.pendingCorrections[]`, inject next turn
   - **Minor** (house rule drift, verbosity overage) → increment counter. Only inject correction if same type flagged 3+ consecutive turns
   - **Info** (word count) → log for analytics dashboard, no action
4. Corrections format for next turn injection:
   ```
   [CORRECTION: {description}. {correction text}.]
   ```

---

## 5. Monster Narrative Templates

### 5.1 Data Model

New DB table `monster_templates`:

```sql
CREATE TABLE IF NOT EXISTS monster_templates (
  id SERIAL PRIMARY KEY,
  monster_slug TEXT NOT NULL,
  event_type TEXT NOT NULL,
  persona TEXT NOT NULL DEFAULT 'epic',
  templates JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(monster_slug, event_type, persona)
);
```

### 5.2 Event Types

| Event Type | When | Variables Available |
|------------|------|-------------------|
| `attack_hit` | Monster hits a PC | `{target}`, `{damage}`, `{weapon}`, `{hp}`, `{maxHp}` |
| `attack_miss` | Monster misses a PC | `{target}`, `{weapon}` |
| `attack_crit` | Monster crits a PC | `{target}`, `{damage}`, `{weapon}`, `{hp}`, `{maxHp}` |
| `takes_damage` | Monster is hit | `{attacker}`, `{damage}`, `{weapon}`, `{hp}`, `{maxHp}` |
| `takes_crit` | Monster is crit | `{attacker}`, `{damage}`, `{weapon}` |
| `death` | Monster reaches 0 HP | `{attacker}`, `{weapon}` |
| `taunt` | Flavor between rounds | `{target}` |
| `spell_hit` | Monster's spell hits | `{target}`, `{spell}`, `{damage}`, `{hp}`, `{maxHp}` |
| `spell_miss` | Monster's spell misses | `{target}`, `{spell}` |
| `pc_attack_hit` | PC hits monster (PC perspective) | `{attacker}`, `{weapon}`, `{damage}`, `{hp}`, `{maxHp}` |
| `pc_attack_miss` | PC misses monster | `{attacker}`, `{weapon}` |
| `pc_spell_hit` | PC spell hits monster | `{attacker}`, `{spell}`, `{damage}`, `{hp}`, `{maxHp}` |

### 5.3 Lazy Generation Flow

```
needTemplate(monsterSlug, eventType, persona)
    │
    ▼
Check in-memory cache (Map)
    │
   HIT → return random template from pool
    │
   MISS → Check DB
           │
          HIT → load into memory cache, return random
           │
          MISS → Use generic fallback NOW
                 │
                 ▼
                 Background: generate via Haiku
                 │
                 ▼
                 Save to DB + memory cache
```

### 5.4 Haiku Generation Prompt

```
Generate 6 short combat narration lines for a {monster_name}
({monster_description}) when it {event_description}.

Persona: {epic — dramatic and atmospheric / over_the_top — comedic and chaotic}

Use these variables (include literally with braces):
{variable list for this event type}

Rules:
- Each line: 1 sentence, max 20 words
- Match the monster's personality and fighting style
- Vary intensity and word choice across the 6 lines
- No dice notation or numbers — just narration flavor

Return a JSON array of 6 strings.
```

**Cost:** ~$0.0005 per batch. One-time per monster × event_type × persona.

### 5.5 Generic Fallback Templates

Hardcoded pools by creature type (humanoid, beast, undead, fiend, dragon, construct, aberration, elemental). ~10-15 templates per event type per creature type. These ship with the codebase and require no generation.

Example (humanoid, attack_hit, epic):
```json
[
  "The blade finds its mark, biting into {target}.",
  "{target} staggers as the blow connects.",
  "Steel meets flesh — {target} takes {damage} damage.",
  "A vicious strike catches {target} off-guard.",
  "{target} grunts as the weapon tears through armor."
]
```

### 5.6 Template Assembly

For a complete combat round, the server builds narration by concatenating one template per resolved result, with the mechanical dice line preceding each:

```
**🎲 Goblin Archer attacks Kael — rolls 17. HIT! 6 piercing damage. Kael (29/35 HP)**
A crude arrow whistles through the air and bites into Kael.

**🎲 Kael swings greatsword at Goblin Archer — rolls 22. HIT! 14 slashing damage. Goblin Archer (1/15 HP)**
The goblin shrieks as Kael's blade tears through its leather armor.
```

The dice line is deterministic (from combat engine). The flavor line is the template. Together they replace the current full Claude narration call.

### 5.7 Options Generation (Combat)

Server generates tactical options from character state:

```
1️⃣ 🗡️ Attack {nearest enemy} with {equipped weapon}
2️⃣ 🛡️ Dodge
3️⃣ 🔥 {context-specific: Cast {highest available spell} / Use {special ability} / Improvise with environment}
```

Option 3 logic:
1. If character has unused spell slots → suggest a relevant spell
2. Else if character has special abilities (Action Surge, Sneak Attack positioning, Wild Shape) → suggest that
3. Else → environmental improvise ("kick the brazier at the goblin", "swing from the chandelier")

Environmental options: if the current location has a description in world state, scan for interactable nouns (brazier, chandelier, table, cliff edge, etc.) via a simple keyword list. If no match, use generic options ("shove an enemy", "throw something", "attempt something reckless").

---

## 6. Narration Pipeline Orchestrator

New module: `narration-pipeline.js`

### 6.1 Interface

```javascript
async function handlePlayerAction(gameId, characterName, actionText) → {
  narration: string,       // streamed to client during execution
  options: string[],       // 3 options
  worldUpdates: object,    // from Call 2
  violations: object[],    // from Call 3
}
```

### 6.2 Combat Path

```javascript
if (gs.combatEngine?.isActive()) {
  // Resolve action via existing combat engine
  const results = await resolveCombatAction(gameId, characterName, actionText);

  // Assemble narration from templates
  const narration = await assembleTemplateNarration(gameId, results, gs.dmPersona);

  // Generate tactical options from character state
  const options = generateCombatOptions(gameId, characterName);

  // Flavor round: every 3rd combat round (gs.combatEngine.state.round % 3 === 0)
  // Also triggers on: round 1 (combat start), final round (combat end)
  if (shouldCallSonnetForFlavor(gs)) {
    // Background Sonnet call for a color paragraph — non-blocking
    queueFlavorCall(gameId, results, gs.dmPersona);
  }

  return { narration, options, worldUpdates: null, violations: [] };
}
```

### 6.3 Non-Combat Path

```javascript
// Call 1: Sonnet narration (streamed)
const { narration, options } = await callSonnetNarration(gameId, characterName, actionText);

// Calls 2 & 3: parallel background
const [worldUpdates, validation] = await Promise.all([
  callHaikuExtraction(gameId, narration, actionText),
  callHaikuValidation(gameId, narration, options),
]);

// Process results
if (worldUpdates?.enemies?.length) {
  await initiateCombat(gameId, worldUpdates.enemies);
}
applyWorldUpdates(gameId, worldUpdates);
queueCorrections(gameId, validation.violations);

return { narration, options, worldUpdates, violations: validation.violations };
```

---

## 7. Correction Injection System

### 7.1 Storage

```javascript
// In game state
gs.pendingCorrections = [];  // Array of {type, description, correction}
gs.minorViolationCounts = {};  // { "verbosity": 2, "house_rule_X": 1 }
```

### 7.2 Injection Logic

Before building the user message for Call 1 (Sonnet):

```javascript
function buildUserMessage(gameId, characterName, actionText) {
  const gs = getGameState(gameId);
  let message = '';

  // Inject critical corrections
  if (gs.pendingCorrections.length > 0) {
    const corrections = gs.pendingCorrections
      .map(c => `[CORRECTION: ${c.description}. ${c.correction}]`)
      .join('\n');
    message += corrections + '\n\n';
    gs.pendingCorrections = [];
  }

  // Chat history
  message += formatChatHistory(gs);

  // Current action
  message += `\nPlayer (${characterName}): ${actionText}`;

  return message;
}
```

### 7.3 Minor Violation Escalation

```javascript
function processViolation(gameId, violation) {
  const gs = getGameState(gameId);

  if (violation.severity === 'critical') {
    gs.pendingCorrections.push(violation);
    return;
  }

  // Minor: count consecutive occurrences
  const key = `${violation.type}:${violation.description}`;
  gs.minorViolationCounts[key] = (gs.minorViolationCounts[key] || 0) + 1;

  if (gs.minorViolationCounts[key] >= 3) {
    // Escalate to correction
    gs.pendingCorrections.push(violation);
    gs.minorViolationCounts[key] = 0;
  }
}
```

---

## 8. Model Configuration

| Call | Model | Temperature | Max Tokens | Streamed | Cost/call |
|------|-------|-------------|------------|----------|-----------|
| Sonnet narration | claude-sonnet-4-6 | 0.4-0.8 (by verbosity) | 400-1500 (by verbosity) | Yes | ~$0.008 |
| Haiku extraction | claude-haiku-4-5-20251001 | 0.0 | 500 | No | ~$0.001 |
| Haiku validation | claude-haiku-4-5-20251001 | 0.0 | 300 | No | ~$0.001 |
| Haiku template gen | claude-haiku-4-5-20251001 | 0.7 | 400 | No | ~$0.0005 |
| Sonnet combat flavor | claude-sonnet-4-6 | 0.6 | 300 | No | ~$0.004 |

### 8.1 Cost Projections

| Scenario | Current (all-Haiku) | New (split pipeline) |
|----------|-------------------|---------------------|
| Combat turn (standard) | ~$0.002 | $0.000 |
| Combat turn (flavor round) | ~$0.002 | ~$0.004 |
| Non-combat turn | ~$0.002 | ~$0.010 |
| Blended (60% combat) | ~$0.002 | ~$0.004-0.006 |
| Template generation (one-time) | $0.00 | ~$0.0005/batch |

Non-combat turns cost 5x more per turn but are dramatically higher quality. Combat turns are free. Blended cost is 2-3x current, which falls well within the ~$0.02/turn budget.

---

## 9. What Changes

| Component | Current | New |
|-----------|---------|-----|
| `buildSystemPrompt()` | ~2100 token monolith | Replaced by `buildNarrationPrompt()` (~800 tokens, Sonnet-focused) |
| `buildTrimmedPrompt()` | ~600 token compressed monolith | Removed — Sonnet always gets full narration prompt |
| `callClaude()` | Single Haiku call, parse everything | Pipeline orchestrator: route → Call 1/2/3 or template assembly |
| `parseResponse()` | Complex multi-section parser | Simplified: narration + options from Sonnet, JSON from Haiku |
| Combat narration | Full Haiku call per turn | Server-side template assembly, $0.00 |
| World state updates | Parsed from Claude's WORLD block | JSON from dedicated Haiku extraction call |
| Rules compliance | Hoped for via prompt instructions | Active validation via dedicated Haiku call |
| Combat format (dice lines) | Prompt-instructed, inconsistent | Server-generated templates, deterministic |

## 10. What Doesn't Change

- **Combat engine** (combat-engine.js) — resolvers, dice, state management all unchanged
- **Encounter designer** (encounter-designer.js) — plans, DPR estimation, monster selection unchanged
- **Action parser** (action-parser.js) — player intent parsing unchanged
- **Stat parser** (stat-parser.js) — combatStats extraction unchanged
- **Monster lookup** (monster-lookup.js) — source resolution unchanged
- **Client UI** (game.html) — same socket events, same rendering. Data arrives from different server-side source but client doesn't know.
- **Discord bot** (discord-bot.js) — same API surface
- **Auth, billing, payments** — completely unchanged
- **DB schema** — only addition is `monster_templates` table

---

## 11. Migration Strategy

The old single-call path and new pipeline can coexist during development:

```javascript
const USE_SPLIT_PIPELINE = process.env.SPLIT_PIPELINE === 'true';

if (USE_SPLIT_PIPELINE) {
  return await narrationPipeline.handlePlayerAction(gameId, characterName, actionText);
} else {
  return await legacyCallClaude(gameId, characterName, actionText);
}
```

This allows:
- A/B testing between old and new in production
- Gradual rollout (enable per-game or globally)
- Safe rollback if issues discovered

---

## 12. Supporting Artifacts

- **`docs/prompt-engineering-log.md`** — Decision log of all prompt instructions tried, outcomes, and lessons. Prevents re-trying failed approaches. Updated whenever prompt strategy changes.
