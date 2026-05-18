'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  substituteVariables,
  pickTemplate,
  getEventDescription,
  GENERIC_TEMPLATES,
  mapResultToTemplate,
  generateCombatOptions,
} = require('../template-engine');

describe('substituteVariables', () => {
  it('replaces all known variables', () => {
    const template = '{attacker} strikes {target} for {damage} damage.';
    const vars = { attacker: 'Kael', target: 'Goblin', damage: '7' };
    const result = substituteVariables(template, vars);
    assert.strictEqual(result, 'Kael strikes Goblin for 7 damage.');
  });

  it('leaves unknown variables as-is', () => {
    const template = '{attacker} hits {target} with {unknown}.';
    const vars = { attacker: 'Kael', target: 'Goblin' };
    const result = substituteVariables(template, vars);
    assert.strictEqual(result, 'Kael hits Goblin with {unknown}.');
  });

  it('handles empty vars object', () => {
    const template = '{target} staggers.';
    const result = substituteVariables(template, {});
    assert.strictEqual(result, '{target} staggers.');
  });
});

describe('pickTemplate', () => {
  it('returns a string from the pool', () => {
    const pool = ['Line A.', 'Line B.', 'Line C.'];
    const result = pickTemplate(pool);
    assert.ok(pool.includes(result));
  });

  it('returns null for empty pool', () => {
    assert.strictEqual(pickTemplate([]), null);
    assert.strictEqual(pickTemplate(null), null);
  });
});

describe('getEventDescription', () => {
  it('returns description for known event types', () => {
    assert.ok(getEventDescription('attack_hit').length > 0);
    assert.ok(getEventDescription('death').length > 0);
  });

  it('returns fallback for unknown event types', () => {
    assert.ok(getEventDescription('unknown_event').length > 0);
  });
});

describe('GENERIC_TEMPLATES', () => {
  it('has templates for humanoid creature type', () => {
    assert.ok(GENERIC_TEMPLATES.humanoid);
    assert.ok(GENERIC_TEMPLATES.humanoid.attack_hit);
    assert.ok(Array.isArray(GENERIC_TEMPLATES.humanoid.attack_hit.epic));
    assert.ok(GENERIC_TEMPLATES.humanoid.attack_hit.epic.length >= 5);
  });

  it('has templates for beast creature type', () => {
    assert.ok(GENERIC_TEMPLATES.beast);
    assert.ok(GENERIC_TEMPLATES.beast.attack_hit);
  });

  it('has templates for undead creature type', () => {
    assert.ok(GENERIC_TEMPLATES.undead);
    assert.ok(GENERIC_TEMPLATES.undead.death);
  });

  it('every template pool has at least 5 entries', () => {
    for (const [type, events] of Object.entries(GENERIC_TEMPLATES)) {
      for (const [event, personas] of Object.entries(events)) {
        for (const [persona, templates] of Object.entries(personas)) {
          assert.ok(templates.length >= 5,
            `${type}.${event}.${persona} has only ${templates.length} templates (need 5+)`);
        }
      }
    }
  });
});

