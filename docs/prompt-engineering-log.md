# Prompt Engineering Decision Log

Historical record of prompt instructions — what was tried, why it was added, why it was kept or removed, and which model it applied to. Prevents re-trying failed approaches and preserves institutional knowledge across brainstorming sessions.

## How to Read This Document

Each entry follows this format:
- **Instruction**: What the prompt text said (paraphrased or quoted)
- **Model**: Which model this was written for
- **Added**: Why it was added (the problem it was solving)
- **Outcome**: Did it work? What happened?
- **Disposition**: Kept / Removed / Moved — and where it lives now
- **Lesson**: What future prompt engineers should know

---

## Format & Structure Instructions

### OUTPUT FORMAT block (SCENE/WORLD/ENEMIES/MAP/ACCOMPLISHMENTS/CHAR_UPDATES)

**Instruction**: ~200 tokens of exact format specification with field names, pipe-delimited examples, and "MANDATORY" warnings.

**Model**: Haiku (claude-haiku-4-5-20251001)

**Added**: The game client parses structured blocks from Claude's response to update UI (map, NPC portraits, combat engine, character sheets). Without exact format, parsing breaks.

**Outcome**: Haiku frequently drifted from format — omitting sections, reordering fields, inventing new field names, mixing prose into structured blocks. Adding "NEVER skip ANY of them" and "the game breaks" warnings helped ~60% of the time but consumed tokens every turn. The fundamental problem: asking Haiku to be a creative writer AND a structured data emitter in the same response is two conflicting objectives.

**Disposition**: REMOVED from narration prompt (2026-04-18 redesign). Structured extraction now handled by a dedicated Haiku call that receives the narration as input and outputs JSON. Haiku is excellent at extraction-from-text — it only fails when asked to generate creative text AND structure simultaneously.

**Lesson**: Never ask a model to switch between creative generation and structured data output in the same response. Split into separate calls where each call has one clear objective.

---

### "If you omit ---OPTIONS--- the game breaks" / "MANDATORY OUTPUT (every response, no exceptions)"

**Instruction**: Stern warnings that omitting structured blocks would break the game, repeated in multiple places.

**Model**: Haiku

**Added**: Haiku would frequently emit narration without OPTIONS, SCENE, or WORLD blocks, especially after 5+ turns. The warnings were escalated progressively — first polite, then CAPS, then "the game breaks."

**Outcome**: Marginal improvement. The warnings consumed ~40 tokens per turn. Haiku still omitted blocks ~30-40% of the time on trimmed prompts. A fallback API call to generate missing OPTIONS was added server-side (lines 1591-1611 in server.js), which itself cost another Haiku call.

**Disposition**: REMOVED. OPTIONS are now part of Sonnet's simple narration output (just "3 numbered choices" — trivially easy to comply with). SCENE/WORLD extracted by dedicated Haiku call. The fallback OPTIONS call can likely be removed too.

**Lesson**: If you need a fallback API call to patch failures from the primary call, the prompt is asking too much. Redesign the pipeline instead of adding safety nets.

---

### IMAGE DESCRIPTIONS (IMG: tag format in LOCATIONS and NPCS)

**Instruction**: ~80 tokens explaining IMG: tag format for first appearances, UPDATED: prefix for changes, "only on first appearance" rule.

**Model**: Haiku

**Added**: Client triggers Together AI image generation when IMG: tags appear. Needed Claude to decide when a visual was new/changed and provide a one-sentence description.

**Outcome**: Worked reasonably well on turn 1. On trimmed prompts, Haiku would either: (a) include IMG: on every mention (wasting image generation credits), or (b) never include IMG: at all. The "only on first appearance" nuance was too subtle for Haiku to track consistently.

**Disposition**: MOVED to Haiku extraction call (Call 2). The extraction call receives narration + current world state (which NPCs/locations already have images). It can make a clean binary decision: "is this entity new? → generate IMG prompt." Server-side logic is more reliable than prompt-based logic for stateful decisions.

