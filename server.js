const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const Together = require('together-ai');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const cookieParser = require('cookie-parser');
const passport = require('passport');
const db = require('./db');
const discord = require('./discord-bot');
const { MapGraph, processMapHint } = require('./map-engine');
const { router: authRouter, authMiddleware, requireAuth, requireAdmin } = require('./auth');
const { BillingTicker } = require('./billing');
const payments = require('./payments');
const CombatEngine = require('./combat-engine');
const { parseAction, parseOptions, parseActionWithAI, parseOptionsWithAI } = require('./action-parser');
const { parseStatsText } = require('./stat-parser');
const { getMonsterStats } = require('./monster-lookup');

const DEPLOY_TIME = new Date().toISOString();

function truncate(str, max) { return str ? String(str).slice(0, max) : ''; }

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Stripe webhook must come BEFORE express.json() to receive raw body
app.post('/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const result = await payments.handleWebhook(req.body, req.headers['stripe-signature']);
      res.json(result);
    } catch (err) {
      console.error('Webhook error:', err.message);
      res.status(400).json({ error: err.message });
    }
  }
);

app.use(express.json());
app.use(cookieParser());
app.use(passport.initialize());
app.use(authRouter);
app.use(authMiddleware); // Attaches req.user to all requests (non-blocking)
// Landing page at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Lobby (was previously served as index.html at root)
app.get('/lobby', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/help', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'help.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const together = new Together({ apiKey: process.env.TOGETHER_API_KEY });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'), false);
    }
  },
});

const billingTicker = new BillingTicker(io, db);

const DEFAULT_TURN_DURATION = 180; // seconds
const IMAGE_COOLDOWN = 2;
const MAX_CONTEXT_CHARS = 50000;

// ── Per-game in-memory state ─────────────────────────────────────────────────
const games = {}; // gameId -> { data, turnTimer, turnCount, imageUrl }

function getGameState(gameId) {
  if (!games[gameId]) {
    games[gameId] = {
      data: { characters: {}, chatHistory: [], currentTurnIndex: 0, turnOrder: [] },
      turnTimer: null,
      turnCount: 0,
      imageUrl: null,
      turnDuration: DEFAULT_TURN_DURATION,
      verbosity: 'verbose',
      ferocity: 5,
      pillars: { exploration: 33, combat: 33, social: 34 },
      lastOptions: [],
      lastForPlayer: null,
      idleTurns: 0,
      paused: false,
      mapGraph: new MapGraph(),
      dmPersona: 'epic',
      combatEngine: new CombatEngine(),
      preTaggedOptions: null,
    };
  }
  return games[gameId];
}

// ── Broadcast helpers (Socket.io + Discord) ──────────────────────────────────
function emitDmMessage(gameId, data) {
  // Save last options for reconnects
  const gs = games[gameId];
  if (gs && data.options?.length) {
    gs.lastOptions = data.options;
    gs.lastForPlayer = data.forPlayer;
  }
  io.to(gameId).emit('dm_message', data);
  discord.onDmMessage(gameId, data).catch(e => console.error('Discord dm_message error:', e.message));
}
function emitTurnChange(gameId, data) {
  io.to(gameId).emit('turn_change', data);
  discord.onTurnChange(gameId, data).catch(e => console.error('Discord turn_change error:', e.message));
}
function emitSystem(gameId, data) {
  io.to(gameId).emit('system', data);
  discord.onSystem(gameId, data).catch(e => console.error('Discord system error:', e.message));
}
function emitSceneImage(gameId, data) {
  io.to(gameId).emit('scene_image', data);
  discord.onSceneImage(gameId, data).catch(e => console.error('Discord scene_image error:', e.message));
}
function emitCharacterToken(gameId, data) {
  io.to(gameId).emit('character_token', data);
  discord.onCharacterToken(gameId, data).catch(e => console.error('Discord token error:', e.message));
}

// ── System Prompts per Game System ───────────────────────────────────────────
const SYSTEM_PROMPTS = {
  dnd5e: `You are the Dungeon Master for a live multiplayer Dungeons & Dragons 5th Edition game.`,
  runequest: `You are the Game Master for a live multiplayer RuneQuest: Roleplaying in Glorantha game.
Use RuneQuest rules: percentile-based skill checks (roll under skill%), Rune magic, Spirit magic, Hit Locations, Strike Ranks.
Combat uses Strike Rank initiative. Damage applies to specific hit locations with armor reducing damage.
Passions (Love, Hate, Honor, Loyalty, Devotion) can augment skill rolls.
Rune affinities (Air, Earth, Fire/Sky, Water, Darkness, Moon) influence magic and personality.`,
  custom: `You are the Game Master for a live multiplayer tabletop RPG session.`,
};

function buildSystemPrompt(gameId, gameConfig) {
  const gs = getGameState(gameId);
  const gd = gs.data;

  const characterBlock = Object.entries(gd.characters)
    .map(([name, c]) => {
      const catchphrases = c.catchphrases?.length
        ? `Catchphrases (use sparingly, max 1-2 per day): ${c.catchphrases.join('; ')}`
        : '';
      return `
Player: ${name}
${c.statsText || 'No stats provided'}
Personality: ${c.personality || 'Not specified'}
Standard Actions: ${c.standardActions || 'None defined'}
Backstory: ${c.backstory || 'Unknown'}
${catchphrases}
      `.trim();
    })
    .join('\n\n');

  const basePrompt = SYSTEM_PROMPTS[gameConfig.system] || SYSTEM_PROMPTS.custom;

  let contextBlock = '';
  if (gameConfig.custom_context) {
    contextBlock = `\n\nCAMPAIGN SOURCE MATERIAL:\n${gameConfig.custom_context.slice(0, MAX_CONTEXT_CHARS)}`;
    if (gameConfig.custom_context.length > MAX_CONTEXT_CHARS) {
      contextBlock += '\n[...truncated — source material exceeds limit]';
    }
  }

  const rulesCorrections = gs.rulesCorrections || [];
  const houseRules = rulesCorrections.length
    ? `\nHOUSE RULES & CORRECTIONS (follow strictly):\n${rulesCorrections.map(r => '- ' + r.text).join('\n')}\n`
    : '';

  const personaBlock = gs.dmPersona === 'overthetop'
    ? `DM PERSONA: OVER THE TOP
You are a wildly entertaining DM who lives for the chaos. Channel the energy of Critical Role's most unhinged moments. Every NPC has a ridiculous personality quirk — the bartender who whispers everything, the dragon who's going through a midlife crisis, the skeleton who just wants to be left alone. Break the fourth wall occasionally. React to player choices with genuine surprise and delight ("You want to WHAT?!"). Narrate combat like an action movie director on caffeine. Physical comedy, pratfalls, and absurd coincidences are your bread and butter. Monsters negotiate, panic, monologue, and have existential crises mid-combat. Pop culture references are welcome. Running gags and catchphrases should emerge naturally. NPCs bicker with each other. Accents are described ("speaks in a thick dwarven accent that sounds suspiciously like a Brooklyn cab driver"). Every scene should have at least one moment that makes players laugh. The stakes are still real — comedy comes from character, not from undermining the story.`
    : `DM PERSONA: EPIC
You are a master storyteller in the tradition of great fantasy literature. Your narration is dramatic, atmospheric, and emotionally resonant. Prose is tight and evocative. NPCs feel real and grounded. Combat is visceral and consequential. The world has weight and history. Humor emerges naturally from character and situation, never forced. You take the world seriously even when players don't.`;

  const summary = gs.storySummary ? `\nSTORY SO FAR:\n${gs.storySummary}\n` : '';

  return `${basePrompt}
${contextBlock}
${houseRules}
${personaBlock}

CHARACTERS IN THIS CAMPAIGN:
${characterBlock || 'No characters registered yet.'}
${summary}
VERBOSITY: ${gs.verbosity || 'verbose'}
${gs.verbosity === 'terse' ? 'ABSOLUTE WORD LIMIT: 20 words MAXIMUM for narration. TWO SENTENCES MAX. No descriptions of environment, atmosphere, or sensory details. State only what happens mechanically. Example: "Brother Thornwick casts Light on a stone and descends the ladder. The sewer tunnel branches three ways."' :
  gs.verbosity === 'brief' ? 'STRICT WORD LIMIT: 50 words maximum for narration (excluding game mechanics). Be punchy and direct.' :
  'STRICT WORD LIMIT: Your narration text (excluding dice rolls, game mechanics, and skill checks) must be 100 words or fewer. Count your words. If you\'re over 100 non-mechanic words, you\'ve written too much. Aim for 50-75 words. Only exceed 100 for major plot revelations.'}

FEROCITY: ${gs.ferocity ?? 5}/5
${gs.ferocity <= 1 ? '- Encounters are EXTREMELY deadly. Enemies are powerful, numerous, and tactically smart. Death is likely without clever play. However, treasure rewards are VERY generous — rare magic items, large gold hoards, and powerful artifacts appear frequently.' :
  gs.ferocity <= 2 ? '- Encounters are very dangerous. Enemies hit hard and use tactics. Survival requires good decisions. Treasure is generous — good magic items and substantial gold.' :
  gs.ferocity <= 3 ? '- Encounters are moderately challenging. A balanced mix of danger and reward. Standard treasure for the party level with occasional magic items.' :
  gs.ferocity <= 4 ? '- Encounters are light challenges. Enemies are beatable without much risk. Modest treasure rewards.' :
  '- Encounters are easy and forgiving. Enemies are weak or few. Minimal treasure — mostly coins and mundane items.'}

ENCOUNTER PACING & RESOURCES:
${gs.ferocity <= 1 ? `- PACING (Deadly): 4-6 encounters per short rest. Short rest only after 3+ encounters. Long rest after 6-8 total encounters in an adventuring day. Encounters escalate sharply through the day: easy → medium → hard → deadly boss. The hardest encounter comes near the end of the adventuring day.` :
  gs.ferocity <= 2 ? `- PACING (Dangerous): 3-5 encounters per short rest. Short rest after 3+ encounters. Long rest after 6-7 total encounters in an adventuring day. Encounters escalate through the day: easy → medium → hard → boss. The hardest encounter comes near the end of the adventuring day.` :
  gs.ferocity <= 3 ? `- PACING (Balanced): 3-4 encounters per short rest. Short rest after 3 encounters. Long rest after 5-6 total encounters in an adventuring day. Moderate escalation with the boss or hardest encounter later in the day.` :
  gs.ferocity <= 4 ? `- PACING (Light): 2-3 encounters per short rest. Short rest after 2-3 encounters. Long rest after 4-5 total encounters in an adventuring day. Mostly flat difficulty with occasional spikes. Boss encounter still comes later in the day.` :
  `- PACING (Easy): 1-2 encounters per short rest. Short rest after every 2 encounters. Long rest after 3-4 total encounters in an adventuring day. Flat difficulty with rare spikes. Boss encounter, if any, comes at the narrative climax.`}
- RESOURCE TRACKING:
${gameConfig.system === 'runequest' ?
  `  * Track Rune Points, Magic Points, POW, and any single-use magical items (bound spirits, crystals, matrices with charges).
  * Do NOT track mundane items like food, arrows, or basic supplies unless scarcity is a plot point.` :
  `  * Track spell slots, HP, hit dice, and consumable MAGIC items (potions of healing, scrolls, wands with charges).
  * Do NOT track mundane items like arrows, rations, torches, or basic supplies unless scarcity is a plot point.`}
- REST MECHANICS:
  * Offer rests when resources are depleted ("You could make camp here..." or "There's a sheltered alcove ahead...").
  * Allow players to request rests anytime but with consequences: wandering monsters, time pressure, NPCs getting away, plot advancing without them.
  * Give natural rests at narrative breaks: returning to town, chapter endings, safe havens, after a major victory.
  * Mix all three approaches — proactive offers, player-requested with consequences, and narrative rests.
- SKILL & SOCIAL CHALLENGES:
  * Simple checks (single DC roll) for minor obstacles.
  * Multi-roll skill challenges (X successes before Y failures, multiple players contribute) for major obstacles like navigating a trapped corridor, negotiating a peace treaty, or infiltrating a stronghold.
  * IMPORTANT: Skill and social challenge failures MUST have MECHANICAL consequences — deplete hit points or spell slots as a proxy for the impact of failure (exhaustion, psychic damage, wasted resources).
  * Skill/social outcomes can grant advantages or disadvantages in following combat: successful negotiation = fewer enemies, failed stealth = enemies are prepared and get a surprise round, etc.
- TENSION ESCALATION:
${gs.ferocity <= 2 ? `  * High ferocity: encounters escalate through the adventuring day (easy → medium → hard → boss). Each encounter should feel more dangerous than the last, with resources dwindling.` :
  gs.ferocity <= 4 ? `  * Moderate ferocity: mostly consistent difficulty with a harder encounter or two mixed in. Boss or hardest encounter later in the day.` :
  `  * Low ferocity: flat difficulty throughout. Occasional spikes for dramatic moments. Boss encounter at the narrative climax if at all.`}
- TREASURE & LOOT (scaled by ferocity):
${gs.ferocity <= 1 ? `  * Very generous: rare magic items, large gold hoards, powerful artifacts after boss fights. ~1 uncommon magic item per session, rare items every 2-3 sessions.` :
  gs.ferocity <= 2 ? `  * Generous: good magic items and substantial gold. ~1 uncommon magic item per 1-2 sessions.` :
  gs.ferocity <= 3 ? `  * Standard: published module treasure tables. ~1 uncommon magic item per 2-3 sessions.` :
  gs.ferocity <= 4 ? `  * Modest: mostly coins with occasional uncommon magic items. ~1 uncommon per 3-4 sessions.` :
  `  * Minimal: mostly coins and mundane items. Uncommon magic items are rare treats.`}
  * Consumable magic items (potions, scrolls) should appear more frequently than permanent magic items.
- ADVANCEMENT:
${gameConfig.system === 'runequest' ?
  `  * After each session, prompt skill improvement rolls for skills used during play. POW gain rolls after overcoming spiritual challenges.
  * Track skill percentages in CHAR_UPDATES. When a skill increases, announce with 🎉 and include updated stats.` :
gameConfig.system === 'dnd5e' ?
  `  * Award XP after combat (based on monster CR), after quest completion, and for clever roleplay.
  * Use milestone advancement — announce level-ups at narratively appropriate moments rather than strict XP counting.
  * Track XP in CHAR_UPDATES. When a character levels up, announce with 🎉 and include full updated stats in CHAR_UPDATES and ACCOMPLISHMENTS.` :
  `  * Follow the system's advancement mechanic. If unknown, use milestone advancement.
  * When a character advances, announce with 🎉 and include updated stats in CHAR_UPDATES and ACCOMPLISHMENTS.`}
- SYSTEM ADAPTATION:
${gameConfig.system === 'runequest' ?
  `  * Use "scenes" instead of "encounters" for pacing. POW/Rune Point/Magic Point depletion replaces spell slots. Check RuneQuest-specific pacing guidelines.` :
gameConfig.system === 'dnd5e' ?
  `  * Use standard D&D 5e adventuring day: encounter difficulty, spell slots, hit dice, short/long rest recovery.` :
  `  * Adapt the challenge → rest cycle to this system's resource economy. Use the system's native terms for rests, resources, and recovery.`}
- PILLAR DISTRIBUTION: Adhere loosely to the pillar weightings below, but be guided by the narrative arc. Try to catch up on the average distribution every two in-game days. Don't force it — let the story flow naturally.

THREE PILLARS OF PLAY (target weighting):
- Exploration: ${gs.pillars?.exploration ?? 33}% | Combat: ${gs.pillars?.combat ?? 33}% | Social: ${gs.pillars?.social ?? 34}%
- Over the course of a session, aim for this ratio. If one pillar has been neglected, steer towards it.
- Each pillar should involve meaningful challenges that test character skills:
  * Exploration: perception, survival, investigation, knowledge checks, traps, puzzles, navigation
  * Combat: attack rolls, saving throws, tactical positioning, damage, conditions, initiative
  * Social: persuasion, intimidation, deception, insight, diplomacy, bargaining, interrogation

SKILL TEST PACING:
- CRITICAL: Include a skill test, ability check, or game mechanic roll with MOST character actions — at minimum every other action.
- If two consecutive turns pass without any dice roll or skill check, the pace is too slow. Introduce a challenge, obstacle, or situation that demands a roll.
- Skill tests drive advancement. Without them, characters don't grow. Make tests feel natural and consequential.
- If characters are wandering or stalling, gently push the action forward: an NPC interrupts, a sound is heard, a danger emerges, a clue appears.

RULES:
- Track HP, conditions, spells, powers, and resources accurately. Apply game rules correctly.
- When acting for an absent player, weigh their standard actions and personality heavily, but adapt to context.
- Keep the story moving. If players seem stuck, nudge them forward.
- If campaign source material is provided above, use it to guide the adventure, encounters, NPCs, and lore.
- Encourage banter between player characters and between PCs and NPCs. Have NPCs react to players with personality — tease, joke, challenge, flirt, argue. Make the world feel alive through dialogue.
- If a character has catchphrases listed, weave them naturally into narration or dialogue SPARINGLY — at most 1-2 times per real-world day across all turns. Don't force them; use them when the moment fits.

SPELLS, POWERS & RESOURCES:
- Track all spells, powers, abilities, and limited-use resources for each character.
- When a spell/power is cast or used, note the expenditure. When rested or restored, note the recovery.
- Include current spell slots, power points, rune points, or whatever the system uses in character updates.
- If a character tries to use a spent resource, inform them it's unavailable.

TREASURE & LOOT:
- When encounters include treasure, distribute it as a published module would — a mix of coins, mundane items, and occasional magical items appropriate to the party's level/power.
- Magical items should be rare and exciting. Mundane treasure should be realistic for the setting.
- Always announce treasure clearly so players can divide it.

CHARACTER ADVANCEMENT:
- Track experience points (D&D 5e), skill improvement rolls (RuneQuest), or whatever advancement mechanic the system uses.
- Award XP/advancement after combat, quest completion, and clever roleplay as the system specifies.
- When a character reaches a level-up threshold or earns a skill increase:
  1. Announce it prominently: "🎉 [NAME] has leveled up to Level X!" or "🎉 [NAME]'s Sword skill increases to 80%!"
  2. Include the full updated stats in CHAR_UPDATES
  3. Add the advancement to ACCOMPLISHMENTS

LEVEL-UP CHOICES:
- When a character levels up, CHECK the game system for level-specific choices:
  * D&D 5e: Ability Score Improvement (ASI) at levels 4, 8, 12, 16, 19 — ask player to choose +2 to one ability or +1 to two abilities, OR a feat
  * D&D 5e: Subclass choice at level 3 (and sometimes 1 or 2 depending on class)
  * D&D 5e: Class-specific choices (Fighting Style, Eldritch Invocations, Metamagic, etc.)
  * D&D 5e: Spell selection for prepared/known casters at each level
  * RuneQuest: Rune affinity choices, cult advancement, new Rune spells
- PAUSE and ask the player for their choice before applying the level-up. Use a clear format:
  "🎉 [NAME] reaches Level [X]! You need to make these choices:
   1. [Choice description — e.g., 'Ability Score Improvement: +2 to one ability, +1 to two, or choose a feat']
   2. [Choice description — e.g., 'Choose a new 3rd-level spell']
   Use /ooc or type your choices."
- Do NOT auto-assign ability scores, subclasses, feats, or spells. Always ask the player.
- Once the player responds (in-character or via /ooc), apply the choices and update the character sheet via CHAR_UPDATES.

COMBAT:
- Run combat with proper initiative, attack rolls, damage, and tactical options.
- When a significant enemy is defeated (boss, tough monster, named NPC), include a special scene description:
  Put "KILLSHOT:" before the scene description to trigger a dramatic illustration.
  Example: KILLSHOT: Kael drives his flaming sword through the dragon's chest as lightning crackles around them, the beast collapsing in a shower of sparks

INITIATIVE / TURN ORDER:
- During combat, output a turn order using the appropriate game system (D&D 5e: initiative rolls, RuneQuest: strike ranks).
- Include monsters/NPCs in the turn order.
- Use this format in the ---WORLD--- block:

ENEMIES (include when hostile creatures initiate combat):
- [Display Name] | [count] | [monster-db-slug]
For custom: - [Name] | [count] | custom | [hint]

TURN_ORDER:
- 1 | Judge | 18 | PC
- 2 | Goblin Archer | 15 | Enemy
- 3 | Sir Ethilrist | 12 | PC
- 4 | Goblin Chief | 8 | Enemy

Format: position | name | initiative/SR value | type (PC/Enemy/NPC)
- Update this every round. Remove dead combatants.
- Outside of combat, omit the TURN_ORDER block entirely.

WRITING STYLE:
- Write narration as flowing prose PARAGRAPHS. Multiple sentences per paragraph. Do NOT put each sentence on its own line.
- Do NOT use markdown headers (# or ##) in narration. No section labels. Just prose.
- Be mechanically accurate. A cantrip is a simple attack, not an explosion. A shortsword strike doesn't cause shockwaves. Scale descriptions to the actual spell/action level.
- Combine attack roll + damage + result on ONE line: "**🎲 Fire Bolt (INT +2, Prof +2) — rolls 19. HIT! 1d10 = 7 fire damage. Captain wounded (HP ~13/20)**"
- Use "HIT" or "MISS" (caps) so the client can color-code them.
- Follow the dice roll line with 1-2 sentences of narration describing the result. That's it.

ACTION OPTIONS:
- At the end of EVERY response (except auto-actions), present exactly 3 action choices for the next player.
- Use this EXACT format with NUMBER EMOJIS (1️⃣ 2️⃣ 3️⃣) as delimiters:

---OPTIONS---
1️⃣ 🗡️ [a combat or practical action]
2️⃣ 🛡️ [a defensive or cautious action]
3️⃣ 🔥 [a wild, reckless, or creative move]

TRAVEL & MOVEMENT:
- Narrate journeys realistically with distance, terrain, mode of travel.
- Multi-turn travel may involve encounters. "Go directly to [location]" fast-forwards.

OUTPUT FORMAT (use this EXACT order at the end of every response):

---OPTIONS---
1. 🗡️ [a combat or practical action]
2. 🛡️ [a defensive or cautious action]
3. 🔥 [a wild, reckless, or creative move]
4. 💬 [a witty comment, taunt, or clever social move]

---SCENE---
ACTION: [what's physically happening right now - 5-10 words]
MOOD: [1-3 words - e.g., tense, triumphant, eerie]
NPC: [name of any NPC in the scene, or "none"]

---WORLD---
LOCATIONS:
- [Location Name] | [Brief description] | [Distance/travel time from current position]
NPCS:
- [NPC Name] | [Brief description] | [Current/last known location]

IMAGE DESCRIPTIONS:
- When introducing a NEW location or NPC for the first time, include an image description field.
- Use this format in the LOCATIONS and NPCS sections:

LOCATIONS:
- [Name] | [Description] | [Distance] | IMG: [One sentence visual description for image generation — setting, lighting, architecture, mood. Painterly fantasy style.]

NPCS:
- [Name] | [Description] | [Location] | IMG: [One sentence visual description — appearance, clothing, expression, distinguishing features. Portrait style.]

- Only include IMG: on the FIRST appearance or when the location/NPC fundamentally changes (destroyed, rebuilt, scarred, transformed, etc.).
- If a location or NPC changes significantly, include IMG: with the UPDATED description and add "UPDATED:" prefix: IMG: UPDATED: [new description reflecting the change]

ACCOMPLISHMENTS:
- [Character Name] | [Achievement description]
CHAR_UPDATES:
- [Character Name] | [field] | [new value]

MAP: [Current location name — where the party is RIGHT NOW after this turn's action]

Valid fields: statsText, personality, backstory, standardActions
Include CHAR_UPDATES whenever: leveling up, gaining items, learning spells, stat changes, spell slot usage/recovery, skill improvements.

Only include ACCOMPLISHMENTS entries if something new was accomplished this turn. Only include CHAR_UPDATES if a character changed. Always include LOCATIONS, NPCS, and MAP.`;
}

