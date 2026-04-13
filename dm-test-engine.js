#!/usr/bin/env node
'use strict';

/**
 * DM Test Engine — Automated quality testing for the AI Game Master
 *
 * Runs configurable scenarios against the live server and measures:
 * - Verbosity compliance (word counts vs limits)
 * - Structured block compliance (OPTIONS, SCENE, WORLD present)
 * - Combat round counts vs ferocity benchmarks
 * - Skill check frequency (should be every 1-2 actions)
 * - Encounter pacing (encounters per rest vs ferocity setting)
 * - Dice roll presence and format
 *
 * Usage: node dm-test-engine.js [scenario] [url]
 *   Scenarios: quick (5 turns), standard (15 turns), full (30 turns), combat (20 turns)
 */

const ioModule = require(__dirname + '/node_modules/socket.io/client-dist/socket.io.js');
const Client = ioModule.io || ioModule;

// ── Configuration ─────────────────────────────────────────────────────────────

const SCENARIO = process.argv[2] || 'standard';
const SERVER_URL = process.argv[3] || 'https://dnd-server-production-9b61.up.railway.app';

const SCENARIOS = {
  quick:    { turns: 5,  verbosity: 'verbose', ferocity: 3, prompt: 'Begin the adventure in a small village tavern.' },
  standard: { turns: 15, verbosity: 'verbose', ferocity: 3, prompt: 'Begin the adventure. The party arrives at a dungeon entrance at dusk.' },
  full:     { turns: 30, verbosity: 'verbose', ferocity: 3, prompt: 'Begin the adventure in a frontier town threatened by goblin raids.' },
  combat:   { turns: 20, verbosity: 'verbose', ferocity: 1, prompt: 'Begin the adventure. The party is ambushed by bandits on the road.' },
  terse:    { turns: 10, verbosity: 'terse',   ferocity: 3, prompt: 'Begin the adventure in a haunted forest.' },
  brief:    { turns: 10, verbosity: 'brief',   ferocity: 3, prompt: 'Begin the adventure exploring ancient ruins.' },
};

