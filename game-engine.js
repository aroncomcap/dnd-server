// ── Game Engine: Claude Orchestration & Game Loop ────────────────────────────

const db = require('./db');

let anthropic; // Initialized by module caller
let io; // Initialized by module caller
let checkRateLimit; // Initialized by module caller
let logCost; // Initialized by module caller
let estimateCost; // Initialized by module caller
let getGameState; // Initialized by module caller
let getCurrentPlayer; // Initialized by module caller
let emitSystem; // Initialized by module caller
let emitCombatUpdate; // Initialized by module caller
let buildSystemPrompt; // Initialized by module caller
let buildTrimmedPrompt; // Initialized by module caller
let parseResponse; // Initialized by module caller
let narrationPipeline; // Initialized by module caller
let ed; // Initialized by module caller
let USE_SPLIT_PIPELINE; // Initialized by module caller

let parseAction; // Initialized by module caller
let parseOptions; // Initialized by module caller
let parseOptionsWithAI; // Initialized by module caller
let initiateCombat; // Initialized by module caller
let resolveEnemyTurns; // Initialized by module caller
let persistCombatState; // Initialized by module caller
let processMapHint; // Initialized by module caller
let generateWorldArt; // Initialized by module caller
let shouldGenerateImage; // Initialized by module caller
let generateCompositeScene; // Initialized by module caller

const MAX_CHAT_HISTORY = 16;

function init(deps) {
  anthropic = deps.anthropic;
  io = deps.io;
  checkRateLimit = deps.checkRateLimit;
  logCost = deps.logCost;
  estimateCost = deps.estimateCost;
  getGameState = deps.getGameState;
  getCurrentPlayer = deps.getCurrentPlayer;
  emitSystem = deps.emitSystem;
  emitCombatUpdate = deps.emitCombatUpdate;
  buildSystemPrompt = deps.buildSystemPrompt;
  buildTrimmedPrompt = deps.buildTrimmedPrompt;
  parseResponse = deps.parseResponse;
  narrationPipeline = deps.narrationPipeline;
  ed = deps.ed;
  USE_SPLIT_PIPELINE = deps.USE_SPLIT_PIPELINE;
  parseAction = deps.parseAction;
  parseOptions = deps.parseOptions;
  parseOptionsWithAI = deps.parseOptionsWithAI;
  initiateCombat = deps.initiateCombat;
  resolveEnemyTurns = deps.resolveEnemyTurns;
  persistCombatState = deps.persistCombatState;
  processMapHint = deps.processMapHint;
  generateWorldArt = deps.generateWorldArt;
  shouldGenerateImage = deps.shouldGenerateImage;
  generateCompositeScene = deps.generateCompositeScene;
}

// ── Rolling Story Summary ─────────────────────────────────────────────────────
async function refreshStorySummary(gameId, gameConfig) {
  const gs = getGameState(gameId);
  const gd = gs.data;
  const oldMessages = gd.chatHistory.slice(0, -6); // Keep last 6, summarize the rest
  if (oldMessages.length < 4) return; // Not enough to summarize

  const transcript = oldMessages.map(m =>
    m.role === 'user' ? `Player: ${m.content}` : `DM: ${m.content}`
  ).join('\n').slice(0, 3000);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: 'Summarize this RPG session in 150 words. Focus on: current quest, recent events, unresolved tensions, character status. Be concise.',
    messages: [{ role: 'user', content: transcript }],
  });

  const inputTokens = response.usage?.input_tokens || 0;
  const outputTokens = response.usage?.output_tokens || 0;
  logCost({ gameId, model: 'claude-haiku-4-5-20251001', inputTokens, outputTokens,
    cost: estimateCost('claude-haiku-4-5-20251001', inputTokens, outputTokens), type: 'story-summary' });

  gs.storySummary = response.content[0].text;
  // Trim history to just the last 6 messages
  gd.chatHistory = gd.chatHistory.slice(-6);
  await db.saveChatHistory(gameId, gd.chatHistory);
  await db.setState(gameId, 'storySummary', gs.storySummary);
  console.log('Story summary refreshed for', gameId);
}

