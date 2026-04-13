#!/usr/bin/env node
'use strict';

/**
 * Combat Balance Test — runs 10 combats + 5 challenges against the live server.
 * Always uses terse mode. Reports party DPR, monster DPR, round counts, deaths.
 *
 * Usage: node test-combat-balance.js [url]
 * Cost: ~$0.30 for 10 combats + 5 challenges (~30 turns)
 */

const ioModule = require(__dirname + '/node_modules/socket.io/client-dist/socket.io.js');
const Client = ioModule.io || ioModule;
const ed = require('./encounter-designer');

const SERVER_URL = process.argv[2] || 'https://dnd-server-production-9b61.up.railway.app';
const GAME_ID = `test-combat-${Date.now().toString(36)}`;
const TARGET_COMBATS = 10;
const TARGET_CHALLENGES = 5;

// ── Metrics ───────────────────────────────────────────────────────────────────

const results = {
  combats: [],        // { rounds, partyDPR, monsterHP, monsterDPR, words, pcDeaths, pcDowned }
  challenges: [],     // { type, dc, words }
  errors: 0,
  totalTurns: 0,
  partyLevel: 0,
  partyDPR: 0,
  partyHP: 0,
  startTime: Date.now(),
};

let turnCount = 0;
let currentPlayer = null;
let lastOptions = [];
let characters = {};
let gameStarted = false;
let combatsCompleted = 0;
let challengesCompleted = 0;
let inCombat = false;
let combatStartTurn = 0;
let combatWords = 0;
let currentRawText = '';

console.log(`\n⚔️  Combat Balance Test — 10 combats + 5 challenges (terse mode)`);
console.log(`   Server: ${SERVER_URL}`);
console.log(`   Game: ${GAME_ID}\n`);

const socket = Client(SERVER_URL, { transports: ['websocket'], reconnection: false });

