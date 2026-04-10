const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const Together = require('together-ai');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const together = new Together({ apiKey: process.env.TOGETHER_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const TURN_DURATION = 3 * 60 * 1000;
const IMAGE_COOLDOWN = 2; // generate image every N turns
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
    };
  }
  return games[gameId];
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
      let stats;
      if (gameConfig.system === 'runequest') {
        stats = `STR ${c.stats.str}, CON ${c.stats.con}, SIZ ${c.stats.siz || 13}, INT ${c.stats.int}, POW ${c.stats.pow || 10}, DEX ${c.stats.dex}, CHA ${c.stats.cha}`;
      } else {
        stats = `STR ${c.stats.str}, DEX ${c.stats.dex}, CON ${c.stats.con}, INT ${c.stats.int}, WIS ${c.stats.wis}, CHA ${c.stats.cha}`;
      }
      return `
Player: ${name}
Level: ${c.level} ${c.class} (${c.race})
Stats: ${stats}
HP: ${c.hp}
Personality: ${c.personality}
Standard Actions: ${c.standardActions || 'None defined'}
Backstory: ${c.backstory || 'Unknown'}
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

RULES:
- Narrate vividly and concisely for a mobile screen (short paragraphs).
- Track HP, conditions, and resources. Apply game rules accurately.
- When acting for an absent player, weigh their standard actions and personality heavily, but adapt to context.
- Keep the story moving. Use dramatic but readable prose. Add atmosphere.
- If campaign source material is provided above, use it to guide the adventure, encounters, NPCs, and lore.

FORMATTING — SKILL ROLLS & GAME MECHANICS:
- Any time there is a skill check, saving throw, attack roll, damage roll, or other game mechanic, put it on its own line with a blank line before and after, wrapped in **double asterisks** for bold. Example:

Some narration text here.

**🎲 DC 14 Dexterity Saving Throw — Kael rolls a 16. Success!**

More narration continues.

ACTION OPTIONS:
- At the end of EVERY response (except auto-actions), present exactly 4 action choices for the next player, plus indicate they can type anything.
- At least one option must be a wild/reckless/creative move (mark with 🔥).
- At least one option must be a witty quip or clever social move (mark with 💬).
- Use this EXACT format at the end of your message — the lines after ---OPTIONS--- are parsed by the client:

---OPTIONS---
1. 🗡️ [a combat or practical action]
2. 🛡️ [a defensive or cautious action]
3. 🔥 [a wild, reckless, or creative move]
4. 💬 [a witty comment, taunt, or clever social move]

SCENE DESCRIPTION:
- At the end of every response, AFTER the options block, include a brief visual scene description for image generation.
- Use this EXACT format:

---SCENE---
[A single sentence describing the current visual scene, suitable as an image generation prompt. Include the setting, lighting, characters' positions, and any dramatic action. Use a painterly fantasy art style.]`;
}

// ── Parsing ──────────────────────────────────────────────────────────────────
function parseResponse(text) {
  let narration = text;
  let options = [];
  let scene = null;

  // Extract scene first
  const sceneMarker = '---SCENE---';
  const sceneIdx = narration.indexOf(sceneMarker);
  if (sceneIdx !== -1) {
    scene = narration.slice(sceneIdx + sceneMarker.length).trim();
    narration = narration.slice(0, sceneIdx).trim();
  }

  // Extract options
  const optionsMarker = '---OPTIONS---';
  const optIdx = narration.indexOf(optionsMarker);
  if (optIdx !== -1) {
    const optionsBlock = narration.slice(optIdx + optionsMarker.length).trim();
    options = optionsBlock.split('\n')
      .map(line => line.replace(/^\d+\.\s*/, '').trim())
      .filter(Boolean);
    narration = narration.slice(0, optIdx).trim();
  }

  return { narration, options, scene };
}