const config = SCENARIOS[SCENARIO];
if (!config) {
  console.error(`Unknown scenario: ${SCENARIO}. Available: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}

// ── Benchmarks ────────────────────────────────────────────────────────────────

const BENCHMARKS = {
  verbosity: {
    terse:   { maxWords: 30, maxSentences: 2, label: 'Terse (≤30 words, ≤2 sentences)' },
    brief:   { maxWords: 60, maxSentences: 5, label: 'Brief (≤60 words, ≤5 sentences)' },
    verbose: { maxWords: 120, maxSentences: 12, label: 'Verbose (≤120 words)' },
  },
  // Encounters per short rest by ferocity
  encountersPacing: {
    1: { perShortRest: [4, 6], perLongRest: [6, 8], label: 'Deadly' },
    2: { perShortRest: [3, 5], perLongRest: [6, 7], label: 'Dangerous' },
    3: { perShortRest: [3, 4], perLongRest: [5, 6], label: 'Balanced' },
    4: { perShortRest: [2, 3], perLongRest: [4, 5], label: 'Light' },
    5: { perShortRest: [1, 2], perLongRest: [3, 4], label: 'Easy' },
  },
  // Skill checks should appear every 1-2 actions
  skillCheckFrequency: { minPercentage: 40, label: 'Skill checks in ≥40% of turns' },
  // Structured blocks must always be present
  structuredBlocks: { required: ['options', 'scene', 'world'], label: 'OPTIONS + SCENE + WORLD every turn' },
  // Dice roll format: **🎲 ... rolls N. HIT/MISS! ...**
  diceFormat: { regex: /🎲.*(?:rolls?\s+\d+|d(?:20|100))/i, label: 'Dice rolls use 🎲 format' },
  // Combat rounds: typical combat should last 3-8 rounds
  combatRounds: { min: 2, max: 10, label: 'Combat lasts 2-10 rounds' },
};

// ── Metrics Collection ────────────────────────────────────────────────────────

const metrics = {
  turns: [],
  combats: [],
  encounters: 0,
  shortRests: 0,
  longRests: 0,
  skillChecks: 0,
  errors: 0,
  startTime: Date.now(),
};

function analyzeTurn(turnNum, narration, options, rawText) {
  const words = (narration || '').split(/\s+/).filter(Boolean);
  const sentences = (narration || '').split(/[.!?]+/).filter(s => s.trim().length > 5);
  const hasDiceRoll = BENCHMARKS.diceFormat.regex.test(narration || '');
  const hasSkillCheck = /(?:roll|check|DC\s*\d|saving throw|ability check|skill check|perception|investigation|athletics|acrobatics|stealth|persuasion|intimidation|deception|insight|\bd\d+\b)/i.test(narration || '');
  const hasHitMiss = /\b(?:HIT|MISS)\b/.test(narration || '');
  const hasCombatStart = /TURN_ORDER:|initiative|roll for initiative/i.test(rawText || '');
  const hasCombatEnd = /combat (?:is )?over|enemies (?:are )?defeated|combat ends|victory/i.test(narration || '');
  const hasRest = /(?:short|long)\s+rest|make camp|rest here|take a rest/i.test(narration || '');
  const hasEncounter = /(?:attack|combat|ambush|hostile|initiative|creature|enemy|enemies|skeleton|goblin|bandit|rat|wolf|undead)/i.test(narration || '');

  const turn = {
    num: turnNum,
    wordCount: words.length,
    sentenceCount: sentences.length,
    optionCount: (options || []).length,
    hasDiceRoll,
    hasSkillCheck,
    hasHitMiss,
    hasCombatStart,
    hasCombatEnd,
    hasRest,
    hasEncounter,
    hasOptions: (options || []).length >= 2,
    hasScene: /---\s*SCENE|## SCENE/i.test(rawText || ''),
    hasWorld: /---\s*WORLD|## WORLD/i.test(rawText || ''),
  };

  if (hasSkillCheck || hasDiceRoll) metrics.skillChecks++;
  if (hasRest && /short\s+rest/i.test(narration)) metrics.shortRests++;
  if (hasRest && /long\s+rest/i.test(narration)) metrics.longRests++;
  if (hasEncounter && !hasCombatEnd) metrics.encounters++;

  metrics.turns.push(turn);
  return turn;
}

// ── Report Generation ─────────────────────────────────────────────────────────

function generateReport() {
  const elapsed = ((Date.now() - metrics.startTime) / 1000).toFixed(0);
  const turns = metrics.turns;
  const total = turns.length;

  console.log('\n' + '═'.repeat(70));
  console.log('  DM TEST ENGINE — RESULTS');
  console.log('═'.repeat(70));
  console.log(`  Scenario: ${SCENARIO} | Turns: ${total} | Time: ${elapsed}s`);
  console.log(`  Verbosity: ${config.verbosity} | Ferocity: ${config.ferocity}/5`);
  console.log('─'.repeat(70));

  // 1. Verbosity Compliance
  const vBench = BENCHMARKS.verbosity[config.verbosity];
  const wordCounts = turns.map(t => t.wordCount);
  const avgWords = (wordCounts.reduce((a, b) => a + b, 0) / total).toFixed(0);
  const maxWords = Math.max(...wordCounts);
  const minWords = Math.min(...wordCounts);
  const overLimit = turns.filter(t => t.wordCount > vBench.maxWords).length;
  const overPct = ((overLimit / total) * 100).toFixed(0);

  console.log('\n📏 VERBOSITY COMPLIANCE');
  console.log(`  Benchmark: ${vBench.label}`);
  console.log(`  Word counts: avg ${avgWords}, min ${minWords}, max ${maxWords}`);
  console.log(`  Over limit: ${overLimit}/${total} turns (${overPct}%)`);
  if (config.verbosity === 'terse') {
    const sentCounts = turns.map(t => t.sentenceCount);
    const overSentences = turns.filter(t => t.sentenceCount > 2).length;
    console.log(`  Sentence counts: avg ${(sentCounts.reduce((a, b) => a + b, 0) / total).toFixed(1)}, over 2: ${overSentences}/${total}`);
  }
  const verbosityPass = overPct <= 20; // Allow 20% tolerance
  console.log(`  ${verbosityPass ? '✅ PASS' : '❌ FAIL'} (${overPct}% over, threshold: 20%)`);

  // Per-turn word count histogram
  console.log('\n  Word count distribution:');
  const buckets = [0, 25, 50, 75, 100, 150, 200, 300, 500];
  for (let i = 0; i < buckets.length; i++) {
    const lo = buckets[i];
    const hi = buckets[i + 1] || Infinity;
    const count = wordCounts.filter(w => w >= lo && w < hi).length;
    const bar = '█'.repeat(Math.round((count / total) * 30));
    const label = hi === Infinity ? `${lo}+` : `${lo}-${hi - 1}`;
    if (count > 0) console.log(`    ${label.padStart(7)}: ${bar} ${count}`);
  }

  // 2. Structured Block Compliance
  console.log('\n📋 STRUCTURED BLOCKS');
  const missingOptions = turns.filter(t => !t.hasOptions).length;
  const missingScene = turns.filter(t => !t.hasScene).length;
  const missingWorld = turns.filter(t => !t.hasWorld).length;
  console.log(`  Missing OPTIONS: ${missingOptions}/${total}`);
  console.log(`  Missing SCENE:   ${missingScene}/${total}`);
  console.log(`  Missing WORLD:   ${missingWorld}/${total}`);
  const structPass = missingOptions === 0 && missingScene === 0 && missingWorld === 0;
  console.log(`  ${structPass ? '✅ PASS' : '❌ FAIL'} (all blocks present every turn)`);

  // 3. Skill Check Frequency
  console.log('\n🎲 SKILL CHECK FREQUENCY');
  const checkPct = ((metrics.skillChecks / total) * 100).toFixed(0);
  console.log(`  Turns with dice/skill checks: ${metrics.skillChecks}/${total} (${checkPct}%)`);
  console.log(`  Benchmark: ≥${BENCHMARKS.skillCheckFrequency.minPercentage}%`);
  const checkPass = parseInt(checkPct) >= BENCHMARKS.skillCheckFrequency.minPercentage;
  console.log(`  ${checkPass ? '✅ PASS' : '❌ FAIL'}`);

  // 4. Combat Analysis
  console.log('\n⚔️  COMBAT ANALYSIS');
  if (metrics.combats.length > 0) {
    for (const combat of metrics.combats) {
      console.log(`  Combat #${combat.id}: ${combat.rounds} rounds (${combat.startTurn}-${combat.endTurn})`);
      const inRange = combat.rounds >= BENCHMARKS.combatRounds.min && combat.rounds <= BENCHMARKS.combatRounds.max;
      console.log(`    ${inRange ? '✅' : '⚠️ '} Benchmark: ${BENCHMARKS.combatRounds.min}-${BENCHMARKS.combatRounds.max} rounds`);
    }
  } else {
    console.log('  No combat detected in this scenario');
  }

  // Encounter pacing
  console.log('\n📊 ENCOUNTER PACING');
  const pBench = BENCHMARKS.encountersPacing[config.ferocity];
  console.log(`  Ferocity ${config.ferocity}/5 (${pBench.label})`);
  console.log(`  Encounters detected: ${metrics.encounters}`);
  console.log(`  Short rests: ${metrics.shortRests}`);
  console.log(`  Long rests: ${metrics.longRests}`);
  if (metrics.shortRests > 0) {
    const encPerRest = (metrics.encounters / metrics.shortRests).toFixed(1);
    console.log(`  Encounters/short rest: ${encPerRest} (benchmark: ${pBench.perShortRest.join('-')})`);
    const pacingInRange = encPerRest >= pBench.perShortRest[0] * 0.5 && encPerRest <= pBench.perShortRest[1] * 2;
    console.log(`  ${pacingInRange ? '✅ PASS' : '⚠️  OUTSIDE RANGE'} (with tolerance)`);
  } else {
    console.log(`  Not enough rests to measure pacing (need longer scenario)`);
  }

  // 5. Dice Roll Format
  console.log('\n🎯 DICE ROLL FORMAT');
  const diceRollTurns = turns.filter(t => t.hasDiceRoll).length;
  const hitMissTurns = turns.filter(t => t.hasHitMiss).length;
  console.log(`  Turns with 🎲 format: ${diceRollTurns}/${total}`);
  console.log(`  Turns with HIT/MISS caps: ${hitMissTurns}/${total}`);

  // 6. Errors
  console.log('\n⚠️  ERRORS');
  console.log(`  DM communication errors: ${metrics.errors}`);
  console.log(`  ${metrics.errors === 0 ? '✅ PASS' : '❌ FAIL'}`);

  // Summary
  console.log('\n' + '═'.repeat(70));
  const allPassed = verbosityPass && structPass && checkPass && metrics.errors === 0;
  const passCount = [verbosityPass, structPass, checkPass, metrics.errors === 0].filter(Boolean).length;
  console.log(`  OVERALL: ${passCount}/4 checks passed ${allPassed ? '✅' : '⚠️ '}`);
  console.log('═'.repeat(70));

  // Raw data dump
  console.log('\n📊 RAW DATA (per turn):');
  console.log('  Turn | Words | Sents | Opts | Dice | Skill | HIT/MISS | Combat');
  console.log('  ' + '-'.repeat(65));
  for (const t of turns) {
    console.log(`  ${String(t.num).padStart(4)} | ${String(t.wordCount).padStart(5)} | ${String(t.sentenceCount).padStart(5)} | ${String(t.optionCount).padStart(4)} | ${t.hasDiceRoll ? ' yes' : '  no'} | ${t.hasSkillCheck ? '  yes' : '   no'} | ${t.hasHitMiss ? '   yes  ' : '    no  '} | ${t.hasCombatStart ? 'START' : t.hasCombatEnd ? 'END' : t.hasEncounter ? 'active' : '-'}`);
  }

  return allPassed;
}

