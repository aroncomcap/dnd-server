const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const Together = require('together-ai');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const cookieParser = require('cookie-parser');
const passport = require('passport');
const db = require('./db');
const discord = require('./discord-bot');
const { MapGraph, processMapHint } = require('./map-engine');
const { router: authRouter, authMiddleware, requireAuth, requireAdmin } = require('./auth');

const DEPLOY_TIME = new Date().toISOString();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(cookieParser());
app.use(passport.initialize());
app.use(authRouter);
app.use(authMiddleware); // Attaches req.user to all requests (non-blocking)
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const together = new Together({ apiKey: process.env.TOGETHER_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const DEFAULT_TURN_DURATION = 180; // seconds
const IMAGE_COOLDOWN = 2;
const MAX_CONTEXT_CHARS = 50000;

// ── Per-game in-memory state ─────────────────────────────────────────────────
const games = {}; // gameId -> { data, turnTimer, turnCount, imageUrl }

function getGameState(gameId) {
  if (!games[gameId]) {
    games[gameId] = {
      data: { characters: {}, chatHistory: [], currentTurnIndex: 0, turnOrder: [] },
      turnTimer: null,
      turnCount: 0,
      imageUrl: null,
      turnDuration: DEFAULT_TURN_DURATION,
      verbosity: 'verbose',
      ferocity: 5,
      pillars: { exploration: 33, combat: 33, social: 34 },
      lastOptions: [],
      lastForPlayer: null,
      idleTurns: 0,
      paused: false,
      mapGraph: new MapGraph(),
    };
  }
  return games[gameId];
}

// ── Broadcast helpers (Socket.io + Discord) ──────────────────────────────────
function emitDmMessage(gameId, data) {
  // Save last options for reconnects
  const gs = games[gameId];
  if (gs && data.options?.length) {
    gs.lastOptions = data.options;
    gs.lastForPlayer = data.forPlayer;
  }
  io.to(gameId).emit('dm_message', data);
  discord.onDmMessage(gameId, data).catch(e => console.error('Discord dm_message error:', e.message));
}
function emitTurnChange(gameId, data) {
  io.to(gameId).emit('turn_change', data);
  discord.onTurnChange(gameId, data).catch(e => console.error('Discord turn_change error:', e.message));
}
function emitSystem(gameId, data) {
  io.to(gameId).emit('system', data);
  discord.onSystem(gameId, data).catch(e => console.error('Discord system error:', e.message));
}
function emitSceneImage(gameId, data) {
  io.to(gameId).emit('scene_image', data);
  discord.onSceneImage(gameId, data).catch(e => console.error('Discord scene_image error:', e.message));
}
function emitCharacterToken(gameId, data) {
  io.to(gameId).emit('character_token', data);
  discord.onCharacterToken(gameId, data).catch(e => console.error('Discord token error:', e.message));
}

// ── System Prompts per Game System ───────────────────────────────────────────
const SYSTEM_PROMPTS = {
  dnd5e: `You are the Dungeon Master for a live multiplayer Dungeons & Dragons 5th Edition game.`,
  runequest: `You are the Game Master for a live multiplayer RuneQuest: Roleplaying in Glorantha game.
Use RuneQuest rules: percentile-based skill checks (roll under skill%), Rune magic, Spirit magic, Hit Locations, Strike Ranks.
Combat uses Strike Rank initiative. Damage applies to specific hit locations with armor reducing damage.
Passions (Love, Hate, Honor, Loyalty, Devotion) can augment skill rolls.
Rune affinities (Air, Earth, Fire/Sky, Water, Darkness, Moon) influence magic and personality.`,
  custom: `You are the Game Master for a live multiplayer tabletop RPG session.`,
};

function buildSystemPrompt(gameId, gameConfig) {
  const gs = getGameState(gameId);
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

  const basePrompt = SYSTEM_PROMPTS[gameConfig.system] || SYSTEM_PROMPTS.custom;

  let contextBlock = '';
  if (gameConfig.custom_context) {
    contextBlock = `\n\nCAMPAIGN SOURCE MATERIAL:\n${gameConfig.custom_context.slice(0, MAX_CONTEXT_CHARS)}`;
    if (gameConfig.custom_context.length > MAX_CONTEXT_CHARS) {
      contextBlock += '\n[...truncated — source material exceeds limit]';
    }
  }

  return `${basePrompt}
${contextBlock}

CHARACTERS IN THIS CAMPAIGN:
${characterBlock || 'No characters registered yet.'}

VERBOSITY: ${gs.verbosity || 'verbose'}
${gs.verbosity === 'terse' ? '- Keep responses to 1-2 sentences. Just the action and result, nothing else.' :
  gs.verbosity === 'brief' ? '- Keep responses to 50-80 words. Hit the key beats concisely.' :
  '- Keep responses to 200 words MAX, with a strong bias towards 50-100 words unless there is a significant plot point, dramatic reveal, or important narrative moment that justifies more. Shorter is almost always better.'}

FEROCITY: ${gs.ferocity ?? 5}/5
${gs.ferocity <= 1 ? '- Encounters are EXTREMELY deadly. Enemies are powerful, numerous, and tactically smart. Death is likely without clever play. However, treasure rewards are VERY generous — rare magic items, large gold hoards, and powerful artifacts appear frequently.' :
  gs.ferocity <= 2 ? '- Encounters are very dangerous. Enemies hit hard and use tactics. Survival requires good decisions. Treasure is generous — good magic items and substantial gold.' :
  gs.ferocity <= 3 ? '- Encounters are moderately challenging. A balanced mix of danger and reward. Standard treasure for the party level with occasional magic items.' :
  gs.ferocity <= 4 ? '- Encounters are light challenges. Enemies are beatable without much risk. Modest treasure rewards.' :
  '- Encounters are easy and forgiving. Enemies are weak or few. Minimal treasure — mostly coins and mundane items.'}

THREE PILLARS OF PLAY (target weighting):
- Exploration: ${gs.pillars?.exploration ?? 33}% | Combat: ${gs.pillars?.combat ?? 33}% | Social: ${gs.pillars?.social ?? 34}%
- Over the course of a session, aim for this ratio. If one pillar has been neglected, steer towards it.
- Each pillar should involve meaningful challenges that test character skills:
  * Exploration: perception, survival, investigation, knowledge checks, traps, puzzles, navigation
  * Combat: attack rolls, saving throws, tactical positioning, damage, conditions, initiative
  * Social: persuasion, intimidation, deception, insight, diplomacy, bargaining, interrogation

SKILL TEST PACING:
- CRITICAL: Include a skill test, ability check, or game mechanic roll with MOST character actions — at minimum every other action.
- If two consecutive turns pass without any dice roll or skill check, the pace is too slow. Introduce a challenge, obstacle, or situation that demands a roll.
- Skill tests drive advancement. Without them, characters don't grow. Make tests feel natural and consequential.
- If characters are wandering or stalling, gently push the action forward: an NPC interrupts, a sound is heard, a danger emerges, a clue appears.

RULES:
- Track HP, conditions, spells, powers, and resources accurately. Apply game rules correctly.
- When acting for an absent player, weigh their standard actions and personality heavily, but adapt to context.
- Keep the story moving. If players seem stuck, nudge them forward.
- If campaign source material is provided above, use it to guide the adventure, encounters, NPCs, and lore.
- Encourage banter between player characters and between PCs and NPCs. Have NPCs react to players with personality — tease, joke, challenge, flirt, argue. Make the world feel alive through dialogue.
- If a character has catchphrases listed, weave them naturally into narration or dialogue SPARINGLY — at most 1-2 times per real-world day across all turns. Don't force them; use them when the moment fits.

SPELLS, POWERS & RESOURCES:
- Track all spells, powers, abilities, and limited-use resources for each character.
- When a spell/power is cast or used, note the expenditure. When rested or restored, note the recovery.
- Include current spell slots, power points, rune points, or whatever the system uses in character updates.
- If a character tries to use a spent resource, inform them it's unavailable.

TREASURE & LOOT:
- When encounters include treasure, distribute it as a published module would — a mix of coins, mundane items, and occasional magical items appropriate to the party's level/power.
- Magical items should be rare and exciting. Mundane treasure should be realistic for the setting.
- Always announce treasure clearly so players can divide it.

CHARACTER ADVANCEMENT:
- Track experience points (D&D 5e), skill improvement rolls (RuneQuest), or whatever advancement mechanic the system uses.
- Award XP/advancement after combat, quest completion, and clever roleplay as the system specifies.
- When a character reaches a level-up threshold or earns a skill increase:
  1. Announce it prominently: "🎉 [NAME] has leveled up to Level X!" or "🎉 [NAME]'s Sword skill increases to 80%!"
  2. Include the full updated stats in CHAR_UPDATES
  3. Add the advancement to ACCOMPLISHMENTS

COMBAT:
- Run combat with proper initiative, attack rolls, damage, and tactical options.
- When a significant enemy is defeated (boss, tough monster, named NPC), include a special scene description:
  Put "KILLSHOT:" before the scene description to trigger a dramatic illustration.
  Example: KILLSHOT: Kael drives his flaming sword through the dragon's chest as lightning crackles around them, the beast collapsing in a shower of sparks

FORMATTING — SKILL ROLLS & GAME MECHANICS:
- Any time there is a skill check, saving throw, attack roll, damage roll, or other game mechanic, put it on its own line with a blank line before and after, wrapped in **double asterisks** for bold.

ACTION OPTIONS:
- At the end of EVERY response (except auto-actions), present exactly 4 action choices for the next player.
- At least one wild/reckless move (🔥) and one witty/social move (💬).
- Use this EXACT format:

---OPTIONS---
1. 🗡️ [a combat or practical action]
2. 🛡️ [a defensive or cautious action]
3. 🔥 [a wild, reckless, or creative move]
4. 💬 [a witty comment, taunt, or clever social move]

TRAVEL & MOVEMENT:
- Narrate journeys realistically with distance, terrain, mode of travel.
- Multi-turn travel may involve encounters. "Go directly to [location]" fast-forwards.

OUTPUT FORMAT (use this EXACT order at the end of every response):

---OPTIONS---
1. 🗡️ [a combat or practical action]
2. 🛡️ [a defensive or cautious action]
3. 🔥 [a wild, reckless, or creative move]
4. 💬 [a witty comment, taunt, or clever social move]

---SCENE---
[One sentence describing the visual scene for image generation. Painterly fantasy art style. No text.]

---WORLD---
LOCATIONS:
- [Location Name] | [Brief description] | [Distance/travel time from current position]
NPCS:
- [NPC Name] | [Brief description] | [Current/last known location]
ACCOMPLISHMENTS:
- [Character Name] | [Achievement description]
CHAR_UPDATES:
- [Character Name] | [field] | [new value]

MAP: [Current location name — where the party is RIGHT NOW after this turn's action]

Valid fields: statsText, personality, backstory, standardActions
Include CHAR_UPDATES whenever: leveling up, gaining items, learning spells, stat changes, spell slot usage/recovery, skill improvements.`;
}

// ── Parsing (single-pass, order-independent) ─────────────────────────────────
function parseResponse(text) {
  // Split on all three markers in one pass
  const markers = ['---OPTIONS---', '---SCENE---', '---WORLD---'];
  let narration = text;
  let optionsRaw = '';
  let sceneRaw = '';
  let worldRaw = '';

  // Find all marker positions
  const positions = markers.map(m => ({ marker: m, idx: text.indexOf(m) })).filter(p => p.idx !== -1);
  positions.sort((a, b) => a.idx - b.idx);

  if (positions.length > 0) {
    narration = text.slice(0, positions[0].idx).trim();
    for (let i = 0; i < positions.length; i++) {
      const start = positions[i].idx + positions[i].marker.length;
      const end = i + 1 < positions.length ? positions[i + 1].idx : text.length;
      const block = text.slice(start, end).trim();
      if (positions[i].marker === '---OPTIONS---') optionsRaw = block;
      else if (positions[i].marker === '---SCENE---') sceneRaw = block;
      else if (positions[i].marker === '---WORLD---') worldRaw = block;
    }
  }

  // Parse options
  const options = optionsRaw ? optionsRaw.split('\n')
    .map(line => line.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean) : [];

  // Parse scene + killshot
  let scene = sceneRaw || null;
  let isKillshot = false;
  if (scene && scene.startsWith('KILLSHOT:')) {
    scene = scene.slice(9).trim();
    isKillshot = true;
  }

  // Parse world
  let world = null;
  if (worldRaw) {
    const locations = [];
    const npcs = [];
    const accomplishments = [];
    const charUpdates = [];
    let section = null;
    for (const line of worldRaw.split('\n')) {
      const trimmed = line.trim();
      if (/^LOCATIONS:/i.test(trimmed)) { section = 'locations'; continue; }
      if (/^NPCS:/i.test(trimmed)) { section = 'npcs'; continue; }
      if (/^ACCOMPLISHMENTS:/i.test(trimmed)) { section = 'accomplishments'; continue; }
      if (/^CHAR_UPDATES:/i.test(trimmed)) { section = 'char_updates'; continue; }
      if (trimmed.startsWith('- ') && section) {
        const parts = trimmed.slice(2).split('|').map(s => s.trim());
        if (section === 'locations') {
          locations.push({ name: parts[0], description: parts[1] || '', distance: parts[2] || '' });
        } else if (section === 'npcs') {
          npcs.push({ name: parts[0], description: parts[1] || '', location: parts[2] || '' });
        } else if (section === 'accomplishments') {
          accomplishments.push({ character: parts[0], achievement: parts[1] || '' });
        } else if (section === 'char_updates') {
          charUpdates.push({ character: parts[0], field: parts[1] || '', value: parts[2] || '' });
        }
      }
    }
    world = { locations, npcs, accomplishments, charUpdates };
  }

  return { narration, options, scene, world, isKillshot, worldRaw: worldRaw || '' };
}

// ── Character Token Generation ───────────────────────────────────────────────
async function generateCharacterToken(name, charData) {
  if (!process.env.TOGETHER_API_KEY) return null;
  try {
    const desc = [charData.statsText, charData.personality, charData.backstory].filter(Boolean).join('. ');
    const prompt = `Fantasy RPG character portrait token, circular frame, dark background. Character: ${name}. ${desc.slice(0, 600)}. Detailed face and upper body, dramatic lighting, painterly style. No text or words.`;
    const response = await together.images.generate({
      model: 'black-forest-labs/FLUX.1-schnell',
      prompt: prompt.slice(0, 1000),
      width: 512,
      height: 512,
      steps: 4,
      n: 1,
      response_format: 'b64_json',
    });
    const b64 = response.data[0]?.b64_json;
    if (!b64) return null;
    return `data:image/png;base64,${b64}`;
  } catch (err) {
    console.error('Token generation failed:', err.message);
    return null;
  }
}

// ── Image Generation (Together AI / FLUX) ────────────────────────────────────
async function generateSceneImage(scene, gameConfig) {
  if (!process.env.TOGETHER_API_KEY || !scene) return null;
  try {
    const style = gameConfig.image_style || 'fantasy illustration';
    const prompt = `${style}: ${scene}. No text or words in the image.`;
    const response = await together.images.generate({
      model: 'black-forest-labs/FLUX.1-schnell',
      prompt: prompt.slice(0, 1000),
      width: 1024,
      height: 768,
      steps: 4,
      n: 1,
      response_format: 'b64_json',
    });
    const b64 = response.data[0]?.b64_json;
    if (!b64) return null;
    return `data:image/png;base64,${b64}`;
  } catch (err) {
    console.error('Image generation failed:', err.message);
    return null;
  }
}

// ── Cost Tracking & Rate Limiting ─────────────────────────────────────────────
const MODEL_COSTS = { // per 1M tokens (input/output)
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-4-6': { input: 15.00, output: 75.00 },
};
const IMAGE_COST = 0.003; // per Together AI FLUX image
const costLog = []; // { timestamp, gameId, model, inputTokens, outputTokens, cost, type }

function estimateCost(model, inputTokens, outputTokens) {
  const rates = MODEL_COSTS[model] || MODEL_COSTS['claude-haiku-4-5-20251001'];
  return (inputTokens / 1_000_000 * rates.input) + (outputTokens / 1_000_000 * rates.output);
}

function logCost(entry) {
  costLog.push({ ...entry, timestamp: Date.now() });
  // Keep last 24h
  const cutoff = Date.now() - 86400000;
  while (costLog.length && costLog[0].timestamp < cutoff) costLog.shift();
}

function getCostSummary() {
  const now = Date.now();
  const lastHour = costLog.filter(e => now - e.timestamp < 3600000);
  const last24h = costLog;
  const hourTotal = lastHour.reduce((s, e) => s + (e.cost || 0), 0);
  const dayTotal = last24h.reduce((s, e) => s + (e.cost || 0), 0);
  const hourCalls = lastHour.length;
  const dayCalls = last24h.length;
  // Project hourly rate
  const projected = hourCalls > 0 ? hourTotal : (dayCalls > 0 ? dayTotal / 24 : 0);
  return {
    lastHour: { calls: hourCalls, cost: Math.round(hourTotal * 100) / 100 },
    last24h: { calls: dayCalls, cost: Math.round(dayTotal * 100) / 100 },
    projectedHourly: Math.round(projected * 100) / 100,
    projectedDaily: Math.round(projected * 24 * 100) / 100,
  };
}

const apiCallLog = {}; // gameId -> [timestamps]
const MAX_CALLS_PER_HOUR = 60;

function checkRateLimit(gameId) {
  const now = Date.now();
  if (!apiCallLog[gameId]) apiCallLog[gameId] = [];
  // Prune old entries
  apiCallLog[gameId] = apiCallLog[gameId].filter(t => now - t < 3600000);
  if (apiCallLog[gameId].length >= MAX_CALLS_PER_HOUR) {
    console.error(`Rate limit hit for game ${gameId}: ${apiCallLog[gameId].length} calls in last hour`);
    return false;
  }
  apiCallLog[gameId].push(now);
  return true;
}

// ── Claude Call (scoped to a game) ───────────────────────────────────────────
async function callClaude(gameId, gameConfig, userMessage, actingAs = null) {
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

  const messages = [
    ...gd.chatHistory,
    { role: 'user', content: prefix + userMessage },
  ];

  const model = gameConfig?.model || 'claude-haiku-4-5-20251001';
  const response = await anthropic.messages.create({
    model,
    max_tokens: 2048,
    system: buildSystemPrompt(gameId, gameConfig),
    messages,
  });

  const reply = response.content[0].text;

  // Log cost
  const inputTokens = response.usage?.input_tokens || 0;
  const outputTokens = response.usage?.output_tokens || 0;
  const cost = estimateCost(model, inputTokens, outputTokens);
  logCost({ gameId, model, inputTokens, outputTokens, cost, type: actingAs ? 'auto-action' : 'player-action' });
  console.log(`API call: ${model} | ${inputTokens}in/${outputTokens}out | $${cost.toFixed(4)} | ${actingAs ? 'auto' : 'human'}`);

  gd.chatHistory.push(
    { role: 'user', content: prefix + userMessage },
    { role: 'assistant', content: reply }
  );
  if (gd.chatHistory.length > 80) {
    gd.chatHistory = gd.chatHistory.slice(-80);
  }
  await db.saveChatHistory(gameId, gd.chatHistory);

  const parsed = parseResponse(reply);

  // Save world data if present
  if (parsed.world) {
    gs.world = parsed.world;
    await db.setState(gameId, 'world', parsed.world);

    // Apply character sheet updates
    if (parsed.world.charUpdates && parsed.world.charUpdates.length) {
      for (const update of parsed.world.charUpdates) {
        const char = gd.characters[update.character];
        if (char && ['statsText', 'personality', 'backstory', 'standardActions'].includes(update.field)) {
          char[update.field] = update.value;
          await db.upsertCharacter(gameId, update.character, char);
          io.to(gameId).emit('character_updated', {
            name: update.character,
            field: update.field,
            value: update.value,
            character: char,
          });
        }
      }
    }
  }

  // Process map hint
  const mapResult = processMapHint(gs.mapGraph, parsed.worldRaw, parsed.world?.locations);
  if (mapResult.moved) {
    await db.setState(gameId, 'map', gs.mapGraph.toJSON());
    io.to(gameId).emit('map_update', gs.mapGraph.toJSON());
    if (mapResult.isNew) {
      io.to(gameId).emit('map_inline', {
        location: mapResult.location,
        mapState: gs.mapGraph.toJSON(),
      });
    }
  }

  return parsed;
}

// ── Turn Management (scoped to a game) ───────────────────────────────────────
function getCurrentPlayer(gameId) {
  const gs = getGameState(gameId);
  const { turnOrder, currentTurnIndex } = gs.data;
  if (!turnOrder.length) return null;
  return turnOrder[currentTurnIndex % turnOrder.length];
}

function getConnectedClients(gameId) {
  const room = io.sockets.adapter.rooms.get(gameId);
  return room ? room.size : 0;
}

function startTurnTimer(gameId, gameConfig, playerName) {
  const gs = getGameState(gameId);
  clearTimeout(gs.turnTimer);

  // Safety: don't start timer if no humans are connected or game is paused
  if (getConnectedClients(gameId) === 0 || gs.paused) {
    console.log(`Timer not started for ${gameId}: ${gs.paused ? 'paused' : 'no clients'}`);
    return;
  }

  gs.turnTimer = setTimeout(async () => {
    // Double-check: still have connected clients?
    if (getConnectedClients(gameId) === 0) {
      console.log(`Auto-action aborted for ${gameId}: no clients connected`);
      return;
    }

    const char = gs.data.characters[playerName];
    const autoPrompt = char
      ? `It is ${playerName}'s turn but they did not respond. Act on their behalf as their character (${char.class}, personality: ${char.personality}). Choose the most fitting action given the current situation and their standard actions: ${char.standardActions || 'none'}. Narrate what they do.`
      : `It is ${playerName}'s turn but they did not respond. Have them take a cautious, sensible action.`;

    emitSystem(gameId, { text: `⏰ ${playerName} ran out of time. Claude is acting for them...` });

    try {
      const { narration, options, scene, world, isKillshot } = await callClaude(gameId, gameConfig, autoPrompt, playerName);
      const gs2 = getGameState(gameId);
      const nextIdx = (gs2.data.currentTurnIndex + 1) % (gs2.data.turnOrder.length || 1);
      const nextPlayer = gs2.data.turnOrder[nextIdx] || null;
      emitDmMessage(gameId, { text: narration, options, auto: true, player: playerName, forPlayer: nextPlayer, world });
      await maybeGenerateImage(gameId, gameConfig, scene, isKillshot);
      advanceTurn(gameId, gameConfig, false);
    } catch (err) {
      emitSystem(gameId, { text: 'Error during auto-action.' });
    }
  }, gs.turnDuration * 1000);
}

async function advanceTurn(gameId, gameConfig, wasHumanAction = false) {
  const gs = getGameState(gameId);
  const gd = gs.data;

  // Track idle turns
  if (wasHumanAction) {
    gs.idleTurns = 0;
  } else {
    gs.idleTurns = (gs.idleTurns || 0) + 1;
  }

  // Pause after 2 consecutive idle turns (prevents runaway API costs)
  if (gs.idleTurns >= 2) {
    gs.paused = true;
    clearTimeout(gs.turnTimer);
    emitSystem(gameId, { text: '⏸️ Game paused — no human actions for 5 turns. Use /tt start or tap Begin to resume.' });
    io.to(gameId).emit('game_paused');
    return;
  }

  gd.currentTurnIndex = (gd.currentTurnIndex + 1) % (gd.turnOrder.length || 1);
  await db.saveTurnState(gameId, gd.currentTurnIndex, gd.turnOrder);
  const next = getCurrentPlayer(gameId);
  if (next) {
    const token = gd.characters[next]?.token || null;
    emitTurnChange(gameId, { player: next, duration: gs.turnDuration * 1000, token });
    startTurnTimer(gameId, gameConfig, next);
  }
}

async function maybeGenerateImage(gameId, gameConfig, scene, isKillshot = false) {
  const gs = getGameState(gameId);
  gs.turnCount++;
  const shouldGenerate = isKillshot || (gs.turnCount % IMAGE_COOLDOWN === 0 && scene);
  if (shouldGenerate && scene) {
    io.to(gameId).emit('scene_generating');
    generateSceneImage(scene, gameConfig).then(url => {
      if (url) {
        gs.imageUrl = url;
        emitSceneImage(gameId, { url });
        logCost({ gameId, model: 'FLUX', inputTokens: 0, outputTokens: 0, cost: IMAGE_COST, type: 'scene-image' });
      } else {
        io.to(gameId).emit('scene_gen_failed');
      }
    });
  }
}

// ── REST API ─────────────────────────────────────────────────────────────────
app.get('/api/games', async (req, res) => {
  try {
    const gamesList = await db.listGames();
    // Attach player count from in-memory
    const enriched = gamesList.map(g => ({
      ...g,
      playerCount: Object.keys(getGameState(g.id).data.characters).length,
    }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/games', async (req, res) => {
  try {
    const { name, system } = req.body;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      || crypto.randomBytes(4).toString('hex');
    await db.createGame(id, name, system || 'dnd5e');
    const game = await db.getGame(id);
    res.json(game);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/games/:id/upload-pdf', upload.array('pdfs', 10), async (req, res) => {
  try {
    const game = await db.getGame(req.params.id);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    let allText = game.custom_context || '';
    for (const file of req.files) {
      const data = await pdfParse(file.buffer);
      allText += `\n\n--- ${file.originalname} ---\n${data.text}`;
    }

    await db.updateGameContext(game.id, allText);

    // Seed map with location names from PDF
    const gs = getGameState(req.params.id);
    const locationPattern = /(?:^|\n)(?:#{1,3}\s+)?([A-Z][A-Za-z\s''-]{2,30})(?:\n|$)/gm;
    let match;
    const skip = /^(chapter|appendix|introduction|table|figure|page|index|contents|credits|about|section|part|summary|overview)/i;
    while ((match = locationPattern.exec(allText)) !== null) {
      const name = match[1].trim();
      if (!skip.test(name) && name.split(' ').length <= 5) {
        gs.mapGraph.addNode(name, { level: 'world', description: 'From campaign source' });
      }
    }
    await db.setState(req.params.id, 'map', gs.mapGraph.toJSON());

    res.json({ success: true, totalChars: allText.length, files: req.files.map(f => f.originalname), mapNodes: Object.keys(gs.mapGraph.nodes).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/games/:id/model', async (req, res) => {
  try {
    const { model } = req.body;
    const valid = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'];
    if (!valid.includes(model)) return res.status(400).json({ error: 'Invalid model' });
    await db.pool.query('UPDATE games SET model = $1 WHERE id = $2', [model, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/deploy-time', (req, res) => {
  res.json({ deployTime: DEPLOY_TIME });
});

app.get('/api/costs', (req, res) => {
  const summary = getCostSummary();
  const games_detail = {};
  for (const entry of costLog) {
    if (!games_detail[entry.gameId]) games_detail[entry.gameId] = { calls: 0, cost: 0 };
    games_detail[entry.gameId].calls++;
    games_detail[entry.gameId].cost += entry.cost || 0;
  }
  res.json({ ...summary, games: games_detail, recentCalls: costLog.slice(-20) });
});

app.delete('/api/games/:id', async (req, res) => {
  try {
    const gameId = req.params.id;
    const gs = games[gameId];
    if (gs) {
      clearTimeout(gs.turnTimer);
      delete games[gameId];
    }
    await db.deleteGame(gameId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve game page for any game slug
app.get('/game/:gameId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

// ── Socket Events ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Join a game room
  socket.on('join_game', async (gameId) => {
    const game = await db.getGame(gameId);
    if (!game) {
      socket.emit('error_msg', { text: 'Game not found.' });
      return;
    }

    socket.join(gameId);
    socket.gameId = gameId;

    // Load from DB if not cached
    if (!games[gameId]) {
      const gs = getGameState(gameId);
      gs.data = await db.loadGameData(gameId);
      gs.world = await db.getState(gameId, 'world', { locations: [], npcs: [] });
      const mapData = await db.getState(gameId, 'map', null);
      if (mapData) gs.mapGraph = new MapGraph(mapData);
      gs.ferocity = await db.getState(gameId, 'ferocity', 5);
      gs.verbosity = await db.getState(gameId, 'verbosity', 'verbose');
      gs.pillars = await db.getState(gameId, 'pillars', { exploration: 33, combat: 33, social: 34 });
    }

    const gs = getGameState(gameId);
    socket.emit('game_joined', {
      game,
      chatHistory: gs.data.chatHistory,
      characters: gs.data.characters,
      turnOrder: gs.data.turnOrder,
      currentPlayer: getCurrentPlayer(gameId),
      imageUrl: gs.imageUrl,
      turnDuration: gs.turnDuration,
      world: gs.world || { locations: [], npcs: [] },
      lastOptions: gs.lastOptions || [],
      lastForPlayer: gs.lastForPlayer || null,
      mapState: gs.mapGraph.toJSON(),
      ferocity: gs.ferocity,
      verbosity: gs.verbosity,
      pillars: gs.pillars,
    });
  });

  // Register / update character
  socket.on('register_character', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;

    // Preserve existing token if re-registering and no new upload
    const gs = getGameState(gameId);
    const existing = gs.data.characters[data.name];

    const charData = {
      statsText: data.statsText || '',
      personality: data.personality || 'Brave and curious',
      standardActions: data.standardActions || '',
      backstory: data.backstory || '',
      token: data.token === null ? null : (data.token || (existing && existing.token) || null),
    };

    gs.data.characters[data.name] = charData;
    if (!gs.data.turnOrder.includes(data.name)) {
      gs.data.turnOrder.push(data.name);
    }
    await db.upsertCharacter(gameId, data.name, charData);
    await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);
    io.to(gameId).emit('character_registered', { name: data.name, character: charData });
    emitSystem(gameId, { text: `📜 ${data.name} has joined the campaign.` });

    // Auto-generate token if none provided
    if (!charData.token) {
      io.to(gameId).emit('token_generating', { name: data.name });
      generateCharacterToken(data.name, charData).then(async (tokenUrl) => {
        if (tokenUrl) {
          charData.token = tokenUrl;
          gs.data.characters[data.name] = charData;
          await db.upsertCharacter(gameId, data.name, charData);
          emitCharacterToken(gameId, { name: data.name, token: tokenUrl });
        } else {
          io.to(gameId).emit('token_failed', { name: data.name });
        }
      });
    }
  });

  // Upload custom token image
  socket.on('upload_token', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const { name, token } = data; // token is base64 data URL
    const gs = getGameState(gameId);
    const char = gs.data.characters[name];
    if (!char) return;
    char.token = token;
    await db.upsertCharacter(gameId, name, char);
    emitCharacterToken(gameId, { name, token });
  });

  // Player sends an action
  socket.on('player_action', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;

    const { playerName, action } = data;
    const current = getCurrentPlayer(gameId);

    if (current && current !== playerName) {
      socket.emit('system', { text: `It's ${current}'s turn, not yours.` });
      return;
    }

    const gs = getGameState(gameId);
    clearTimeout(gs.turnTimer);
    const playerToken = gs.data.characters[playerName]?.token || null;
    io.to(gameId).emit('player_message', { player: playerName, text: action, token: playerToken });
    discord.onSystem(gameId, { text: `**${playerName}:** ${action}` }).catch(() => {});

    try {
      const gameConfig = await db.getGame(gameId);
      const { narration, options, scene, world, isKillshot } = await callClaude(gameId, gameConfig, `${playerName}: ${action}`);
      const nextIdx = (gs.data.currentTurnIndex + 1) % (gs.data.turnOrder.length || 1);
      const nextPlayer = gs.data.turnOrder[nextIdx] || null;
      emitDmMessage(gameId, { text: narration, options, auto: false, forPlayer: nextPlayer, world });
      await maybeGenerateImage(gameId, gameConfig, scene, isKillshot);
      await advanceTurn(gameId, gameConfig, true);
    } catch (err) {
      socket.emit('system', { text: 'Error communicating with the DM. Try again.' });
    }
  });

  // DM start
  socket.on('dm_start', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;

    const { prompt } = data;
    try {
      const gameConfig = await db.getGame(gameId);
      const gs = getGameState(gameId);
      const { narration, options, scene, world } = await callClaude(gameId, gameConfig, prompt || 'Begin the adventure. Set the scene vividly.');
      const firstPlayer = getCurrentPlayer(gameId);
      emitDmMessage(gameId, { text: narration, options, auto: false, forPlayer: firstPlayer, world });
      // Always generate image for the opening scene
      if (scene) {
        generateSceneImage(scene, gameConfig).then(url => {
          if (url) {
            gs.imageUrl = url;
            emitSceneImage(gameId, { url });
          }
        });
      }
      const first = getCurrentPlayer(gameId);
      if (first) {
        const firstToken = gs.data.characters[first]?.token || null;
        emitTurnChange(gameId, { player: first, duration: gs.turnDuration * 1000, token: firstToken });
        startTurnTimer(gameId, gameConfig, first);
      }
    } catch (err) {
      socket.emit('system', { text: 'Failed to start the game.' });
    }
  });

  // Reset game
  socket.on('reset_game', async () => {
    const gameId = socket.gameId;
    if (!gameId) return;

    const gs = getGameState(gameId);
    clearTimeout(gs.turnTimer);
    gs.data.chatHistory = [];
    gs.data.currentTurnIndex = 0;
    gs.turnCount = 0;
    gs.imageUrl = null;
    await db.saveChatHistory(gameId, gs.data.chatHistory);
    await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);
    io.to(gameId).emit('game_reset');
    emitSystem(gameId, { text: '🔄 Game has been reset. Characters preserved.' });
  });

  socket.on('add_catchphrase', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const gs = getGameState(gameId);
    const char = gs.data.characters[data.name];
    if (!char) return;
    if (!char.catchphrases) char.catchphrases = [];
    if (char.catchphrases.length >= 10) {
      socket.emit('system', { text: '⚠️ Max 10 catchphrases. Remove one first.' });
      return;
    }
    char.catchphrases.push(data.phrase);
    await db.upsertCharacter(gameId, data.name, char);
    socket.emit('system', { text: `💬 Catchphrase added: "${data.phrase}"` });
    io.to(gameId).emit('catchphrases_updated', { name: data.name, catchphrases: char.catchphrases });
  });

  socket.on('remove_catchphrase', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const gs = getGameState(gameId);
    const char = gs.data.characters[data.name];
    if (!char || !char.catchphrases) return;
    char.catchphrases = char.catchphrases.filter(p => p !== data.phrase);
    await db.upsertCharacter(gameId, data.name, char);
    io.to(gameId).emit('catchphrases_updated', { name: data.name, catchphrases: char.catchphrases });
  });

  socket.on('add_backstory', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const gs = getGameState(gameId);
    const char = gs.data.characters[data.name];
    if (!char) return;
    // Append to existing backstory with a note
    const existing = char.backstory || '';
    char.backstory = existing + (existing ? '\n' : '') + `[Added: ${data.text}]`;
    await db.upsertCharacter(gameId, data.name, char);
    socket.emit('system', { text: `📝 Backstory note added for ${data.name}. Claude will weave it into the narrative.` });
    io.to(gameId).emit('character_updated', { name: data.name, character: char });
  });

  socket.on('add_world_context', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const gs = getGameState(gameId);
    if (!gs.world) gs.world = { locations: [], npcs: [], accomplishments: [] };
    if (data.type === 'location') {
      // Add or append context to a location
      const existing = gs.world.locations.find(l => l.name.toLowerCase() === data.name?.toLowerCase());
      if (existing) {
        existing.description += ` | ${data.context}`;
      } else {
        gs.world.locations.push({ name: data.name || data.context.split(' ')[0], description: data.context, distance: '' });
      }
    } else if (data.type === 'npc') {
      const existing = gs.world.npcs.find(n => n.name.toLowerCase() === data.name?.toLowerCase());
      if (existing) {
        existing.description += ` | ${data.context}`;
      } else {
        gs.world.npcs.push({ name: data.name || data.context.split(' ')[0], description: data.context, location: '' });
      }
    }
    await db.setState(gameId, 'world', gs.world);
    io.to(gameId).emit('world_updated', gs.world);
    socket.emit('system', { text: `🗺️ World context added. Claude will use this in the narrative.` });
  });

  socket.on('save_character', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const gs = getGameState(gameId);
    const char = gs.data.characters[data.name];
    if (!char) return;
    if (data.statsText !== undefined) char.statsText = data.statsText;
    if (data.personality !== undefined) char.personality = data.personality;
    if (data.standardActions !== undefined) char.standardActions = data.standardActions;
    if (data.backstory !== undefined) char.backstory = data.backstory;
    await db.upsertCharacter(gameId, data.name, char);
    socket.emit('system', { text: `✅ ${data.name}'s character sheet saved.` });
    io.to(gameId).emit('character_updated', { name: data.name, character: char });
  });

  socket.on('catch_up', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    try {
      const result = await gameEngine.catchUp(gameId, data.playerName);
      socket.emit('catch_up_result', result);
    } catch (err) {
      socket.emit('catch_up_result', { summary: 'Error generating summary.' });
    }
  });

  socket.on('skip_turn', async () => {
    const gameId = socket.gameId;
    if (!gameId) return;
    await gameEngine.skipTurn(gameId);
  });

  socket.on('set_pillars', (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    gameEngine.setPillars(gameId, data.exploration || 33, data.combat || 33, data.social || 34);
  });

  socket.on('set_verbosity', (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    gameEngine.setVerbosity(gameId, data.level);
  });

  socket.on('set_ferocity', (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    gameEngine.setFerocity(gameId, data.level);
  });

  socket.on('set_timer', (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    gameEngine.setTimer(gameId, data.seconds);
  });

  socket.on('delete_character', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    await gameEngine.deleteCharacter(gameId, data.name);
  });

  socket.on('deactivate_character', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    await gameEngine.deactivateCharacter(gameId, data.name);
  });

  socket.on('activate_character', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    await gameEngine.activateCharacter(gameId, data.name);
  });

  socket.on('reveal_location', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const gs = getGameState(gameId);
    if (gs.mapGraph.revealNode(data.name)) {
      await db.setState(gameId, 'map', gs.mapGraph.toJSON());
      io.to(gameId).emit('map_update', gs.mapGraph.toJSON());
      emitSystem(gameId, { text: `🗺️ Revealed: ${data.name}` });
    }
  });

  socket.on('set_map_style', (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const gs = getGameState(gameId);
    gs.mapStyle = data.style; // 'parchment' | 'dark' | 'tactical'
    io.to(gameId).emit('map_style_changed', { style: data.style });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    // If no humans left in this game, stop the timer to prevent runaway API costs
    const gameId = socket.gameId;
    if (gameId) {
      setTimeout(() => {
        const remaining = getConnectedClients(gameId);
        if (remaining === 0) {
          const gs = games[gameId];
          if (gs) {
            clearTimeout(gs.turnTimer);
            gs.turnTimer = null;
            console.log(`All clients left ${gameId} — timer stopped`);
          }
        }
      }, 5000); // 5s grace period for reconnects
    }
  });
});

