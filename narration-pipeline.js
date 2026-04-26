'use strict';

const templateEngine = require('./template-engine');
const { formatPlanForPrompt } = require('./encounter-designer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SONNET_MODEL = 'claude-sonnet-4-6';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const VERBOSITY_RULES = {
  verbose: 'Write ~100 words of narration. Vivid detail and atmosphere.',
  brief:   'BRIEF MODE — HARD LIMIT: 75 words max narration. 4-5 sentences. Punchy and direct.',
  terse:   'TERSE MODE — ABSOLUTE LIMIT: 50 words max. 3 sentences max. No atmosphere, no descriptions, no internal thoughts. State what happens mechanically. Count your words. If you write more than 50 words, you have failed.',
};

const FEROCITY_LABELS = {
  1: 'Deadly (lethal, every encounter is life-threatening)',
  2: 'Dangerous (tough fights, meaningful consequences)',
  3: 'Balanced (challenging but fair)',
  4: 'Light (manageable encounters, low death risk)',
  5: 'Easy (heroic power fantasy, minimal threat)',
};

const PERSONA_BLOCKS = {
  epic: `You are an EPIC Dungeon Master — literary, atmospheric, and dramatic. Your narration uses visceral, grounded prose that makes players feel the weight of every action. You write like a novelist: tight sentences, evocative imagery, no purple prose. You NEVER break the fourth wall or make jokes at the story's expense. Think: Patrick Rothfuss meets combat-focused Brandon Sanderson.`,

  over_the_top: `You are an OVER THE TOP Dungeon Master — comedic, chaotic, and full of Critical Role energy. Your narration is vivid but playful: absurd humor, dramatic flair, occasional fourth-wall glances, and zany NPC personalities. Think: Matthew Mercer on a caffeine high, Sam Riegel doing three voices at once, and the entire table losing it. Lean into the chaos.`,
};

// ---------------------------------------------------------------------------
// buildNarrationPrompt
// ---------------------------------------------------------------------------

/**
 * Build ~800 token Sonnet system prompt.
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

  // Encounter plan
  let encounterGuidance = '';
  if (gs.encounterPlan) {
    try {
      encounterGuidance = formatPlanForPrompt(gs.encounterPlan, gs.encounterIndex || 0);
    } catch (err) {
      encounterGuidance = '';
    }
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
  const history = gs.chatHistory || [];
  if (history.length > 0) {
    const historyLines = history.map(msg => {
      const role = msg.role === 'assistant' ? 'DM' : (msg.name || characterName || 'Player');
      return `${role}: ${msg.content}`;
    });
    parts.push(`[RECENT HISTORY]\n${historyLines.join('\n')}`);
  }

  // Player action - AGGRESSIVE FORMATTING
  parts.push(`═══════════════════════════════════════════════════════════`);
  parts.push(`🎬 THIS IS THE PLAYER'S CHOICE - RESPOND TO THIS ONLY:`);
  parts.push(`${characterName} chooses: ${actionText}`);
  parts.push(`\nDO NOT REPEAT PREVIOUS NARRATIONS. DO NOT IGNORE THIS ACTION.`);
  parts.push(`YOUR ONLY JOB: Describe what happens DIRECTLY BECAUSE OF THIS CHOICE.`);
  parts.push(`═══════════════════════════════════════════════════════════`);

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// buildExtractionPrompt
// ---------------------------------------------------------------------------

/**
 * Haiku extraction prompt for world state changes.
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
- "enemies" ONLY if hostile creatures are actively threatening the party
- "slug" must be a plausible monster database key (lowercase, hyphenated). Use "custom" if unsure.
- Omit empty arrays entirely
- Return ONLY the JSON object, no explanation`;
}

// ---------------------------------------------------------------------------
// buildValidationPrompt
// ---------------------------------------------------------------------------

/**
 * Haiku validation prompt checking narration against game state.
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
// parseSonnetResponse
// ---------------------------------------------------------------------------

/**
 * Extract narration + options from Sonnet's response.
 * Lines matching ^[1-3]️⃣ are options (emoji format).
 * Lines matching ^[1-3][.)] are options (numbered format).
 * If fewer than 2 option-like lines found, treat entire text as narration with empty options.
 * Returns { narration, options } where options is array of up to 3 strings.
 */
