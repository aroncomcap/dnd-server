'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { d4, d6, d8, d10, d12, d20, d100, roll, advantage, disadvantage } = require('../resolvers/dice.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run fn N times and return all results. */
function sample(fn, n = 200) {
  return Array.from({ length: n }, () => fn());
}

/** Assert every value in results is within [min, max]. */
function assertRange(results, min, max, label) {
  for (const v of results) {
    assert.ok(
      v >= min && v <= max,
      `${label}: expected ${v} to be in [${min}, ${max}]`
    );
  }
}

/** Assert that results contain at least one value equal to boundary. */
function assertBoundaryHit(results, boundary, label) {
  assert.ok(
    results.includes(boundary),
    `${label}: boundary value ${boundary} never rolled in ${results.length} samples — possible RNG issue`
  );
}

// ---------------------------------------------------------------------------
// Individual dice
// ---------------------------------------------------------------------------

describe('Individual dice functions', () => {
  const cases = [
    { fn: d4,   name: 'd4',   min: 1, max: 4   },
    { fn: d6,   name: 'd6',   min: 1, max: 6   },
    { fn: d8,   name: 'd8',   min: 1, max: 8   },
    { fn: d10,  name: 'd10',  min: 1, max: 10  },
    { fn: d12,  name: 'd12',  min: 1, max: 12  },
    { fn: d20,  name: 'd20',  min: 1, max: 20  },
    { fn: d100, name: 'd100', min: 1, max: 100 },
  ];

  for (const { fn, name, min, max } of cases) {
    it(`${name} returns integers in [${min}, ${max}]`, () => {
      const results = sample(fn, 500);
      assertRange(results, min, max, name);
      // Verify integer values
      for (const v of results) {
        assert.equal(v, Math.floor(v), `${name}: expected integer, got ${v}`);
      }
    });

    it(`${name} hits both boundaries over 500 rolls`, () => {
      const results = sample(fn, 500);
      assertBoundaryHit(results, min, `${name} min`);
      assertBoundaryHit(results, max, `${name} max`);
    });
  }
});

// ---------------------------------------------------------------------------
// roll() notation parser
// ---------------------------------------------------------------------------

describe('roll() notation parser', () => {
  it('"1d6" — single die, no modifier', () => {
    const r = roll('1d6');
    assert.equal(r.rolls.length, 1);
    assert.equal(r.modifier, 0);
    assertRange(r.rolls, 1, 6, '1d6 roll');
    assert.equal(r.total, r.rolls[0]);
  });

  it('"2d6+3" — two dice with positive modifier', () => {
    const r = roll('2d6+3');
    assert.equal(r.rolls.length, 2);
    assert.equal(r.modifier, 3);
    assertRange(r.rolls, 1, 6, '2d6+3 rolls');
    assert.equal(r.total, r.rolls[0] + r.rolls[1] + 3);
  });

  it('"1d8-1" — one die with negative modifier', () => {
    const r = roll('1d8-1');
    assert.equal(r.rolls.length, 1);
    assert.equal(r.modifier, -1);
    assertRange(r.rolls, 1, 8, '1d8-1 roll');
    assert.equal(r.total, r.rolls[0] - 1);
  });

  it('"4d6" — four dice, no modifier', () => {
    const r = roll('4d6');
    assert.equal(r.rolls.length, 4);
    assert.equal(r.modifier, 0);
    assertRange(r.rolls, 1, 6, '4d6 rolls');
    assert.equal(r.total, r.rolls.reduce((s, v) => s + v, 0));
  });

  it('"1d20+5" — single d20 with modifier', () => {
    const r = roll('1d20+5');
    assert.equal(r.rolls.length, 1);
    assert.equal(r.modifier, 5);
    assertRange(r.rolls, 1, 20, '1d20+5 roll');
    assert.equal(r.total, r.rolls[0] + 5);
  });

  it('"1d8+1+1d4" — compound notation (RuneQuest damage bonus)', () => {
    const r = roll('1d8+1+1d4');
    // 1d8 contributes 1 roll, 1d4 contributes 1 roll
    assert.equal(r.rolls.length, 2);
    assert.equal(r.modifier, 1);
    assertRange([r.rolls[0]], 1, 8,  '1d8 component');
    assertRange([r.rolls[1]], 1, 4,  '1d4 component');
    assert.equal(r.total, r.rolls[0] + r.rolls[1] + 1);
  });

  it('total always equals sum(rolls) + modifier', () => {
    const notations = ['1d6', '2d6+3', '1d8-1', '4d6', '1d20+5', '1d8+1+1d4'];
    for (const n of notations) {
      for (let i = 0; i < 20; i++) {
        const r = roll(n);
        const expected = r.rolls.reduce((s, v) => s + v, 0) + r.modifier;
        assert.equal(r.total, expected, `total mismatch for "${n}"`);
      }
    }
  });

  it('throws TypeError on non-string input', () => {
    assert.throws(() => roll(null),      TypeError);
    assert.throws(() => roll(undefined), TypeError);
    assert.throws(() => roll(6),         TypeError);
  });

  it('throws SyntaxError on garbage notation', () => {
    assert.throws(() => roll('abc'), SyntaxError);
    assert.throws(() => roll(''),   TypeError);
  });
});

// ---------------------------------------------------------------------------
// advantage / disadvantage
// ---------------------------------------------------------------------------

describe('advantage()', () => {
  it('returns rolls array of length 2 and a result', () => {
    const a = advantage();
    assert.equal(a.rolls.length, 2);
    assert.ok(typeof a.result === 'number');
  });

  it('result equals max of the two rolls', () => {
    for (let i = 0; i < 100; i++) {
      const a = advantage();
      assert.equal(a.result, Math.max(a.rolls[0], a.rolls[1]));
    }
  });

  it('all values are in [1, 20]', () => {
    for (let i = 0; i < 100; i++) {
      const a = advantage();
      assertRange(a.rolls, 1, 20, 'advantage rolls');
      assertRange([a.result], 1, 20, 'advantage result');
    }
  });
});

describe('disadvantage()', () => {
  it('returns rolls array of length 2 and a result', () => {
    const d = disadvantage();
    assert.equal(d.rolls.length, 2);
    assert.ok(typeof d.result === 'number');
  });

  it('result equals min of the two rolls', () => {
    for (let i = 0; i < 100; i++) {
      const d = disadvantage();
      assert.equal(d.result, Math.min(d.rolls[0], d.rolls[1]));
    }
  });

  it('all values are in [1, 20]', () => {
    for (let i = 0; i < 100; i++) {
      const d = disadvantage();
      assertRange(d.rolls, 1, 20, 'disadvantage rolls');
      assertRange([d.result], 1, 20, 'disadvantage result');
    }
  });
});