// ── Game Engine API (used by Discord bot) ────────────────────────────────────
const gameEngine = {
  getGameState,

  async playerAction(gameId, playerName, action) {
    const current = getCurrentPlayer(gameId);
    if (current && current !== playerName) {
      return { error: `It's ${current}'s turn, not yours.` };
    }
    const gs = getGameState(gameId);
    clearTimeout(gs.turnTimer);

    const gameConfig = await db.getGame(gameId);
    const { narration, options, scene, world, isKillshot } = await callClaude(gameId, gameConfig, `${playerName}: ${action}`);
    const nextIdx = (gs.data.currentTurnIndex + 1) % (gs.data.turnOrder.length || 1);
    const nextPlayer = gs.data.turnOrder[nextIdx] || null;
    emitDmMessage(gameId, { text: narration, options, auto: false, forPlayer: nextPlayer, world });
    const playerToken = gs.data.characters[playerName]?.token || null;
    io.to(gameId).emit('player_message', { player: playerName, text: action, token: playerToken });
    await maybeGenerateImage(gameId, gameConfig, scene, isKillshot);
    await advanceTurn(gameId, gameConfig, true);
    return { ok: true };
  },

  async registerCharacter(gameId, name, data) {
    const gs = getGameState(gameId);
    const existing = gs.data.characters[name];
    const charData = {
      statsText: data.statsText || '',
      personality: data.personality || 'Brave and curious',
      standardActions: data.standardActions || '',
      backstory: data.backstory || '',
      token: (existing && existing.token) || null,
    };
    gs.data.characters[name] = charData;
    if (!gs.data.turnOrder.includes(name)) {
      gs.data.turnOrder.push(name);
    }
    await db.upsertCharacter(gameId, name, charData);
    await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);
    io.to(gameId).emit('character_registered', { name, character: charData });
    emitSystem(gameId, { text: `📜 ${name} has joined the campaign.` });

    // Auto-generate token
    if (!charData.token) {
      io.to(gameId).emit('token_generating', { name });
      generateCharacterToken(name, charData).then(async (tokenUrl) => {
        if (tokenUrl) {
          charData.token = tokenUrl;
          gs.data.characters[name] = charData;
          await db.upsertCharacter(gameId, name, charData);
          emitCharacterToken(gameId, { name, token: tokenUrl });
        }
      });
    }
  },

  async startGame(gameId, prompt) {
    const gameConfig = await db.getGame(gameId);
    if (!games[gameId]) {
      const gs = getGameState(gameId);
      gs.data = await db.loadGameData(gameId);
    }
    const gs = getGameState(gameId);
    gs.paused = false;
    gs.idleTurns = 0;
    const { narration, options, scene, world } = await callClaude(gameId, gameConfig, prompt || 'Begin the adventure. Set the scene vividly.');
    const firstPlayer = getCurrentPlayer(gameId);
    emitDmMessage(gameId, { text: narration, options, auto: false, forPlayer: firstPlayer, world });
    if (scene) {
      generateSceneImage(scene, gameConfig).then(url => {
        if (url) {
          gs.imageUrl = url;
          emitSceneImage(gameId, { url });
        }
      });
    }
    const first = getCurrentPlayer(gameId);
    if (first) {
      const firstToken = gs.data.characters[first]?.token || null;
      emitTurnChange(gameId, { player: first, duration: TURN_DURATION, token: firstToken });
      startTurnTimer(gameId, gameConfig, first);
    }
  },

  async resetGame(gameId) {
    const gs = getGameState(gameId);
    clearTimeout(gs.turnTimer);
    gs.data.chatHistory = [];
    gs.data.currentTurnIndex = 0;
    gs.turnCount = 0;
    gs.imageUrl = null;
    await db.saveChatHistory(gameId, gs.data.chatHistory);
    await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);
    io.to(gameId).emit('game_reset');
    emitSystem(gameId, { text: '🔄 Game has been reset. Characters preserved.' });
  },

  async catchUp(gameId, playerName) {
    const gs = getGameState(gameId);
    const gd = gs.data;
    // Find messages since the player last acted
    let lastActionIdx = -1;
    for (let i = gd.chatHistory.length - 1; i >= 0; i--) {
      const msg = gd.chatHistory[i];
      if (msg.role === 'user' && msg.content.startsWith(`${playerName}:`)) {
        lastActionIdx = i;
        break;
      }
    }
    const missedMessages = lastActionIdx === -1
      ? gd.chatHistory
      : gd.chatHistory.slice(lastActionIdx + 1);

    if (!missedMessages.length) {
      return { summary: 'You haven\'t missed anything — you\'re all caught up!' };
    }

    // Build a condensed transcript
    const transcript = missedMessages
      .map(m => m.role === 'user' ? `Player: ${m.content}` : `DM: ${m.content}`)
      .join('\n')
      .slice(0, 8000);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: `Summarize what happened in this RPG session in 400 words or less. Focus on key events, combat outcomes, discoveries, and story developments. Write from a third-person perspective. Be vivid but concise.`,
      messages: [{ role: 'user', content: `Summarize what ${playerName} missed:\n\n${transcript}` }],
    });

    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    logCost({ gameId, model: 'claude-sonnet-4-6', inputTokens, outputTokens,
      cost: estimateCost('claude-sonnet-4-6', inputTokens, outputTokens), type: 'catch-up' });

    return { summary: response.content[0].text };
  },

  async skipTurn(gameId) {
    const gs = getGameState(gameId);
    clearTimeout(gs.turnTimer);
    const current = getCurrentPlayer(gameId);
    emitSystem(gameId, { text: `⏭️ ${current || 'Current player'}'s turn was skipped.` });
    const gameConfig = await db.getGame(gameId);
    await advanceTurn(gameId, gameConfig, false);
    return { ok: true };
  },

  async setVerbosity(gameId, level) {
    const gs = getGameState(gameId);
    const valid = ['verbose', 'brief', 'terse'];
    if (!valid.includes(level)) return { error: 'Invalid verbosity level' };
    gs.verbosity = level;
    await db.setState(gameId, 'verbosity', gs.verbosity);
    emitSystem(gameId, { text: `📝 Verbosity set to **${level}**.` });
    io.to(gameId).emit('verbosity_updated', { verbosity: level });
    return { ok: true, verbosity: level };
  },

  async setFerocity(gameId, level) {
    const gs = getGameState(gameId);
    const num = Math.max(1, Math.min(5, parseInt(level) || 5));
    gs.ferocity = num;
    await db.setState(gameId, 'ferocity', gs.ferocity);
    const labels = { 1: '💀 Extremely Deadly (max treasure)', 2: '⚔️ Very Dangerous (generous treasure)', 3: '⚖️ Balanced', 4: '🛡️ Light Challenge', 5: '😊 Easy & Forgiving' };
    emitSystem(gameId, { text: `🔥 Ferocity set to **${num}/5** — ${labels[num]}` });
    io.to(gameId).emit('ferocity_updated', { ferocity: num });
    return { ok: true, ferocity: num };
  },

  async setPillars(gameId, exploration, combat, social) {
    const gs = getGameState(gameId);
    // Normalize to 100%
    const total = exploration + combat + social;
    gs.pillars = {
      exploration: Math.round(exploration / total * 100),
      combat: Math.round(combat / total * 100),
      social: Math.round(social / total * 100),
    };
    await db.setState(gameId, 'pillars', gs.pillars);
    emitSystem(gameId, { text: `🎭 Pillars set: Exploration ${gs.pillars.exploration}% · Combat ${gs.pillars.combat}% · Social ${gs.pillars.social}%` });
    io.to(gameId).emit('pillars_updated', gs.pillars);
    return { ok: true, pillars: gs.pillars };
  },

  setTimer(gameId, seconds) {
    const gs = getGameState(gameId);
    gs.turnDuration = Math.max(10, Math.min(3600, seconds));
    emitSystem(gameId, { text: `⏱️ Turn timer set to ${gs.turnDuration} seconds.` });
    // Broadcast new duration to web clients
    io.to(gameId).emit('timer_updated', { duration: gs.turnDuration });
    return { ok: true, duration: gs.turnDuration };
  },

  async deleteCharacter(gameId, name) {
    const gs = getGameState(gameId);
    delete gs.data.characters[name];
    gs.data.turnOrder = gs.data.turnOrder.filter(n => n !== name);
    await db.pool.query('DELETE FROM characters WHERE game_id = $1 AND name = $2', [gameId, name]);
    await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);
    io.to(gameId).emit('character_deleted', { name });
    emitSystem(gameId, { text: `🗑️ ${name} has been removed from the campaign.` });
    return { ok: true };
  },

  async deactivateCharacter(gameId, name) {
    const gs = getGameState(gameId);
    const idx = gs.data.turnOrder.indexOf(name);
    if (idx !== -1) {
      gs.data.turnOrder.splice(idx, 1);
      await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);
      io.to(gameId).emit('character_deactivated', { name, turnOrder: gs.data.turnOrder });
      emitSystem(gameId, { text: `💤 ${name} has been removed from the initiative order.` });
    }
    return { ok: true };
  },

  async revealLocation(gameId, name) {
    const gs = getGameState(gameId);
    if (gs.mapGraph.revealNode(name)) {
      await db.setState(gameId, 'map', gs.mapGraph.toJSON());
      io.to(gameId).emit('map_update', gs.mapGraph.toJSON());
      emitSystem(gameId, { text: `🗺️ Revealed: ${name}` });
      return true;
    }
    return false;
  },

  async activateCharacter(gameId, name) {
    const gs = getGameState(gameId);
    if (gs.data.characters[name] && !gs.data.turnOrder.includes(name)) {
      gs.data.turnOrder.push(name);
      await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);
      io.to(gameId).emit('character_activated', { name, turnOrder: gs.data.turnOrder });
      emitSystem(gameId, { text: `⚔️ ${name} has rejoined the initiative order.` });
    }
    return { ok: true };
  },
};

