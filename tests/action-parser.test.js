'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseAction, parseOptions } = require('../action-parser.js');

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const COMBATANTS = {
  kael: {
    id: 'kael',
    name: 'Kael',
    type: 'Player',
    weapons: [{ name: 'Longsword' }, { name: 'Dagger' }],
    spells: [
      { name: 'Fireball', damage: '8d6', save: 'dex' },
      { name: 'Fire Bolt', level: 0, attack: true, damage: '1d10', damageType: 'fire' },
      { name: 'Shield' },
      { name: 'Cure Wounds', healing: '1d8' },
      { name: 'Sacred Flame', damage: '1d8', save: 'dex' },
      { name: 'Dissonant Whispers', damage: '3d6', save: 'wis' },
    ],
  },
  'gob-1': {
    id: 'gob-1',
    name: 'Goblin',
    type: 'Enemy',
    weapons: [{ name: 'Scimitar' }],
    spells: [],
  },
  'goblin-archer-2': {
    id: 'goblin-archer-2',
    name: 'Goblin Archer',
    type: 'Enemy',
    weapons: [{ name: 'Shortbow' }],
    spells: [],
  },
  azer: {
    id: 'azer',
    name: 'Azer',
    type: 'Enemy',
    weapons: [{ name: 'Warhammer' }],
    spells: [],
  },
  lyra: {
    id: 'lyra',
    name: 'Lyra',
    type: 'Player',
    weapons: [],
    spells: [],
  },
};

const BASE_CTX = { combatants: COMBATANTS, preTaggedOptions: null };

// ---------------------------------------------------------------------------
// Option number mapping
// ---------------------------------------------------------------------------

