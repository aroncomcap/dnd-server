'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  parseNarrationResponse,
  buildNarrationPrompt,
  processViolation,
} = require('../narration-pipeline');

describe('Pipeline Integration', () => {
  it('parseNarrationResponse handles streamed chunks assembled into full text', () => {
    const fullText = 'The door creaks open.\n\n1️⃣ 🗡️ Enter carefully\n2️⃣ 🛡️ Listen first\n3️⃣ 🔥 Kick it wide open';
    const result = parseNarrationResponse(fullText);
    assert.ok(result.narration.includes('door creaks'));
    assert.strictEqual(result.options.length, 3);
    assert.ok(result.options[0].includes('Enter'));
    assert.ok(result.options[2].includes('Kick'));
  });

  it('narration prompt is under 1000 tokens worth of text', () => {
    const prompt = buildNarrationPrompt('test', { system: 'dnd5e', custom_context: '' }, {
      dmPersona: 'epic',
      verbosity: 'brief',
      ferocity: 3,
      pillars: { exploration: 33, combat: 33, social: 34 },
      storySummary: 'Short summary.',
      rulesCorrections: [],
      npcMemory: {},
      encounterPlan: null,
      encounterPlanIndex: 0,
      data: {
        characters: {
          'Kael': { personality: 'Brave', backstory: 'Soldier.', standardActions: 'Attack', catchphrases: [], class: 'Fighter', level: 5 },
        },
      },
    });
    // Rough token estimate: 1 token ≈ 4 chars. 1000 tokens ≈ 4000 chars.
    assert.ok(prompt.length < 4000, `Prompt too long: ${prompt.length} chars (~${Math.ceil(prompt.length / 4)} tokens)`);
  });

  it('correction injection clears pending corrections', () => {
    const gs = { pendingCorrections: [], minorViolationCounts: {} };
    processViolation(gs, { severity: 'minor', type: 'verbosity', description: 'too long', correction: 'shorter' });
    processViolation(gs, { severity: 'minor', type: 'verbosity', description: 'too long', correction: 'shorter' });
    processViolation(gs, { severity: 'minor', type: 'verbosity', description: 'too long', correction: 'shorter' });
    assert.strictEqual(gs.pendingCorrections.length, 1);
    assert.strictEqual(gs.pendingCorrections[0].description, 'too long');
  });

  it('parseNarrationResponse handles response with no options gracefully', () => {
    const text = 'The room is empty. Dust motes float in the light.';
    const result = parseNarrationResponse(text);
    assert.ok(result.narration.includes('room is empty'));
    assert.strictEqual(result.options.length, 0);
  });

  it('parseNarrationResponse handles multiline narration with options', () => {
    const text = 'Line one of narration.\nLine two of narration.\n\n1️⃣ 🗡️ Option A\n2️⃣ 🛡️ Option B\n3️⃣ 🔥 Option C';
    const result = parseNarrationResponse(text);
    assert.ok(result.narration.includes('Line one'));
    assert.ok(result.narration.includes('Line two'));
    assert.strictEqual(result.options.length, 3);
  });

  it('parseNarrationResponse strips inline structured marker blocks from narration', () => {
    const text = 'The road narrows beneath the ash trees. ---OPTIONS------SCENE---\nACTION: Road travel\nMOOD: uneasy\n---WORLD---\nLOCATIONS:\n- Ash Road | Shadowed lane | current';
    const result = parseNarrationResponse(text);
    assert.strictEqual(result.narration, 'The road narrows beneath the ash trees.');
    assert.ok(!result.narration.includes('---OPTIONS---'));
    assert.ok(!result.narration.includes('---SCENE---'));
  });

  it('parseNarrationResponse extracts structured options without leaking markers', () => {
    const text = `The bridge sways in the rain.

---OPTIONS---
1. Cross one at a time
2. Anchor a rope first
3. Search for another crossing

---SCENE---
ACTION: Crossing the ravine`;
    const result = parseNarrationResponse(text);
    assert.strictEqual(result.narration, 'The bridge sways in the rain.');
    assert.deepStrictEqual(result.options, [
      'Cross one at a time',
      'Anchor a rope first',
      'Search for another crossing',
    ]);
  });

  it('buildNarrationPrompt excludes stat blocks', () => {
    const prompt = buildNarrationPrompt('test', { system: 'dnd5e', custom_context: '' }, {
      dmPersona: 'epic', verbosity: 'brief', ferocity: 3,
      pillars: { exploration: 33, combat: 33, social: 34 },
      storySummary: '', rulesCorrections: [], npcMemory: {},
      encounterPlan: null, encounterPlanIndex: 0,
      data: {
        characters: {
          'Kael': { personality: 'Brave', backstory: 'Soldier.', standardActions: 'Attack',
            catchphrases: [], class: 'Fighter', level: 5,
            statsText: 'STR 18 DEX 14 CON 16 INT 10 WIS 12 CHA 8, HP 44/44, AC 18' },
        },
      },
    });
    assert.ok(!prompt.includes('STR 18'));
    assert.ok(!prompt.includes('HP 44'));
    assert.ok(!prompt.includes('AC 18'));
    assert.ok(prompt.includes('Kael'));
    assert.ok(prompt.includes('Brave'));
  });
});