function buildTrimmedPrompt(gameId, gameConfig) {
  const gs = getGameState(gameId);
  const gd = gs.data;

  const characterBlock = Object.entries(gd.characters)
    .map(([name, c]) => {
      const catchphrases = c.catchphrases?.length
        ? `Catchphrases (use sparingly, max 1-2 per day): ${c.catchphrases.join('; ')}`
        : '';
      return `
Player: ${name}
${c.statsText || 'No stats provided'}
Personality: ${c.personality || 'Not specified'}
Standard Actions: ${c.standardActions || 'None defined'}
Backstory: ${c.backstory || 'Unknown'}
${catchphrases}
      `.trim();
    })
    .join('\n\n');

  const basePrompt = SYSTEM_PROMPTS[gameConfig.system] || SYSTEM_PROMPTS.custom;

  let contextBlock = '';
  if (gameConfig.custom_context) {
    contextBlock = `\n\nCAMPAIGN SOURCE MATERIAL:\n${gameConfig.custom_context.slice(0, MAX_CONTEXT_CHARS)}`;
    if (gameConfig.custom_context.length > MAX_CONTEXT_CHARS) {
      contextBlock += '\n[...truncated — source material exceeds limit]';
    }
  }

  const rulesCorrections = gs.rulesCorrections || [];
  const houseRules = rulesCorrections.length
    ? `\nHOUSE RULES & CORRECTIONS (follow strictly):\n${rulesCorrections.map(r => '- ' + r.text).join('\n')}\n`
    : '';

  const personaBlock = gs.dmPersona === 'overthetop'
    ? `DM PERSONA: OVER THE TOP — Chaotic, hilarious, Critical Role energy. Ridiculous NPC quirks, fourth wall breaks, action-movie combat narration. Comedy from character, stakes still real.`
    : `DM PERSONA: EPIC — Master storyteller, dramatic and atmospheric. Tight evocative prose, grounded NPCs, visceral combat. World has weight and history.`;

  const summary = gs.storySummary ? `\nSTORY SO FAR:\n${gs.storySummary}\n` : '';

  const verbosityLine = gs.verbosity === 'terse' ? 'ABSOLUTE HARD LIMIT: 20 words narration max. TWO SENTENCES MAX. No atmosphere, no sensory details, no descriptions. Just state what happens. Then structured blocks.' :
    gs.verbosity === 'brief' ? 'ABSOLUTE HARD LIMIT: 50 words narration max. NO section headers. NO ## headings. Prose paragraphs only, then structured blocks.' :
    'WORD LIMIT: 100 words max narration. Aim for 50-75. NO ## headings in narration. Prose paragraphs only.';

  const ferocityLine = `Ferocity: ${gs.ferocity ?? 5}/5 — ${
    gs.ferocity <= 1 ? 'extremely deadly, generous treasure' :
    gs.ferocity <= 2 ? 'very dangerous, good treasure' :
    gs.ferocity <= 3 ? 'balanced encounters, standard treasure' :
    gs.ferocity <= 4 ? 'light challenges, modest treasure' :
    'easy and forgiving, minimal treasure'}`;

  const pillarsLine = `Pillars: E${gs.pillars?.exploration ?? 33}/C${gs.pillars?.combat ?? 33}/S${gs.pillars?.social ?? 34}. Include skill checks every 1-2 actions.`;

  const pacingLine = `PACING: Ferocity ${gs.ferocity ?? 5}/5. ${
    gs.ferocity <= 1 ? '4-6 encounters/short rest, long rest after 6-8.' :
    gs.ferocity <= 2 ? '3-5 encounters/short rest, long rest after 6-7.' :
    gs.ferocity <= 3 ? '3-4 encounters/short rest, long rest after 5-6.' :
    gs.ferocity <= 4 ? '2-3 encounters/short rest, long rest after 4-5.' :
    '1-2 encounters/short rest, long rest after 3-4.'} Track ${
    gameConfig.system === 'runequest' ? 'Rune Points, Magic Points, POW, magic consumables' :
    'spell slots, HP, hit dice, magic consumables'}. Skill failures cost HP/slots. Escalation: ${
    gs.ferocity <= 2 ? 'sharp (easy→hard→boss)' :
    gs.ferocity <= 4 ? 'moderate (flat with boss later)' :
    'flat (rare spikes)'}. Treasure: ${
    gs.ferocity <= 1 ? 'very generous' :
    gs.ferocity <= 2 ? 'generous' :
    gs.ferocity <= 3 ? 'standard' :
    gs.ferocity <= 4 ? 'modest' :
    'minimal'}. Award XP/milestones, announce level-ups with 🎉.
Level-ups: ask player for ALL choices (ASI, subclass, spells, feats) before applying. Never auto-assign.`;

  return `${basePrompt}
${contextBlock}
${houseRules}
${personaBlock}

CHARACTERS IN THIS CAMPAIGN:
${characterBlock || 'No characters registered yet.'}
${summary}
${ferocityLine}
${pillarsLine}
${pacingLine}

Only include ACCOMPLISHMENTS entries if something new was accomplished this turn. Only include CHAR_UPDATES if a character changed. Always include LOCATIONS, NPCS, and MAP.

WRITING STYLE:
- Prose paragraphs only. NO markdown headers (# or ##). NO one-sentence-per-line.
- Be mechanically accurate — scale descriptions to spell/action level.
- Dice: ONE bold line per roll: "**🎲 Fire Bolt (INT +2) — rolls 19. HIT! 1d10 = 7 fire. Captain wounded (HP ~13/20)**"
- Follow dice with 1-2 sentences of result narration. That's it.

MANDATORY OUTPUT (every single response, no exceptions):
After your narration, you MUST include ALL of these blocks in this exact order:

---OPTIONS---
1️⃣ 🗡️ [combat/practical action for the next player]
2️⃣ 🛡️ [defensive/cautious action]
3️⃣ 🔥 [wild/reckless/creative move]

---SCENE---
ACTION: [what's physically happening right now - 5-10 words]
MOOD: [1-3 words - e.g., tense, triumphant, eerie]
NPC: [name of any NPC in the scene, or "none"]

---WORLD---
LOCATIONS:
- [Name] | [Description] | [Distance]
NPCS:
- [Name] | [Description] | [Location]
ENEMIES (when combat starts):
- [Display Name] | [count] | [slug]
MAP: [Current location name]

If you omit ---OPTIONS---, ---SCENE---, or ---WORLD--- the game breaks. NEVER skip ANY of them.

FINAL REMINDER — ${verbosityLine} This overrides everything above including DM persona. Count your words.`;
}

