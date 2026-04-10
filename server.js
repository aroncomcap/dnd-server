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
const discord = require('./discord-bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
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
    };
  }
  return games[gameId];
}

// ── Broadcast helpers (Socket.io + Discord) ──────────────────────────────────
function emitDmMessage(gameId, data) {
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
      return `
Player: ${name}
${c.statsText || 'No stats provided'}
Personality: ${c.personality || 'Not specified'}
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

// ── Character Token Generation ───────────────────────────────────────────────
async function generateCharacterToken(name, charData) {
  if (!process.env.TOGETHER_API_KEY) return null;
  try {
    const desc = [charData.statsText, charData.personality, charData.backstory].filter(Boolean).join('. ');
    const prompt = `Fantasy RPG character portrait token, circular frame, dark background. Character: ${name}. ${desc.slice(0, 600)}. Detailed face and upper body, dramatic lighting, painterly style. No text or words.`;
    const response = await together.images.generate({
      model: 'black-forest-labs/FLUX.1-schnell-Free',
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

    emitSystem(gameId, { text: `⏰ ${playerName} ran out of time. Claude is acting for them...` });

    try {
      const { narration, options, scene } = await callClaude(gameId, gameConfig, autoPrompt, playerName);
      emitDmMessage(gameId, { text: narration, options, auto: true, player: playerName });
      await maybeGenerateImage(gameId, gameConfig, scene);
      advanceTurn(gameId, gameConfig);
    } catch (err) {
      emitSystem(gameId, { text: 'Error during auto-action.' });
    }
  }, gs.turnDuration * 1000);
}

async function advanceTurn(gameId, gameConfig) {
  const gs = getGameState(gameId);
  const gd = gs.data;
  gd.currentTurnIndex = (gd.currentTurnIndex + 1) % (gd.turnOrder.length || 1);
  await db.saveTurnState(gameId, gd.currentTurnIndex, gd.turnOrder);
  const next = getCurrentPlayer(gameId);
  if (next) {
    const token = gd.characters[next]?.token || null;
    emitTurnChange(gameId, { player: next, duration: gs.turnDuration * 1000, token });
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
        emitSceneImage(gameId, { url });
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
      turnDuration: gs.turnDuration,
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

    // Auto-generate token if none provided (fire and forget)
    if (!charData.token) {
      generateCharacterToken(data.name, charData).then(async (tokenUrl) => {
        if (tokenUrl) {
          charData.token = tokenUrl;
          gs.data.characters[data.name] = charData;
          await db.upsertCharacter(gameId, data.name, charData);
          emitCharacterToken(gameId, { name: data.name, token: tokenUrl });
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
      const { narration, options, scene } = await callClaude(gameId, gameConfig, `${playerName}: ${action}`);
      emitDmMessage(gameId, { text: narration, options, auto: false });
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
      emitDmMessage(gameId, { text: narration, options, auto: false });
      // Always generate image for the opening scene
      if (scene) {
        generateSceneImage(scene, gameConfig).then(url => {
          if (url) {
            const gs = getGameState(gameId);
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

  socket.on('skip_turn', async () => {
    const gameId = socket.gameId;
    if (!gameId) return;
    await gameEngine.skipTurn(gameId);
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

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
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
    const { narration, options, scene } = await callClaude(gameId, gameConfig, `${playerName}: ${action}`);
    emitDmMessage(gameId, { text: narration, options, auto: false });
    // Also emit to web socket player_message
    const playerToken = gs.data.characters[playerName]?.token || null;
    io.to(gameId).emit('player_message', { player: playerName, text: action, token: playerToken });
    await maybeGenerateImage(gameId, gameConfig, scene);
    await advanceTurn(gameId, gameConfig);
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
    const { narration, options, scene } = await callClaude(gameId, gameConfig, prompt || 'Begin the adventure. Set the scene vividly.');
    emitDmMessage(gameId, { text: narration, options, auto: false });
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

  async skipTurn(gameId) {
    const gs = getGameState(gameId);
    clearTimeout(gs.turnTimer);
    const current = getCurrentPlayer(gameId);
    emitSystem(gameId, { text: `⏭️ ${current || 'Current player'}'s turn was skipped.` });
    const gameConfig = await db.getGame(gameId);
    await advanceTurn(gameId, gameConfig);
    return { ok: true };
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
  await discord.startBot();
  server.listen(PORT, () => {
    console.log(`D&D Server running on http://localhost:${PORT}`);
  });
}

boot().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
