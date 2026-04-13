# Encounter Difficulty Module Design

**Date:** 2026-04-13
**Status:** Draft
**Systems:** D&D 5e (primary), RuneQuest (future)

## Problem

Encounter difficulty is currently prompt-only — the AI decides how hard fights are based on ferocity text guidance. This produces inconsistent results: combat can last 1 round or 15, with no correlation to ferocity settings. There's no math connecting party power to monster selection, no tracking of actual difficulty outcomes, and no adventuring day planning.

## Solution

A server-side Encounter Difficulty Module that:
1. Calculates party DPR (damage per round) from stats + rolling combat history
2. Designs encounters with monster HP/DPR budgets calibrated to target round counts
3. Plans full adventuring days with encounter sequences, rest cadence, and pillar distribution
4. Applies difficulty scaling to social and exploration challenges (not just combat)
5. Tracks actual outcomes and self-corrects over time

---

## 1. DPR Calculator & Party Power Budget

### Party DPR Estimation

For each character, estimate DPR from their `combatStats`:

**Weapon DPR:**
- Average damage per hit = avg(damage dice) + ability modifier
- Hit probability = (21 - (target AC - attack modifier)) / 20, clamped to [0.05, 0.95]
- Weapon DPR = avg damage × hit probability
- Extra Attack feature: multiply by 2 (or 3 for Fighter 11+)
- Critical hit bonus: +5% × avg damage dice (nat 20 doubles dice)

**Spell DPR:**
- Cantrip DPR: avg(cantrip damage) × hit/save probability (at-will, no resource cost)
- Leveled spell DPR: avg(best damage spell) × hit/save probability, weighted by slots available
- Burst DPR: max single-turn damage using highest slot

**Effective DPR:** max(weaponDPR, cantrip DPR) + (leveled spell burst / expected combat rounds)

This gives a conservative estimate — the character uses their best at-will option plus amortizes spell slots across a combat.

### Rolling DPR from Combat History

Track actual damage dealt per character per combat from `combatEngine.state.log`:
- After each combat ends, sum all damage dealt by each PC
- Divide by combat round count = actual DPR for that fight
- Store last 3 combats per character
- Weighted average: [0.5 (most recent), 0.3, 0.2]
- Use rolling average when available, fall back to estimated DPR for characters without combat history

### Monster HP Budget

```
monsterTotalHP = partyDPR × targetRounds × ferocityHPMultiplier
```

| Ferocity | Label | Target Rounds | HP Multiplier | Monster DPR Multiplier | PC Death Frequency |
|----------|-------|---------------|---------------|----------------------|-------------------|
| 1 | Deadly | 4-5 | 1.5x | 1.8x | Every 3-5 combats |
| 2 | Dangerous | 3-5 | 1.3x | 1.4x | Every 6-8 combats |
| 3 | Balanced | 3-4 | 1.0x | 1.0x | Every 9-12 combats |
| 4 | Light | 2-3 | 0.7x | 0.7x | Every 13-16 combats |
| 5 | Easy | 2-3 | 0.5x | 0.5x | Every 17-20 combats |

### Monster DPR Budget

```
monsterTotalDPR = partyTotalHP / (targetRounds × deathFrequencyFactor)
```

Where `deathFrequencyFactor` scales based on how many combats between expected PC deaths. Higher factor = less dangerous per fight.

---

## 2. Encounter Designer

Given a party and difficulty parameters, design a specific encounter.

### Combat Encounter Design

Input: party combatStats[], ferocity, encounterPosition (early/mid/late/boss)

1. Calculate party DPR (rolling avg or estimated)
2. Calculate HP budget based on target rounds + ferocity
3. Calculate monster DPR budget
4. Apply escalation modifier based on position in adventuring day:
   - Early encounters: 0.6x budget (warmup)
   - Mid encounters: 1.0x budget (standard)
   - Late encounters: 1.3x budget (resource drain)
   - Boss encounters: 1.8x budget (climax)