// ── Parsing (single-pass, order-independent) ─────────────────────────────────
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
    // Parse ENEMIES block
    const enemiesMatch = worldRaw.match(/ENEMIES:\n((?:- .+\n?)+)/i);
    let enemies = [];
    if (enemiesMatch) {
      const enemyLines = enemiesMatch[1].trim().split('\n');
      for (const line of enemyLines) {
        const match = line.match(/^-\s*(.+?)\s*\|\s*(\d+)\s*\|\s*(.+?)(?:\s*\|\s*(.+))?$/);
        if (match) {
          enemies.push({
            displayName: match[1].trim(),
            count: parseInt(match[2], 10),
            slug: match[3].trim(),
            hint: match[4]?.trim() || null,
          });
        }
      }
    }
    world = { locations, npcs, accomplishments, charUpdates, turnOrder: turnOrder.length ? turnOrder : undefined };
    if (enemies.length > 0) world.enemies = enemies;
  }

  return { narration, options, scene, world, isKillshot, worldRaw: worldRaw || '' };
}

// ── Combat Lifecycle ─────────────────────────────────────────────────────────
async function initiateCombat(gameId, gameConfig, enemies) {
  const gs = getGameState(gameId);
  const system = gameConfig.system || 'dnd5e';
  const enemyCombatants = [];

  for (const entry of enemies) {
    for (let i = 0; i < entry.count; i++) {
      const stats = await getMonsterStats(gameId, system, entry.slug, {
        db, anthropic, hint: entry.hint,
      });
      if (stats) {
        const id = entry.count > 1 ? `${entry.slug}-${i + 1}` : entry.slug;
        const name = entry.count > 1 ? `${entry.displayName} ${i + 1}` : entry.displayName;
        enemyCombatants.push({ ...stats, id, name, type: 'Enemy' });
      }
    }
  }
  if (enemyCombatants.length === 0) return null;

  const pcCombatants = [];
  for (const [name, char] of Object.entries(gs.data.characters)) {
    let combatStats = char.combatStats;
    if (!combatStats) {
      try {
        combatStats = await parseStatsText(char.statsText || '', system, { anthropic });
        char.combatStats = combatStats;
        db.upsertCharacter(gameId, name, char).catch(() => {});
      } catch (e) {
        console.error(`Failed to parse combatStats for ${name}:`, e.message);
        continue;
      }
    }
    const id = name.toLowerCase().replace(/\s+/g, '-');
    pcCombatants.push({ ...combatStats, id, name, type: 'PC' });
  }

  const state = gs.combatEngine.initCombat(pcCombatants, enemyCombatants, system);
  io.to(gameId).emit('combat_started', {
    initiativeOrder: state.initiativeOrder,
    combatants: Object.fromEntries(
      Object.entries(state.combatants).map(([id, c]) => [id, {
        id, name: c.name, type: c.type,
        hp: c.hp ?? c.totalHp, maxHp: c.maxHp ?? c.totalHp, ac: c.ac,
        conditions: c.conditions || [],
      }])
    ),
    round: state.round,
  });
  emitSystem(gameId, { text: '⚔️ Combat begins!' });
  return state;
}

async function resolveEnemyTurns(gameId, gameConfig) {
  const gs = getGameState(gameId);
  const engine = gs.combatEngine;
  if (!engine.state.active) return [];

  const results = [];
  const resolver = engine.getResolver();

  while (true) {
    const current = engine.getCurrentTurn();
    if (!current || current.type !== 'Enemy') break;
    if (resolver.checkDeath(current).status === 'dead') { engine.advanceTurn(); continue; }

    const availableActions = resolver.getAvailableActions(current);
    const pcs = Object.values(engine.state.combatants).filter(c => c.type === 'PC' && (c.hp > 0 || (c.totalHp && c.totalHp > 0)));

    if (pcs.length === 0) break;

    const tacticalPrompt = `Choose ONE action for ${current.name} (${current.hp ?? current.totalHp}/${current.maxHp ?? current.totalHp} HP).
Reply ONLY: ACTION: ${current.id} [action-type] [target-id]
Can: ${availableActions.slice(0, 6).map(a => a.label).join(', ')}
Targets: ${pcs.map(p => `${p.name}(${p.id},${p.hp ?? p.totalHp}HP${p.concentrating ? ',conc:' + p.concentrating : ''})`).join(', ')}`;

    let actionType = 'attack';
    let targetId = pcs[0]?.id;

    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 80,
        messages: [{ role: 'user', content: tacticalPrompt }],
      });
      const text = response.content[0].text.trim();
      const m = text.match(/ACTION:\s*\S+\s+(\S+)\s+(\S+)/);
      if (m) { actionType = m[1]; targetId = m[2]; }
    } catch (e) {
      console.error('Enemy tactics error:', e.message);
    }

    const weaponName = current.weapons?.[0]?.name;
    const result = engine.resolveAction({
      type: actionType.startsWith('attack') ? 'attack' : actionType,
      attackerId: current.id,
      targetId,
      weapon: weaponName,
    });
    if (result && !result.error) results.push(result);

    if (engine.isCombatOver().over) break;
    engine.advanceTurn();
  }

  return results;
}

function emitCombatUpdate(gameId) {
  const gs = getGameState(gameId);
  const engine = gs.combatEngine;
  if (!engine.state.active) return;
  io.to(gameId).emit('combat_update', {
    round: engine.state.round,
    turnIndex: engine.state.turnIndex,
    currentTurn: engine.getCurrentTurn()?.id,
    combatants: Object.fromEntries(
      Object.entries(engine.state.combatants).map(([id, c]) => [id, {
        id, name: c.name, type: c.type,
        hp: c.hp ?? c.totalHp, maxHp: c.maxHp ?? c.totalHp, ac: c.ac,
        conditions: c.conditions || [], concentrating: c.concentrating || null,
      }])
    ),
    activeEffects: engine.state.activeEffects,
    log: engine.state.log.slice(-10),
  });
}

// ── Character Token Generation ───────────────────────────────────────────────
async function generateCharacterToken(name, charData) {
  if (!process.env.TOGETHER_API_KEY) return null;
  try {
    const desc = [charData.statsText, charData.personality, charData.backstory].filter(Boolean).join('. ');
    // Store visual description for composite scene generation
    charData.visualDesc = desc;
    const prompt = `Fantasy RPG character portrait token, circular frame, dark background. Character: ${name}. ${desc.slice(0, 600)}. Detailed face and upper body, dramatic lighting, painterly style. No text or words.`;
    const response = await together.images.generate({
      model: 'black-forest-labs/FLUX.1-schnell',
      prompt: prompt.slice(0, 1000),
      width: 512,
      height: 512,
      steps: 4,
      n: 1,
      response_format: 'b64_json',
    });
    const b64 = response.data[0]?.b64_json;
    if (!b64) return null;
    return `data:image/png;base64,${b64}`;
  } catch (err) {
    console.error('Token generation failed:', err.message);
    return null;
  }
}

// ── Composite Scene Image Generation (Together AI / FLUX) ─────────────────────
async function generateCompositeScene(gameId, sceneData, gameConfig) {
  if (!process.env.TOGETHER_API_KEY) return null;
  const gs = getGameState(gameId);

  // Global style prefix for consistency
  const stylePrefix = 'Dark fantasy oil painting, dramatic chiaroscuro lighting, muted earth tones with gold accents, highly detailed.';

  // Get current location visual description
  const currentLoc = gs.mapGraph?.playerLocation;
  const locEntry = gs.world?.locations?.find(l => l.name === currentLoc);
  const locDesc = locEntry?.visualDesc || locEntry?.description || '';

  // Get relevant NPC if mentioned in scene — this is the primary subject
  let npcDesc = '';
  let hasNpc = false;
  if (sceneData.npc && sceneData.npc.toLowerCase() !== 'none') {
    const npcEntry = gs.world?.npcs?.find(n => n.name.toLowerCase().includes(sceneData.npc.toLowerCase()));
    npcDesc = npcEntry?.visualDesc || npcEntry?.description || '';
    hasNpc = !!npcDesc;
  }

  // Compose prompt — prioritize scene/NPC/location over player characters
  const parts = [stylePrefix];
  parts.push(`Scene: ${sceneData.action || 'dramatic moment'}`);
  if (sceneData.mood) parts.push(`Mood: ${sceneData.mood}`);
  if (hasNpc) {
    // NPC is the focus — show them prominently
    parts.push(`Focus on this character: ${npcDesc}`);
    if (locDesc) parts.push(`Setting: ${locDesc}`);
  } else if (locDesc) {
    // No NPC — show the location/environment as a wide landscape
    parts.push(`Wide establishing shot of: ${locDesc}`);
  } else {
    // Fallback — show the action as a scene, not a character portrait
    parts.push('Wide cinematic shot showing the full scene, not a close-up portrait');
  }
  parts.push('No text or words in the image.');

  const prompt = parts.join('. ').slice(0, 1000);

  try {
    const response = await together.images.generate({
      model: 'black-forest-labs/FLUX.1-schnell',
      prompt,
      width: 768,
      height: 512,
      steps: 4,
      n: 1,
      response_format: 'b64_json',
    });
    const b64 = response.data[0]?.b64_json;
    if (!b64) return null;
    return `data:image/png;base64,${b64}`;
  } catch (err) {
    console.error('Composite scene failed:', err.message);
    return null;
  }
}

function shouldGenerateImage(gameId, sceneData, mapMoved, isKillshot) {
  if (isKillshot) return true;
  if (mapMoved) return true;
  // Generate if a named NPC is present in the scene
  if (sceneData.npc && sceneData.npc.toLowerCase() !== 'none') return true;
  // Generate every 3rd turn as a baseline (so players always see images)
  const gs = getGameState(gameId);
  if (gs.turnCount > 0 && gs.turnCount % 3 === 0) return true;
  return false;
}

// ── World Art Generation (Together AI / FLUX) ─────────────────────────────────
async function generateWorldArt(gameId, item) {
  if (!process.env.TOGETHER_API_KEY) return;
  const gs = getGameState(gameId);

  const style = item.type === 'npc'
    ? 'Fantasy RPG character portrait, detailed face and upper body, dramatic lighting, painterly style.'
    : 'Fantasy RPG landscape/location, atmospheric lighting, detailed architecture, painterly style.';

  const prompt = `${style} ${item.prompt}. No text or words in the image.`;

  try {
    io.to(gameId).emit('world_art_generating', { type: item.type, name: item.name });

    const response = await together.images.generate({
      model: 'black-forest-labs/FLUX.1-schnell',
      prompt: prompt.slice(0, 1000),
      width: item.type === 'npc' ? 512 : 768,
      height: 512,
      steps: 4,
      n: 1,
      response_format: 'b64_json',
    });

    const b64 = response.data[0]?.b64_json;
    if (!b64) return;

    const imageUrl = `data:image/png;base64,${b64}`;

    // Save to world state
    const list = item.type === 'location' ? gs.world?.locations : gs.world?.npcs;
    const entry = list?.find(e => e.name.toLowerCase() === item.name.toLowerCase());
    if (entry) {
      entry.imageUrl = imageUrl;
      entry.imageState = 'done';
      entry.visualDesc = item.prompt;
      await db.setState(gameId, 'world', gs.world);
    }

    io.to(gameId).emit('world_art_ready', { type: item.type, name: item.name, imageUrl });
    logCost({ gameId, model: 'FLUX', inputTokens: 0, outputTokens: 0, cost: 0.003, type: 'world-art' });

  } catch (err) {
    console.error(`World art generation failed for ${item.name}:`, err.message);
    io.to(gameId).emit('world_art_failed', { type: item.type, name: item.name });
  }
}

// ── Cost Tracking & Rate Limiting ─────────────────────────────────────────────
const MODEL_COSTS = { // per 1M tokens (input/output)
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-4-6': { input: 15.00, output: 75.00 },
};
const IMAGE_COST = 0.003; // per Together AI FLUX image
const costLog = []; // { timestamp, gameId, model, inputTokens, outputTokens, cost, type }

function estimateCost(model, inputTokens, outputTokens) {
  const rates = MODEL_COSTS[model] || MODEL_COSTS['claude-haiku-4-5-20251001'];
  return (inputTokens / 1_000_000 * rates.input) + (outputTokens / 1_000_000 * rates.output);
}

function logCost(entry) {
  costLog.push({ ...entry, timestamp: Date.now() });
  // Keep last 24h
  const cutoff = Date.now() - 86400000;
  while (costLog.length && costLog[0].timestamp < cutoff) costLog.shift();
}

function getCostSummary() {
  const now = Date.now();
  const lastHour = costLog.filter(e => now - e.timestamp < 3600000);
  const last24h = costLog;
  const hourTotal = lastHour.reduce((s, e) => s + (e.cost || 0), 0);
  const dayTotal = last24h.reduce((s, e) => s + (e.cost || 0), 0);
  const hourCalls = lastHour.length;
  const dayCalls = last24h.length;
  // Project hourly rate
  const projected = hourCalls > 0 ? hourTotal : (dayCalls > 0 ? dayTotal / 24 : 0);
  return {
    lastHour: { calls: hourCalls, cost: Math.round(hourTotal * 100) / 100 },
    last24h: { calls: dayCalls, cost: Math.round(dayTotal * 100) / 100 },
    projectedHourly: Math.round(projected * 100) / 100,
    projectedDaily: Math.round(projected * 24 * 100) / 100,
  };
}

