#!/usr/bin/env node
/**
 * Quick test: Start fresh game and verify narration responds to player actions
 * This test focuses on the NON-COMBAT path to verify the fix
 */

const ioModule = require(__dirname + '/node_modules/socket.io/client-dist/socket.io.js');
const io = ioModule.io || ioModule;
const fetch = require('node-fetch') || require('node:fetch');

const BASE_URL = process.env.BASE_URL || 'https://theystillsing.com';

const TEST_USER = {
  email: 'test-bot-1@theystillsing.test',
  password: 'TestPassword12345!@#',
};

let authToken = null;

function log(msg) {
  console.log(msg);
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function authenticate() {
  log(`🔐 Authenticating...`);
  try {
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
  try {
    const response = await fetch(`${BASE_URL}/api/games`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `tt_token=${authToken}`,
      },
      body: JSON.stringify({
        name: `Response-Fix-Test-${Date.now()}`,
        system: 'dnd5e',
      }),
    });

    if (!response.ok) {
      return null;
    }

    const game = await response.json();
    return game.id;
  } catch (err) {
    return null;
  }
}

async function runTest(gameId) {
  return new Promise((resolve) => {
    let turns = [];
    let currentTurn = null;

    const socket = io(BASE_URL, {
      transports: ['websocket'],
      reconnection: true,
    });

    socket.on('dm_stream_start', () => {
      if (currentTurn) {
        currentTurn.narrationBuffer = '';
        currentTurn.isStreaming = true;
        process.stdout.write('🎭 ');
      }
    });

    socket.on('dm_stream_chunk', (data) => {
      if (currentTurn && currentTurn.isStreaming) {
        let text = data?.text || data?.content || data?.chunk || data?.data;
        if (text) {
          currentTurn.narrationBuffer += text;
          process.stdout.write('.');
        }
      }
    });

    socket.on('dm_stream_end', (data) => {
      if (currentTurn && currentTurn.isStreaming) {
        currentTurn.isStreaming = false;
        currentTurn.narration = currentTurn.narrationBuffer;

        if (!currentTurn.narration && data?.text) {
          currentTurn.narration = data.text;
        }

        process.stdout.write('✅\n');

        if (currentTurn.narration && currentTurn.narration.length > 0) {
          log(`\n${'─'.repeat(80)}`);
          log(`TURN ${currentTurn.num} - ACTION: "${currentTurn.action}"`);
          log(`${'─'.repeat(80)}`);
          log(`\nNARRATION:\n${currentTurn.narration}\n`);

          // Parse options
          const optionMatches = currentTurn.narration.match(/([1-3])️⃣\s+([^\n]+)/g);
          if (optionMatches && optionMatches.length > 0) {
            currentTurn.options = [];
            optionMatches.forEach((match, idx) => {
              const text = match.replace(/[1-3]️⃣\s+/, '').trim();
              currentTurn.options.push({ num: idx + 1, text });
            });
            log(`OPTIONS:`);
            currentTurn.options.forEach(o => log(`  ${o.num}. ${o.text}`));
          }
          log(`\n${'─'.repeat(80)}\n`);
        }
        currentTurn.narrationPrinted = true;
      }
    });

    socket.on('connect', async () => {
      log(`\n🎮 Connected to game ${gameId.substring(0, 8)}...\n`);

      socket.emit('join_game', gameId);
      await wait(1500);

      log(`📖 Starting the game...\n`);
      socket.emit('dm_start', {});
      await wait(2000);

      // Run 5 turns, selecting from options each time
      let prevTurn = null;
      for (let i = 0; i < 5; i++) {
        currentTurn = {
          num: i + 1,
          action: null,
          narration: null,
          narrationBuffer: '',
          isStreaming: false,
          options: [],
        };
        turns.push(currentTurn);

        // Select action
        if (i === 0) {
          currentTurn.action = "Let's begin.";
        } else if (prevTurn && prevTurn.options && prevTurn.options.length > 0) {
          // Pick first option (deterministic for testing)
          const selectedOption = prevTurn.options[0];
          currentTurn.action = selectedOption.text;
        } else {
          currentTurn.action = "Continue the adventure.";
        }

        log(`━━ TURN ${currentTurn.num} ━━`);
        log(`📋 ACTION: "${currentTurn.action}"`);
        log(`🔄 Waiting for narration...`);

        socket.emit('player_action', { text: currentTurn.action });

        // Wait for narration
        const startWait = Date.now();
        while (!currentTurn.narration && Date.now() - startWait < 25000) {
          await wait(200);
        }

        if (!currentTurn.narration) {
          log(`⚠️  No narration received\n`);
        }

        prevTurn = currentTurn;
      }

      log(`\n✅ TEST COMPLETE\n`);
      await wait(3000);
      socket.disconnect();
      resolve();
    });

    socket.on('error', (err) => {
      log(`❌ Socket error: ${err}`);
    });

    setTimeout(() => {
      socket.disconnect();
      resolve();
    }, 180000);
  });
}

async function main() {
  console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
  console.log(`║        NARRATION RESPONSE FIX TEST                              ║`);
  console.log(`║  Verifies that game narration responds to player actions        ║`);
  console.log(`╚════════════════════════════════════════════════════════════════╝\n`);

  if (!await authenticate()) {
    process.exit(1);
  }

  const gameId = await createGame();
  if (!gameId) {
    log(`❌ Failed to create game`);
    process.exit(1);
  }

  log(`🎮 Testing game: ${gameId}\n`);

  await runTest(gameId);

  console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
  console.log(`║                    TEST COMPLETE                               ║`);
  console.log(`║  Check above: does each narration respond to the action?       ║`);
  console.log(`╚════════════════════════════════════════════════════════════════╝\n`);

  process.exit(0);
}

main();