discord.setGameEngine(gameEngine);

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function boot() {
  await db.initDB();
  console.log('DB initialized');

  // Cost estimate on startup
  const gamesList = await db.listGames();
  const activeGames = gamesList.length;
  console.log('\n══════════════════════════════════════════');
  console.log('  💰 COST ESTIMATE');
  console.log('══════════════════════════════════════════');
  console.log(`  Active games: ${activeGames}`);
  console.log(`  Default model: Haiku ($0.80/$4.00 per 1M tokens)`);
  console.log(`  Turn timer: ${DEFAULT_TURN_DURATION}s | Idle pause: after 2 auto-turns`);
  console.log(`  Rate limit: ${MAX_CALLS_PER_HOUR} calls/game/hour`);
  console.log('  ─────────────────────────────────────');
  console.log('  Per API call (Haiku, ~2k in/500 out): ~$0.004');
  console.log('  Per API call (Sonnet, ~2k/500):       ~$0.014');
  console.log('  Per API call (Opus, ~2k/500):         ~$0.068');
  console.log('  Per image (FLUX):                     ~$0.003');
  console.log('  ─────────────────────────────────────');
  console.log('  Max hourly (Haiku, 60 calls+30 imgs): ~$0.33');
  console.log('  Max hourly (Sonnet, 60 calls+30 imgs):~$0.93');
  console.log('  Max hourly (Opus, 60 calls+30 imgs):  ~$4.17');
  console.log('  ─────────────────────────────────────');
  console.log('  Safety: no timer without clients, 2-turn idle pause,');
  console.log('  60 calls/hr rate limit, timer killed on disconnect');
  console.log('  Monitor: GET /api/costs for live cost tracking');
  console.log('══════════════════════════════════════════\n');

  await discord.startBot();
  server.listen(PORT, () => {
    console.log(`D&D Server running on http://localhost:${PORT}`);
  });
}

boot().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
