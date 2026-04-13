'use strict';

// ---------------------------------------------------------------------------
// Fuzzy matching helpers
// ---------------------------------------------------------------------------

/**
 * Score how well `query` matches `name`.
 * Returns a positive number (higher = better) or 0 if no match.
 */
function fuzzyScore(query, name) {
  const q = query.toLowerCase().trim();
  const n = name.toLowerCase().trim();
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.startsWith(q) || q.startsWith(n)) return 80;
  if (n.includes(q) || q.includes(n)) return 60;
  // Word overlap
  const qWords = q.split(/\s+/);
  const nWords = n.split(/[\s\-_]+/);
  const overlap = qWords.filter(w => nWords.some(nw => nw.includes(w) || w.includes(nw)));
  if (overlap.length > 0) return 20 * overlap.length;
  return 0;
}

/**
 * Find the best matching combatant id for a name query.
 * When typeFilter is provided, prefer combatants of that type but fall back to any.
 */
function findCombatantId(query, combatants, typeFilter = null) {
  if (!query) return null;
  const q = query.toLowerCase().trim();

  // Direct id match
  if (combatants[q]) return q;

  let best = null;
  let bestScore = 0;

  for (const [id, c] of Object.entries(combatants)) {
    const score = Math.max(fuzzyScore(q, c.name), fuzzyScore(q, id));
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }

  if (bestScore === 0) return null;

  // If typeFilter is given, check if there's a same-type match and prefer it
  if (typeFilter) {
    let typeBest = null;
    let typeBestScore = 0;
    for (const [id, c] of Object.entries(combatants)) {
      if (c.type !== typeFilter) continue;
      const score = Math.max(fuzzyScore(q, c.name), fuzzyScore(q, id));
      if (score > typeBestScore) {
        typeBestScore = score;
        typeBest = id;
      }
    }
    if (typeBest && typeBestScore >= bestScore * 0.6) return typeBest;
  }

  return best;
}

/**
 * Find the first enemy combatant id.
 */
function firstEnemyId(combatants) {
  for (const [id, c] of Object.entries(combatants)) {
    if (c.type === 'Enemy') return id;
  }
  return null;
}

/**
 * Fuzzy-match a weapon name from an array of weapon objects [{name}].
 */
