const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Persistence ──────────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'game_data.json');

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  return { characters: {}, chatHistory: [], currentTurnIndex: 0, turnOrder: [] };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let gameData = loadData();
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
- Keep the story moving. End each message by making it clear what the active player (or the party) can do next.
- Use dramatic but readable prose. Add atmosphere.`;
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

  // Persist conversation
  gameData.chatHistory.push(
    { role: 'user', content: prefix + userMessage },
    { role: 'assistant', content: reply }
  );
  // Keep last 80 messages to stay within context
  if (gameData.chatHistory.length > 80) {
    gameData.chatHistory = gameData.chatHistory.slice(-80);
  }
  saveData(gameData);
  return reply;
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
      const reply = await callClaude(autoPrompt, playerName);
      io.emit('dm_message', { text: reply, auto: true, player: playerName });
      advanceTurn();
    } catch (err) {
      io.emit('system', { text: 'Error during auto-action.' });
    }
  }, TURN_DURATION);
}

function advanceTurn() {
  gameData.currentTurnIndex = (gameData.currentTurnIndex + 1) % (gameData.turnOrder.length || 1);
  saveData(gameData);
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
  socket.on('register_character', (data) => {
    gameData.characters[data.name] = {
      level: data.level || 1,
      class: data.class || 'Fighter',
      race: data.race || 'Human',
      stats: data.stats || { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      hp: data.hp || 10,
      personality: data.personality || 'Brave and curious',
      standardActions: data.standardActions || '',
      backstory: data.backstory || '',
    };
    if (!gameData.turnOrder.includes(data.name)) {
      gameData.turnOrder.push(data.name);
    }
    saveData(gameData);
    io.emit('character_registered', { name: data.name, character: gameData.characters[data.name] });
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
      const reply = await callClaude(`${playerName}: ${action}`);
      io.emit('dm_message', { text: reply, auto: false });
      advanceTurn();
    } catch (err) {
      socket.emit('system', { text: 'Error communicating with the DM. Try again.' });
    }
  });

  // DM start / narration (host only — no auth for MVP, just a flag)
  socket.on('dm_start', async (data) => {
    const { prompt } = data;
    try {
      const reply = await callClaude(prompt || 'Begin the adventure. Set the scene vividly.');
      io.emit('dm_message', { text: reply, auto: false });
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
  socket.on('reset_game', () => {
    clearTimeout(turnTimer);
    gameData.chatHistory = [];
    gameData.currentTurnIndex = 0;
    saveData(gameData);
    io.emit('game_reset');
    io.emit('system', { text: '🔄 Game has been reset. Characters preserved.' });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`D&D Server running on http://localhost:${PORT}`);
});
