#!/usr/bin/env node
/**
 * Debug Socket Events - Log ALL socket events to understand flow
 */

const ioModule = require(__dirname + '/node_modules/socket.io/client-dist/socket.io.js');
const io = ioModule.io || ioModule;

const BASE_URL = process.env.BASE_URL || 'https://theystillsing.com';
const GAME_ID = `debug-${Date.now()}`;

let socket = null;

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function test() {
  return new Promise((resolve) => {
    socket = io(BASE_URL, {
      transports: ['websocket'],
      reconnection: true,
    });

    // Capture ALL events
    const originalEmit = socket.onevent.bind(socket);
    socket.onevent = function(packet) {
      const eventName = packet.data[0];
      const eventData = packet.data[1];
      console.log(`\n📡 EVENT RECEIVED: ${eventName}`);
      if (eventData) {
        console.log(`   Data:`, JSON.stringify(eventData).substring(0, 200));
      }
      originalEmit(packet);
    };

    socket.on('connect', async () => {
      console.log('✅ Connected to server\n');

      // Join game
      console.log(`📤 Joining game: ${GAME_ID}\n`);
      socket.emit('join_game', GAME_ID);
      await wait(1500);

      // Start game
      console.log(`📤 Starting game (dm_start)\n`);
      socket.emit('dm_start', {});

      // Wait and listen for events
      console.log('⏳ Waiting 15 seconds for events...\n');
      await wait(15000);

      socket.disconnect();
      resolve();
    });

    socket.on('error', (err) => {
      console.error(`❌ ERROR: ${err}`);
    });

    setTimeout(() => {
      if (socket) socket.disconnect();
      resolve();
    }, 20000);
  });
}

console.log('╔══════════════════════════════════════════════════╗');
console.log('║  DEBUG SOCKET EVENTS - Log all events            ║');
console.log('╚══════════════════════════════════════════════════╝\n');

test().then(() => {
  console.log('\n✅ Debug test complete');
  process.exit(0);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