function findWeapon(query, weapons) {
  if (!weapons || weapons.length === 0) return null;
  if (!query) return weapons[0].name;
  let best = null;
  let bestScore = 0;
  for (const w of weapons) {
    const score = fuzzyScore(query, w.name);
    if (score > bestScore) {
      bestScore = score;
      best = w.name;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * Fuzzy-match a spell name from an array of spell objects [{name}].
 */
function findSpell(query, spells) {
  if (!spells || spells.length === 0) return null;
  if (!query) return spells[0].name;
  let best = null;
  let bestScore = 0;
  for (const s of spells) {
    const score = fuzzyScore(query, s.name);
    if (score > bestScore) {
      bestScore = score;
      best = s.name;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * Find the first healing spell from a spells array.
 * Heuristic: spell name contains "heal", "cure", "mend", "restore".
 */
function findHealingSpell(spells) {
  if (!spells || spells.length === 0) return null;
  const healWords = ['heal', 'cure', 'mend', 'restore'];
  for (const s of spells) {
    const n = s.name.toLowerCase();
    if (healWords.some(w => n.includes(w))) return s.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Strip emoji prefix from option strings
// ---------------------------------------------------------------------------

function stripEmoji(str) {
  // Remove leading emoji characters and whitespace
  return str.replace(/^[\p{Emoji}\s]+/u, '').trim();
}

// ---------------------------------------------------------------------------
// parseAction
// ---------------------------------------------------------------------------

/**
 * Tier 1 pattern-matching action parser.
 * @param {string} input
 * @param {string} playerId
 * @param {object} ctx  { combatants, preTaggedOptions }
 * @returns {object|null} structured action or null
 */
function parseAction(input, playerId, ctx) {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim();
  const lower = raw.toLowerCase();
  const combatants = ctx.combatants || {};
  const preTaggedOptions = ctx.preTaggedOptions || null;
  const player = combatants[playerId] || {};
  const weapons = player.weapons || [];
  const spells = player.spells || [];

  // --- 1. Option numbers ---
  if (preTaggedOptions && /^[123]$/.test(raw)) {
    const idx = parseInt(raw, 10) - 1;
    const option = preTaggedOptions[idx];
    if (option) {
      return { ...option, attackerId: playerId };
    }
  }

  // --- 2. Simple actions ---
  const simpleActions = ['dodge', 'disengage', 'dash', 'help'];
  for (const action of simpleActions) {
    if (lower === action || lower.startsWith(action + ' ')) {
      return { type: action, attackerId: playerId };
    }
  }

  // --- 3. Attack with weapon: "attack/strike/hit/slash/stab <target> with <weapon>" ---
  const attackWithWeaponRe = /^(?:attack|strike|hit|slash|stab)\s+(.+?)\s+with\s+(.+)$/i;
  const awm = raw.match(attackWithWeaponRe);
  if (awm) {
    const targetQuery = awm[1].trim();
    const weaponQuery = awm[2].trim();
    const targetId = findCombatantId(targetQuery, combatants, 'Enemy');
    const weapon = findWeapon(weaponQuery, weapons) || findWeapon(null, weapons);
    return { type: 'attack', attackerId: playerId, targetId, weapon };
  }

  // --- 4. Attack (no weapon): "attack/strike/hit/slash/stab <target>" ---
  const attackRe = /^(?:attack|strike|hit|slash|stab)\s+(.+)$/i;
  const am = raw.match(attackRe);
  if (am) {
    const targetQuery = am[1].trim();
    const targetId = findCombatantId(targetQuery, combatants, 'Enemy');
    const weapon = weapons.length > 0 ? weapons[0].name : null;
    return { type: 'attack', attackerId: playerId, targetId, weapon };
  }

  // --- 5. Cast on target: "cast <spell> on/at <target>" ---
  const castOnRe = /^cast\s+(.+?)\s+(?:on|at)\s+(.+)$/i;
  const com = raw.match(castOnRe);
  if (com) {
    const spellQuery = com[1].trim();
    const targetQuery = com[2].trim();
    const spell = findSpell(spellQuery, spells);
    const targetId = findCombatantId(targetQuery, combatants, 'Enemy');
    return { type: 'spell', attackerId: playerId, spell, targetId };
  }

  // --- 6. Cast (self): "cast <spell>" ---
  const castRe = /^cast\s+(.+)$/i;
  const cm = raw.match(castRe);
  if (cm) {
    const spellQuery = cm[1].trim();
    const spell = findSpell(spellQuery, spells);
    return { type: 'spell', attackerId: playerId, spell, targetId: playerId };
  }

  // --- 7. Heal: "heal <target>" ---
  const healRe = /^heal\s+(.+)$/i;
  const hm = raw.match(healRe);
  if (hm) {
    const targetQuery = hm[1].trim();
    const targetId = findCombatantId(targetQuery, combatants) || playerId;
    const spell = findHealingSpell(spells);
    return { type: 'spell', attackerId: playerId, spell, targetId };
  }

  // --- 8. Unparseable ---
  return null;
}

// ---------------------------------------------------------------------------
// parseOptions
// ---------------------------------------------------------------------------

/**
 * Parse an array of 3 AI-generated option strings into tagged actions.
 * @param {string[]} options  Array of 3 option strings
 * @param {string}   playerId
 * @param {object}   ctx
 * @returns {Array}  Array of 3 parsed actions (some may be null)
 */
function parseOptions(options, playerId, ctx) {
  const combatants = ctx.combatants || {};
  const player = combatants[playerId] || {};
  const weapons = player.weapons || [];
  const spells = player.spells || [];

  return options.map(opt => {
    if (!opt) return null;
    // Strip emoji prefix
    const clean = stripEmoji(opt);

    // Try parseAction first
    const parsed = parseAction(clean, playerId, { ...ctx, preTaggedOptions: null });
    if (parsed) return parsed;

    // Fallback heuristics
    const lower = clean.toLowerCase();

    if (/dodge|defend|shield/.test(lower)) {
      return { type: 'dodge', attackerId: playerId };
    }
    if (/attack|strike|slash/.test(lower)) {
      const targetId = firstEnemyId(combatants);
      const weapon = weapons.length > 0 ? weapons[0].name : null;
      return { type: 'attack', attackerId: playerId, targetId, weapon };
    }
    if (/cast|spell|magic/.test(lower)) {
      const spell = spells.length > 0 ? spells[0].name : null;
      const targetId = firstEnemyId(combatants) || playerId;
      return { type: 'spell', attackerId: playerId, spell, targetId };
    }

    return null;
  });
}

// ---------------------------------------------------------------------------
// parseActionWithAI
// ---------------------------------------------------------------------------

/**
 * Tier 2 AI-assisted action parser using Haiku.
 * @param {string} input
 * @param {string} playerId
 * @param {object} ctx
 * @param {object} anthropic  Anthropic SDK instance
 * @returns {Promise<object>} parsed action (never null — has fallback)
 */
async function parseActionWithAI(input, playerId, ctx, anthropic) {
  const combatants = ctx.combatants || {};
  const player = combatants[playerId] || {};
  const weapons = (player.weapons || []).map(w => w.name);
  const spells = (player.spells || []).map(s => s.name);
  const enemies = Object.values(combatants)
    .filter(c => c.type === 'Enemy')
    .map(c => ({ id: c.id, name: c.name }));
  const allies = Object.values(combatants)
    .filter(c => c.id !== playerId && c.type !== 'Enemy')
    .map(c => ({ id: c.id, name: c.name }));

  const prompt = `You are a D&D combat assistant. Parse the player's action into JSON.

Player "${playerId}" wants to: "${input}"

Available weapons: ${weapons.length ? weapons.join(', ') : 'none'}
Available spells: ${spells.length ? spells.join(', ') : 'none'}
Enemies: ${enemies.map(e => `${e.name} (id: ${e.id})`).join(', ') || 'none'}
Allies: ${allies.map(a => `${a.name} (id: ${a.id})`).join(', ') || 'none'}

Respond with ONLY valid JSON (no markdown, no explanation):
{"type":"attack"|"spell"|"dodge"|"disengage"|"dash"|"help","targetId":"id or null","weapon":"name or null","spell":"name or null","notes":"brief description"}`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text.trim();
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        type: parsed.type || 'attack',
        attackerId: playerId,
        targetId: parsed.targetId || null,
        weapon: parsed.weapon || null,
        spell: parsed.spell || null,
        notes: parsed.notes || null,
      };
    }
  } catch (_err) {
    // Fall through to default
  }

  // Fallback: attack first enemy with first weapon
  const targetId = firstEnemyId(combatants);
  const weapon = (player.weapons || [])[0]?.name || null;
  return { type: 'attack', attackerId: playerId, targetId, weapon, spell: null };
}

// ---------------------------------------------------------------------------
// parseOptionsWithAI
// ---------------------------------------------------------------------------

/**
 * AI-powered option parsing — one Haiku call for all 3 options.
 * @param {string[]} options  Array of 3 option strings
 * @param {string}   playerId
 * @param {object}   ctx
 * @param {object}   anthropic  Anthropic SDK instance
 * @returns {Promise<Array>} Array of 3 parsed actions
 */
async function parseOptionsWithAI(options, playerId, ctx, anthropic) {
  const combatants = ctx.combatants || {};
  const player = combatants[playerId] || {};
  const weapons = (player.weapons || []).map(w => w.name);
  const spells = (player.spells || []).map(s => s.name);
  const enemies = Object.values(combatants)
    .filter(c => c.type === 'Enemy')
    .map(c => ({ id: c.id, name: c.name }));
  const allies = Object.values(combatants)
    .filter(c => c.id !== playerId && c.type !== 'Enemy')
    .map(c => ({ id: c.id, name: c.name }));

  const optionsList = options
    .map((o, i) => `${i + 1}. "${stripEmoji(o || '')}"`)
    .join('\n');

  const prompt = `You are a D&D combat assistant. Parse each option into JSON.

Player "${playerId}" has these 3 options:
${optionsList}

Available weapons: ${weapons.length ? weapons.join(', ') : 'none'}
Available spells: ${spells.length ? spells.join(', ') : 'none'}
Enemies: ${enemies.map(e => `${e.name} (id: ${e.id})`).join(', ') || 'none'}
Allies: ${allies.map(a => `${a.name} (id: ${a.id})`).join(', ') || 'none'}

Respond with ONLY a JSON array of 3 objects (no markdown, no explanation):
[
  {"type":"attack"|"spell"|"dodge"|"disengage"|"dash"|"help","targetId":"id or null","weapon":"name or null","spell":"name or null"},
  {"type":...},
  {"type":...}
]`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed) && parsed.length === 3) {
        return parsed.map(p => ({
          type: p.type || 'attack',
          attackerId: playerId,
          targetId: p.targetId || null,
          weapon: p.weapon || null,
          spell: p.spell || null,
        }));
      }
    }
  } catch (_err) {
    // Fall through to fallback
  }

  // Fallback: parse each option individually
  return options.map(opt => {
    const clean = stripEmoji(opt || '');
    return parseAction(clean, playerId, { ...ctx, preTaggedOptions: null }) ||
      { type: 'attack', attackerId: playerId, targetId: firstEnemyId(combatants), weapon: (player.weapons || [])[0]?.name || null, spell: null };
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { parseAction, parseOptions, parseActionWithAI, parseOptionsWithAI };
