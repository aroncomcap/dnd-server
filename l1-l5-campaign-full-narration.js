#!/usr/bin/env node
/**
 * L1-L5 Campaign with Full Narration - Single Connection
 * Stable version without reconnects
 */

const ioModule = require(__dirname + '/node_modules/socket.io/client-dist/socket.io.js');
const io = ioModule.io || ioModule;
const fetch = require('node-fetch') || require('node:fetch');
const fs = require('fs');

const BASE_URL = 'https://theystillsing.com';

let socket = null;
let fullLog = [];
let narrations = [];

const TEST_USER = {
  email: 'test-bot-1@theystillsing.test',
  password: 'TestPassword12345!@#',
};

let authToken = null;

function logFull(msg) {
  console.log(msg);
  fullLog.push(msg);
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
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

    logFull(`[AUTH] ✅ Authenticated`);
    return !!authToken;
  } catch (err) {
    logFull(`[AUTH] ❌ Error: ${err.message}`);
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
        name: `L1-L5-Narration-${Date.now()}`,
        system: 'dnd5e',
      }),
    });

    if (!response.ok) {
      logFull(`[GAME] ❌ Game creation failed: ${response.status}`);
      return null;
    }

    const game = await response.json();
    logFull(`[GAME] ✅ Game created: ${game.id}`);
    return game.id;
  } catch (err) {
    logFull(`[GAME] ❌ Error: ${err.message}`);
    return null;
  }
}

async function runTest() {
  // Authenticate first
  if (!await authenticate()) {
    logFull(`[AUTH] ❌ Could not authenticate`);
    return;
  }

  // Create game
  const gameId = await createGame();
  if (!gameId) {
    logFull(`[GAME] ❌ Could not create game`);
    return;
  }

  return new Promise((resolve) => {
    socket = io(BASE_URL, { 
      transports: ['websocket'], 
      reconnection: false // Disable auto-reconnect to keep test simple
    });

    // Set up DM narration listener BEFORE connecting
    socket.on('dm_message', (data) => {
      if (data.text) {
        const timestamp = new Date().toISOString().slice(11, 19);
        logFull(`\n[${timestamp}] 🎭 DM NARRATION:`);
        logFull(data.text);
        narrations.push({ time: timestamp, text: data.text });
      }
    });

    socket.on('connect', async () => {
      logFull(`\n[CONNECT] ✅ Connected to server`);
      logFull(`[GAME] Game ID: ${gameId}\n`);

      logFull(`${'═'.repeat(80)}`);
      logFull(`L1-L5 CAMPAIGN PROGRESSION - FULL NARRATION LOG`);
      logFull(`${'═'.repeat(80)}\n`);

      socket.emit('join_game', gameId);
      await wait(500);

      // Generate party
      logFull(`\n[PARTY] Generating party...`);
      socket.emit('generate_party', {
        direction: 'Small elite party - 2 characters. Fighter and Cleric. Level 1.',
      });

      let partyReady = false;
      const partyTimeout = setTimeout(() => {
        if (!partyReady) {
          logFull(`\n[PARTY] ❌ Party generation timeout (60s elapsed)`);
          socket.disconnect();
          resolve();
        }
      }, 60000);

      socket.once('party_ready', async (data) => {
        clearTimeout(partyTimeout);
        logFull(`[PARTY] Party ready event received: ${data.count} characters`);

        if (data.count === 0) {
          logFull(`[PARTY] ❌ ERROR: No characters created - cannot proceed\n`);
          socket.disconnect();
          resolve();
          return;
        }

        logFull(`[PARTY] ✅ Valid party created with ${data.count} characters\n`);
        partyReady = true;

        // Start game
        await wait(500);
        socket.emit('dm_start', { ferocity: 3 });
        logFull(`[GAME] ✅ Game started with ferocity 3\n`);

        await wait(2000);

        // Run through all levels
        const levels = [
          { level: 1, encounters: 5, actions: ['Attack the enemy', 'Attack the enemy', 'Attack the enemy', 'Attack the enemy', 'Attack the enemy'] },
          { level: 2, encounters: 6, actions: ['Cast spell', 'Cast spell', 'Cast spell', 'Cast spell', 'Cast spell', 'Cast spell'] },
          { level: 3, encounters: 7, actions: ['Strategic action', 'Strategic action', 'Strategic action', 'Strategic action', 'Strategic action', 'Strategic action', 'Strategic action'] },
          { level: 4, encounters: 8, actions: ['Advance', 'Advance', 'Advance', 'Advance', 'Advance', 'Advance', 'Advance', 'Advance'] },
          { level: 5, encounters: 6, actions: ['Boss fight', 'Boss fight', 'Boss fight', 'Boss fight', 'Boss fight', 'Boss fight'] },
        ];

        for (const levelData of levels) {
          logFull(`\n[L${levelData.level}] Starting ${levelData.encounters} encounters...\n`);
          for (let i = 0; i < levelData.encounters; i++) {
            logFull(`[L${levelData.level}-TURN-${i+1}] Player: "${levelData.actions[i] || 'Action'}"`);
            socket.emit('player_action', {
              action: levelData.actions[i] || 'Action',
              text: levelData.actions[i] || 'Action'
            });
            await wait(2000);
          }
          if (levelData.level < 5) {
            logFull(`\n[L${levelData.level}] ✅ LEVEL UP!\n`);
            await wait(500);
          }
        }

        logFull(`\n${'═'.repeat(80)}`);
        logFull(`CAMPAIGN COMPLETE`);
        logFull(`${'═'.repeat(80)}`);
        logFull(`\nTotal Narrations Captured: ${narrations.length}`);

        // Save log
        const output = fullLog.join('\n');
        fs.writeFileSync('/tmp/L1_L5_FULL_NARRATION_LOG.txt', output, 'utf8');
        logFull(`\n📝 Full log saved to /tmp/L1_L5_FULL_NARRATION_LOG.txt`);

        await wait(1000);
        socket.disconnect();
        resolve();
      });
    });

    socket.on('disconnect', (reason) => {
      logFull(`\n[DISCONNECT] Socket disconnected: ${reason}`);
    });

    socket.on('error', (err) => {
      logFull(`\n[ERROR] Socket error: ${err}`);
    });

    socket.on('connect_error', (err) => {
      logFull(`\n[CONNECT_ERROR] Connection error: ${err.message}`);
    });
  });
}

runTest().then(() => {
  console.log('\n✅ Test complete');
  process.exit(0);
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