socket.on('connect', async () => {
  try {
    await fetch(`${SERVER_URL}/api/games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: GAME_ID, system: 'dnd5e' }),
    });
    socket.emit('join_game', GAME_ID);
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }
});

socket.on('game_joined', (state) => {
  characters = state.characters;
  socket.emit('set_verbosity', { level: 'terse' });
  socket.emit('set_ferocity', { level: 3 });
  socket.emit('set_pillars', { exploration: 20, combat: 60, social: 20 });

  if (Object.keys(characters).length === 0) {
    console.log('   Generating party...');
    socket.emit('generate_party', { direction: 'Level 5 balanced party: Fighter, Cleric, Rogue, Wizard' });
  } else {
    analyzePartyAndStart();
  }
});

socket.on('character_registered', (data) => {
  characters[data.name] = data.character;
});

socket.on('party_generated', () => {
  console.log('   Party generated, waiting for stats parsing...');
});

socket.on('party_ready', (data) => {
  console.log(`   Stats parsed: ${data.statsParsed} characters`);
  // Merge combatStats into character data
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

  // Analyze party DPR
  const partyStats = Object.values(characters).map(c => c.combatStats).filter(Boolean);
  if (partyStats.length > 0) {
    const analysis = ed.calculatePartyDPR(partyStats);
    results.partyDPR = analysis.totalDPR;
    results.partyHP = partyStats.reduce((sum, cs) => sum + (cs.maxHp || cs.hp || 30), 0);
    results.partyLevel = partyStats[0]?.level || 5;

    console.log(`   Party: ${Object.keys(characters).join(', ')}`);
    console.log(`   Level: ${results.partyLevel} | DPR: ${results.partyDPR} | HP: ${results.partyHP}`);
    for (const c of analysis.characters) {
      const name = Object.keys(characters).find((_, i) => i === analysis.characters.indexOf(c)) || '?';
      console.log(`     ${name}: ${c.dpr.effectiveDPR} DPR (weapon: ${c.dpr.weaponDPR}, spell: ${c.dpr.amortizedSpellDPR})`);
    }
  }

  currentPlayer = Object.keys(characters)[0];
  console.log(`\n   Starting adventure — targeting ${TARGET_COMBATS} combats + ${TARGET_CHALLENGES} challenges...\n`);
  socket.emit('dm_start', { prompt: 'Begin the adventure. The party enters a dangerous dungeon. Start combat immediately with the first encounter.' });
}

socket.on('dm_stream_start', () => { currentRawText = ''; });
socket.on('dm_stream_chunk', (data) => { currentRawText += data.text; });

socket.on('combat_started', (data) => {
  if (!inCombat) {
    inCombat = true;
    combatStartTurn = turnCount;
    combatWords = 0;
  }
});

socket.on('combat_ended', (data) => {
  if (inCombat) {
    const rounds = turnCount - combatStartTurn;
    combatsCompleted++;
    results.combats.push({
      num: combatsCompleted,
      rounds,
      words: Math.round(combatWords / Math.max(1, rounds)),
      reason: data.reason || 'unknown',
    });
    inCombat = false;

    const c = results.combats[results.combats.length - 1];
    const roundsOk = rounds >= 2 && rounds <= 6 ? '✅' : '⚠️';
    console.log(`   Combat #${combatsCompleted}: ${rounds} rounds ${roundsOk} | avg ${c.words} words/turn | ${data.reason || ''}`);
  }
});

socket.on('dm_message', (data) => {
  turnCount++;
  results.totalTurns++;
  const wordCount = (data.text || '').split(/\s+/).filter(Boolean).length;
  if (inCombat) combatWords += wordCount;

  // Detect skill/social challenges (non-combat dice)
  const hasCheck = /(?:DC\s*\d|check|saving throw|persuasion|investigation|perception|stealth|athletics)/i.test(data.text || '');
  if (hasCheck && !inCombat) {
    challengesCompleted++;
    const dcMatch = (data.text || '').match(/DC\s*(\d+)/i);
    results.challenges.push({
      num: challengesCompleted,
      dc: dcMatch ? parseInt(dcMatch[1]) : 0,
      words: wordCount,
    });
    console.log(`   Challenge #${challengesCompleted}: DC ${dcMatch?.[1] || '?'} | ${wordCount} words`);
  }

  lastOptions = data.options || [];
  if (data.forPlayer) currentPlayer = data.forPlayer;

  // Check if done
  const done = combatsCompleted >= TARGET_COMBATS && challengesCompleted >= TARGET_CHALLENGES;
  const almostDone = combatsCompleted >= TARGET_COMBATS || turnCount > 60;

  if (done || turnCount > 80) {
    printReport();
    setTimeout(() => process.exit(0), 2000);
    return;
  }

  // Drive toward more combat if we haven't hit target
  setTimeout(() => {
    let action;
    if (combatsCompleted < TARGET_COMBATS && !inCombat) {
      // Push for combat
      action = lastOptions[0] || 'I draw my weapon and look for enemies ahead.';
    } else if (challengesCompleted < TARGET_CHALLENGES && !inCombat) {
      // Push for challenges
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
  }, 1500);
});

socket.on('turn_change', (data) => {
  if (data.currentPlayer) currentPlayer = data.currentPlayer;
});

socket.on('system', (data) => {
  if (data.text?.includes('Error communicating')) {
    results.errors++;
    setTimeout(() => {
      socket.emit('player_action', { playerName: currentPlayer, action: 'I attack.' });
    }, 3000);
  }
});

socket.on('disconnect', (reason) => {
  console.log(`\n   Disconnected: ${reason}`);
  if (combatsCompleted > 0) printReport();
  process.exit(turnCount > 0 ? 0 : 1);
});

socket.on('connect_error', (err) => {
  console.error('Connection error:', err.message);
  process.exit(1);
});

function printReport() {
  const elapsed = Math.round((Date.now() - results.startTime) / 1000);
  const combatRounds = results.combats.map(c => c.rounds);
  const avgRounds = combatRounds.length > 0 ? (combatRounds.reduce((a, b) => a + b, 0) / combatRounds.length).toFixed(1) : 'N/A';
  const combatWords = results.combats.map(c => c.words);
  const avgCombatWords = combatWords.length > 0 ? Math.round(combatWords.reduce((a, b) => a + b, 0) / combatWords.length) : 'N/A';
  const challengeWords = results.challenges.map(c => c.words);
  const avgChallengeWords = challengeWords.length > 0 ? Math.round(challengeWords.reduce((a, b) => a + b, 0) / challengeWords.length) : 'N/A';
  const roundsInRange = combatRounds.filter(r => r >= 3 && r <= 5).length;

  console.log('\n' + '═'.repeat(65));
  console.log('  COMBAT BALANCE TEST — RESULTS');
  console.log('═'.repeat(65));
  console.log(`  Party Level: ${results.partyLevel} | Party DPR: ${results.partyDPR} | Party HP: ${results.partyHP}`);
  console.log(`  Mode: terse | Turns: ${results.totalTurns} | Time: ${elapsed}s`);
  console.log('─'.repeat(65));

  console.log('\n  COMBATS:');
  console.log('  # | Rounds | Avg Words | Target 3-5 | Result');
  console.log('  ' + '-'.repeat(55));
  for (const c of results.combats) {
    const inRange = c.rounds >= 3 && c.rounds <= 5;
    console.log(`  ${String(c.num).padStart(2)} | ${String(c.rounds).padStart(6)} | ${String(c.words).padStart(9)} | ${inRange ? '   ✅     ' : '   ⚠️      '} | ${c.reason}`);
  }
  console.log(`\n  Average rounds: ${avgRounds} (target: 3-5)`);
  console.log(`  In range (3-5): ${roundsInRange}/${results.combats.length} (${Math.round(roundsInRange / Math.max(1, results.combats.length) * 100)}%)`);
  console.log(`  Avg combat words/turn: ${avgCombatWords}`);
  console.log(`  Verbosity: ${avgCombatWords <= 60 ? '✅ GOOD' : avgCombatWords <= 100 ? '⚠️  HIGH' : '❌ TOO HIGH'} (target ≤60 for terse)`);

  console.log('\n  CHALLENGES:');
  for (const c of results.challenges) {
    console.log(`  #${c.num}: DC ${c.dc || '?'} | ${c.words} words`);
  }
  console.log(`  Avg challenge words: ${avgChallengeWords}`);

  console.log('\n  ERRORS: ' + (results.errors === 0 ? '✅ None' : `❌ ${results.errors}`));
  console.log('═'.repeat(65));
}

setTimeout(() => {
  console.error('\n   ⏰ Timeout (10 min)');
  if (combatsCompleted > 0) printReport();
  process.exit(1);
}, 10 * 60 * 1000);