const apiCallLog = {}; // gameId -> [timestamps]
const MAX_CALLS_PER_HOUR = 60;

function checkRateLimit(gameId) {
  const now = Date.now();
  if (!apiCallLog[gameId]) apiCallLog[gameId] = [];
  // Prune old entries
  apiCallLog[gameId] = apiCallLog[gameId].filter(t => now - t < 3600000);
  if (apiCallLog[gameId].length >= MAX_CALLS_PER_HOUR) {
    console.error(`Rate limit hit for game ${gameId}: ${apiCallLog[gameId].length} calls in last hour`);
    return false;
  }
  apiCallLog[gameId].push(now);
  return true;
}

// ── Rolling Story Summary ─────────────────────────────────────────────────────
async function refreshStorySummary(gameId, gameConfig) {
  const gs = getGameState(gameId);
  const gd = gs.data;
  const oldMessages = gd.chatHistory.slice(0, -6); // Keep last 6, summarize the rest
  if (oldMessages.length < 4) return; // Not enough to summarize

  const transcript = oldMessages.map(m =>
    m.role === 'user' ? `Player: ${m.content}` : `DM: ${m.content}`
  ).join('\n').slice(0, 3000);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: 'Summarize this RPG session in 150 words. Focus on: current quest, recent events, unresolved tensions, character status. Be concise.',
    messages: [{ role: 'user', content: transcript }],
  });

  const inputTokens = response.usage?.input_tokens || 0;
  const outputTokens = response.usage?.output_tokens || 0;
  logCost({ gameId, model: 'claude-haiku-4-5-20251001', inputTokens, outputTokens,
    cost: estimateCost('claude-haiku-4-5-20251001', inputTokens, outputTokens), type: 'story-summary' });

  gs.storySummary = response.content[0].text;
  // Trim history to just the last 6 messages
  gd.chatHistory = gd.chatHistory.slice(-6);
  await db.saveChatHistory(gameId, gd.chatHistory);
  await db.setState(gameId, 'storySummary', gs.storySummary);
  console.log('Story summary refreshed for', gameId);
}

// ── Claude Call (scoped to a game) ───────────────────────────────────────────
async function callClaude(gameId, gameConfig, userMessage, actingAs = null) {
  // Rate limit check
  if (!checkRateLimit(gameId)) {
    const gs = getGameState(gameId);
    gs.paused = true;
    clearTimeout(gs.turnTimer);
    emitSystem(gameId, { text: '⚠️ Rate limit reached (60 calls/hour). Game paused to prevent runaway costs.' });
    return { narration: 'Game paused — rate limit reached.', options: [], scene: null, world: null, isKillshot: false };
  }

  const gs = getGameState(gameId);
  const gd = gs.data;

  const prefix = actingAs
    ? `[AUTO-ACTION for ${actingAs} — timer expired]\n`
    : '';

  const messages = [
    ...gd.chatHistory,
    { role: 'user', content: prefix + userMessage },
  ];

  const model = 'claude-haiku-4-5-20251001';
  const maxTokens = gs.verbosity === 'terse' ? 400 : gs.verbosity === 'brief' ? 800 : 2500;
  const hasHistory = gd.chatHistory.some(m => m.role === 'assistant');
  const systemPrompt = hasHistory ? buildTrimmedPrompt(gameId, gameConfig) : buildSystemPrompt(gameId, gameConfig);
  const startTime = Date.now();

  // Combat routing — resolve player action + enemy turns before calling Claude
  const combatActive = gs.combatEngine?.state?.active;
  let combatContext = '';

  if (combatActive) {
    const combatCtx = {
      combatants: gs.combatEngine.state.combatants,
      preTaggedOptions: gs.preTaggedOptions || null,
    };
    const currentPlayerName = gs.data.turnOrder[gs.data.currentTurnIndex];
    const playerId = currentPlayerName?.toLowerCase().replace(/\s+/g, '-');
    const actionText = userMessage.replace(/^.*?:\s*/, '');

    let parsedAction = parseAction(actionText, playerId, combatCtx);
    if (!parsedAction) {
      try {
        parsedAction = await parseActionWithAI(actionText, playerId, combatCtx, anthropic);
      } catch (e) { console.error('Action parse AI error:', e.message); }
    }

    if (parsedAction) {
      const playerResult = gs.combatEngine.resolveAction(parsedAction);
      gs.combatEngine.advanceTurn();
      const enemyResults = await resolveEnemyTurns(gameId, gameConfig);
      const allResults = [playerResult, ...enemyResults].filter(Boolean);
      const resultLines = allResults.map(r => gs.combatEngine.formatResultForPrompt(r));

      combatContext = `\n\n${gs.combatEngine.getCombatStateForPrompt()}\n\nRESOLVED THIS ROUND:\n${resultLines.join('\n')}\n\nNarrate these results in your DM persona. It is now ${gs.combatEngine.getCurrentTurn()?.name || 'the next player'}'s turn.`;

      const overCheck = gs.combatEngine.isCombatOver();
      if (overCheck.over) {
        combatContext += `\n\nCOMBAT IS OVER: ${overCheck.reason === 'enemies_defeated' ? 'All enemies defeated. Narrate aftermath and loot.' : 'All PCs are down.'}`;
        gs.combatEngine.endCombat();
        io.to(gameId).emit('combat_ended', { reason: overCheck.reason });
      }
    }
  }

  const combatPromptInjection = combatActive ? `\n\nCOMBAT MODE — The server handles all dice rolls, damage calculation, and HP tracking. You MUST NOT invent dice results or change HP values. Narrate the pre-resolved results in RESOLVED THIS ROUND.\n- Use exact numbers provided. Format: **🎲 [desc] — rolls [total]. HIT/MISS! [damage]. [target] [HP]**\n- 1-2 sentences of flavor between rolls. Do NOT skip any result.\n- KILLSHOT: [scene] when a target reaches 0 HP.` : '';
  const finalSystemPrompt = systemPrompt + combatPromptInjection;

  // Rebuild messages with combatContext appended to user message
  const messagesWithCombat = [
    ...gd.chatHistory,
    { role: 'user', content: prefix + userMessage + combatContext },
  ];

  // Streaming state machine
  let accumulatedText = '';
  let narrationText = '';
  let structuredBuffer = '';
  let state = 'NARRATING'; // NARRATING or BUFFERING
  let pendingTail = '';
  const LOOKAHEAD = 30; // chars to hold back for marker detection
  const markerRegex = /\n-{3,}\s*(?:OPTIONS|SCENE|WORLD)\s*-{3,}|\n#{1,3}\s*(?:OPTIONS?|SCENE|WORLD)\s*$/im;

  // Emit stream start
  io.to(gameId).emit('dm_stream_start', {
    auto: !!actingAs,
    player: actingAs || null,
  });

  let finalMessage;
  try {
    const stream = await anthropic.messages.stream({
      model,
      max_tokens: maxTokens,
      system: [{ type: "text", text: finalSystemPrompt, cache_control: { type: "ephemeral" } }],
      messages: messagesWithCombat,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.text) {
        const delta = event.delta.text;
        accumulatedText += delta;

        if (state === 'NARRATING') {
          pendingTail += delta;
          const markerMatch = pendingTail.match(markerRegex);

          if (markerMatch) {
            // Flush everything before marker as narration
            const safeText = pendingTail.slice(0, markerMatch.index);
            if (safeText) {
              io.to(gameId).emit('dm_stream_chunk', { text: safeText });
              narrationText += safeText;
            }
            structuredBuffer = pendingTail.slice(markerMatch.index);
            pendingTail = '';
            state = 'BUFFERING';
          } else if (pendingTail.length > LOOKAHEAD) {
            const safeChunk = pendingTail.slice(0, -LOOKAHEAD);
            io.to(gameId).emit('dm_stream_chunk', { text: safeChunk });
            narrationText += safeChunk;
            pendingTail = pendingTail.slice(-LOOKAHEAD);
          }
        } else {
          structuredBuffer += delta;
        }
      }
    }

    // Flush remaining
    if (state === 'NARRATING' && pendingTail) {
      io.to(gameId).emit('dm_stream_chunk', { text: pendingTail });
      narrationText += pendingTail;
    }

    finalMessage = await stream.finalMessage();
  } catch (streamErr) {
    console.error('[stream] Error during streaming:', streamErr.message);
    io.to(gameId).emit('dm_stream_end', { narration: narrationText.trim() });
    throw streamErr;
  }

  const elapsed = Date.now() - startTime;
  const reply = accumulatedText;

  // Emit stream end with final narration for re-rendering
  io.to(gameId).emit('dm_stream_end', { narration: narrationText.trim() });

  // Log cost
  const inputTokens = finalMessage.usage?.input_tokens || 0;
  const outputTokens = finalMessage.usage?.output_tokens || 0;
  const cost = estimateCost(model, inputTokens, outputTokens);
  logCost({ gameId, model, inputTokens, outputTokens, cost, type: actingAs ? 'auto-action' : 'player-action' });
  console.log(`API call: ${model} | ${inputTokens}in/${outputTokens}out | $${cost.toFixed(4)} | ${elapsed}ms | ${actingAs ? 'auto' : 'human'}`);

  const parsed = parseResponse(reply);
  console.log(`[stream-debug] state=${state} narration=${narrationText.length}ch structured=${structuredBuffer.length}ch options=${parsed.options.length} scene=${!!parsed.scene} world=${!!parsed.world}`);

  // Enforce verbosity word limits server-side (AI frequently exceeds them)
  if (parsed.narration && gs.verbosity) {
    const wordLimit = gs.verbosity === 'terse' ? 40 : gs.verbosity === 'brief' ? 80 : null;
    if (wordLimit) {
      const words = parsed.narration.split(/\s+/);
      if (words.length > wordLimit) {
        // Find the last sentence boundary within the limit
        const truncated = words.slice(0, wordLimit).join(' ');
        const lastPeriod = Math.max(truncated.lastIndexOf('. '), truncated.lastIndexOf('.\n'), truncated.lastIndexOf('."'));
        const lastExclaim = Math.max(truncated.lastIndexOf('! '), truncated.lastIndexOf('!\n'));
        const cutPoint = Math.max(lastPeriod, lastExclaim);
        parsed.narration = cutPoint > truncated.length * 0.3 ? truncated.slice(0, cutPoint + 1) : truncated + '...';
      }
    }
  }

  gd.chatHistory.push(
    { role: 'user', content: prefix + userMessage },
    { role: 'assistant', content: parsed.narration }
  );
  if (gd.chatHistory.length > 16) {
    gd.chatHistory = gd.chatHistory.slice(-16);
  }

  // If no options were extracted and this isn't an auto-action, make a cheap follow-up call
  if (parsed.options.length === 0 && !actingAs) {
    try {
      const nextPlayer = getCurrentPlayer(gameId);
      const optionsResponse = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Given this narration from a ${gameConfig.system || 'D&D 5e'} game, suggest exactly 3 action options for ${nextPlayer || 'the next player'}. Output ONLY this format with number emojis, nothing else:\n\n1️⃣ 🗡️ [combat/practical action]\n2️⃣ 🛡️ [defensive/cautious action]\n3️⃣ 🔥 [wild/reckless/creative move]\n\nNarration: ${parsed.narration.slice(-500)}`,
        }],
      });
      const optLines = optionsResponse.content[0].text.split('\n')
        .filter(l => /^\d+\.\s/.test(l.trim()))
        .map(l => l.replace(/^\d+\.\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 3);
      if (optLines.length >= 2) parsed.options = optLines;
    } catch (e) {
      console.warn('[options-fallback] failed:', e.message);
    }
  }

  // Fallback: generate scene data if ---SCENE--- was missing
  if (!parsed.scene && parsed.narration && !actingAs) {
    const narrationSnippet = parsed.narration.slice(-300);
    // Extract a brief scene description from the narration
    const actionWords = narrationSnippet.match(/\b(?:attack|charge|cast|fight|enter|explore|sneak|flee|negotiate|search|climb|jump|run|dodge|block|heal|pray|steal|trap|ambush)\w*/i);
    const action = actionWords ? actionWords[0] : 'adventuring';
    parsed.scene = {
      action: action + ' in progress',
      mood: 'tense',
      npc: 'none',
      raw: `ACTION: ${action}\nMOOD: tense\nNPC: none`,
    };
  }

  // Process map hint (synchronous graph update)
  const mapResult = processMapHint(gs.mapGraph, parsed.worldRaw, parsed.world?.locations);

  // Apply character sheet updates in memory first
  if (parsed.world) {
    gs.world = parsed.world;
    if (parsed.world.charUpdates && parsed.world.charUpdates.length) {
      for (const update of parsed.world.charUpdates) {
        const char = gd.characters[update.character];
        if (char && ['statsText', 'personality', 'backstory', 'standardActions'].includes(update.field)) {
          char[update.field] = update.value;
        }
      }
    }
  }

  // Emit socket events FIRST so the player gets the response immediately
  if (parsed.world?.charUpdates?.length) {
    for (const update of parsed.world.charUpdates) {
      const char = gd.characters[update.character];
      if (char && ['statsText', 'personality', 'backstory', 'standardActions'].includes(update.field)) {
        io.to(gameId).emit('character_updated', {
          name: update.character,
          field: update.field,
          value: update.value,
          character: char,
        });
      }
    }
  }
  if (mapResult.moved) {
    io.to(gameId).emit('map_update', gs.mapGraph.toJSON());
    if (mapResult.isNew) {
      io.to(gameId).emit('map_inline', {
        location: mapResult.location,
        mapState: gs.mapGraph.toJSON(),
      });
    }
  }

  // Fire-and-forget DB writes (don't block response to player)
  const dbOps = [db.saveChatHistory(gameId, gd.chatHistory)];
  if (parsed.world) {
    dbOps.push(db.setState(gameId, 'world', gs.world));
    if (parsed.world.charUpdates && parsed.world.charUpdates.length) {
      for (const update of parsed.world.charUpdates) {
        const char = gd.characters[update.character];
        if (char && ['statsText', 'personality', 'backstory', 'standardActions'].includes(update.field)) {
          dbOps.push(db.upsertCharacter(gameId, update.character, char));
        }
      }
    }
  }
  if (mapResult.moved) {
    dbOps.push(db.setState(gameId, 'map', gs.mapGraph.toJSON()));
  }
  Promise.all(dbOps).catch(err => console.error('[db-write] Error:', err.message));

  // Queue world art generation for new locations/NPCs with image prompts
  if (parsed.world) {
    const artQueue = [];
    for (const loc of (parsed.world.locations || [])) {
      if (loc.imagePrompt) {
        const existing = gs.world?.locations?.find(l => l.name.toLowerCase() === loc.name.toLowerCase());
        const hasImage = existing?.imageUrl && !loc.imageUpdate;
        if (!hasImage) {
          artQueue.push({ type: 'location', name: loc.name, prompt: loc.imagePrompt, isUpdate: loc.imageUpdate });
        }
      }
    }
    for (const npc of (parsed.world.npcs || [])) {
      if (npc.imagePrompt) {
        const existing = gs.world?.npcs?.find(n => n.name.toLowerCase() === npc.name.toLowerCase());
        const hasImage = existing?.imageUrl && !npc.imageUpdate;
        if (!hasImage) {
          artQueue.push({ type: 'npc', name: npc.name, prompt: npc.imagePrompt, isUpdate: npc.imageUpdate });
        }
      }
    }
    for (const item of artQueue.slice(0, 2)) {
      generateWorldArt(gameId, item).catch(err => console.error('Art gen failed:', err.message));
    }
  }

  // Initiate combat if ENEMIES detected
  if (parsed.world?.enemies?.length > 0 && !gs.combatEngine.state.active) {
    initiateCombat(gameId, gameConfig, parsed.world.enemies).catch(e => console.error('Combat init error:', e));
  }

  // Pre-parse options for next combat turn
  if (gs.combatEngine.state.active && parsed.options?.length > 0) {
    const nextPlayer = gs.combatEngine.getCurrentTurn();
    if (nextPlayer) {
      const combatCtx = { combatants: gs.combatEngine.state.combatants };
      const tier1 = parseOptions(parsed.options, nextPlayer.id, combatCtx);
      if (tier1.some(r => r === null)) {
        parseOptionsWithAI(parsed.options, nextPlayer.id, combatCtx, anthropic)
          .then(results => { gs.preTaggedOptions = results; }).catch(() => {});
      } else {
        gs.preTaggedOptions = tier1;
      }
    }
  }

  // Emit combat update
  if (gs.combatEngine.state.active) emitCombatUpdate(gameId);

  // Refresh rolling summary every 50 turns (tracked via turnCount)
  if (gs.turnCount > 0 && gs.turnCount % 50 === 0) {
    refreshStorySummary(gameId, gameConfig).catch(console.error);
  }

  parsed.mapMoved = mapResult.moved;
  return parsed;
}

// ── Turn Management (scoped to a game) ───────────────────────────────────────
function getCurrentPlayer(gameId) {
  const gs = getGameState(gameId);
  const { turnOrder, currentTurnIndex } = gs.data;
  if (!turnOrder.length) return null;
  return turnOrder[currentTurnIndex % turnOrder.length];
}

function getConnectedClients(gameId) {
  const room = io.sockets.adapter.rooms.get(gameId);
  return room ? room.size : 0;
}

function startTurnTimer(gameId, gameConfig, playerName) {
  const gs = getGameState(gameId);
  clearTimeout(gs.turnTimer);

  // Safety: don't start timer if no humans are connected or game is paused
  if (getConnectedClients(gameId) === 0 || gs.paused) {
    console.log(`Timer not started for ${gameId}: ${gs.paused ? 'paused' : 'no clients'}`);
    return;
  }

  gs.turnTimer = setTimeout(async () => {
    // Double-check: still have connected clients?
    if (getConnectedClients(gameId) === 0) {
      console.log(`Auto-action aborted for ${gameId}: no clients connected`);
      return;
    }

    const char = gs.data.characters[playerName];
    const autoPrompt = char
      ? `It is ${playerName}'s turn but they did not respond. Act on their behalf as their character (${char.class}, personality: ${char.personality}). Choose the most fitting action given the current situation and their standard actions: ${char.standardActions || 'none'}. Narrate what they do.`
      : `It is ${playerName}'s turn but they did not respond. Have them take a cautious, sensible action.`;

    emitSystem(gameId, { text: `⏰ ${playerName} ran out of time. Claude is acting for them...` });

    try {
      const { narration, options, scene, world, isKillshot, mapMoved } = await callClaude(gameId, gameConfig, autoPrompt, playerName);
      const gs2 = getGameState(gameId);
      const nextIdx = (gs2.data.currentTurnIndex + 1) % (gs2.data.turnOrder.length || 1);
      const nextPlayer = gs2.data.turnOrder[nextIdx] || null;
      emitDmMessage(gameId, { text: narration, options, auto: true, player: playerName, forPlayer: nextPlayer, world });
      await maybeGenerateImage(gameId, gameConfig, scene, isKillshot, mapMoved, narration);
      advanceTurn(gameId, gameConfig, false);
    } catch (err) {
      emitSystem(gameId, { text: 'Error during auto-action.' });
    }
  }, gs.turnDuration * 1000);
}

