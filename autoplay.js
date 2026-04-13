#!/usr/bin/env node
'use strict';

/**
 * Auto-play script using the Socket.IO client bundled with the server's socket.io package.
 * Creates a game, generates a party, starts the adventure, plays N turns picking option 1.
 *
 * Usage: node autoplay.js [turns] [url]
 */

// Use the Client class bundled with the socket.io server package (absolute path to bypass exports)
const ioModule = require(__dirname + '/node_modules/socket.io/client-dist/socket.io.js');
const Client = ioModule.io || ioModule;

const TOTAL_TURNS = parseInt(process.argv[2], 10) || 20;
const SERVER_URL = process.argv[3] || 'https://dnd-server-production-9b61.up.railway.app';
const GAME_ID = 'autoplay-' + Date.now().toString(36);

console.log(`\n🎲 Auto-play: ${TOTAL_TURNS} turns on ${SERVER_URL}`);
console.log(`   Game ID: ${GAME_ID}\n`);

let turnCount = 0;
let currentPlayer = null;
let lastOptions = [];
let characters = {};
let gameStarted = false;

const socket = Client(SERVER_URL, {
  transports: ['websocket'],
  reconnection: false,
});

socket.on('connect', async () => {
  console.log('✅ Connected to server');

  // Create game via REST API
  try {
    const res = await fetch(`${SERVER_URL}/api/games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: GAME_ID, system: 'dnd5e' }),
    });
    const game = await res.json();
    console.log(`✅ Game created: ${game.id || game.name || GAME_ID}`);
  } catch (err) {
    console.error('❌ Failed to create game:', err.message);
    process.exit(1);
  }

  // Join the game
  socket.emit('join_game', GAME_ID);
});

socket.on('game_joined', (state) => {
  console.log(`✅ Joined game. Characters: ${Object.keys(state.characters).length}`);
  characters = state.characters;

  if (Object.keys(characters).length === 0) {
    console.log('🎲 Generating pre-gen party...');
    socket.emit('generate_party', { direction: 'Classic dungeon crawl party — fighter, cleric, rogue, wizard' });
  } else {
    startAdventure();
  }
});

socket.on('character_registered', (data) => {
  characters[data.name] = data.character;
  console.log(`  📜 ${data.name} joined`);
});

socket.on('party_generated', (data) => {
  console.log(`✅ Party generated: ${data.count} characters`);
  setTimeout(startAdventure, 2000);
});

function startAdventure() {
  if (gameStarted) return;
  gameStarted = true;
  const charNames = Object.keys(characters);
  currentPlayer = charNames[0];
  console.log(`\n⚔️  Adventure begins! First player: ${currentPlayer}`);
  console.log('─'.repeat(60));
  socket.emit('dm_start', { prompt: 'Begin the adventure. The party arrives at a dungeon entrance at dusk.' });
}

socket.on('dm_message', (data) => {
  turnCount++;
  const wordCount = (data.text || '').split(/\s+/).length;
  console.log(`\n[Turn ${turnCount}/${TOTAL_TURNS}] DM (${wordCount} words):`);
  const preview = (data.text || '').slice(0, 300);
  console.log(`  "${preview}${data.text?.length > 300 ? '...' : ''}"`);

  if (data.options?.length) {
    console.log(`  Options:`);
    data.options.forEach((o, i) => console.log(`    ${i + 1}. ${o.slice(0, 70)}`));
  }

  lastOptions = data.options || [];
  if (data.forPlayer) currentPlayer = data.forPlayer;

  if (turnCount >= TOTAL_TURNS) {
    console.log('\n' + '═'.repeat(60));
    console.log(`✅ Completed ${TOTAL_TURNS} turns!`);
    console.log('═'.repeat(60));
    setTimeout(() => process.exit(0), 3000);
    return;
  }

  // Auto-play: pick option 1 after delay
  setTimeout(() => {
    const action = lastOptions[0] || 'I look around and investigate the area.';
    console.log(`  → ${currentPlayer}: "${action.slice(0, 80)}"`);
    socket.emit('player_action', { playerName: currentPlayer, action });
  }, 2000);
});

socket.on('turn_change', (data) => {
  if (data.currentPlayer) currentPlayer = data.currentPlayer;
});

socket.on('combat_started', (data) => {
  console.log(`  ⚔️  COMBAT! ${data.initiativeOrder?.length || '?'} combatants`);
});

socket.on('combat_ended', (data) => {
  console.log(`  🏆 Combat over: ${data.reason}`);
});

socket.on('scene_image', (data) => {
  console.log(`  🖼️  Image${data.label ? ': ' + data.label : ''}`);
});

socket.on('system', (data) => {
  if (data.text) console.log(`  💬 ${data.text}`);
  // Retry on DM error
  if (data.text?.includes('Error communicating')) {
    console.log('  🔄 Retrying with a different action...');
    setTimeout(() => {
      const action = 'I look around cautiously and prepare for what comes next.';
      console.log(`  → ${currentPlayer}: "${action}"`);
      socket.emit('player_action', { playerName: currentPlayer, action });
    }, 3000);
  }
});

socket.on('disconnect', () => {
  console.log('\nDisconnected');
  if (turnCount < TOTAL_TURNS) process.exit(1);
});

socket.on('connect_error', (err) => {
  console.error('Connection error:', err.message);
  process.exit(1);
});

// Safety timeout
setTimeout(() => {
  console.error('\n⏰ Timeout (10 min)');
  process.exit(1);
}, 10 * 60 * 1000);
