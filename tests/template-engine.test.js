'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  substituteVariables,
  pickTemplate,
  getEventDescription,
  GENERIC_TEMPLATES,
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