describe('parseAction — option numbers', () => {
  const PRE_TAGGED = [
    { type: 'attack', targetId: 'gob-1', weapon: 'Longsword' },
    { type: 'dodge' },
    { type: 'spell', spell: 'Fireball', targetId: 'gob-1' },
  ];
  const ctx = { combatants: COMBATANTS, preTaggedOptions: PRE_TAGGED };

  it('"1" maps to first pre-tagged option with attackerId injected', () => {
    const result = parseAction('1', 'kael', ctx);
    assert.ok(result, 'should not return null');
    assert.equal(result.attackerId, 'kael');
    assert.equal(result.type, 'attack');
    assert.equal(result.targetId, 'gob-1');
    assert.equal(result.weapon, 'Longsword');
  });

  it('"2" maps to second pre-tagged option', () => {
    const result = parseAction('2', 'kael', ctx);
    assert.ok(result);
    assert.equal(result.type, 'dodge');
    assert.equal(result.attackerId, 'kael');
  });

  it('"3" maps to third pre-tagged option', () => {
    const result = parseAction('3', 'kael', ctx);
    assert.ok(result);
    assert.equal(result.type, 'spell');
    assert.equal(result.spell, 'Fireball');
    assert.equal(result.attackerId, 'kael');
  });

  it('option numbers return null when preTaggedOptions is null', () => {
    const result = parseAction('1', 'kael', BASE_CTX);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Simple actions
// ---------------------------------------------------------------------------

describe('parseAction — simple actions', () => {
  it('"dodge" returns dodge action', () => {
    const result = parseAction('dodge', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'dodge');
    assert.equal(result.attackerId, 'kael');
  });

  it('"disengage" returns disengage action', () => {
    const result = parseAction('disengage', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'disengage');
  });

  it('"dash" returns dash action', () => {
    const result = parseAction('dash', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'dash');
  });

  it('"help" returns help action', () => {
    const result = parseAction('help', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'help');
  });

  it('DODGE (uppercase) returns dodge', () => {
    const result = parseAction('DODGE', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'dodge');
  });
});

// ---------------------------------------------------------------------------
// Attack with weapon
// ---------------------------------------------------------------------------

describe('parseAction — attack with weapon', () => {
  it('"attack goblin with longsword" → attack with correct target and weapon', () => {
    const result = parseAction('attack goblin with longsword', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'attack');
    assert.equal(result.attackerId, 'kael');
    assert.equal(result.targetId, 'gob-1');
    assert.equal(result.weapon, 'Longsword');
  });

  it('"strike goblin with dagger" → attack with dagger', () => {
    const result = parseAction('strike goblin with dagger', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'attack');
    assert.equal(result.weapon, 'Dagger');
  });

  it('"slash goblin with longsword" verb aliases work', () => {
    const result = parseAction('slash goblin with longsword', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'attack');
  });
});

// ---------------------------------------------------------------------------
// Attack without weapon
// ---------------------------------------------------------------------------

describe('parseAction — attack without weapon', () => {
  it('"attack goblin" uses first weapon', () => {
    const result = parseAction('attack goblin', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'attack');
    assert.equal(result.attackerId, 'kael');
    assert.equal(result.targetId, 'gob-1');
    assert.equal(result.weapon, 'Longsword');
  });

  it('"attack Goblin Archer" matches goblin-archer-2', () => {
    const result = parseAction('attack Goblin Archer', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.targetId, 'goblin-archer-2');
  });

  it('sneak attack feature text resolves through deterministic attack math', () => {
    const result = parseAction('Sneak Attack 1d6', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'attack');
    assert.equal(result.attackerId, 'kael');
    assert.equal(result.targetId, 'gob-1');
    assert.equal(result.weapon, 'Longsword');
  });

  it('explicit extra attack phrasing resolves as a multi-attack request', () => {
    const result = parseAction('Attack with longsword twice with extra attack', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'attack');
    assert.equal(result.targetId, 'gob-1');
    assert.equal(result.weapon, 'Longsword');
    assert.equal(result.attackCountOverride, 2);
  });
});

// ---------------------------------------------------------------------------
// Spell casting
// ---------------------------------------------------------------------------

describe('parseAction — cast spell on target', () => {
  it('"cast fireball on goblin" → spell with targetId', () => {
    const result = parseAction('cast fireball on goblin', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'spell');
    assert.equal(result.attackerId, 'kael');
    assert.equal(result.spell, 'Fireball');
    assert.equal(result.targetId, 'gob-1');
  });

  it('"cast fireball at goblin" → spell with targetId', () => {
    const result = parseAction('cast fireball at goblin', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'spell');
    assert.equal(result.targetId, 'gob-1');
  });

  it('speaker-prefixed spell text still resolves through deterministic spell math', () => {
    const result = parseAction('Kael: Cast fire bolt at Azer.', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'spell');
    assert.equal(result.attackerId, 'kael');
    assert.equal(result.spell, 'Fire Bolt');
    assert.equal(result.targetId, 'azer');
  });

  it('"cast shield" → spell targeting self', () => {
    const result = parseAction('cast shield', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'spell');
    assert.equal(result.spell, 'Shield');
    assert.equal(result.targetId, 'kael');
  });

  it('untargeted offensive cantrips target the first enemy, not the caster', () => {
    const result = parseAction('cast sacred flame', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'spell');
    assert.equal(result.spell, 'Sacred Flame');
    assert.equal(result.targetId, 'gob-1');
  });

  it('freeform offensive spell intent targets the enemy instead of becoming an attack', () => {
    const result = parseAction('cast dissonant whispers to drive it back', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'spell');
    assert.equal(result.spell, 'Dissonant Whispers');
    assert.equal(result.targetId, 'gob-1');
  });
});

// ---------------------------------------------------------------------------
// Heal
// ---------------------------------------------------------------------------

describe('parseAction — heal', () => {
  it('"heal kael" → spell using healing spell', () => {
    const result = parseAction('heal kael', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'spell');
    assert.equal(result.spell, 'Cure Wounds');
    assert.equal(result.targetId, 'kael');
  });

  it('"heal lyra" → targets lyra', () => {
    const result = parseAction('heal lyra', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.targetId, 'lyra');
  });
});

// ---------------------------------------------------------------------------
// Unparseable inputs → null
// ---------------------------------------------------------------------------

describe('parseAction — unparseable returns null', () => {
  it('freeform text returns null', () => {
    assert.equal(parseAction('I want to do something creative', 'kael', BASE_CTX), null);
  });

  it('empty string returns null', () => {
    assert.equal(parseAction('', 'kael', BASE_CTX), null);
  });

  it('null input returns null', () => {
    assert.equal(parseAction(null, 'kael', BASE_CTX), null);
  });

  it('random word returns null', () => {
    assert.equal(parseAction('xyzzy', 'kael', BASE_CTX), null);
  });
});

// ---------------------------------------------------------------------------
// Exploration / interaction actions
// ---------------------------------------------------------------------------

describe('parseAction — non-attack combat actions', () => {
  it('bare attack resolves to the first living enemy with the primary weapon', () => {
    const result = parseAction('attack', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'attack');
    assert.equal(result.attackerId, 'kael');
    assert.equal(result.targetId, 'gob-1');
    assert.equal(result.weapon, 'Longsword');
  });

  it('bare attacks use the persistent attack target when one is set', () => {
    const result = parseAction('attack', 'kael', {
      ...BASE_CTX,
      targetPreferences: { attackTargetId: 'goblin-archer-2' },
    });
    assert.ok(result);
    assert.equal(result.type, 'attack');
    assert.equal(result.targetId, 'goblin-archer-2');
  });

  it('bare weapon names in combat resolve as attacks against the preferred target', () => {
    const result = parseAction('longsword', 'kael', {
      ...BASE_CTX,
      targetPreferences: { attackTargetId: 'goblin-archer-2' },
    });
    assert.ok(result);
    assert.equal(result.type, 'attack');
    assert.equal(result.weapon, 'Longsword');
    assert.equal(result.targetId, 'goblin-archer-2');
  });

  it('offensive spells use the persistent attack target when no target is typed', () => {
    const result = parseAction('cast sacred flame', 'kael', {
      ...BASE_CTX,
      targetPreferences: { attackTargetId: 'goblin-archer-2' },
    });
    assert.ok(result);
    assert.equal(result.type, 'spell');
    assert.equal(result.targetId, 'goblin-archer-2');
  });

  it('healing shorthand uses the persistent support target when the typed target is missing', () => {
    const result = parseAction('heal ally', 'kael', {
      ...BASE_CTX,
      targetPreferences: { supportTargetId: 'lyra' },
    });
    assert.ok(result);
    assert.equal(result.type, 'spell');
    assert.equal(result.targetId, 'lyra');
  });

  it('checking an object is parsed as a check, not an attack fallback', () => {
    const result = parseAction('check the sarcophagus', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'check');
    assert.equal(result.actorId, 'kael');
    assert.equal(result.attackerId, 'kael');
    assert.equal(result.targetId, null);
    assert.equal(result.description, 'check the sarcophagus');
  });

  it('inspecting the scene is parsed as a check', () => {
    const result = parseAction('I inspect the silver chain for magic', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'check');
  });
});

// ---------------------------------------------------------------------------
// Dialogue / social intent
// ---------------------------------------------------------------------------

describe('parseAction — dialogue intent', () => {
  it('parley and persuasion phrasing routes to dialogue, not combat', () => {
    const result = parseAction('parlay and make peace with a persuasion check', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'dialogue');
    assert.equal(result.actorId, 'kael');
    assert.equal(result.attackerId, 'kael');
    assert.equal(result.targetId, null);
  });

  it('asking an NPC a question routes to dialogue', () => {
    const result = parseAction('I ask the Goblin why they are blocking the road', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'dialogue');
  });

  it('offering peace with an enemy nearby routes to dialogue', () => {
    const result = parseAction('hold up hands and offer peace: "we came to fight goblins, not you"', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'dialogue');
  });

  it('negotiate with phrasing does not become an attack target named "with"', () => {
    const result = parseAction('negotiate with the Goblin', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'dialogue');
    assert.equal(result.targetId, null);
  });

  it('social pressure and intimidation phrasing routes to dialogue', () => {
    const result = parseAction('pressure the acolytes to explain who sent them', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'dialogue');
    assert.equal(result.targetId, null);
  });

  it('explicit attack still wins over nearby social words', () => {
    const result = parseAction('attack the Goblin with Longsword', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'attack');
    assert.equal(result.targetId, 'gob-1');
  });

  it('emoji-prefixed attack options are parsed by intent', () => {
    const result = parseAction('🗡️ Attack Goblin with Longsword', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'attack');
    assert.equal(result.targetId, 'gob-1');
    assert.equal(result.weapon, 'Longsword');
  });
});

// ---------------------------------------------------------------------------
// Travel / story advancement intent
// ---------------------------------------------------------------------------

describe('parseAction — story advancement intent', () => {
  it('travel phrasing routes to advance, not combat', () => {
    const result = parseAction('Travel to the Caves of Chaos', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'advance');
    assert.equal(result.actorId, 'kael');
    assert.equal(result.targetId, null);
  });

  it('moving on routes to advance', () => {
    const result = parseAction('we move on toward the main caves', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'advance');
  });

  it('acknowledgement routes to advance instead of becoming ambiguous combat', () => {
    const result = parseAction('yes', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'advance');
  });

  it('partial continuation command routes to advance', () => {
    const result = parseAction('continue', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.type, 'advance');
  });
});

// ---------------------------------------------------------------------------
// parseOptions
// ---------------------------------------------------------------------------

describe('parseOptions — typical AI option strings', () => {
  it('parses 3 standard options', () => {
    const options = [
      'Attack the goblin with your longsword',
      'Dodge and take defensive stance',
      'Cast fireball on the goblin',
    ];
    const results = parseOptions(options, 'kael', BASE_CTX);
    assert.equal(results.length, 3);
    assert.ok(results[0], 'option 1 should parse');
    assert.equal(results[0].type, 'attack');
    assert.equal(results[0].attackerId, 'kael');
    assert.ok(results[1], 'option 2 should parse');
    assert.equal(results[1].type, 'dodge');
    assert.ok(results[2], 'option 3 should parse');
    assert.equal(results[2].type, 'spell');
  });

  it('strips emoji prefixes from options', () => {
    const options = [
      '⚔️ Attack goblin with longsword',
      '🛡️ Dodge the attack',
      '🔥 Cast fireball on goblin',
    ];
    const results = parseOptions(options, 'kael', BASE_CTX);
    assert.equal(results.length, 3);
    // After emoji strip, these should parse
    for (const r of results) {
      assert.ok(r, 'should not be null after emoji strip');
      assert.equal(r.attackerId, 'kael');
    }
  });

  it('uses fallback heuristics for unstructured options', () => {
    const options = [
      'Try to slash at the enemy',   // attack heuristic
      'Defend yourself carefully',   // dodge heuristic
      'Use your magic abilities',    // cast heuristic
    ];
    const results = parseOptions(options, 'kael', BASE_CTX);
    assert.equal(results.length, 3);
    assert.ok(results[0]);
    assert.equal(results[0].type, 'attack');
    assert.ok(results[1]);
    assert.equal(results[1].type, 'dodge');
    assert.ok(results[2]);
    assert.equal(results[2].type, 'spell');
  });

  it('parses exploratory options as checks instead of leaving them for AI attack fallback', () => {
    const options = [
      'Kael checks the sarcophagus for danger',
      'Inspect the blue residue before moving',
      'Search the chamber for the hidden route',
    ];
    const results = parseOptions(options, 'kael', BASE_CTX);
    assert.equal(results.length, 3);
    for (const result of results) {
      assert.ok(result);
      assert.equal(result.type, 'check');
      assert.equal(result.actorId, 'kael');
    }
  });

  it('parses social options as dialogue, not combat fallbacks', () => {
    const options = [
      'Speak calmly to the Goblin',
      'Negotiate safe passage',
      'Offer peace and lower your weapon',
    ];
    const results = parseOptions(options, 'kael', BASE_CTX);
    assert.equal(results.length, 3);
    for (const result of results) {
      assert.ok(result);
      assert.equal(result.type, 'dialogue');
      assert.equal(result.actorId, 'kael');
      assert.equal(result.targetId, null);
    }
  });

  it('parses progress options as advance, not combat fallbacks', () => {
    const options = [
      'Continue toward the caves',
      'Travel along the road',
      'Move on from the merchant watch',
    ];
    const results = parseOptions(options, 'kael', BASE_CTX);
    assert.equal(results.length, 3);
    for (const result of results) {
      assert.ok(result);
      assert.equal(result.type, 'advance');
      assert.equal(result.actorId, 'kael');
      assert.equal(result.targetId, null);
    }
  });
});

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

describe('fuzzy matching', () => {
  it('"goblin" matches "Goblin" (case insensitive) → gob-1', () => {
    const result = parseAction('attack goblin', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.targetId, 'gob-1');
  });

  it('"goblin" can match via id "gob-1" when name similarity is lower', () => {
    const ctx = {
      combatants: {
        kael: COMBATANTS.kael,
        'gob-1': { ...COMBATANTS['gob-1'], name: 'Orc' },
      },
      preTaggedOptions: null,
    };
    // "goblin" matches id "gob-1" by partial overlap
    const result = parseAction('attack goblin', 'kael', ctx);
    assert.ok(result);
    assert.equal(result.targetId, 'gob-1');
  });

  it('partial match: "archer" matches "Goblin Archer"', () => {
    const result = parseAction('attack archer', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.targetId, 'goblin-archer-2');
  });

  it('case insensitive weapon match: "LONGSWORD" matches "Longsword"', () => {
    const result = parseAction('attack goblin with LONGSWORD', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.weapon, 'Longsword');
  });

  it('case insensitive spell match: "FIREBALL" matches "Fireball"', () => {
    const result = parseAction('cast FIREBALL on goblin', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.spell, 'Fireball');
  });

  it('partial spell match: "fire" matches "Fireball"', () => {
    const result = parseAction('cast fire on goblin', 'kael', BASE_CTX);
    assert.ok(result);
    assert.equal(result.spell, 'Fireball');
  });

  it('enemy type preference: "attack goblin" prefers Enemy type over Player named Goblin', () => {
    const ctx = {
      combatants: {
        kael: COMBATANTS.kael,
        'gob-1': COMBATANTS['gob-1'],
        goblin_npc: {
          id: 'goblin_npc',
          name: 'Goblin',
          type: 'Player', // friendly NPC named Goblin
          weapons: [],
          spells: [],
        },
      },
      preTaggedOptions: null,
    };
    const result = parseAction('attack goblin', 'kael', ctx);
    assert.ok(result);
    // Should prefer enemy type
    assert.equal(result.targetId, 'gob-1');
  });
});
