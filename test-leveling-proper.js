#!/usr/bin/env node
/**
 * Campaign Test - Proper Turn Order + Real XP Leveling
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
        name: `Leveling-Test-${Date.now()}`,
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
  log('CAMPAIGN TEST - PROPER TURN ORDER + XP LEVELING');
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
      reconnectionAttempts: 5
    });

    socket.on('dm_message', (data) => {
      if (data.text) {
        log(`\n🎭 DM:\n${data.text}\n`);
      }
    });

    socket.on('character_updated', (data) => {
      if (data.character && data.character.level) {
        log(`📊 ${data.name} - Level ${data.character.level}, XP: ${data.character.xp || 0}`);
        if (data.character.level > currentLevel) {
          currentLevel = data.character.level;
          log(`🎉 LEVEL UP! New level: ${currentLevel}`);
        }
      }
    });

    socket.on('system', (data) => {
      if (data.text) {
        log(`ℹ️ ${data.text}`);
      }
    });

    socket.on('character_registered', (data) => {
      log(`✅ ${data.name}`);
      if (!characterNames.includes(data.name)) {
        characterNames.push(data.name);
      }
    });

    socket.on('party_ready', (data) => {
      log(`✅ Party ready: ${data.count} characters`);
    });

    socket.on('player_message', (data) => {
      log(`👤 ${data.player}: "${data.text}"`);
    });

    socket.on('combat_update', (data) => {
      log(`⚔️ Round ${data.round}`);
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
        log(`\nParty: ${characterNames.join(', ')}\n`);
        await wait(1000);
        
        log('🎮 STARTING GAME');
        socket.emit('dm_start', { ferocity: 3 });
        await wait(2000);

        // Run 50 encounters to trigger multiple level ups
        const actions = [
          'Attack with longsword',
          'Cast healing spell',
          'Use tactical positioning',
          'Defend allies',
          'Advance forward',
          'Use combat maneuver',
        ];

        for (let i = 1; i <= 50; i++) {
          const charIndex = (i - 1) % characterNames.length;
          const charName = characterNames[charIndex];
          const action = actions[i % actions.length];

          log(`\nENCOUNTER ${i}: ${charName} - "${action}"`);
          
          socket.emit('player_action', {
            playerName: charName,
            action: action,
            text: action
          });

          await wait(4000);
        }

        log(`\n${'═'.repeat(80)}`);
        log('CAMPAIGN COMPLETE');
        log('═'.repeat(80));

        const output = allLogs.join('\n');
        fs.writeFileSync('/tmp/LEVELING_TEST_LOG.txt', output, 'utf8');
        log(`\n📝 Log: /tmp/LEVELING_TEST_LOG.txt`);

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
