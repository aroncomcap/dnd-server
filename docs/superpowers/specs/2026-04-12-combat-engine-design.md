# Combat Engine Design — Rules-True Combat for Tavern Table

**Date:** 2026-04-12
**Status:** Draft
**Systems:** D&D 5e, RuneQuest: Roleplaying in Glorantha

## Problem

The AI (Haiku) currently hand-waves combat: inventing dice rolls, guessing modifiers, drifting on HP, skipping saving throws, ignoring conditions and concentration. Combat feels narrative rather than mechanical. Players can't trust the numbers.

## Solution

A server-side combat engine that owns all dice rolls, math, HP tracking, and condition management. The AI's role in combat shifts from "simulate the rules" to "narrate pre-resolved results." The server resolves, the AI narrates.

## Architecture: Approach

New `combat-engine.js` module with system-specific resolvers. Server.js orchestrates (routes actions, manages lifecycle). The engine is pure logic — no socket/DB dependencies.

---

## 1. Structured Character Stats

When a character is registered (manual or pre-gen), Haiku extracts a `combatStats` JSON object from the free-form `statsText`. Stored alongside `statsText` in the character object and persisted to DB.

For existing characters (games already in progress), auto-trigger stat parsing on the first combat encounter.

Re-parse whenever `CHAR_UPDATES` modifies `statsText` (level-ups, new equipment, etc.).

### D&D 5e combatStats Schema

```json
{
  "system": "dnd5e",
  "level": 5,
  "ac": 16,
  "hp": 38,
  "maxHp": 38,
  "speed": 30,
  "abilities": { "str": 16, "dex": 12, "con": 14, "int": 10, "wis": 13, "cha": 8 },
  "saveProficiencies": ["str", "con"],
  "proficiencyBonus": 3,
  "weapons": [
    { "name": "longsword", "attackMod": "str", "damage": "1d8", "damageType": "slashing", "properties": ["versatile"] },
    { "name": "javelin", "attackMod": "str", "damage": "1d6", "damageType": "piercing", "properties": ["thrown"], "range": "30/120" }
  ],
  "spells": [
    { "name": "fireball", "level": 3, "save": "dex", "damage": "8d6", "damageType": "fire", "area": "20ft sphere" },
    { "name": "shield", "level": 1, "reaction": true, "effect": "+5 AC until next turn" }
  ],
  "spellSlots": { "1": 4, "2": 3, "3": 2 },
  "spellcastingAbility": "int",
  "features": ["Extra Attack", "Action Surge"],
  "conditions": [],
  "concentrating": null,
  "deathSaves": { "successes": 0, "failures": 0 },
  "inspiration": false
}
```

### RuneQuest combatStats Schema

```json
{
  "system": "runequest",
  "characteristics": { "str": 14, "con": 12, "siz": 13, "int": 15, "pow": 16, "dex": 11, "cha": 10 },
  "hitLocations": {
    "head": { "hp": 5, "maxHp": 5, "armor": 0 },
    "chest": { "hp": 6, "maxHp": 6, "armor": 3 },
    "abdomen": { "hp": 5, "maxHp": 5, "armor": 3 },
    "rightArm": { "hp": 4, "maxHp": 4, "armor": 0 },
    "leftArm": { "hp": 4, "maxHp": 4, "armor": 0 },
    "rightLeg": { "hp": 5, "maxHp": 5, "armor": 3 },
    "leftLeg": { "hp": 5, "maxHp": 5, "armor": 3 }
  },
  "totalHp": 12,
  "weapons": [
    { "name": "broadsword", "skill": 65, "damage": "1d8+1+1d4", "sr": 7 },
    { "name": "medium shield", "skill": 45, "damage": "1d4+1d4", "parry": 45 }
  ],
  "runePoints": 3,
  "maxRunePoints": 3,
  "magicPoints": 16,
  "maxMagicPoints": 16,
  "runeSpells": [{ "name": "Shield", "cost": 1, "effect": "+20% to parry" }],
  "spiritSpells": [{ "name": "Bladesharp 2", "cost": 2, "effect": "+10% attack, +2 damage" }],
  "skills": { "dodge": 35, "firstAid": 40 },
  "strikeRank": 7,
  "conditions": []
}
```

### Stat Parser

`stat-parser.js` (~150 lines) — Sends `statsText` + schema definition to Haiku, receives structured JSON. Validates required fields, fills defaults for missing optional fields.

