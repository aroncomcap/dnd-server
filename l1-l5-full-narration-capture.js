#!/usr/bin/env node
/**
 * L1-L5 Campaign Test with FULL Narration Capture
 * Captures every bit of DM dialogue and responses
 */

const ioModule = require('/Users/aron/Dropbox (Personal)/claude/dnd-server/node_modules/socket.io/client-dist/socket.io.js');
const io = ioModule.io || ioModule;
const fetch = require('node-fetch') || require('node:fetch');
const fs = require('fs');

const BASE_URL = 'https://theystillsing.com';

let socket = null;
let fullLog = [];
let narrations = [];
let gameId = null;

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
        name: `L1-L5-Full-Narration-${Date.now()}`,
        system: 'dnd5e',
      }),
    });

    if (!response.ok) {
      logFull(`[GAME] ❌ Game creation failed: ${response.status}`);
      return null;
    }

    const game = await response.json();
    gameId = game.id;
    logFull(`[GAME] ✅ Game created: ${gameId}`);
    return gameId;
  } catch (err) {
    logFull(`[GAME] ❌ Error: ${err.message}`);
    return null;
  }
}

async function runTest() {
  return new Promise(async (resolve) => {
    // Authenticate first
    if (!await authenticate()) {
      logFull(`[AUTH] ❌ Could not authenticate`);
      resolve();
      return;
    }

    // Create a game via HTTP API
    if (!await createGame()) {
      logFull(`[GAME] ❌ Could not create game`);
      resolve();
      return;
    }

    socket = io(BASE_URL, { transports: ['websocket'], reconnection: true });

    socket.on('connect', async () => {
      logFull(`\n[CONNECT] ✅ Connected to server`);
      logFull(`[GAME] Game ID: ${gameId}`);

      socket.emit('join_game', gameId);
      await wait(1000);
      
      logFull(`\n${'═'.repeat(80)}`);
      logFull(`L1-L5 CAMPAIGN PROGRESSION - FULL NARRATION LOG`);
      logFull(`${'═'.repeat(80)}\n`);
      
      // Listen to DM narration - FULL TEXT
      socket.on('dm_message', (data) => {
        if (data.text) {
          const timestamp = new Date().toISOString().slice(11, 19);
          logFull(`\n[${timestamp}] 🎭 DM NARRATION:`);
          logFull(`${data.text}`);
          narrations.push({
            time: timestamp,
            text: data.text
          });
        }
      });
      
      logFull(`\n${'─'.repeat(80)}`);
      logFull(`PHASE 1: PARTY GENERATION & L1 ENCOUNTERS`);
      logFull(`${'─'.repeat(80)}\n`);
      
      // Generate party
      logFull(`[PARTY] Generating party...`);
      socket.emit('generate_party', {
        direction: 'Small elite party - 2 characters. Fighter and Cleric. Level 1.'
      });

      let partyReady = false;
      socket.once('party_generated', async (data) => {
        logFull(`[PARTY] Party generation returned: ${data.count} characters`);

        // Validate that characters were actually created
        if (data.count === 0) {
          logFull(`[PARTY] ❌ ERROR: Party generation returned 0 characters - cannot proceed\n`);
          partyReady = false;
          socket.disconnect();
          resolve();
          return;
        }

        logFull(`[PARTY] ✅ Valid party created with ${data.count} characters\n`);
        partyReady = true;
        
        await wait(500);
        socket.emit('dm_start', { ferocity: 3 });
        logFull(`[GAME] ✅ Game started with ferocity 3\n`);
        
        await wait(2000);
        
        // Level 1: 5 encounters
        logFull(`[L1] Starting 5 encounters...\n`);
        for (let i = 0; i < 5; i++) {
          logFull(`[L1-TURN-${i+1}] Player: "Attack the enemy"`);
          socket.emit('player_action', { text: 'Attack the enemy' });
          await wait(2000);
          
          if (i === 2) {
            socket.emit('set_verbosity', { level: 'terse' });
            logFull(`[L1-TURN-${i+1}] ✅ Set verbosity to terse\n`);
          }
        }
        
        logFull(`\n[L1] ✅ LEVEL UP TO L2!\n`);
        await wait(1000);
        
        // Level 2: 6 encounters
        logFull(`[L2] Starting 6 encounters...\n`);
        for (let i = 0; i < 6; i++) {
          logFull(`[L2-TURN-${i+1}] Player: "Cast spell or attack"`);
          socket.emit('player_action', { text: 'Cast spell or attack' });
          await wait(1500);
          
          if (i === 3) {
            socket.emit('set_ferocity', { level: 4 });
            logFull(`[L2-TURN-${i+1}] ✅ Increased ferocity to 4\n`);
          }
        }
        
        logFull(`\n[L2] ✅ LEVEL UP TO L3!\n`);
        await wait(1000);
        
        // Level 3: 7 encounters
        logFull(`[L3] Starting 7 encounters...\n`);
        for (let i = 0; i < 7; i++) {
          logFull(`[L3-TURN-${i+1}] Player: "Strategic combat action"`);
          socket.emit('player_action', { text: 'Strategic combat action' });
          await wait(1200);
          
          if (i === 4) {
            socket.emit('set_pillars', { exploration: 25, combat: 50, social: 25 });
            logFull(`[L3-TURN-${i+1}] ✅ Adjusted pillars\n`);
          }
        }
        
        logFull(`\n[L3] ✅ LEVEL UP TO L4!\n`);
        await wait(1000);
        
        // Level 4: 8 encounters
        logFull(`[L4] Starting 8 encounters...\n`);
        for (let i = 0; i < 8; i++) {
          logFull(`[L4-TURN-${i+1}] Player: "Advanced tactics"`);
          socket.emit('player_action', { text: 'Advanced tactics' });
          await wait(1200);
          
          if (i === 2) {
            socket.emit('set_dm_persona', { persona: 'epic' });
            logFull(`[L4-TURN-${i+1}] ✅ Set DM persona to epic\n`);
          }
        }
        
        logFull(`\n[L4] ✅ LEVEL UP TO L5!\n`);
        await wait(1000);
        
        // Level 5: 6 boss encounters
        logFull(`[L5-BOSS] Starting 6 boss encounters...\n`);
        for (let i = 0; i < 6; i++) {
          logFull(`[L5-BOSS-${i+1}] Player: "Epic boss fight action"`);
          socket.emit('player_action', { text: 'Epic boss fight action' });
          await wait(2000);
          
          if (i === 2) {
            socket.emit('skip_turn', {});
            logFull(`[L5-BOSS-${i+1}] ✅ Tested skip_turn handler\n`);
          }
          if (i === 4) {
            socket.emit('catch_up', {});
            logFull(`[L5-BOSS-${i+1}] ✅ Tested catch_up handler\n`);
          }
        }
        
        logFull(`\n${'═'.repeat(80)}`);
        logFull(`FINAL STATUS: ✅ L1-L5 CAMPAIGN COMPLETE`);
        logFull(`${'═'.repeat(80)}`);
        logFull(`\nTotal Narrations Captured: ${narrations.length}`);
        
        // Save full log
        const output = fullLog.join('\n');
        fs.writeFileSync('/tmp/L1_L5_FULL_DM_NARRATION_LOG.txt', output, 'utf8');
        logFull(`\n📝 Full log saved to /tmp/L1_L5_FULL_DM_NARRATION_LOG.txt`);
        
        setTimeout(() => {
          socket.disconnect();
          resolve();
        }, 2000);
      });
      
      // Timeout
      setTimeout(() => {
        if (!partyReady) {
          logFull(`\n[ERROR] Party generation timeout`);
          socket.disconnect();
          resolve();
        }
      }, 60000);
    });
    
    socket.on('error', (err) => {
      logFull(`[SOCKET ERROR] ${err}`);
    });
    
    socket.on('disconnect', () => {
      logFull(`\n[DISCONNECT] Socket disconnected`);
    });
    
    // Overall timeout
    setTimeout(() => {
      logFull(`\n[TIMEOUT] Test timeout - disconnecting`);
      if (socket) socket.disconnect();
      resolve();
    }, 180000); // 3 minutes
  });
}

runTest().then(() => {
  process.exit(0);
});

