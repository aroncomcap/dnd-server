'use strict';

const templateEngine = require('./template-engine');
const { formatPlanForPrompt } = require('./encounter-designer');
const llm = require('./llm');
const { worldExtractionSchema, validationSchema } = require('./llm/schemas/world-extraction');
const { isDialogueAction, isAdvanceAction, isExplicitHostileAction } = require('./action-parser');
const { cleanInvalidCombatNarration } = require('./narration-sanitizer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERBOSITY_RULES = {
  verbose: 'Write ~100 words of narration. Vivid detail and atmosphere.',
  brief:   'BRIEF MODE — HARD LIMIT: 75 words max narration. 4-5 sentences. Punchy and direct.',
  terse:   'TERSE MODE — ABSOLUTE LIMIT: 50 words max. 3 sentences max. No atmosphere, no descriptions, no internal thoughts. State what happens mechanically. Count your words. If you write more than 50 words, you have failed.',
};

const STORY_MOMENTUM_RULES = [
  'Every non-combat response must materially change the situation: location, clue, NPC stance, danger, cost, route, or decision.',
  'Maintain one active named lead, contact, or destination until the party reaches, resolves, or clearly loses it.',
  'If you need a twist, twist the current lead instead of inventing a replacement contact, route, or destination.',
  'Begin each response after the latest DM message. Do not reproduce or paraphrase any full sentence from recent history.',
  'Do not end a response by only pointing to the next lead; pay known leads off as arrival, confrontation, revelation, cost, or hard choice.',
  'A strong non-combat turn has payoff, pressure, and personality: show what changes, why it matters, and who reacts.',
  'Confront/demand answers is social unless explicit attack/damaging spell.',
  'Never repeat a prior clue as the main event; recap old evidence in one short phrase, then show the new consequence.',
  'For travel, progress, acknowledgement, and "move on" actions, move the party to the next concrete place, person, clue, or decision in this response.',
  'Minor routing/social scenes have a two-response ceiling: establish the lead, then reveal, resolve, complicate, or leave. Do not chain clerks, permits, ledgers, or corridors.',
  'If recent history already ended with "the next lead is ahead/one room away/waiting there", the next progress action must consume that lead now instead of restating that it is close.',
  'Never answer progress with only cautious movement and no new information. If the party checks for danger and there is no meaningful hazard, compress the caution and advance the scene.',
  'Do not repeat the same beat from recent turns. If recent narration already covered scouting, watching flanks, checking traps, or a clear path, switch to arrival, discovery, dialogue, consequence, or choice.',
  'Merchant, guard, checkpoint, and passerby scenes are brief routing/social beats unless the player clearly chooses violence or a hard failure forces initiative.',
  'Make utilitarian hooks matter by the second response: expose motive, secret, threat, personality, or cost.',
].join('\n- ');

const OPTION_QUALITY_RULES = [
  'Each option must change the situation; avoid options that merely maintain safety, watch a flank, wait, or re-check the same path.',
  'Offer one direct advance option, one interaction/investigation option, and one bold or risky option tied to the current scene.',
  'Name the current lead, NPC, location, clue, or visible danger when possible. Specific options beat generic verbs.',
  'Avoid "inspect/search/scout ahead" unless a specific unresolved hazard, clue, or mystery is visible right now.',
  'In social or travel scenes, options should favor dialogue, leverage, route choice, discovery, or decisive movement over combat defaults.',
].join('\n- ');

const FALLBACK_OPTIONS = [
  'Advance to the next clear lead',
  'Ask one pointed question about the current clue',
  'Take a bold risk that changes the situation',
];

const STRUCTURED_MARKER_PATTERN = String.raw`(?:-{3,}\s*(OPTIONS|SCENE|WORLD)\s*-{3,}?|#{1,3}\s*(OPTIONS?|SCENE|WORLD)\s*(?=\n|$))`;
const STREAM_MARKER_LOOKAHEAD = 60;