function parseSonnetResponse(text) {
  if (!text || text.trim() === '') {
    return { narration: '', options: [] };
  }

  const lines = text.split('\n');
  const narrationLines = [];
  const optionLines = [];

  // Regex patterns for options
  const emojiOptionRe = /^([1-3])️⃣\s*/u;
  const numberedOptionRe = /^([1-3])[.)]\s+/;

  for (const line of lines) {
    const emojiMatch = line.match(emojiOptionRe);
    const numberedMatch = line.match(numberedOptionRe);

    if (emojiMatch) {
      // Strip the emoji prefix (e.g. "1️⃣ ")
      const stripped = line.replace(emojiOptionRe, '').trim();
      optionLines.push(stripped);
    } else if (numberedMatch) {
      // Strip "1. " or "1) " prefix
      const stripped = line.replace(numberedOptionRe, '').trim();
      optionLines.push(stripped);
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
  // Support both { key, message } (Haiku validation format) and { type, description, correction } (pipeline format)
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
// shouldCallSonnetForFlavor
// ---------------------------------------------------------------------------

/**
 * Returns true on round 1, every 3rd round, or when combat is over.
 */
function shouldCallSonnetForFlavor(combatState) {
  if (!combatState) return true;
  if (!combatState.active || combatState.over) return true;
  const round = combatState.round || 1;
  if (round === 1) return true;
  if (round % 3 === 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// API call: Sonnet narration (streamed)
// ---------------------------------------------------------------------------

/**
 * Streamed Sonnet API call for narration.
 * Emits: dm_stream_start, dm_stream_chunk, dm_stream_end via io.
 */
async function callSonnetNarration(gameId, gameConfig, gs, characterName, actionText, io) {
  // Lazy require to avoid circular dependency: server requires narration-pipeline
  const { anthropic } = require('./server');

  const systemPrompt = buildNarrationPrompt(gameId, gameConfig, gs);
  const userMessage = buildUserMessage(gs, characterName, actionText);

  let fullText = '';

  // Emit stream start to the game room
  if (io) {
    io.to(gameId).emit('dm_stream_start', { gameId });
  }

  const verbosityMaxTokens = { terse: 250, brief: 400, verbose: 1500 };
  const maxTokens = verbosityMaxTokens[gs.verbosity] || verbosityMaxTokens.brief;

  const stream = anthropic.messages.stream({
    model: SONNET_MODEL,
    max_tokens: maxTokens,
    system: [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      { role: 'user', content: userMessage },
    ],
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const chunk = event.delta.text;
      fullText += chunk;
      if (io) {
        io.to(gameId).emit('dm_stream_chunk', { gameId, chunk });
      }
    }
  }

  if (io) {
    io.to(gameId).emit('dm_stream_end', { gameId });
  }

  return parseSonnetResponse(fullText);
}

// ---------------------------------------------------------------------------
// API call: Haiku extraction (non-streaming)
// ---------------------------------------------------------------------------

/**
 * Haiku extraction API call. Returns parsed world state changes.
 */
async function callHaikuExtraction(gameId, narration, actionText, worldState) {
  // Lazy require to avoid circular dependency: server requires narration-pipeline
  const { anthropic } = require('./server');

  const prompt = buildExtractionPrompt(narration, actionText, worldState);

  let response;
  try {
    response = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    console.error(`[narration-pipeline] Haiku extraction failed for game ${gameId}:`, err.message);
    return null;
  }

  const text = response.content[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error(`[narration-pipeline] Haiku extraction JSON parse failed:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// API call: Haiku validation (non-streaming)
// ---------------------------------------------------------------------------

/**
 * Haiku validation API call. Returns { violations: [] } on failure.
 */
async function callHaikuValidation(gameId, narration, options, gameState) {
  // Lazy require to avoid circular dependency: server requires narration-pipeline
  const { anthropic } = require('./server');

  const prompt = buildValidationPrompt(narration, options, gameState);

  const defaultResult = { violations: [] };

  let response;
  try {
    response = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    console.error(`[narration-pipeline] Haiku validation failed for game ${gameId}:`, err.message);
    return defaultResult;
  }

  const text = response.content[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return defaultResult;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.violations ? parsed : defaultResult;
  } catch (err) {
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
 */
async function handlePlayerAction(gameId, gameConfig, gs, characterName, actionText, io, deps) {
  const {
    initiateCombat,
    parseAction,
    resolveEnemyTurns,
    persistCombatState,
    emitCombatUpdate,
  } = deps || {};

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

    // Skip Sonnet flavor calls during combat - template narration is sufficient
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

  // Call 1: Sonnet narration (streamed)
  let narration = '';
  let options = [];
  try {
    const sonnetResult = await callSonnetNarration(gameId, gameConfig, gs, characterName, actionText, io);
    narration = sonnetResult.narration;
    options = sonnetResult.options;
  } catch (err) {
    console.error(`[narration-pipeline] callSonnetNarration failed:`, err.message);
    narration = 'The world holds its breath...';
    options = [];
  }

  // Calls 2 & 3: Haiku extraction + validation in parallel
  const worldState = gs.world || {};
  const gameStateForValidation = { system: gameConfig.system, ferocity: gs.ferocity };

  const [extractionResult, validationResult] = await Promise.all([
    callHaikuExtraction(gameId, narration, actionText, worldState).then(r => r || {}).catch(err => {
      console.error(`[narration-pipeline] callHaikuExtraction failed:`, err.message);
      return {};
    }),
    callHaikuValidation(gameId, narration, options, gameStateForValidation).catch(err => {
      console.error(`[narration-pipeline] callHaikuValidation failed:`, err.message);
      return { violations: [] };
    }),
  ]);

  // Check for enemies detected → initiate combat
  const enemies = extractionResult.enemies || [];
  if (enemies.length > 0 && initiateCombat) {
    try {
      await initiateCombat(gameId, gameConfig, enemies);
    } catch (err) {
      console.error(`[narration-pipeline] initiateCombat failed:`, err.message);
    }
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
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildNarrationPrompt,
  buildUserMessage,
  buildExtractionPrompt,
  buildValidationPrompt,
  parseSonnetResponse,
  processViolation,
  shouldCallSonnetForFlavor,
  callSonnetNarration,
  callHaikuExtraction,
  callHaikuValidation,
  handlePlayerAction,
  // Constants exposed for callers
  SONNET_MODEL,
  HAIKU_MODEL,
};
