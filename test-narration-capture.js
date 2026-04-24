#!/usr/bin/env node
/**
 * Test Narration Capture - Proper Game Setup
 * Creates game in DB, joins via Socket.IO, captures all narration
 */

const ioModule = require(__dirname + '/node_modules/socket.io/client-dist/socket.io.js');
const io = ioModule.io || ioModule;
const db = require('./db');
const crypto = require('crypto');

const BASE_URL = process.env.BASE_URL || 'https://theystillsing.com';

let socket = null;
let gameId = null;
let turns = [];

function log(msg) {
  console.log(msg);
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function setupGame() {
  gameId = `test-narrative-${crypto.randomUUID()}`;
  log(`🎲 Creating game in database: ${gameId}`);

  try {
    await db.createGame(gameId, `Narrative Test ${Date.now()}`, 'dnd5e');
    log(`✅ Game created in DB\n`);
    return true;
  } catch (err) {
    log(`❌ Failed to create game: ${err.message}`);
    return false;
  }
}

async function captureTest() {
  return new Promise((resolve) => {
    socket = io(BASE_URL, {
      transports: ['websocket'],
      reconnection: true,
    });

    let narrationBuffer = '';
    let isStreaming = false;

    socket.on('connect', async () => {
      log('✅ Connected to server\n');

      // Setup event handlers BEFORE joining
      socket.on('dm_message', (data) => {
        if (data.text && turns.length > 0) {
          const lastTurn = turns[turns.length - 1];
          if (!lastTurn.narration) {
            lastTurn.narration = data.text;
            log(`\n📖 DM NARRATION (${data.text.length} chars):`);
            log(data.text.substring(0, 200) + '...\n');
          }
        }
      });

      socket.on('dm_stream_chunk', (data) => {
        if (data.chunk) {
          narrationBuffer += data.chunk;
          process.stdout.write('.');
        }
      });

      socket.on('dm_stream_end', (data) => {
        isStreaming = false;
        if (narrationBuffer && turns.length > 0) {
          const lastTurn = turns[turns.length - 1];
          lastTurn.narration = narrationBuffer;
          log(`\n📖 STREAMED NARRATION (${narrationBuffer.length} chars):`);
          log(narrationBuffer.substring(0, 200) + '...\n');
          narrationBuffer = '';
        }
      });

      socket.on('error_msg', (data) => {
        log(`❌ Server error: ${data.text}`);
      });

      // Join game
      log(`📤 Joining game: ${gameId}\n`);
      socket.emit('join_game', gameId);
      await wait(1500);

      // Start game
      log(`🎮 Starting game...\n`);
      socket.emit('dm_start', {});
      await wait(2000);

      // Test 3 turns
      log('═══════════════════════════════════════');
      log('TESTING 3 TURNS OF NARRATION');
      log('═══════════════════════════════════════\n');

      const actions = [
        'I look around cautiously.',
        'I draw my sword and prepare for battle.',
        'I cast a fireball spell!',
      ];

      for (let i = 0; i < 3; i++) {
        const action = actions[i];
        const turn = {
          num: i + 1,
          action,
          narration: null,
        };
        turns.push(turn);

        log(`\n━━ TURN ${turn.num} ━━`);
        log(`⚔️  Player: ${action}`);
        log('🔄 Waiting for narration...');

        socket.emit('player_action', { text: action });

        // Wait for narration with timeout
        const startWait = Date.now();
        while (!turn.narration && Date.now() - startWait < 15000) {
          await wait(100);
        }

        if (!turn.narration) {
          log('⚠️  No narration received after 15s');
        }
      }

      log('\n═══════════════════════════════════════');
      log('✅ TEST COMPLETE');
      log('═══════════════════════════════════════\n');

      await wait(1000);
      socket.disconnect();
      resolve();
    });

    socket.on('error', (err) => {
      log(`❌ Socket error: ${err}`);
    });

    setTimeout(() => {
      if (socket) socket.disconnect();
      resolve();
    }, 90000);
  });
}

async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║  TEST NARRATION CAPTURE                    ║');
  console.log('║  Create game → Join → Capture narration    ║');
  console.log('╚════════════════════════════════════════════╝\n');

  if (!await setupGame()) {
    await db.pool.end();
    process.exit(1);
  }

  await captureTest();

  // Summary
  log('\n📊 RESULTS:');
  log(`Total turns: ${turns.length}`);
  turns.forEach((turn, idx) => {
    const hasNarration = turn.narration && turn.narration.length > 0;
    const status = hasNarration ? '✅' : '❌';
    const length = hasNarration ? ` (${turn.narration.length} chars)` : '';
    log(`  Turn ${turn.num}: ${status}${length}`);
  });

  const withNarration = turns.filter(t => t.narration && t.narration.length > 0).length;
  log(`\nNarration captured: ${withNarration}/${turns.length}`);

  if (withNarration > 0) {
    log('\n✅ SUCCESS - Narration is being captured!');
  } else {
    log('\n❌ NO NARRATION - Check server logs');
  }

  // Save full results
  const fs = require('fs');
  const output = {
    gameId,
    turns,
    summary: { total: turns.length, captured: withNarration },
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync('/Users/aron/Dropbox (Personal)/claude/dnd-server/NARRATION-TEST-RESULTS.json', JSON.stringify(output, null, 2));
  log('\n📁 Results saved to NARRATION-TEST-RESULTS.json');

  await db.pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