---

## 2. Monster Database with Layered Sources

### Source Resolution Order

1. **Game-level overrides** — Monsters customized for this specific game (homebrew, AI-generated fallbacks). Stored in DB per game.
2. **Campaign sources** — Monsters from a specific module/campaign the host has loaded. Stored in DB, shareable across games.
3. **System defaults** — Base SRD/OGL files shipped with the app. `monsters-5e-srd.json`, `monsters-rq-core.json`.
4. **AI fallback** — Haiku generates a stat block for anything not found above. Generated blocks get saved to game-level overrides so it only generates once per unknown monster per game.

### Database Schema

```sql
-- Monster source collections
CREATE TABLE monster_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,              -- e.g. "D&D 5e SRD", "RuneQuest Bestiary"
  system TEXT NOT NULL,            -- "dnd5e", "runequest"
  scope TEXT NOT NULL DEFAULT 'global',  -- "global" (admin) or "game" (per-game)
  game_id UUID REFERENCES games(id),     -- NULL for global sources
  monsters JSONB NOT NULL DEFAULT '{}',  -- keyed by slug
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Which sources are attached to which games
CREATE TABLE game_monster_sources (
  game_id UUID REFERENCES games(id),
  source_id UUID REFERENCES monster_sources(id),
  priority INT NOT NULL DEFAULT 0,  -- lower = checked first
  PRIMARY KEY (game_id, source_id)
);
```

### Monster Data Generation

SRD monster JSON files generated using AI from official SRD text. Each monster entry uses the same `combatStats` format as characters (D&D 5e schema for 5e monsters, RuneQuest schema for RQ creatures). ~300 D&D 5e SRD monsters, core RuneQuest creatures.

### Lookup Function

```js
async function getMonsterStats(gameId, system, slug) {
  // 1. Check game-level overrides (DB: monster_sources WHERE game_id AND scope='game')
  // 2. Check attached sources by priority (DB: game_monster_sources JOIN monster_sources)
  // 3. Check system defaults (in-memory JSON loaded at startup)
  // 4. AI fallback → generate, save to game-level overrides
}
```

### Host Tab Integration

A section in the Host tab showing attached monster sources. When a game selects D&D 5e or RuneQuest, the system default source is auto-attached. Admin can create/edit global sources. Updates to global sources propagate to all games using them (reference, not copy).

### Enemy Introduction Format

AI outputs in the WORLD section:

```
ENEMIES:
- Goblin War Chief | 1 | goblin-war-chief
- Goblin | 3 | goblin
- Dire Wolf | 2 | dire-wolf
```

Format: `display name | count | monster-db-slug`

For custom/homebrew enemies not in any source:

```
ENEMIES:
- Shadow Wraith | 1 | custom | undead, CR 5, incorporeal, necrotic damage
```

The `custom` key triggers the AI fallback to generate a full stat block using the hint text.

---

## 3. Combat Engine — State & Resolution

### `combat-engine.js` (~300 lines)

Pure logic module. No socket, DB, or AI dependencies. Server.js passes in combatant data and actions, engine returns results.

### Combat State

```js
combatState = {
  active: false,
  round: 0,
  system: "dnd5e",                // or "runequest"
  turnIndex: 0,                    // current position in initiative order
  initiativeOrder: [               // sorted by initiative value
    { id: "kael", name: "Kael", init: 18, type: "PC" },
    { id: "goblin-chief-1", name: "Goblin Chief", init: 12, type: "Enemy" },
  ],
  combatants: {                    // all participants keyed by id
    "kael": { ...combatStats, id: "kael", type: "PC" },
    "goblin-chief-1": { ...combatStats, id: "goblin-chief-1", type: "Enemy" },
  },
  activeEffects: [                 // tracked buffs/debuffs with duration
    { name: "Bless", caster: "elara", targets: ["kael", "elara"],
      effect: { attackBonus: "1d4", saveBonus: "1d4" },
      duration: { type: "concentration", maxRounds: 10 }, roundApplied: 1 }
  ],
  pendingReaction: null,           // reaction prompt awaiting player response
  log: []                          // audit trail of all rolls/results
}
```

### System Resolvers

The engine delegates system-specific math to resolver modules:

```js
const resolvers = {
  dnd5e: require('./resolvers/dnd5e-resolver'),
  runequest: require('./resolvers/runequest-resolver'),
};

// Each resolver implements:
{
  rollInitiative(combatant) → number,
  resolveAttack(attacker, target, weapon, conditions, activeEffects) → result,
  resolveSpell(caster, spell, targets, conditions, activeEffects) → result,
  resolveDefense(defender, defenseType, incomingAttack) → result,  // RQ: parry/dodge
  applyDamage(target, damage, damageType) → updatedTarget,
  checkDeath(combatant) → status,
  getAvailableActions(combatant) → actions[],
  resolveConcentrationCheck(caster, damageTaken) → { dc, roll, success },
  resolveDeathSave(combatant) → result,  // D&D 5e only
}
```

### D&D 5e Attack Resolution

```
1. Determine attack modifier: ability mod + proficiency bonus + active effects (Bless, etc.)
2. Check advantage/disadvantage from conditions (prone target = advantage on melee, etc.)
3. Roll d20 (real RNG via dice.js)
   - Natural 20 → critical hit (double damage dice)
   - Natural 1 → automatic miss
4. Add modifier, compare vs target AC (including Shield spell, cover, etc.)
5. If hit: roll damage dice + modifier
6. Apply resistance/vulnerability/immunity to damage type
7. Subtract from target HP
8. Check if target reaches 0 HP → unconscious, death saves begin
9. If target was concentrating → trigger concentration check (see Reaction System)
```

### RuneQuest Attack Resolution

```
1. Attacker rolls d100 vs weapon skill%
   - ≤ skill/20 → critical hit (max damage, ignore armor)
   - ≤ skill/5  → special hit (max weapon damage + special effect)
   - ≤ skill%   → normal hit
   - > skill%   → miss
   - 96-00      → fumble (roll on full fumble table)
2. Defender may parry (weapon/shield skill%) or dodge (dodge skill%)
   - Critical parry vs normal hit → no damage, attacker's weapon damaged
   - Special parry → weapon/shield absorbs double its normal HP
   - Normal parry → shield/weapon absorbs its damage rating
   - Dodge success → attack misses entirely
   - Result matrix: attacker result vs defender result determines outcome
3. Roll hit location (d20):
   Right Leg (1-4), Left Leg (5-8), Abdomen (9-11),
   Chest (12), Right Arm (13-15), Left Arm (16-18), Head (19-20)
4. Calculate damage: weapon dice + damage bonus - location armor points
   - Location HP reduced by net damage
   - Location HP ≤ 0 → limb useless/incapacitated
   - Location HP ≤ -(max location HP) → severed/destroyed
   - Total HP ≤ 0 → dead
5. Check for special effects based on attack quality (impale, slash, crush)
```

### RuneQuest Fumble Tables (Full)

Ship complete fumble tables for:
- Melee weapons (d20: lose next attack, drop weapon, hit self, hit ally, weapon breaks, fall prone, etc.)
- Ranged weapons (d20: bowstring breaks, hit ally, lose arrow, weapon jams, etc.)
- Natural weapons (d20: fall prone, twist limb, bite tongue, etc.)
- Spell fumbles (d20: lose extra MP, spell backfires, target wrong person, etc.)

### RuneQuest Special/Critical Tables

- Impale: weapon stuck in target, extra damage equal to max weapon damage
- Slash: max damage + extra bleeding (1 HP/round to location)
- Crush: max damage + knockback, target must resist or fall prone

### Dice Module

`resolvers/dice.js` (~50 lines) — Real RNG wrapper:

```js
d4(), d6(), d8(), d10(), d12(), d20(), d100()
roll(notation)    // "2d6+3" → { rolls: [4, 2], modifier: 3, total: 9 }
advantage()       // roll 2d20, take higher
disadvantage()    // roll 2d20, take lower
```

### Action Types

| Action | D&D 5e | RuneQuest |
|--------|--------|-----------|
| Melee attack | d20 + mod vs AC | d100 ≤ skill%, hit location, armor reduction |
| Ranged attack | d20 + mod vs AC, range | d100 ≤ skill%, hit location |
| Spell (attack) | d20 + mod vs AC or save DC | Rune/Spirit magic, MP/RP cost |
| Spell (save) | Target rolls save vs DC | Resistance roll (POW vs POW) |
| Spell (buff/heal) | Roll healing/buff dice, apply effect | Apply spell effect, deduct MP/RP |
| Dodge | — | Dodge skill% roll |
| Parry | — | Parry skill% with weapon/shield |
| Concentration check | CON save vs DC 10 or half damage | — |
| Death saves (D&D) | d20, track 3 success/fail | — |
| Skill check | d20 + mod vs DC | d100 vs skill% |
| Grapple/Shove | Athletics vs Athletics/Acrobatics | STR vs STR resistance |

