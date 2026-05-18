'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../llm');
const { parseWeightedVariants, estimateCost, normalizeModelRef } = require('../llm/model-registry');
const { weightedChoice } = require('../llm/experiments');
const { parseNarrationResponse } = require('../narration-pipeline');

afterEach(() => {
  llm.resetProviderForTesting();
});

describe('LLM model registry', () => {
  it('normalizes unprefixed model names', () => {
    assert.strictEqual(normalizeModelRef('gpt-5.4-mini'), 'openai:gpt-5.4-mini');
  });

  it('parses weighted narration variants', () => {
    const variants = parseWeightedVariants('openai:gpt-5.4-mini:70,openai:gpt-5.4:30');
    assert.deepStrictEqual(variants.map(v => v.weight), [70, 30]);
    assert.strictEqual(variants[0].model, 'openai:gpt-5.4-mini');
    assert.strictEqual(variants[1].model, 'openai:gpt-5.4');
  });

  it('estimates model cost from normalized price table', () => {
    const cost = estimateCost('openai:gpt-5.4-mini', 1_000_000, 1_000_000);
    assert.strictEqual(cost, 5.25);
  });

  it('assigns the same weighted variant for the same key', () => {
    const variants = parseWeightedVariants('openai:gpt-5.4-mini:70,openai:gpt-5.4:30');
    const first = weightedChoice('game-abc', variants);
    const second = weightedChoice('game-abc', variants);
    assert.strictEqual(first.id, second.id);
  });
});

describe('LLM output harness', () => {
  const fixtures = [
    {
      name: 'social',
      output: `The candlelit common room quiets as Mira asks about the missing caravan. The innkeeper's smile falters; one hand closes around a brass key beneath the bar.

1️⃣ 🗣️ Press the innkeeper gently for names
2️⃣ 🛡️ Watch the room for anyone reacting
3️⃣ 🔥 Offer double coin for the truth`,
    },
    {
      name: 'exploration',
      output: `Rain beads on the black standing stones. Kael spots fresh boot prints vanishing between two leaning slabs, where the air smells sharply of pine smoke.

1️⃣ 🔍 Follow the tracks between the stones
2️⃣ 🛡️ Circle the site before entering
3️⃣ 🔥 Call out to whoever is hiding`,
    },
    {
      name: 'combat-adjacent',
      output: `The goblins spill from the ruined archway, blades low and eyes wide. They are close enough to threaten the path, but the clash has not begun yet.

1️⃣ 🗡️ Draw steel and hold the choke point
2️⃣ 🛡️ Fall back toward better cover
3️⃣ 🔥 Challenge their leader by name`,
    },
  ];

  it('checks every configured fixture for player-visible narration quality', async () => {
    let index = 0;
    llm.setProviderForTesting({
      streamText: async ({ onToken }) => {
        const text = fixtures[index++].output;
        for (const chunk of text.match(/.{1,40}/gs) || []) onToken?.(chunk);
        return { text, usage: { inputTokens: 100, outputTokens: 120 } };
      },
    });

    for (const fixture of fixtures) {
      let streamed = '';
      const result = await llm.streamText({
        task: 'narration',
        gameId: `test-${fixture.name}`,
        system: 'You are a concise game master.',
        prompt: 'Continue the scene.',
        onToken: chunk => { streamed += chunk; },
      });

      assert.strictEqual(streamed, fixture.output);
      assert.ok(result.llmRunId, 'run id should be generated for feedback linkage');

      const parsed = parseNarrationResponse(result.text);
      assert.ok(parsed.narration.length > 40, `${fixture.name}: narration should be substantive`);
      assert.strictEqual(parsed.options.length, 3, `${fixture.name}: should expose exactly 3 options`);
      assert.ok(!/---(?:OPTIONS|SCENE|WORLD)---/.test(parsed.narration), `${fixture.name}: markers must not leak`);
      assert.strictEqual(new Set(parsed.options.map(o => o.toLowerCase())).size, 3, `${fixture.name}: options must differ`);
      assert.ok(parsed.narration.split(/\s+/).length <= 100, `${fixture.name}: brief narration should stay concise`);
      assert.ok(!/\brolls?\s+\d+|\bdeals?\s+\d+\s+damage|\bHP\s*\d+/i.test(parsed.narration),
        `${fixture.name}: narration should not resolve engine-owned mechanics`);
    }
  });
});

describe('LLM timeout handling', () => {
  it('fails a wedged stream quickly instead of leaving the table waiting forever', async () => {
    llm.setProviderForTesting({
      streamText: async () => new Promise(() => {}),
    });

    await assert.rejects(
      llm.streamText({
        task: 'narration',
        gameId: 'timeout-test',
        prompt: 'Start the scene.',
        timeoutMs: 15,
      }),
      err => err?.code === 'LLM_TIMEOUT' && err?.name === 'TimeoutError'
    );
  });
});