// ── Claude Call (scoped to a game) ───────────────────────────────────────────
async function callClaude(gameId, gameConfig, userMessage, actingAs = null) {
  if (!USE_SPLIT_PIPELINE) {
    return legacyCallClaude(gameId, gameConfig, userMessage, actingAs);
  }

  // Combat turns use legacy path — combat engine integration is complex and already works well with Haiku
  const gs0 = getGameState(gameId);
  if (gs0.combatEngine?.state?.active) {
    return legacyCallClaude(gameId, gameConfig, userMessage, actingAs);
  }

  // Rate limit check
  if (!checkRateLimit(gameId)) {
    const gs = getGameState(gameId);
    gs.paused = true;
    clearTimeout(gs.turnTimer);
    emitSystem(gameId, { text: '⚠️ Rate limit reached (60 calls/hour). Game paused.' });
    return { narration: 'Game paused — rate limit reached.', options: [], scene: null, world: null, isKillshot: false };
  }

  const gs = getGameState(gameId);
  const characterName = actingAs || userMessage.split(':')[0]?.trim() || 'Unknown';
  const actionText = userMessage.replace(/^.*?:\s*/, '');
  const prefix = actingAs ? `[AUTO-ACTION for ${actingAs}]\n` : '';

  // ── Story Moment Detection ─────────────────────────────────────────────────
  // Detect if this turn is a story moment that warrants the full system prompt
  // Story moments: encounter plans, NPC interactions, exploration, or manual flags
  const turn = {
    flags: {
      story: false,
      npc: false,
      exploration: false,
    }
  };

  // Flag 1: Encounter plan urgency
  if (gs._pendingChallenge) {
    turn.flags.story = true;
  }

  // Flag 2: NPC interaction detection
  // Look for: dialogue markers, NPC names, conversation verbs
  if (actionText && (
    // Dialogue markers
    actionText.match(/["'].*["']/) || // quoted dialogue
    actionText.match(/\b(?:talk|speak|discuss|chat|ask|convince|threaten|bribe|seduce|negotiate|bargain|interrogate|approach|confront|meet|greet|address)\b/i) || // conversation verbs
    // Named NPCs (capitalized proper nouns like "Lord Blackthorn" or "the bartender" — check for titlecase patterns)
    actionText.match(/\b(?:to|with|at)\s+(?:the\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g) ||
    // Capitalized names standing alone (at least 2 capitals for proper nouns)
    actionText.match(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g)
  )) {
    turn.flags.npc = true;
  }

  // Flag 3: Exploration/investigation detection
  // Look for: exploration verbs and location keywords
  if (actionText && actionText.match(/\b(?:explore|investigate|search|examine|discover|venture|enter|descend|climb|lookfor|check|study|observe|inspect)\b/i)) {
    turn.flags.exploration = true;
  }

  // Mark full story moment if any component is true
  if (turn.flags.npc || turn.flags.exploration) {
    turn.flags.story = true;
  }

  try {
    const result = await narrationPipeline.handlePlayerAction(
      gameId, gameConfig, gs, characterName, prefix + actionText, io,
      { initiateCombat, parseAction, resolveEnemyTurns, persistCombatState, emitCombatUpdate },
      turn.flags
    );

    // Save to chat history (same format as legacy)
    const gd = gs.data;
    const historyContent = result.narration +
      (result.options?.length ? '\n\n' + result.options.map((o, i) => `${i + 1}️⃣ ${o}`).join('\n') : '');
    gd.chatHistory.push(
      { role: 'user', content: prefix + userMessage },
      { role: 'assistant', content: historyContent }
    );
    if (gd.chatHistory.length > MAX_CHAT_HISTORY) {
      gd.chatHistory = gd.chatHistory.slice(-MAX_CHAT_HISTORY);
    }

    // Apply world updates to game state
    if (result.world) {
      applyWorldUpdates(gameId, result.world);
    }

    // Trigger story summary refresh periodically
    const turnCount = gd.chatHistory.length / 2;
    if (turnCount > 6 && turnCount % 25 === 0) {
      refreshStorySummary(gameId, gameConfig).catch(() => {});
    }

    return result;
  } catch (err) {
    console.error('[pipeline] Error, falling back to legacy:', err.message, err.stack?.split('\n').slice(0, 3).join(' | '));
    return legacyCallClaude(gameId, gameConfig, userMessage, actingAs);
  }
}

function applyWorldUpdates(gameId, worldUpdates) {
  if (!worldUpdates) return;
  const gs = getGameState(gameId);
  const gd = gs.data;
  if (!gd.world) gd.world = { locations: [], npcs: [], accomplishments: [] };

  // Merge locations
  if (worldUpdates.locations) {
    for (const loc of worldUpdates.locations) {
      const existing = gd.world.locations.find(l => l.name.toLowerCase() === loc.name.toLowerCase());
      if (existing) {
        Object.assign(existing, loc);
      } else {
        gd.world.locations.push(loc);
      }
    }
  }

  // Merge NPCs
  if (worldUpdates.npcs) {
    for (const npc of worldUpdates.npcs) {
      const existing = gd.world.npcs.find(n => n.name.toLowerCase() === npc.name.toLowerCase());
      if (existing) {
        Object.assign(existing, npc);
      } else {
        gd.world.npcs.push(npc);
      }
    }
  }

  // Map update
  if (worldUpdates.map) {
    gd.world.currentMap = worldUpdates.map;
  }

  // Accomplishments
  if (worldUpdates.accomplishments) {
    gd.world.accomplishments = [...(gd.world.accomplishments || []), ...worldUpdates.accomplishments];
  }

  // Character updates
  if (worldUpdates.charUpdates) {
    for (const update of worldUpdates.charUpdates) {
      const char = gd.characters[update.character];
      if (char && update.field && update.value) {
        char[update.field] = update.value;
      }
    }
  }

  // Persist
  db.setState(gameId, 'world', gd.world).catch(() => {});
}

async function legacyCallClaude(gameId, gameConfig, userMessage, actingAs = null) {
  // Rate limit check
  if (!checkRateLimit(gameId)) {
    const gs = getGameState(gameId);
    gs.paused = true;
    clearTimeout(gs.turnTimer);
    emitSystem(gameId, { text: '⚠️ Rate limit reached (60 calls/hour). Game paused to prevent runaway costs.' });
    return { narration: 'Game paused — rate limit reached.', options: [], scene: null, world: null, isKillshot: false };
  }

  const gs = getGameState(gameId);
  const gd = gs.data;

  const prefix = actingAs
    ? `[AUTO-ACTION for ${actingAs} — timer expired]\n`
    : '';

  // Few-shot examples for terse mode (only on first few turns before history establishes pattern)
  const needsFewShot = gs.verbosity === 'terse' && gd.chatHistory.length < 6;
  const verbosityExample = needsFewShot ? [
    { role: 'user', content: 'Kael: I search the room for traps.' },
    { role: 'assistant', content: 'Kael finds a tripwire near the door — a poison dart trap.\n\n---OPTIONS---\n1️⃣ 🗡️ Disarm the trap\n2️⃣ 🛡️ Find another way around\n3️⃣ 🔥 Trigger it from a distance\n\n---SCENE---\nACTION: Examining trapped doorway\nMOOD: cautious\nNPC: none\n\n---WORLD---\nLOCATIONS:\n- Trapped Hallway | Stone corridor | current\nNPCS:\n- none\nMAP: Trapped Hallway' },
    { role: 'user', content: 'Kael: I attack the goblin with my longsword.' },
    { role: 'assistant', content: '**🎲 Kael swings longsword (STR +3, Prof +2) — rolls 17. HIT! 1d8+3 = 7 slashing. Goblin staggers (HP 0/7)**\nKael cleaves through the goblin\'s guard. It crumples.\n\n**🎲 Goblin Archer fires at Kael — rolls 14. HIT! 1d6+2 = 5 piercing. Kael winces (HP 13/18)**\nAn arrow bites into Kael\'s shoulder.\n\n---OPTIONS---\n1️⃣ 🗡️ Charge the archer\n2️⃣ 🛡️ Take cover behind the pillar\n3️⃣ 🔥 Throw the goblin\'s body at the archer\n\n---SCENE---\nACTION: Fighting goblins in cave\nMOOD: fierce\nNPC: none\n\n---WORLD---\nLOCATIONS:\n- Goblin Cave | Damp limestone | current\nNPCS:\n- none\nMAP: Goblin Cave' },
  ] : [];

  const messages = [
    ...verbosityExample,
    ...gd.chatHistory,
    { role: 'user', content: prefix + userMessage },
  ];

  const model = 'claude-haiku-4-5-20251001';
  const hasHistory = gd.chatHistory.some(m => m.role === 'assistant');
  const systemPrompt = hasHistory ? buildTrimmedPrompt(gameId, gameConfig) : buildSystemPrompt(gameId, gameConfig);
  const startTime = Date.now();

  // Combat routing — resolve player action + enemy turns before calling Claude
  const combatActive = gs.combatEngine?.state?.active;

  // Token limits: combat narration needs fewer tokens (just describing pre-resolved results)
  let maxTokens;
  if (combatActive) {
    maxTokens = gs.verbosity === 'terse' ? 500 : gs.verbosity === 'brief' ? 700 : 1500;
  } else {
    maxTokens = gs.verbosity === 'terse' ? 400 : gs.verbosity === 'brief' ? 600 : 2500;
  }
  let combatContext = '';

  if (combatActive) {
    try {
      const combatCtx = {
        combatants: gs.combatEngine.state.combatants,
        preTaggedOptions: gs.preTaggedOptions || null,
      };
      // Use combat engine's current turn, not the normal turn order
      const engineCurrent = gs.combatEngine.getCurrentTurn();
      const playerId = engineCurrent?.id || gs.data.turnOrder[gs.data.currentTurnIndex]?.toLowerCase().replace(/\s+/g, '-');
      const actionText = userMessage.replace(/^.*?:\s*/, '');

      // Check if this PC is downed — auto-resolve death save instead of normal action
      const playerCombatant = gs.combatEngine.state.combatants[playerId];
      const resolver = gs.combatEngine.getResolver();
      const isDown = playerCombatant && resolver.checkDeath(playerCombatant).status === 'unconscious';

      let parsedAction;
      if (isDown) {
        // Downed PC: auto-resolve death save
        parsedAction = { type: 'death_save', actorId: playerId };
      } else {
        parsedAction = parseAction(actionText, playerId, combatCtx);
        if (!parsedAction) {
          // Default: attack the first living enemy with primary weapon
          const enemies = Object.values(gs.combatEngine.state.combatants).filter(c => c.type === 'Enemy' && (c.hp > 0 || (c.totalHp && c.totalHp > 0)));
          const attacker = gs.combatEngine.state.combatants[playerId];
          if (enemies.length > 0 && attacker) {
            parsedAction = {
              type: 'attack',
              attackerId: playerId,
              targetId: enemies[0].id,
              weapon: attacker.weapons?.[0]?.name,
            };
          }
        }
      }

      if (parsedAction) {
        const playerResult = gs.combatEngine.resolveAction(parsedAction);
        gs.combatEngine.advanceTurn();

        // Auto-resolve death saves for any other downed PCs whose turns come up
        const deathSaveResults = [];
        while (true) {
          const nextTurn = gs.combatEngine.getCurrentTurn();
          if (!nextTurn || nextTurn.type !== 'PC') break;
          const deathCheck = resolver.checkDeath(nextTurn);
          if (deathCheck.status !== 'unconscious') break;
          const dsResult = gs.combatEngine.resolveAction({ type: 'death_save', actorId: nextTurn.id });
          deathSaveResults.push(dsResult);
          gs.combatEngine.advanceTurn();
        }

        const enemyResults = await resolveEnemyTurns(gameId, gameConfig);

        // Auto-resolve death saves for downed PCs after enemy turns
        while (true) {
          const nextTurn = gs.combatEngine.getCurrentTurn();
          if (!nextTurn || nextTurn.type !== 'PC') break;
          const deathCheck = resolver.checkDeath(nextTurn);
          if (deathCheck.status !== 'unconscious') break;
          const dsResult = gs.combatEngine.resolveAction({ type: 'death_save', actorId: nextTurn.id });
          deathSaveResults.push(dsResult);
          gs.combatEngine.advanceTurn();
        }

        persistCombatState(gameId);
        const allResults = [playerResult, ...deathSaveResults, ...enemyResults].filter(Boolean);
        const resultLines = allResults.map(r => gs.combatEngine.formatResultForPrompt(r));

        combatContext = `\n\n${gs.combatEngine.getCombatStateForPrompt()}\n\nRESOLVED THIS ROUND:\n${resultLines.join('\n')}\n\nNarrate these results in your DM persona. It is now ${gs.combatEngine.getCurrentTurn()?.name || 'the next player'}'s turn.`;

        // Add enemy personalities for narration flavor
        const enemyPersonalities = Object.values(gs.combatEngine.state.combatants)
          .filter(c => c.type === 'Enemy' && c.personality && (c.hp > 0 || (c.totalHp && c.totalHp > 0)))
          .map(c => `${c.name}: ${c.personality}`)
          .join('\n');
        if (enemyPersonalities) {
          combatContext += `\n\nENEMY PERSONALITIES (use in narration):\n${enemyPersonalities}`;
        }

        const overCheck = gs.combatEngine.isCombatOver();
        if (overCheck.over) {
          combatContext += `\n\nCOMBAT IS OVER: ${overCheck.reason === 'enemies_defeated' ? 'All enemies defeated. Narrate aftermath and loot.' : 'All PCs are down.'}`;
          gs.combatEngine.endCombat();
          persistCombatState(gameId);
          // Collect DPR data from combat
          const combatSummary = gs.combatEngine.getCombatSummary();
          if (combatSummary && combatSummary.rounds > 0) {
            if (!gs.combatHistory) gs.combatHistory = {};
            for (const [id, data] of Object.entries(combatSummary.characters)) {
              if (data.type !== 'PC') continue;
              if (!gs.combatHistory[id]) gs.combatHistory[id] = { combats: [] };
              gs.combatHistory[id].combats.push({
                date: Date.now(), rounds: combatSummary.rounds,
                damageDealt: data.damageDealt, damageTaken: data.damageTaken,
                healed: data.healed, spellSlotsUsed: data.spellSlotsUsed,
              });
              if (gs.combatHistory[id].combats.length > 5) gs.combatHistory[id].combats.shift();
              gs.combatHistory[id].rollingDPR = ed.updateRollingDPR(gs.combatHistory[id]);
            }
            db.setState(gameId, 'combatHistory', gs.combatHistory).catch(() => {});

            // Difficulty correction
            if (gs.encounterPlan) {
              const encounters = gs.encounterPlan.encounters || [];
              const currentEnc = encounters.find(e => e.pillar === 'combat' && !e.completed && !e.rest);
              if (currentEnc) {
                gs.difficultyCorrection = ed.applyDifficultyCorrection(
                  gs.difficultyCorrection || 1.0,
                  { predictedRounds: currentEnc.estimatedRounds || 4, actualRounds: combatSummary.rounds }
                );
                currentEnc.completed = true;
                gs.encounterPlanIndex = (gs.encounterPlanIndex || 0) + 1;
                db.setState(gameId, 'difficultyCorrection', gs.difficultyCorrection).catch(() => {});
              }
            }
          }
          // Save surviving/notable enemies to NPC memory
          if (!gs.npcMemory) gs.npcMemory = {};
          const combatants = gs.combatEngine.state.combatants || {};
          for (const [id, c] of Object.entries(combatants)) {
            if (c.type !== 'Enemy') continue;
            const hp = c.hp ?? c.totalHp ?? 0;
            const maxHp = c.maxHp ?? c.totalHp ?? 1;
            const survived = hp > 0;
            const wasSignificant = (c.personality || c.cr >= 2 || maxHp >= 30);

            if (survived || wasSignificant) {
              const key = c.name.toLowerCase().replace(/\s+\d+$/, ''); // Strip number suffix
              if (!gs.npcMemory[key]) gs.npcMemory[key] = { encounters: [] };
              gs.npcMemory[key].name = c.name;
              gs.npcMemory[key].personality = c.personality || '';
              gs.npcMemory[key].lastSeen = Date.now();
              gs.npcMemory[key].encounters.push({
                date: Date.now(),
                survived,
                hpRemaining: hp,
                fled: (c.morale === 'cowardly' || c.morale === 'normal') && hp > 0 && hp < maxHp * 0.5,
                roundsFought: gs.combatEngine.state.round,
                partyMembersPresent: Object.values(combatants).filter(x => x.type === 'PC').map(x => x.name),
              });
              // Keep last 5 encounters
              if (gs.npcMemory[key].encounters.length > 5) gs.npcMemory[key].encounters.shift();
            }
          }
          db.setState(gameId, 'npcMemory', gs.npcMemory).catch(() => {});

          io.to(gameId).emit('combat_ended', { reason: overCheck.reason });
        }
      }
    } catch (combatErr) {
      // Combat engine error — fall back to normal AI processing (no combat context)
      const errDetail = `[${new Date().toISOString()}] Combat engine error: ${combatErr.message}\n${combatErr.stack}\n---\n`;
      console.error('Combat engine error (falling back to AI):', combatErr.message, combatErr.stack?.split('\n').slice(0, 5).join(' | '));
      // Persist to in-memory error ring buffer (last 50 errors)
      if (!global._combatErrors) global._combatErrors = [];
      global._combatErrors.push(errDetail);
      if (global._combatErrors.length > 50) global._combatErrors.shift();
      // Don't end combat — just skip engine resolution for this turn and let AI narrate
      // The engine state is preserved so it can retry next turn
      combatContext = '\n\n[Server combat engine encountered an error this turn. Narrate this combat turn normally using dice rolls.]';
    }
  }

  const combatPromptInjection = combatActive ? `\n\nCOMBAT MODE ACTIVE — Server controls all combat.
DO NOT: roll dice, invent attack results, change HP, ask for initiative rolls, or resolve combat yourself.
DO: Narrate EVERY result from RESOLVED THIS ROUND as a bold dice line, then 1 sentence of flavor. That's it.
Format each result: **🎲 [who] [action] — rolls [total]. HIT/MISS! [damage]. [target] ([HP])**
ENEMY ATTACKS ON PCs are the most dramatic part — describe the PC getting hurt, bleeding, staggering.
KILLSHOT: [scene] when a target reaches 0 HP.
Keep narration SHORT — this is tactical combat, not a novel.` : '';
  const finalSystemPrompt = systemPrompt + combatPromptInjection;

  // Rebuild messages with combatContext appended to user message
  const messagesWithCombat = [
    ...gd.chatHistory,
    { role: 'user', content: prefix + userMessage + combatContext },
  ];

  // Streaming state machine
  let accumulatedText = '';
  let narrationText = '';
  let structuredBuffer = '';
  let state = 'NARRATING'; // NARRATING or BUFFERING
  let pendingTail = '';
  const LOOKAHEAD = 30; // chars to hold back for marker detection
  const markerRegex = /\n-{3,}\s*(?:OPTIONS|SCENE|WORLD)\s*-{3,}|\n#{1,3}\s*(?:OPTIONS?|SCENE|WORLD)\s*$/im;


  // Emit stream start
  io.to(gameId).emit('dm_stream_start', {
    auto: !!actingAs,
    player: actingAs || null,
  });

  let finalMessage;
  try {
    // Lower temperature for terse/brief = more instruction-following, less creative wandering
    const temperature = gs.verbosity === 'terse' ? 0.3 : gs.verbosity === 'brief' ? 0.5 : 0.8;

    const stream = await anthropic.messages.stream({
      model,
      max_tokens: maxTokens,
      temperature,
      system: [{ type: "text", text: finalSystemPrompt, cache_control: { type: "ephemeral" } }],
      messages: messagesWithCombat,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.text) {
        const delta = event.delta.text;
        accumulatedText += delta;

        if (state === 'NARRATING') {
          pendingTail += delta;
          const markerMatch = pendingTail.match(markerRegex);

          if (markerMatch) {
            // Flush everything before marker as narration
            const safeText = pendingTail.slice(0, markerMatch.index);
            if (safeText) {
              io.to(gameId).emit('dm_stream_chunk', { text: safeText });
              narrationText += safeText;
            }
            structuredBuffer = pendingTail.slice(markerMatch.index);
            pendingTail = '';
            state = 'BUFFERING';
          } else if (pendingTail.length > LOOKAHEAD) {
            const safeChunk = pendingTail.slice(0, -LOOKAHEAD);
            io.to(gameId).emit('dm_stream_chunk', { text: safeChunk });
            narrationText += safeChunk;
            pendingTail = pendingTail.slice(-LOOKAHEAD);
          }
        } else {
          structuredBuffer += delta;
        }
      }
    }

    // Flush remaining
    if (state === 'NARRATING' && pendingTail) {
      io.to(gameId).emit('dm_stream_chunk', { text: pendingTail });
      narrationText += pendingTail;
    }

    finalMessage = await stream.finalMessage();
  } catch (streamErr) {
    console.error('[stream] Error during streaming:', streamErr.message);
    io.to(gameId).emit('dm_stream_end', { narration: narrationText.trim() });
    throw streamErr;
  }

  const elapsed = Date.now() - startTime;
  const reply = accumulatedText;

  // Emit stream end with final narration for re-rendering
  io.to(gameId).emit('dm_stream_end', { narration: narrationText.trim() });

  // Log cost
  const inputTokens = finalMessage.usage?.input_tokens || 0;
  const outputTokens = finalMessage.usage?.output_tokens || 0;
  const cost = estimateCost(model, inputTokens, outputTokens);
  logCost({ gameId, model, inputTokens, outputTokens, cost, type: actingAs ? 'auto-action' : 'player-action' });
  console.log(`API call: ${model} | ${inputTokens}in/${outputTokens}out | $${cost.toFixed(4)} | ${elapsed}ms | ${actingAs ? 'auto' : 'human'}`);

  const parsed = parseResponse(reply);
  console.log(`[stream-debug] state=${state} narration=${narrationText.length}ch structured=${structuredBuffer.length}ch options=${parsed.options.length} scene=${!!parsed.scene} world=${!!parsed.world}`);

  // Include a minimal structured block in history so the AI sees the output format pattern
  const historyContent = parsed.narration +
    (parsed.options?.length ? '\n\n---OPTIONS---\n' + parsed.options.map((o, i) => `${i + 1}️⃣ ${o}`).join('\n') : '') +
    '\n\n---SCENE---\nACTION: ' + (parsed.scene?.action || 'continuing') + '\nMOOD: ' + (parsed.scene?.mood || 'neutral') + '\nNPC: ' + (parsed.scene?.npc || 'none');
  gd.chatHistory.push(
    { role: 'user', content: prefix + userMessage },
    { role: 'assistant', content: historyContent }
  );
  if (gd.chatHistory.length > MAX_CHAT_HISTORY) {
    gd.chatHistory = gd.chatHistory.slice(-MAX_CHAT_HISTORY);
  }

  // If no options were extracted and this isn't an auto-action, make a cheap follow-up call
  if (parsed.options.length === 0 && !actingAs) {
    try {
      const nextPlayer = getCurrentPlayer(gameId);
      const optionsResponse = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Given this narration from a ${gameConfig.system || 'D&D 5e'} game, suggest exactly 3 action options for ${nextPlayer || 'the next player'}. Output ONLY this format with number emojis, nothing else:\n\n1️⃣ 🗡️ [combat/practical action]\n2️⃣ 🛡️ [defensive/cautious action]\n3️⃣ 🔥 [wild/reckless/creative move]\n\nNarration: ${parsed.narration.slice(-500)}`,
        }],
      });
      const optLines = optionsResponse.content[0].text.split('\n')
        .filter(l => /^\d+\.\s/.test(l.trim()))
        .map(l => l.replace(/^\d+\.\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 3);
      if (optLines.length >= 2) parsed.options = optLines;
    } catch (e) {
      console.warn('[options-fallback] failed:', e.message);
    }
  }

  // Fallback: generate scene data if ---SCENE--- was missing
  if (!parsed.scene && parsed.narration && !actingAs) {
    const narrationSnippet = parsed.narration.slice(-300);
    // Extract a brief scene description from the narration
    const actionWords = narrationSnippet.match(/\b(?:attack|charge|cast|fight|enter|explore|sneak|flee|negotiate|search|climb|jump|run|dodge|block|heal|pray|steal|trap|ambush)\w*/i);
    const action = actionWords ? actionWords[0] : 'adventuring';
    parsed.scene = {
      action: action + ' in progress',
      mood: 'tense',
      npc: 'none',
      raw: `ACTION: ${action}\nMOOD: tense\nNPC: none`,
    };
  }

  // Process map hint (synchronous graph update)
  const mapResult = processMapHint(gs.mapGraph, parsed.worldRaw, parsed.world?.locations);

  // Apply character sheet updates in memory first
  if (parsed.world) {
    gs.world = parsed.world;
    if (parsed.world.charUpdates && parsed.world.charUpdates.length) {
      for (const update of parsed.world.charUpdates) {
        const char = gd.characters[update.character];
        if (char && ['statsText', 'personality', 'backstory', 'standardActions'].includes(update.field)) {
          char[update.field] = update.value;
        }
      }
    }
  }

  // Emit socket events FIRST so the player gets the response immediately
  if (parsed.world?.charUpdates?.length) {
    for (const update of parsed.world.charUpdates) {
      const char = gd.characters[update.character];
      if (char && ['statsText', 'personality', 'backstory', 'standardActions'].includes(update.field)) {
        io.to(gameId).emit('character_updated', {
          name: update.character,
          field: update.field,
          value: update.value,
          character: char,
        });
      }
    }
  }
  if (mapResult.moved) {
    io.to(gameId).emit('map_update', gs.mapGraph.toJSON());
    if (mapResult.isNew) {
      io.to(gameId).emit('map_inline', {
        location: mapResult.location,
        mapState: gs.mapGraph.toJSON(),
      });
    }
  }

  // Fire-and-forget DB writes (don't block response to player)
  const dbOps = [db.saveChatHistory(gameId, gd.chatHistory)];
  if (parsed.world) {
    dbOps.push(db.setState(gameId, 'world', gs.world));
    if (parsed.world.charUpdates && parsed.world.charUpdates.length) {
      for (const update of parsed.world.charUpdates) {
        const char = gd.characters[update.character];
        if (char && ['statsText', 'personality', 'backstory', 'standardActions'].includes(update.field)) {
          dbOps.push(db.upsertCharacter(gameId, update.character, char));
        }
      }
    }
  }
  if (mapResult.moved) {
    dbOps.push(db.setState(gameId, 'map', gs.mapGraph.toJSON()));
  }
  Promise.all(dbOps).catch(err => console.error('[db-write] Error:', err.message));

  // Queue world art generation for new locations/NPCs with image prompts
  if (parsed.world) {
    const artQueue = [];
    for (const loc of (parsed.world.locations || [])) {
      if (loc.imagePrompt) {
        const existing = gs.world?.locations?.find(l => l.name.toLowerCase() === loc.name.toLowerCase());
        const hasImage = existing?.imageUrl && !loc.imageUpdate;
        if (!hasImage) {
          artQueue.push({ type: 'location', name: loc.name, prompt: loc.imagePrompt, isUpdate: loc.imageUpdate });
        }
      }
    }
    for (const npc of (parsed.world.npcs || [])) {
      if (npc.imagePrompt) {
        const existing = gs.world?.npcs?.find(n => n.name.toLowerCase() === npc.name.toLowerCase());
        const hasImage = existing?.imageUrl && !npc.imageUpdate;
        if (!hasImage) {
          artQueue.push({ type: 'npc', name: npc.name, prompt: npc.imagePrompt, isUpdate: npc.imageUpdate });
        }
      }
    }
    for (const item of artQueue.slice(0, 2)) {
      generateWorldArt(gameId, item).catch(err => console.error('Art gen failed:', err.message));
    }
  }

  // Initiate combat — two paths:
  // Path 1: AI outputs formal ENEMIES: block (ideal)
  if (parsed.world?.enemies?.length > 0 && !gs.combatEngine.state.active) {
    initiateCombat(gameId, gameConfig, parsed.world.enemies).catch(e => console.error('Combat init error:', e));
  }
  // Path 2: AI narrates combat without ENEMIES: block — server takes over
  // Only trigger on strong combat signals (actual attacks/charges, not just monster mentions)
  if (!gs.combatEngine.state.active && !parsed.world?.enemies?.length) {
    const strongCombatSignal = /(?:roll(?:s|ing)?\s+(?:for\s+)?initiative|initiative.*(?:order|roll)|combat\s+(?:begins|starts|erupts|breaks out)|(?:goblin|orc|skeleton|zombie|wolf|rat|bandit|dragon|troll|ogre|spider|kobold|gnoll|bugbear|hobgoblin|cultist|thug|guard|knight|wraith|ghoul|ghast|wight|vampire|demon|devil|elemental|giant|minotaur|owlbear|manticore|hydra|chimera|basilisk|beholder|lich|golem|treant|werewolf)s?\s+(?:attack|lunge|charge|burst|leap|rush|swing|slash|stab|strike|pounce|ambush|emerge|appear|surround|block|engage)s?\b|(?:attacks?\s+(?:you|the party|with)|charges?\s+(?:at|toward|into)|ambush(?:ed|es)?!?|lunges?\s+(?:at|toward)|strikes?\s+(?:at|with)|draws?\s+(?:its |their )?(?:sword|weapon|blade|axe|bow)|weapons?\s+drawn|swords?\s+(?:raised|drawn|flashing)|prepare(?:s)?\s+to\s+(?:fight|attack|strike)|hostile|ready\s+(?:their|your)\s+weapons?))/i;
    if (strongCombatSignal.test(parsed.narration || '')) {
      // Try encounter plan first
      let enemies = null;
      if (gs.encounterPlan) {
        const nextCombat = gs.encounterPlan.encounters.find(
          (e, i) => i >= (gs.encounterPlanIndex || 0) && e.pillar === 'combat' && !e.completed && !e.rest
        );
        if (nextCombat?.monsters?.length > 0) {
          enemies = nextCombat.monsters.map(m => ({
            displayName: m.name || m.displayName, count: m.count, slug: m.slug, hint: null,
          }));
        }
      }

      // Fallback: extract monster names from narration and look them up
      if (!enemies) {
        const monsterDB = require('./monster-lookup').loadDefaultMonsters(gameConfig.system || 'dnd5e');
        const monsterSlugs = Object.keys(monsterDB);
        const found = [];
        for (const slug of monsterSlugs) {
          const name = monsterDB[slug].name;
          if (name && new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 's?\\b', 'i').test(parsed.narration)) {
            found.push({ displayName: name, count: 1, slug, hint: null });
          }
        }
        // Pick up to 4 unique monsters mentioned
        if (found.length > 0) enemies = found.slice(0, 4);
      }

      if (enemies?.length > 0) {
        console.log(`[auto-combat] Server taking over combat: ${enemies.map(e => `${e.count}x ${e.displayName}`).join(', ')}`);
        initiateCombat(gameId, gameConfig, enemies).catch(e => console.error('Auto-combat init error:', e));
      }
    }
  }

  // Desync fix: AI narrated combat ending but engine still active → force-end engine
  if (gs.combatEngine.state.active && !combatActive) {
    // combatActive was true at start of this call but engine might have ended mid-resolution
    // This handles the case where AI says combat is over but engine disagrees
  }
  if (gs.combatEngine.state.active) {
    const aiSaysCombatOver = /(?:combat\s+(?:is\s+)?(?:over|ended|resolved|finished)|(?:all|the)\s+(?:enemies|monsters|foes|skeletons|goblins|orcs)\s+(?:are\s+)?(?:dead|defeated|slain|fallen|destroyed)|victory|(?:last|final)\s+(?:enemy|monster|foe)\s+(?:falls|drops|crumbles|collapses))/i;
    if (aiSaysCombatOver.test(parsed.narration || '')) {
      console.log(`[desync] AI narrated combat end but engine still active — force-ending combat`);
      gs.combatEngine.endCombat();
      persistCombatState(gameId);
      io.to(gameId).emit('combat_ended', { reason: 'enemies_defeated' });
    }
  }

  // Path 3: Encounter plan enforcement — if plan says next encounter should happen, force it
  if (!gs.combatEngine.state.active && gs.encounterPlan) {
    if (!gs._turnsSinceLastEncounter) gs._turnsSinceLastEncounter = 0;
    gs._turnsSinceLastEncounter++;

    const nextEnc = gs.encounterPlan.encounters.find(
      (e, i) => i >= (gs.encounterPlanIndex || 0) && !e.completed && !e.rest
    );

    // After 3 turns of exploration, force the next planned encounter
    if (nextEnc && gs._turnsSinceLastEncounter >= 3) {
      if (nextEnc.pillar === 'combat' && nextEnc.monsters?.length > 0) {
        console.log(`[encounter-plan] Forcing combat encounter after ${gs._turnsSinceLastEncounter} exploration turns`);
        const enemies = nextEnc.monsters.map(m => ({
          displayName: m.name || m.displayName, count: m.count, slug: m.slug, hint: null,
        }));
        initiateCombat(gameId, gameConfig, enemies).catch(e => console.error('Forced combat init error:', e));
        gs._turnsSinceLastEncounter = 0;
        nextEnc.completed = true;
        gs.encounterPlanIndex = (gs.encounterPlanIndex || 0) + 1;
      } else if (nextEnc.pillar === 'social' || nextEnc.pillar === 'exploration') {
        // Inject challenge guidance into next prompt via game state
        gs._pendingChallenge = nextEnc;
        gs._turnsSinceLastEncounter = 0;
        nextEnc.completed = true;
        gs.encounterPlanIndex = (gs.encounterPlanIndex || 0) + 1;
      }
    }
  }

  // Reset encounter counter when combat starts or ends
  if (gs.combatEngine.state.active) {
    gs._turnsSinceLastEncounter = 0;
  }

  // Pre-parse options for next combat turn
  if (gs.combatEngine.state.active && parsed.options?.length > 0) {
    const nextPlayer = gs.combatEngine.getCurrentTurn();
    if (nextPlayer) {
      const combatCtx = { combatants: gs.combatEngine.state.combatants };
      const tier1 = parseOptions(parsed.options, nextPlayer.id, combatCtx);
      if (tier1.some(r => r === null)) {
        parseOptionsWithAI(parsed.options, nextPlayer.id, combatCtx, anthropic)
          .then(results => { gs.preTaggedOptions = results; }).catch(() => {});
      } else {
        gs.preTaggedOptions = tier1;
      }
    }
  }

  // Emit combat update
  if (gs.combatEngine.state.active) emitCombatUpdate(gameId);

  // Refresh rolling summary every 50 turns (tracked via turnCount)
  if (gs.turnCount > 0 && gs.turnCount % 50 === 0) {
    refreshStorySummary(gameId, gameConfig).catch(console.error);
  }

  parsed.mapMoved = mapResult.moved;
  return parsed;
}

module.exports = {
  init,
  callClaude,
  legacyCallClaude,
  refreshStorySummary,
};
