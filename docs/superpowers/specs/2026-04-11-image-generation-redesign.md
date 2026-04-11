# Image Generation Redesign: Composite Scene Composition from Stored Visual Data

**Date:** 2026-04-11
**Status:** Design
**Scope:** server.js image pipeline, system prompt changes, DB schema additions

---

## Problem Statement

The current scene image system is stateless: Claude writes a one-sentence description ("a warrior in a dark cave"), FLUX generates from scratch, and the result has zero visual continuity. The same character looks different every turn. The same tavern looks different every visit. NPCs are unrecognizable between scenes.

Meanwhile, the system *already generates and stores* rich visual data:
- **Character tokens** — generated at registration from statsText/personality/backstory, stored as base64 in `charData.token`
- **NPC portraits** — generated on first discovery via `generateWorldArt()`, stored in `gs.world.npcs[].imageUrl`
- **Location images** — generated on first discovery via `generateWorldArt()`, stored in `gs.world.locations[].imageUrl`

None of this stored visual context is used when generating scene images. That's the core waste.

---

## Architecture: Server-Side Prompt Composition

### Core Principle

**Claude describes WHAT happens. The server composes WHO, WHERE, and HOW it looks.**

Claude's `---SCENE---` output shrinks to a short action/moment tag. The server enriches it with stored visual descriptions to build a full, consistent FLUX prompt.

### New Data: `visualDesc` Field

Each entity needs a persistent **visual description string** — the text that was used (or would be used) to generate its image. This is the reusable prompt fragment.

#### What to Store

| Entity | Field | Source | Example |
|--------|-------|--------|---------|
| Character | `charData.visualDesc` | Generated at registration time by a one-shot Claude call | `"Female half-elf ranger, olive skin, silver-streaked auburn hair in a loose braid, leather armor with leaf motifs, longbow across back, green cloak, sharp amber eyes, angular features, scar across left cheek"` |
| NPC | `npc.visualDesc` | The `imagePrompt` from Claude's `IMG:` tag, stored permanently | `"Grizzled dwarf blacksmith, soot-covered leather apron, braided red beard with iron rings, missing left ear, thick muscular arms, warm brown eyes"` |
| Location | `location.visualDesc` | The `imagePrompt` from Claude's `IMG:` tag, stored permanently | `"Cavernous underground forge, rivers of molten metal flowing through stone channels, massive iron anvil at center, orange firelight reflecting off wet obsidian walls, smoke rising through natural chimney"` |

#### Schema Changes

**Characters table** — no schema change needed. `visualDesc` goes into the existing `data JSONB` column alongside `statsText`, `personality`, etc.

**World state** — no schema change needed. `visualDesc` gets stored in the `gs.world.locations[]` and `gs.world.npcs[]` objects that are already persisted via `db.setState(gameId, 'world', gs.world)`.

---

## Prompt Composition Pipeline

### Step 1: Claude outputs a minimal scene tag

Current `---SCENE---` output:
```
---SCENE---
A fierce warrior battles a dragon in a dark cave lit by molten lava.
```

New `---SCENE---` output:
```
---SCENE---
ACTION: lunging forward with sword raised, mid-strike against the dragon's neck
MOOD: desperate, climactic
FRAMING: wide shot, low angle
```

Claude no longer describes the characters, NPCs, or location — just the **moment**. Three short fields: what's physically happening, the emotional tone, and the camera angle.

### Step 2: Server resolves entities from game state

After `callClaude()` returns, before image generation, the server gathers visual descriptions:

```javascript
function composeScenePrompt(gs, sceneTag, gameConfig) {
  const style = gameConfig.image_style || 'Dark fantasy oil painting, dramatic chiaroscuro lighting, muted earth tones with gold accents';

  // 1. Parse the scene tag
  const action = sceneTag.match(/ACTION:\s*(.+)/i)?.[1] || sceneTag;
  const mood = sceneTag.match(/MOOD:\s*(.+)/i)?.[1] || '';
  const framing = sceneTag.match(/FRAMING:\s*(.+)/i)?.[1] || 'medium shot';

  // 2. Get current location visual
  const currentLoc = gs.mapGraph.playerLocation;
  const locData = gs.world?.locations?.find(
    l => l.name.toLowerCase() === currentLoc?.toLowerCase()
  );
  const locationDesc = locData?.visualDesc || locData?.description || '';

  // 3. Get active character visuals (current turn player)
  const activePlayer = getCurrentPlayerName(gs);
  const charData = gs.data.characters[activePlayer];
  const charDesc = charData?.visualDesc || '';

  // 4. Get relevant NPC visuals (NPCs at current location)
  const nearbyNpcs = (gs.world?.npcs || [])
    .filter(n => n.location?.toLowerCase() === currentLoc?.toLowerCase())
    .slice(0, 2); // max 2 NPCs to keep prompt bounded
  const npcDescs = nearbyNpcs
    .map(n => n.visualDesc || n.description)
    .filter(Boolean);

  // 5. Compose the prompt
  const parts = [style];

  if (locationDesc) parts.push(`Setting: ${locationDesc}`);
  if (charDesc) parts.push(`Main figure: ${charDesc}, ${action}`);
  else if (action) parts.push(action);
  if (npcDescs.length) parts.push(`Also present: ${npcDescs.join('. ')}`);
  if (mood) parts.push(`Mood: ${mood}`);
  if (framing) parts.push(framing);
  parts.push('No text or words in the image.');

  return parts.join('. ').slice(0, 1000);
}
```

### Step 3: FLUX receives the composed prompt

The `generateSceneImage()` function no longer prepends a generic style. It receives the fully composed prompt from `composeScenePrompt()`.

---

## Example: Full Pipeline

### Game State
- **Player:** "Kira" — visualDesc: `"Female half-elf ranger, olive skin, silver-streaked auburn hair in a loose braid, leather armor with leaf motifs, longbow across back, green cloak, sharp amber eyes"`
- **Location:** "The Sunken Forge" — visualDesc: `"Cavernous underground forge, rivers of molten metal flowing through stone channels, massive iron anvil at center, orange firelight reflecting off wet obsidian walls"`
- **NPC present:** "Durgan" — visualDesc: `"Grizzled dwarf blacksmith, soot-covered leather apron, braided red beard with iron rings, missing left ear, thick muscular arms"`

### Claude's Output
```
---SCENE---
ACTION: drawing her bow at the shadow emerging from behind the anvil
MOOD: tense, uncertain
FRAMING: over-the-shoulder shot from behind Durgan
```

### Composed FLUX Prompt
```
Dark fantasy oil painting, dramatic chiaroscuro lighting, muted earth tones with gold accents. Setting: Cavernous underground forge, rivers of molten metal flowing through stone channels, massive iron anvil at center, orange firelight reflecting off wet obsidian walls. Main figure: Female half-elf ranger, olive skin, silver-streaked auburn hair in a loose braid, leather armor with leaf motifs, longbow across back, green cloak, sharp amber eyes, drawing her bow at the shadow emerging from behind the anvil. Also present: Grizzled dwarf blacksmith, soot-covered leather apron, braided red beard with iron rings, missing left ear, thick muscular arms. Mood: tense, uncertain. Over-the-shoulder shot from behind Durgan. No text or words in the image.
```

Compare this to what the current system would produce:
```
fantasy illustration: A ranger draws her bow at a shadow in a forge. No text or words in the image.
```

---

## Generating `visualDesc` for Characters

Characters don't currently have a `visualDesc`. Two options:

### Option A: Claude generates it at registration (recommended)

After `generateCharacterToken()` is called, make a lightweight Claude call to produce a visual description from the character's statsText/personality/backstory. This is a one-time cost per character.

```javascript
async function generateVisualDesc(name, charData) {
  const desc = [charData.statsText, charData.personality, charData.backstory].filter(Boolean).join('. ');
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    messages: [{ role: 'user', content: `Write a concise visual description of this D&D character for image generation. Focus on: species, gender, build, skin/hair/eye color, clothing, armor, weapons, distinguishing marks. One paragraph, no narrative.\n\nCharacter: ${name}\n${desc.slice(0, 1000)}` }],
  });
  return response.content[0].text;
}
```

Cost: ~200 input tokens + ~100 output tokens = ~$0.0006 per character. Negligible.

The same prompt text is then used for BOTH the token generation AND stored as `charData.visualDesc` for future scene composition.

### Option B: Derive from the token generation prompt

Reuse the prompt string that was passed to FLUX for the token. This is free but less refined — it includes framing instructions ("circular frame, dark background") that don't belong in scene composition. Would need string manipulation to strip those.

