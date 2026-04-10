const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── In-memory cache (loaded from DB on boot, written through on changes) ─────
let gameData = { characters: {}, chatHistory: [], currentTurnIndex: 0, turnOrder: [] };
let turnTimer = null;
const TURN_DURATION = 3 * 60 * 1000; // 3 minutes

// ── Helpers ───────────────────────────────────────────────────────────────────
function getCurrentPlayer() {
  const { turnOrder, currentTurnIndex } = gameData;
  if (!turnOrder.length) return null;
  return turnOrder[currentTurnIndex % turnOrder.length];
}

function buildSystemPrompt() {
  const characterBlock = Object.entries(gameData.characters)
    .map(([name, c]) => `
Player: ${name}
Level: ${c.level} ${c.class} (${c.race})
Stats: STR ${c.stats.str}, DEX ${c.stats.dex}, CON ${c.stats.con}, INT ${c.stats.int}, WIS ${c.stats.wis}, CHA ${c.stats.cha}
HP: ${c.hp}
Personality: ${c.personality}
Standard Actions: ${c.standardActions || 'None defined'}
Backstory: ${c.backstory || 'Unknown'}
    `.trim())
    .join('\n\n');

  return `You are the Dungeon Master for a live multiplayer Dungeons & Dragons 5th Edition game.

CHARACTERS IN THIS CAMPAIGN:
${characterBlock || 'No characters registered yet.'}

RULES:
- Narrate vividly and concisely for a mobile screen (short paragraphs).
- Track HP, conditions, and resources. Apply D&D 5e rules accurately.
- When acting for an absent player, weigh their standard actions and personality heavily, but adapt to context.
- Keep the story moving. Use dramatic but readable prose. Add atmosphere.

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
4. 💬 [a witty comment, taunt, or clever social move]`;
}

function parseOptions(text) {
  const marker = '---OPTIONS---';
  const idx = text.indexOf(marker);
  if (idx === -1) return { narration: text.trim(), options: [] };
  const narration = text.slice(0, idx).trim();
  const optionsBlock = text.slice(idx + marker.length).trim();
  const options = optionsBlock.split('\n')
    .map(line => line.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean);
  return { narration, options };
}

async function callClaude(userMessage, actingAs = null) {
  const prefix = actingAs
    ? `[AUTO-ACTION for ${actingAs} — 3 min timer expired]\n`
    : '';

  const messages = [
    ...gameData.chatHistory,
    { role: 'user', content: prefix + userMessage },
  ];

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: buildSystemPrompt(),
    messages,
  });

  const reply = response.content[0].text;

  // Persist conversation (full text including options marker)
  gameData.chatHistory.push(
    { role: 'user', content: prefix + userMessage },
    { role: 'assistant', content: reply }
  );
  // Keep last 80 messages to stay within context
  if (gameData.chatHistory.length > 80) {
    gameData.chatHistory = gameData.chatHistory.slice(-80);
  }
  await db.saveChatHistory(gameData.chatHistory);

  // Parse options out of reply for the client
  const parsed = parseOptions(reply);
  return parsed;
}

// ── Turn Management ───────────────────────────────────────────────────────────
function startTurnTimer(playerName) {
  clearTimeout(turnTimer);
  turnTimer = setTimeout(async () => {
    const char = gameData.characters[playerName];
    const autoPrompt = char
      ? `It is ${playerName}'s turn but they did not respond. Act on their behalf as their character (${char.class}, personality: ${char.personality}). Choose the most fitting action given the current situation and their standard actions: ${char.standardActions || 'none'}. Narrate what they do.`
      : `It is ${playerName}'s turn but they did not respond. Have them take a cautious, sensible action.`;

    io.emit('system', { text: `⏰ ${playerName} ran out of time. Claude is acting for them...` });

    try {
      const { narration, options } = await callClaude(autoPrompt, playerName);
      io.emit('dm_message', { text: narration, options, auto: true, player: playerName });
      advanceTurn();
    } catch (err) {
      io.emit('system', { text: 'Error during auto-action.' });
    }
  }, TURN_DURATION);
}

async function advanceTurn() {
  gameData.currentTurnIndex = (gameData.currentTurnIndex + 1) % (gameData.turnOrder.length || 1);
  await db.saveTurnState(gameData.currentTurnIndex, gameData.turnOrder);
  const next = getCurrentPlayer();
  if (next) {
    io.emit('turn_change', { player: next, duration: TURN_DURATION });
    startTurnTimer(next);
  }
}

// ── Socket Events ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send current state to new connection
  socket.emit('game_state', {
    chatHistory: gameData.chatHistory,
    characters: gameData.characters,
    turnOrder: gameData.turnOrder,
    currentPlayer: getCurrentPlayer(),
  });

  // Register / update character
  socket.on('register_character', async (data) => {
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
    gameData.characters[data.name] = charData;
    if (!gameData.turnOrder.includes(data.name)) {
      gameData.turnOrder.push(data.name);
    }
    await db.upsertCharacter(data.name, charData);
    await db.saveTurnState(gameData.currentTurnIndex, gameData.turnOrder);
    io.emit('character_registered', { name: data.name, character: charData });
    io.emit('system', { text: `📜 ${data.name} has joined the campaign.` });
  });

  // Player sends an action
  socket.on('player_action', async (data) => {
    const { playerName, action } = data;
    const currentPlayer = getCurrentPlayer();

    if (currentPlayer && currentPlayer !== playerName) {
      socket.emit('system', { text: `It's ${currentPlayer}'s turn, not yours.` });
      return;
    }

    clearTimeout(turnTimer);
    io.emit('player_message', { player: playerName, text: action });

    try {
      const { narration, options } = await callClaude(`${playerName}: ${action}`);
      io.emit('dm_message', { text: narration, options, auto: false });
      await advanceTurn();
    } catch (err) {
      socket.emit('system', { text: 'Error communicating with the DM. Try again.' });
    }
  });

  // DM start / narration (host only — no auth for MVP, just a flag)
  socket.on('dm_start', async (data) => {
    const { prompt } = data;
    try {
      const { narration, options } = await callClaude(prompt || 'Begin the adventure. Set the scene vividly.');
      io.emit('dm_message', { text: narration, options, auto: false });
      const first = getCurrentPlayer();
      if (first) {
        io.emit('turn_change', { player: first, duration: TURN_DURATION });
        startTurnTimer(first);
      }
    } catch (err) {
      socket.emit('system', { text: 'Failed to start the game.' });
    }
  });

  // Reset game (host)
  socket.on('reset_game', async () => {
    clearTimeout(turnTimer);
    gameData.chatHistory = [];
    gameData.currentTurnIndex = 0;
    await db.saveChatHistory(gameData.chatHistory);
    await db.saveTurnState(gameData.currentTurnIndex, gameData.turnOrder);
    io.emit('game_reset');
    io.emit('system', { text: '🔄 Game has been reset. Characters preserved.' });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function boot() {
  await db.initDB();
  gameData = await db.loadGameData();
  console.log(`Loaded ${Object.keys(gameData.characters).length} characters from DB`);
  server.listen(PORT, () => {
    console.log(`D&D Server running on http://localhost:${PORT}`);
  });
}

boot().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