describe('mapResultToTemplate', () => {
  const mockEngine = {
    state: {
      combatants: {
        'player-kael': { type: 'PC', name: 'Kael', hp: 30, maxHp: 35, slug: null,
          weapons: [{ name: 'Greatsword' }], spells: [], spellSlots: {} },
        'goblin-1': { type: 'Enemy', name: 'Goblin Archer', hp: 10, maxHp: 15,
          slug: 'goblin', creatureType: 'humanoid', personality: 'Cowardly and sneaky' },
      },
    },
  };

  it('maps monster attack hit correctly', () => {
    const result = { type: 'attack', attackerId: 'goblin-1', targetId: 'player-kael', hit: true, damage: 7, weapon: 'Shortbow' };
    const mapped = mapResultToTemplate(result, mockEngine);
    assert.strictEqual(mapped.monsterSlug, 'goblin');
    assert.strictEqual(mapped.eventType, 'attack_hit');
    assert.strictEqual(mapped.vars.target, 'Kael');
    assert.strictEqual(mapped.vars.damage, 7);
  });

  it('maps monster attack miss', () => {
    const result = { type: 'attack', attackerId: 'goblin-1', targetId: 'player-kael', hit: false, weapon: 'Shortbow' };
    const mapped = mapResultToTemplate(result, mockEngine);
    assert.strictEqual(mapped.eventType, 'attack_miss');
  });

  it('maps monster attack crit', () => {
    const result = { type: 'attack', attackerId: 'goblin-1', targetId: 'player-kael', hit: true, critical: true, damage: 14, weapon: 'Shortbow' };
    const mapped = mapResultToTemplate(result, mockEngine);
    assert.strictEqual(mapped.eventType, 'attack_crit');
  });

  it('maps PC attack hit to pc_attack_hit', () => {
    const result = { type: 'attack', attackerId: 'player-kael', targetId: 'goblin-1', hit: true, damage: 12, weapon: 'Greatsword' };
    const mapped = mapResultToTemplate(result, mockEngine);
    assert.strictEqual(mapped.monsterSlug, 'goblin');
    assert.strictEqual(mapped.eventType, 'pc_attack_hit');
  });

  it('maps killing blow to death event', () => {
    const deadEngine = {
      state: {
        combatants: {
          'player-kael': { type: 'PC', name: 'Kael', hp: 30, maxHp: 35 },
          'goblin-1': { type: 'Enemy', name: 'Goblin', hp: 0, maxHp: 15, slug: 'goblin', creatureType: 'humanoid' },
        },
      },
    };
    const result = { type: 'attack', attackerId: 'player-kael', targetId: 'goblin-1', hit: true, damage: 15 };
    const mapped = mapResultToTemplate(result, deadEngine);
    assert.strictEqual(mapped.eventType, 'death');
  });

  it('returns empty for heal results', () => {
    const result = { type: 'heal', casterId: 'player-kael' };
    const mapped = mapResultToTemplate(result, mockEngine);
    assert.deepStrictEqual(mapped, {});
  });

  it('returns empty for death_save results', () => {
    const result = { type: 'death_save', actorId: 'player-kael' };
    const mapped = mapResultToTemplate(result, mockEngine);
    assert.deepStrictEqual(mapped, {});
  });
});

