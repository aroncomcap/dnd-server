#!/usr/bin/env node
'use strict';

/**
 * Combat Balance Test — runs 10 combats + 5 challenges against the live server.
 * Always uses terse mode. Reports party DPR, monster DPR, round counts, deaths.
 * Includes socket reconnection and retry logic.
 *
 * Usage: node test-combat-balance.js [url] [--party balanced|melee-heavy|caster-heavy|generate]
 * Cost: ~$0.30 for 10 combats + 5 challenges (~30 turns)
 *
 * --party generate  : use generate_party API (original behavior, adds ~$0.01 + 5-10s)
 * --party balanced  : use stock balanced party from tests/fixtures/stock-parties.json (default)
 * --party melee-heavy : use stock melee-heavy party
 * --party caster-heavy : use stock caster-heavy party
 */

const ioModule = require(__dirname + '/node_modules/socket.io/client-dist/socket.io.js');
const Client = ioModule.io || ioModule;
const ed = require('./encounter-designer');
const path = require('path');
const fs = require('fs');

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let SERVER_URL = 'https://dnd-server-production-9b61.up.railway.app';
let partyMode = 'balanced'; // default

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--party' && args[i + 1]) {
    partyMode = args[i + 1];
    i++;
  } else if (!args[i].startsWith('--')) {
    SERVER_URL = args[i];
  }
}

let GAME_ID = `test-combat-${Date.now().toString(36)}`;
const TARGET_COMBATS = 10;
const TARGET_CHALLENGES = 5;
const MAX_CONSECUTIVE_FAILURES = 3;

const TEST_EMAIL = 'test@tavern-table.local';
const TEST_PASSWORD = 'test-combat-harness-2024';
const TEST_DISPLAY_NAME = 'Combat Test';

const results = {
  combats: [], challenges: [], errors: 0, totalTurns: 0,
  partyLevel: 0, partyDPR: 0, partyHP: 0, startTime: Date.now(),
};

let turnCount = 0, currentPlayer = null, lastOptions = [];
let characters = {}, gameStarted = false, gameCreated = false;
let combatsCompleted = 0, challengesCompleted = 0;
let inCombat = false, combatStartTurn = 0, combatWords = 0;
let consecutiveFailures = 0, reconnectCount = 0;
let combatIndicatorCount = 0, noCombatCount = 0;
let authToken = null;
// Engine-event tracking: true when server has confirmed combat is active via socket events
let engineCombatActive = false;
// Last round number seen via combat_update (to detect stalled combat)
let lastEngineRound = 0;

// Load stock party fixture (if not using generate mode)
let stockParty = null;
if (partyMode !== 'generate') {
  const fixturePath = path.join(__dirname, 'tests', 'fixtures', 'stock-parties.json');
  const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  stockParty = fixtures[partyMode];
  if (!stockParty) {
    console.error(`Unknown party mode: "${partyMode}". Valid: balanced, melee-heavy, caster-heavy, generate`);
    process.exit(1);
  }
}

console.log(`\n⚔️  Combat Balance Test — ${TARGET_COMBATS} combats + ${TARGET_CHALLENGES} challenges (terse)`);
console.log(`   Server: ${SERVER_URL}`);
console.log(`   Game: ${GAME_ID}`);
console.log(`   Party: ${partyMode}\n`);

// ── Auth ──────────────────────────────────────────────────────────────────────

async function authenticate() {
  // Try login first
  const loginRes = await fetch(`${SERVER_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });

  if (loginRes.ok) {
    const cookie = loginRes.headers.get('set-cookie') || '';
    const match = cookie.match(/tt_token=([^;]+)/);
    if (match) {
      console.log('   Authenticated (login)');
      return match[1];
    }
  }

  // Login failed — try register
  const regRes = await fetch(`${SERVER_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, displayName: TEST_DISPLAY_NAME }),
  });

  if (!regRes.ok) {
    const body = await regRes.text();
    throw new Error(`Auth failed — login: HTTP ${loginRes.status}, register: HTTP ${regRes.status} — ${body}`);
  }

  const cookie = regRes.headers.get('set-cookie') || '';
  const match = cookie.match(/tt_token=([^;]+)/);
  if (!match) throw new Error('Auth succeeded but no tt_token cookie in response');

  console.log('   Authenticated (registered new test account)');
  return match[1];
}

// ── Init: authenticate then create socket ─────────────────────────────────────