5. Select monsters from the database that fit the budget:
   - Find monsters whose total HP fits within ±20% of budget
   - Prefer monsters whose DPR fits the DPR budget
   - Prefer variety (don't repeat the same monster in consecutive encounters)
   - Allow mix of 1 strong + several weak, or all medium, etc.
6. Return: `{ monsters: [{slug, count, stats}], totalHP, estimatedDPR, estimatedRounds, difficultyRating }`

### Social Encounter Design

Social challenges use a "DC budget" analogous to HP budget:

```
socialDifficulty = baseDC + ferocityModifier + escalationModifier
```

| Ferocity | Base Social DC | Consequence on Failure |
|----------|---------------|----------------------|
| 1 (Deadly) | 18-20 | Severe (combat starts, ally captured, treasure lost) |
| 2 (Dangerous) | 16-18 | Major (deal worsens significantly, enemy alerted) |
| 3 (Balanced) | 13-15 | Moderate (partial success, complication added) |
| 4 (Light) | 11-13 | Minor (small setback, can retry with disadvantage) |
| 5 (Easy) | 8-10 | Minimal (flavor consequence only, narrative setback) |

Multi-roll social challenges: X successes before Y failures, where X and Y scale with ferocity.
- Deadly: 4 successes before 2 failures
- Balanced: 3 successes before 3 failures
- Easy: 2 successes before 3 failures

### Exploration Encounter Design

Exploration challenges use trap/puzzle difficulty scaling:

| Ferocity | Trap/Puzzle DC | Trap Damage | Detection DC |
|----------|---------------|-------------|-------------|
| 1 (Deadly) | 18-20 | 4d10 | 18 |
| 2 (Dangerous) | 16-18 | 3d10 | 16 |
| 3 (Balanced) | 13-15 | 2d10 | 14 |
| 4 (Light) | 11-13 | 1d10 | 12 |
| 5 (Easy) | 8-10 | 1d6 | 10 |

Exploration skill challenges follow the same success/failure count as social.

---

## 3. Adventuring Day Planner

Designs a full sequence of encounters for one in-game adventuring day.

### Input
- Party: combatStats[] for all PCs
- Ferocity: 1-5
- Pillars: { exploration: %, combat: %, social: % }
- Host overrides (optional): { encounterCount, restFrequency, bossEncounter, theme }

### Output: Adventuring Day Plan

```js
{
  encounters: [
    { position: 'early', pillar: 'exploration', type: 'trap', difficulty: 'easy', dc: 13, details: {...} },
    { position: 'early', pillar: 'combat', type: 'combat', difficulty: 'medium', monsters: [...], totalHP: 40, estimatedRounds: 3 },
    { position: 'mid', pillar: 'social', type: 'negotiation', difficulty: 'medium', dc: 14, stakes: '...' },
    { rest: 'short', reason: 'After 3 encounters' },
    { position: 'mid', pillar: 'combat', type: 'combat', difficulty: 'hard', monsters: [...], totalHP: 70, estimatedRounds: 4 },
    { position: 'late', pillar: 'exploration', type: 'puzzle', difficulty: 'hard', dc: 16 },
    { position: 'boss', pillar: 'combat', type: 'combat', difficulty: 'deadly', monsters: [...], totalHP: 120, estimatedRounds: 5 },
    { rest: 'long', reason: 'End of adventuring day' },
  ],
  summary: {
    totalEncounters: 6,
    combatEncounters: 3,
    socialEncounters: 1,
    explorationEncounters: 2,
    shortRests: 1,
    longRests: 1,
    estimatedPartyHPDrain: '65%',
    estimatedSlotUsage: '80%',
    pillarDistribution: { exploration: 33, combat: 50, social: 17 },
    pillarTarget: { exploration: 33, combat: 33, social: 34 },
  }
}
```

### Encounter Count by Ferocity

| Ferocity | Encounters/Day | Short Rests | Combat | Social | Exploration |
|----------|---------------|-------------|--------|--------|-------------|
| 1 (Deadly) | 6-8 | 2 | scaled by pillars | scaled | scaled |
| 2 (Dangerous) | 5-7 | 2 | scaled | scaled | scaled |
| 3 (Balanced) | 4-6 | 1-2 | scaled | scaled | scaled |
| 4 (Light) | 3-5 | 1 | scaled | scaled | scaled |
| 5 (Easy) | 2-4 | 1 | scaled | scaled | scaled |

The pillar percentages determine how many of each type. E.g., 6 encounters with 50% combat / 25% social / 25% exploration = 3 combat + 1-2 social + 1-2 exploration.

### Escalation Curve

Encounters within a day follow a tension curve:
- **Encounters 1-2:** Easy/Medium (warmup, resource-lite)
- **Encounters 3-4:** Medium/Hard (pressure building, resources draining)
- **Encounter 5+:** Hard/Deadly (climax, boss)
- **Short rest** inserted when estimated HP drain exceeds 40% or spell slots > 50% used
- **Long rest** after the boss or when estimated resources are > 80% depleted

### Rest Cadence

Short rests inserted based on:
1. Encounter count since last rest (ferocity-dependent threshold)
2. Estimated resource drain (HP + spell slots)
3. Narrative positioning (never mid-dungeon-room, always at natural break points)

---

## 4. Rolling DPR Tracker

Persistent per-character combat performance tracking.

### Data Structure (stored in game state)

```js
gs.combatHistory = {
  'character-name': {
    combats: [
      { date: timestamp, rounds: 4, damageDealt: 42, damageTaken: 18, healed: 12, spellSlotsUsed: 2 },
      { date: timestamp, rounds: 3, damageDealt: 35, damageTaken: 22, healed: 0, spellSlotsUsed: 1 },
      { date: timestamp, rounds: 5, damageDealt: 58, damageTaken: 31, healed: 8, spellSlotsUsed: 3 },
    ],
    rollingDPR: 12.4,        // weighted average
    rollingDamageTaken: 7.8,  // avg damage taken per round
    avgCombatLength: 4.0,     // avg rounds
  },
  // ... per character
}
```

### Collection

After each combat ends (`combatEngine.endCombat()`):
1. Parse `combatEngine.state.log` for all damage/healing events per PC
2. Calculate DPR = total damage dealt / rounds
3. Push to character's `combats` array (keep last 5, not 3 — more data = smoother average)
4. Recalculate rolling averages with weights [0.35, 0.25, 0.20, 0.12, 0.08]
5. Persist to DB via `db.setState(gameId, 'combatHistory', gs.combatHistory)`

### Usage

When the encounter designer needs party DPR:
1. Check `gs.combatHistory[name].rollingDPR` for each character
2. If no history exists (new character or first combat), use `estimateCharacterDPR(combatStats)`
3. Sum across party = partyDPR

---

## 5. Difficulty Self-Correction

Track actual outcomes vs predictions and adjust.

### Tracking

After each combat, record:
```js
{
  predicted: { rounds: 4, difficulty: 'medium' },
  actual: { rounds: 2, pcDeaths: 0, pcDowned: 1 },
  delta: { roundsDiff: -2, harderThanExpected: false }
}
```

### Correction

If actual outcomes consistently differ from predictions:
- If combats are shorter than predicted (party is stronger than estimated): increase monster HP budget by 10% per deviation
- If combats are longer (party is weaker): decrease budget by 10%
- Correction factor stored as `gs.difficultyCorrection` (starts at 1.0, adjusts ±0.1 per combat, capped at 0.5-2.0)
- Applied as a multiplier in `calculateMonsterHPBudget()`

---

## 6. Encounter Injection into AI Prompts

The adventuring day plan feeds into the AI's system prompt so it knows what's coming.

### When to Generate a Plan

1. **Game start** (dm_start): Generate first adventuring day plan
2. **After long rest**: Generate next adventuring day plan
3. **Host changes ferocity/pillars**: Regenerate remaining encounters in current day

### Prompt Injection

Add to system prompt when plan exists:

```
ENCOUNTER PLAN (current adventuring day):
You are on encounter 3 of 6. Next encounter should be: COMBAT (hard difficulty).
Monsters to use: 2x Bugbear, 4x Goblin (total ~75 HP).
After this encounter, offer a short rest opportunity.
Pillar progress: Combat 2/3, Social 0/1, Exploration 1/2.
```

The AI uses this as structured guidance rather than inventing encounters freely. It still narrates the transition and flavor, but the mechanical parameters (which monsters, how many, difficulty) come from the planner.

### ENEMIES Block Enhancement

When the AI introduces combat, it can now reference the plan's monster selection:
```
ENEMIES:
- Bugbear | 2 | bugbear
- Goblin | 4 | goblin
```

If the AI deviates from the plan (different monsters), the server can either accept it or inject the planned monsters instead.

---

## 7. Host Tab Interface

### Encounter Planner Panel (new section in Host tab)

**Current Day Overview:**
- Visual timeline showing planned encounters (icons for combat/social/exploration)
- Current position indicator (which encounter is active)
- Estimated difficulty rating per encounter
- Rest points marked

**Difficulty Adjustments:**
- "Make Next Encounter Harder/Easier" buttons (±20% budget)
- "Force Boss Encounter Next" toggle
- "Insert Rest Now" button
- "Skip to Boss" button (for short sessions)

**Party Stats Display:**
- Per-character DPR (rolling average or estimated)
- Total party DPR
- Party HP pool
- Resource estimate (spell slots remaining)

**Session Planning:**
- "How many encounters this session?" slider (overrides ferocity default)
- "Session length" estimate (helps calibrate encounter count)
- "Regenerate Day Plan" button

### Socket Events

| Event | Direction | Purpose |
|-------|-----------|---------|
| `encounter_plan_updated` | server → client | New/updated day plan |
| `encounter_progress` | server → client | Current encounter position |
| `adjust_difficulty` | client → server | Host adjusts next encounter |
| `force_boss` | client → server | Host forces boss encounter |
| `insert_rest` | client → server | Host inserts a rest |
| `regenerate_plan` | client → server | Host regenerates day plan |

---

## 8. Test Harness (No UI)

The module must be fully testable from the command line with no server or UI.

### Test Script: `test-encounter-designer.js`

```bash
node test-encounter-designer.js [scenario]
```

**Scenarios:**

1. **standard-party** — Level 5 Fighter/Cleric/Rogue/Wizard, ferocity 3
2. **low-level** — Level 1 party, ferocity 5 (easy)
3. **high-level** — Level 10 party, ferocity 1 (deadly)
4. **solo** — Single level 5 Fighter, ferocity 3
5. **custom** — Load party from a game ID in the DB
6. **random** — Generate random party via Haiku, test encounter design

**Output:**
```
Party DPR Analysis:
  Fighter: 14.2 DPR (longsword + Extra Attack)
  Cleric: 6.8 DPR (mace + Spiritual Weapon amortized)
  Rogue: 11.5 DPR (rapier + Sneak Attack)
  Wizard: 8.1 DPR (Fire Bolt cantrip + Fireball amortized)
  Total Party DPR: 40.6

Adventuring Day Plan (Ferocity 3, Pillars E33/C33/S34):
  1. [Exploration] Trapped corridor — DC 14, 2d10 damage
  2. [Combat] 3x Goblin + 1x Bugbear — 48 HP, est. 3 rounds
     → Short Rest opportunity
  3. [Social] Negotiation with captured scout — DC 14, 3-success challenge
  4. [Combat] 2x Dire Wolf + 4x Wolf — 72 HP, est. 4 rounds
     → Short Rest opportunity
  5. [Exploration] Ancient puzzle door — DC 15, 3-success challenge
  6. [Combat/Boss] 1x Young Green Dragon — 136 HP, est. 4 rounds
     → Long Rest

Summary:
  Combat encounters: 3 (50%) — target 33%
  Social encounters: 1 (17%) — target 34%
  Exploration encounters: 2 (33%) — target 33%
  Total monster HP: 256
  Estimated total rounds: 11
  Estimated party HP drain: 68%
  PC death probability: ~8% per day
```

### Unit Tests (node:test)

- `estimateCharacterDPR` for each class archetype
- `calculateMonsterHPBudget` for each ferocity level
- `calculateMonsterDPRBudget` for each ferocity level
- `designCombatEncounter` produces valid monster selections within budget
- `designAdventuringDay` produces correct encounter count, rest cadence, pillar distribution
- `updateRollingDPR` correctly weights recent combats
- `difficultyCorrection` adjusts after consistent over/under predictions
- Social/exploration DC scaling matches ferocity tables

---

## 9. File Map

### New Files
| File | Purpose |
|------|---------|
| `encounter-designer.js` | Core module: DPR calc, encounter design, day planning, difficulty correction |
| `tests/encounter-designer.test.js` | Unit tests |
| `test-encounter-designer.js` | CLI test harness (no UI) |

### Modified Files
| File | Changes |
|------|---------|
| `server.js` | Encounter plan generation on game start/long rest, prompt injection, rolling DPR collection after combat, host tab socket events |
| `public/game.html` | Encounter planner panel in host tab |
| `combat-engine.js` | Export combat summary data after endCombat for DPR tracking |