**Lesson**: Don't ask the model to track state across turns via instructions. If the decision depends on "has this been seen before," that's a server-side lookup, not a prompt constraint.

---

## Combat Instructions

### COMBAT — CRITICAL RULES (full block)

**Instruction**: ~120 tokens: "The SERVER runs all combat mechanics. You do NOT roll dice, track HP, or resolve attacks. [...] Narrate RESOLVED THIS ROUND results ONLY."

**Model**: Haiku

**Added**: Before the combat engine existed, Claude would invent dice rolls, make up damage numbers, and hallucinate HP values. The combat engine was built to fix this, but Claude still needed to be told not to override the engine's results.

**Outcome**: Mostly worked — Haiku generally respected the "narrate results only" constraint when combat context was injected. Occasional drift where Haiku would add extra attacks or invent saving throws not in the resolved results. The real fix was the combat engine, not the prompt.

**Disposition**: REMOVED from narration prompt. In the new architecture, combat turns don't go to Sonnet at all — server assembles narration from monster templates. Sonnet only handles combat-start scenes, killshots, and combat-end aftermath (where it doesn't need mechanical constraints because there are no mechanics to get wrong).

**Lesson**: The best prompt constraint is one that doesn't exist because the architecture makes the failure impossible. The combat engine succeeded not because the prompt was better, but because the server owned the mechanics.

---

### ENEMIES block format

**Instruction**: ~60 tokens: exact pipe-delimited format with example (`Goblin Archer | 2 | goblin`).

**Model**: Haiku

**Added**: Server parses ENEMIES block to initialize the combat engine. Format must be exact or parsing fails and combat doesn't start.

**Outcome**: Haiku would frequently: (a) omit ENEMIES entirely when narrating hostile encounters, (b) use wrong format ("2x Goblin Archers" instead of pipe-delimited), (c) invent slugs not in the monster DB. An auto-combat injection system was built to detect combat narration without ENEMIES and inject from the encounter plan. This worked but added complexity.

**Disposition**: REMOVED. Sonnet narrates "three goblins emerge from the shadows, bows drawn." Haiku extraction call (Call 2) identifies enemy references and matches them to monster DB slugs. Server starts combat from structured JSON, not parsed text blocks.

**Lesson**: Asking a creative writing model to emit machine-parseable data inline with prose is fragile by design. Extract structure from text after generation — don't try to co-generate structure and prose.

---

### Dice format ("ONE bold line per roll: **🎲 Fire Bolt (INT +2) — rolls 19. HIT!**")

**Instruction**: ~80 tokens specifying exact dice notation format with emoji, roll breakdown, HIT/MISS caps, and HP display.

**Model**: Haiku

**Added**: Client parses bold dice lines to color-code hits green and misses red. Exact format needed for regex matching.

**Outcome**: Format compliance was inconsistent. Haiku would sometimes use the format, sometimes write plain prose about attacks. When it did use the format, it would invent roll numbers that contradicted the combat engine's actual results. This was a symptom of the larger problem: asking Haiku to narrate AND format simultaneously.

**Disposition**: REMOVED. Combat narration now uses server-side templates that embed the exact dice results from the combat engine. Format is guaranteed correct because it's a template, not generated text.

**Lesson**: If you need guaranteed format compliance for client-side parsing, use templates, not generation. LLMs are probabilistic — templates are deterministic.

---

## Game Rules & Mechanics Instructions

### Resource Tracking Details (spell slots, HP, hit dice, consumable magic items)

**Instruction**: ~60 tokens covering what to track, what not to track ("do NOT track mundane items like arrows, rations, torches").

**Model**: Haiku

**Added**: Without explicit instructions, Haiku would either: (a) ignore resource depletion entirely, or (b) obsessively track mundane items ("you use one of your 47 remaining arrows").

**Outcome**: Helped somewhat on turn 1 with full prompt. On trimmed prompts, resource tracking disappeared almost entirely. Haiku would narrate spell casting without noting slot expenditure, or allow characters to cast spells they'd already used.

