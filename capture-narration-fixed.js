#!/usr/bin/env node
/**
 * Fixed Narration Capture - Properly Create Game via API First
 * 1. Authenticate with API
 * 2. Create game via /api/games endpoint
 * 3. Join game via Socket.IO
 * 4. Capture narration with streaming events
 */

const ioModule = require(__dirname + '/node_modules/socket.io/client-dist/socket.io.js');
const io = ioModule.io || ioModule;
const fetch = require('node-fetch') || require('node:fetch');

const BASE_URL = process.env.BASE_URL || 'https://theystillsing.com';

// Test user credentials
const TEST_USER = {
  email: 'test-bot-1@theystillsing.test',
  password: 'TestPassword12345!@#',
  displayName: 'Test Bot 1',
};

let socket = null;
let authToken = null;

function log(msg) {
  console.log(msg);
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function authenticate() {
  log(`\n🔐 Authenticating as ${TEST_USER.email}...`);

  try {
    // Try login first
    const response = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: TEST_USER.email,
        password: TEST_USER.password,
      }),
      credentials: 'include',
    });

    if (!response.ok && response.status !== 409) {
      log(`❌ Login failed: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const setCookie = response.headers.get('set-cookie');

    if (setCookie && setCookie.includes('tt_token=')) {
      const match = setCookie.match(/tt_token=([^;]+)/);
      authToken = match ? match[1] : null;
    }

    log(`✅ Authenticated\n`);
    return authToken;
  } catch (err) {
    log(`❌ Auth error: ${err.message}`);
    return null;
  }
}

async function createGame() {
  if (!authToken) {
    log(`❌ No auth token`);
    return null;
  }

  log(`📝 Creating game via API...`);

  try {
    const response = await fetch(`${BASE_URL}/api/games`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `tt_token=${authToken}`,
      },
      body: JSON.stringify({
        name: `Narration-Test-${Date.now()}`,
        system: 'dnd5e',
      }),
    });

    if (!response.ok) {
      log(`❌ Game creation failed: ${response.status}`);
      const errText = await response.text();
      log(`   Error: ${errText}`);
      return null;
    }

    const game = await response.json();
    log(`✅ Game created: ${game.id}\n`);
    return game.id;
  } catch (err) {
    log(`❌ Error creating game: ${err.message}`);
    return null;
  }
}

async function captureNarration(gameId) {
  return new Promise((resolve) => {
    socket = io(BASE_URL, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 100,
    });

    let turns = [];
    let currentTurn = null;

    socket.on('connect', async () => {
      log(`✅ Connected to Socket.IO\n`);

      // Setup narration listeners BEFORE joining
      socket.on('dm_stream_start', () => {
        if (!currentTurn) return;
        currentTurn.narrationBuffer = '';
        currentTurn.isStreaming = true;
        process.stdout.write('🎭 ');
      });

      socket.on('dm_stream_chunk', (data) => {
        if (currentTurn && currentTurn.isStreaming && data.chunk) {
          currentTurn.narrationBuffer += data.chunk;
          process.stdout.write('.');
        }
      });

      socket.on('dm_stream_end', (data) => {
        if (currentTurn && currentTurn.isStreaming) {
          currentTurn.isStreaming = false;
          currentTurn.narration = currentTurn.narrationBuffer;
          process.stdout.write('✅\n');
        }
      });

      socket.on('error_msg', (data) => {
        log(`⚠️  Server error: ${data.text}`);
      });

      // Join game
      log(`📤 Joining game: ${gameId}`);
      socket.emit('join_game', gameId);
      await wait(1500);

      // Start game
      log(`🎮 Starting game...\n`);
      socket.emit('dm_start', {});
      await wait(2000);

      // Play 10 turns with diverse actions
      log(`═══════════════════════════════════════`);
      log(`CAPTURING 10 TURNS OF NARRATION`);
      log(`═══════════════════════════════════════`);
      log(`Testing diverse player actions...\n`);

      const diverseActions = [
        // Combat
        'I draw my sword and attack!',
        'I dodge to the side and counterattack.',
        'I brace myself for their attack.',
        // Exploration
        'I examine the surroundings carefully.',
        'I search for hidden doors or passages.',
        'I approach cautiously and investigate.',
        // Social
        'I try to negotiate or reason with them.',
        'I ask who they are and what they want.',
        'I try to read their intentions.',
        // Magic
        'I cast a spell to protect myself.',
        'I channel magic to sense danger.',
        'I attempt a magical attack.',
      ];

      for (let i = 0; i < 10; i++) {
        currentTurn = {
          num: i + 1,
          action: diverseActions[i % diverseActions.length],
          narration: null,
          narrationBuffer: '',
          isStreaming: false,
        };
        turns.push(currentTurn);

        log(`\n━━ TURN ${currentTurn.num} ━━`);
        log(`⚔️  ${currentTurn.action}`);
        log(`🔄 Waiting for narration...`);

        socket.emit('player_action', { text: currentTurn.action });

        // Wait for narration with timeout
        const startWait = Date.now();
        while (!currentTurn.narration && Date.now() - startWait < 20000) {
          await wait(200);
        }

        if (!currentTurn.narration) {
          log(`⚠️  No narration received`);
          currentTurn.narration = '[NO NARRATION CAPTURED]';
        }
      }

      log(`\n═══════════════════════════════════════`);
      log(`✅ TEST COMPLETE`);
      log(`═══════════════════════════════════════\n`);

      // Print results
      log(`📊 CAPTURED NARRATION:\n`);
      turns.forEach((turn) => {
        log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        log(`TURN ${turn.num}: ${turn.action}`);
        log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        if (turn.narration && turn.narration !== '[NO NARRATION CAPTURED]') {
          log(turn.narration);
        } else {
          log(turn.narration || '[NO NARRATION]');
        }
        log('');
      });

      await wait(1000);
      socket.disconnect();
      resolve(turns);
    });

    socket.on('error', (err) => {
      log(`❌ Socket error: ${err}`);
    });

    setTimeout(() => {
      if (socket) socket.disconnect();
      resolve([]);
    }, 90000);
  });
}

async function main() {
  console.log(`╔════════════════════════════════════════════╗`);
  console.log(`║  FIXED NARRATION CAPTURE                   ║`);
  console.log(`║  Auth → Create Game → Join → Capture       ║`);
  console.log(`╚════════════════════════════════════════════╝\n`);

  const token = await authenticate();
  if (!token) {
    process.exit(1);
  }

  const gameId = await createGame();
  if (!gameId) {
    process.exit(1);
  }

  await captureNarration(gameId);
  process.exit(0);
}

main();
