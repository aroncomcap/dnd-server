#!/usr/bin/env node
/**
 * Test Narration Capture - With TEST_MODE Support
 *
 * Usage: TEST_MODE=true npm start (in one terminal)
 * Then:  node test-with-narration.js (in another terminal)
 *
 * This script tests a full 3-turn campaign and captures all narration
 */

const ioModule = require(__dirname + '/node_modules/socket.io/client-dist/socket.io.js');
const io = ioModule.io || ioModule;
const fs = require('fs');
const crypto = require('crypto');

const BASE_URL = process.env.BASE_URL || 'https://theystillsing.com';
const GAME_ID = `test-${crypto.randomUUID()}`;

let socket = null;
let turns = [];
let currentTurnNum = 0;

function log(msg) {
  console.log(msg);
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runTest() {
  return new Promise((resolve) => {
    socket = io(BASE_URL, {
      transports: ['websocket'],
      reconnection: true,
    });

    socket.on('connect', async () => {
      log('✅ Connected to server\n');

      // Setup event listeners
      socket.on('dm_message', (data) => {
        if (data.text && turns.length > currentTurnNum) {
          const turn = turns[currentTurnNum];
          if (!turn.narration) {
            turn.narration = data.text;
            log(`\n📖 NARRATION RECEIVED (${data.text.length} chars):`);
            log(`   "${data.text.substring(0, 150)}..."\n`);
          }
        }
      });

      socket.on('error_msg', (data) => {
        log(`❌ Error: ${data.text}`);
      });

      // Join game (will auto-create in TEST_MODE)
      log(`📤 Joining game: ${GAME_ID}`);
      socket.emit('join_game', GAME_ID);
      await wait(1500);

      // Start game
      log(`🎮 Starting game...\n`);
      socket.emit('dm_start', {});
      await wait(2000);

      // Test 3 turns with different actions
      const actions = [
        'I look around the tavern carefully.',
        'I approach the cloaked figure.',
        'I draw my sword as danger approaches!',
      ];

      for (let i = 0; i < 3; i++) {
        currentTurnNum = i;
        const turn = {
          num: i + 1,
          action: actions[i],
          narration: null,
        };
        turns.push(turn);

        log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        log(`TURN ${turn.num}`);
        log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        log(`⚔️  Player Action: ${turn.action}`);
        log(`🔄 Waiting for narration...`);

        socket.emit('player_action', { text: turn.action });

        // Wait for narration with timeout
        const startWait = Date.now();
        while (!turn.narration && Date.now() - startWait < 20000) {
          await wait(200);
        }

        if (!turn.narration) {
          log(`⚠️  NO NARRATION RECEIVED (timeout after 20s)`);
          turn.narration = '[NO NARRATION CAPTURED]';
        }

        await wait(500);
      }

      log(`\n${'━'.repeat(50)}`);
      log(`✅ TEST COMPLETE`);
      log(`${'━'.repeat(50)}\n`);

      // Summary
      log(`📊 RESULTS:`);
      log(`   Game ID: ${GAME_ID}`);
      log(`   Total turns: ${turns.length}`);

      const withNarration = turns.filter(t => t.narration && !t.narration.includes('NO NARRATION')).length;
      log(`   Turns with narration: ${withNarration}/${turns.length}`);

      if (withNarration > 0) {
        log(`\n✅ SUCCESS - Narration is being captured!\n`);
      } else {
        log(`\n❌ FAILURE - No narration captured\n`);
      }

      // Log each turn
      log(`${'═'.repeat(60)}\nDETAILED TURN LOG\n${'═'.repeat(60)}\n`);
      turns.forEach((turn) => {
        log(`TURN ${turn.num}:`);
        log(`  Player: ${turn.action}`);
        log(`  DM: ${turn.narration ? turn.narration.substring(0, 100) + '...' : '[NO NARRATION]'}`);
        log('');
      });

      // Save results
      const results = {
        gameId: GAME_ID,
        timestamp: new Date().toISOString(),
        turns: turns.map(t => ({
          num: t.num,
          playerAction: t.action,
          dmNarration: t.narration,
        })),
        summary: {
          total: turns.length,
          withNarration,
          withoutNarration: turns.length - withNarration,
        },
      };

      const outputFile = '/Users/aron/Dropbox (Personal)/claude/dnd-server/TEST-RESULTS.json';
      fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
      log(`📁 Full results saved to TEST-RESULTS.json\n`);

      await wait(1000);
      socket.disconnect();
      resolve();
    });

    socket.on('error', (err) => {
      log(`❌ Socket error: ${err}`);
      resolve();
    });

    setTimeout(() => {
      if (socket) socket.disconnect();
      resolve();
    }, 120000);
  });
}

async function main() {
  console.log(`╔${'═'.repeat(58)}╗`);
  console.log(`║  TEST NARRATION CAPTURE - WITH TEST_MODE SUPPORT        ║`);
  console.log(`║  Tests 3 turns of gameplay with AI-generated narration  ║`);
  console.log(`╚${'═'.repeat(58)}╝\n`);

  log(`To run this test:`);
  log(`  1. In terminal 1: TEST_MODE=true npm start`);
  log(`  2. In terminal 2: node test-with-narration.js\n`);
  log(`Expected: Each turn should receive DM narration\n`);

  await runTest();

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
