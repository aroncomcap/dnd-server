#!/usr/bin/env node
/**
 * Game Flow Test - Event-driven, tracks actual narration arrival
 * Waits for narrations to arrive instead of guessing at timing
 */

const ioModule = require(__dirname + '/node_modules/socket.io/client-dist/socket.io.js');
const io = ioModule.io || ioModule;
const fetch = globalThis.fetch;

const BASE_URL = 'https://theystillsing.com';

const TEST_USER = {
  email: 'test-bot-1@theystillsing.test',
  password: 'TestPassword12345!@#',
};

let authToken = null;
let narrations = [];
let currentAction = null;

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function waitForNarration(timeout = 10000) {
  return new Promise((resolve) => {
    const startCount = narrations.length;
    const timer = setTimeout(() => {
      resolve(null); // Timeout
    }, timeout);

    const checkInterval = setInterval(() => {
      if (narrations.length > startCount) {
        clearInterval(checkInterval);
        clearTimeout(timer);
        resolve(narrations[narrations.length - 1]);
      }
    }, 100);
  });
}

async function authenticate() {
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

    const setCookie = response.headers.get('set-cookie');
    if (setCookie && setCookie.includes('tt_token=')) {
      const match = setCookie.match(/tt_token=([^;]+)/);
      authToken = match ? match[1] : null;
    }

    console.log(`✅ Authenticated`);
    return !!authToken;
  } catch (err) {
    const cause = err.cause ? ` (${err.cause.code || 'cause'}: ${err.cause.message})` : '';
    console.error(`❌ Auth failed: ${err.message}${cause}`);
    return false;
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
        name: `GameFlow-${Date.now()}`,
        system: 'dnd5e',
      }),
    });

    if (!response.ok) {
      console.log(`❌ Game creation failed: ${response.status}`);
      return null;
    }

    const game = await response.json();
    console.log(`✅ Game created: ${game.id}`);
    return game.id;
  } catch (err) {
    console.log(`❌ Game creation error: ${err.message}`);
    return null;
  }
}

async function runGameFlow() {
  if (!await authenticate()) {
    console.log('❌ Could not authenticate');
    return false;
  }

  const gameId = await createGame();
  if (!gameId) {
    console.log('❌ Could not create game');
    return false;
  }

  return new Promise((resolve) => {
    let smokePassed = true;
    const socket = io(BASE_URL, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: {
        Cookie: `tt_token=${authToken}`,
      },
    });

    let firstPlayerName = null;
    let currentPlayerName = null;

    socket.on('dm_message', (data) => {
      if (data.text) {
        const timestamp = new Date().toISOString().slice(11, 19);
        narrations.push(data.text);
        console.log(`\n[${timestamp}] 🎭 Narration (${data.text.length} chars):`);
        console.log(`   "${data.text.slice(0, 100)}..."`);
      }
    });

    socket.on('character_registered', (data) => {
      if (data.name) {
        console.log(`✅ CHARACTER: ${data.name}`);
        if (!firstPlayerName) firstPlayerName = data.name;
      }
    });

    socket.on('turn_change', (data) => {
      if (data.player) {
        currentPlayerName = data.player;
        console.log(`➡️  Turn: ${currentPlayerName}`);
      }
    });

    socket.on('connect', async () => {
      console.log(`✅ Connected\n`);

      socket.emit('join_game', gameId);
      await wait(500);

      // Generate party
      console.log(`🎲 Generating party...`);
      socket.emit('generate_party', {
        direction: 'Small elite party - 2 characters. Fighter and Cleric. Level 1.',
      });

      const partyTimeout = setTimeout(() => {
        console.log(`❌ Party generation timeout`);
        smokePassed = false;
        socket.disconnect();
        resolve(false);
      }, 60000);

      socket.once('party_ready', async (data) => {
        clearTimeout(partyTimeout);
        console.log(`✅ Party ready: ${data.count} characters\n`);

        // Start game
        console.log(`🎮 Starting game...`);
        narrations = []; // Clear any party gen narrations
        socket.emit('dm_start', { ferocity: 3 });

        // Wait for initial narration
        console.log(`⏳ Waiting for opening narration...`);
        const opening = await waitForNarration(15000);
        if (opening) {
          console.log(`✅ Opening narration received (${opening.length} chars)`);
        } else {
          console.log(`❌ No opening narration received after 15s`);
          smokePassed = false;
        }

        await wait(500);

        // Test player actions
        console.log(`\n📋 Testing player actions...\n`);

        const actions = [
          'Cast a healing spell',
          'Attack the nearest enemy with my sword',
          'Search the room for hidden items',
        ];

        for (let i = 0; i < actions.length; i++) {
          const action = actions[i];
          console.log(`📤 Action ${i + 1}: "${action}"`);
          const beforeCount = narrations.length;
          socket.emit('player_action', {
            playerName: currentPlayerName || firstPlayerName,
            action: action,
          });

          // Wait up to 15 seconds for a NEW narration
          const response = await waitForNarration(15000);
          const afterCount = narrations.length;
          const gotResponse = afterCount > beforeCount;

          if (response) {
            console.log(`✅ Response received (${response.length} chars): "${response.slice(0, 80)}..."`);
          } else {
            console.log(`❌ No response after 15s`);
            smokePassed = false;
          }

          await wait(1000);
        }

        console.log(`\n${'='.repeat(60)}`);
        console.log(`Total narrations captured: ${narrations.length}`);
        console.log(`${'='.repeat(60)}\n`);

        socket.disconnect();
        resolve(smokePassed);
      });
    });

    socket.on('disconnect', (reason) => {
      console.log(`\n[DISCONNECT] ${reason}`);
    });

    socket.on('error', (err) => {
      console.error(`[ERROR] ${err}`);
      smokePassed = false;
    });
  });
}

runGameFlow()
  .then((passed) => {
    if (passed) {
      console.log('✅ Test complete');
      process.exit(0);
    }
    console.log('❌ Test failed');
    process.exit(1);
  })
  .catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
