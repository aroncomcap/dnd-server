#!/usr/bin/env node
/**
 * Full Narrative Capture - with Game Creation
 * Creates game via API, then joins via Socket.IO and captures narration
 */

const ioModule = require(__dirname + '/node_modules/socket.io/client-dist/socket.io.js');
const io = ioModule.io || ioModule;
const https = require('https');

const BASE_URL = process.env.BASE_URL || 'https://theystillsing.com';

let socket = null;
let log = [];
let turnData = [];
let currentTurn = 0;
let dmNarrationBuffer = '';
let streamActive = false;
let gameId = null;

function recordLog(msg) {
  console.log(msg);
  log.push(msg);
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function httpsRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function createGame() {
  recordLog('📤 Creating game via API...');
  try {
    // Create a game without auth (allows test games)
    // Actually, let's use POST directly without auth for testing
    const result = await httpsRequest('POST', '/api/games/test', {
      name: `Narrative Test ${Date.now()}`,
      system: 'dnd5e',
    });

    if (result.status === 401) {
      // Auth required - try creating without API
      recordLog('⚠️  API requires auth. Creating test game locally...');
      gameId = `test-${Date.now()}`;
      return true;
    }

    if (result.data?.id) {
      gameId = result.data.id;
      recordLog(`✅ Game created: ${gameId}\n`);
      return true;
    }

    recordLog(`❌ Failed to create game: ${result.status}`);
    return false;
  } catch (err) {
    recordLog(`⚠️  API error: ${err.message}. Creating test game locally...`);
    gameId = `test-${Date.now()}`;
    return true;
  }
}

async function waitForNarration(timeoutMs = 20000) {
  const startTime = Date.now();
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      if (!streamActive && dmNarrationBuffer) {
        clearInterval(checkInterval);
        resolve();
        return;
      }
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(checkInterval);
        recordLog(`⚠️  Narration wait timed out after ${timeoutMs}ms`);
        resolve();
      }
    }, 100);
  });
}

async function captureNarrative() {
  return new Promise((resolve) => {
    socket = io(BASE_URL, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 100,
    });

    socket.on('connect', async () => {
      recordLog('✅ Connected to server\n');

      // Join game
      recordLog(`📤 Joining game: ${gameId}\n`);
      socket.emit('join_game', gameId);
      await wait(1500);

      // Listen for ALL events for debugging
      const eventLog = {};
      socket.onAny((eventName, ...args) => {
        if (!eventLog[eventName]) {
          eventLog[eventName] = 0;
        }
        eventLog[eventName]++;
      });

      // Listen for DM narration streaming START
      socket.on('dm_stream_start', (data) => {
        streamActive = true;
        dmNarrationBuffer = '';
        recordLog('[STREAM START]');
      });

      // Listen for DM narration streaming chunks
      socket.on('dm_stream_chunk', (data) => {
        if (data.chunk) {
          dmNarrationBuffer += data.chunk;
          process.stdout.write('.');
        }
      });

      // Listen for DM narration streaming END
      socket.on('dm_stream_end', (data) => {
        streamActive = false;
        if (dmNarrationBuffer && turnData.length > 0) {
          const lastTurn = turnData[turnData.length - 1];
          lastTurn.dmNarration = dmNarrationBuffer;
          recordLog(`\n📖 STREAMED NARRATION:\n${dmNarrationBuffer}\n`);
        }
        recordLog('[STREAM END]\n');
      });

      // Fallback: listen to complete dm_message
      socket.on('dm_message', (data) => {
        if (data.text && turnData.length > 0) {
          const lastTurn = turnData[turnData.length - 1];
          if (!lastTurn.dmNarration || lastTurn.dmNarration.length === 0) {
            lastTurn.dmNarration = data.text;
            recordLog(`\n📖 DM MESSAGE:\n${data.text}\n`);
          }
        }
      });

      // Log errors
      socket.on('error_msg', (data) => {
        recordLog(`❌ Server Error: ${data.text}`);
      });

      // Start game
      recordLog('🎮 Starting game (dm_start)...\n');
      socket.emit('dm_start', { ferocity: 3 });
      await wait(3000);

      recordLog('═══════════════════════════════════════\n');
      recordLog('LEVEL 1 - THE ADVENTURE BEGINS\n');
      recordLog('═══════════════════════════════════════\n');

      // LEVEL 1: Just test first 2 turns
      const level1Actions = [
        'I look around the tavern carefully, observing the patrons.',
        'I stand up and approach the mysterious cloaked figure in the corner.',
      ];

      for (let i = 0; i < 2; i++) {
        currentTurn++;
        const action = level1Actions[i];

        const turn = {
          turn: currentTurn,
          level: 1,
          playerAction: action,
          dmNarration: '',
        };
        turnData.push(turn);

        recordLog(`\n━━ TURN ${currentTurn} ━━`);
        recordLog(`⚔️ PLAYER: ${action}`);
        recordLog('');

        socket.emit('player_action', { text: action });
        await waitForNarration(25000);
        await wait(500);
      }

      recordLog('\n═══════════════════════════════════════');
      recordLog('✅ TEST COMPLETE');
      recordLog('═══════════════════════════════════════\n');

      await wait(2000);
      socket.disconnect();
      resolve();
    });

    socket.on('error', (err) => {
      recordLog(`❌ ERROR: ${err}`);
    });

    setTimeout(() => {
      if (socket) socket.disconnect();
      resolve();
    }, 120000);
  });
}

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  FULL NARRATIVE CAPTURE - WITH GAME CREATION     ║');
  console.log('║  Tests streaming narration with debug info       ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (!await createGame()) {
    console.error('❌ Failed to create game');
    process.exit(1);
  }

  await captureNarrative();

  console.log('\n\n✅ Test complete.\n');

  // Summary
  console.log('📊 SUMMARY:');
  console.log(`   Total turns: ${turnData.length}`);
  console.log(`   Turns with narration: ${turnData.filter(t => t.dmNarration && t.dmNarration.length > 0).length}`);
  console.log(`   Turns missing narration: ${turnData.filter(t => !t.dmNarration || t.dmNarration.length === 0).length}`);

  // Log any turns without narration
  const missingTurns = turnData.filter(t => !t.dmNarration || t.dmNarration.length === 0);
  if (missingTurns.length > 0) {
    console.log(`\n⚠️  Turns without narration:`);
    missingTurns.forEach(t => console.log(`   Turn ${t.turn}: ${t.playerAction.substring(0, 50)}...`));
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