**Recommendation: Option A.** The Claude call produces a clean, reusable description and costs essentially nothing.

---

## Storing `visualDesc` for NPCs and Locations

This is almost free — the data already flows through the system.

Currently, when Claude outputs `| IMG: [description]`, the server parses it as `imagePrompt` and passes it to `generateWorldArt()`. After art generation, `imageUrl` is stored but `imagePrompt` is discarded.

**Change:** When parsing the `IMG:` tag, also store the text as `visualDesc` on the entity:

```javascript
// In the world art queueing logic (callClaude, ~line 792)
if (loc.imagePrompt) {
  // Store the visual description permanently
  const existing = gs.world?.locations?.find(l => l.name.toLowerCase() === loc.name.toLowerCase());
  if (existing) existing.visualDesc = loc.imagePrompt;
  // ... rest of art queue logic
}
```

For NPCs, identical logic. The `visualDesc` persists in the world state JSONB and survives across sessions.

---

## Image Trigger Events

Current triggers (from `maybeGenerateImage`, line 905):
- **Killshot** (`isKillshot` flag) — always generates
- **Map moved** (`mapMoved` flag) — always generates

These are good triggers. Proposed additions:

| Trigger | Why | Priority |
|---------|-----|----------|
| Killshot | Dramatic moment, worth capturing | Keep (high) |
| New location entered | Visual establishment shot | Keep (high) |
| Boss encounter start | First appearance of major NPC | New (high) |
| Major NPC first meeting | Character introduction moment | New (medium) |
| Critical success/failure (nat 20/1) | Memorable gameplay moment | New (medium) |
| Every N turns (e.g., 5) | Ambient scene refresh | New (low, configurable) |

Detection for new triggers:
- **Boss encounter:** Claude could add a `BOSS:` prefix to `---SCENE---` (like existing `KILLSHOT:` prefix)
- **Critical rolls:** Detectable from narration parsing (already bold-formatted with dice results)
- **NPC first meeting:** Detectable when `world.npcs` gains a new entry with an `imagePrompt`

---

## System Prompt Changes

The changes to the system prompt are minimal — we're *reducing* what Claude needs to output.

### Current `---SCENE---` instruction (line 268-269, 379-380):
```
---SCENE---
[One sentence describing the visual scene for image generation. Painterly fantasy art style. No text.]
```

### New `---SCENE---` instruction:
```
---SCENE---
ACTION: [What is physically happening RIGHT NOW — the specific gesture, movement, or moment. 5-15 words.]
MOOD: [1-3 emotional/atmospheric words]
FRAMING: [Camera angle: wide shot, close-up, over-the-shoulder, bird's eye, low angle, etc.]
```

### Additional prefix instructions:
Add to scene instructions:
```
Do NOT describe characters' appearances, the location, or NPCs in the SCENE block — the server already has stored visual data for those. ONLY describe the ACTION (what's happening this instant), MOOD, and FRAMING.

Use KILLSHOT: prefix on ACTION when a creature is slain dramatically.
Use BOSS: prefix on ACTION when a major enemy first appears.
```

### What stays the same:
- `IMG:` tags on LOCATIONS and NPCS entries — these feed the `visualDesc` storage
- `---WORLD---` structure — unchanged
- `---OPTIONS---` — unchanged

### What's removed from Claude's burden:
- No need to compose a complete visual sentence
- No need to re-describe known characters or locations
- Saves ~20-40 output tokens per turn

---

## Style Consistency

### Global Style Prefix

All scene images share a fixed style prefix stored in the game config (`gameConfig.image_style`). The default should be upgraded from the current generic `"fantasy illustration"` to something specific:

**Recommended default:**
```
Dark fantasy oil painting, dramatic chiaroscuro lighting, muted earth tones with gold and crimson accents, highly detailed, cinematic composition
```

This prefix anchors every image to the same visual language. Individual games can override it in their settings.

### Per-Entity Style Lock

When `visualDesc` is first generated for a character/NPC/location, it becomes the canonical description. It should only change when:
- The entity is fundamentally transformed (polymorphed, location destroyed, etc.)
- Claude outputs an `IMG: UPDATED:` tag (existing mechanism)

The `visualDesc` field is write-once-unless-updated. This prevents drift.

---

## Performance Impact