async function init() {
  try {
    authToken = await authenticate();
  } catch (err) {
    console.error('   Auth error:', err.message);
    process.exit(1);
  }

  const socket = Client(SERVER_URL, {
    transports: ['websocket', 'polling'],
    extraHeaders: { Cookie: `tt_token=${authToken}` },
    reconnection: true,
    reconnectionAttempts: 20,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
    timeout: 60000,
    pingTimeout: 120000,
    pingInterval: 25000,
  });

  socket.on('connect', async () => {
    if (reconnectCount > 0) {
      console.log(`   Reconnected (attempt ${reconnectCount}). Rejoining game...`);
      socket.emit('join_game', GAME_ID);
      return;
    }

    // First connection — create game
    if (!gameCreated) {
      try {
        const res = await fetch(`${SERVER_URL}/api/games`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Cookie': `tt_token=${authToken}` },
          body: JSON.stringify({ name: GAME_ID, system: 'dnd5e' }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const gameData = await res.json();
        GAME_ID = gameData.id; // Use the server-assigned UUID
        gameCreated = true;
        console.log(`   Game created (${GAME_ID})`);
      } catch (err) {
        console.error('   Setup failed:', err.message);
        process.exit(1);
      }
    }
    socket.emit('join_game', GAME_ID);
  });

  socket.on('reconnect_attempt', (attempt) => {
    reconnectCount = attempt;
  });

  socket.on('game_joined', (state) => {
    characters = state.characters || {};
    // Merge any combatStats from state
    for (const [name, char] of Object.entries(characters)) {
      if (state.characters?.[name]?.combatStats) {
        characters[name].combatStats = state.characters[name].combatStats;
      }
    }

    if (!gameStarted && Object.keys(characters).length === 0) {
      socket.emit('set_verbosity', { level: 'terse' });
      socket.emit('set_ferocity', { level: 3 });
      socket.emit('set_pillars', { exploration: 20, combat: 60, social: 20 });

      if (partyMode === 'generate') {
        // Legacy path: generate party via API
        console.log('   Generating party (via API)...');
        socket.emit('generate_party', { direction: 'Level 5 balanced party: Fighter, Cleric, Rogue, Wizard' });
      } else {
        // Stock party path: register each character individually
        console.log(`   Registering stock party: ${stockParty.map(c => c.name).join(', ')}...`);
        registerStockParty(socket);
      }
    } else if (!gameStarted && Object.keys(characters).length > 0) {
      analyzePartyAndStart();
    } else if (gameStarted) {
      // Reconnected mid-game — send next action
      console.log('   Resumed. Sending next action...');
      setTimeout(sendNextAction, 2000);
    }
  });

  // ── Stock party registration ───────────────────────────────────────────────

  function registerStockParty(socket) {
    let registered = 0;
    const total = stockParty.length;

    // Listen for character_registered events to track completion
    const onRegistered = (data) => {
      // Merge combatStats from our fixture into the local characters map
      const fixture = stockParty.find(c => c.name === data.name);
      if (fixture && fixture.combatStats) {
        characters[data.name] = { ...data.character, combatStats: fixture.combatStats };
      } else {
        characters[data.name] = data.character;
      }
      registered++;
      if (registered === total) {
        socket.off('character_registered', onRegistered);
        console.log(`   All ${total} characters registered`);
        analyzePartyAndStart();
      }
    };

    socket.on('character_registered', onRegistered);

    // Emit register_character for each stock party member
    for (const char of stockParty) {
      socket.emit('register_character', {
        name: char.name,
        statsText: char.statsText,
        personality: char.personality,
        backstory: char.backstory,
        standardActions: char.standardActions,
        combatStats: char.combatStats,
      });
    }
  }

  // ── Legacy generate_party path ────────────────────────────────────────────

  socket.on('character_registered', (data) => {
    // Only fires when NOT in stock party registration (handled above via off())
    if (!characters[data.name]) {
      characters[data.name] = data.character;
    }
  });

  socket.on('party_generated', () => {
    console.log('   Party generated, waiting for stats parsing...');
  });

  socket.on('party_ready', (data) => {
    console.log(`   Stats parsed: ${data.statsParsed} characters`);
    if (data.combatStats) {
      for (const [name, stats] of Object.entries(data.combatStats)) {
        if (characters[name]) characters[name].combatStats = stats;
      }
    }
    analyzePartyAndStart();
  });

  function analyzePartyAndStart() {
    if (gameStarted) return;
    gameStarted = true;

    const partyStats = Object.values(characters).map(c => c.combatStats).filter(Boolean);
    if (partyStats.length > 0) {
      const analysis = ed.calculatePartyDPR(partyStats);
      results.partyDPR = analysis.totalDPR;
      results.partyHP = partyStats.reduce((sum, cs) => sum + (cs.maxHp || cs.hp || 30), 0);
      results.partyLevel = partyStats[0]?.level || 5;

      console.log(`   Party: ${Object.keys(characters).join(', ')}`);
      console.log(`   Level: ${results.partyLevel} | DPR: ${results.partyDPR} | HP: ${results.partyHP}`);
      const charNames = Object.keys(characters);
      for (let i = 0; i < analysis.characters.length; i++) {
        const c = analysis.characters[i];
        console.log(`     ${c.name || charNames[i] || '?'}: ${c.effectiveDPR || 0} DPR (weapon: ${c.weaponDPR || 0}, spell: ${c.amortizedSpellDPR || 0})`);
      }
    } else {
      console.log('   Warning: No combatStats available — DPR analysis skipped');
    }

    currentPlayer = Object.keys(characters)[0];
    console.log(`\n   Starting adventure...\n`);
    socket.emit('dm_start', { prompt: 'Begin the adventure. The party enters a dungeon. Start with a combat encounter against goblins.' });
  }

  // ── Turn handling ─────────────────────────────────────────────────────────────

  socket.on('dm_stream_start', () => {});

  // ── Engine event handlers (PRIMARY combat detection path) ────────────────────
  // These are authoritative: if the engine says combat started/ended, we trust it.

  socket.on('combat_started', (data) => {
    engineCombatActive = true;
    lastEngineRound = data.round || 1;
    if (!inCombat) {
      inCombat = true;
      combatStartTurn = turnCount;
      combatWords = 0;
      combatIndicatorCount = 1;
      noCombatCount = 0;
      console.log(`\n   ⚔️  Combat started (engine) at turn ${turnCount} | round ${lastEngineRound}`);
    }
  });

  // combat_update fires every round — use it as a heartbeat to confirm combat is still active
  // and to capture the round count for accurate post-combat reporting.
  socket.on('combat_update', (data) => {
    engineCombatActive = true;
    lastEngineRound = data.round || lastEngineRound;
    if (!inCombat) {
      // We missed the combat_started event — recover from combat_update
      inCombat = true;
      combatStartTurn = turnCount;
      combatWords = 0;
      combatIndicatorCount = 1;
      noCombatCount = 0;
      console.log(`\n   ⚔️  Combat detected (update event) at turn ${turnCount} | round ${lastEngineRound}`);
    }
  });

  socket.on('combat_ended', (data) => {
    engineCombatActive = false;
    if (inCombat) {
      // Use engine round count if available; fall back to turn-based estimate
      const rounds = lastEngineRound > 0 ? lastEngineRound : Math.max(1, turnCount - combatStartTurn);
      combatsCompleted++;
      results.combats.push({
        num: combatsCompleted, rounds,
        words: Math.round(combatWords / Math.max(1, rounds)),
        reason: data.reason || 'engine-event',
      });
      inCombat = false;
      combatIndicatorCount = 0;
      noCombatCount = 0;
      lastEngineRound = 0;
      const roundsOk = rounds >= 2 && rounds <= 6 ? '✅' : '⚠️';
      console.log(`\n   Combat #${combatsCompleted}: ${rounds} rounds ${roundsOk} | avg ${results.combats[results.combats.length - 1].words} words/turn | ${data.reason || ''}`);
    }
  });

  socket.on('dm_message', (data) => {
    turnCount++;
    results.totalTurns++;
    consecutiveFailures = 0; // Reset on successful turn
    const wordCount = (data.text || '').split(/\s+/).filter(Boolean).length;
    if (inCombat) combatWords += wordCount;

    // ── Combat detection from narration (SECONDARY / fallback) ───────────────
    // Only used when engine events are not firing (e.g. legacy pipeline or missed events).
    // Skipped entirely when engineCombatActive is true — engine events are authoritative.
    const hasCombatKeywords = /(?:TURN_ORDER|initiative|🎲|d20\+|rolls?\s+\d+|HIT!|MISS!|(?:\d+)\s*(?:slashing|piercing|bludgeoning|fire|cold|necrotic|radiant)\s*damage|HP[:\s]*\d+)/i.test(data.text || '');

    if (!engineCombatActive) {
      // Engine is silent — use narration keyword heuristic
      if (hasCombatKeywords && !inCombat) {
        combatIndicatorCount++;
        if (combatIndicatorCount >= 1) { // Even 1 turn with dice/damage = combat
          inCombat = true;
          combatStartTurn = turnCount;
          combatWords = wordCount; // Include this turn's words
          noCombatCount = 0;
          console.log(`\n   ⚔️  Combat detected (narration fallback) at turn ${turnCount}`);
        }
      } else if (!hasCombatKeywords && inCombat) {
        noCombatCount++;
        if (noCombatCount >= 2) { // 2 turns without combat keywords = combat ended
          combatsCompleted++;
          const rounds = Math.max(1, turnCount - combatStartTurn - noCombatCount);
          results.combats.push({
            num: combatsCompleted, rounds,
            words: Math.round(combatWords / Math.max(1, rounds)),
            reason: 'narration-detected',
          });
          const roundsOk = rounds >= 2 && rounds <= 6 ? '✅' : '⚠️';
          console.log(`\n   Combat #${combatsCompleted}: ${rounds} rounds ${roundsOk} | avg ${results.combats[results.combats.length - 1].words} words/turn`);
          inCombat = false;
          combatIndicatorCount = 0;
          noCombatCount = 0;
        }
      } else if (hasCombatKeywords && inCombat) {
        noCombatCount = 0; // Reset non-combat counter
      }
    } else if (inCombat) {
      // Engine is active — reset narration counters so they don't interfere
      noCombatCount = 0;
    }

    // ── Challenge detection from narration ───────────────────────────────────
    const hasChallengeKeywords = /(?:DC\s*\d+|skill check|saving throw|ability check|rolls?\s+(?:perception|investigation|stealth|athletics|persuasion|arcana|deception|insight|survival|nature|medicine|religion|history|performance|intimidation|acrobatics|sleight))/i.test(data.text || '');
    if (hasChallengeKeywords && !inCombat) {
      challengesCompleted++;
      const dcMatch = (data.text || '').match(/DC\s*(\d+)/i);
      results.challenges.push({ num: challengesCompleted, dc: dcMatch ? parseInt(dcMatch[1]) : 0, words: wordCount });
      console.log(`   Challenge #${challengesCompleted}: DC ${dcMatch?.[1] || '?'} | ${wordCount} words`);
    }

    lastOptions = data.options || [];
    if (data.forPlayer) currentPlayer = data.forPlayer;

    // Progress
    process.stdout.write(`\r   Turn ${turnCount} | Combats: ${combatsCompleted}/${TARGET_COMBATS} | Challenges: ${challengesCompleted}/${TARGET_CHALLENGES} | Words: ${wordCount}   `);

    // Done check
    if ((combatsCompleted >= TARGET_COMBATS && challengesCompleted >= TARGET_CHALLENGES) || turnCount > 80) {
      console.log('');
      printReport().then(() => setTimeout(() => process.exit(0), 2000));
      return;
    }

    setTimeout(sendNextAction, 1500);
  });

  function sendNextAction() {
    if (!currentPlayer) currentPlayer = Object.keys(characters)[0];
    if (!currentPlayer) return;

    let action;
    if (combatsCompleted < TARGET_COMBATS && !inCombat) {
      action = lastOptions[0] || 'I draw my weapon and charge into the next room looking for enemies.';
    } else if (challengesCompleted < TARGET_CHALLENGES && !inCombat) {
      const challengeActions = [
        'I search the room for traps and hidden passages.',
        'I try to persuade the guard to let us through.',
        'I investigate the strange runes on the wall.',
        'I attempt to pick the lock on the chest.',
        'I try to sneak past the sentries.',
      ];
      action = challengeActions[challengesCompleted % challengeActions.length];
    } else {
      action = lastOptions[0] || 'I attack the nearest enemy.';
    }
    socket.emit('player_action', { playerName: currentPlayer, action });
  }

  socket.on('turn_change', (data) => {
    if (data.currentPlayer) currentPlayer = data.currentPlayer;
  });

  socket.on('system', (data) => {
    if (data.text?.includes('Error communicating')) {
      results.errors++;
      consecutiveFailures++;
      console.log(`\n   ⚠️  Error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${data.text}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.log('   ❌ Too many consecutive failures. Stopping.');
        printReport().then(() => process.exit(1));
      }
      setTimeout(() => {
        socket.emit('player_action', { playerName: currentPlayer, action: 'I look around and prepare.' });
      }, 3000);
    } else if (data.text?.includes('Game resumed')) {
      console.log('   ▶️  Game resumed');
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`\n   Socket disconnected: ${reason}`);
    if (reason === 'io server disconnect') {
      // Server forced disconnect — reconnect manually
      socket.connect();
    }
    // Other disconnect reasons (transport error, ping timeout) handled by auto-reconnection
  });

  socket.on('reconnect', (attempt) => {
    console.log(`   Reconnected after ${attempt} attempts`);
  });

  socket.on('reconnect_failed', () => {
    console.log('   ❌ Reconnection failed after all attempts');
    printReport().then(() => process.exit(1));
  });

  socket.on('connect_error', (err) => {
    if (reconnectCount === 0) {
      console.error('   Connection error:', err.message);
      process.exit(1);
    }
    // During reconnection, errors are expected
  });
} // end init()

init();

// ── Cost fetch ────────────────────────────────────────────────────────────────

async function fetchGameCost() {
  try {
    const res = await fetch(`${SERVER_URL}/api/costs`, {
      headers: { 'Cookie': `tt_token=${authToken || ''}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const gameEntry = data.games && data.games[GAME_ID];
    return gameEntry ? gameEntry.cost : null;
  } catch {
    return null;
  }
}

// ── Report ─────────────────────────────────────────────────────────────────────

async function printReport() {
  const endTime = new Date().toISOString();
  const elapsed = Math.round((Date.now() - results.startTime) / 1000);
  const gameCost = await fetchGameCost();

  const combatRounds = results.combats.map(c => c.rounds);
  const avgRounds = combatRounds.length > 0 ? (combatRounds.reduce((a, b) => a + b, 0) / combatRounds.length).toFixed(1) : 'N/A';
  const cWords = results.combats.map(c => c.words);
  const avgCombatWords = cWords.length > 0 ? Math.round(cWords.reduce((a, b) => a + b, 0) / cWords.length) : 'N/A';
  const chWords = results.challenges.map(c => c.words);
  const avgChallengeWords = chWords.length > 0 ? Math.round(chWords.reduce((a, b) => a + b, 0) / chWords.length) : 'N/A';
  const roundsInRange = combatRounds.filter(r => r >= 3 && r <= 5).length;

  console.log('\n' + '═'.repeat(65));
  console.log('  COMBAT BALANCE TEST — RESULTS');
  console.log('═'.repeat(65));
  console.log(`  Party Level: ${results.partyLevel} | Party DPR: ${results.partyDPR} | Party HP: ${results.partyHP}`);
  console.log(`  Party Mode: ${partyMode}`);
  console.log(`  Mode: terse | Turns: ${results.totalTurns} | Errors: ${results.errors}`);
  console.log(`  Elapsed: ${elapsed}s | End: ${endTime}`);
  if (gameCost !== null) {
    console.log(`  Cost: $${gameCost.toFixed(4)}`);
  } else {
    console.log('  Cost: unavailable');
  }
  console.log('─'.repeat(65));

  if (results.combats.length > 0) {
    console.log('\n  COMBATS:');
    console.log('  # | Rounds | Words/Turn | 3-5? | Result');
    console.log('  ' + '-'.repeat(50));
    for (const c of results.combats) {
      const ok = c.rounds >= 3 && c.rounds <= 5;
      console.log(`  ${String(c.num).padStart(2)} | ${String(c.rounds).padStart(6)} | ${String(c.words).padStart(10)} | ${ok ? ' ✅ ' : ' ⚠️  '} | ${c.reason}`);
    }
    console.log(`\n  Avg rounds: ${avgRounds} (target 3-5) | In range: ${roundsInRange}/${results.combats.length}`);
    console.log(`  Avg words/turn: ${avgCombatWords} | ${avgCombatWords !== 'N/A' && avgCombatWords <= 60 ? '✅' : avgCombatWords !== 'N/A' && avgCombatWords <= 100 ? '⚠️' : '❌'} (target ≤60)`);
  } else {
    console.log('\n  No combats completed.');
  }

  if (results.challenges.length > 0) {
    console.log('\n  CHALLENGES:');
    for (const c of results.challenges) console.log(`  #${c.num}: DC ${c.dc || '?'} | ${c.words} words`);
    console.log(`  Avg words: ${avgChallengeWords}`);
  }

  console.log('\n' + '═'.repeat(65));
}

// Safety timeout: 15 minutes (longer for reconnections)
setTimeout(() => {
  console.log('\n   ⏰ Timeout (15 min)');
  printReport().then(() => process.exit(results.combats.length > 0 ? 0 : 1));
}, 15 * 60 * 1000);