**Disposition**: MOVED to rules compliance check (Call 3). Server tracks actual resource state. After Sonnet narrates, Haiku Call 3 checks: "did the narration imply casting a spell? Does the character have slots remaining?" Violations get corrected next turn.

**Lesson**: Resource tracking is a stateful bookkeeping problem. Models lose state across turns. Server-side tracking with post-hoc validation is more reliable than hoping the model remembers.

---

### Rest Mechanics (when to offer rests, consequences, recovery details)

**Instruction**: ~80 tokens covering proactive rest offers, player-requested rests with consequences, narrative rests.

**Model**: Haiku

**Added**: Haiku would either never offer rests (party dies of attrition) or offer rests constantly (no resource tension).

**Outcome**: Moderate improvement with full prompt. On trimmed prompts, Haiku defaulted to never offering rests. The encounter designer's pacing system partially compensated by scheduling rest encounters.

**Disposition**: MOVED to rules compliance check (Call 3). The encounter plan already schedules rest points. Call 3 checks if the party is past the scheduled rest point and flags it. Server can inject "The party looks exhausted — they could rest here" into the next prompt context.

**Lesson**: Pacing decisions that depend on counting turns/encounters belong in server logic (encounter designer), not model prompts. The model should respond to pacing cues, not generate them.

---

### Advancement / Level-Up Specifics (XP awards, milestone triggers, ASI/subclass/feat choices)

**Instruction**: ~100 tokens covering when to award XP, how to announce level-ups, pausing for player choices.

**Model**: Haiku

**Added**: Haiku would auto-assign ability score improvements and subclass choices without asking the player. Also sometimes announced level-ups at wrong XP thresholds.

**Outcome**: Mixed. The "PAUSE and ask the player" instruction worked when present in the full prompt. On trimmed prompts, Haiku would skip the pause and auto-assign. Server-side XP tracking was added but the prompt instructions remained as a belt-and-suspenders approach.

**Disposition**: MOVED to rules compliance check (Call 3). Server owns XP tracking and detects level-up thresholds. When a level-up occurs, server injects a structured choice prompt — not relying on the model to remember the advancement rules.

**Lesson**: "Pause and ask the player for their choice" is a UX flow, not a narrative instruction. UX flows should be server-driven with explicit state machines, not prompt-hoped.

---

### Treasure Scaling Tables (by ferocity level)

**Instruction**: ~80 tokens mapping ferocity 1-5 to treasure generosity ("rare magic items" vs "mostly coins").

**Model**: Haiku

**Added**: Without guidance, Haiku would either shower the party with magic items or never give treasure.

**Outcome**: Worked reasonably on full prompt. On trimmed prompts (which only had a 1-line ferocity summary), treasure calibration was lost. Not a critical failure — treasure is flavor, not mechanics.

**Disposition**: MOVED to rules compliance check (Call 3). Sonnet gets a short ferocity description for tone ("this is a deadly, high-reward adventure"). Call 3 flags if treasure awards seem wildly off-scale.

**Lesson**: Calibration tables are reference data, not creative instructions. Models don't internalize tables — they need them present at inference time. If the table can't fit in the trimmed prompt, move the calibration to a validation layer.

---

### Encounter Pacing & Resource Tables (encounters per rest, escalation curves)

**Instruction**: ~100 tokens of pacing rules per ferocity level (encounters per short rest, long rest timing, escalation pattern).

**Model**: Haiku

**Added**: Without pacing guidance, Haiku would throw combat encounters back-to-back with no rest or pacing variety.

**Outcome**: Partially effective. The encounter designer was built to solve this problem architecturally (scheduling encounters, rests, and pillar distribution). The prompt instructions became redundant once the encounter plan was injected.

**Disposition**: REMOVED (redundant). The encounter designer now owns pacing. Sonnet receives "Next: COMBAT encounter" or "Next: SOCIAL encounter" from the plan — it doesn't need to understand the pacing algorithm.

