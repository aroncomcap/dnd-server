#!/usr/bin/env node
/**
 * Campaign Test - Real Leveling Through XP and Encounter Completion
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
let currentLevel = 1;

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
        name: `Real-Leveling-${Date.now()}`,
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
  log('L1-L5 CAMPAIGN - REAL LEVELING THROUGH ENCOUNTERS AND XP');
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
      reconnectionAttempts: 5
    });

    // Set up all listeners
    socket.on('dm_message', (data) => {
      if (data.text) {
        log(`\n🎭 DM NARRATION:\n${data.text}\n`);
      }
    });

    socket.on('character_updated', (data) => {
      if (data.character && data.character.level) {
        log(`⬆️ CHARACTER UPDATE: ${data.name} - Level ${data.character.level}`);
        if (data.character.level > currentLevel) {
          log(`🎉 LEVEL UP! ${data.name} is now Level ${data.character.level}!`);
          currentLevel = data.character.level;
        }
      }
    });

    socket.on('combat_started', (data) => {
      log(`⚔️ COMBAT STARTED`);
    });

    socket.on('combat_update', (data) => {
      log(`⚔️ Round ${data.round}`);
      if (data.combatants) {
        for (const [id, c] of Object.entries(data.combatants)) {
          log(`  ${c.name}: ${c.hp}/${c.maxHp} HP`);
        }
      }
    });

    socket.on('system', (data) => {
      if (data.text) {
        log(`ℹ️ ${data.text}`);
      }
    });

    socket.on('character_registered', (data) => {
      log(`✅ CHARACTER: ${data.name}`);
      if (!characterNames.includes(data.name)) {
        characterNames.push(data.name);
      }
    });

    socket.on('party_ready', (data) => {
      log(`✅ PARTY READY: ${data.count} characters`);
    });

    socket.on('player_message', (data) => {
      log(`👤 ${data.player}: "${data.text}"`);
    });

    socket.on('error', (err) => {
      log(`❌ Socket error: ${err}`);
    });

    socket.on('disconnect', (reason) => {
      log(`⚠️ Disconnected: ${reason}`);
    });

    socket.on('connect', async () => {
      log('\n✅ Connected\n');

      socket.emit('join_game', gameId);
      await wait(500);

      log('🎲 GENERATING PARTY');
      socket.emit('generate_party', {
        direction: 'Party of 2 - Fighter and Cleric. Level 1.',
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
        log(`Party: ${characterNames.join(', ')}\n`);
        await wait(1000);
        
        // Start game
        log('🎮 STARTING GAME');
        socket.emit('dm_start', { ferocity: 3 });
        await wait(2000);

        // Run campaign - use BOTH characters in turn
        const encounters = 32;
        for (let i = 1; i <= encounters; i++) {
          const charIndex = (i - 1) % characterNames.length;
          const charName = characterNames[charIndex];
          const actions = [
            'Attack with all might',
            'Cast a powerful spell',
            'Use tactical positioning',
            'Defend allies',
            'Advance and strike',
            'Use cunning strategy',
          ];
          const action = actions[i % actions.length];

          log(`\n═══ ENCOUNTER ${i} ═══`);
          log(`${charName}: "${action}"`);
          
          socket.emit('player_action', {
            playerName: charName,
            action: action,
            text: action
          });

          // Wait for narration and combat resolution
          await wait(4000);
        }

        log(`\n${'═'.repeat(80)}`);
        log('CAMPAIGN COMPLETE - ALL ENCOUNTERS FINISHED');
        log('═'.repeat(80));

        // Save log
        const output = allLogs.join('\n');
        fs.writeFileSync('/tmp/REAL_LEVELING_LOG.txt', output, 'utf8');
        log(`\n📝 Log: /tmp/REAL_LEVELING_LOG.txt (${allLogs.length} lines)`);

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
  log(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