### Speed improvement
- **Current:** Claude generates scene description (in its output) -> server passes to FLUX. Bottleneck is Claude's generation of the scene text within its response.
- **New:** Claude outputs 3 short fields (~15-25 tokens for SCENE block vs current ~20-40 tokens). Server composes full prompt from cached data (microseconds). Net effect: slight reduction in Claude output tokens, no change to FLUX latency.

### Cost impact
- **One-time:** ~$0.0006 per character for `visualDesc` generation via Claude
- **Per-turn:** Slight token reduction from shorter `---SCENE---` output (~20 tokens saved per turn)
- **FLUX cost:** Unchanged ($0.003 per image)
- **Net:** Marginally cheaper per turn, dramatically better quality per dollar

### Token budget
The composed FLUX prompt will be longer (~150-300 chars vs current ~80-120 chars), but FLUX.1-schnell accepts up to 1000 chars and the current code already `.slice(0, 1000)`. No issue.

---

## Migration Path

### Phase 1: Store visual descriptions (no behavior change)
1. Add `visualDesc` storage for NPCs/locations when `IMG:` tags are parsed
2. Add `generateVisualDesc()` for new character registrations
3. Backfill: on game load, if a character has no `visualDesc`, generate one

### Phase 2: New prompt composition
1. Add `composeScenePrompt()` function
2. Update `---SCENE---` parsing to extract ACTION/MOOD/FRAMING
3. Route composed prompts through existing `generateSceneImage()`
4. Update system prompt instructions

### Phase 3: Expanded triggers
1. Add BOSS: prefix detection
2. Add periodic image generation (every N turns)
3. Add critical roll detection

### Backward compatibility
- If Claude outputs an old-style single-sentence `---SCENE---` (no ACTION/MOOD/FRAMING fields), fall back to current behavior: use the sentence as-is, but still prepend location/character visual context from stored data. This makes the transition graceful.

```javascript
function parseSceneTag(sceneRaw) {
  const action = sceneRaw.match(/ACTION:\s*(.+)/i)?.[1];
  if (action) {
    // New format
    return {
      action: action.replace(/^(KILLSHOT|BOSS):\s*/i, ''),
      mood: sceneRaw.match(/MOOD:\s*(.+)/i)?.[1] || '',
      framing: sceneRaw.match(/FRAMING:\s*(.+)/i)?.[1] || 'medium shot',
      isKillshot: /^KILLSHOT:/i.test(action),
      isBoss: /^BOSS:/i.test(action),
    };
  }
  // Legacy fallback
  return {
    action: sceneRaw,
    mood: '',
    framing: 'medium shot',
    isKillshot: sceneRaw.startsWith('KILLSHOT:'),
    isBoss: false,
  };
}
```

---

## Summary of Changes by File

| File | Change | Size |
|------|--------|------|
| `server.js` | Add `composeScenePrompt()` function | ~40 lines |
| `server.js` | Add `generateVisualDesc()` function | ~15 lines |
| `server.js` | Add `parseSceneTag()` function | ~20 lines |
| `server.js` | Modify `generateCharacterToken()` to also store `visualDesc` | ~5 lines |
| `server.js` | Modify world art parsing to store `visualDesc` | ~4 lines |
| `server.js` | Modify `maybeGenerateImage()` to use `composeScenePrompt()` | ~8 lines |
| `server.js` | Update system prompt `---SCENE---` instructions | ~10 lines changed |
| `server.js` | Add BOSS: prefix detection, expanded triggers | ~15 lines |
| `db.js` | No changes needed | 0 |
| `map-engine.js` | No changes needed | 0 |

**Total estimated diff: ~120 lines added/modified, 0 new files.**

---

## Expected Quality Improvement

| Dimension | Before | After |
|-----------|--------|-------|
| Character consistency | None — different person every image | High — same visual description anchors every scene |
| Location consistency | None — generic "cave" or "tavern" | High — stored architectural/lighting details reused |
| NPC recognizability | None | High — stored portrait descriptions reused |
| Style coherence | Low — generic "fantasy illustration" | High — fixed style prefix on every prompt |
| Compositional complexity | Single subject/vague scene | Multi-entity with specific spatial relationships |
| Action clarity | Vague ("battles a dragon") | Specific ("lunging forward, sword raised mid-strike at the dragon's neck") |
| Prompt token utilization | ~80-120 chars of 1000 limit | ~300-600 chars — much better use of FLUX's capacity |
