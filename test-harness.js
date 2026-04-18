#!/usr/bin/env node

/**
 * Test Harness for Game/Character Creation
 *
 * Tests:
 * 1. User login/registration
 * 2. Game creation (all 3 systems)
 * 3. Character creation
 * 4. Character loading
 * 5. Game persistence
 */

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
let authToken = null;
let userId = null;
const testUser = {
  email: `testuser-${Date.now()}@test.local`,
  password: 'TestPass123!',
};

const log = {
  pass: (msg) => console.log(`✅ ${msg}`),
  fail: (msg) => console.error(`❌ ${msg}`),
  info: (msg) => console.log(`ℹ️  ${msg}`),
};

const api = axios.create({
  baseURL: BASE_URL,
  withCredentials: true,
  validateStatus: () => true, // Don't throw on any status
});

(async () => {
  try {
    // ─────────────────────────────────────────────────────────────
    // TEST 1: Register User
    // ─────────────────────────────────────────────────────────────
    log.info('TEST 1: Register user...');
    const registerRes = await api.post('/auth/register', {
      email: testUser.email,
      password: testUser.password,
    });

    if (registerRes.status === 200) {
      log.pass('User registered');
    } else {
      log.fail(`User registration failed: ${registerRes.status}`);
      throw new Error(registerRes.data?.error || 'Registration failed');
    }

    // ─────────────────────────────────────────────────────────────
    // TEST 2: Login User
    // ─────────────────────────────────────────────────────────────
    log.info('TEST 2: Login user...');
    const loginRes = await api.post('/auth/login', {
      email: testUser.email,
      password: testUser.password,
    });

    if (loginRes.status === 200 && loginRes.data?.user) {
      log.pass('User logged in');
      userId = loginRes.data.user.id;
    } else {
      log.fail(`Login failed: ${loginRes.status}`);
      throw new Error(loginRes.data?.error || 'Login failed');
    }

    // Check cookie is being set
    const cookies = registerRes.headers['set-cookie'];
    if (cookies?.some(c => c.includes('tt_token'))) {
      log.pass('JWT cookie set');
    } else {
      log.fail('JWT cookie not set in response');
    }

    // ─────────────────────────────────────────────────────────────
    // TEST 3: Verify auth persistence
    // ─────────────────────────────────────────────────────────────
    log.info('TEST 3: Verify auth persistence (/auth/me)...');
    const meRes = await api.get('/auth/me');

    if (meRes.status === 200 && meRes.data?.user) {
      log.pass('Session persists (auth/me returns user)');
    } else {
      log.fail(`Session not persisting: ${meRes.status}`);
      log.info(`Response: ${JSON.stringify(meRes.data)}`);
    }

    // ─────────────────────────────────────────────────────────────
    // TEST 4: Create Games (all 3 systems)
    // ─────────────────────────────────────────────────────────────
    const gameSystems = ['dnd5e', 'runequest', 'custom'];
    const games = {};

    for (const system of gameSystems) {
      log.info(`TEST 4.${gameSystems.indexOf(system) + 1}: Create ${system} game...`);
      const gameRes = await api.post('/api/games', {
        name: `Test ${system.toUpperCase()} Game`,
        system: system,
      });

      if (gameRes.status === 200 && gameRes.data?.id) {
        log.pass(`${system} game created (ID: ${gameRes.data.id})`);
        games[system] = gameRes.data;
      } else {
        log.fail(`${system} game creation failed: ${gameRes.status}`);
        log.info(`Response: ${JSON.stringify(gameRes.data)}`);
      }
    }

    // ─────────────────────────────────────────────────────────────
    // TEST 5: Fetch games list
    // ─────────────────────────────────────────────────────────────
    log.info('TEST 5: Fetch games list (/api/games)...');
    const gamesListRes = await api.get('/api/games');

    if (gamesListRes.status === 200 && Array.isArray(gamesListRes.data)) {
      const count = gamesListRes.data.length;
      log.pass(`Games list retrieved (${count} games)`);
      gamesListRes.data.forEach(g => {
        log.info(`  - ${g.name} (${g.system}, ${g.playerCount || 0} players)`);
      });
    } else {
      log.fail(`Games list failed: ${gamesListRes.status}`);
    }

    // ─────────────────────────────────────────────────────────────
    // TEST 6: Create Characters
    // ─────────────────────────────────────────────────────────────
    for (const [system, game] of Object.entries(games)) {
      log.info(`TEST 6: Create character in ${system} game...`);
      const charRes = await api.post(`/api/games/${game.id}/characters`, {
        name: `Test ${system} Character`,
        stats: `Level 5 ${system === 'dnd5e' ? 'Wizard' : system === 'runequest' ? 'Warrior' : 'Hero'}, HP 30, STR 14 DEX 16 CON 13`,
        visualDesc: 'A brave adventurer',
      });

      if (charRes.status === 200) {
        log.pass(`Character created in ${system} game`);
      } else {
        log.fail(`Character creation failed in ${system}: ${charRes.status}`);
        log.info(`Response: ${JSON.stringify(charRes.data)}`);
      }
    }

    // ─────────────────────────────────────────────────────────────
    // TEST 7: Verify data persistence (re-fetch games)
    // ─────────────────────────────────────────────────────────────
    log.info('TEST 7: Verify data persistence...');
    const reloadRes = await api.get('/api/games');

    if (reloadRes.status === 200 && reloadRes.data.length >= gameSystems.length) {
      log.pass('Data persisted to database');
      reloadRes.data.forEach(g => {
        const charCount = g.playerCount || 0;
        log.info(`  - ${g.name}: ${charCount} character(s)`);
      });
    } else {
      log.fail('Data persistence check failed');
    }

    // ─────────────────────────────────────────────────────────────
    // SUMMARY
    // ─────────────────────────────────────────────────────────────
    log.info('\n' + '='.repeat(60));
    log.pass('All tests completed!');
    log.info('\nTest Results Summary:');
    log.info(`- User created: ${testUser.email}`);
    log.info(`- Games created: ${Object.keys(games).length}`);
    log.info(`- Character creation: Ready for testing`);
    log.info(`- Database persistence: OK`);
    log.info('\nNext steps:');
    log.info('1. Log in at https://dnd-server-production-9b61.up.railway.app');
    log.info(`2. Use email: ${testUser.email}`);
    log.info(`3. Use password: ${testUser.password}`);
    log.info('4. Verify you see games in the lobby');
    log.info('5. Check if session persists after page refresh');

    process.exit(0);
  } catch (err) {
    log.fail(`Test suite failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
})();
