#!/usr/bin/env node
/**
 * VERBOSE CAMPAIGN - Actually Captures Narration & Combat
 * Uses Socket.IO streaming events instead of DOM extraction
 */

const ioModule = require(__dirname + '/node_modules/socket.io/client-dist/socket.io.js');
const io = ioModule.io || ioModule;
const fetch = require('node-fetch') || require('node:fetch');

const BASE_URL = process.env.BASE_URL || 'https://theystillsing.com';

const TEST_USER = {
  email: 'test-bot-1@theystillsing.test',
  password: 'TestPassword12345!@#',
  displayName: 'Test Bot 1',
};

let authToken = null;
let gameCount = 0;
let totalTurns = 0;

function log(msg) {
  console.log(msg);
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function authenticate() {
  log(`\n🔐 Authenticating...\n`);
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
        name: `Verbose-Campaign-${Date.now()}`,
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

async function runVerboseCampaign(gameId) {
  return new Promise((resolve) => {
    let turns = [];
    let currentTurn = null;
    let sessionTurns = 0;
    let streamingInProgress = false;  // ✅ FIX: Track if streaming is active

    const socket = io(BASE_URL, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 100,
    });

    // Set up narration listeners FIRST before connecting
    socket.on('dm_stream_start', () => {
      if (currentTurn) {
        streamingInProgress = true;  // ✅ FIX: Mark streaming as active
        currentTurn.narrationBuffer = '';
        currentTurn.isStreaming = true;
        process.stdout.write('🎭 ');
      }
    });

    socket.on('dm_stream_chunk', (data) => {
      if (currentTurn && currentTurn.isStreaming) {
        // Try multiple possible field names for the text
        let text = null;
        if (data) {
          text = data.text || data.content || data.chunk || data.data;
        }

        if (text) {
          currentTurn.narrationBuffer += text;
          process.stdout.write('.');
        } else {
          // Log only once per turn what we got
          if (!currentTurn.diagnosticLogged) {
            currentTurn.diagnosticLogged = true;
            log(`\n[DEBUG TURN ${currentTurn.num}] dm_stream_chunk data keys: ${data ? Object.keys(data).join(', ') : 'null'}`);
            if (data) log(`[DEBUG TURN ${currentTurn.num}] data: ${JSON.stringify(data).substring(0, 200)}`);
          }
          process.stdout.write('?');
        }
      }
    });

    socket.on('dm_stream_end', (data) => {
      if (currentTurn && currentTurn.isStreaming) {
        currentTurn.isStreaming = false;
        streamingInProgress = false;  // ✅ FIX: Mark streaming as complete
        currentTurn.narration = currentTurn.narrationBuffer;

        // If narration is empty, try fallback from data object
        if (!currentTurn.narration && data && data.text) {
          currentTurn.narration = data.text;
        }

        process.stdout.write('✅\n');

        // ✅ FIX: Print narration synchronously to avoid interleaving
        if (currentTurn.narration && currentTurn.narration.length > 0) {
          log(`\n${'─'.repeat(80)}`);
          log(`TURN ${currentTurn.num}\n`);
          log(currentTurn.narration);

          // Extract combat indicators
          const combatMatches = currentTurn.narration.match(
            /(\d+d\d+[+\-\d]*|HIT|MISS|CRITICAL|DAMAGE|attack|spell|initiative)/gi
          );
          if (combatMatches) {
            log(`\n🎲 DICE & COMBAT:`);
            combatMatches.forEach(m => log(`   • ${m}`));
          }
          log(`${'─'.repeat(80)}\n`);
        }
        currentTurn.narrationPrinted = true;  // ✅ FIX: Track that output is done
      }
    });

    socket.on('connect', async () => {
      gameCount++;
      log(`\n${'═'.repeat(80)}`);
      log(`SESSION ${gameCount} - GAME ${gameId.substring(0, 8)}...`);
      log(`${'═'.repeat(80)}\n`);

      // Join and start
      socket.emit('join_game', gameId);
      await wait(1500);

      log(`🎮 Starting game...\n`);
      socket.emit('dm_start', {});
      await wait(2000);

      // Play 15 turns per session
      const actions = [
        'I look around carefully.',
        'I examine everything.',
        'I move forward.',
        'I attack.',
        'I cast a spell.',
        'I listen.',
        'I search.',
        'I prepare.',
        'I investigate.',
        'I approach.',
        'I draw my weapon.',
        'I investigate further.',
        'I take the object.',
        'I try to escape.',
        'I stand firm.',
      ];

      for (let i = 0; i < 15; i++) {
        currentTurn = {
          num: i + 1,
          action: actions[i],
          narration: null,
          narrationBuffer: '',
          isStreaming: false,
        };
        turns.push(currentTurn);
        sessionTurns++;
        totalTurns++;

        log(`\n━━ TURN ${currentTurn.num} ━━`);
        log(`⚔️  ${currentTurn.action}`);
        log(`🔄 Waiting for narration...`);

        socket.emit('player_action', { text: currentTurn.action });

        // Wait for narration with timeout
        const startWait = Date.now();
        while (!currentTurn.narration && Date.now() - startWait < 20000) {
          await wait(200);
        }

        if (!currentTurn.narration) {
          log(`⚠️  No narration received`);
        }
      }

      log(`\n${'═'.repeat(80)}`);
      log(`✅ SESSION COMPLETE: ${sessionTurns} turns`);
      log(`📊 TOTAL: ${totalTurns} turns across ${gameCount} sessions`);
      log(`${'═'.repeat(80)}\n`);

      // ✅ FIX: Wait for any pending streaming to complete
      // Even after turn loop ends, some streams might still be in flight
      const streamWaitStart = Date.now();
      while (streamingInProgress && Date.now() - streamWaitStart < 10000) {
        await wait(500);
      }

      // Extra buffer for output flushing
      await wait(3000);
      socket.disconnect();
      // Final buffer after disconnect to ensure all console output is flushed
      await wait(2000);
      resolve();
    });

    socket.on('error', (err) => {
      log(`❌ Socket error: ${err}`);
    });

    setTimeout(() => {
      socket.disconnect();
      resolve();
    }, 90000);
  });
}

async function main() {
  console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
  console.log(`║              TAVERN TABLE - VERBOSE CAMPAIGN                    ║`);
  console.log(`║    Full Narration, Dice Rolls, and Combat Capture              ║`);
  console.log(`╚════════════════════════════════════════════════════════════════╝`);

  if (!await authenticate()) {
    process.exit(1);
  }

  // Run 4 sessions sequentially (15 turns each = 60 turns total)
  for (let s = 0; s < 4; s++) {
    const gameId = await createGame();
    if (!gameId) {
      log(`❌ Failed to create game`);
      continue;
    }

    // WAIT for session to complete before starting next
    await runVerboseCampaign(gameId);
    // Add significant delay between sessions to ensure all output completes
    await wait(5000);
  }

  // Final wait to ensure all output is flushed
  await wait(3000);

  console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
  console.log(`║                    CAMPAIGN COMPLETE                           ║`);
  console.log(`║              Total: ${totalTurns} turns across ${gameCount} sessions                  ║`);
  console.log(`╚════════════════════════════════════════════════════════════════╝\n`);

  process.exit(0);
}

main();