### Active Effects Tracking

Buffs and debuffs tracked with duration:

```js
{
  name: "Bless",
  caster: "elara",
  targets: ["kael", "elara", "theron"],
  effect: { attackBonus: "1d4", saveBonus: "1d4" },
  duration: { type: "concentration", maxRounds: 10 },
  roundApplied: 1
}
```

Duration types:
- `concentration` — ends when caster loses concentration or dismisses
- `rounds` — expires after N rounds
- `untilEndOfNextTurn` — expires at end of target's next turn
- `untilSaved` — target re-saves each turn (e.g. Hold Person)
- `permanent` — lasts until dispelled or removed (e.g. Blindness with failed save)

Engine checks and expires effects at the appropriate phase of each round.

---

## 4. Reaction System

Certain events during combat can trigger player choices before resolution continues. This is critical for rules-true D&D 5e play.

### Reaction Triggers

| Trigger | Player Choice |
|---------|--------------|
| Damage while concentrating | Use Inspiration, Bardic Inspiration, Flash of Genius, War Caster feature, or just roll the CON save |
| Attack hits (barely) | Cast Shield (+5 AC, might turn hit into miss), Absorb Elements, other reaction spells |
| Ally drops to 0 HP nearby | Sentinel reaction, healing word as reaction (if available via feature) |
| Enemy leaves reach | Opportunity attack (yes/no) |
| Spell targeting (counterspell range) | Cast Counterspell |

### Reaction Flow

```
Combat resolution in progress...
  → Trigger detected (e.g. Goblin hits Elara for 8 damage, she's concentrating on Bless)
  → Engine pauses, returns pendingReaction:
    {
      type: "concentration_damage",
      combatant: "elara",
      context: { damage: 8, dc: 10, currentSlots: {1: 2, 2: 1} },
      options: [
        { id: "roll", label: "Roll CON save (d20+4 vs DC 10)" },
        { id: "inspiration", label: "Use Inspiration (advantage on save)", available: true },
        { id: "shield", label: "Cast Shield (1st-level slot) — +5 AC, attack becomes MISS", available: true },
        { id: "bardic", label: "Add Bardic Inspiration (d8) to save", available: false },
        { id: "flash", label: "Flash of Genius (+INT to save)", available: false }
      ]
    }
  → Server emits reaction_prompt to the player's client
  → Client shows choices as buttons
  → Player picks "shield"
  → Server sends to engine: resolveReaction("shield")
  → Engine: Shield costs 1st-level slot, AC becomes 18,
    original attack roll (15) < new AC (18) → attack becomes MISS
    → No damage taken, no concentration check needed
  → Resolution continues with remaining combatants
```

### Timeout

If a player doesn't respond within 30 seconds, auto-resolve with the default option (plain roll, no resources spent). Keeps combat moving.

### RuneQuest Reactions

In RuneQuest, the primary reaction is **parry vs dodge** — defender always gets to choose. This is part of the standard attack resolution (step 2 in the RQ attack flow), not a separate reaction system. The resolver handles it inline:

```
→ Attack incoming against Kael
→ Engine checks: does Kael have a parry-capable weapon/shield?
→ If yes: prompt player "Parry with medium shield (45%) or Dodge (35%) or take the hit?"
→ Same reaction_prompt socket flow
→ Player chooses → engine resolves defense roll → continues
```

---

## 5. Action Parsing

Converts player intent ("I slash at the goblin") into a structured action the engine understands.

### Tier 1: Pattern Matching (fast, free)

```js
// Pre-tagged options (most common path)
Player clicks option "1" → action already tagged from pre-parsing → skip to engine

// Freeform patterns
"attack [target] with [weapon]" → { type: "attack", target, weapon }
"cast [spell] on/at [target]"  → { type: "spell", spell, target }
"dodge" / "disengage" / "dash" → { type: "dodge" | "disengage" | "dash" }
"heal [target]"                → { type: "spell", spell: "cure wounds", target }
"1" / "2" / "3"               → maps to pre-tagged option
```