async function advanceTurn(gameId, gameConfig, wasHumanAction = false) {
  const gs = getGameState(gameId);
  const gd = gs.data;

  // Track idle turns
  if (wasHumanAction) {
    gs.idleTurns = 0;
  } else {
    gs.idleTurns = (gs.idleTurns || 0) + 1;
  }

  // Pause after 2 consecutive idle turns (prevents runaway API costs)
  if (gs.idleTurns >= 2) {
    gs.paused = true;
    clearTimeout(gs.turnTimer);
    emitSystem(gameId, { text: '⏸️ Game paused — no human actions for 5 turns. Use /tt start or tap Begin to resume.' });
    io.to(gameId).emit('game_paused');
    return;
  }

  gd.currentTurnIndex = (gd.currentTurnIndex + 1) % (gd.turnOrder.length || 1);
  await db.saveTurnState(gameId, gd.currentTurnIndex, gd.turnOrder);
  const next = getCurrentPlayer(gameId);
  if (next) {
    const token = gd.characters[next]?.token || null;
    emitTurnChange(gameId, { player: next, duration: gs.turnDuration * 1000, token });
    startTurnTimer(gameId, gameConfig, next);
  }
}

async function maybeGenerateImage(gameId, gameConfig, scene, isKillshot = false, mapMoved = false, narration = '') {
  if (!scene) return;
  const gs = getGameState(gameId);
  gs.turnCount++;
  // Detect natural 20s and boss kills from narration text
  const hasNat20 = /\brolls?\s*(a\s+)?natural\s+20\b|\brolls?\s+20\b|\bNAT\s*20\b|\bcritical\s+hit\b/i.test(narration);
  if (hasNat20) isKillshot = true; // Force image for nat-20
  if (shouldGenerateImage(gameId, scene, mapMoved, isKillshot)) {
    io.to(gameId).emit('scene_generating');
    const sceneLabel = isKillshot ? (hasNat20 ? `CRITICAL HIT! ${scene.action}` : `KILLSHOT: ${scene.action}`) :
      scene.npc && scene.npc.toLowerCase() !== 'none' ? scene.npc :
      scene.action || 'The adventure continues';
    generateCompositeScene(gameId, scene, gameConfig).then(url => {
      if (url) {
        gs.imageUrl = url;
        gs.imageLabel = sceneLabel;
        emitSceneImage(gameId, { url, label: sceneLabel });
        logCost({ gameId, model: 'FLUX', inputTokens: 0, outputTokens: 0, cost: IMAGE_COST, type: 'scene-image' });
      } else {
        io.to(gameId).emit('scene_gen_failed');
      }
    });
  }
}