**Lesson**: If you've built a system to solve a problem, remove the prompt instructions that were the earlier band-aid for the same problem. Redundant instructions waste tokens and can conflict with the system's actual output.

---

### System Adaptation (D&D 5e vs RuneQuest vs Custom specifics)

**Instruction**: ~40 tokens per system adapting terminology and mechanics.

**Model**: Haiku

**Added**: RuneQuest uses different terminology (scenes vs encounters, Strike Ranks vs Initiative, Rune Points vs spell slots). Without adaptation, Haiku would use D&D terms in RuneQuest games.

**Outcome**: Worked well — Haiku respected system-specific terminology when told. Low token cost.

**Disposition**: KEPT in Sonnet's prompt (condensed to 1-2 lines). System-specific flavor affects narration ("the shaman channels her Rune magic" vs "the wizard prepares a spell slot"). This is creative context, not mechanical tracking.

**Lesson**: Terminology/flavor adaptation is a legitimate prompt instruction — it's creative guidance that belongs in the narration prompt. Don't over-remove.

---

## Style & Tone Instructions

### Verbosity Limits ("TERSE: 50 words max, 3 sentences")

**Instruction**: ~30 tokens per verbosity level with word count and sentence count.

**Model**: Haiku

**Added**: Without limits, Haiku would write 200-400 word responses regardless of setting. Even "terse" mode produced ~273 words in testing (2026-04-14).

**Outcome**: FAILED on Haiku. Even with "RULE #1 — WORD LIMIT (overrides ALL other instructions)" and "Count your narration words" — Haiku consistently exceeded limits. Temperature reduction to 0.3 in terse mode helped marginally. The word count problem was never fully solved on Haiku.

**Disposition**: KEPT in Sonnet's prompt. Sonnet is significantly better at following quantitative constraints. The simplified prompt (no structured blocks to emit) also helps — Haiku was spending its "compliance budget" on format and had nothing left for word limits.

**Lesson**: Haiku has a hard ceiling on simultaneous constraint compliance. Word limits compete with format compliance, rules compliance, and persona maintenance. Reducing the total constraint count is more effective than making any single constraint more emphatic. Sonnet with fewer constraints > Haiku with many constraints.

---

### Persona Blocks (Epic vs Over the Top)

**Instruction**: ~80 tokens (full) or ~30 tokens (trimmed) defining DM voice and style.

**Model**: Haiku / Sonnet

**Added**: Core creative identity of the DM. Without it, responses are generic and interchangeable.

**Outcome**: Worked well on both models. Persona is the kind of instruction LLMs are naturally good at — it's a style guide, not a constraint.

**Disposition**: KEPT in Sonnet's prompt. This is narration DNA — always present.

**Lesson**: Personas are the highest-ROI prompt instruction. Models internalize voice/tone much better than rules or format. Invest tokens here.

---

### "Write narration as flowing prose PARAGRAPHS. No markdown headers."

**Instruction**: ~30 tokens banning markdown headers and one-sentence-per-line formatting.

**Model**: Haiku

**Added**: Haiku would output narration with `## Combat Round 3` headers and bullet-pointed prose, which looked terrible in the game UI.

**Outcome**: Mostly worked. Occasional header slippage but manageable.

**Disposition**: KEPT (condensed). One line in Sonnet's prompt: "Write prose paragraphs. No markdown headers." Sonnet is less prone to this but the instruction is cheap insurance.

**Lesson**: Format bans ("don't do X") work better than format prescriptions ("use exactly this format") because they're simpler to comply with.

---

### "Be mechanically accurate — a cantrip is a simple attack, not an explosion"

**Instruction**: ~25 tokens calibrating narration scale to actual spell/ability power level.

**Model**: Haiku

**Added**: Haiku would describe a level 1 Fire Bolt as "a massive explosion of arcane flame that engulfs the entire room" — dramatic but mechanically absurd.

**Outcome**: Improved calibration but not eliminated. Haiku still occasionally over-dramatized low-level actions.