describe('generateCombatOptions', () => {
  it('generates 3 options for a fighter', () => {
    const engine = {
      state: {
        combatants: {
          'player-kael': { type: 'PC', name: 'Kael', hp: 30, maxHp: 35,
            weapons: [{ name: 'Greatsword' }], spells: [], spellSlots: {},
            features: ['Extra Attack'] },
          'goblin-1': { type: 'Enemy', name: 'Goblin', hp: 10, maxHp: 15 },
        },
      },
    };
    const options = generateCombatOptions(engine, 'Kael');
    assert.strictEqual(options.length, 3);
    assert.ok(options[0].includes('Greatsword'));
    assert.ok(options[1].includes('Dodge'));
    assert.ok(options[2].includes('Extra Attack'));
  });

  it('suggests spell for caster with slots', () => {
    const engine = {
      state: {
        combatants: {
          'player-mira': { type: 'PC', name: 'Mira', hp: 20, maxHp: 20,
            weapons: [{ name: 'Dagger' }],
            spells: [{ name: 'Fireball', level: 3 }, { name: 'Fire Bolt', level: 0 }],
            spellSlots: { 1: 2, 2: 1, 3: 1 }, features: [] },
          'goblin-1': { type: 'Enemy', name: 'Goblin', hp: 10, maxHp: 15 },
        },
      },
    };
    const options = generateCombatOptions(engine, 'Mira');
    assert.ok(options[2].includes('Fireball'));
  });

  it('targets support spells at allies instead of enemies', () => {
    const engine = {
      state: {
        combatants: {
          'player-elowen': {
            id: 'player-elowen',
            type: 'PC',
            name: 'Sister Elowen Vale',
            hp: 20,
            maxHp: 24,
            weapons: [{ name: 'Mace' }],
            spells: [
              { name: 'Bless', level: 1, type: 'buff' },
              { name: 'Healing Word', level: 1, healing: '1d4', type: 'heal' },
            ],
            spellSlots: { 1: 2 },
            features: [],
          },
          'player-kael': { id: 'player-kael', type: 'PC', name: 'Kael', hp: 8, maxHp: 18 },
          'guild-factor': { id: 'guild-factor', type: 'Enemy', name: 'Guild Factor', hp: 50, maxHp: 60 },
        },
      },
    };

    const options = generateCombatOptions(engine, 'Sister Elowen Vale');
    const text = options.join('\n');

    assert.match(text, /Cast (Bless|Healing Word) on (Sister Elowen Vale|Kael)/);
    assert.doesNotMatch(text, /Cast (Bless|Healing Word) on Guild Factor/);
  });

  it('falls back to help instead of generic reckless filler', () => {
    const engine = {
      state: {
        combatants: {
          'player-bob': { type: 'PC', name: 'Bob', hp: 15, maxHp: 15,
            weapons: [{ name: 'Club' }], spells: [], spellSlots: {}, features: [] },
          'goblin-1': { type: 'Enemy', name: 'Goblin', hp: 10, maxHp: 15 },
        },
      },
    };
    const options = generateCombatOptions(engine, 'Bob');
    assert.strictEqual(options.length, 3);
    assert.match(options[2], /Help an exposed ally against Goblin/);
    assert.doesNotMatch(options.join('\n'), /reckless|scene's strange details|immediate danger/i);
  });

  it('filters non-combat standard actions out of active combat options', () => {
    const engine = {
      state: {
        combatants: {
          'player-garrick': {
            type: 'PC',
            name: 'Garrick Moorland',
            hp: 18,
            maxHp: 18,
            weapons: [{ name: 'Rapier' }],
            spells: [],
            spellSlots: {},
            features: [],
            standardActions: 'Press forward cautiously, Search the scene for useful details, Move on toward the objective, Attack with rapier, Dodge, Help ally',
          },
          'cult-acolytes': { type: 'Enemy', name: 'Cult acolytes', hp: 15, maxHp: 22 },
        },
      },
    };

    const options = generateCombatOptions(engine, 'Garrick Moorland');

    assert.strictEqual(options.length, 3);
    assert.match(options.join('\n'), /Attack Cult acolytes with rapier|Dodge|Help ally/);
    assert.doesNotMatch(options.join('\n'), /Press forward|Search the scene|Move on toward/i);
  });

  it('prefers character standard actions over generic combat fillers', () => {
    const engine = {
      state: {
        combatants: {
          'player-elowen': {
            type: 'PC',
            name: 'Sister Elowen Vale',
            hp: 24,
            maxHp: 24,
            weapons: [{ name: 'Mace' }],
            spells: [{ name: 'Sacred Flame', level: 0, damage: '1d8', save: 'dex' }],
            spellSlots: {},
            features: [],
            standardActions: 'Cast bless, Cast cure wounds, Cast spirit guardians, Attack with mace, Use Channel Divinity: Turn Undead, Dodge, Help ally',
          },
          'mummy-1': { type: 'Enemy', name: 'Tomb Presence', hp: 25, maxHp: 45 },
        },
      },
    };

    const options = generateCombatOptions(engine, 'Sister Elowen Vale');

    assert.strictEqual(options.length, 3);
    assert.match(options.join('\n'), /Cast bless|Cast cure wounds|Cast spirit guardians|Attack with mace|Channel Divinity|Dodge|Help ally/);
    assert.doesNotMatch(options.join('\n'), /reckless|scene's strange details|immediate danger/i);
  });
});