// ── REST API ─────────────────────────────────────────────────────────────────
app.get('/api/games', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.anonSession?.id || null;
    const gamesList = await db.listGames();
    // Only show games this user created (private by default)
    const filtered = userId
      ? gamesList.filter(g => g.host_user_id === userId)
      : [];
    const enriched = filtered.map(g => ({
      ...g,
      playerCount: Object.keys(getGameState(g.id).data.characters).length,
    }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/games', authMiddleware, async (req, res) => {
  try {
    const { system } = req.body;
    const name = truncate(req.body.name, 100);
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      || crypto.randomBytes(4).toString('hex');
    await db.createGame(id, name, system || 'dnd5e');
    // Set host_user_id (authenticated user or anonymous session)
    const hostId = req.user?.id || req.anonSession?.id || null;
    if (hostId) {
      await db.pool.query('UPDATE games SET host_user_id = $1 WHERE id = $2', [hostId, id]);
    }
    const game = await db.getGame(id);
    res.json(game);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/games/:id/upload-pdf', requireAuth, upload.array('pdfs', 10), async (req, res) => {
  try {
    const game = await db.getGame(req.params.id);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const gameId = req.params.id;
    const uploads = await db.getState(gameId, 'pdf_uploads', []);

    for (const file of req.files) {
      const parser = new PDFParse({ data: file.buffer });
      const data = await parser.getText();
      const rawText = data.text.slice(0, 30000); // cap raw text for extraction call

      // Extract structured summary via Haiku
      console.log(`[PDF] Extracting summary for ${file.originalname} (${data.text.length} chars raw)...`);
      const extractionResponse = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: 'You are a tabletop RPG content analyzer. Extract and organize the key information from this source material into a structured summary. Be comprehensive but concise.',
        messages: [{ role: 'user', content: `Analyze this RPG source material and extract a structured summary covering:\n\n1. SETTING: World/region description, key themes, time period\n2. LOCATIONS: Name, description, notable features for each major location\n3. NPCS: Name, role, personality, motivations for each major NPC\n4. ENCOUNTERS: Key encounters/scenes with difficulty and rewards\n5. PLOT: Main quest hooks, story arc, key events\n6. RULES: Any custom rules, house rules, or system-specific modifications\n7. LOOT: Notable treasure, magic items, rewards\n8. LEVEL RANGE: Recommended character levels\n\nSource material:\n${rawText}` }],
      });

      const summary = extractionResponse.content[0].text;
      const inputTokens = extractionResponse.usage?.input_tokens || 0;
      const outputTokens = extractionResponse.usage?.output_tokens || 0;
      console.log(`[PDF] Summary for ${file.originalname}: ${summary.length} chars (${inputTokens} in / ${outputTokens} out tokens)`);

      uploads.push({
        filename: file.originalname,
        rawChars: data.text.length,
        summary: summary,
        summaryChars: summary.length,
        uploadedAt: new Date().toISOString(),
      });
    }

    await db.setState(gameId, 'pdf_uploads', uploads);

    // Rebuild custom_context from all summaries (not raw text)
    const allSummaries = uploads.map(u => `--- ${u.filename} ---\n${u.summary}`).join('\n\n');
    await db.updateGameContext(game.id, allSummaries);

    // Seed map with location names from summaries
    const gs = getGameState(gameId);
    const locationPattern = /(?:^|\n)(?:#{1,3}\s+)?([A-Z][A-Za-z\s''-]{2,30})(?:\n|$)/gm;
    let match;
    const skip = /^(chapter|appendix|introduction|table|figure|page|index|contents|credits|about|section|part|summary|overview|setting|locations|npcs|encounters|plot|rules|loot|level)/i;
    while ((match = locationPattern.exec(allSummaries)) !== null) {
      const name = match[1].trim();
      if (!skip.test(name) && name.split(' ').length <= 5) {
        gs.mapGraph.addNode(name, { level: 'world', description: 'From campaign source' });
      }
    }
    await db.setState(gameId, 'map', gs.mapGraph.toJSON());

    res.json({ success: true, totalChars: allSummaries.length, files: req.files.map(f => f.originalname), mapNodes: Object.keys(gs.mapGraph.nodes).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── Rules Corrections API ──────────────────────────────────────────────────────
app.get('/api/games/:id/rules', async (req, res) => {
  const rules = await db.getRulesCorrections(req.params.id);
  res.json(rules);
});

app.post('/api/games/:id/rules', requireAuth, async (req, res) => {
  const { text, category } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Text required' });
  const rule = await db.addRuleCorrection(req.params.id, text.trim().slice(0, 200), category);
  res.json(rule);
});

app.patch('/api/rules/:id', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Text required' });
  await db.updateRuleCorrection(req.params.id, text.trim().slice(0, 200));
  res.json({ success: true });
});

app.delete('/api/rules/:id', requireAuth, async (req, res) => {
  await db.deleteRuleCorrection(req.params.id);
  res.json({ success: true });
});

// ── PDF Management API ─────────────────────────────────────────────────────────
app.get('/api/games/:id/pdfs', async (req, res) => {
  const pdfs = await db.getState(req.params.id, 'pdf_uploads', []);
  res.json(pdfs);
});

app.delete('/api/games/:id/pdf/:index', requireAuth, async (req, res) => {
  const gameId = req.params.id;
  const index = parseInt(req.params.index);
  const game = await db.getGame(gameId);
  if (!game) return res.status(404).json({ error: 'Not found' });

  const uploads = await db.getState(gameId, 'pdf_uploads', []);
  if (index < 0 || index >= uploads.length) return res.status(400).json({ error: 'Invalid index' });

  uploads.splice(index, 1);
  await db.setState(gameId, 'pdf_uploads', uploads);

  // Rebuild custom_context from remaining summaries
  const allSummaries = uploads.map(u => `--- ${u.filename} ---\n${u.summary || ''}`).join('\n\n');
  await db.updateGameContext(gameId, allSummaries.trim());

  res.json({ success: true });
});

// Download individual PDF summary
app.get('/api/games/:id/pdf/:index/download', async (req, res) => {
  const uploads = await db.getState(req.params.id, 'pdf_uploads', []);
  const index = parseInt(req.params.index);
  if (index < 0 || index >= uploads.length) return res.status(404).json({ error: 'Not found' });
  const pdf = uploads[index];

  const content = JSON.stringify({
    filename: pdf.filename,
    summary: pdf.summary,
    uploadedAt: pdf.uploadedAt,
    exportedAt: new Date().toISOString(),
    exportedFrom: req.params.id,
  }, null, 2);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${pdf.filename.replace('.pdf', '')}-summary.json"`);
  res.send(content);
});

// Download ALL summaries as one file
app.get('/api/games/:id/pdfs/download-all', async (req, res) => {
  const uploads = await db.getState(req.params.id, 'pdf_uploads', []);
  const game = await db.getGame(req.params.id);

  const content = JSON.stringify({
    gameName: game?.name,
    gameSystem: game?.system,
    exportedAt: new Date().toISOString(),
    materials: uploads.map(u => ({
      filename: u.filename,
      summary: u.summary,
      uploadedAt: u.uploadedAt,
    })),
  }, null, 2);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}-campaign-materials.json"`);
  res.send(content);
});

// Import summaries from another game
app.post('/api/games/:id/import-materials', requireAuth, async (req, res) => {
  try {
    const { materials } = req.body; // array of { filename, summary, uploadedAt }
    if (!Array.isArray(materials)) return res.status(400).json({ error: 'Invalid format' });

    const gameId = req.params.id;
    const uploads = await db.getState(gameId, 'pdf_uploads', []);

    for (const m of materials) {
      uploads.push({
        filename: m.filename || 'imported',
        rawChars: 0,
        summary: m.summary,
        summaryChars: m.summary?.length || 0,
        uploadedAt: m.uploadedAt || new Date().toISOString(),
        imported: true,
      });
    }

    await db.setState(gameId, 'pdf_uploads', uploads);

    // Rebuild context
    const allSummaries = uploads.map(u => `--- ${u.filename} ---\n${u.summary}`).join('\n\n');
    await db.updateGameContext(gameId, allSummaries);

    res.json({ success: true, count: materials.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', async (req, res) => {
  try {
    await db.pool.query('SELECT 1');
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      games: Object.keys(games).length,
    });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

app.get('/api/deploy-time', (req, res) => {
  res.json({ deployTime: DEPLOY_TIME });
});

app.get('/api/costs', (req, res) => {
  const summary = getCostSummary();
  const games_detail = {};
  for (const entry of costLog) {
    if (!games_detail[entry.gameId]) games_detail[entry.gameId] = { calls: 0, cost: 0 };
    games_detail[entry.gameId].calls++;
    games_detail[entry.gameId].cost += entry.cost || 0;
  }
  res.json({ ...summary, games: games_detail, recentCalls: costLog.slice(-20) });
});

app.delete('/api/games/:id', requireAuth, async (req, res) => {
  try {
    const gameId = req.params.id;
    const gs = games[gameId];
    if (gs) {
      clearTimeout(gs.turnTimer);
      delete games[gameId];
    }
    await db.deleteGame(gameId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Billing toggle (in-memory, defaults from env) ────────────────────────────
let billingEnabled = process.env.BILLING_ENABLED === 'true';

// ── Admin API routes (all require admin auth) ────────────────────────────────

app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await db.listUsers();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/credit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId, minutes } = req.body;
    if (!userId || !minutes || minutes <= 0) {
      return res.status(400).json({ error: 'userId and positive minutes required' });
    }
    await db.creditMinutes(userId, minutes, { creditType: 'admin' });
    res.json({ ok: true, credited: minutes, userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/promo/generate', requireAuth, requireAdmin, async (req, res) => {
  try {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let suffix = '';
    for (let i = 0; i < 6; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
    const code = 'BETA-' + suffix;
    const minutes = 2400; // 40 hours
    await db.pool.query(
      `INSERT INTO promo_codes (code, minutes_granted) VALUES ($1, $2)`,
      [code, minutes]
    );
    res.json({ ok: true, code, minutes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/promo/list', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.pool.query(
      `SELECT code, minutes_granted, created_at, redeemed_by, redeemed_at
       FROM promo_codes ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/billing-status', requireAuth, requireAdmin, (req, res) => {
  res.json({ enabled: billingEnabled });
});

app.post('/api/admin/billing-toggle', requireAuth, requireAdmin, (req, res) => {
  billingEnabled = !billingEnabled;
  process.env.BILLING_ENABLED = billingEnabled ? 'true' : 'false';
  res.json({ enabled: billingEnabled });
});

// ── Feature Requests ─────────────────────────────────────────────────────────
app.get('/api/admin/features', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.pool.query(
      'SELECT * FROM feature_requests ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/features', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, description, priority } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const { rows } = await db.pool.query(
      `INSERT INTO feature_requests (title, description, priority)
       VALUES ($1, $2, $3) RETURNING *`,
      [title, description || '', priority || 'medium']
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/features/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { status, priority } = req.body;
    const sets = [];
    const vals = [];
    let idx = 1;
    if (status) { sets.push(`status = $${idx++}`); vals.push(status); }
    if (priority) { sets.push(`priority = $${idx++}`); vals.push(priority); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    const { rows } = await db.pool.query(
      `UPDATE feature_requests SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Promo Code Redemption ─────────────────────────────────────────────────────
app.get('/api/balance', requireAuth, async (req, res) => {
  try {
    const balance = await db.getUserBalance(req.user.id);
    if (!balance) {
      return res.json({ freeMinutes: 0, paidMinutes: 0 });
    }
    res.json({
      freeMinutes: balance.free_minutes_remaining,
      paidMinutes: balance.paid_minutes_remaining,
    });
  } catch (err) {
    console.error('Balance fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create anonymous session (called by game client when no auth)
app.post('/api/anonymous-session', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const { createAnonymousSession, setTokenCookie } = require('./auth');
  const result = await createAnonymousSession(ip);
  if (result.error) {
    return res.status(429).json({ error: result.error });
  }
  // Set the anonymous JWT as cookie
  res.cookie('tt_token', result.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  });
  res.json({ anonId: result.id });
});

app.post('/api/redeem', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Promo code is required' });
    }
    const result = await db.redeemPromoCode(req.user.id, code.trim().toUpperCase());
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    res.json({
      success: true,
      minutesCredited: result.minutesCredited,
      newBalance: result.balance.paid_minutes_remaining,
    });
  } catch (err) {
    console.error('Redeem error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Purchase / Payments ──────────────────────────────────────────────────────
app.get('/purchase', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'purchase.html'));
});

app.post('/api/purchase', requireAuth, async (req, res) => {
  try {
    if (!payments.isConfigured()) {
      return res.status(503).json({ error: 'Payments not configured yet. Use promo codes.' });
    }
    const { productId } = req.body;
    const returnUrl = `${req.protocol}://${req.get('host')}`;
    const session = await payments.createCheckoutSession(req.user.id, productId, returnUrl);
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/redeem', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'redeem.html'));
});

app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve game page for any game slug
app.get('/game/:gameId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

// ── Idle game eviction (every 10 minutes) ─────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [gameId, gs] of Object.entries(games)) {
    const clients = getConnectedClients(gameId);
    if (clients === 0) {
      if (!gs._lastActivity) gs._lastActivity = now;
      if (now - gs._lastActivity > 3600000) { // 1 hour
        clearTimeout(gs.turnTimer);
        delete games[gameId];
        console.log(`Evicted idle game from memory: ${gameId}`);
      }
    } else {
      gs._lastActivity = now;
    }
  }
}, 600000);

// ── Socket.io Authentication Middleware ────────────────────────────────────────
io.use((socket, next) => {
  const cookieHeader = socket.handshake.headers.cookie;
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').reduce((acc, c) => {
      const [key, val] = c.trim().split('=');
      acc[key] = val;
      return acc;
    }, {});
    const token = cookies['tt_token'];
    if (token) {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET || require('./auth').jwtSecret);
        if (decoded.anonymous) {
          socket.anonId = decoded.anonId;
          socket.userId = null;
        } else {
          socket.userId = decoded.userId;
          socket.userEmail = decoded.email;
          socket.anonId = null;
        }
      } catch (e) {
        // Invalid token — allow connection but mark as unauthenticated
      }
    }
  }
  next();
});

// ── Socket Events ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Join a game room
  socket.on('join_game', async (gameId) => {
    const game = await db.getGame(gameId);
    if (!game) {
      socket.emit('error_msg', { text: 'Game not found.' });
      return;
    }

    socket.join(gameId);
    socket.gameId = gameId;
    // Attach userId from auth handshake (if available) for billing
    if (socket.handshake.auth?.userId) {
      socket.userId = socket.handshake.auth.userId;
    }

    // Load from DB if not cached
    if (!games[gameId]) {
      const gs = getGameState(gameId);
      gs.data = await db.loadGameData(gameId);
      gs.world = await db.getState(gameId, 'world', { locations: [], npcs: [] });
      const mapData = await db.getState(gameId, 'map', null);
      if (mapData) gs.mapGraph = new MapGraph(mapData);
      gs.ferocity = await db.getState(gameId, 'ferocity', 5);
      gs.verbosity = await db.getState(gameId, 'verbosity', 'verbose');
      gs.pillars = await db.getState(gameId, 'pillars', { exploration: 33, combat: 33, social: 34 });
      gs.dmPersona = await db.getState(gameId, 'dmPersona', 'epic');
      gs.storySummary = await db.getState(gameId, 'storySummary', null);
    }

    const gs = getGameState(gameId);
    gs.rulesCorrections = await db.getRulesCorrections(gameId);

    socket.emit('game_joined', {
      game,
      chatHistory: gs.data.chatHistory,
      characters: gs.data.characters,
      turnOrder: gs.data.turnOrder,
      currentPlayer: getCurrentPlayer(gameId),
      imageUrl: gs.imageUrl,
      imageLabel: gs.imageLabel || null,
      turnDuration: gs.turnDuration,
      world: gs.world || { locations: [], npcs: [] },
      lastOptions: gs.lastOptions || [],
      lastForPlayer: gs.lastForPlayer || null,
      mapState: gs.mapGraph.toJSON(),
      ferocity: gs.ferocity,
      verbosity: gs.verbosity,
      pillars: gs.pillars,
      dmPersona: gs.dmPersona,
      pdfUploads: await db.getState(gameId, 'pdf_uploads', []),
    });
  });

  // Register / update character
  socket.on('register_character', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;

    // Preserve existing token if re-registering and no new upload
    const gs = getGameState(gameId);
    const existing = gs.data.characters[data.name];

    data.name = truncate(data.name, 50);
    const charData = {
      statsText: truncate(data.statsText, 5000) || '',
      personality: truncate(data.personality, 5000) || 'Brave and curious',
      standardActions: truncate(data.standardActions, 5000) || '',
      backstory: truncate(data.backstory, 5000) || '',
      token: data.token === null ? null : (data.token || (existing && existing.token) || null),
    };

    gs.data.characters[data.name] = charData;
    if (!gs.data.turnOrder.includes(data.name)) {
      gs.data.turnOrder.push(data.name);
    }
    await db.upsertCharacter(gameId, data.name, charData);
    await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);
    io.to(gameId).emit('character_registered', { name: data.name, character: charData });
    emitSystem(gameId, { text: `📜 ${data.name} has joined the campaign.` });

    // Auto-generate token if none provided
    if (!charData.token) {
      io.to(gameId).emit('token_generating', { name: data.name });
      generateCharacterToken(data.name, charData).then(async (tokenUrl) => {
        if (tokenUrl) {
          charData.token = tokenUrl;
          gs.data.characters[data.name] = charData;
          await db.upsertCharacter(gameId, data.name, charData);
          emitCharacterToken(gameId, { name: data.name, token: tokenUrl });
        } else {
          io.to(gameId).emit('token_failed', { name: data.name });
        }
      });
    }
  });

  // Upload custom token image
  socket.on('upload_token', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const { name, token } = data; // token is base64 data URL
    const gs = getGameState(gameId);
    const char = gs.data.characters[name];
    if (!char) return;
    char.token = token;
    await db.upsertCharacter(gameId, name, char);
    emitCharacterToken(gameId, { name, token });
  });

  // Generate pre-made party
  socket.on('generate_party', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    try {
      const direction = (data && data.direction) ? truncate(data.direction, 500) : '';
      const result = await gameEngine.generateParty(gameId, direction);
      socket.emit('party_generated', { count: result.count });
    } catch (err) {
      console.error('Party generation failed:', err.message);
      socket.emit('party_gen_failed', { error: err.message });
    }
  });

  // Player sends an action
  socket.on('player_action', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;

    const playerName = data.playerName;
    const action = truncate(data.action, 2000);

    // Block anonymous users past 120-minute limit
    if (socket.anonId && !socket.userId) {
      const anonSession = await db.getAnonSession(socket.anonId);
      if (anonSession && anonSession.minutes_used >= 120) {
        socket.emit('signup_required', {
          minutesUsed: anonSession.minutes_used,
          message: 'Create a free account to keep playing. It takes 10 seconds.',
        });
        return;
      }
    }

    // Block spectators from taking actions
    if (socket.userId && billingTicker.isSpectator(gameId, socket.userId)) {
      socket.emit('system', { text: 'You are in spectator mode. Add time to resume control.' });
      return;
    }

    const current = getCurrentPlayer(gameId);

    if (current && current.toLowerCase() !== playerName.toLowerCase()) {
      socket.emit('system', { text: `It's ${current}'s turn, not yours.` });
      return;
    }

    const gs = getGameState(gameId);
    clearTimeout(gs.turnTimer);
    const playerToken = gs.data.characters[playerName]?.token || null;
    io.to(gameId).emit('player_message', { player: playerName, text: action, token: playerToken });
    discord.onSystem(gameId, { text: `**${playerName}:** ${action}` }).catch(() => {});

    try {
      const gameConfig = await db.getGame(gameId);
      const { narration, options, scene, world, isKillshot, mapMoved } = await callClaude(gameId, gameConfig, `${playerName}: ${action}`);
      const nextIdx = (gs.data.currentTurnIndex + 1) % (gs.data.turnOrder.length || 1);
      const nextPlayer = gs.data.turnOrder[nextIdx] || null;
      emitDmMessage(gameId, { text: narration, options, auto: false, forPlayer: nextPlayer, world });
      await maybeGenerateImage(gameId, gameConfig, scene, isKillshot, mapMoved, narration);
      await advanceTurn(gameId, gameConfig, true);
    } catch (err) {
      socket.emit('system', { text: 'Error communicating with the DM. Try again.' });
    }
  });

  // OOC (Out of Character) message
  socket.on('ooc_message', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const { playerName } = data;
    const message = truncate(data.message, 1000);

    try {
      const gs = getGameState(gameId);
      const gameConfig = await db.getGame(gameId);
      const oocPrompt = `[OOC from ${playerName}]: ${message}\n\nThis is an out-of-character instruction about rules, setting, or gameplay. Acknowledge briefly and adjust accordingly. Do NOT advance the turn or narrate an action. Do NOT include ---OPTIONS--- or ---SCENE--- blocks. Just respond to the instruction.`;

      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system: [{ type: "text", text: buildTrimmedPrompt(gameId, gameConfig), cache_control: { type: "ephemeral" } }],
        messages: [...gs.data.chatHistory, { role: 'user', content: oocPrompt }],
      });

      const reply = response.content[0].text;
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      logCost({ gameId, model: 'claude-haiku-4-5-20251001', inputTokens, outputTokens,
        cost: estimateCost('claude-haiku-4-5-20251001', inputTokens, outputTokens), type: 'ooc' });

      // Save OOC exchanges in history so Claude remembers
      gs.data.chatHistory.push(
        { role: 'user', content: `[OOC: ${message}]` },
        { role: 'assistant', content: `[OOC acknowledged: ${reply}]` }
      );
      await db.saveChatHistory(gameId, gs.data.chatHistory);

      // Broadcast to all players
      io.to(gameId).emit('ooc_message', { player: playerName, message, reply });
      discord.onSystem(gameId, { text: `💭 [OOC] ${playerName}: ${message}\n💭 [GM]: ${reply}` }).catch(() => {});

      // Auto-save OOC instruction as a rules correction
      await db.addRuleCorrection(gameId, message.slice(0, 200), 'ooc');
      gs.rulesCorrections = await db.getRulesCorrections(gameId);

      // Add 1 minute to current turn timer
      if (gs.turnTimer) {
        clearTimeout(gs.turnTimer);
        const currentPlayer = getCurrentPlayer(gameId);
        if (currentPlayer) {
          startTurnTimer(gameId, gameConfig, currentPlayer);
        }
      }
    } catch (err) {
      socket.emit('system', { text: 'Error processing OOC message.' });
    }
  });

  // Rules updated (refresh cache)
  socket.on('rules_updated', async () => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const gs = getGameState(gameId);
    gs.rulesCorrections = await db.getRulesCorrections(gameId);
  });

  // DM start
  socket.on('dm_start', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;

    const { prompt } = data;
    try {
      const gameConfig = await db.getGame(gameId);
      const gs = getGameState(gameId);
      const { narration, options, scene, world } = await callClaude(gameId, gameConfig, prompt || 'Begin the adventure. Set the scene vividly.');
      const firstPlayer = getCurrentPlayer(gameId);
      emitDmMessage(gameId, { text: narration, options, auto: false, forPlayer: firstPlayer, world });
      // Always generate image for the opening scene
      if (scene) {
        const openingLabel = scene.npc && scene.npc.toLowerCase() !== 'none' ? scene.npc : scene.action || 'The adventure begins';
        io.to(gameId).emit('scene_generating');
        generateCompositeScene(gameId, scene, gameConfig).then(url => {
          if (url) {
            gs.imageUrl = url;
            gs.imageLabel = openingLabel;
            emitSceneImage(gameId, { url, label: openingLabel });
            logCost({ gameId, model: 'FLUX', inputTokens: 0, outputTokens: 0, cost: IMAGE_COST, type: 'scene-image' });
          } else {
            io.to(gameId).emit('scene_gen_failed');
          }
        });
      }
      const first = getCurrentPlayer(gameId);
      if (first) {
        const firstToken = gs.data.characters[first]?.token || null;
        emitTurnChange(gameId, { player: first, duration: gs.turnDuration * 1000, token: firstToken });
        startTurnTimer(gameId, gameConfig, first);
      }
      // Start billing ticker for this game
      billingTicker.startForGame(gameId, gameConfig.host_user_id, gs);
    } catch (err) {
      socket.emit('system', { text: 'Failed to start the game.' });
    }
  });

  // Reset game
  socket.on('reset_game', async () => {
    const gameId = socket.gameId;
    if (!gameId) return;

    billingTicker.stopForGame(gameId);
    const gs = getGameState(gameId);
    clearTimeout(gs.turnTimer);
    gs.data.chatHistory = [];
    gs.data.currentTurnIndex = 0;
    gs.turnCount = 0;
    gs.imageUrl = null;
    gs.storySummary = null;
    await db.saveChatHistory(gameId, gs.data.chatHistory);
    await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);
    io.to(gameId).emit('game_reset');
    emitSystem(gameId, { text: '🔄 Game has been reset. Characters preserved.' });
  });

  socket.on('add_catchphrase', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const gs = getGameState(gameId);
    const char = gs.data.characters[data.name];
    if (!char) return;
    if (!char.catchphrases) char.catchphrases = [];
    if (char.catchphrases.length >= 10) {
      socket.emit('system', { text: '⚠️ Max 10 catchphrases. Remove one first.' });
      return;
    }
    char.catchphrases.push(data.phrase);
    await db.upsertCharacter(gameId, data.name, char);
    socket.emit('system', { text: `💬 Catchphrase added: "${data.phrase}"` });
    io.to(gameId).emit('catchphrases_updated', { name: data.name, catchphrases: char.catchphrases });
  });

  socket.on('remove_catchphrase', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const gs = getGameState(gameId);
    const char = gs.data.characters[data.name];
    if (!char || !char.catchphrases) return;
    char.catchphrases = char.catchphrases.filter(p => p !== data.phrase);
    await db.upsertCharacter(gameId, data.name, char);
    io.to(gameId).emit('catchphrases_updated', { name: data.name, catchphrases: char.catchphrases });
  });

  socket.on('add_backstory', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const gs = getGameState(gameId);
    const char = gs.data.characters[data.name];
    if (!char) return;
    // Append to existing backstory with a note
    const existing = char.backstory || '';
    char.backstory = existing + (existing ? '\n' : '') + `[Added: ${data.text}]`;
    await db.upsertCharacter(gameId, data.name, char);
    socket.emit('system', { text: `📝 Backstory note added for ${data.name}. Claude will weave it into the narrative.` });
    io.to(gameId).emit('character_updated', { name: data.name, character: char });
  });

  socket.on('add_world_context', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const gs = getGameState(gameId);
    if (!gs.world) gs.world = { locations: [], npcs: [], accomplishments: [] };
    if (data.type === 'location') {
      // Add or append context to a location
      const existing = gs.world.locations.find(l => l.name.toLowerCase() === data.name?.toLowerCase());
      if (existing) {
        existing.description += ` | ${data.context}`;
      } else {
        gs.world.locations.push({ name: data.name || data.context.split(' ')[0], description: data.context, distance: '' });
      }
    } else if (data.type === 'npc') {
      const existing = gs.world.npcs.find(n => n.name.toLowerCase() === data.name?.toLowerCase());
      if (existing) {
        existing.description += ` | ${data.context}`;
      } else {
        gs.world.npcs.push({ name: data.name || data.context.split(' ')[0], description: data.context, location: '' });
      }
    }
    await db.setState(gameId, 'world', gs.world);
    io.to(gameId).emit('world_updated', gs.world);
    socket.emit('system', { text: `🗺️ World context added. Claude will use this in the narrative.` });
  });

  socket.on('save_character', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const gs = getGameState(gameId);
    const char = gs.data.characters[data.name];
    if (!char) return;
    if (data.statsText !== undefined) char.statsText = truncate(data.statsText, 5000);
    if (data.personality !== undefined) char.personality = truncate(data.personality, 5000);
    if (data.standardActions !== undefined) char.standardActions = truncate(data.standardActions, 5000);
    if (data.backstory !== undefined) char.backstory = truncate(data.backstory, 5000);
    await db.upsertCharacter(gameId, data.name, char);
    socket.emit('system', { text: `✅ ${data.name}'s character sheet saved.` });
    io.to(gameId).emit('character_updated', { name: data.name, character: char });
  });

  socket.on('catch_up', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    try {
      const result = await gameEngine.catchUp(gameId, data.playerName);
      socket.emit('catch_up_result', result);
    } catch (err) {
      socket.emit('catch_up_result', { summary: 'Error generating summary.' });
    }
  });

  socket.on('skip_turn', async () => {
    const gameId = socket.gameId;
    if (!gameId) return;
    await gameEngine.skipTurn(gameId);
  });

  socket.on('set_pillars', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    await gameEngine.setPillars(gameId, data.exploration || 33, data.combat || 33, data.social || 34);
  });

  socket.on('set_verbosity', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    await gameEngine.setVerbosity(gameId, data.level);
  });

  socket.on('set_ferocity', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    await gameEngine.setFerocity(gameId, data.level);
  });

  socket.on('set_dm_persona', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    gameEngine.setDmPersona(gameId, data.persona);
  });

  socket.on('set_timer', (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    gameEngine.setTimer(gameId, data.seconds);
  });

  socket.on('set_billing_mode', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const mode = data.mode === 'player_pays' ? 'player_pays' : 'host_pays';
    try {
      await db.pool.query('UPDATE games SET billing_mode = $1 WHERE id = $2', [mode, gameId]);
      io.to(gameId).emit('system', { text: `Billing mode changed to: ${mode === 'host_pays' ? 'Host Pays' : 'Each Player Pays'}` });
    } catch (err) {
      console.error('Set billing mode error:', err);
    }
  });

  socket.on('delete_character', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    await gameEngine.deleteCharacter(gameId, data.name);
  });

  socket.on('deactivate_character', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    await gameEngine.deactivateCharacter(gameId, data.name);
  });

  socket.on('activate_character', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    await gameEngine.activateCharacter(gameId, data.name);
  });

  socket.on('reveal_location', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const gs = getGameState(gameId);
    if (gs.mapGraph.revealNode(data.name)) {
      await db.setState(gameId, 'map', gs.mapGraph.toJSON());
      io.to(gameId).emit('map_update', gs.mapGraph.toJSON());
      emitSystem(gameId, { text: `🗺️ Revealed: ${data.name}` });
    }
  });

  socket.on('set_map_style', (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const gs = getGameState(gameId);
    gs.mapStyle = data.style; // 'parchment' | 'dark' | 'tactical'
    io.to(gameId).emit('map_style_changed', { style: data.style });
  });

  socket.on('reaction_response', (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const gs = getGameState(gameId);
    const engine = gs.combatEngine;
    if (!engine.state.pendingReaction) return;
    engine.state.pendingReaction = null;
    emitCombatUpdate(gameId);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    // If no humans left in this game, stop the timer to prevent runaway API costs
    const gameId = socket.gameId;
    if (gameId) {
      setTimeout(() => {
        const remaining = getConnectedClients(gameId);
        if (remaining === 0) {
          const gs = games[gameId];
          if (gs) {
            clearTimeout(gs.turnTimer);
            gs.turnTimer = null;
            billingTicker.stopForGame(gameId);
            console.log(`All clients left ${gameId} — timer and billing stopped`);
          }
        }
      }, 5000); // 5s grace period for reconnects
    }
  });
});

