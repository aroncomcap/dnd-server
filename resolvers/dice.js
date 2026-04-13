'use strict';

const { randomBytes } = require('crypto');

/**
 * Cryptographically secure random integer in [min, max] (inclusive).
 * Uses rejection sampling to eliminate modulo bias.
 */
function secureRandInt(min, max) {
  const range = max - min + 1;
  const bytesNeeded = Math.ceil(Math.log2(range) / 8) + 1;
  const maxValid = Math.floor(256 ** bytesNeeded / range) * range;

  let value;
  do {
    const buf = randomBytes(bytesNeeded);
    value = buf.reduce((acc, byte) => acc * 256 + byte, 0);
  } while (value >= maxValid);

  return min + (value % range);
}

/** Roll a single die with the given number of faces. */
function rollDie(faces) {
  return secureRandInt(1, faces);
}

const d4   = () => rollDie(4);
const d6   = () => rollDie(6);
const d8   = () => rollDie(8);
const d10  = () => rollDie(10);
const d12  = () => rollDie(12);
const d20  = () => rollDie(20);
const d100 = () => rollDie(100);

/**
 * Parse a single dice term like "2d6", "1d8", "d4" into { count, faces }.
 * Returns null if the string is not a dice term.
 */
function parseDiceTerm(term) {
  const match = term.match(/^(\d*)d(\d+)$/i);
  if (!match) return null;
  const count = match[1] === '' ? 1 : parseInt(match[1], 10);
  const faces = parseInt(match[2], 10);
  return { count, faces };
}

/**
 * Roll dice notation.
 *
 * Supports:
 *   "1d6"         — simple roll
 *   "2d6+3"       — with flat modifier
 *   "1d8-1"       — with negative modifier
 *   "4d6"         — multiple dice
 *   "1d20+5"      — with modifier
 *   "1d8+1+1d4"   — compound (RuneQuest-style damage bonus)
 *
 * Returns { rolls: number[], modifier: number, total: number }
 *   rolls    — every individual die result
 *   modifier — sum of all flat numeric modifiers
 *   total    — sum of all rolls plus modifier
 */
function roll(notation) {
  if (typeof notation !== 'string' || !notation.trim()) {
    throw new TypeError(`roll() expects a non-empty string, got: ${JSON.stringify(notation)}`);
  }

  // Tokenise by splitting on '+' and '-', keeping the sign.
  // e.g. "1d8+1+1d4" → ["1d8", "+1", "+1d4"]
  //      "2d6-1"     → ["2d6", "-1"]
  const tokenPattern = /([+-]?(?:\d*d\d+|\d+))/gi;
  const tokens = notation.match(tokenPattern);

  if (!tokens) {
    throw new SyntaxError(`Invalid dice notation: "${notation}"`);
  }

  const allRolls = [];
  let modifier = 0;

  for (const token of tokens) {
    const sign = token.startsWith('-') ? -1 : 1;
    const raw = token.replace(/^[+-]/, '');
    const diceTerm = parseDiceTerm(raw);

    if (diceTerm) {
      for (let i = 0; i < diceTerm.count; i++) {
        allRolls.push(rollDie(diceTerm.faces));
      }
    } else {
      const flat = parseInt(raw, 10);
      if (isNaN(flat)) {
        throw new SyntaxError(`Unrecognised token in dice notation: "${token}"`);
      }
      modifier += sign * flat;
    }
  }

  const total = allRolls.reduce((sum, r) => sum + r, 0) + modifier;

  return { rolls: allRolls, modifier, total };
}

/**
 * Roll with advantage: roll 2d20, take the higher result.
 * Returns { rolls: [r1, r2], result: number }
 */
function advantage() {
  const r1 = d20();
  const r2 = d20();
  return { rolls: [r1, r2], result: Math.max(r1, r2) };
}

/**
 * Roll with disadvantage: roll 2d20, take the lower result.
 * Returns { rolls: [r1, r2], result: number }
 */
function disadvantage() {
  const r1 = d20();
  const r2 = d20();
  return { rolls: [r1, r2], result: Math.min(r1, r2) };
}

module.exports = { d4, d6, d8, d10, d12, d20, d100, roll, advantage, disadvantage };