// ── Image Generation (Together AI / FLUX) ────────────────────────────────────
async function generateSceneImage(scene, gameConfig) {
  if (!process.env.TOGETHER_API_KEY || !scene) return null;
  try {
    const style = gameConfig.image_style || 'fantasy illustration';
    const prompt = `${style}: ${scene}. No text or words in the image.`;
    const response = await together.images.create({
      model: 'black-forest-labs/FLUX.1-schnell-Free',
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

// ── Claude Call (scoped to a game) ───────────────────────────────────────────
async function callClaude(gameId, gameConfig, userMessage, actingAs = null) {
  const gs = getGameState(gameId);
  const gd = gs.data;

  const prefix = actingAs
    ? `[AUTO-ACTION for ${actingAs} — 3 min timer expired]\n`
    : '';

  const messages = [
    ...gd.chatHistory,
    { role: 'user', content: prefix + userMessage },
  ];

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: buildSystemPrompt(gameId, gameConfig),
    messages,
  });

  const reply = response.content[0].text;

  gd.chatHistory.push(
    { role: 'user', content: prefix + userMessage },
    { role: 'assistant', content: reply }
  );
  if (gd.chatHistory.length > 80) {
    gd.chatHistory = gd.chatHistory.slice(-80);
  }
  await db.saveChatHistory(gameId, gd.chatHistory);

  return parseResponse(reply);
}

// ── Turn Management (scoped to a game) ───────────────────────────────────────
function getCurrentPlayer(gameId) {
  const gs = getGameState(gameId);
  const { turnOrder, currentTurnIndex } = gs.data;
  if (!turnOrder.length) return null;
  return turnOrder[currentTurnIndex % turnOrder.length];
}

function startTurnTimer(gameId, gameConfig, playerName) {
  const gs = getGameState(gameId);
  clearTimeout(gs.turnTimer);
  gs.turnTimer = setTimeout(async () => {
    const char = gs.data.characters[playerName];
    const autoPrompt = char
      ? `It is ${playerName}'s turn but they did not respond. Act on their behalf as their character (${char.class}, personality: ${char.personality}). Choose the most fitting action given the current situation and their standard actions: ${char.standardActions || 'none'}. Narrate what they do.`
      : `It is ${playerName}'s turn but they did not respond. Have them take a cautious, sensible action.`;

    io.to(gameId).emit('system', { text: `⏰ ${playerName} ran out of time. Claude is acting for them...` });

    try {
      const { narration, options, scene } = await callClaude(gameId, gameConfig, autoPrompt, playerName);
      io.to(gameId).emit('dm_message', { text: narration, options, auto: true, player: playerName });
      await maybeGenerateImage(gameId, gameConfig, scene);
      advanceTurn(gameId, gameConfig);
    } catch (err) {
      io.to(gameId).emit('system', { text: 'Error during auto-action.' });
    }
  }, TURN_DURATION);
}

async function advanceTurn(gameId, gameConfig) {
  const gs = getGameState(gameId);
  const gd = gs.data;
  gd.currentTurnIndex = (gd.currentTurnIndex + 1) % (gd.turnOrder.length || 1);
  await db.saveTurnState(gameId, gd.currentTurnIndex, gd.turnOrder);
  const next = getCurrentPlayer(gameId);
  if (next) {
    io.to(gameId).emit('turn_change', { player: next, duration: TURN_DURATION });
    startTurnTimer(gameId, gameConfig, next);
  }
}

async function maybeGenerateImage(gameId, gameConfig, scene) {
  const gs = getGameState(gameId);
  gs.turnCount++;
  if (gs.turnCount % IMAGE_COOLDOWN === 0 && scene) {
    // Fire and forget — don't block the game
    generateSceneImage(scene, gameConfig).then(url => {
      if (url) {
        gs.imageUrl = url;
        io.to(gameId).emit('scene_image', { url });
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
    res.json({ success: true, totalChars: allText.length, files: req.files.map(f => f.originalname) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    }

    const gs = getGameState(gameId);
    socket.emit('game_joined', {
      game,
      chatHistory: gs.data.chatHistory,
      characters: gs.data.characters,
      turnOrder: gs.data.turnOrder,
      currentPlayer: getCurrentPlayer(gameId),
      imageUrl: gs.imageUrl,
    });
  });

  // Register / update character
  socket.on('register_character', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;

    const charData = {
      level: data.level || 1,
      class: data.class || 'Fighter',
      race: data.race || 'Human',
      stats: data.stats || { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      hp: data.hp || 10,
      personality: data.personality || 'Brave and curious',
      standardActions: data.standardActions || '',
      backstory: data.backstory || '',
    };

    const gs = getGameState(gameId);
    gs.data.characters[data.name] = charData;
    if (!gs.data.turnOrder.includes(data.name)) {
      gs.data.turnOrder.push(data.name);
    }
    await db.upsertCharacter(gameId, data.name, charData);
    await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);
    io.to(gameId).emit('character_registered', { name: data.name, character: charData });
    io.to(gameId).emit('system', { text: `📜 ${data.name} has joined the campaign.` });
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
    io.to(gameId).emit('player_message', { player: playerName, text: action });

    try {
      const gameConfig = await db.getGame(gameId);
      const { narration, options, scene } = await callClaude(gameId, gameConfig, `${playerName}: ${action}`);
      io.to(gameId).emit('dm_message', { text: narration, options, auto: false });
      await maybeGenerateImage(gameId, gameConfig, scene);
      await advanceTurn(gameId, gameConfig);
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
      const { narration, options, scene } = await callClaude(gameId, gameConfig, prompt || 'Begin the adventure. Set the scene vividly.');
      io.to(gameId).emit('dm_message', { text: narration, options, auto: false });
      // Always generate image for the opening scene
      if (scene) {
        generateSceneImage(scene, gameConfig).then(url => {
          if (url) {
            const gs = getGameState(gameId);
            gs.imageUrl = url;
            io.to(gameId).emit('scene_image', { url });
          }
        });
      }
      const first = getCurrentPlayer(gameId);
      if (first) {
        io.to(gameId).emit('turn_change', { player: first, duration: TURN_DURATION });
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
    io.to(gameId).emit('system', { text: '🔄 Game has been reset. Characters preserved.' });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function boot() {
  await db.initDB();
  console.log('DB initialized');
  server.listen(PORT, () => {
    console.log(`D&D Server running on http://localhost:${PORT}`);
  });
}

boot().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