// ── Game Engine API (used by Discord bot) ────────────────────────────────────
const gameEngine = {
  getGameState,

  async playerAction(gameId, playerName, action) {
    const current = getCurrentPlayer(gameId);
    if (current && current.toLowerCase() !== playerName.toLowerCase()) {
      return { error: `It's ${current}'s turn, not yours.` };
    }
    const gs = getGameState(gameId);
    clearTimeout(gs.turnTimer);

    const gameConfig = await db.getGame(gameId);
    const { narration, options, scene, world, isKillshot, mapMoved } = await callClaude(gameId, gameConfig, `${playerName}: ${action}`);
    const nextIdx = (gs.data.currentTurnIndex + 1) % (gs.data.turnOrder.length || 1);
    const nextPlayer = gs.data.turnOrder[nextIdx] || null;
    emitDmMessage(gameId, { text: narration, options, auto: false, forPlayer: nextPlayer, world });
    const playerToken = gs.data.characters[playerName]?.token || null;
    io.to(gameId).emit('player_message', { player: playerName, text: action, token: playerToken });
    await maybeGenerateImage(gameId, gameConfig, scene, isKillshot, mapMoved, narration);
    await advanceTurn(gameId, gameConfig, true);
    return { ok: true };
  },

  async registerCharacter(gameId, name, data) {
    const gs = getGameState(gameId);
    const existing = gs.data.characters[name];
    const charData = {
      statsText: data.statsText || '',
      personality: data.personality || 'Brave and curious',
      standardActions: data.standardActions || '',
      backstory: data.backstory || '',
      token: (existing && existing.token) || null,
    };
    gs.data.characters[name] = charData;
    if (!gs.data.turnOrder.includes(name)) {
      gs.data.turnOrder.push(name);
    }
    await db.upsertCharacter(gameId, name, charData);
    await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);
    io.to(gameId).emit('character_registered', { name, character: charData });
    emitSystem(gameId, { text: `📜 ${name} has joined the campaign.` });

    // Auto-generate token
    if (!charData.token) {
      io.to(gameId).emit('token_generating', { name });
      generateCharacterToken(name, charData).then(async (tokenUrl) => {
        if (tokenUrl) {
          charData.token = tokenUrl;
          gs.data.characters[name] = charData;
          await db.upsertCharacter(gameId, name, charData);
          emitCharacterToken(gameId, { name, token: tokenUrl });
        }
      });
    }
  },

  async startGame(gameId, prompt) {
    const gameConfig = await db.getGame(gameId);
    if (!games[gameId]) {
      const gs = getGameState(gameId);
      gs.data = await db.loadGameData(gameId);
    }
    const gs = getGameState(gameId);
    gs.paused = false;
    gs.idleTurns = 0;
    const { narration, options, scene, world } = await callClaude(gameId, gameConfig, prompt || 'Begin the adventure. Set the scene vividly.');
    const firstPlayer = getCurrentPlayer(gameId);
    emitDmMessage(gameId, { text: narration, options, auto: false, forPlayer: firstPlayer, world });
    if (scene) {
      const startLabel = scene.npc && scene.npc.toLowerCase() !== 'none' ? scene.npc : scene.action || 'The adventure begins';
      io.to(gameId).emit('scene_generating');
      generateCompositeScene(gameId, scene, gameConfig).then(url => {
        if (url) {
          gs.imageUrl = url;
          gs.imageLabel = startLabel;
          emitSceneImage(gameId, { url, label: startLabel });
          logCost({ gameId, model: 'FLUX', inputTokens: 0, outputTokens: 0, cost: IMAGE_COST, type: 'scene-image' });
        } else {
          io.to(gameId).emit('scene_gen_failed');
        }
      });
    }
    const first = getCurrentPlayer(gameId);
    if (first) {
      const firstToken = gs.data.characters[first]?.token || null;
      emitTurnChange(gameId, { player: first, duration: TURN_DURATION, token: firstToken });
      startTurnTimer(gameId, gameConfig, first);
    }
  },

  async resetGame(gameId) {
    const gs = getGameState(gameId);
    clearTimeout(gs.turnTimer);
    gs.data.chatHistory = [];
    gs.data.currentTurnIndex = 0;
    gs.turnCount = 0;
    gs.imageUrl = null;
    gs.storySummary = null;
    await db.saveChatHistory(gameId, gs.data.chatHistory);
    await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);
    io.to(gameId).emit('game_reset');
    emitSystem(gameId, { text: '🔄 Game has been reset. Characters preserved.' });
  },

  async catchUp(gameId, playerName) {
    const gs = getGameState(gameId);
    const gd = gs.data;
    // Find messages since the player last acted
    let lastActionIdx = -1;
    for (let i = gd.chatHistory.length - 1; i >= 0; i--) {
      const msg = gd.chatHistory[i];
      if (msg.role === 'user' && msg.content.startsWith(`${playerName}:`)) {
        lastActionIdx = i;
        break;
      }
    }
    const missedMessages = lastActionIdx === -1
      ? gd.chatHistory
      : gd.chatHistory.slice(lastActionIdx + 1);

    if (!missedMessages.length) {
      return { summary: 'You haven\'t missed anything — you\'re all caught up!' };
    }

    // Build a condensed transcript
    const transcript = missedMessages
      .map(m => m.role === 'user' ? `Player: ${m.content}` : `DM: ${m.content}`)
      .join('\n')
      .slice(0, 8000);

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: `Summarize what happened in this RPG session in 400 words or less. Focus on key events, combat outcomes, discoveries, and story developments. Write from a third-person perspective. Be vivid but concise.`,
      messages: [{ role: 'user', content: `Summarize what ${playerName} missed:\n\n${transcript}` }],
    });

    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    logCost({ gameId, model: 'claude-haiku-4-5-20251001', inputTokens, outputTokens,
      cost: estimateCost('claude-haiku-4-5-20251001', inputTokens, outputTokens), type: 'catch-up' });

    return { summary: response.content[0].text };
  },

  async skipTurn(gameId) {
    const gs = getGameState(gameId);
    clearTimeout(gs.turnTimer);
    const current = getCurrentPlayer(gameId);
    emitSystem(gameId, { text: `⏭️ ${current || 'Current player'}'s turn was skipped.` });
    const gameConfig = await db.getGame(gameId);
    await advanceTurn(gameId, gameConfig, false);
    return { ok: true };
  },

  async setVerbosity(gameId, level) {
    const gs = getGameState(gameId);
    const valid = ['verbose', 'brief', 'terse'];
    if (!valid.includes(level)) return { error: 'Invalid verbosity level' };
    gs.verbosity = level;
    await db.setState(gameId, 'verbosity', gs.verbosity);
    emitSystem(gameId, { text: `📝 Verbosity set to **${level}**.` });
    io.to(gameId).emit('verbosity_updated', { verbosity: level });
    return { ok: true, verbosity: level };
  },

  async setFerocity(gameId, level) {
    const gs = getGameState(gameId);
    const num = Math.max(1, Math.min(5, parseInt(level) || 5));
    gs.ferocity = num;
    await db.setState(gameId, 'ferocity', gs.ferocity);
    const labels = { 1: '💀 Extremely Deadly (max treasure)', 2: '⚔️ Very Dangerous (generous treasure)', 3: '⚖️ Balanced', 4: '🛡️ Light Challenge', 5: '😊 Easy & Forgiving' };
    emitSystem(gameId, { text: `🔥 Ferocity set to **${num}/5** — ${labels[num]}` });
    io.to(gameId).emit('ferocity_updated', { ferocity: num });
    return { ok: true, ferocity: num };
  },

  async setDmPersona(gameId, persona) {
    const gs = getGameState(gameId);
    const valid = ['epic', 'overthetop'];
    if (!valid.includes(persona)) return { error: 'Invalid persona' };
    gs.dmPersona = persona;
    await db.setState(gameId, 'dmPersona', persona);
    emitSystem(gameId, { text: `🎭 DM Persona switched to ${persona === 'epic' ? '📖 Epic' : '🤪 Over the Top'}` });
    io.to(gameId).emit('persona_updated', { persona });
    return { ok: true };
  },

  async setPillars(gameId, exploration, combat, social) {
    const gs = getGameState(gameId);
    // Normalize to 100%
    const total = exploration + combat + social;
    gs.pillars = {
      exploration: Math.round(exploration / total * 100),
      combat: Math.round(combat / total * 100),
      social: Math.round(social / total * 100),
    };
    await db.setState(gameId, 'pillars', gs.pillars);
    emitSystem(gameId, { text: `🎭 Pillars set: Exploration ${gs.pillars.exploration}% · Combat ${gs.pillars.combat}% · Social ${gs.pillars.social}%` });
    io.to(gameId).emit('pillars_updated', gs.pillars);
    return { ok: true, pillars: gs.pillars };
  },

  setTimer(gameId, seconds) {
    const gs = getGameState(gameId);
    gs.turnDuration = Math.max(10, Math.min(3600, seconds));
    emitSystem(gameId, { text: `⏱️ Turn timer set to ${gs.turnDuration} seconds.` });
    // Broadcast new duration to web clients
    io.to(gameId).emit('timer_updated', { duration: gs.turnDuration });
    return { ok: true, duration: gs.turnDuration };
  },

  async oocMessage(gameId, playerName, message) {
    const gs = getGameState(gameId);
    const gameConfig = await db.getGame(gameId);
    const oocPrompt = `[OOC from ${playerName}]: ${message}\n\nThis is an out-of-character instruction about rules, setting, or gameplay. Acknowledge briefly and adjust accordingly. Do NOT advance the turn or narrate an action. Do NOT include ---OPTIONS--- or ---SCENE--- blocks. Just respond to the instruction.`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: [{ type: "text", text: buildTrimmedPrompt(gameId, gameConfig), cache_control: { type: "ephemeral" } }],
      messages: [...gs.data.chatHistory, { role: 'user', content: oocPrompt }],
    });

    const reply = response.content[0].text;
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    logCost({ gameId, model: 'claude-haiku-4-5-20251001', inputTokens, outputTokens,
      cost: estimateCost('claude-haiku-4-5-20251001', inputTokens, outputTokens), type: 'ooc' });

    gs.data.chatHistory.push(
      { role: 'user', content: `[OOC: ${message}]` },
      { role: 'assistant', content: `[OOC acknowledged: ${reply}]` }
    );
    await db.saveChatHistory(gameId, gs.data.chatHistory);

    io.to(gameId).emit('ooc_message', { player: playerName, message, reply });

    // Add 1 minute to current turn timer
    if (gs.turnTimer) {
      clearTimeout(gs.turnTimer);
      const currentPlayer = getCurrentPlayer(gameId);
      if (currentPlayer) {
        startTurnTimer(gameId, gameConfig, currentPlayer);
      }
    }

    return { ok: true, reply };
  },

  async deleteCharacter(gameId, name) {
    const gs = getGameState(gameId);
    delete gs.data.characters[name];
    gs.data.turnOrder = gs.data.turnOrder.filter(n => n !== name);
    await db.pool.query('DELETE FROM characters WHERE game_id = $1 AND name = $2', [gameId, name]);
    await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);
    io.to(gameId).emit('character_deleted', { name });
    emitSystem(gameId, { text: `🗑️ ${name} has been removed from the campaign.` });
    return { ok: true };
  },

  async deactivateCharacter(gameId, name) {
    const gs = getGameState(gameId);
    const idx = gs.data.turnOrder.indexOf(name);
    if (idx !== -1) {
      gs.data.turnOrder.splice(idx, 1);
      await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);
      io.to(gameId).emit('character_deactivated', { name, turnOrder: gs.data.turnOrder });
      emitSystem(gameId, { text: `💤 ${name} has been removed from the initiative order.` });
    }
    return { ok: true };
  },

  async revealLocation(gameId, name) {
    const gs = getGameState(gameId);
    if (gs.mapGraph.revealNode(name)) {
      await db.setState(gameId, 'map', gs.mapGraph.toJSON());
      io.to(gameId).emit('map_update', gs.mapGraph.toJSON());
      emitSystem(gameId, { text: `🗺️ Revealed: ${name}` });
      return true;
    }
    return false;
  },

  async activateCharacter(gameId, name) {
    const gs = getGameState(gameId);
    if (gs.data.characters[name] && !gs.data.turnOrder.includes(name)) {
      gs.data.turnOrder.push(name);
      await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);
      io.to(gameId).emit('character_activated', { name, turnOrder: gs.data.turnOrder });
      emitSystem(gameId, { text: `⚔️ ${name} has rejoined the initiative order.` });
    }
    return { ok: true };
  },

  async generateParty(gameId, direction) {
    const gameConfig = await db.getGame(gameId);
    const gs = getGameState(gameId);

    const system = gameConfig.system || 'dnd5e';
    const hasContent = gameConfig.custom_context && gameConfig.custom_context.length > 100;

    let levelGuidance = '';
    if (hasContent) {
      levelGuidance = `Campaign source material has been uploaded. Analyze it and set the party to the appropriate starting level for the LOWEST level adventure/module in the material. If you can identify the module (e.g., "Lost Mine of Phandelver" = level 1-5, start at 1), use that. Otherwise default to level 1.`;
    }

    let systemInstructions = '';
    if (system === 'dnd5e') {
      systemInstructions = `Create 4 D&D 5th Edition characters. For each:
- Choose a distinct race and class (ensure party balance: at least 1 melee, 1 healer/support, 1 ranged/caster, 1 versatile)
- Generate full ability scores (use standard array: 15,14,13,12,10,8 assigned appropriately for class)
- Calculate HP based on class hit die + CON modifier at the appropriate level
- List starting equipment appropriate to class and level
- Include spell lists for casters (prepared spells or known spells)
- Include any class features, subclass if level 3+
${levelGuidance || 'Start at level 1.'}`;
    } else if (system === 'runequest') {
      systemInstructions = `Create 4 RuneQuest: Roleplaying in Glorantha characters. For each:
- Choose a distinct homeland and occupation (ensure variety: warrior, priest, shaman/sorcerer, scout/thief)
- Generate characteristics: STR, CON, SIZ, INT, POW, DEX, CHA (roll 3d6 or 2d6+6 as appropriate)
- Set starting cult affiliations and Rune affinities
- List key combat and non-combat skills with percentages
- Include starting Rune magic and Spirit magic
- Equipment appropriate to homeland and occupation
${levelGuidance || 'Standard starting characters.'}`;
    } else {
      systemInstructions = `Create 4 characters appropriate for this RPG system. Ensure party balance (combat, support, skills, magic). Include full stats, equipment, and abilities. ${levelGuidance || 'Standard starting level.'}`;
    }

    const contextSnippet = hasContent ? gameConfig.custom_context.slice(0, 3000) : '';

    let directionBlock = '';
    if (direction) {
      directionBlock = `PLAYER DIRECTION: ${direction}\nFollow these instructions for party composition, level, and number of characters.\n\n`;
    }

    const prompt = `${directionBlock}${systemInstructions}

${contextSnippet ? 'CAMPAIGN CONTEXT (use this to set level and flavor):\n' + contextSnippet + '\n' : ''}
For each character, output in this EXACT format (generate the number of characters specified in the direction, or 4 by default):

---CHARACTER---
NAME: [A fitting fantasy name]
STATS: [Full stat block as a single text block — include level, race, class, HP, ability scores, AC, speed, proficiencies, equipment, spells if any, class features]
PERSONALITY: [2-3 sentences — personality traits, ideals, bonds, flaws]
ACTIONS: [Comma-separated standard actions: e.g., Attack with longsword, Cast Fireball, Dodge, Help ally]
BACKSTORY: [3-4 sentences — origin, motivation, how they joined the party]

Generate the characters now.`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      system: 'You are a character creation assistant for tabletop RPGs. Generate detailed, playable characters.',
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text;

    // Parse the characters
    const charBlocks = text.split('---CHARACTER---').filter(b => b.trim());
    let count = 0;

    for (const block of charBlocks) {
      const nameMatch = block.match(/NAME:\s*(.+)/i);
      const statsMatch = block.match(/STATS:\s*([\s\S]*?)(?=PERSONALITY:|$)/i);
      const personalityMatch = block.match(/PERSONALITY:\s*([\s\S]*?)(?=ACTIONS:|$)/i);
      const actionsMatch = block.match(/ACTIONS:\s*([\s\S]*?)(?=BACKSTORY:|$)/i);
      const backstoryMatch = block.match(/BACKSTORY:\s*([\s\S]*?)(?=---CHARACTER---|$)/i);

      if (!nameMatch) continue;

      const name = nameMatch[1].trim();
      const charData = {
        statsText: (statsMatch?.[1] || '').trim(),
        personality: (personalityMatch?.[1] || '').trim(),
        standardActions: (actionsMatch?.[1] || '').trim(),
        backstory: (backstoryMatch?.[1] || '').trim(),
        token: null,
      };

      gs.data.characters[name] = charData;
      if (!gs.data.turnOrder.includes(name)) {
        gs.data.turnOrder.push(name);
      }
      await db.upsertCharacter(gameId, name, charData);
      io.to(gameId).emit('character_registered', { name, character: charData });
      emitSystem(gameId, { text: `📜 ${name} has joined the campaign.` });

      // Generate token async
      io.to(gameId).emit('token_generating', { name });
      generateCharacterToken(name, charData).then(async (tokenUrl) => {
        if (tokenUrl) {
          charData.token = tokenUrl;
          gs.data.characters[name] = charData;
          await db.upsertCharacter(gameId, name, charData);
          emitCharacterToken(gameId, { name, token: tokenUrl });
        }
      });

      count++;
    }

    await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);

    // Log cost
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    logCost({ gameId, model: 'claude-haiku-4-5-20251001', inputTokens, outputTokens,
      cost: estimateCost('claude-haiku-4-5-20251001', inputTokens, outputTokens), type: 'party-gen' });

    return { count };
  },
};