**Disposition**: KEPT in Sonnet's prompt. This is narration quality guidance — exactly what the creative model should have.

**Lesson**: Scale calibration is a legitimate creative instruction. Models default to cinematic escalation; grounding them improves immersion.

---

## Interaction & Behavioral Instructions

### Skill Check Pacing ("include a skill check every 1-2 actions")

**Instruction**: ~40 tokens requiring regular mechanical interaction.

**Model**: Haiku

**Added**: Without this, Haiku would narrate long stretches of pure storytelling with no dice rolls, skill checks, or mechanical engagement. Players felt like they were reading a novel, not playing a game.

**Outcome**: Partially effective. Haiku increased check frequency but would sometimes front-load 3 checks in one turn then go 5 turns without any.

**Disposition**: KEPT in Sonnet's prompt. This is a core gameplay rhythm instruction. Also validated by Call 3 (rules check) which flags if 2+ turns pass without a mechanical trigger.

**Lesson**: Pacing rhythm is partly a creative instruction (Sonnet) and partly a validation rule (Call 3). Both layers help.

---

### NPC Memory / Recurring NPCs

**Instruction**: Variable tokens listing NPCs with encounter history and "reference past encounters, evolve behavior."

**Model**: Haiku

**Added**: Without NPC memory, returning enemies would act like strangers. The goblin chief who escaped three sessions ago wouldn't remember the party.

**Outcome**: Worked when present in prompt. Information was correctly utilized. The issue was only that trimmed prompts cut NPC memory to save tokens.

**Disposition**: KEPT in Sonnet's prompt. Narrative continuity is a creative strength — give Sonnet the context and it will use it well.

**Lesson**: Context-as-instruction (providing facts for the model to work with) is different from rules-as-instruction (telling the model what to do). Models handle context much more reliably than rules.

---

### Catchphrases ("use sparingly, max 1-2 per real-world day")

**Instruction**: ~15 tokens per character with catchphrases listed.

**Model**: Haiku

**Added**: Players wanted their characters to have signature lines. Without the "sparingly" constraint, Haiku would use catchphrases every single turn.

**Outcome**: The "sparingly" constraint was hard for Haiku to calibrate. It either used catchphrases every turn or never. Frequency tracking is a stateful problem models can't solve.

**Disposition**: KEPT in Sonnet's prompt with "use sparingly" note. Server-side frequency tracking could be added later (Call 3 could flag overuse), but it's low priority.

**Lesson**: "Use sparingly" is vague — models can't count across turns. If precise frequency matters, track it server-side.

---

### "Encourage banter between PCs and NPCs"

**Instruction**: ~30 tokens encouraging dialogue and NPC personality.

**Model**: Haiku

**Added**: Without it, Haiku would narrate in third person without dialogue, making the world feel dead.

**Outcome**: Worked well. One of the cheaper, higher-ROI instructions.

**Disposition**: KEPT (implicitly via persona block). The Epic and Over the Top personas both emphasize NPC personality. A separate instruction is redundant with a good persona.

**Lesson**: If the persona already implies a behavior, you don't need a separate instruction for it. Audit for redundancy.

---

## Meta-Pattern: What Works vs. What Fails in Prompts

### Instructions that WORK on small models (Haiku):
- Personas and voice/tone guidance
- Simple format bans ("no markdown headers")
- Context injection (facts, NPC history, story summaries)
- Single-objective tasks ("extract JSON from this text")

### Instructions that FAIL on small models (Haiku):
- Multi-section structured output in creative responses
- Quantitative limits (word counts, frequency caps)
- Stateful tracking across turns (resources, visit counts)
- Multiple competing constraints in one call
- "NEVER do X" combined with "ALWAYS do Y" — compliance with one degrades the other

### Architectural principle (2026-04-18):
**One call, one objective.** If a call needs to be creative, don't also ask it to be structured. If it needs to be structured, don't also ask it to be creative. Split the pipeline.