### Tier 2: AI Assist (when Tier 1 fails)

For freeform input like "I try to shove the goblin off the bridge while screaming my battle cry":

```
Prompt to Haiku (~100 tokens response):
"Given this player input and their available actions, extract the game action.
Character weapons: longsword, javelin. Spells: fireball, shield.
Input: 'I try to shove the goblin off the bridge'
Reply with JSON only: {type, target, weapon/spell, notes}"

→ { "type": "shove", "target": "goblin-1", "notes": "off the bridge" }
```

### Pre-Parsing Options

After each AI narration response, the 3 suggested options are pre-parsed asynchronously:

1. AI generates 3 natural-language options
2. Server sends all 3 to Haiku in one call (~150 tokens): "Parse these into structured actions"
3. Results cached. When player clicks an option, the action is already resolved.
4. This happens during player think time — no latency impact.

---

## 6. Enemy Turn Resolution

### Flow

```
All enemy turns in a round are batched:

1. Server builds tactical context:
   "Goblin Chief (12/21 HP), Goblin 1 (7/7 HP), Goblin 2 (7/7 HP)
    Targets: Kael (24/38 HP, 10ft, AC 16), Elara (14/28 HP, 30ft, concentrating on Bless, AC 13)

    Goblin Chief can: Attack (scimitar, 1d6+2), Multiattack (2x scimitar), Disengage, Dash
    Goblin can: Attack (shortbow, 1d6+2, range 80/320), Attack (scimitar, 1d6+2)

    Choose ONE action per enemy. Format:
    ACTION: [enemy-id] [action] [target-id]"

2. One Haiku call (~50 tokens response):
   "ACTION: goblin-chief-1 multiattack elara
    ACTION: goblin-1 attack-shortbow kael
    ACTION: goblin-2 attack-shortbow elara"

3. Engine resolves each action mechanically (dice, modifiers, damage, HP)

4. All results batched into the next AI narration prompt
```

### Tactical Hints

The tactical prompt includes battlefield awareness so the AI makes reasonable decisions:
- "Elara is concentrating on Bless" (high-value target — break concentration)
- "Kael is at 4 HP" (finish off wounded PC)
- "Theron is prone" (advantage on melee attacks against prone)
- "Goblin 2 is at 2 HP" (might flee or act desperately)

The AI makes tactical calls, the server resolves the math.

### Token Cost

- One Haiku call per round for all enemy tactics: ~150 tokens out
- Scales well — 10 enemies still one call

---

## 7. Combat Lifecycle & Server.js Integration

### Entering Combat

```
AI narration includes ENEMIES: block in the ---WORLD--- section
  (The presence of an ENEMIES: block IS the combat start signal — no separate COMBAT_START marker needed)
  → Server parses ENEMIES entries
  → Look up monster stats (layered source resolution)
  → Roll initiative for all combatants (real d20 + DEX mod / Strike Rank)
  → combatEngine.initCombat(players, enemies, system)
  → Emit combat_started to all clients
  → Store combatState on game state object
  → Next AI call receives combat context injection
```

### Modified callClaude Flow

```
player_action received
  → Is combat active?

  NO → callClaude(action) as today (unchanged)

  YES →
    1. Parse player intent (Tier 1 pattern match / Tier 2 Haiku)
    2. Check for pending reactions, resolve if needed
    3. combatEngine.resolveAction(parsedAction) → player result
    4. Advance to enemy turns
    5. One Haiku call for enemy tactical decisions
    6. combatEngine.resolveAction() for each enemy → enemy results
    7. Check for reaction triggers on player (opportunity attacks, Shield, etc.)
    8. Format all results as combat context string
    9. callClaude(playerAction + combatContext) → AI narrates around facts
    10. parseResponse (same as today, plus ENEMIES detection for new waves)
    11. Pre-parse the 3 new suggested options (async Haiku)
    12. Sync engine state → combatStats → DB
    13. Emit combat_update + dm_response to all clients
```

### Combat State Injection Into Prompt

When combat is active, inject before the AI narration call:

```
ACTIVE COMBAT — Round 3
Initiative: Kael (18) → Goblin Chief (12) → Elara (9) → Goblin x2 (7)
Current turn: Elara

COMBATANT STATUS:
- Kael: 24/38 HP, AC 16, no conditions
- Elara: 14/28 HP, AC 13, concentrating on Bless (round 1)
- Goblin Chief: 12/21 HP, AC 15, no conditions
- Goblin 1: 3/7 HP, AC 13, no conditions
- Goblin 2: DEAD

ACTIVE EFFECTS:
- Bless (Elara, concentration): Kael, Elara, Theron get +1d4 to attacks and saves

RESOLVED THIS ROUND:
- Kael attacks Goblin Chief with longsword: d20+6=23 vs AC 15. HIT! 1d8+3=9 slashing. Goblin Chief 21→12 HP.
- Goblin Chief multiattacks Elara: d20+4=11 vs AC 14. MISS! d20+4=17 vs AC 14. HIT! 1d6+2=5 slashing. Elara 19→14 HP.
  → Elara rolls concentration save: d20+4=16 vs DC 10. SUCCESS. Bless maintained.
- Goblin 1 shoots Kael: d20+4=18 vs AC 16. HIT! 1d6+2=5 piercing. Kael 29→24 HP.

Narrate these results in your DM persona. It is now Elara's turn.
```

### Exiting Combat

Three triggers:

1. **All enemies down** — Engine detects all enemy HP ≤ 0 (D&D) or dead (RQ). Flags `combatOver: true`. Server tells AI "Combat is over, narrate the aftermath."
2. **AI declares end** — AI includes `COMBAT_END` in response (enemies flee, surrender, parley). Server calls `combatEngine.endCombat()`.
3. **All PCs down** — TPK or all unconscious. Trigger special handling (death saves continue, potential NPC rescue, etc.).

### State Sync on Combat End

1. Final HP, conditions, spell slot usage written back to `combatStats`
2. Haiku call to update `statsText` from structured `combatStats` (keeps the free-form text in sync)
3. `CHAR_UPDATES` emitted for all changed characters
4. `combatState.active = false`
5. Emit `combat_ended` to clients

---

## 8. Client-Side Combat UI

Minimal changes to `public/game.html`. Enhance existing elements, add one new panel.

### Enhanced Turn Order Overlay (already exists)

Currently displays AI-generated turn order text. Changes:
- Populated from server combat state (authoritative) instead of AI text
- HP bars next to each combatant name (green → yellow → red)
- Condition icons (stunned, prone, concentrating, poisoned, etc.)
- Highlight current turn
- Strikethrough + skull icon for dead combatants
- Click enemy name → compact stat card popup (AC, HP, known attacks, conditions)

### New: Combat Log Panel

Collapsible panel below the chat area. Shows the mechanical audit trail:

```
━━ Round 3 ━━
Kael → Goblin Chief: d20+6 = 23 vs AC 15. HIT! 1d8+3 = 9 slashing. [21→12 HP]
Goblin Chief → Elara: d20+4 = 11 vs AC 14. MISS!
Goblin Chief → Elara: d20+4 = 17 vs AC 14. HIT! 1d6+2 = 5 slashing. [19→14 HP]
  └─ Concentration save: d20+4 = 16 vs DC 10. SUCCESS.
Goblin 1 → Kael: d20+4 = 18 vs AC 16. HIT! 1d6+2 = 5 piercing. [29→24 HP]
```

Players see real rolls. Transparent, verifiable. AI narration appears in chat as usual — the combat log is the "show your math" companion.

### Reaction Prompt UI

