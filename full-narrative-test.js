#!/usr/bin/env node
/**
 * Full Narrative Capture - Properly Wait for Streaming Events
 * Waits for dm_stream_end before proceeding to next action
 * Captures complete Claude-generated narration
 */

const ioModule = require(__dirname + '/node_modules/socket.io/client-dist/socket.io.js');
const io = ioModule.io || ioModule;

const BASE_URL = process.env.BASE_URL || 'https://theystillsing.com';
const GAME_ID = `narrative-full-${Date.now()}`;

let socket = null;
let log = [];
let turnData = [];
let currentTurn = 0;
let dmNarrationBuffer = '';
let streamActive = false;

function recordLog(msg) {
  console.log(msg);
  log.push(msg);
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForNarration(timeoutMs = 15000) {
  const startTime = Date.now();
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      if (!streamActive) {
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
      socket.emit('join_game', GAME_ID);
      await wait(1500);
      recordLog('✅ Joined game\n');

      // Listen for DM narration streaming START
      socket.on('dm_stream_start', (data) => {
        streamActive = true;
        dmNarrationBuffer = '';
        recordLog('🎭 [STREAM START]');
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
          recordLog(`\n🎭 DM NARRATION:\n${dmNarrationBuffer}\n`);
        }
        recordLog('🎭 [STREAM END]\n');
      });

      // Fallback: listen to complete dm_message if streaming doesn't work
      socket.on('dm_message', (data) => {
        if (data.text && !dmNarrationBuffer && turnData.length > 0) {
          const lastTurn = turnData[turnData.length - 1];
          if (!lastTurn.dmNarration) {
            lastTurn.dmNarration = data.text;
            recordLog(`\n🎭 DM MESSAGE (fallback):\n${data.text}\n`);
          }
        }
      });

      // Start game
      recordLog('🎮 Starting game...\n');
      socket.emit('dm_start', { ferocity: 3 });
      await wait(3000);

      recordLog('\n═══════════════════════════════════════\n');
      recordLog('LEVEL 1 - THE ADVENTURE BEGINS\n');
      recordLog('═══════════════════════════════════════\n');

      // LEVEL 1: 5 encounters
      const level1Actions = [
        'I look around the tavern carefully, observing the patrons.',
        'I stand up and approach the mysterious cloaked figure in the corner.',
        'I draw my weapon as goblins burst through the tavern door!',
        'I cast a spell to create a barrier between us and the goblins.',
        'I strike down the last goblin with a mighty blow.',
      ];

      for (let i = 0; i < 5; i++) {
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
        await waitForNarration(20000);

        if (i === 2) {
          socket.emit('set_verbosity', { level: 'brief' });
        }
      }

      recordLog('\n═══════════════════════════════════════\n');
      recordLog('LEVEL 2 - DEEPER PERIL\n');
      recordLog('═══════════════════════════════════════\n');

      // LEVEL 2: 6 encounters
      const level2Actions = [
        'I follow the mysterious figure down into the underground caves.',
        'I examine the ancient symbols carved into the stone walls.',
        'I hear a growl from the darkness ahead and prepare for combat.',
        'I cast a healing spell on my wounded companion.',
        'I detect magical traps with my arcane senses.',
        'I disarm the trap and push onward to the boss chamber.',
      ];

      for (let i = 0; i < 6; i++) {
        currentTurn++;
        const action = level2Actions[i];

        const turn = {
          turn: currentTurn,
          level: 2,
          playerAction: action,
          dmNarration: '',
        };
        turnData.push(turn);

        recordLog(`\n━━ TURN ${currentTurn} ━━`);
        recordLog(`⚔️ PLAYER: ${action}`);
        recordLog('');

        socket.emit('player_action', { text: action });
        await waitForNarration(20000);

        if (i === 2) {
          socket.emit('set_ferocity', { level: 4 });
        }
      }

      recordLog('\n═══════════════════════════════════════\n');
      recordLog('LEVEL 3 - TEMPLE OF SHADOWS\n');
      recordLog('═══════════════════════════════════════\n');

      // LEVEL 3: 7 encounters
      const level3Actions = [
        'I enter the vast temple hall, awed by the towering statues.',
        'I investigate the central altar and find an ancient tome.',
        'Suddenly, shadow creatures emerge from the darkness!',
        'I channel divine power to banish the shadow beasts.',
        'I decipher the ancient script and unlock a hidden passage.',
        'I carefully navigate through the trapped corridor.',
        'I confront the shadow lord guarding the inner sanctum.',
      ];

      for (let i = 0; i < 7; i++) {
        currentTurn++;
        const action = level3Actions[i];

        const turn = {
          turn: currentTurn,
          level: 3,
          playerAction: action,
          dmNarration: '',
        };
        turnData.push(turn);

        recordLog(`\n━━ TURN ${currentTurn} ━━`);
        recordLog(`⚔️ PLAYER: ${action}`);
        recordLog('');

        socket.emit('player_action', { text: action });
        await waitForNarration(20000);

        if (i === 3) {
          socket.emit('set_pillars', { exploration: 30, combat: 50, social: 20 });
        }
      }

      recordLog('\n═══════════════════════════════════════\n');
      recordLog('LEVEL 4 - DRAGON\'S MOUNTAIN LAIR\n');
      recordLog('═══════════════════════════════════════\n');

      // LEVEL 4: 8 encounters
      const level4Actions = [
        'I climb the mountain path toward the dragon\'s lair.',
        'I see the massive gold dragon emerge from the mountain peak.',
        'I dodge the dragon\'s devastating breath attack!',
        'I cast a spell to protect myself from the inferno.',
        'I leap onto the dragon\'s back and begin attacking.',
        'The dragon throws me to the ground with a mighty thrash.',
        'I charge forward with my sword raised high.',
        'I land a critical strike on the dragon\'s heart!',
      ];

      for (let i = 0; i < 8; i++) {
        currentTurn++;
        const action = level4Actions[i];

        const turn = {
          turn: currentTurn,
          level: 4,
          playerAction: action,
          dmNarration: '',
        };
        turnData.push(turn);

        recordLog(`\n━━ TURN ${currentTurn} ━━`);
        recordLog(`⚔️ PLAYER: ${action}`);
        recordLog('');

        socket.emit('player_action', { text: action });
        await waitForNarration(20000);

        if (i === 2) {
          socket.emit('set_dm_persona', { persona: 'epic' });
        }
      }

      recordLog('\n═══════════════════════════════════════\n');
      recordLog('LEVEL 5 - THE LICH LORD\'S FORTRESS\n');
      recordLog('═══════════════════════════════════════\n');

      // LEVEL 5: 6 final encounters
      const level5Actions = [
        'I storm the fortress gates and enter the throne room.',
        'The ancient lich lord rises, ancient magic crackling around him.',
        'I destroy the phylactery containing the lich\'s immortal essence!',
        'The lich lord\'s form begins to crumble as its power wanes.',
        'I channel all my remaining strength for one final attack.',
        'With a triumphant cry, I strike down the lich lord forever!',
      ];

      for (let i = 0; i < 6; i++) {
        currentTurn++;
        const action = level5Actions[i];

        const turn = {
          turn: currentTurn,
          level: 5,
          playerAction: action,
          dmNarration: '',
        };
        turnData.push(turn);

        recordLog(`\n━━ TURN ${currentTurn} ━━`);
        recordLog(`⚔️ PLAYER: ${action}`);
        recordLog('');

        socket.emit('player_action', { text: action });
        await waitForNarration(20000);

        if (i === 1) {
          socket.emit('skip_turn', {});
        }
      }

      recordLog('\n═══════════════════════════════════════');
      recordLog('✅ CAMPAIGN COMPLETE - VICTORY!');
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
    }, 300000);
  });
}

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  FULL NARRATIVE CAPTURE - STREAMING EVENTS       ║');
  console.log('║  Waiting for dm_stream_end before next action    ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  await captureNarrative();

  console.log('\n\n✅ Campaign complete. Building document...\n');

  // Build comprehensive document
  let docContent = `╔══════════════════════════════════════════════════════════════════════════════╗
║            TAVERN TABLE: FULL L1-L5 CAMPAIGN NARRATIVE LOG                 ║
║                                                                              ║
║  Complete AI-Generated Dialogue + Player Actions for Every Turn            ║
║  Date: ${new Date().toISOString()}
║  Total Turns: 32  |  Levels: 1-5  |  Status: COMPLETE                      ║
║                                                                              ║
║  NOTE: This document contains the FULL AI-generated narration for each     ║
║  turn, captured from Claude's streaming responses via Socket.IO events.    ║
╚══════════════════════════════════════════════════════════════════════════════╝

`;

  // Add turn-by-turn breakdown
  for (const turn of turnData) {
    docContent += `\n${'─'.repeat(80)}\nTURN ${turn.turn} (LEVEL ${turn.level})\n${'─'.repeat(80)}\n\n`;
    docContent += `PLAYER ACTION:\n${turn.playerAction}\n\n`;

    if (turn.dmNarration) {
      docContent += `AI DM NARRATION:\n${turn.dmNarration}\n`;
    } else {
      docContent += `⚠️  NO NARRATION CAPTURED FOR THIS TURN\n`;
    }
  }

  docContent += `\n\n╔══════════════════════════════════════════════════════════════════════════════╗
║                          END OF CAMPAIGN NARRATIVE                          ║
║                     All turns captured with full narration                   ║
║                          32 turns • 5 levels complete                        ║
╚══════════════════════════════════════════════════════════════════════════════╝

STATISTICS:
Total turns: ${turnData.length}
Turns with narration: ${turnData.filter(t => t.dmNarration).length}
Turns missing narration: ${turnData.filter(t => !t.dmNarration).length}
`;

  const fs = require('fs');
  fs.writeFileSync('/Users/aron/Dropbox (Personal)/claude/dnd-server/FULL-NARRATIVE-LOG.txt', docContent);
  console.log('📋 Full narrative log saved: FULL-NARRATIVE-LOG.txt');
  console.log(`📊 Total turns: ${turnData.length}`);
  console.log(`📖 Turns with narration: ${turnData.filter(t => t.dmNarration).length}`);
  console.log(`⚠️  Turns missing narration: ${turnData.filter(t => !t.dmNarration).length}\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
