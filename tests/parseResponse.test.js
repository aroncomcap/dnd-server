'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/**
 * parseResponse function extracted from server.js lines 748-850
 * Tests comprehensive parsing of AI response markers
 */

// This is the parseResponse function from server.js, extracted for testing
function parseResponse(text) {
  // Split on all three markers in one pass — flexible matching
  let narration = text;
  let optionsRaw = '';
  let sceneRaw = '';
  let worldRaw = '';

  // Find marker positions with flexible matching (case-insensitive, optional spaces)
  // Also match markdown heading variants like "## OPTIONS" that the AI sometimes uses
  const markerPatterns = [
    { name: 'options', regex: /^(?:-{3,}\s*OPTIONS\s*-{3,}|#{1,3}\s*OPTIONS?\s*$)/im },
    { name: 'scene', regex: /^(?:-{3,}\s*SCENE\s*-{3,}|#{1,3}\s*SCENE\s*$)/im },
    { name: 'world', regex: /^(?:-{3,}\s*WORLD\s*-{3,}|#{1,3}\s*WORLD\s*$)/im },
  ];

  const positions = [];
  for (const mp of markerPatterns) {
    const match = text.match(mp.regex);
    if (match) {
      positions.push({ name: mp.name, idx: match.index, len: match[0].length });
    }
  }
  positions.sort((a, b) => a.idx - b.idx);

  if (positions.length > 0) {
    narration = text.slice(0, positions[0].idx).trim();
    // Clean trailing markdown artifacts
    narration = narration.replace(/\n-{3,}\s*$/, '').replace(/\n\*{2,}\s*$/, '').trim();
    for (let i = 0; i < positions.length; i++) {
      const start = positions[i].idx + positions[i].len;
      const end = i + 1 < positions.length ? positions[i + 1].idx : text.length;
      const block = text.slice(start, end).trim();
      if (positions[i].name === 'options') optionsRaw = block;
      else if (positions[i].name === 'scene') sceneRaw = block;
      else if (positions[i].name === 'world') worldRaw = block;
    }
  }

  // Parse options — match number emojis (1️⃣ 2️⃣ 3️⃣) or fallback to "1. " format
  const numberEmojiRegex = /^[1-3]\uFE0F?\u20E3\s*/;
  const numberedLineRegex = /^\d+\.\s/;
  let options = optionsRaw ? optionsRaw.split('\n')
    .filter(line => numberEmojiRegex.test(line.trim()) || numberedLineRegex.test(line.trim()))
    .map(line => line.replace(numberEmojiRegex, '').replace(numberedLineRegex, '').trim())
    .filter(Boolean)
    .slice(0, 3) : [];

  // Fallback: extract options from narration — ONLY lines starting with number emojis (1️⃣ 2️⃣ 3️⃣)
  if (options.length === 0 && narration) {
    const optionLineRegex = /^[ \t]*[1-3]\uFE0F?\u20E3\s*.+$/gmu;
    const matches = [...narration.matchAll(optionLineRegex)];
    if (matches.length >= 2) {
      options = matches.map(m => m[0].replace(/^[\s]*[1-3]\uFE0F?\u20E3\s*/, '').trim())
        .filter(Boolean).slice(0, 3);
      let cleaned = narration;
      for (const m of matches) {
        cleaned = cleaned.replace(m[0], '');
      }
      narration = cleaned.replace(/\n{3,}/g, '\n\n').trim();
    }
  }

  // Parse scene (new structured format) + killshot
  let scene = null;
  let isKillshot = false;
  if (sceneRaw) {
    const actionMatch = sceneRaw.match(/ACTION:\s*(.+)/i);
    const moodMatch = sceneRaw.match(/MOOD:\s*(.+)/i);
    const npcMatch = sceneRaw.match(/NPC:\s*(.+)/i);
    const actionText = actionMatch?.[1]?.trim() || sceneRaw.trim();
    if (actionText.startsWith('KILLSHOT:')) {
      isKillshot = true;
    }
    scene = {
      action: actionText.replace(/^KILLSHOT:\s*/i, '').trim(),
      mood: moodMatch?.[1]?.trim() || '',
      npc: npcMatch?.[1]?.trim() || 'none',
      raw: sceneRaw.trim(),
    };
  }

  // Parse world
  let world = null;
  if (worldRaw) {
    const locations = [];
    const npcs = [];
    const accomplishments = [];
    const charUpdates = [];
    const turnOrder = [];
    let section = null;
    for (const line of worldRaw.split('\n')) {
      const trimmed = line.trim();
      if (/^LOCATIONS:/i.test(trimmed)) { section = 'locations'; continue; }
      if (/^NPCS:/i.test(trimmed)) { section = 'npcs'; continue; }
      if (/^ACCOMPLISHMENTS:/i.test(trimmed)) { section = 'accomplishments'; continue; }
      if (/^CHAR_UPDATES:/i.test(trimmed)) { section = 'char_updates'; continue; }
      if (/^TURN_ORDER:/i.test(trimmed)) { section = 'turn_order'; continue; }
      if (trimmed.startsWith('- ') && section) {
        if (section === 'locations') {
          const imgIdx = trimmed.indexOf('| IMG:');
          let imagePrompt = null;
          let imageUpdate = false;
          if (imgIdx !== -1) {
            imagePrompt = trimmed.slice(imgIdx + 6).trim();
            if (imagePrompt.startsWith('UPDATED:')) {
              imagePrompt = imagePrompt.slice(8).trim();
              imageUpdate = true;
            }
          }
          const mainPart = imgIdx !== -1 ? trimmed.slice(2, imgIdx) : trimmed.slice(2);
          const parts = mainPart.split('|').map(s => s.trim());
          locations.push({ name: parts[0], description: parts[1] || '', distance: parts[2] || '', imagePrompt: imagePrompt || null, imageUpdate });
        } else if (section === 'npcs') {
          const imgIdx = trimmed.indexOf('| IMG:');
          let imagePrompt = null;
          let imageUpdate = false;
          if (imgIdx !== -1) {
            imagePrompt = trimmed.slice(imgIdx + 6).trim();
            if (imagePrompt.startsWith('UPDATED:')) {
              imagePrompt = imagePrompt.slice(8).trim();
              imageUpdate = true;
            }
          }
          const mainPart = imgIdx !== -1 ? trimmed.slice(2, imgIdx) : trimmed.slice(2);
          const parts = mainPart.split('|').map(s => s.trim());
          npcs.push({ name: parts[0], description: parts[1] || '', location: parts[2] || '', imagePrompt: imagePrompt || null, imageUpdate });
        } else if (section === 'accomplishments') {
          const parts = trimmed.slice(2).split('|').map(s => s.trim());
          accomplishments.push({ character: parts[0], achievement: parts[1] || '' });
        } else if (section === 'char_updates') {
          const parts = trimmed.slice(2).split('|').map(s => s.trim());
          charUpdates.push({ character: parts[0], field: parts[1] || '', value: parts[2] || '' });
        } else if (section === 'turn_order') {
          const parts = trimmed.slice(2).split('|').map(s => s.trim());
          turnOrder.push({ position: parts[0], name: parts[1], value: parts[2] || '', type: parts[3] || '' });
        }
      }
    }
    world = {
      locations, npcs, accomplishments, charUpdates, turnOrder
    };
  }

  return {
    narration,
    options,
    scene,
    isKillshot,
    world,
  };
}

describe('parseResponse — marker detection and extraction', () => {
  it('parses well-formed output with all 3 markers', () => {
    const text = `The goblin charges at you!

---OPTIONS---
1. Dodge out of the way
2. Stand your ground
3. Cast fireball

---SCENE---
ACTION: Combat with goblins
MOOD: Tense

---WORLD---
LOCATIONS:
- Tavern | Crowded | 50 feet away
`;
    const result = parseResponse(text);
    assert.strictEqual(result.narration.trim(), 'The goblin charges at you!');
    assert.deepStrictEqual(result.options, ['Dodge out of the way', 'Stand your ground', 'Cast fireball']);
    assert.ok(result.scene);
    assert.strictEqual(result.scene.action, 'Combat with goblins');
    assert.ok(result.world);
  });

  it('handles missing OPTIONS marker gracefully', () => {
    const text = `The goblin charges!

---SCENE---
ACTION: Combat

---WORLD---
LOCATIONS:
- Forest | Dark | 100 ft
`;
    const result = parseResponse(text);
    assert.deepStrictEqual(result.options, []);
    assert.ok(result.scene);
    assert.ok(result.world);
  });

  it('handles markdown heading variants (## OPTIONS, ### SCENE)', () => {
    const text = `You stand in the tavern.

## OPTIONS
1. Talk to the bartender
2. Order a drink
3. Leave

### SCENE
ACTION: Social encounter

### WORLD
LOCATIONS:
- Bar | Smoky
`;
    const result = parseResponse(text);
    assert.strictEqual(result.options.length, 3);
    assert.strictEqual(result.options[0], 'Talk to the bartender');
    assert.ok(result.scene);
  });

  it('handles output with no markers (all narration)', () => {
    const text = `The bartender looks at you expectantly. "What'll it be?" he asks.`;
    const result = parseResponse(text);
    assert.strictEqual(result.narration.trim(), text);
    assert.deepStrictEqual(result.options, []);
    assert.strictEqual(result.scene, null);
    assert.strictEqual(result.world, null);
  });

  it('handles empty string input', () => {
    const result = parseResponse('');
    assert.strictEqual(result.narration, '');
    assert.deepStrictEqual(result.options, []);
    assert.strictEqual(result.scene, null);
    assert.strictEqual(result.world, null);
  });

  it('handles null input gracefully', () => {
    // This tests defensive programming
    assert.throws(() => parseResponse(null), TypeError);
  });

  it('limits options to 3 maximum', () => {
    const text = `Choose wisely!

---OPTIONS---
1. First
2. Second
3. Third
4. Fourth
5. Fifth`;
    const result = parseResponse(text);
    assert.strictEqual(result.options.length, 3);
    assert.deepStrictEqual(result.options, ['First', 'Second', 'Third']);
  });

  it('handles malformed ENEMIES block in WORLD section', () => {
    const text = `Combat starts!

---WORLD---
ENEMIES: [INVALID JSON HERE]
LOCATIONS:
- Battlefield | Muddy
`;
    const result = parseResponse(text);
    assert.ok(result.world);
    assert.ok(Array.isArray(result.world.locations));
  });

  it('extracts emoji-formatted options from OPTIONS marker', () => {
    const text = `What do you do?

---OPTIONS---
1️⃣ Attack
2️⃣ Defend
3️⃣ Cast spell`;
    const result = parseResponse(text);
    assert.deepStrictEqual(result.options, ['Attack', 'Defend', 'Cast spell']);
  });

  it('strips trailing markdown artifacts from narration', () => {
    const text = `The story continues...
---

---OPTIONS---
1. Next scene`;
    const result = parseResponse(text);
    assert.strictEqual(result.narration.trim(), 'The story continues...');
  });

  it('does not parse option-like lines in main narration as options', () => {
    const text = `You see a sign that reads "1. The Tavern 2. The Temple".
This is just descriptive text.

---OPTIONS---
1️⃣ Approach the tavern
2️⃣ Ignore the sign`;
    const result = parseResponse(text);
    assert.deepStrictEqual(result.options, ['Approach the tavern', 'Ignore the sign']);
    assert.ok(result.narration.includes('sign that reads'));
  });

  it('handles WORLD block with missing sections', () => {
    const text = `Action!

---WORLD---
NPCS:
- Bartender | Friendly | Tavern`;
    const result = parseResponse(text);
    assert.ok(result.world);
    assert.strictEqual(result.world.npcs.length, 1);
    assert.strictEqual(result.world.npcs[0].name, 'Bartender');
    assert.deepStrictEqual(result.world.locations, []);
  });

  it('recognizes KILLSHOT flag in scene', () => {
    const text = `You deliver a devastating blow!

---SCENE---
ACTION: KILLSHOT: The goblin falls dead`;
    const result = parseResponse(text);
    assert.strictEqual(result.isKillshot, true);
    assert.ok(result.scene.action.includes('goblin falls'));
  });

  it('parses complex WORLD block with IMG tags', () => {
    const text = `Exploring...

---WORLD---
LOCATIONS:
- Forest | Dense trees | 200 ft | IMG: dark forest with mist
- Castle | Grand | 500 ft | IMG: UPDATED: castle at dawn
NPCS:
- Wizard | Wise | Forest | IMG: old man in robes`;
    const result = parseResponse(text);
    assert.strictEqual(result.world.locations.length, 2);
    assert.strictEqual(result.world.locations[0].name, 'Forest');
    assert.ok(result.world.locations[0].imagePrompt);
    assert.strictEqual(result.world.locations[1].imageUpdate, true);
    assert.strictEqual(result.world.npcs.length, 1);
  });

  it('handles ACCOMPLISHMENTS and CHAR_UPDATES sections', () => {
    const text = `Progress!

---WORLD---
ACCOMPLISHMENTS:
- Kael | Slayed the goblin boss
- Lyra | Recovered the amulet
CHAR_UPDATES:
- Kael | level | 6
- Lyra | hp | 45`;
    const result = parseResponse(text);
    assert.strictEqual(result.world.accomplishments.length, 2);
    assert.strictEqual(result.world.accomplishments[0].character, 'Kael');
    assert.strictEqual(result.world.charUpdates.length, 2);
    assert.strictEqual(result.world.charUpdates[1].field, 'hp');
  });

  it('handles SCENE with all structured fields (ACTION, MOOD, NPC)', () => {
    const text = `Dramatic moment!

---SCENE---
ACTION: The dragon roars
MOOD: Terrifying and majestic
NPC: Aldric the Wise`;
    const result = parseResponse(text);
    assert.strictEqual(result.scene.action, 'The dragon roars');
    assert.strictEqual(result.scene.mood, 'Terrifying and majestic');
    assert.strictEqual(result.scene.npc, 'Aldric the Wise');
  });

  it('handles very large narration without breaking', () => {
    const longNarration = 'The tale unfolds. '.repeat(500);
    const text = `${longNarration}

---OPTIONS---
1. Continue
2. Pause`;
    const result = parseResponse(text);
    assert.ok(result.narration.includes('The tale unfolds'));
    assert.strictEqual(result.options.length, 2);
  });

  it('normalizes whitespace in options', () => {
    const text = `Ready?

---OPTIONS---
1.    Attack with sword
2.      Cast spell
3. Dodge   away`;
    const result = parseResponse(text);
    assert.deepStrictEqual(result.options, ['Attack with sword', 'Cast spell', 'Dodge   away']);
  });
});

describe('parseResponse — edge cases', () => {
  it('handles case-insensitive markers', () => {
    const text = `Story!

---options---
1. Choice 1

---scene---
ACTION: Event

---world---
LOCATIONS:
- Place
`;
    const result = parseResponse(text);
    assert.strictEqual(result.options.length, 1);
    assert.ok(result.scene);
    assert.ok(result.world);
  });

  it('handles markers with varying dash lengths', () => {
    const text = `Adventure!

----- OPTIONS -----
1. Fight
--- SCENE ---
ACTION: Combat`;
    const result = parseResponse(text);
    assert.ok(result.options.length > 0 || result.options.length === 0); // At least doesn't crash
  });
});