discord.setGameEngine(gameEngine);

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function boot() {
  await db.initDB();
  console.log('DB initialized');

  // Cost estimate on startup
  const gamesList = await db.listGames();
  const activeGames = gamesList.length;
  console.log('\n══════════════════════════════════════════');
  console.log('  💰 COST ESTIMATE');
  console.log('══════════════════════════════════════════');
  console.log(`  Active games: ${activeGames}`);
  console.log(`  Default model: Haiku ($0.80/$4.00 per 1M tokens)`);
  console.log(`  Turn timer: ${DEFAULT_TURN_DURATION}s | Idle pause: after 2 auto-turns`);
  console.log(`  Rate limit: ${MAX_CALLS_PER_HOUR} calls/game/hour`);
  console.log('  ─────────────────────────────────────');
  console.log('  Per API call (Haiku, ~2k in/500 out): ~$0.004');
  console.log('  Per API call (Sonnet, ~2k/500):       ~$0.014');
  console.log('  Per API call (Opus, ~2k/500):         ~$0.068');
  console.log('  Per image (FLUX):                     ~$0.003');
  console.log('  ─────────────────────────────────────');
  console.log('  Max hourly (Haiku, 60 calls+30 imgs): ~$0.33');
  console.log('  Max hourly (Sonnet, 60 calls+30 imgs):~$0.93');
  console.log('  Max hourly (Opus, 60 calls+30 imgs):  ~$4.17');
  console.log('  ─────────────────────────────────────');
  console.log('  Safety: no timer without clients, 2-turn idle pause,');
  console.log('  60 calls/hr rate limit, timer killed on disconnect');
  console.log('  Monitor: GET /api/costs for live cost tracking');
  console.log('══════════════════════════════════════════\n');

  await discord.startBot();
  server.listen(PORT, () => {
    console.log(`D&D Server running on http://localhost:${PORT}`);
  });
}

boot().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