// ── Game Runner ───────────────────────────────────────────────────────────────

const GAME_ID = `test-${SCENARIO}-${Date.now().toString(36)}`;
let turnCount = 0;
let currentPlayer = null;
let lastOptions = [];
let characters = {};
let gameStarted = false;
let inCombat = false;
let combatStartTurn = 0;
let combatCount = 0;
let rawResponses = [];

console.log(`\n🧪 DM Test Engine — ${SCENARIO} scenario`);
console.log(`   ${config.turns} turns | verbosity: ${config.verbosity} | ferocity: ${config.ferocity}/5`);
console.log(`   Server: ${SERVER_URL}`);
console.log(`   Game ID: ${GAME_ID}\n`);

const socket = Client(SERVER_URL, {
  transports: ['websocket'],
  reconnection: false,
});

socket.on('connect', async () => {
  console.log('Connected');

  try {
    const res = await fetch(`${SERVER_URL}/api/games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: GAME_ID, system: 'dnd5e' }),
    });
    await res.json();
    console.log('Game created');
  } catch (err) {
    console.error('Failed to create game:', err.message);
    process.exit(1);
  }

  socket.emit('join_game', GAME_ID);
});

socket.on('game_joined', (state) => {
  characters = state.characters;
  console.log(`Joined. Setting verbosity=${config.verbosity}, ferocity=${config.ferocity}`);

  // Set game settings
  socket.emit('set_verbosity', { level: config.verbosity });
  socket.emit('set_ferocity', { level: config.ferocity });

  if (Object.keys(characters).length === 0) {
    console.log('Generating party...');
    socket.emit('generate_party', { direction: 'Balanced dungeon party — fighter, cleric, rogue, wizard. Level 3.' });
  } else {
    startAdventure();
  }
});

socket.on('character_registered', (data) => {
  characters[data.name] = data.character;
});

socket.on('party_generated', (data) => {
  console.log(`Party: ${data.count} characters`);
  setTimeout(startAdventure, 2000);
});

function startAdventure() {
  if (gameStarted) return;
  gameStarted = true;
  currentPlayer = Object.keys(characters)[0];
  console.log(`Starting: ${config.prompt.slice(0, 60)}...`);
  console.log('─'.repeat(50));
  socket.emit('dm_start', { prompt: config.prompt });
}

// Collect raw text for analysis
let currentRawText = '';
socket.on('dm_stream_start', () => { currentRawText = ''; });
socket.on('dm_stream_chunk', (data) => { currentRawText += data.text; });

socket.on('dm_message', (data) => {
  turnCount++;
  const rawText = currentRawText + '\n' + (data.options || []).join('\n');
  rawResponses.push(rawText);

  const turn = analyzeTurn(turnCount, data.text, data.options, rawText);

  // Track combat
  if (turn.hasCombatStart && !inCombat) {
    inCombat = true;
    combatStartTurn = turnCount;
    combatCount++;
  }
  if (turn.hasCombatEnd && inCombat) {
    const rounds = turnCount - combatStartTurn;
    metrics.combats.push({ id: combatCount, rounds, startTurn: combatStartTurn, endTurn: turnCount });
    inCombat = false;
  }

  // Progress indicator
  const bar = '█'.repeat(Math.round((turnCount / config.turns) * 20));
  const empty = '░'.repeat(20 - Math.round((turnCount / config.turns) * 20));
  process.stdout.write(`\r  [${bar}${empty}] Turn ${turnCount}/${config.turns} (${turn.wordCount}w)`);

  lastOptions = data.options || [];
  if (data.forPlayer) currentPlayer = data.forPlayer;

  if (turnCount >= config.turns) {
    // Close any open combat
    if (inCombat) {
      metrics.combats.push({ id: combatCount, rounds: turnCount - combatStartTurn, startTurn: combatStartTurn, endTurn: turnCount });
    }
    console.log('\n');
    const passed = generateReport();
    setTimeout(() => process.exit(passed ? 0 : 1), 2000);
    return;
  }

  // Vary actions to test different DM behaviors
  setTimeout(() => {
    let action;
    const roll = Math.random();
    if (lastOptions[0] && roll < 0.5) {
      // Pick option 1 (most common path)
      action = lastOptions[0];
    } else if (lastOptions[2] && roll < 0.7) {
      // Pick option 3 (wild/reckless — triggers more combat/checks)
      action = lastOptions[2];
    } else if (roll < 0.85) {
      // Custom freeform actions to test variety
      const freeform = [
        'I search the room for hidden passages or traps.',
        'I try to persuade the nearest NPC to help us.',
        'I cast Detect Magic and scan the area.',
        'I take a defensive stance and observe my surroundings carefully.',
        'I investigate the strange markings on the wall.',
        'I try to pick the lock on the door.',
        'I attack the nearest enemy with my primary weapon.',
        'I attempt to sneak past the guards.',
      ];
      action = freeform[Math.floor(Math.random() * freeform.length)];
    } else {
      // OOC to test that it's handled (should not count as a game turn)
      action = lastOptions[1] || 'I look around cautiously.';
    }
    socket.emit('player_action', { playerName: currentPlayer, action });
  }, 1500);
});

socket.on('turn_change', (data) => {
  if (data.currentPlayer) currentPlayer = data.currentPlayer;
});

socket.on('combat_started', () => {
  if (!inCombat) {
    inCombat = true;
    combatStartTurn = turnCount;
    combatCount++;
  }
});

socket.on('combat_ended', (data) => {
  if (inCombat) {
    const rounds = turnCount - combatStartTurn;
    metrics.combats.push({ id: combatCount, rounds, startTurn: combatStartTurn, endTurn: turnCount });
    inCombat = false;
  }
});

socket.on('system', (data) => {
  if (data.text?.includes('Error communicating')) {
    metrics.errors++;
    // Retry
    setTimeout(() => {
      socket.emit('player_action', { playerName: currentPlayer, action: 'I wait and observe.' });
    }, 3000);
  }
});

socket.on('disconnect', () => {
  if (turnCount < config.turns) {
    console.log('\nDisconnected early');
    generateReport();
    process.exit(1);
  }
});

socket.on('connect_error', (err) => {
  console.error('Connection error:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('\n⏰ Timeout (10 min)');
  if (turnCount > 0) generateReport();
  process.exit(1);
}, 10 * 60 * 1000);