function hasHardCombatSignal(text) {
  const value = String(text || '').replace(/\b(?:not|no|never|without|isn't|wasn't|weren't)\s+(?:an?\s+)?(?:ambush|attack|fight|combat|trap|hostility|hostile)\b/gi, '');
  return /(?:roll(?:s|ing)?\s+(?:for\s+)?initiative|initiative.*(?:order|roll)|combat\s+(?:begins|starts|erupts|breaks out)|(?:goblin|orc|skeleton|zombie|wolf|rat|bandit|dragon|spider|kobold|gnoll|bugbear|hobgoblin|cultist|thug|guard|knight|wraith|ghoul|ghast|wight|vampire|demon|devil|elemental|giant|minotaur|owlbear|manticore|hydra|chimera|basilisk|beholder|lich|golem|treant|werewolf)s?\s+(?:attack|attacks|lunge|lunges|charge|charges|rush|rushes|swing|swings|slash|slashes|stab|stabs|strike|strikes|pounce|pounces|ambush|ambushes)\b|(?:attacks?\s+(?:you|the party|with)|charges?\s+(?:at|toward|into)|ambush(?:ed|es)?!?|lunges?\s+(?:at|toward)|strikes?\s+(?:at|with)|draws?\s+(?:its |their )?(?:sword|weapon|blade|axe|bow)|weapons?\s+drawn|swords?\s+(?:raised|drawn|flashing)|prepare(?:s)?\s+to\s+(?:fight|attack|strike)|openly\s+hostile|turns?\s+hostile|ready\s+(?:their|your)\s+weapons?))/i.test(value);
}

function createStructuredMarkerRegex(flags) {
  return new RegExp(STRUCTURED_MARKER_PATTERN, flags);
}

function buildFallbackTurn(characterName, actionText) {
  const rawActor = String(characterName || '').trim();
  const actor = rawActor && rawActor !== 'Unknown' && rawActor.length <= 40 && !/[.!?]/.test(rawActor)
    ? rawActor
    : 'The story';
  const action = String(actionText || '')
    .replace(/\[AUTO-ACTION[^\]]*\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const verb = actor === 'The story' ? 'moves forward' : 'follows through';
  const actionClause = action
    ? ` ${verb}: ${action}`
    : ' takes a cautious step forward';

  return {
    narration: `${actor}${actionClause}. The scene stays tense but playable as the party keeps its footing and watches for the next opening.`,
    options: [...FALLBACK_OPTIONS],
  };
}

function buildAntiStallPacingDirective(history, actionText) {
  const assistantMessages = (history || [])
    .filter(msg => msg?.role === 'assistant' && msg.content)
    .map(msg => String(msg.content).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-4);
  if (assistantMessages.length < 2) return '';

  const action = String(actionText || '');
  const playerIsTryingToMoveScene =
    isAdvanceAction(action) ||
    isDialogueAction(action) ||
    /\b(?:follow|continue|proceed|press on|move on|head|travel|enter|approach|leave|ask|explain|state|offer|cooperate|lead|objective|inspect|search|investigate|look|study|examine|check|trace|track)\b/i.test(action);
  if (!playerIsTryingToMoveScene) return '';

  const recent = assistantMessages.join(' ').toLowerCase();
  const stallSignals = [
    /\b(?:next|clear)\s+(?:lead|objective|proof|decision|place)\b/,
    /\b(?:one\s+(?:room|door)|door\s+away|room\s+away|waiting\s+(?:there|ahead|beyond)|waits?|bracing|ahead)\b/,
    /\b(?:points?|leads?|go(?:es)?)\s+(?:toward|to|back)\b/,
    /\b(?:clerk|guild|ledger|permit|docket|seal|factor|counting\s+room|warehouse|countinghouse)\b/,
    /\b(?:dockmaster|dock|quay|shipment|cargo|crate|manifest|freight|berth|shutter)\b/,
  ];
  const signalCount = stallSignals.reduce((count, pattern) => count + (pattern.test(recent) ? 1 : 0), 0);
  if (signalCount < 2) return '';

  return `[ANTI-STALL PACING]
Recent DM turns already established the current lead, destination, permission step, or document trail. If the player repeats non-hostile social, search, or progress intent, treat it as consent to proceed. Do not narrate another transition, reminder, reluctance, or "it is ahead/one door away" beat. Resolve or complicate it NOW in this response: change the physical location, arrive inside, reveal the proof, confront the responsible NPC, introduce immediate danger, extract a cost, or close the minor routing scene and move to the next materially different scene. Do not end this response by only naming another lead. This turn needs payoff, pressure, or a hard choice: put someone named on stage, expose motive, force a cost, start a valid threat, or close the objective. This objective has consumed several turns; if an accountable NPC, culprit, cache, handoff, or named place is visible, resolve or climax it now rather than adding another intermediary. Forbidden endings: "the next move is clear", "one more door", "the lead points to", "reach X before Y", or a newly named contact with no immediate payoff. If this is a merchant/guild/clerk/permit/ledger scene and the player is cooperating or following the lead, wrap the scene up instead of adding another clerk or document.`;
}

function normalizeBareNarration(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .trim()
    .toLowerCase();
}

function isLowInformationNarration(narration, actionText = '') {
  const normalized = normalizeBareNarration(narration);
  if (!normalized) return true;

  const action = normalizeBareNarration(actionText);
  if (action && normalized === action) return true;

  return FALLBACK_OPTIONS
    .map(normalizeBareNarration)
    .includes(normalized);
}

const FEROCITY_LABELS = {
  1: 'Deadly (lethal, every encounter is life-threatening)',
  2: 'Dangerous (tough fights, meaningful consequences)',
  3: 'Balanced (challenging but fair)',
  4: 'Light (manageable encounters, low death risk)',
  5: 'Easy (heroic power fantasy, minimal threat)',
};

const PERSONA_BLOCKS = {
  epic: `You are an EPIC Dungeon Master: dramatic, grounded, and atmospheric. Use tight evocative prose, real stakes, specific consequences, and never break character.`,

  over_the_top: `You are an OVER THE TOP Dungeon Master: comedic, chaotic, and full of Critical Role energy. Give NPCs vivid quirks, let humor emerge from stakes, and keep choices consequential.`,
};

function formatResolvedCombatState(lastCombatConclusion) {
  if (!lastCombatConclusion) return '';

  const defeated = Array.isArray(lastCombatConclusion.defeated)
    ? lastCombatConclusion.defeated.filter(Boolean)
    : [];
  const reason = lastCombatConclusion.reason || 'resolved';
  const summary = lastCombatConclusion.summary || '';
  const defeatedLine = defeated.length > 0
    ? `Defeated opponents: ${defeated.join(', ')}.`
    : '';

  return [
    `=== RESOLVED COMBAT STATE ===`,
    `Last combat result: ${reason}.`,
    defeatedLine,
    summary ? `Outcome: ${summary}` : '',
    `This outcome is permanent story state: defeated opponents are already defeated. Do not revive them, restart the same fight, or make them attack again unless the current player explicitly causes that reversal.`,
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// buildNarrationPrompt
// ---------------------------------------------------------------------------

/**
 * Build ~800 token model system prompt.
 * Includes: persona, characters (no stat blocks), story summary,
 * campaign material, house rules, NPC memory, encounter guidance,
 * ferocity, pillars, verbosity rules.
 */
function buildNarrationPrompt(gameId, gameConfig, gs) {
  const persona = gameConfig.dmPersona || 'epic';
  const personaBlock = PERSONA_BLOCKS[persona] || PERSONA_BLOCKS.epic;

  // Character block — names/personalities only, NO stat blocks
  // Accept either gs.characters (array of { name, data }) or gs.data.characters (dict of { [name]: charData })
  let characters = (gs.characters || []);
  if (characters.length === 0 && gs.data && gs.data.characters && typeof gs.data.characters === 'object') {
    characters = Object.entries(gs.data.characters).map(([name, charData]) => ({ name, data: charData }));
  }
  const charLines = characters.map(ch => {
    const d = ch.data || {};
    const firstSentenceOfBackstory = d.backstory
      ? (d.backstory.split(/[.!?]/)[0] || '').trim()
      : '';
    const catchphrases = Array.isArray(d.catchphrases) && d.catchphrases.length > 0
      ? `Catchphrases: "${d.catchphrases.join('", "')}".`
      : '';
    const standardActions = Array.isArray(d.standardActions)
      ? (d.standardActions.length > 0 ? `Typical actions: ${d.standardActions.join(', ')}.` : '')
      : (typeof d.standardActions === 'string' && d.standardActions
          ? `Typical actions: ${d.standardActions}.`
          : '');
    return [
      `  - ${ch.name} (${d.class || 'Adventurer'} ${d.level || 1})`,
      d.personality ? `    Personality: ${d.personality}` : '',
      firstSentenceOfBackstory ? `    Background: ${firstSentenceOfBackstory}.` : '',
      catchphrases ? `    ${catchphrases}` : '',
      standardActions ? `    ${standardActions}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n');

  // NPC memory (up to 5)
  const npcs = gs.world?.npcs ? Object.values(gs.world.npcs) : [];
  const npcLines = npcs.slice(0, 5).map(npc =>
    `  - ${npc.name}: ${npc.personality || 'unknown'}${npc.lastSeen ? ` (last seen: ${npc.lastSeen})` : ''}`
  ).join('\n');

  // Campaign source material (capped at 50000 chars)
  const rawContext = gameConfig.custom_context || '';
  const campaignMaterial = rawContext.length > 50000
    ? rawContext.slice(0, 50000) + '\n[... truncated for length ...]'
    : rawContext;

  // House rules
  const houseRules = gameConfig.house_rules || '';

  // Story summary
  const storySummary = gs.storySummary || '';
  const resolvedCombatState = formatResolvedCombatState(gs.lastCombatConclusion);

  // Encounter plan
  let encounterGuidance = '';
  if (gs.encounterPlan) {
    try {
      encounterGuidance = formatPlanForPrompt(gs.encounterPlan, gs.encounterPlanIndex || 0);
    } catch (err) {
      encounterGuidance = '';
    }
  }
  if (gs._encounterPacingDirective) {
    encounterGuidance += `${encounterGuidance ? '\n' : ''}${gs._encounterPacingDirective}`;
  }

  // Ferocity
  const ferocity = gs.ferocity || 3;
  const ferocityDesc = FEROCITY_LABELS[ferocity] || FEROCITY_LABELS[3];

  // Pillars
  const pillars = gs.pillars || {};
  const pillarsLine = `Combat ${pillars.combat || 33}% / Exploration ${pillars.exploration || 33}% / Social ${pillars.social || 33}%`;

  // Verbosity
  const verbosity = gs.verbosity || 'brief';
  const verbosityRule = VERBOSITY_RULES[verbosity] || VERBOSITY_RULES.brief;

  const sections = [
    `=== DM PERSONA ===`,
    personaBlock,
    '',
    `=== CAMPAIGN ===`,
    `Game: ${gameConfig.name || 'Untitled'}`,
    `System: ${gameConfig.system || 'dnd5e'}`,
    '',
    characters.length > 0 ? `=== PLAYER CHARACTERS ===\n${charLines}` : '',
    '',
    npcs.length > 0 ? `=== NPC MEMORY (recent) ===\n${npcLines}` : '',
    '',
    storySummary ? `=== STORY SO FAR ===\n${storySummary}` : '',
    '',
    resolvedCombatState,
    '',
    campaignMaterial ? `=== CAMPAIGN SOURCE MATERIAL ===\n${campaignMaterial}` : '',
    '',
    houseRules ? `=== HOUSE RULES ===\n${houseRules}` : '',
    '',
    encounterGuidance ? `=== ENCOUNTER GUIDANCE ===\n${encounterGuidance}` : '',
    '',
    `=== DIFFICULTY ===`,
    `Ferocity ${ferocity}: ${ferocityDesc}`,
    `Pillars: ${pillarsLine}`,
    '',
    `=== STORY MOMENTUM ===`,
    `- ${STORY_MOMENTUM_RULES}`,
    '',
    `=== OPTION QUALITY ===`,
    `- ${OPTION_QUALITY_RULES}`,
    '',
    `=== NARRATION RULES ===`,
    `CRITICAL: Your narration MUST directly acknowledge and respond to the player's action. Show what happens as a direct consequence of their choice. Do not ignore or bypass their action — make it clear their decision matters and shapes the world.`,
    `VERBOSITY: ${verbosityRule}`,
    ``,
    `Always end your response with exactly 3 numbered player options using this format:`,
    `1️⃣ [option one]`,
    `2️⃣ [option two]`,
    `3️⃣ [option three]`,
    `Do not use markdown headers (##, ###) in narration. Never roll dice yourself — all dice outcomes are resolved by the server. Never mention HP numbers, AC, or stat blocks. Never break character as DM.`,
  ].filter(s => s !== null && s !== undefined).join('\n');

  return sections;
}

// ---------------------------------------------------------------------------
// buildUserMessage
// ---------------------------------------------------------------------------

/**
 * Build user message with corrections injection + chat history + player action.
 * Consumes (clears) gs.pendingCorrections.
 */
function buildUserMessage(gs, characterName, actionText) {
  const parts = [];

  // Inject corrections if present, then clear them
  const corrections = gs.pendingCorrections || [];
  if (corrections.length > 0) {
    // Corrections may be stored as strings (key/message format) or objects (type/description/correction format)
    const correctionTexts = corrections.map(c =>
      typeof c === 'string' ? c : (c.correction || c.description || JSON.stringify(c))
    );
    parts.push(`[DM CORRECTIONS — apply immediately and silently:\n${correctionTexts.map((c, i) => `${i + 1}. ${c}`).join('\n')}]`);
    gs.pendingCorrections = [];
  }

  // Chat history
  const topLevelHistory = Array.isArray(gs.chatHistory) ? gs.chatHistory : [];
  const dataHistory = Array.isArray(gs.data?.chatHistory) ? gs.data.chatHistory : [];
  const history = topLevelHistory.length ? topLevelHistory : dataHistory;
  if (history.length > 0) {
    const historyLines = history.map(msg => {
      const role = msg.role === 'assistant' ? 'DM' : (msg.name || characterName || 'Player');
      return `${role}: ${msg.content}`;
    });
    parts.push(`[RECENT HISTORY]\n${historyLines.join('\n')}`);

    const antiStallDirective = buildAntiStallPacingDirective(history, actionText);
    if (antiStallDirective) {
      parts.push(antiStallDirective);
      parts.push(`[INTERPRETED INTENT]\nThe party proceeds to the current named lead now. If a destination, contact, room, or visible threat has already been named, cut directly to it and show the immediate consequence.`);
    }
  }

  const resolvedCombatState = formatResolvedCombatState(gs.lastCombatConclusion);
  if (resolvedCombatState) {
    parts.push(`[${resolvedCombatState}]`);
  }

  // Player action with system override instruction
  const systemOverride = `CRITICAL: The player has chosen an action below. You MUST narrate ONLY what happens as a direct consequence of that choice. Begin after the latest DM message. Do not reproduce or paraphrase any full sentence from RECENT HISTORY. If the player's action overlaps with a recent beat, compress the overlap and reveal the next new consequence, discovery, NPC reaction, cost, or decision. Do not repeat previous narrations or generic descriptions. Treat RECENT HISTORY as binding continuity: keep the same named lead, contact, or destination until the party reaches, resolves, or clearly loses it.\n\n`;
  parts.push(systemOverride);
  parts.push(`PLAYER ACTION: ${characterName} chooses: ${actionText}`);
  parts.push(`\nRespond directly. Narrate what happens because of this choice ONLY.`);

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// buildExtractionPrompt
// ---------------------------------------------------------------------------

/**
 * structured model extraction prompt for world state changes.
 */
function buildExtractionPrompt(narration, actionText, worldState) {
  return `You are a world state extractor for a tabletop RPG game. Given the DM narration and player action, extract any changes to the world state.

PLAYER ACTION:
${actionText}

DM NARRATION:
${narration}

CURRENT WORLD STATE:
${JSON.stringify(worldState, null, 2)}

Extract changes as JSON with this structure:
{
  "scene": {"action": "5-10 word summary", "mood": "1-3 words", "npc": "name or null"},
  "locations": [{"name": "...", "description": "...", "distance": "...", "isNew": true, "img": "one sentence visual or null"}],
  "npcs": [{"name": "...", "description": "...", "location": "...", "isNew": true, "img": "one sentence visual or null"}],
  "enemies": [{"displayName": "...", "count": 1, "slug": "monster-db-slug"}],
  "map": "current location name",
  "accomplishments": [{"character": "...", "achievement": "..."}],
  "charUpdates": [{"character": "...", "field": "statsText|personality|backstory|standardActions", "value": "..."}]
}

Rules:
- "isNew" = true ONLY if entity does NOT appear in CURRENT WORLD STATE
- "img" ONLY for isNew entities
- "enemies" ONLY if hostile creatures are actively attacking, forcing initiative, or the player clearly chose violence. Do not extract enemies from merchant/watch/checkpoint/social/travel scenes by proximity alone.
- "slug" must be a plausible monster database key (lowercase, hyphenated). Use "custom" if unsure.
- Omit empty arrays entirely
- Return ONLY the JSON object, no explanation`;
}

// ---------------------------------------------------------------------------
// buildValidationPrompt
// ---------------------------------------------------------------------------

/**
 * structured model validation prompt checking narration against game state.
 */
function buildValidationPrompt(narration, options, gameState) {
  return `You are a rules compliance validator for a tabletop RPG game. Check the DM narration for violations.

DM NARRATION:
${narration}

PLAYER OPTIONS:
${(options || []).map((o, i) => `${i + 1}. ${o}`).join('\n')}

GAME STATE CONTEXT:
System: ${gameState.system || 'dnd5e'}
Ferocity: ${gameState.ferocity || 3}

Check for violations:
1. Did the DM roll dice or mention specific dice outcomes? (critical violation)
2. Did the DM reveal HP numbers, AC values, or stat block info? (minor violation)
3. Did the DM break character or address the players meta-game? (minor violation)
4. Are all 3 player options distinct and meaningful? (minor violation if not)

Return JSON:
{
  "violations": [
    { "severity": "critical|minor", "key": "short_key", "message": "description" }
  ]
}

Return ONLY the JSON object. If no violations, return { "violations": [] }`;
}

// ---------------------------------------------------------------------------
// parseNarrationResponse
// ---------------------------------------------------------------------------

function getStructuredMarkerPositions(text) {
  const markerRegex = createStructuredMarkerRegex('gim');
  const positions = [];

  for (const match of text.matchAll(markerRegex)) {
    let name = (match[1] || match[2] || '').toLowerCase();
    if (name === 'option') name = 'options';
    positions.push({ name, idx: match.index, len: match[0].length });
  }

  return positions.sort((a, b) => a.idx - b.idx);
}

function parseOptionLine(line) {
  const emojiOptionRe = /^([1-3])️⃣\s*/u;
  const numberedOptionRe = /^([1-3])[.)]\s+/;

  if (emojiOptionRe.test(line)) {
    return line.replace(emojiOptionRe, '').trim();
  }
  if (numberedOptionRe.test(line)) {
    return line.replace(numberedOptionRe, '').trim();
  }
  return null;
}

function extractOptions(text) {
  return text
    .split('\n')
    .map(line => parseOptionLine(line.trim()))
    .filter(Boolean)
    .slice(0, 3);
}

/**
 * Extract narration + options from model's response.
 * Lines matching ^[1-3]️⃣ are options (emoji format).
 * Lines matching ^[1-3][.)] are options (numbered format).
 * Structured ---OPTIONS---/---SCENE---/---WORLD--- blocks are stripped from narration.
 * If fewer than 2 option-like lines found outside structured blocks, treat entire text as narration with empty options.
 * Returns { narration, options } where options is array of up to 3 strings.
 */
function parseNarrationResponse(text) {
  if (!text || text.trim() === '') {
    return { narration: '', options: [] };
  }

  const markerPositions = getStructuredMarkerPositions(text);
  if (markerPositions.length > 0) {
    const narration = text.slice(0, markerPositions[0].idx).trim();
    let optionsRaw = '';

    for (let i = 0; i < markerPositions.length; i++) {
      const start = markerPositions[i].idx + markerPositions[i].len;
      const end = i + 1 < markerPositions.length ? markerPositions[i + 1].idx : text.length;
      if (markerPositions[i].name === 'options') {
        optionsRaw += '\n' + text.slice(start, end).trim();
      }
    }

    return {
      narration,
      options: extractOptions(optionsRaw),
    };
  }

  const lines = text.split('\n');
  const narrationLines = [];
  const optionLines = [];

  for (const line of lines) {
    const optionText = parseOptionLine(line.trim());
    if (optionText) {
      optionLines.push(optionText);
    } else {
      narrationLines.push(line);
    }
  }

  // If fewer than 2 option-like lines, treat everything as narration
  if (optionLines.length < 2) {
    return { narration: text.trim(), options: [] };
  }

  return {
    narration: narrationLines.join('\n').trim(),
    options: optionLines.slice(0, 3),
  };
}

// ---------------------------------------------------------------------------
// processViolation
// ---------------------------------------------------------------------------

/**
 * Route critical violations immediately, escalate minor after 3 consecutive.
 */
function processViolation(gs, violation) {
  if (!gs.pendingCorrections) gs.pendingCorrections = [];
  if (!gs.minorViolationCounts) gs.minorViolationCounts = {};

  const { severity } = violation;
  // Support both { key, message } (structured model validation format) and { type, description, correction } (pipeline format)
  const key = violation.key || violation.type;
  // Store the full violation object when using the type/description format, else store message string
  const payload = violation.description !== undefined ? violation : violation.message;

  if (severity === 'critical') {
    gs.pendingCorrections.push(payload);
    return;
  }

  // Minor violation
  const current = gs.minorViolationCounts[key] || 0;
  const next = current + 1;

  if (next >= 3) {
    gs.pendingCorrections.push(payload);
    gs.minorViolationCounts[key] = 0;
  } else {
    gs.minorViolationCounts[key] = next;
  }
}

// ---------------------------------------------------------------------------
// shouldCallModelForFlavor
// ---------------------------------------------------------------------------

/**
 * Returns true on round 1, every 3rd round, or when combat is over.
 */
function shouldCallModelForFlavor(combatState) {
  if (!combatState) return true;
  if (!combatState.active || combatState.over) return true;
  const round = combatState.round || 1;
  if (round === 1) return true;
  if (round % 3 === 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// API call: model narration (streamed)
// ---------------------------------------------------------------------------

/**
 * Streamed model API call for narration.
 * Emits: dm_stream_start, dm_stream_chunk, dm_stream_end via io.
 */
async function callModelNarration(gameId, gameConfig, gs, characterName, actionText, io, storyFlags) {
  const { buildFullPrompt, buildMinimalPrompt } = require('./prompt-builder');
  const encounterDesigner = require('./encounter-designer');

  // Select prompt based on story flags and pending challenges
  // Use full prompt for story moments (NPC interactions, exploration, encounter plans)
  const isStoryMoment = storyFlags?.story || gs._pendingChallenge;
  const systemPrompt = isStoryMoment
    ? buildFullPrompt(gameId, gameConfig, () => gs, encounterDesigner)
    : buildMinimalPrompt(gameConfig, gs);
  const userMessage = buildUserMessage(gs, characterName, actionText);

  let fullText = '';
  let visibleNarration = '';
  let pendingNarrationTail = '';
  let streamingState = 'NARRATING';
  const markerRegex = createStructuredMarkerRegex('im');
  let streamEnded = false;

  const emitVisibleChunk = (text) => {
    if (!text) return;
    visibleNarration += text;
    if (io) {
      io.to(gameId).emit('dm_stream_chunk', { gameId, text, chunk: text });
    }
  };

  const bufferStreamChunk = (chunk) => {
    if (!chunk || streamingState !== 'NARRATING') return;

    pendingNarrationTail += chunk;
    const markerMatch = pendingNarrationTail.match(markerRegex);

    if (markerMatch) {
      emitVisibleChunk(pendingNarrationTail.slice(0, markerMatch.index).replace(/\s+$/, ''));
      pendingNarrationTail = '';
      streamingState = 'BUFFERING_STRUCTURED';
      return;
    }

    if (pendingNarrationTail.length > STREAM_MARKER_LOOKAHEAD) {
      emitVisibleChunk(pendingNarrationTail.slice(0, -STREAM_MARKER_LOOKAHEAD));
      pendingNarrationTail = pendingNarrationTail.slice(-STREAM_MARKER_LOOKAHEAD);
    }
  };

  const flushVisibleNarration = () => {
    if (streamingState === 'NARRATING' && pendingNarrationTail) {
      emitVisibleChunk(pendingNarrationTail);
    }
    pendingNarrationTail = '';
  };

  const closeStream = (narration, llmRunId = null) => {
    if (!io || streamEnded) return;
    io.to(gameId).emit('dm_stream_end', {
      gameId,
      narration: narration || 'The world holds its breath...',
      llmRunId,
    });
    streamEnded = true;
  };

  // Emit stream start to the game room
  if (io) {
    io.to(gameId).emit('dm_stream_start', { gameId });
  }

  const verbosityMaxTokens = { terse: 250, brief: 400, verbose: 1500 };
  const maxTokens = verbosityMaxTokens[gs.verbosity] || verbosityMaxTokens.brief;

  try {
    const response = await llm.streamText({
      task: 'narration',
      gameId,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens,
      onToken: (chunk) => {
        fullText += chunk;
        bufferStreamChunk(chunk);
      },
    });
    flushVisibleNarration();

    const responseText = fullText || response.text || '';
    if (!responseText.trim()) {
      const fallback = buildFallbackTurn(characterName, actionText);
      closeStream(fallback.narration, response.llmRunId || null);
      return {
        ...fallback,
        llmRunId: response.llmRunId || null,
        fallback: true,
      };
    }

    const parsed = parseNarrationResponse(responseText);
    parsed.narration = cleanInvalidCombatNarration(parsed.narration);
    if (isLowInformationNarration(parsed.narration, actionText)) {
      const fallback = buildFallbackTurn(characterName, actionText);
      closeStream(fallback.narration, response.llmRunId || null);
      return {
        ...fallback,
        llmRunId: response.llmRunId || null,
        fallback: true,
      };
    }
    if (!parsed.options.length) {
      parsed.options = [...FALLBACK_OPTIONS];
    }
    parsed.llmRunId = response.llmRunId;
    closeStream(parsed.narration || responseText.trim(), response.llmRunId);
    return parsed;
  } catch (err) {
    const fallback = buildFallbackTurn(characterName, actionText);
    flushVisibleNarration();
    closeStream(visibleNarration.trim() || fallback.narration, err.llmRunId || null);
    return {
      ...fallback,
      llmRunId: err.llmRunId || null,
      fallback: true,
    };
  }
}

// ---------------------------------------------------------------------------
// API call: structured model extraction (non-streaming)
// ---------------------------------------------------------------------------

/**
 * structured model extraction API call. Returns parsed world state changes.
 */
async function callWorldExtraction(gameId, narration, actionText, worldState) {
  const prompt = buildExtractionPrompt(narration, actionText, worldState);

  try {
    const response = await llm.completeJson({
      task: 'world-extraction',
      gameId,
      prompt,
      schema: worldExtractionSchema,
      maxTokens: 700,
      temperature: 0,
    });
    return response.object;
  } catch (err) {
    console.error(`[narration-pipeline] world extraction failed for game ${gameId}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// API call: structured model validation (non-streaming)
// ---------------------------------------------------------------------------

/**
 * structured model validation API call. Returns { violations: [] } on failure.
 */
async function callNarrationValidation(gameId, narration, options, gameState) {
  const prompt = buildValidationPrompt(narration, options, gameState);

  const defaultResult = { violations: [] };

  try {
    const response = await llm.completeJson({
      task: 'validation',
      gameId,
      prompt,
      schema: validationSchema,
      maxTokens: 300,
      temperature: 0,
    });
    return response.object?.violations ? response.object : defaultResult;
  } catch (err) {
    console.error(`[narration-pipeline] validation failed for game ${gameId}:`, err.message);
    return defaultResult;
  }
}

// ---------------------------------------------------------------------------
// handlePlayerAction — main orchestrator
// ---------------------------------------------------------------------------

/**
 * Main orchestrator. Routes combat vs non-combat.
 *
 * deps: { initiateCombat, parseAction, resolveEnemyTurns, persistCombatState, emitCombatUpdate }
 * storyFlags: { story, npc, exploration } — hints for full vs minimal prompt selection
 */
async function handlePlayerAction(gameId, gameConfig, gs, characterName, actionText, io, deps, storyFlags) {
  const {
    initiateCombat,
    parseAction,
    resolveEnemyTurns,
    persistCombatState,
    emitCombatUpdate,
  } = deps || {};

  // Store flags on game state for prompt selection
  gs._turnFlags = storyFlags || {};

  const combatActive = gs.combatEngine?.state?.active;

  // -------------------------------------------------------------------------
  // COMBAT PATH
  // -------------------------------------------------------------------------
  if (combatActive) {
    const combatEngine = gs.combatEngine;

    // Parse and resolve player action
    let parsedAction = null;
    if (parseAction) {
      try {
        parsedAction = await parseAction(actionText, combatEngine.state.combatants, gs.system || gameConfig.system);
      } catch (err) {
        console.error(`[narration-pipeline] parseAction failed:`, err.message);
      }
    }

    // Resolve player action through combat engine
    let playerResults = [];
    if (parsedAction && combatEngine.resolveAction) {
      try {
        playerResults = await combatEngine.resolveAction(parsedAction, characterName);
      } catch (err) {
        console.error(`[narration-pipeline] resolveAction failed:`, err.message);
      }
    }

    // Auto-resolve death saves for downed PCs
    const downedPCs = Object.values(combatEngine.state.combatants || {}).filter(
      c => c.type === 'PC' && c.hp <= 0 && !c.dead
    );
    for (const pc of downedPCs) {
      if (combatEngine.resolveDeathSave) {
        try {
          const dsResult = combatEngine.resolveDeathSave(pc.id);
          if (dsResult) playerResults.push(dsResult);
        } catch (err) {
          // non-fatal
        }
      }
    }

    // Resolve enemy turns
    let enemyResults = [];
    if (resolveEnemyTurns) {
      try {
        enemyResults = await resolveEnemyTurns(gameId, gameConfig);
      } catch (err) {
        console.error(`[narration-pipeline] resolveEnemyTurns failed:`, err.message);
      }
    }

    const allResults = [...playerResults, ...enemyResults];

    // Assemble template narration
    const persona = gameConfig.dmPersona || 'epic';
    let narration = '';
    try {
      narration = await templateEngine.assembleCombatNarration(allResults, combatEngine, persona);
    } catch (err) {
      console.error(`[narration-pipeline] assembleCombatNarration failed:`, err.message);
      narration = 'The battle continues...';
    }

    // Generate tactical options
    let options = [];
    try {
      options = templateEngine.generateCombatOptions(combatEngine, characterName);
    } catch (err) {
      options = ['Attack', 'Dodge', 'Use ability'];
    }

    // Skip model flavor calls during combat - template narration is sufficient
    // Avoid concurrent Socket.IO emissions that could cause text interleaving

    // Check if combat is over
    let combatOver = false;
    if (combatEngine.isCombatOver) {
      const overResult = combatEngine.isCombatOver();
      combatOver = typeof overResult === 'object' ? overResult.over : Boolean(overResult);
    }

    if (combatOver && combatEngine.endCombat) {
      try {
        combatEngine.endCombat();
        const defeated = Object.values(combatEngine.state.combatants || {})
          .filter(c => c.type !== 'PC' && ((c.hp ?? c.totalHp ?? 0) <= 0))
          .map(c => c.name)
          .filter(Boolean);
        gs.lastCombatConclusion = {
          reason: 'combat_over',
          defeated,
          summary: defeated.length > 0
            ? `${defeated.join(', ')} defeated. The fight is over.`
            : 'The fight is over.',
          updatedAt: new Date().toISOString(),
        };
      } catch (err) {
        console.error(`[narration-pipeline] endCombat failed:`, err.message);
      }
    }

    // Persist combat state
    if (persistCombatState) {
      try { persistCombatState(gameId); } catch (err) {
        console.error(`[narration-pipeline] persistCombatState failed:`, err.message);
      }
    }

    // Emit combat update
    if (emitCombatUpdate) {
      try {
        emitCombatUpdate(gameId, combatEngine, io);
      } catch (err) {
        console.error(`[narration-pipeline] emitCombatUpdate failed:`, err.message);
      }
    }

    return {
      narration,
      options,
      scene: null,
      world: null,
      isKillshot: false,
      combatOver,
    };
  }

  // -------------------------------------------------------------------------
  // NON-COMBAT PATH
  // -------------------------------------------------------------------------

  // Call 1: model narration (streamed)
  let narration = '';
  let options = [];
  let llmRunId = null;
  try {
    const narrationResult = await callModelNarration(gameId, gameConfig, gs, characterName, actionText, io, gs._turnFlags);
    narration = narrationResult.narration;
    options = narrationResult.options;
    llmRunId = narrationResult.llmRunId || null;
    if (narrationResult.fallback) {
      return {
        narration,
        options,
        scene: null,
        world: null,
        isKillshot: false,
        llmRunId,
        fallback: true,
      };
    }
  } catch (err) {
    console.error(`[narration-pipeline] callModelNarration failed:`, err.message);
    const fallback = buildFallbackTurn(characterName, actionText);
    narration = fallback.narration;
    options = fallback.options;
    return {
      narration,
      options,
      scene: null,
      world: null,
      isKillshot: false,
      llmRunId,
      fallback: true,
    };
  }

  // Calls 2 & 3: structured model extraction + validation in parallel
  const worldState = gs.world || {};
  const gameStateForValidation = { system: gameConfig.system, ferocity: gs.ferocity };

  const [extractionResult, validationResult] = await Promise.all([
    callWorldExtraction(gameId, narration, actionText, worldState).then(r => r || {}).catch(err => {
      console.error(`[narration-pipeline] callWorldExtraction failed:`, err.message);
      return {};
    }),
    callNarrationValidation(gameId, narration, options, gameStateForValidation).catch(err => {
      console.error(`[narration-pipeline] callNarrationValidation failed:`, err.message);
      return { violations: [] };
    }),
  ]);

  // Check for enemies detected → initiate combat
  const enemies = extractionResult.enemies || [];
  const nonHostileIntent = isDialogueAction(actionText) || isAdvanceAction(actionText);
  const explicitHostileAction = isExplicitHostileAction(actionText);
  if (enemies.length > 0 && initiateCombat && (explicitHostileAction || (!nonHostileIntent && hasHardCombatSignal(narration)))) {
    try {
      await initiateCombat(gameId, gameConfig, enemies);
    } catch (err) {
      console.error(`[narration-pipeline] initiateCombat failed:`, err.message);
    }
  } else if (enemies.length > 0) {
    extractionResult.enemies = [];
    const reason = nonHostileIntent ? 'non-hostile/progress input' : 'no hostile trigger';
    console.log(`[narration-pipeline] suppressed enemies after ${reason}`);
  }

  // Process violations
  const violations = validationResult.violations || [];
  for (const violation of violations) {
    processViolation(gs, violation);
  }

  return {
    narration,
    options,
    scene: extractionResult.scene || null,
    world: extractionResult,
    isKillshot: extractionResult.scene?.action?.toLowerCase().includes('killshot') || false,
    llmRunId,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildNarrationPrompt,
  buildUserMessage,
  formatResolvedCombatState,
  buildExtractionPrompt,
  buildValidationPrompt,
  parseNarrationResponse,
  processViolation,
  shouldCallModelForFlavor,
  callModelNarration,
  callWorldExtraction,
  callNarrationValidation,
  handlePlayerAction,
  buildFallbackTurn,
  isLowInformationNarration,
  buildAntiStallPacingDirective,
};
