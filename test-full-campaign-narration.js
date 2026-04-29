#!/usr/bin/env node
/**
 * Full Campaign Test - Captures all narration and combat rolls
 */

const ioModule = require(__dirname + '/node_modules/socket.io/client-dist/socket.io.js');
const io = ioModule.io || ioModule;
const fetch = require('node-fetch') || require('node:fetch');
const fs = require('fs');

const BASE_URL = 'https://theystillsing.com';

const TEST_USER = {
  email: 'test-bot-1@theystillsing.test',
  password: 'TestPassword12345!@#',
};

let authToken = null;
let socket = null;
let gameId = null;
let allLogs = [];
let characterNames = [];

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const fullMsg = `[${ts}] ${msg}`;
  console.log(fullMsg);
  allLogs.push(fullMsg);
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
    return !!authToken;
  } catch (err) {
    log(`❌ Auth error: ${err.message}`);
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
        name: `Full-Campaign-${Date.now()}`,
        system: 'dnd5e',
      }),
    });

    if (!response.ok) {
      log(`❌ Game creation failed: ${response.status}`);
      return null;
    }

    const game = await response.json();
    return game.id;
  } catch (err) {
    log(`❌ Game creation error: ${err.message}`);
    return null;
  }
}

async function runTest() {
  log('═'.repeat(80));
  log('FULL L1-L5 CAMPAIGN TEST - COMPLETE NARRATION AND COMBAT LOG');
  log('═'.repeat(80));
  
  if (!await authenticate()) {
    log('❌ Authentication failed');
    return false;
  }
  log('✅ Authenticated');

  gameId = await createGame();
  if (!gameId) {
    log('❌ Game creation failed');
    return false;
  }
  log(`✅ Game created: ${gameId}`);

  return new Promise((resolve) => {
    socket = io(BASE_URL, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5
    });

    // Set up all listeners BEFORE connecting
    socket.on('dm_message', (data) => {
      if (data.text) {
        log(`\n🎭 DM NARRATION:\n${data.text}\n`);
      }
    });

    socket.on('combat_started', (data) => {
      log(`\n⚔️ COMBAT STARTED`);
      log(`Initiative: ${data.initiativeOrder?.join(', ') || 'N/A'}`);
    });

    socket.on('combat_update', (data) => {
      log(`\n⚔️ COMBAT UPDATE - Round ${data.round}, Turn Index: ${data.turnIndex}`);
      if (data.currentTurn) {
        log(`Current turn: ${data.currentTurn}`);
      }
      if (data.combatants) {
        for (const [id, c] of Object.entries(data.combatants)) {
          log(`  ${c.name}: ${c.hp}/${c.maxHp} HP`);
        }
      }
    });

    socket.on('system', (data) => {
      if (data.text) {
        log(`ℹ️ SYSTEM: ${data.text}`);
      }
    });

    socket.on('character_registered', (data) => {
      log(`✅ CHARACTER REGISTERED: ${data.name}`);
      if (!characterNames.includes(data.name)) {
        characterNames.push(data.name);
      }
    });

    socket.on('party_ready', (data) => {
      log(`✅ PARTY READY: ${data.count} characters`);
    });

    socket.on('player_message', (data) => {
      log(`👤 ${data.player}: ${data.text}`);
    });

    socket.on('error', (err) => {
      log(`❌ Socket error: ${err}`);
    });

    socket.on('connect_error', (err) => {
      log(`❌ Connection error: ${err.message}`);
    });

    socket.on('disconnect', (reason) => {
      log(`⚠️ Disconnected: ${reason}`);
    });

    socket.on('connect', async () => {
      log('\n✅ Connected to server\n');

      socket.emit('join_game', gameId);
      await wait(500);

      // Generate party
      log('🎲 GENERATING PARTY...');
      socket.emit('generate_party', {
        direction: 'Small elite party - 2 characters. Fighter and Cleric. Level 1.',
      });

      let partyReady = false;
      const partyTimeout = setTimeout(() => {
        if (!partyReady) {
          log('❌ Party generation timeout');
          socket.disconnect();
          resolve(false);
        }
      }, 60000);

      socket.once('party_ready', async (data) => {
        clearTimeout(partyTimeout);
        
        if (data.count === 0) {
          log('❌ No characters created');
          socket.disconnect();
          resolve(false);
          return;
        }

        partyReady = true;
        log(`\n✅ Party created: ${data.count} characters`);
        if (characterNames.length > 0) {
          log(`Characters: ${characterNames.join(', ')}`);
        }

        await wait(1000);
        
        // Start game
        log('\n🎮 STARTING GAME...');
        socket.emit('dm_start', { ferocity: 3 });
        await wait(2000);

        // Run campaign
        const levels = [
          { level: 1, turns: 5 },
          { level: 2, turns: 6 },
          { level: 3, turns: 7 },
          { level: 4, turns: 8 },
          { level: 5, turns: 6 },
        ];

        for (const levelData of levels) {
          log(`\n${'='.repeat(80)}`);
          log(`LEVEL ${levelData.level} - ${levelData.turns} ENCOUNTERS`);
          log('='.repeat(80));

          for (let i = 0; i < levelData.turns; i++) {
            const playerName = characterNames[0] || `Player${i}`;
            const actions = [
              'Attack the nearest enemy',
              'Cast a spell',
              'Use a tactical maneuver',
              'Defend an ally',
              'Advance forward',
              'Check for traps',
            ];
            const action = actions[i % actions.length];

            log(`\nTurn ${i + 1}: ${playerName} - "${action}"`);
            socket.emit('player_action', {
              playerName: playerName,
              action: action,
              text: action
            });

            // Wait for narration response
            await wait(3000);
          }

          if (levelData.level < 5) {
            log(`\n📈 LEVEL UP to Level ${levelData.level + 1}!`);
            await wait(1000);
          }
        }

        log(`\n${'='.repeat(80)}`);
        log('CAMPAIGN COMPLETE');
        log('='.repeat(80));

        // Save log
        const output = allLogs.join('\n');
        fs.writeFileSync('/tmp/FULL_CAMPAIGN_LOG.txt', output, 'utf8');
        log(`\n📝 Log saved to /tmp/FULL_CAMPAIGN_LOG.txt (${allLogs.length} lines)`);

        await wait(2000);
        socket.disconnect();
        resolve(true);
      });
    });
  });
}

runTest().then((success) => {
  if (success) {
    log('\n✅ TEST COMPLETE');
    process.exit(0);
  } else {
    log('\n❌ TEST FAILED');
    process.exit(1);
  }
}).catch(err => {
  log(`\n❌ Test error: ${err.message}`);
  process.exit(1);
});