When a `reaction_prompt` event arrives:
- Modal overlay (doesn't block seeing the battlefield)
- Show context: "Elara takes 8 damage while concentrating on Bless"
- Buttons for each available option, grayed out for unavailable ones
- 30-second countdown timer
- Auto-selects default (plain roll) on timeout

### Action Buttons During Combat

The 3 options still appear as buttons. Each is backed by a pre-parsed action tag. Clicking sends the tagged action directly — no parsing delay.

### Socket Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `combat_started` | server → client | initiative order, enemy summary, round 1 |
| `combat_update` | server → client | round, turn, all combatant HP/conditions, round log entries |
| `combat_ended` | server → client | final state, XP/loot trigger |
| `reaction_prompt` | server → client (specific player) | trigger type, context, available options, timeout |
| `reaction_response` | client → server | selected option id |

Player actions still flow through existing `player_action` socket event. Server routes through engine when combat is active.

---

## 9. Prompt Changes

### Combat-Mode Injection (replaces current COMBAT section when active)

```
COMBAT MODE — The server handles all dice rolls, damage calculation, and HP tracking.
You MUST NOT invent dice results or change HP values. Your job is to NARRATE the
pre-resolved results provided in RESOLVED THIS ROUND.

Rules:
- Use the exact numbers provided. Do not alter, round, or reinterpret them.
- Format each roll as: **🎲 [description] — rolls [total]. HIT/MISS! [damage]. [target] [HP]**
- Narrate between rolls with 1-2 sentences of flavor in your DM persona.
- Do NOT skip any resolved action — every result must appear in your narration.
- For results where a target reaches 0 HP, include KILLSHOT: [dramatic scene description].
- Conditions are tracked by the server. Mention them narratively but do not add or remove them.
- Active effects (Bless, etc.) are tracked by the server. Reference them narratively.
```

### Enemy Introduction Format (added to WORLD output instructions)

```
When introducing hostile creatures that will initiate combat, include in the ---WORLD--- block:

ENEMIES:
- [Display Name] | [count] | [monster-db-slug]

Example:
ENEMIES:
- Goblin War Chief | 1 | goblin-war-chief
- Goblin | 3 | goblin
- Dire Wolf | 2 | dire-wolf

For custom/homebrew enemies not in standard sources:
- Shadow Wraith | 1 | custom | undead, CR 5, incorporeal, necrotic damage
```

### Enemy Tactics Prompt (small mid-round Haiku call)

```
You are the tactical AI for enemy combatants. Given the battlefield state below,
choose ONE action for each enemy. Reply ONLY with action lines, no narration.

Format: ACTION: [enemy-id] [action-type] [target-id]

Available action types: attack [weapon], cast [spell], multiattack, disengage, dash, dodge, grapple, shove

Consider: wounded PCs, concentrating casters, tactical advantage, self-preservation at low HP.

[battlefield state injected here]
```

### Non-Combat Unchanged

When `combatState.active` is false, prompts remain exactly as they are today. Zero impact on exploration and social pillar play.

---

## 10. File Map & Token Cost

### New Files

| File | ~Lines | Purpose |
|------|--------|---------|
| `combat-engine.js` | ~300 | Combat state management, lifecycle, turn routing |
| `resolvers/dnd5e-resolver.js` | ~400 | D&D 5e: attacks, spells, saves, damage, death saves, conditions |
| `resolvers/runequest-resolver.js` | ~450 | RQ: percentile rolls, parry/dodge, hit locations, fumble/special/critical tables |
| `resolvers/dice.js` | ~50 | Real RNG: d4-d100, NdX notation parser, advantage/disadvantage |
| `monsters/monsters-5e-srd.json` | data | ~300 SRD monsters in combatStats format |
| `monsters/monsters-rq-core.json` | data | Core RuneQuest creatures in combatStats format |
| `stat-parser.js` | ~150 | Haiku: statsText → combatStats JSON extraction |
| `action-parser.js` | ~100 | Tier 1 pattern matching + Tier 2 Haiku intent extraction |

### Modified Files

| File | Changes |
|------|---------|
| `server.js` | Combat routing in callClaude, lifecycle hooks, ENEMIES parsing, monster source lookup, reaction socket events, fix 3 async handlers |
| `public/game.html` | Combat log panel, enhanced turn order overlay with HP bars, reaction prompt modal, enemy stat cards, combat socket handlers |
| `db.js` | `monster_sources` + `game_monster_sources` tables, `combatStats` column on characters |

### Token Cost Per Combat Turn

| Call | Tokens Out | When |
|------|-----------|------|
| Main narration | 900-2500 (same as today) | Every turn |
| Enemy tactics | ~150 | Every round (once for all enemies) |
| Option pre-parsing | ~150 | Async during player think time |
| Stat block gen (fallback) | ~300 | Once per unknown monster |
| Reaction intent parsing | ~100 | Only on freeform reaction input |

Net increase per turn: ~150-300 tokens for enemy tactics. Option pre-parsing overlaps with player think time and doesn't block.

### Bug Fix (from code review)

Fix 3 socket handlers in server.js missing `async/await`:
- `socket.on('set_pillars', ...)` — add `async`, `await gameEngine.setPillars()`
- `socket.on('set_verbosity', ...)` — add `async`, `await gameEngine.setVerbosity()`
- `socket.on('set_ferocity', ...)` — add `async`, `await gameEngine.setFerocity()`

These currently silently swallow DB write failures.
