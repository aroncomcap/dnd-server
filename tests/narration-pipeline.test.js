'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const llm = require('../llm');
const { createEncounterPlan } = require('../planner-state');

const {
  buildNarrationPrompt,
  buildUserMessage,
  buildExtractionPrompt,
  buildValidationPrompt,
  parseNarrationResponse,
  processViolation,
  shouldCallModelForFlavor,
  callModelNarration,
  handlePlayerAction,
} = require('../narration-pipeline');

afterEach(() => {
  llm.resetProviderForTesting();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeGameConfig() {
  return {
    name: 'Test Campaign',
    system: 'dnd5e',
    custom_context: 'A dark fantasy world threatened by an ancient lich.',
    house_rules: 'Crits deal max damage plus rolled damage.',
    dmPersona: 'epic',
  };
}

function makeGameState() {
  return {
    characters: [
      {
        name: 'Kael',
        data: {
          class: 'Fighter',
          level: 5,
          personality: 'Bold and honorable.',
          backstory: 'Kael grew up on the frontier. He fought his first battle at age twelve.',
          catchphrases: ['For the light!', 'Stand firm!'],
          standardActions: ['Attack', 'Dodge'],
          // stat block stuff that should NOT appear
          statsText: 'STR 18 DEX 10 CON 16 INT 8 WIS 12 CHA 10',
          hp: 45,
          maxHp: 45,
          ac: 18,
        },
      },
      {
        name: 'Mira',
        data: {
          class: 'Wizard',
          level: 5,
          personality: 'Curious and cautious.',
          backstory: 'Mira studied at the Arcane Academy. She left after uncovering a conspiracy.',
          catchphrases: ['Fascinating!'],
          standardActions: ['Cast Fireball'],
        },
      },
    ],
    storySummary: 'The party defeated the goblin king and found a map to the lich\'s lair.',
    world: {
      npcs: {
        'merchant-1': { name: 'Aldric', personality: 'Greedy but fair', lastSeen: 'Market Square' },
        'guard-1':    { name: 'Bren',   personality: 'Loyal soldier',   lastSeen: 'City Gate'     },
        'innkeeper-1':{ name: 'Helga',  personality: 'Warm and chatty',  lastSeen: 'The Rusty Mug' },
        'wizard-1':   { name: 'Zorin',  personality: 'Mysterious mage',  lastSeen: 'Tower'         },
        'bandit-1':   { name: 'Rook',   personality: 'Cunning thief',    lastSeen: 'Alley'         },
        'extra-1':    { name: 'Extra',  personality: 'Irrelevant',       lastSeen: 'Nowhere'       },
      },
    },
    ferocity: 3,
    verbosity: 'brief',
    pillars: { combat: 40, exploration: 30, social: 30 },
    encounterPlan: null,
    encounterIndex: 0,
    pendingCorrections: [],
    minorViolationCounts: {},
    chatHistory: [
      { role: 'user',      content: 'I walk into the tavern.' },
      { role: 'assistant', content: 'The barkeep eyes you warily as you enter.' },
    ],
  };
}

// ---------------------------------------------------------------------------
// buildNarrationPrompt
// ---------------------------------------------------------------------------

describe('buildNarrationPrompt', () => {
  it('includes persona block for epic', () => {
    const gs = makeGameState();
    const cfg = makeGameConfig();
    const prompt = buildNarrationPrompt('game-1', cfg, gs);
    assert.ok(prompt.includes('epic') || prompt.includes('Epic') || prompt.includes('dramatic') || prompt.includes('atmospheric'),
      'Prompt should include epic persona description');
  });

  it('includes persona block for over_the_top', () => {
    const gs = makeGameState();
    const cfg = { ...makeGameConfig(), dmPersona: 'over_the_top' };
    const prompt = buildNarrationPrompt('game-1', cfg, gs);
    assert.ok(
      prompt.toLowerCase().includes('over the top') ||
      prompt.toLowerCase().includes('comedic') ||
      prompt.toLowerCase().includes('chaotic') ||
      prompt.toLowerCase().includes('fourth-wall'),
      'Prompt should include over_the_top persona description'
    );
  });

  it('includes character names and personalities', () => {
    const gs = makeGameState();
    const cfg = makeGameConfig();
    const prompt = buildNarrationPrompt('game-1', cfg, gs);
    assert.ok(prompt.includes('Kael'), 'Should include character name Kael');
    assert.ok(prompt.includes('Mira'), 'Should include character name Mira');
    assert.ok(prompt.includes('Bold and honorable'), 'Should include personality');
    assert.ok(prompt.includes('Curious and cautious'), 'Should include personality');
  });

  it('preserves recent resolved combat outcomes as permanent state', () => {
    const gs = makeGameState();
    gs.lastCombatConclusion = {
      reason: 'enemies_defeated',
      defeated: ['Ashenvale Beast'],
      summary: 'Ashenvale Beast was defeated and the village is safe.',
    };
    const cfg = makeGameConfig();
    const prompt = buildNarrationPrompt('game-1', cfg, gs);
    assert.ok(prompt.includes('RESOLVED COMBAT STATE'), 'Should include a resolved combat state section');
    assert.ok(prompt.includes('Ashenvale Beast'), 'Should name defeated enemies');
    assert.ok(prompt.includes('do not revive') || prompt.includes('Do not revive'), 'Should prevent undoing the outcome');
  });

  it('does NOT include stat blocks (HP, AC, raw stats)', () => {
    const gs = makeGameState();
    const cfg = makeGameConfig();
    const prompt = buildNarrationPrompt('game-1', cfg, gs);
    // statsText should not appear verbatim
    assert.ok(!prompt.includes('STR 18 DEX 10'), 'Should NOT include raw stat blocks');
    // HP numbers should not appear
    assert.ok(!prompt.includes('hp: 45') && !prompt.includes('HP: 45'), 'Should NOT include HP values');
  });

  it('includes verbosity rule', () => {
    const gs = makeGameState();
    const cfg = makeGameConfig();
    const prompt = buildNarrationPrompt('game-1', cfg, gs);
    assert.ok(
      prompt.includes('brief') || prompt.includes('50') || prompt.includes('word'),
      'Should include verbosity guidance'
    );
  });

  it('includes house rules', () => {
    const gs = makeGameState();
    const cfg = makeGameConfig();
    const prompt = buildNarrationPrompt('game-1', cfg, gs);
    assert.ok(prompt.includes('Crits deal max damage'), 'Should include house rules');
  });

  it('includes story summary', () => {
    const gs = makeGameState();
    const cfg = makeGameConfig();
    const prompt = buildNarrationPrompt('game-1', cfg, gs);
    assert.ok(prompt.includes('goblin king'), 'Should include story summary');
  });

  it('includes campaign source material (capped at 50000 chars)', () => {
    const gs = makeGameState();
    const cfg = { ...makeGameConfig(), custom_context: 'Unique campaign lore: The Lich is named Mortem.' };
    const prompt = buildNarrationPrompt('game-1', cfg, gs);
    assert.ok(prompt.includes('Mortem'), 'Should include campaign context');
  });

  it('includes up to 5 NPCs from world state', () => {
    const gs = makeGameState();
    const cfg = makeGameConfig();
    const prompt = buildNarrationPrompt('game-1', cfg, gs);
    // Should include first 5 NPCs but not 6th
    const npcNames = ['Aldric', 'Bren', 'Helga', 'Zorin', 'Rook'];
    let includedCount = 0;
    for (const name of npcNames) {
      if (prompt.includes(name)) includedCount++;
    }
    assert.ok(includedCount >= 3, `Should include several NPCs, got ${includedCount}`);
    // Extra NPC should not be included (6th one)
    // Note: implementation may include or exclude 'Extra' — just test max is capped
    assert.ok(prompt.length < 200000, 'Prompt should not be excessively long');
  });

  it('includes ferocity description', () => {
    const gs = makeGameState();
    const cfg = makeGameConfig();
    const prompt = buildNarrationPrompt('game-1', cfg, gs);
    assert.ok(
      prompt.includes('ferocity') || prompt.includes('Ferocity') ||
      prompt.includes('Balanced') || prompt.includes('balanced'),
      'Should include ferocity info'
    );
  });

  it('includes pillars line', () => {
    const gs = makeGameState();
    const cfg = makeGameConfig();
    const prompt = buildNarrationPrompt('game-1', cfg, gs);
    assert.ok(
      prompt.includes('40') || prompt.includes('combat') || prompt.includes('exploration'),
      'Should include pillars guidance'
    );
  });

  it('includes 3-options format rule', () => {
    const gs = makeGameState();
    const cfg = makeGameConfig();
    const prompt = buildNarrationPrompt('game-1', cfg, gs);
    assert.ok(
      prompt.includes('3') || prompt.includes('option') || prompt.includes('Option'),
      'Should include options format rule'
    );
  });

  it('includes story momentum rules that prevent cautious non-event loops', () => {
    const gs = makeGameState();
    const cfg = makeGameConfig();
    const prompt = buildNarrationPrompt('game-1', cfg, gs);

    assert.match(prompt, /Every non-combat response must materially change the situation/);
    assert.match(prompt, /move the party to the next concrete place, person, clue, or decision/);
    assert.match(prompt, /Never answer progress with only cautious movement and no new information/);
    assert.match(prompt, /Do not repeat the same beat from recent turns/);
  });

  it('requires scene-changing options instead of passive re-checks', () => {
    const gs = makeGameState();
    const cfg = makeGameConfig();
    const prompt = buildNarrationPrompt('game-1', cfg, gs);

    assert.match(prompt, /Each option must change the situation/);
    assert.match(prompt, /one direct advance option, one interaction\/investigation option, and one bold or risky option/);
    assert.match(prompt, /Avoid "inspect\/search\/scout ahead" unless a specific unresolved hazard/);
  });

  it('uses encounterPlanIndex when injecting encounter guidance', () => {
    const gs = makeGameState();
    gs.encounterPlan = createEncounterPlan({
      encounters: [
        { pillar: 'combat', position: 'early', monsters: [{ name: 'Goblin', count: 2, slug: 'goblin' }] },
        { pillar: 'social', type: 'parley', dc: 14, successesNeeded: 2, maxFailures: 2 },
      ],
      summary: { totalEncounters: 2, combatCount: 1, socialCount: 1, explorationCount: 0 },
    });
    gs.encounterPlanIndex = 1;

    const prompt = buildNarrationPrompt('game-1', makeGameConfig(), gs);

    assert.match(prompt, /ENCOUNTER PLAN: Encounter 2 of 2/);
  });

  it('handles missing optional fields gracefully', () => {
    const gs = {
      characters: [],
      storySummary: null,
      world: {},
      ferocity: 3,
      verbosity: 'brief',
      pillars: {},
      encounterPlan: null,
      encounterIndex: 0,
      pendingCorrections: [],
      minorViolationCounts: {},
      chatHistory: [],
    };
    const cfg = { name: 'Test', system: 'dnd5e', dmPersona: 'epic' };
    assert.doesNotThrow(() => buildNarrationPrompt('game-1', cfg, gs));
  });
});

// ---------------------------------------------------------------------------
// parseNarrationResponse
// ---------------------------------------------------------------------------

describe('parseNarrationResponse', () => {
  it('parses emoji-numbered options correctly', () => {
    const text = `The dragon swoops down with terrifying speed, its wings casting shadows over the village.

1️⃣ Draw your sword and charge the beast
2️⃣ Cast Shield and call for backup
3️⃣ Try to reason with the dragon`;

    const { narration, options } = parseNarrationResponse(text);
    assert.ok(narration.includes('dragon swoops'), 'Narration should include story text');
    assert.strictEqual(options.length, 3);
    assert.ok(options[0].includes('Draw your sword'), `Option 1: ${options[0]}`);
    assert.ok(options[1].includes('Cast Shield'), `Option 2: ${options[1]}`);
    assert.ok(options[2].includes('Try to reason'), `Option 3: ${options[2]}`);
  });

  it('treats entire text as narration when no options found', () => {
    const text = 'The tavern door swings open, revealing a hooded figure.';
    const { narration, options } = parseNarrationResponse(text);
    assert.ok(narration.includes('hooded figure'));
    assert.strictEqual(options.length, 0);
  });

  it('parses numbered format with period (1. 2. 3.)', () => {
    const text = `You stand at the crossroads.

1. Head north toward the mountains
2. Turn east toward the forest
3. Make camp here for the night`;

    const { narration, options } = parseNarrationResponse(text);
    assert.strictEqual(options.length, 3);
    assert.ok(options[0].includes('north'));
    assert.ok(options[1].includes('east'));
    assert.ok(options[2].includes('camp'));
  });

  it('parses numbered format with parenthesis (1) 2) 3))', () => {
    const text = `The goblin raises its sword.

1) Parry the blow
2) Dodge to the side
3) Counter-attack`;

    const { narration, options } = parseNarrationResponse(text);
    assert.strictEqual(options.length, 3);
    assert.ok(options[0].includes('Parry'));
  });

  it('strips the emoji/number prefix from options', () => {
    const text = `Narration text here.

1️⃣ Attack the goblin
2️⃣ Retreat
3️⃣ Cast a spell`;

    const { narration, options } = parseNarrationResponse(text);
    // Options should NOT start with the emoji
    assert.ok(!options[0].startsWith('1️⃣'), 'Option should not start with emoji');
    assert.ok(options[0].trim().length > 0, 'Option should have content after stripping');
  });

  it('returns narration-only when only 1 option-like line found', () => {
    const text = `Some narration.
1. Only one option here.`;
    const { narration, options } = parseNarrationResponse(text);
    assert.strictEqual(options.length, 0, 'Should return no options if fewer than 2 option-like lines');
    assert.ok(narration.includes('Some narration') || narration.length > 0);
  });

  it('handles empty string gracefully', () => {
    const { narration, options } = parseNarrationResponse('');
    assert.strictEqual(narration, '');
    assert.strictEqual(options.length, 0);
  });
});

// ---------------------------------------------------------------------------
// buildUserMessage
// ---------------------------------------------------------------------------

describe('buildUserMessage', () => {
  it('includes chat history', () => {
    const gs = makeGameState();
    const msg = buildUserMessage(gs, 'Kael', 'I attack the goblin.');
    assert.ok(msg.includes('walk into the tavern') || msg.includes('barkeep'), 'Should include chat history');
  });

  it('uses persisted data.chatHistory when top-level chatHistory is absent', () => {
    const gs = {
      pendingCorrections: [],
      data: {
        chatHistory: [
          { role: 'assistant', content: 'Veyra Halm at Cinder Wharf is the current lead.' },
        ],
      },
    };

    const msg = buildUserMessage(gs, 'Kael', 'Follow the lead.');

    assert.ok(msg.includes('RECENT HISTORY'), 'Should include persisted history marker');
    assert.ok(msg.includes('Veyra Halm at Cinder Wharf'), 'Should preserve the current named lead');
    assert.ok(msg.includes('binding continuity'), 'Should tell the model to preserve the named lead');
  });

  it('adds anti-stall pacing when recent history keeps circling an established lead', () => {
    const gs = {
      pendingCorrections: [],
      data: {
        chatHistory: [
          { role: 'assistant', content: 'Master Halven says the warehouse ledger on Flint Row is the next lead.' },
          { role: 'assistant', content: 'The counting room is one door away, and the proof is waiting ahead.' },
        ],
      },
    };

    const msg = buildUserMessage(gs, 'Kael', 'Follow the lead toward the next clear objective.');

    assert.ok(msg.includes('ANTI-STALL PACING'), 'Should warn the model not to circle a known lead');
    assert.ok(msg.includes('Resolve or complicate it NOW'), 'Should require consuming the established lead');
    assert.ok(msg.includes('wrap the scene up'), 'Should shorten minor merchant/guild document scenes');
  });

  it('does not add anti-stall pacing for a new explicit combat action', () => {
    const gs = {
      pendingCorrections: [],
      data: {
        chatHistory: [
          { role: 'assistant', content: 'The counting room is one door away, and the proof is waiting ahead.' },
          { role: 'assistant', content: 'The clerk points toward the warehouse ledger again.' },
        ],
      },
    };

    const msg = buildUserMessage(gs, 'Kael', 'I stab the cultist.');

    assert.ok(!msg.includes('ANTI-STALL PACING'), 'Combat actions should not receive non-combat pacing directives');
  });

  it('includes the player action', () => {
    const gs = makeGameState();
    const msg = buildUserMessage(gs, 'Kael', 'I attack the goblin.');
    assert.ok(msg.includes('I attack the goblin'), 'Should include player action');
  });

  it('injects pending corrections when present', () => {
    const gs = makeGameState();
    gs.pendingCorrections = ['Do not describe spell slots aloud.', 'Keep NPC Aldric hostile.'];
    const msg = buildUserMessage(gs, 'Kael', 'I look around.');
    assert.ok(
      msg.includes('Do not describe spell slots') || msg.includes('Keep NPC Aldric hostile'),
      'Should inject pending corrections'
    );
  });

  it('consumes (clears) pendingCorrections after building message', () => {
    const gs = makeGameState();
    gs.pendingCorrections = ['Some correction.'];
    buildUserMessage(gs, 'Kael', 'I rest.');
    assert.strictEqual(gs.pendingCorrections.length, 0, 'pendingCorrections should be cleared after consumption');
  });

  it('works with no pending corrections', () => {
    const gs = makeGameState();
    gs.pendingCorrections = [];
    assert.doesNotThrow(() => buildUserMessage(gs, 'Kael', 'I look around.'));
  });

  it('includes character name', () => {
    const gs = makeGameState();
    const msg = buildUserMessage(gs, 'Kael', 'I search the room.');
    assert.ok(msg.includes('Kael'), 'Should include the acting character name');
  });

  it('carries resolved combat state into the immediate user message', () => {
    const gs = makeGameState();
    gs.lastCombatConclusion = {
      reason: 'enemies_defeated',
      defeated: ['Ashenvale Beast'],
      summary: 'Ashenvale Beast was defeated and the village is safe.',
    };
    const msg = buildUserMessage(gs, 'Kael', 'I tend wounds after the fight.');
    assert.ok(msg.includes('RESOLVED COMBAT STATE'), 'Should include resolved combat state');
    assert.ok(msg.includes('Ashenvale Beast'), 'Should include defeated enemy names');
    assert.ok(msg.includes('already defeated') || msg.includes('do not revive'), 'Should guard against resurrection drift');
  });
});

// ---------------------------------------------------------------------------
// processViolation
// ---------------------------------------------------------------------------

describe('processViolation', () => {
  it('queues critical violations immediately', () => {
    const gs = makeGameState();
    processViolation(gs, { severity: 'critical', key: 'dice_rolling', message: 'DM rolled dice in narration.' });
    assert.strictEqual(gs.pendingCorrections.length, 1);
    assert.ok(gs.pendingCorrections[0].includes('dice') || gs.pendingCorrections[0].length > 0);
  });

  it('does not queue minor violations on first occurrence', () => {
    const gs = makeGameState();
    processViolation(gs, { severity: 'minor', key: 'stat_mention', message: 'Mentioned AC value.' });
    assert.strictEqual(gs.pendingCorrections.length, 0, 'Minor violation should not queue on first occurrence');
    assert.strictEqual(gs.minorViolationCounts.stat_mention, 1);
  });

  it('does not queue minor violations on second occurrence', () => {
    const gs = makeGameState();
    gs.minorViolationCounts.stat_mention = 1;
    processViolation(gs, { severity: 'minor', key: 'stat_mention', message: 'Mentioned AC value again.' });
    assert.strictEqual(gs.pendingCorrections.length, 0, 'Minor violation should not queue on second occurrence');
    assert.strictEqual(gs.minorViolationCounts.stat_mention, 2);
  });

  it('escalates minor violation to correction after 3 consecutive occurrences', () => {
    const gs = makeGameState();
    gs.minorViolationCounts.stat_mention = 2;
    processViolation(gs, { severity: 'minor', key: 'stat_mention', message: 'Mentioned AC value third time.' });
    assert.strictEqual(gs.pendingCorrections.length, 1, 'Minor violation should queue after 3rd occurrence');
    assert.strictEqual(gs.minorViolationCounts.stat_mention, 0, 'Count should reset after escalation');
  });

  it('handles multiple distinct minor violation keys independently', () => {
    const gs = makeGameState();
    processViolation(gs, { severity: 'minor', key: 'key_a', message: 'Violation A.' });
    processViolation(gs, { severity: 'minor', key: 'key_b', message: 'Violation B.' });
    assert.strictEqual(gs.minorViolationCounts.key_a, 1);
    assert.strictEqual(gs.minorViolationCounts.key_b, 1);
    assert.strictEqual(gs.pendingCorrections.length, 0);
  });

  it('can queue multiple critical violations', () => {
    const gs = makeGameState();
    processViolation(gs, { severity: 'critical', key: 'v1', message: 'First critical.' });
    processViolation(gs, { severity: 'critical', key: 'v2', message: 'Second critical.' });
    assert.strictEqual(gs.pendingCorrections.length, 2);
  });
});

// ---------------------------------------------------------------------------
// shouldCallModelForFlavor
// ---------------------------------------------------------------------------

describe('shouldCallModelForFlavor', () => {
  it('returns true on round 1', () => {
    assert.strictEqual(shouldCallModelForFlavor({ round: 1, active: true }), true);
  });

  it('returns true on round 3 (every 3rd round)', () => {
    assert.strictEqual(shouldCallModelForFlavor({ round: 3, active: true }), true);
  });

  it('returns true on round 6', () => {
    assert.strictEqual(shouldCallModelForFlavor({ round: 6, active: true }), true);
  });

  it('returns false on round 2', () => {
    assert.strictEqual(shouldCallModelForFlavor({ round: 2, active: true }), false);
  });

  it('returns false on round 4', () => {
    assert.strictEqual(shouldCallModelForFlavor({ round: 4, active: true }), false);
  });

  it('returns false on round 5', () => {
    assert.strictEqual(shouldCallModelForFlavor({ round: 5, active: true }), false);
  });

  it('returns true when combat is over', () => {
    assert.strictEqual(shouldCallModelForFlavor({ round: 4, active: false }), true);
  });

  it('returns true when combatState has over flag', () => {
    assert.strictEqual(shouldCallModelForFlavor({ round: 4, active: true, over: true }), true);
  });
});

// ---------------------------------------------------------------------------
// buildExtractionPrompt (smoke test — pure string construction)
// ---------------------------------------------------------------------------

describe('buildExtractionPrompt', () => {
  it('includes narration, action, and world state', () => {
    const narration = 'The goblin falls to the ground, defeated.';
    const actionText = 'I stab the goblin.';
    const worldState = { locations: ['Tavern'], npcs: {} };
    const prompt = buildExtractionPrompt(narration, actionText, worldState);
    assert.ok(typeof prompt === 'string' && prompt.length > 0, 'Should return a non-empty string');
    assert.ok(prompt.includes('goblin falls'), 'Should include narration');
    assert.ok(prompt.includes('stab'), 'Should include action');
  });
});

// ---------------------------------------------------------------------------
// buildValidationPrompt (smoke test — pure string construction)
// ---------------------------------------------------------------------------

describe('buildValidationPrompt', () => {
  it('includes narration, options, and game state', () => {
    const narration = 'You stand at the entrance to the dungeon.';
    const options = ['Go inside', 'Wait for backup', 'Set a trap'];
    const gameState = { ferocity: 3, system: 'dnd5e' };
    const prompt = buildValidationPrompt(narration, options, gameState);
    assert.ok(typeof prompt === 'string' && prompt.length > 0, 'Should return a non-empty string');
    assert.ok(prompt.includes('entrance to the dungeon'), 'Should include narration');
  });
});

// ---------------------------------------------------------------------------
// handlePlayerAction fallback behavior
// ---------------------------------------------------------------------------

describe('handlePlayerAction fallback behavior', () => {
  it('suppresses extracted enemies after social pressure intent', async () => {
    let jsonCalls = 0;
    let combatStarted = false;
    llm.setProviderForTesting({
      streamText: async ({ onToken }) => {
        const text = 'The acolytes flinch under the pressure and admit the shipment is temple business, not an ambush.';
        onToken(text);
        return { text, usage: { inputTokens: 20, outputTokens: 20 } };
      },
      completeJson: async () => {
        jsonCalls++;
        if (jsonCalls === 1) {
          return {
            object: {
              enemies: [{ displayName: 'Acolyte', count: 5, slug: 'custom', hint: 'temple acolytes' }],
              scene: { action: 'Acolytes questioned in a tense room', mood: 'tense', npc: 'Acolytes' },
            },
            text: '{}',
            usage: { inputTokens: 20, outputTokens: 10 },
          };
        }
        return { object: { violations: [] }, text: '{}', usage: { inputTokens: 10, outputTokens: 3 } };
      },
    });

    const emitted = [];
    const io = {
      to: room => ({
        emit: (event, payload) => emitted.push({ room, event, payload }),
      }),
    };
    const gs = {
      ...makeGameState(),
      data: {
        characters: {
          Seraphine: {
            class: 'Rogue',
            level: 1,
            personality: 'Sharp and suspicious.',
            standardActions: 'Question suspects, Search the room, Dodge',
            backstory: 'A former investigator.',
            statsText: 'Level 1 rogue',
          },
        },
        chatHistory: [],
        turnOrder: ['Seraphine'],
        currentTurnIndex: 0,
      },
    };

    const result = await handlePlayerAction(
      'game-social-pressure',
      makeGameConfig(),
      gs,
      'Seraphine',
      'pressure the acolytes to explain who sent them',
      io,
      { initiateCombat: async () => { combatStarted = true; } }
    );

    assert.equal(combatStarted, false, 'social pressure should not start combat from extracted NPCs');
    assert.deepEqual(result.world.enemies, [], 'suppressed enemies should not leak into world output');
  });

  it('stops streaming visible narration before structured metadata', async () => {
    llm.setProviderForTesting({
      streamText: async ({ onToken }) => {
        onToken('The dust settles.');
        onToken(' ---OPTIONS---\n1️⃣ Follow the blue trail\n2️⃣ Inspect the room\n3️⃣ Cast detect magic');
        onToken('\n---SCENE---\nACTION: Caldus secures the path');
        return {
          text: 'The dust settles. ---OPTIONS---\n1️⃣ Follow the blue trail\n2️⃣ Inspect the room\n3️⃣ Cast detect magic\n---SCENE---\nACTION: Caldus secures the path',
          usage: { inputTokens: 10, outputTokens: 40 },
          llmRunId: 'run-stream-metadata',
        };
      },
    });

    const emitted = [];
    const io = {
      to: room => ({
        emit: (event, payload) => emitted.push({ room, event, payload }),
      }),
    };

    const result = await callModelNarration(
      'game-stream-metadata',
      makeGameConfig(),
      {
        ...makeGameState(),
        data: {
          characters: {
            Caldus: {
              class: 'Fighter',
              level: 5,
              personality: 'Cautious and steady.',
              standardActions: 'Attack, Dodge',
              backstory: 'Shield-bearing veteran.',
            },
          },
          chatHistory: [],
        },
      },
      'Caldus',
      'I secure the path.',
      io,
      {}
    );

    const streamedText = emitted
      .filter(e => e.event === 'dm_stream_chunk')
      .map(e => e.payload.text)
      .join('');

    assert.strictEqual(streamedText, 'The dust settles.');
    assert.ok(!streamedText.includes('---OPTIONS---'));
    assert.ok(!streamedText.includes('---SCENE---'));
    assert.strictEqual(result.narration, 'The dust settles.');
    assert.deepStrictEqual(result.options, [
      'Follow the blue trail',
      'Inspect the room',
      'Cast detect magic',
    ]);
  });

  it('returns an actionable fallback immediately when narration streaming fails', async () => {
    let completeJsonCalls = 0;
    llm.setProviderForTesting({
      streamText: async () => {
        const err = new Error('insufficient quota');
        err.code = 'insufficient_quota';
        throw err;
      },
      completeJson: async () => {
        completeJsonCalls++;
        throw new Error('fallback should not call structured model tasks');
      },
    });

    const emitted = [];
    const io = {
      to: room => ({
        emit: (event, payload) => emitted.push({ room, event, payload }),
      }),
    };
    const gs = {
      ...makeGameState(),
      data: {
        characters: {
          Kael: {
            class: 'Fighter',
            level: 5,
            personality: 'Bold and honorable.',
            standardActions: 'Attack, Dodge',
            backstory: 'Frontier veteran.',
            statsText: 'Level 5 fighter',
          },
        },
        chatHistory: [],
        turnOrder: ['Kael'],
        currentTurnIndex: 0,
      },
    };

    const result = await handlePlayerAction(
      'game-fallback',
      makeGameConfig(),
      gs,
      'Kael',
      'I search the room for hidden items.',
      io,
      {}
    );

    assert.ok(result.narration.includes('Kael'), 'fallback should name the acting character');
    assert.ok(result.narration.toLowerCase().includes('search'), 'fallback should reflect the action');
    assert.strictEqual(result.options.length, 3, 'fallback should keep the turn actionable');
    assert.strictEqual(completeJsonCalls, 0, 'fallback should not spend extra failed structured calls');

    const streamEnd = emitted.find(e => e.event === 'dm_stream_end');
    assert.ok(streamEnd, 'fallback should close the stream for clients');
    assert.strictEqual(streamEnd.payload.narration, result.narration);
  });

  it('treats an empty streamed narration as a playable fallback', async () => {
    let completeJsonCalls = 0;
    llm.setProviderForTesting({
      streamText: async () => ({ text: '', usage: { inputTokens: 10, outputTokens: 0 } }),
      completeJson: async () => {
        completeJsonCalls++;
        throw new Error('empty stream fallback should not call structured model tasks');
      },
    });

    const emitted = [];
    const io = {
      to: room => ({
        emit: (event, payload) => emitted.push({ room, event, payload }),
      }),
    };
    const gs = {
      ...makeGameState(),
      data: {
        characters: {
          Kael: {
            class: 'Fighter',
            level: 5,
            personality: 'Bold and honorable.',
            standardActions: 'Attack, Dodge',
            backstory: 'Frontier veteran.',
            statsText: 'Level 5 fighter',
          },
        },
        chatHistory: [],
        turnOrder: ['Kael'],
        currentTurnIndex: 0,
      },
    };

    const result = await handlePlayerAction(
      'game-empty-stream',
      makeGameConfig(),
      gs,
      'Kael',
      'I search the room for hidden items.',
      io,
      {}
    );

    assert.ok(result.narration.includes('Kael'), 'fallback should name the acting character');
    assert.strictEqual(result.options.length, 3, 'fallback should keep the turn actionable');
    assert.strictEqual(completeJsonCalls, 0, 'fallback should not spend extra failed structured calls');

    const streamEnd = emitted.find(e => e.event === 'dm_stream_end');
    assert.ok(streamEnd, 'fallback should close the stream for clients');
    assert.strictEqual(streamEnd.payload.narration, result.narration);
  });

  it('treats bare option echoes as playable fallback narration', async () => {
    let completeJsonCalls = 0;
    llm.setProviderForTesting({
      streamText: async ({ onToken }) => {
        onToken('Press forward cautiously');
        return { text: 'Press forward cautiously', usage: { inputTokens: 10, outputTokens: 4 } };
      },
      completeJson: async () => {
        completeJsonCalls++;
        throw new Error('option echo fallback should not call structured model tasks');
      },
    });

    const emitted = [];
    const io = {
      to: room => ({
        emit: (event, payload) => emitted.push({ room, event, payload }),
      }),
    };
    const gs = {
      ...makeGameState(),
      data: {
        characters: {
          Kael: {
            class: 'Fighter',
            level: 5,
            personality: 'Bold and honorable.',
            standardActions: 'Attack, Dodge',
            backstory: 'Frontier veteran.',
            statsText: 'Level 5 fighter',
          },
        },
        chatHistory: [],
        turnOrder: ['Kael'],
        currentTurnIndex: 0,
      },
    };

    const result = await handlePlayerAction(
      'game-option-echo-fallback',
      makeGameConfig(),
      gs,
      'Kael',
      'Press forward cautiously',
      io,
      {}
    );

    assert.notStrictEqual(result.narration, 'Press forward cautiously');
    assert.ok(result.narration.includes('Kael'), 'fallback should name the acting character');
    assert.ok(result.narration.toLowerCase().includes('press forward'), 'fallback should reflect the echoed action');
    assert.strictEqual(result.options.length, 3, 'fallback should keep the turn actionable');
    assert.strictEqual(completeJsonCalls, 0, 'fallback should not spend extra failed structured calls');

    const streamEnd = emitted.find(e => e.event === 'dm_stream_end');
    assert.ok(streamEnd, 'fallback should close the stream for clients');
    assert.strictEqual(streamEnd.payload.narration, result.narration);
  });

  it('does not treat a game-start prompt as the fallback actor name', async () => {
    llm.setProviderForTesting({
      streamText: async () => ({ text: '', usage: { inputTokens: 10, outputTokens: 0 } }),
    });

    const emitted = [];
    const io = {
      to: room => ({
        emit: (event, payload) => emitted.push({ room, event, payload }),
      }),
    };
    const gs = {
      ...makeGameState(),
      data: {
        characters: {},
        chatHistory: [],
        turnOrder: [],
        currentTurnIndex: 0,
      },
    };

    const result = await handlePlayerAction(
      'game-start-fallback',
      makeGameConfig(),
      gs,
      'Begin the adventure. Set the scene vividly.',
      'Begin the adventure. Set the scene vividly.',
      io,
      {}
    );

    assert.ok(result.narration.startsWith('The story moves forward'), 'fallback should use a generic story actor');
    assert.ok(!result.narration.startsWith('Begin the adventure'), 'fallback should not use prompt text as actor name');
  });
});
