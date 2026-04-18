#!/usr/bin/env node
'use strict';

/**
 * Server-side Combat Test CLI
 *
 * Authenticates, calls POST /api/test/combat, and prints results.
 * No WebSocket needed — the test runs entirely inside the server process.
 *
 * Usage:
 *   node test-combat-server.js [--party balanced|melee-heavy|caster-heavy] [--turns 30] [--url https://...]
 *
 * Defaults:
 *   --party balanced
 *   --turns 30
 *   --url https://dnd-server-production-9b61.up.railway.app
 */

const args = process.argv.slice(2);

let SERVER_URL = 'https://dnd-server-production-9b61.up.railway.app';
let partyMode = 'balanced';
let numTurns = 30;
let verbosity = 'terse';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--party' && args[i + 1]) { partyMode = args[i + 1]; i++; }
  else if (args[i] === '--turns' && args[i + 1]) { numTurns = parseInt(args[i + 1]) || 30; i++; }
  else if (args[i] === '--verbosity' && args[i + 1]) { verbosity = args[i + 1]; i++; }
  else if (args[i] === '--url' && args[i + 1]) { SERVER_URL = args[i + 1]; i++; }
  else if (!args[i].startsWith('--')) { SERVER_URL = args[i]; }
}

const TEST_EMAIL = 'test@tavern-table.local';
const TEST_PASSWORD = 'test-combat-harness-2024';
const TEST_DISPLAY_NAME = 'Combat Test';

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

async function run() {
  console.log(`\nServer-side Combat Test`);
  console.log(`  Server:    ${SERVER_URL}`);
  console.log(`  Party:     ${partyMode}`);
  console.log(`  Turns:     ${numTurns}`);
  console.log(`  Verbosity: ${verbosity}\n`);

  let authToken;
  try {
    authToken = await authenticate();
  } catch (err) {
    console.error('Auth error:', err.message);
    process.exit(1);
  }

  console.log(`  Calling POST /api/test/combat ... (may take several minutes)\n`);
  const callStart = Date.now();

  let res;
  try {
    res = await fetch(`${SERVER_URL}/api/test/combat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `tt_token=${authToken}`,
      },
      body: JSON.stringify({ party: partyMode, turns: numTurns, verbosity }),
      // Node 18+ fetch doesn't support timeout natively — we rely on server 5-min cap
    });
  } catch (err) {
    console.error('Request failed:', err.message);
    process.exit(1);
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`HTTP ${res.status}: ${body}`);
    process.exit(1);
  }

  // Parse NDJSON stream — each line is a JSON object
  const turnLog = [];
  let summary = null;
  const body = await res.text();
  for (const line of body.split('\n').filter(Boolean)) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'summary') {
        summary = obj;
      } else if (obj.type === 'turn') {
        turnLog.push(obj);
        const combatFlag = obj.combat ? '⚔️' : '  ';
        const err = obj.error ? ` [ERR]` : '';
        process.stdout.write(`  ${combatFlag} Turn ${String(obj.turn).padStart(3)}: ${String(obj.words).padStart(4)}w ${(obj.elapsed_ms / 1000).toFixed(1)}s${err}\n`);
      }
    } catch (e) { /* skip malformed lines */ }
  }
  const clientElapsed = Date.now() - callStart;

  if (!summary) {
    console.error('No summary received — test may have crashed server-side');
    process.exit(1);
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));
  console.log(`  Party:              ${summary.party}`);
  console.log(`  Verbosity:          ${summary.verbosity}`);
  console.log(`  Turns completed:    ${summary.turns}`);
  console.log(`  Combats detected:   ${summary.combatsDetected}`);
  console.log(`  Avg words/turn:     ${summary.avgWordsPerTurn}`);
  console.log(`  Errors:             ${summary.errors}`);
  console.log(`  Timed out:          ${summary.timedOut}`);
  console.log(`  Cost:               $${summary.cost}`);
  console.log(`  Server elapsed:     ${(summary.elapsed_ms / 1000).toFixed(1)}s`);
  console.log(`  Client elapsed:     ${(clientElapsed / 1000).toFixed(1)}s`);
  console.log(`  End time:           ${summary.end_time}`);
  console.log('='.repeat(60));
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
