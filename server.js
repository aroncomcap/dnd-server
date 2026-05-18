const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const Together = require('together-ai');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const cookieParser = require('cookie-parser');
const passport = require('passport');
const db = require('./db');
const discord = require('./discord-bot');
const { MapGraph, processMapHint } = require('./map-engine');
const { router: authRouter, authMiddleware, requireAuth, requireAdmin, resolveAuthToken } = require('./auth');
const { BillingTicker } = require('./billing');
const payments = require('./payments');
const CombatEngine = require('./combat-engine');
const {
  parseAction,
  parseOptions,
  parseActionWithAI,
  parseOptionsWithAI,
  isDialogueAction,
  makeDialogueAction,
  isAdvanceAction,
  makeAdvanceAction,
  isExplicitHostileAction,
} = require('./action-parser');
const { parseStatsText } = require('./stat-parser');
const { getMonsterStats } = require('./monster-lookup');
const ed = require('./encounter-designer');
const narrationPipeline = require('./narration-pipeline');
const costTracker = require('./cost-tracker');
const llm = require('./llm');
const llmTelemetry = require('./llm/telemetry');
const llmModels = require('./llm/model-registry');
const promptBuilder = require('./prompt-builder');
const imageEngine = require('./image-engine');
const gameEngine = require('./game-engine');
const { awardCombatXP } = require('./xp-system');
const { sanitizeOptionsForPlayer } = require('./turn-options');
const { cleanInvalidCombatNarration } = require('./narration-sanitizer');
const { normalizeDnd5eCombatStats, applyCombatProfileEdits } = require('./combat-stats');
const plannerState = require('./planner-state');
const encounterDirector = require('./encounter-director');
const templateEngine = require('./template-engine');
const targetAuthority = require('./target-authority');
const enemyTargeting = require('./enemy-targeting');
const { isPlaceholderEnemyName, normalizeEnemyEntry, normalizeEnemyEntries } = require('./enemy-normalizer');
const USE_SPLIT_PIPELINE = process.env.SPLIT_PIPELINE === 'true';
const TEST_MODE = process.env.TEST_MODE === 'true';

// ── Art Styles ───────────────────────────────────────────────────────────────
const { ART_STYLES } = promptBuilder;

// ── Local stats parser (regex-based, no AI call) ─────────────────────────────
function parseStatsLocal(statsText) {
  if (!statsText || statsText.length < 20) return null;
  const text = statsText;

  // Level
  const levelMatch = text.match(/level\s+(\d+)/i);
  const level = levelMatch ? parseInt(levelMatch[1]) : 1;

  // HP
  const hpMatch = text.match(/HP[:\s]*(\d+)/i) || text.match(/Hit Points[:\s]*(\d+)/i);
  const hp = hpMatch ? parseInt(hpMatch[1]) : null;

  // AC
  const acMatch = text.match(/AC[:\s]*(\d+)/i) || text.match(/Armor Class[:\s]*(\d+)/i);
  const ac = acMatch ? parseInt(acMatch[1]) : null;

  // Abilities — match patterns like "STR 16" or "STR: 16" or "Strength 16"
  const abilities = {};
  const abilityNames = { str: /STR(?:ength)?[:\s]*(\d+)/i, dex: /DEX(?:terity)?[:\s]*(\d+)/i, con: /CON(?:stitution)?[:\s]*(\d+)/i, int: /INT(?:elligence)?[:\s]*(\d+)/i, wis: /WIS(?:dom)?[:\s]*(\d+)/i, cha: /CHA(?:risma)?[:\s]*(\d+)/i };
  for (const [key, regex] of Object.entries(abilityNames)) {
    const m = text.match(regex);
    abilities[key] = m ? parseInt(m[1]) : 10;
  }

  // Speed
  const speedMatch = text.match(/Speed[:\s]*(\d+)/i);
  const speed = speedMatch ? parseInt(speedMatch[1]) : 30;

  // Proficiency bonus
  const profMatch = text.match(/Proficiency[:\s]*\+?(\d+)/i);
  const proficiencyBonus = profMatch ? parseInt(profMatch[1]) : (level < 5 ? 2 : level < 9 ? 3 : level < 13 ? 4 : level < 17 ? 5 : 6);

  // Weapons — look for weapon names with damage dice
  const weapons = [];
  const weaponRegex = /(\w[\w\s]*?)\s*\((\d+d\d+(?:\s*[+-]\s*\d+)?)\s*(\w+)?\)/gi;
  let wm;
  while ((wm = weaponRegex.exec(text)) !== null) {
    const name = wm[1].trim().toLowerCase();
    if (/^(?:level|hp|ac|str|dex|con|int|wis|cha|speed)/i.test(name)) continue;
    const strMod = Math.floor((abilities.str - 10) / 2);
    const dexMod = Math.floor((abilities.dex - 10) / 2);
    const finesse = /rapier|dagger|shortsword|scimitar/i.test(name);
    const ranged = /bow|sling|dart|javelin/i.test(name);
    weapons.push({
      name,
      attackMod: (finesse || ranged) ? 'dex' : 'str',
      damage: wm[2].replace(/\s+/g, ''),
      damageType: (wm[3] || 'bludgeoning').toLowerCase(),
      properties: finesse ? ['finesse'] : ranged ? ['ranged'] : [],
    });
  }

  // Features
  const features = [];
  if (/extra attack/i.test(text)) features.push('Extra Attack');
  const sneakMatch = text.match(/sneak attack\s*(\d+d\d+)/i);
  if (sneakMatch) features.push(sneakMatch[0]);
  if (/multiattack/i.test(text)) features.push('Multiattack');
  if (/action surge/i.test(text)) features.push('Action Surge');
  if (/channel divinity/i.test(text)) features.push('Channel Divinity');

  if (!hp && !ac) return null; // Not enough data to be useful

  return normalizeDnd5eCombatStats({
    system: 'dnd5e', level, ac: ac || 10, hp: hp || 10, maxHp: hp || 10, speed,
    abilities, proficiencyBonus, saveProficiencies: [],
    weapons: weapons.length ? weapons : [{ name: 'unarmed', attackMod: 'str', damage: '1d4', damageType: 'bludgeoning', properties: [] }],
    spells: [], spellSlots: {}, spellcastingAbility: null,
    features, conditions: [], concentrating: null,
    deathSaves: { successes: 0, failures: 0 }, inspiration: false,
    resistances: [], vulnerabilities: [], immunities: [],
  });
}

function createFallbackCombatStats({ ac, hp, abilities, weapons, spells = [], spellSlots = {}, spellcastingAbility = null, features = [], saveProficiencies = [] }) {
  return normalizeDnd5eCombatStats({
    system: 'dnd5e',
    level: 1,
    ac,
    hp,
    maxHp: hp,
    speed: 30,
    abilities,
    proficiencyBonus: 2,
    saveProficiencies,
    weapons,
    spells,
    spellSlots,
    spellcastingAbility,
    features,
    conditions: [],
    concentrating: null,
    deathSaves: { successes: 0, failures: 0 },
    inspiration: false,
    resistances: [],
    vulnerabilities: [],
    immunities: [],
  });
}

function createFallbackParty(system = 'dnd5e') {
  if (system !== 'dnd5e') {
    return [
      {
        name: 'Mira Stone',
        statsText: 'Level 1 Adventurer. HP 12. AC 14. STR 14 DEX 12 CON 14 INT 10 WIS 10 CHA 10. Shortsword (1d6 piercing).',
        personality: 'Practical and brave, Mira keeps the group moving when plans fall apart.',
        standardActions: 'Attack with shortsword, Dodge, Help ally, Search the area',
        backstory: 'Mira is a reliable traveler who stepped forward when the road became dangerous.',
        combatStats: createFallbackCombatStats({
          ac: 14,
          hp: 12,
          abilities: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
          weapons: [{ name: 'shortsword', attackMod: 'str', damage: '1d6', damageType: 'piercing', properties: [] }],
        }),
      },
    ];
  }

  return [
    {
      name: 'Thorgrim Ironbeard',
      statsText: 'Level 1 dwarf fighter. HP 13. AC 16. STR 15 DEX 12 CON 14 INT 10 WIS 13 CHA 8. Longsword (1d8 slashing), handaxe (1d6 slashing).',
      personality: 'Gruff, loyal, and direct. Thorgrim protects companions first and asks questions later.',
      standardActions: 'Attack with longsword, Throw handaxe, Dodge, Protect an ally',
      backstory: 'Thorgrim left his clanhold to earn honor on the open road and prove his shield arm still matters.',
      combatStats: createFallbackCombatStats({
        ac: 16,
        hp: 13,
        abilities: { str: 15, dex: 12, con: 14, int: 10, wis: 13, cha: 8 },
        saveProficiencies: ['str', 'con'],
        weapons: [
          { name: 'longsword', attackMod: 'str', damage: '1d8', damageType: 'slashing', properties: [] },
          { name: 'handaxe', attackMod: 'str', damage: '1d6', damageType: 'slashing', properties: ['thrown'] },
        ],
        features: ['Second Wind'],
      }),
    },
    {
      name: 'Lyssa Moonwhisper',
      statsText: 'Level 1 elf cleric. HP 10. AC 15. STR 10 DEX 12 CON 14 INT 10 WIS 15 CHA 13. Mace (1d6 bludgeoning). Spells: Sacred Flame, Healing Word, Cure Wounds.',
      personality: 'Calm under pressure and quietly stubborn. Lyssa believes mercy and resolve can share the same hand.',
      standardActions: 'Cast Sacred Flame, Cast Healing Word, Attack with mace, Help ally',
      backstory: 'Lyssa follows a moonlit pilgrimage, offering aid wherever fear has taken root.',
      combatStats: createFallbackCombatStats({
        ac: 15,
        hp: 10,
        abilities: { str: 10, dex: 12, con: 14, int: 10, wis: 15, cha: 13 },
        saveProficiencies: ['wis', 'cha'],
        weapons: [{ name: 'mace', attackMod: 'str', damage: '1d6', damageType: 'bludgeoning', properties: [] }],
        spells: [
          { name: 'sacred flame', type: 'damage', damage: '1d8', damageType: 'radiant', save: 'dex' },
          { name: 'healing word', type: 'heal', healing: '1d4' },
          { name: 'cure wounds', type: 'heal', healing: '1d8' },
        ],
        spellSlots: { 1: 2 },
        spellcastingAbility: 'wis',
      }),
    },
    {
      name: 'Kael Swiftblade',
      statsText: 'Level 1 halfling rogue. HP 9. AC 14. STR 8 DEX 15 CON 13 INT 12 WIS 10 CHA 14. Rapier (1d8 piercing), shortbow (1d6 piercing). Sneak Attack 1d6.',
      personality: 'Quick-witted, curious, and allergic to obvious doors. Kael masks caution with jokes.',
      standardActions: 'Attack with rapier, Shoot shortbow, Sneak ahead, Search for traps',
      backstory: 'Kael learned survival in crowded alleys and now uses those instincts for better causes.',
      combatStats: createFallbackCombatStats({
        ac: 14,
        hp: 9,
        abilities: { str: 8, dex: 15, con: 13, int: 12, wis: 10, cha: 14 },
        saveProficiencies: ['dex', 'int'],
        weapons: [
          { name: 'rapier', attackMod: 'dex', damage: '1d8', damageType: 'piercing', properties: ['finesse'] },
          { name: 'shortbow', attackMod: 'dex', damage: '1d6', damageType: 'piercing', properties: ['ranged'] },
        ],
        features: ['Sneak Attack 1d6'],
      }),
    },
    {
      name: 'Ember Flamecrest',
      statsText: 'Level 1 tiefling sorcerer. HP 8. AC 12. STR 8 DEX 14 CON 12 INT 13 WIS 10 CHA 15. Dagger (1d4 piercing). Spells: Fire Bolt, Burning Hands, Shield.',
      personality: 'Dramatic, sharp, and fiercely protective. Ember treats danger as an insult to answer brightly.',
      standardActions: 'Cast Fire Bolt, Cast Burning Hands, Cast Shield, Search arcane traces',
      backstory: 'Ember left a burned bridge behind and joined the party to turn raw talent into something heroic.',
      combatStats: createFallbackCombatStats({
        ac: 12,
        hp: 8,
        abilities: { str: 8, dex: 14, con: 12, int: 13, wis: 10, cha: 15 },
        saveProficiencies: ['con', 'cha'],
        weapons: [{ name: 'dagger', attackMod: 'dex', damage: '1d4', damageType: 'piercing', properties: ['finesse'] }],
        spells: [
          { name: 'fire bolt', type: 'damage', damage: '1d10', damageType: 'fire', attack: true },
          { name: 'burning hands', type: 'damage', damage: '3d6', damageType: 'fire', save: 'dex' },
          { name: 'shield', type: 'defense' },
        ],
        spellSlots: { 1: 2 },
        spellcastingAbility: 'cha',
      }),
    },
  ];
}

async function ensurePlayablePartyForStart(gameId, gameConfig, gs, socket = null) {
  gs.data = gs.data || { characters: {}, chatHistory: [], currentTurnIndex: 0, turnOrder: [] };
  gs.data.characters = gs.data.characters || {};
  gs.data.turnOrder = Array.isArray(gs.data.turnOrder) ? gs.data.turnOrder : [];

  const existingNames = Object.keys(gs.data.characters);
  if (existingNames.length > 0) {
    let changed = false;
    for (const name of existingNames) {
      if (!gs.data.turnOrder.includes(name)) {
        gs.data.turnOrder.push(name);
        changed = true;
      }
    }
    if (!Number.isInteger(gs.data.currentTurnIndex) || gs.data.currentTurnIndex >= gs.data.turnOrder.length) {
      gs.data.currentTurnIndex = 0;
      changed = true;
    }
    if (changed) {
      await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);
    }
    return { created: false, count: existingNames.length };
  }

  const fallbackParty = createFallbackParty(gameConfig?.system || 'dnd5e');
  const charStats = {};
  let count = 0;

  gs.data.currentTurnIndex = 0;
  for (const character of fallbackParty) {
    const cloned = JSON.parse(JSON.stringify(character));
    const { name, ...charData } = cloned;
    charData.token = charData.token || null;

    gs.data.characters[name] = charData;
    if (!gs.data.turnOrder.includes(name)) gs.data.turnOrder.push(name);
    if (charData.combatStats) charStats[name] = charData.combatStats;

    await db.upsertCharacter(gameId, name, charData);
    io.to(gameId).emit('character_registered', { name, character: charData });
    emitSystem(gameId, { text: `📜 ${name} has joined the campaign.` });
    count++;
  }

  await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);
  const payload = { count, fallback: true, reason: 'missing_party_on_start' };
  if (socket) socket.emit('party_generated', payload);
  io.to(gameId).emit('party_ready', {
    count,
    statsParsed: Object.keys(charStats).length,
    combatStats: charStats,
    fallback: true,
    reason: 'missing_party_on_start',
  });
  console.log(`Fallback party generated: ${count} characters before game start`);
  return { created: true, count };
}

const DEPLOY_TIME = new Date().toISOString();

// ── Magic number constants ──────────────────────────────────────────────────────
const MAX_CHAT_HISTORY = 16;
const MAX_CONTEXT_CHARS = 50000;
const MAX_CHAR_FIELD = 5000;
const MAX_RULE_TEXT = 200;
const MAX_ANON_MINUTES = 120;
const WELCOME_BONUS_MINUTES = 600;
const GAME_EVICTION_MINUTES = 60;

function truncate(str, max) { return str ? String(str).slice(0, max) : ''; }

function extractSubmittedActionText(userMessage) {
  return String(userMessage || '').replace(/^.*?:\s*/, '').trim();
}

function hasNonHostileProgressIntent(userMessage) {
  const actionText = extractSubmittedActionText(userMessage);
  return isDialogueAction(actionText) || isAdvanceAction(actionText);
}

function hasExplicitHostileAction(userMessage) {
  return isExplicitHostileAction(extractSubmittedActionText(userMessage));
}

function hasHardCombatSignal(text) {
  const value = String(text || '').replace(/\b(?:not|no|never|without|isn't|wasn't|weren't)\s+(?:an?\s+)?(?:ambush|attack|fight|combat|trap|hostility|hostile)\b/gi, '');
  return /(?:roll(?:s|ing)?\s+(?:for\s+)?initiative|initiative.*(?:order|roll)|combat\s+(?:begins|starts|erupts|breaks out)|(?:goblin|orc|skeleton|zombie|wolf|rat|bandit|dragon|spider|kobold|gnoll|bugbear|hobgoblin|cultist|thug|guard|knight|wraith|ghoul|ghast|wight|vampire|demon|devil|elemental|giant|minotaur|owlbear|manticore|hydra|chimera|basilisk|beholder|lich|golem|treant|werewolf)s?\s+(?:attack|attacks|lunge|lunges|charge|charges|rush|rushes|swing|swings|slash|slashes|stab|stabs|strike|strikes|pounce|pounces|ambush|ambushes)\b|(?:attacks?\s+(?:you|the party|with)|charges?\s+(?:at|toward|into)|ambush(?:ed|es)?!?|lunges?\s+(?:at|toward)|strikes?\s+(?:at|with)|draws?\s+(?:its |their )?(?:sword|weapon|blade|axe|bow)|weapons?\s+drawn|swords?\s+(?:raised|drawn|flashing)|prepare(?:s)?\s+to\s+(?:fight|attack|strike)|openly\s+hostile|turns?\s+hostile|ready\s+(?:their|your)\s+weapons?))/i.test(value);
}

function extractNumberedOptions(text) {
  return String(text || '').split('\n')
    .filter(l => /^[1-3](?:\uFE0F?\u20E3|[.)])\s*/.test(l.trim()))
    .map(l => l.replace(/^[1-3](?:\uFE0F?\u20E3|[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 3);
}

function extractJsonObject(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_err) {
    return null;
  }
}

function sanitizeBugSlug(value, fallback = 'gameplay_behavior_review') {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
  return slug || fallback;
}

function looksLikeBehaviorReview(message) {
  return /\b(?:why\s+did|should\s+(?:not|have)|should've|bug|broken|wrong|mistake|issue|problem|parser|classified|classification|intent|behavior|behaviour|decision|derail|combat|retcon|rules?|context|forgot|improvement|fix|slug)\b/i.test(message || '');
}

const app = express();
app.set('trust proxy', 1); // Railway runs behind a reverse proxy
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingTimeout: 120000, pingInterval: 25000 });

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

app.get('/new-game', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'new-game.html'));
});

app.get('/help', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'help.html'));
});

// Diagnostic: combat engine errors (no auth — returns only error count in prod, full details with ?key=)
app.get('/api/diag/combat-errors', (req, res) => {
  const errors = global._combatErrors || [];
  if (req.query.key === process.env.ADMIN_DIAG_KEY) {
    res.type('text/plain').send(errors.length ? errors.join('\n') : 'No errors.');
  } else {
    res.json({ count: errors.length, hint: 'Add ?key= for details' });
  }
});

app.get('/api/diag/parse-errors', (req, res) => {
  const errors = global._parseErrors || [];
  if (req.query.key === process.env.ADMIN_DIAG_KEY) {
    res.type('text/plain').send(errors.length ? errors.join('\n') : 'No parse errors.');
  } else {
    res.json({ count: errors.length });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

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

const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'), false);
  },
});

const billingTicker = new BillingTicker(io, db);

const DEFAULT_TURN_DURATION = 180; // seconds
const IMAGE_COOLDOWN = 2;

// ── Per-game in-memory state ─────────────────────────────────────────────────
const games = {}; // gameId -> { data, turnTimer, turnCount, imageUrl }
const gameStreamingLocks = {}; // gameId -> Promise that resolves when current stream completes

function getGameState(gameId) {
  if (!games[gameId]) {
    games[gameId] = {
      data: { characters: {}, chatHistory: [], currentTurnIndex: 0, turnOrder: [] },
      turnTimer: null,
      turnCount: 0,
      imageUrl: null,
      imageLabel: null,
      imageStyle: 'oil-painting',
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
      targetPreferences: {},
      pendingCinematicFinish: null,
      combatHistory: {},
      encounterPlan: null,
      encounterPlanIndex: 0,
      difficultyCorrection: 1.0,
      npcMemory: {},
      introducedEnemies: new Set(),
    };
  }
  return games[gameId];
}

function hostRoom(gameId) {
  return `${gameId}:hosts`;
}

function socketIsHost(socket, game) {
  if (!game) return false;
  if (socket.isAdmin) return true;
  if (TEST_MODE && !game.host_user_id) return true;
  return Boolean(socket.userId && game.host_user_id && socket.userId === game.host_user_id);
}

async function ensureHostSocket(socket, ack) {
  const gameId = socket.gameId;
  const deny = (error) => {
    if (typeof ack === 'function') ack({ ok: false, error });
    socket.emit('error_msg', { text: error });
    return null;
  };

  if (!gameId) return deny('Join a game before using planner controls.');
  const game = await db.getGame(gameId);
  if (!game) return deny('Game not found.');
  if (!socketIsHost(socket, game)) return deny('Only the host can use the encounter planner.');
  return { gameId, game, gs: getGameState(gameId) };
}

function plannerMetadataFromUploads(uploads) {
  const sourceMaterialNames = (uploads || [])
    .map(u => u.filename)
    .filter(Boolean)
    .slice(0, 6);
  return {
    sourceMode: sourceMaterialNames.length ? 'adaptive-module' : 'sandbox',
    sourceMaterialCount: sourceMaterialNames.length,
    sourceMaterialNames,
  };
}

async function buildPlannerDay(gameId, gameConfig, gs, hostOverrides = {}) {
  const partyStats = Object.values(gs.data.characters || {})
    .map(c => c.combatStats)
    .filter(Boolean);
  if (partyStats.length === 0) {
    return { ok: false, error: 'Add characters with combat stats before planning encounters.' };
  }

  const monsterDB = require('./monster-lookup').loadDefaultMonsters(gameConfig.system || 'dnd5e');
  const uploads = await db.getState(gameId, 'pdf_uploads', []);
  const metadata = plannerMetadataFromUploads(uploads);
  const day = ed.designAdventuringDay(partyStats, gs.ferocity, gs.pillars, monsterDB, {
    correction: gs.difficultyCorrection || 1.0,
    hostOverrides,
    sourceMaterialNames: metadata.sourceMaterialNames,
  });
  return { ok: true, day, metadata };
}

async function ensureActiveEncounterPlan(gameId, gameConfig, gs) {
  if (gs.encounterPlan) {
    gs.encounterPlan = plannerState.advanceCompletedDays(gs.encounterPlan);
    gs.encounterPlanIndex = gs.encounterPlan._currentIndex || 0;
  }
  if (!encounterDirector.planNeedsAdventuringDay(gs.encounterPlan)) {
    return { ok: true, created: false, plan: gs.encounterPlan };
  }

  const plannerDay = await buildPlannerDay(gameId, gameConfig, gs);
  if (!plannerDay.ok) return plannerDay;

  gs.encounterPlan = plannerState.createEncounterPlan(plannerDay.day, plannerDay.metadata);
  gs.encounterPlanIndex = 0;
  gs._turnsSinceLastEncounter = 0;
  await persistEncounterPlan(gameId);
  emitPlannerUpdate(gameId);
  return { ok: true, created: true, plan: gs.encounterPlan };
}

function extractNamedCombatTarget(text, partyNames = []) {
  const source = String(text || '').replace(/\([^)]*\)/g, ' ');
  const partyAliases = new Set(
    (partyNames || []).flatMap(name => String(name || '').toLowerCase().split(/\s+/).filter(part => part.length >= 4))
  );
  const patterns = [
    /\b(?:attack|attacks|strike|strikes|hit|hits|stab|stabs|slash|slashes|shoot|shoots|blast|blasts)\s+(?:at\s+)?(?:the\s+)?([a-z][a-z'’ -]{2,60}?)(?=\s+(?:with|using|and|but|before|while|as|again|back|to\b)|[.,;!]|$)/i,
    /\bcast\s+[-a-z'’ ]+\s+(?:at|against|on|toward|towards)\s+(?:the\s+)?([a-z][a-z'’ -]{2,60}?)(?=\s+(?:with|using|and|but|before|while|as|again|back|to\b)|[.,;!]|$)/i,
    /\b(?:acid splash|burning hands|chill touch|eldritch blast|fire bolt|fireball|guiding bolt|inflict wounds|magic missile|poison spray|ray of frost|sacred flame|shocking grasp|thunderwave|toll the dead)\s+(?:at|against|on|toward|towards)\s+(?:the\s+)?([a-z][a-z'’ -]{2,60}?)(?=\s+(?:with|using|and|but|before|while|as|again|back|to\b)|[.,;!]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match) continue;
    const raw = match[1]
      .replace(/\b(?:with|using|and|but|before|while|again|back|contained|the|a|an)\b.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!raw || raw.length < 3) continue;
    const lower = raw.toLowerCase();
    if (/^(?:you|yourself|ally|allies|party|door|room|area|danger|threat|it|them|self)$/.test(lower)) continue;
    if (partyAliases.has(lower)) continue;
    return raw.replace(/\b\w/g, c => c.toUpperCase());
  }
  return null;
}

function isUntargetedOffensiveAction(text, partyNames = []) {
  const actionText = extractSubmittedActionText(text);
  if (!actionText || hasNonHostileProgressIntent(actionText)) return false;
  if (extractNamedCombatTarget(actionText, partyNames)) return false;

  const lower = actionText.toLowerCase();
  if (/^(?:attack|attacks|strike|strikes|hit|hits|stab|stabs|slash|slashes|shoot|shoots|blast|blasts|sneak attack)\b/.test(lower)) {
    return true;
  }
  return /^(?:cast\s+)?(?:acid splash|burning hands|chill touch|eldritch blast|fire bolt|fireball|guiding bolt|inflict wounds|magic missile|poison spray|ray of frost|sacred flame|shocking grasp|thunderwave|toll the dead)\b/.test(lower);
}

function targetRequiredNarration(userMessage) {
  const actionText = extractSubmittedActionText(userMessage) || 'That action';
  return {
    narration: `${actionText} needs a clear target. Who are you targeting?`,
    options: [],
    scene: null,
    world: null,
    isKillshot: false,
    mapMoved: false,
    llmRunId: null,
    blocked: true,
  };
}

function looksLikeHostileOption(option) {
  const text = String(option || '').replace(/^[\s\d.)\uFE0F\u20E3]+/u, '').trim();
  if (!text) return false;
  if (hasNonHostileProgressIntent(text)) return false;
  if (/\b(?:check|inspect|investigate|search|examine|study|observe|look|listen|scan|track|ask|talk|explain|negotiate|persuade|convince|offer|bargain|move on|press on|continue|proceed|travel|head toward)\b/i.test(text)) {
    return false;
  }
  return /\b(?:attack|strike|hit|stab|slash|shoot|blast|kill|wound|damage|charge|dodge|take cover|ready (?:a|the|your)?\s*weapon|draw (?:a|the|your)?\s*(?:sword|blade|weapon)|mace|longsword|shortsword|rapier|dagger|spear|crossbow|shortbow|longbow|axe beak|goblin|orc|skeleton|zombie|bandit|cultist|cast\s+(?:acid splash|burning hands|chill touch|eldritch blast|fire bolt|fireball|guiding bolt|inflict wounds|magic missile|poison spray|ray of frost|sacred flame|shocking grasp|thunderwave|toll the dead))\b/i.test(text);
}

function filterOptionsForSceneState(options, gs, narration = '') {
  if (!Array.isArray(options) || !options.length) return options || [];
  if (gs?.combatEngine?.state?.active || hasHardCombatSignal(narration)) return options;
  const filtered = options.filter(option => !looksLikeHostileOption(option));
  return filtered.length >= 2 ? filtered.slice(0, 3) : [];
}

async function maybeStartCombatFromOffensiveAction(gameId, gameConfig, userMessage, gs = getGameState(gameId)) {
  if (gs.combatEngine?.state?.active) return false;
  const targetName = extractNamedCombatTarget(userMessage, Object.keys(gs.data.characters || {}));
  if (!targetName) return false;
  await initiateCombat(gameId, gameConfig, [normalizeEnemyEntry({
    displayName: targetName,
    count: 1,
    slug: 'custom',
    hint: targetName,
  })]);
  return !!gs.combatEngine?.state?.active;
}

function markPlannedEncounterResolved(gs, index) {
  if (!gs.encounterPlan) return;
  const activeDay = plannerState.getActiveDay(gs.encounterPlan);
  const encounter = activeDay?.encounters?.[index];
  if (!encounter) return;
  encounter.completed = true;
  encounter.status = 'resolved';
  activeDay.currentIndex = index + 1;
  gs.encounterPlanIndex = index + 1;
}

async function resolvePendingPlannedChallenge(gameId, gameConfig, gs) {
  const pending = gs._pendingChallenge;
  if (!pending) return;
  const pendingIndex = Number.isInteger(gs._pendingChallengeIndex)
    ? gs._pendingChallengeIndex
    : (gs.encounterPlanIndex || 0);

  if (pending.pillar === 'combat') {
    if (!gs.combatEngine?.state?.active) {
      markPlannedEncounterResolved(gs, pendingIndex);
      await persistAndEmitPlannerProgress(gameId);
    }
    encounterDirector.clearPacingDirective(gs);
    return;
  }

  if (pending.pillar === 'social' || pending.pillar === 'exploration') {
    markPlannedEncounterResolved(gs, pendingIndex);
    encounterDirector.clearPacingDirective(gs);
    await persistAndEmitPlannerProgress(gameId);
  }
}

async function persistEncounterPlan(gameId) {
  const gs = getGameState(gameId);
  if (!gs.encounterPlan) return null;
  gs.encounterPlan = plannerState.normalizeEncounterPlan(gs.encounterPlan);
  gs.encounterPlanIndex = gs.encounterPlan._currentIndex || 0;
  await db.setState(gameId, 'encounterPlan', gs.encounterPlan);
  return gs.encounterPlan;
}

function emitPlannerUpdate(gameId) {
  const gs = getGameState(gameId);
  const hostPlan = plannerState.toHostPlan(gs.encounterPlan);
  io.to(hostRoom(gameId)).emit('encounter_plan_updated', hostPlan);
  return hostPlan;
}

async function persistAndEmitPlannerProgress(gameId) {
  const gs = getGameState(gameId);
  if (!gs.encounterPlan) return null;
  const activeDay = plannerState.getActiveDay(gs.encounterPlan);
  if (activeDay) activeDay.currentIndex = gs.encounterPlanIndex || 0;
  gs.encounterPlan = plannerState.advanceCompletedDays(gs.encounterPlan);
  await persistEncounterPlan(gameId);
  return emitPlannerUpdate(gameId);
}

// ── Streaming queue helper (ensures one stream per game at a time) ──────────────
async function withStreamingLock(gameId, streamFn) {
  // Wait for any previous stream to complete
  if (gameStreamingLocks[gameId]) {
    try {
      await gameStreamingLocks[gameId];
    } catch (err) {
      // Ignore previous stream errors
    }
  }

  // Create a new lock promise for this stream
  let resolveLock;
  const lockPromise = new Promise((resolve) => {
    resolveLock = resolve;
  });
  gameStreamingLocks[gameId] = lockPromise;

  try {
    const result = await streamFn();
    resolveLock();
    return result;
  } catch (err) {
    resolveLock();
    throw err;
  }
}

// ── Broadcast helpers (Socket.io + Discord) ──────────────────────────────────
function emitDmMessage(gameId, data) {
  // Save last options for reconnects
  const gs = games[gameId];
  let messageData = data;
  if (messageData?.text) {
    const cleanText = cleanInvalidCombatNarration(messageData.text);
    if (cleanText !== messageData.text) {
      messageData = { ...messageData, text: cleanText, narrationSanitized: true };
    }
  }
  if (gs && data?.forPlayer && data.options?.length) {
    const character = gs.data.characters?.[data.forPlayer] || null;
    const scoped = sanitizeOptionsForPlayer(data.options, data.forPlayer, Object.keys(gs.data.characters || {}), {
      previousPlayer: data.previousPlayer || data.player || null,
      character,
      combatEngine: gs.combatEngine,
      combatants: gs.combatEngine?.state?.combatants || {},
    });
    if (scoped.retargeted) {
      gs.preTaggedOptions = null;
      console.warn(`[options-retarget] ${gameId}: options for ${data.forPlayer} mentioned ${scoped.mismatchedNames.join(', ')}`);
      messageData = {
        ...data,
        options: scoped.options,
        optionsRetargeted: true,
        optionsRetargetedFrom: scoped.mismatchedNames,
      };
    }
  }
  if (gs && messageData?.options?.length) {
    const sceneOptions = filterOptionsForSceneState(messageData.options, gs, messageData.text || '');
    if (sceneOptions.length !== messageData.options.length) {
      gs.preTaggedOptions = null;
      messageData = {
        ...messageData,
        options: sceneOptions,
        optionsFilteredForScene: true,
      };
    }
  }
  if (gs && messageData.options?.length) {
    gs.lastOptions = messageData.options;
    gs.lastForPlayer = messageData.forPlayer;
  } else if (gs && Object.prototype.hasOwnProperty.call(messageData || {}, 'options')) {
    gs.lastOptions = [];
    gs.lastForPlayer = null;
  }
  io.to(gameId).emit('dm_message', messageData);
  discord.onDmMessage(gameId, messageData).catch(e => console.error('Discord dm_message error:', e.message));
}
function emitTurnChange(gameId, data) {
  io.to(gameId).emit('turn_change', data);
  discord.onTurnChange(gameId, data).catch(e => console.error('Discord turn_change error:', e.message));
}

function publishCurrentTurn(gameId, gameConfig, { startTimer = true } = {}) {
  const gs = getGameState(gameId);
  const current = getCurrentPlayer(gameId);
  if (!current) return null;
  const token = gs.data.characters[current]?.token || null;
  emitTurnChange(gameId, { player: current, duration: gs.turnDuration * 1000, token });
  if (startTimer) startTurnTimer(gameId, gameConfig, current);
  return current;
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
// Destructure the prompt selection functions from prompt-builder
const { SYSTEM_PROMPTS, buildMinimalPrompt, buildFullPrompt, buildTrimmedPrompt: buildTrimmedPromptImpl } = promptBuilder;

// Wrapper functions that call the implementations in promptBuilder
function buildSystemPrompt(gameId, gameConfig) {
  return buildFullPrompt(gameId, gameConfig, getGameState, ed);
}

function buildTrimmedPrompt(gameId, gameConfig) {
  return buildTrimmedPromptImpl(gameId, gameConfig, getGameState, ed);
}

// ── Parsing (single-pass, order-independent) ─────────────────────────────────
function parseResponse(text) {
  // Split on all three markers in one pass — flexible matching
  let narration = text;
  let optionsRaw = '';
  let sceneRaw = '';
  let worldRaw = '';

  // Find marker positions with flexible matching (case-insensitive, optional spaces).
  // Markers sometimes arrive inline or jammed together (---OPTIONS------SCENE---),
  // so do not require line starts.
  const markerRegex = /(?:-{3,}\s*(OPTIONS|SCENE|WORLD)\s*-{3,}?|#{1,3}\s*(OPTIONS?|SCENE|WORLD)\s*(?=\n|$))/gim;
  const positions = [];
  for (const match of text.matchAll(markerRegex)) {
    let name = (match[1] || match[2] || '').toLowerCase();
    if (name === 'option') name = 'options';
    positions.push({ name, idx: match.index, len: match[0].length });
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
    // Parse ENEMIES block — flexible matching for model output formats
    // Matches: "ENEMIES:", "ENEMIES (...):", "ENEMIES (when combat starts):", etc.
    const enemiesMatch = worldRaw.match(/ENEMIES[^:\n]*:\s*\n((?:[-*•]\s*.+\n?)+)/i);
    let enemies = [];
    if (enemiesMatch) {
      const enemyLines = enemiesMatch[1].trim().split('\n');
      for (const line of enemyLines) {
        // Standard format: - Name | count | slug
        const match = line.match(/^[-*•]\s*(.+?)\s*\|\s*(\d+)\s*\|\s*(.+?)(?:\s*\|\s*(.+))?$/);
        if (match) {
          const displayName = match[1].trim();
          const slug = match[3].trim();
          if (!isPlaceholderEnemyName(displayName) && !isPlaceholderEnemyName(slug)) {
            enemies.push({
              displayName,
              count: parseInt(match[2], 10),
              slug,
              hint: match[4]?.trim() || null,
            });
          }
        } else {
          // Fallback: - Name (count) or - Name x3 or just - Name
          const fallback = line.match(/^[-*•]\s*(.+?)(?:\s*\((\d+)\)|\s*x(\d+))?$/);
          if (fallback) {
            const name = fallback[1].replace(/\s*\|.*$/, '').trim();
            if (name && name.length > 1 && !/^(?:none|no enemies)$/i.test(name)) {
              enemies.push({
                displayName: name,
                count: parseInt(fallback[2] || fallback[3] || '1', 10),
                slug: name.toLowerCase().replace(/\s+/g, '-'),
                hint: null,
              });
            }
          }
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
  const normalizedEnemies = normalizeEnemyEntries(enemies || []);

  // Gate: signal clients that combat is initializing (OOC-only mode)
  gs.combatInitializing = true;
  io.to(gameId).emit('combat_initializing', {
    message: 'Rolling initiative... preparing for combat.',
    enemies: normalizedEnemies.map(e => `${e.count}x ${e.displayName}`),
  });

  const enemyCombatants = [];

  for (const entry of normalizedEnemies) {
    for (let i = 0; i < entry.count; i++) {
      const stats = await getMonsterStats(gameId, system, entry.slug, {
        db, hint: entry.hint,
      });
      if (stats) {
        const id = entry.count > 1 ? `${entry.slug}-${i + 1}` : entry.slug;
        const name = entry.count > 1 ? `${entry.displayName} ${i + 1}` : entry.displayName;
        enemyCombatants.push({ ...stats, id, name, type: 'Enemy' });

        // For solo/named enemies, generate a unique personality twist.
        if (entry.count === 1 && stats.personality) {
          try {
            const variantResponse = await llm.completeText({
              task: 'summary',
              gameId,
              maxTokens: 100,
              temperature: 0.7,
              prompt: `This ${stats.name} has a base personality: "${stats.personality}". Give this specific ${name} a unique twist in 1-2 sentences — a quirk, obsession, or unusual trait that makes it memorable. Reply with ONLY the personality text.`,
            });
            const uniquePersonality = variantResponse.text?.trim();
            if (uniquePersonality) {
              enemyCombatants[enemyCombatants.length - 1].personality = uniquePersonality;
            }
          } catch (e) { /* Use base personality on error */ }
        }
      }
    }
  }
  if (enemyCombatants.length === 0) {
    gs.combatInitializing = false;
    io.to(gameId).emit('combat_init_failed', { message: 'No valid enemies found.' });
    return null;
  }

  // Check for new monster entries
  const newEntries = [];
  for (const enemy of enemyCombatants) {
    const key = (enemy.slug || enemy.name).toLowerCase();
    if (!gs.introducedEnemies.has(key)) {
      gs.introducedEnemies.add(key);
      newEntries.push(enemy);
    }
  }

  // Fire entry image if there are new enemies
  if (newEntries.length > 0 && process.env.TOGETHER_API_KEY) {
    const entryNames = newEntries.map(e => e.name).join(', ');
    const actionText = newEntries.length > 1 ? 'appear' : 'appears';
    const sceneData = {
      action: `${entryNames} ${actionText} before the party`,
      mood: 'tense, dramatic reveal',
      npc: newEntries[0].name,
    };
    generateCompositeScene(gameId, sceneData, gameConfig).then(url => {
      if (url) {
        gs.imageUrl = url;
        gs.imageLabel = `NEW FOE: ${entryNames}`;
        db.updateGameImage(gameId, url).catch(e => console.error('[monster-entry-persist]', e));
        emitSceneImage(gameId, { url, label: gs.imageLabel, type: 'monster_entry' });
      }
    }).catch(err => console.error('[scene-gen-monster]', err.message));
  }

  const pcCombatants = [];
  for (const [name, char] of Object.entries(gs.data.characters)) {
    let combatStats = char.combatStats;
    if (!combatStats) {
      try {
        combatStats = await parseStatsText(char.statsText || '', system, { gameId });
        char.combatStats = combatStats;
        db.upsertCharacter(gameId, name, char).catch(() => {});
      } catch (e) {
        console.error(`Failed to parse combatStats for ${name}:`, e.message);
        continue;
      }
    }
    if (system === 'dnd5e') {
      combatStats = normalizeDnd5eCombatStats(combatStats);
      char.combatStats = combatStats;
      db.upsertCharacter(gameId, name, char).catch(() => {});
    }
    const id = name.toLowerCase().replace(/\s+/g, '-');
    pcCombatants.push({ ...combatStats, id, name, type: 'PC' });
  }

  if (pcCombatants.length === 0) {
    gs.combatInitializing = false;
    io.to(gameId).emit('combat_init_failed', { message: 'No player characters available for combat.' });
    emitSystem(gameId, { text: 'Combat could not start because there are no player characters yet.' });
    return null;
  }

  const state = gs.combatEngine.initCombat(pcCombatants, enemyCombatants, system);
  gs.currentCombatId = crypto.randomUUID();
  gs.combatXpAwardedForCombatId = null;
  gs.lastCombatXpAward = null;
  db.setState(gameId, 'currentCombatId', gs.currentCombatId).catch(() => {});
  db.setState(gameId, 'combatXpAwardedForCombatId', null).catch(() => {});
  db.setState(gameId, 'lastCombatXpAward', null).catch(() => {});
  io.to(gameId).emit('combat_started', combatSocketPayload(gameId));
  gs.combatInitializing = false;
  emitSystem(gameId, { text: '⚔️ Combat begins!' });
  persistCombatState(gameId);
  return state;
}

async function resolveEnemyTurns(gameId, gameConfig) {
  const gs = getGameState(gameId);
  const engine = gs.combatEngine;
  if (!engine.state.active) return [];

  const results = [];
  const resolver = engine.getResolver();

  // OPTIMIZATION: Parallelize enemy API calls
  // Step 1: Collect all active enemy combatants and their decision prompts
  const enemyDecisions = [];
  const tempEngine = {
    turnIndex: engine.state.turnIndex,
    round: engine.state.round,
    activeEffects: JSON.parse(JSON.stringify(engine.state.activeEffects || [])),
  }; // Snapshot current position without preserving speculative initiative movement

  while (true) {
    const current = engine.getCurrentTurn();
    if (!current || current.type !== 'Enemy') break;
    if (resolver.checkDeath(current).status === 'dead') {
      engine.advanceTurn({ processStart: false, processEnd: false });
      continue;
    }

    const availableActions = resolver.getAvailableActions(current);
    const pcs = Object.values(engine.state.combatants).filter(c => c.type === 'PC' && (c.hp > 0 || (c.totalHp && c.totalHp > 0)));

    if (pcs.length === 0) break;

    const personality = current.personality || '';
    const tactics = current.tactics || '';
    const morale = current.morale || 'normal';
    const hpPct = (current.hp ?? current.totalHp ?? 1) / (current.maxHp ?? current.totalHp ?? 1);

    let moraleAction = '';
    if (morale === 'cowardly' && hpPct < 0.5) moraleAction = ' PREFER: disengage or dash (fleeing — cowardly at <50% HP).';
    else if (morale === 'normal' && hpPct < 0.25) moraleAction = ' PREFER: disengage or dash (fleeing — low HP).';
    else if (morale === 'berserker') moraleAction = ' PREFER: reckless attacks — berserker never retreats.';

    const tacticalPrompt = `Choose ONE action for ${current.name}.
${personality ? 'Personality: ' + personality : ''}
${tactics ? 'Tactics: ' + tactics : ''}
${moraleAction}
HP: ${current.hp ?? current.totalHp}/${current.maxHp ?? current.totalHp}
Can: ${availableActions.slice(0, 6).map(a => a.label || a.name || a.type).join(', ')}
Targets: ${pcs.map(p => `${p.name}(${p.id},${p.hp ?? p.totalHp}HP${p.concentrating ? ',conc:' + (p.concentrating.name || p.concentrating) : ''})`).join(', ')}
Reply ONLY: ACTION: ${current.id} [action-type] [target-id]`;

    // Queue up API call without awaiting
    enemyDecisions.push({
      enemyId: current.id,
      name: current.name,
      weaponName: current.weapons?.[0]?.name,
      prompt: tacticalPrompt,
      morale,
      hpPct,
      pcs: pcs.map(p => ({
        id: p.id,
        name: p.name,
        hp: p.hp ?? p.totalHp,
        maxHp: p.maxHp ?? p.totalHp,
        concentrating: !!p.concentrating,
      })),
    });

    if (engine.isCombatOver().over) break;
    engine.advanceTurn({ processStart: false, processEnd: false });
  }

  // Step 2: Fetch ALL tactical decisions in parallel
  const decisions = await Promise.all(
    enemyDecisions.map(async (enemy) => {
      const enemyTacticsLlmEnabled = process.env.ENEMY_TACTICS_LLM === 'true';
      if (process.env.ENEMY_TACTICS_LLM !== 'true') {
        return chooseDeterministicEnemyDecision(enemy);
      }

      let actionType = 'attack';
      let targetId = chooseEnemyTargetId(enemy.pcs) || Object.values(engine.state.combatants).find(c => c.type === 'PC')?.id;

      try {
        const response = await llm.completeText({
          task: 'enemy-tactics',
          gameId,
          maxTokens: 80,
          temperature: 0.2,
          prompt: enemy.prompt,
        });
        const text = response.text.trim();
        const m = text.match(/ACTION:\s*\S+\s+(\S+)\s+(\S+)/);
        if (m) { actionType = m[1]; targetId = m[2]; }
      } catch (e) {
        console.error(`Enemy tactics error for ${enemy.name}:`, e.message);
      }

      return { enemyId: enemy.enemyId, actionType, targetId, weaponName: enemy.weaponName };
    })
  );

  // Step 3: Reset engine to initial position and apply decisions sequentially (deterministic)
  engine.state.turnIndex = tempEngine.turnIndex;
  engine.state.round = tempEngine.round;
  engine.state.activeEffects = tempEngine.activeEffects;

  while (true) {
    const current = engine.getCurrentTurn();
    if (!current || current.type !== 'Enemy') break;
    if (resolver.checkDeath(current).status === 'dead') {
      const turnEffects = engine.advanceTurn();
      if (turnEffects.length) results.push(...turnEffects);
      continue;
    }

    const pcs = Object.values(engine.state.combatants).filter(c => c.type === 'PC' && (c.hp > 0 || (c.totalHp && c.totalHp > 0)));
    if (pcs.length === 0) break;

    // Find this enemy's pre-computed decision
    const decision = decisions.find(d => d.enemyId === current.id);
    const actionType = normalizeEnemyActionType(decision?.actionType || 'attack');
    const targetId = enemyTargeting.resolveEnemyDecisionTarget(decision?.targetId, pcs) || pcs[0]?.id;
    const weaponName = decision?.weaponName;

    const result = engine.resolveAction({
      type: actionType,
      attackerId: current.id,
      actorId: current.id,
      targetId,
      weapon: weaponName,
    });
    if (result && !result.error) results.push(result);

    if (engine.isCombatOver().over) break;
    const turnEffects = engine.advanceTurn();
    if (turnEffects.length) results.push(...turnEffects);
  }

  return results;
}

function chooseEnemyTargetId(pcs = []) {
  return enemyTargeting.chooseEnemyTargetId(pcs);
}

function chooseDeterministicEnemyDecision(enemy) {
  if ((enemy.morale === 'cowardly' && enemy.hpPct < 0.5) || (enemy.morale === 'normal' && enemy.hpPct < 0.25)) {
    return {
      enemyId: enemy.enemyId,
      actionType: 'disengage',
      targetId: chooseEnemyTargetId(enemy.pcs),
      weaponName: enemy.weaponName,
    };
  }

  return {
    enemyId: enemy.enemyId,
    actionType: 'attack',
    targetId: chooseEnemyTargetId(enemy.pcs),
    weaponName: enemy.weaponName,
  };
}

function normalizeEnemyActionType(actionType) {
  const text = String(actionType || '').toLowerCase();
  if (/^(attack|weapon|melee|ranged|shoot|strike|slash|stab|bite|claw)/.test(text)) return 'attack';
  if (text.startsWith('dodge')) return 'dodge';
  if (text.startsWith('disengage')) return 'disengage';
  if (text.startsWith('dash') || text.startsWith('flee')) return 'dash';
  return 'attack';
}

function emitCombatUpdate(gameId) {
  const gs = getGameState(gameId);
  const engine = gs.combatEngine;
  if (!engine.state.active) return;
  io.to(gameId).emit('combat_update', combatSocketPayload(gameId));
}

/** Fire-and-forget save of combat state to DB. */
function persistCombatState(gameId) {
  const gs = games[gameId];
  if (!gs) return;
  db.setState(gameId, 'combatState', gs.combatEngine.state).catch(() => {});
}

function recordCombatConclusion(gameId, reason = 'combat_over') {
  const gs = getGameState(gameId);
  const combatants = gs.combatEngine?.state?.combatants || {};
  const defeated = Object.values(combatants)
    .filter(c => c.type !== 'PC' && ((c.hp ?? c.totalHp ?? 0) <= 0))
    .map(c => c.name)
    .filter(Boolean);

  gs.lastCombatConclusion = {
    reason,
    defeated,
    summary: defeated.length > 0
      ? `${defeated.join(', ')} defeated. The fight is over.`
      : 'The fight is over.',
    updatedAt: new Date().toISOString(),
  };

  db.setState(gameId, 'lastCombatConclusion', gs.lastCombatConclusion).catch(() => {});
  return gs.lastCombatConclusion;
}

function combatantPayload(combatant) {
  return {
    id: combatant.id,
    name: combatant.name,
    type: combatant.type,
    hp: combatant.hp ?? combatant.totalHp,
    maxHp: combatant.maxHp ?? combatant.totalHp,
    ac: combatant.ac,
    conditions: combatant.conditions || [],
    concentrating: combatant.concentrating || null,
  };
}

function combatantsPayload(combatants = {}) {
  return Object.fromEntries(
    Object.entries(combatants).map(([id, c]) => [id, combatantPayload({ ...c, id: c.id || id })])
  );
}

function getTargetPreferencesForPlayer(gs, playerName, actorId = null) {
  const prefs = gs.targetPreferences || {};
  return targetAuthority.normalizeTargetPreferences(
    prefs[playerName] || prefs[actorId] || {}
  );
}

function getCurrentTargetSuggestions(gs) {
  const current = gs.combatEngine?.state?.active ? gs.combatEngine.getCurrentTurn() : null;
  const actorId = current?.id || null;
  const playerName = getCombatPlayerNameForCurrentTurn(gs) || current?.name || null;
  return targetAuthority.buildTargetSuggestions(
    gs.combatEngine?.state?.combatants || {},
    actorId,
    getTargetPreferencesForPlayer(gs, playerName, actorId)
  );
}

function combatSocketPayload(gameId) {
  const gs = getGameState(gameId);
  const engine = gs.combatEngine;
  return {
    initiativeOrder: engine.getDisplayInitiativeOrder(),
    round: engine.state.round,
    turnIndex: engine.state.turnIndex,
    currentTurn: engine.getCurrentTurn()?.id,
    combatants: combatantsPayload(engine.state.combatants),
    activeEffects: engine.state.activeEffects,
    log: engine.state.log.slice(-10),
    targetPreferences: gs.targetPreferences || {},
    targetSuggestions: getCurrentTargetSuggestions(gs),
  };
}

function appendTacticalHistory(gameId, playerName, actionText, narration) {
  const gs = getGameState(gameId);
  const gd = gs.data;
  gd.chatHistory.push(
    { role: 'user', content: `${playerName}: ${actionText}` },
    { role: 'assistant', content: narration }
  );
  if (gd.chatHistory.length > MAX_CHAT_HISTORY) {
    gd.chatHistory = gd.chatHistory.slice(-MAX_CHAT_HISTORY);
  }
  db.saveChatHistory(gameId, gd.chatHistory).catch(e => console.error('[tactical-history-save]', e.message));
}

async function resolveDeathSavesUntilPlayableTurn(engine, results) {
  const resolver = engine.getResolver();
  while (true) {
    const nextTurn = engine.getCurrentTurn();
    if (!nextTurn || nextTurn.type !== 'PC') break;
    const deathCheck = resolver.checkDeath(nextTurn);
    if (deathCheck.status !== 'unconscious') break;
    if (deathCheck.stable) {
      results.push(...engine.advanceTurn());
      continue;
    }
    const dsResult = engine.resolveAction({ type: 'death_save', actorId: nextTurn.id });
    results.push(dsResult);
    results.push(...engine.advanceTurn());
  }
}

async function finalizeCombatOverForFastPath(gameId, gameConfig, overCheck) {
  const gs = getGameState(gameId);
  let xpAward = null;
  if (!overCheck?.over) return { xpAward };

  recordCombatConclusion(gameId, overCheck.reason);
  if (overCheck.reason === 'enemies_defeated') {
    xpAward = await awardCombatXpForGame(gameId, overCheck.reason);
  }

  const combatSummary = gs.combatEngine.getCombatSummary();
  if (combatSummary && combatSummary.rounds > 0) {
    if (!gs.combatHistory) gs.combatHistory = {};
    for (const [id, data] of Object.entries(combatSummary.characters)) {
      if (data.type !== 'PC') continue;
      if (!gs.combatHistory[id]) gs.combatHistory[id] = { combats: [] };
      gs.combatHistory[id].combats.push({
        date: Date.now(),
        rounds: combatSummary.rounds,
        damageDealt: data.damageDealt,
        damageTaken: data.damageTaken,
        healed: data.healed,
        spellSlotsUsed: data.spellSlotsUsed,
      });
      if (gs.combatHistory[id].combats.length > 5) gs.combatHistory[id].combats.shift();
      gs.combatHistory[id].rollingDPR = ed.updateRollingDPR(gs.combatHistory[id]);
    }
    db.setState(gameId, 'combatHistory', gs.combatHistory).catch(() => {});
  }

  gs.combatEngine.endCombat();
  persistCombatState(gameId);
  io.to(gameId).emit('combat_ended', { reason: overCheck.reason, xp: xpAward });
  return { xpAward };
}

function targetRequiredOptions(result) {
  return (result.availableTargets || []).slice(0, 3).map(target => {
    if (result.actionType === 'spell') return `Cast ${result.actionName} on ${target.name}`;
    return `Attack ${target.name}`;
  });
}

function formatTacticalCombatText(gs, results, overCheck = null, xpAward = null) {
  const lines = results
    .filter(Boolean)
    .map(r => gs.combatEngine.formatResultForPrompt(r))
    .filter(Boolean);
  if (overCheck?.over) {
    lines.push(overCheck.reason === 'enemies_defeated' ? 'Combat ends: victory.' : 'Combat ends: the party is down.');
  }
  if (xpAward) lines.push(formatXpAwardForPrompt(xpAward));
  return lines.join('\n') || 'The combat state updates.';
}

async function tryResolveCombatActionFastPath(gameId, gameConfig, playerName, actionText) {
  const gs = getGameState(gameId);
  const engine = gs.combatEngine;
  if (!engine?.state?.active) return null;

  const engineCurrent = engine.getCurrentTurn();
  if (!engineCurrent || engineCurrent.type !== 'PC') return null;

  const actorId = engineCurrent.id;
  const resolver = engine.getResolver();
  const playerCombatant = engine.state.combatants[actorId];
  const isDown = playerCombatant && resolver.checkDeath(playerCombatant).status === 'unconscious';
  const ctx = {
    combatants: engine.state.combatants,
    preTaggedOptions: gs.preTaggedOptions || null,
    targetPreferences: getTargetPreferencesForPlayer(gs, playerName, actorId),
  };

  const parsedAction = isDown
    ? { type: 'death_save', actorId }
    : parseAction(actionText, actorId, ctx);

  if (!parsedAction) return null;

  const results = [];
  const playerResult = engine.resolveAction(parsedAction);
  results.push(playerResult);

  if (playerResult?.type === 'target_required') {
    persistCombatState(gameId);
    emitCombatUpdate(gameId);
    const text = `Target needed: ${playerResult.message}`;
    return {
      handled: true,
      blocked: true,
      tactical: true,
      text,
      options: targetRequiredOptions(playerResult),
      llmRunId: null,
    };
  }

  results.push(...engine.advanceTurn());
  await resolveDeathSavesUntilPlayableTurn(engine, results);
  const enemyResults = await resolveEnemyTurns(gameId, gameConfig);
  results.push(...enemyResults);
  await resolveDeathSavesUntilPlayableTurn(engine, results);

  const overCheck = engine.isCombatOver();
  const { xpAward } = overCheck.over
    ? await finalizeCombatOverForFastPath(gameId, gameConfig, overCheck)
    : { xpAward: null };

  persistCombatState(gameId);
  if (engine.state.active) emitCombatUpdate(gameId);

  const text = formatTacticalCombatText(gs, results, overCheck, xpAward);
  appendTacticalHistory(gameId, playerName, actionText, text);
  return {
    handled: true,
    blocked: false,
    tactical: true,
    text,
    options: [],
    scene: null,
    world: null,
    isKillshot: false,
    mapMoved: false,
    llmRunId: null,
  };
}

function clearEphemeralGameStateForNextBeat(gameId, gs) {
  clearTimeout(gs.turnTimer);
  const combatWasActive = !!gs.combatEngine?.state?.active;
  if (combatWasActive) {
    recordCombatConclusion(gameId, 'move_to_next_beat');
    gs.combatEngine.endCombat();
    persistCombatState(gameId);
    io.to(gameId).emit('combat_ended', { reason: 'move_to_next_beat', xp: null });
  }
  gs.combatInitializing = false;
  gs.preTaggedOptions = null;
  gs.lastOptions = [];
  gs.lastForPlayer = null;
  gs.pendingCinematicFinish = null;
  gs.paused = false;
  gs.idleTurns = 0;
  gs._pendingChallenge = null;
  gs._encounterPacingDirective = null;
  gs._turnFlags = {};
  db.setState(gameId, 'lastOptions', []).catch(() => {});
  db.setState(gameId, 'lastForPlayer', null).catch(() => {});
  return { combatWasActive };
}

async function moveToNextBeat(gameId, gameConfig, actorName = 'Host') {
  const gs = getGameState(gameId);
  clearEphemeralGameStateForNextBeat(gameId, gs);
  const nextPlayer = getVisiblePlayerForOptions(gameId) || getCurrentPlayer(gameId);
  const recent = (gs.data.chatHistory || []).slice(-6).map(m => `${m.role}: ${m.content}`).join('\n').slice(-2500);
  let narration = '';
  let llmRunId = null;
  try {
    const response = await llm.completeText({
      task: 'move-to-next-beat',
      gameId,
      maxTokens: 500,
      temperature: 0.4,
      prompt: `The host clicked Move to Next Beat to recover from a stuck or buggy scene in this ${gameConfig.system || 'D&D'} campaign.

Preserve durable campaign facts and character state. Clear the immediate blocked scene/combat. Advance to the next main story beat. Do not start combat unless the module/story absolutely requires it. Keep it to 1-2 short paragraphs.

Recent table context:
${recent}`,
    });
    narration = response.text.trim();
    llmRunId = response.llmRunId || null;
  } catch (err) {
    narration = 'The table steps past the stuck moment and returns to the main thread of the adventure. The immediate confusion falls away; the next clear story beat is ready.';
  }

  appendTacticalHistory(gameId, actorName, 'Move to Next Beat', narration);
  emitDmMessage(gameId, { text: narration, options: [], auto: false, forPlayer: nextPlayer, llmRunId });
  io.to(gameId).emit('game_resumed');
  return { ok: true, narration, llmRunId };
}

async function finishCombatCinematically(gameId, gameConfig, proposer = 'A player') {
  const gs = getGameState(gameId);
  if (!gs.combatEngine?.state?.active) return { ok: false, error: 'No active combat.' };
  const conclusion = recordCombatConclusion(gameId, 'cinematic_finish');
  gs.pendingCinematicFinish = null;
  gs.combatEngine.endCombat();
  persistCombatState(gameId);
  const text = `${proposer} proposes a cinematic finish, and the table closes the fight without another blow-by-blow round.\n${conclusion.summary}\nNo automatic HP or spell-slot costs were applied.`;
  appendTacticalHistory(gameId, proposer, 'Finish Cinematically', text);
  io.to(gameId).emit('combat_ended', { reason: 'cinematic_finish', xp: null });
  emitDmMessage(gameId, { text, options: [], auto: false, tactical: true, forPlayer: getCurrentPlayer(gameId), llmRunId: null });
  return { ok: true };
}

function formatXpAwardForPrompt(award) {
  if (!award || !award.results?.length) return '';

  const defeatedNames = award.defeated.map(enemy => enemy.name).filter(Boolean).join(', ') || 'the defeated enemies';
  const lines = [
    `Total encounter XP: ${award.totalXP}.`,
    `Party award: ${award.xpPerCharacter} XP each for defeating ${defeatedNames}.`,
  ];

  const levelUps = award.results
    .filter(result => result.leveledUp)
    .map(result => `${result.character} reached Level ${result.newLevel}`);
  if (levelUps.length) {
    lines.push(`Level ups: ${levelUps.join('; ')}.`);
  }

  return lines.join('\n');
}

async function awardCombatXpForGame(gameId, reason = 'combat_over') {
  const gs = getGameState(gameId);
  const combatants = gs.combatEngine?.state?.combatants || {};
  const combatId = gs.currentCombatId || 'active-combat';

  if (gs.combatXpAwardedForCombatId === combatId) {
    return gs.lastCombatXpAward || null;
  }

  const award = awardCombatXP(gs, combatants);
  if (!award.results.length || award.xpPerCharacter <= 0) {
    return null;
  }

  const compactAward = {
    reason,
    combatId,
    totalXP: award.totalXP,
    xpPerCharacter: award.xpPerCharacter,
    defeated: award.defeated.map(enemy => ({
      name: enemy.name,
      xp: enemy.xp,
      cr: enemy.cr ?? enemy.challengeRating ?? enemy.challenge_rating ?? null,
    })),
    results: award.results.map(result => ({
      character: result.character,
      xpGained: result.xpGained,
      totalXP: result.totalXP,
      leveledUp: result.leveledUp,
      newLevel: result.newLevel,
    })),
    updatedAt: new Date().toISOString(),
  };

  gs.lastCombatXpAward = compactAward;
  gs.combatXpAwardedForCombatId = combatId;
  db.setState(gameId, 'lastCombatXpAward', compactAward).catch(() => {});
  db.setState(gameId, 'combatXpAwardedForCombatId', combatId).catch(() => {});

  const defeatedNames = compactAward.defeated.map(enemy => enemy.name).filter(Boolean).join(', ') || 'the defeated enemies';
  emitSystem(gameId, {
    text: `XP awarded: ${compactAward.xpPerCharacter} XP each for defeating ${defeatedNames}.`,
  });

  for (const result of compactAward.results) {
    const char = gs.data.characters[result.character];
    if (!char) continue;
    db.upsertCharacter(gameId, result.character, char).catch(e => console.error('[xp-persist]', e.message));
    io.to(gameId).emit('character_updated', {
      name: result.character,
      character: char,
      xpGained: result.xpGained,
      totalXP: result.totalXP,
      level: result.newLevel,
      leveledUp: result.leveledUp,
    });

    if (result.leveledUp) {
      emitSystem(gameId, {
        text: `Level up: ${result.character} reached Level ${result.newLevel}! Total XP: ${result.totalXP}.`,
      });
    }
  }

  return compactAward;
}

// ── Character Token Generation ───────────────────────────────────────────────
// (Moved to image-engine.js)

// Initialize image engine with dependencies
imageEngine.init(together, io, costTracker.logCost, getGameState, promptBuilder.ART_STYLES);

// Wrapper functions that call the implementations in imageEngine
async function generateCharacterToken(name, charData) {
  return imageEngine.generateCharacterToken(name, charData);
}
async function generateCompositeScene(gameId, sceneData, gameConfig) {
  return imageEngine.generateCompositeScene(gameId, sceneData, gameConfig);
}
function shouldGenerateImage(gameId, sceneData, mapMoved, isKillshot) {
  return imageEngine.shouldGenerateImage(gameId, sceneData, mapMoved, isKillshot);
}
async function generateWorldArt(gameId, item) {
  return imageEngine.generateWorldArt(gameId, item);
}

// ── Cost Tracking & Rate Limiting ─────────────────────────────────────────────
// (Moved to cost-tracker.js)
const { estimateCost, logCost, checkRateLimit, getCostSummary, getCostLog, IMAGE_COST, MAX_CALLS_PER_HOUR } = costTracker;

// ── Rolling Story Summary ─────────────────────────────────────────────────────
async function refreshStorySummary(gameId, gameConfig) {
  const gs = getGameState(gameId);
  const gd = gs.data;
  const oldMessages = gd.chatHistory.slice(0, -6); // Keep last 6, summarize the rest
  if (oldMessages.length < 4) return; // Not enough to summarize

  const transcript = oldMessages.map(m =>
    m.role === 'user' ? `Player: ${m.content}` : `DM: ${m.content}`
  ).join('\n').slice(0, 3000);

  const response = await llm.completeText({
    task: 'summary',
    gameId,
    maxTokens: 300,
    temperature: 0.2,
    system: 'Summarize this RPG session in 150 words. Focus on: current quest, recent events, unresolved tensions, character status. Be concise.',
    prompt: transcript,
  });

  gs.storySummary = response.text;
  // Trim history to just the last 6 messages
  gd.chatHistory = gd.chatHistory.slice(-6);
  await db.saveChatHistory(gameId, gd.chatHistory);
  await db.setState(gameId, 'storySummary', gs.storySummary);
  console.log('Story summary refreshed for', gameId);
}

// ── Game Master LLM Call (scoped to a game) ──────────────────────────────────
async function callGameLLM(gameId, gameConfig, userMessage, actingAs = null) {
  if (!USE_SPLIT_PIPELINE) {
    return legacyCallLLM(gameId, gameConfig, userMessage, actingAs);
  }

  // Combat turns use legacy path — combat engine integration has special handling.
  const gs0 = getGameState(gameId);
  if (!gs0.combatEngine?.state?.active) {
    if (isUntargetedOffensiveAction(userMessage, Object.keys(gs0.data.characters || {}))) {
      return targetRequiredNarration(userMessage);
    }
    await maybeStartCombatFromOffensiveAction(gameId, gameConfig, userMessage, gs0).catch(err => {
      console.error('[auto-combat-action] failed:', err.message);
    });
  }
  if (gs0.combatEngine?.state?.active) {
    return legacyCallLLM(gameId, gameConfig, userMessage, actingAs);
  }

  // Rate limit check
  if (!checkRateLimit(gameId)) {
    const gs = getGameState(gameId);
    gs.paused = true;
    clearTimeout(gs.turnTimer);
    emitSystem(gameId, { text: '⚠️ Rate limit reached (60 calls/hour). Game paused.' });
    return { narration: 'Game paused — rate limit reached.', options: [], scene: null, world: null, isKillshot: false };
  }

  const gs = getGameState(gameId);
  const characterName = actingAs || userMessage.split(':')[0]?.trim() || 'Unknown';
  const actionText = userMessage.replace(/^.*?:\s*/, '');
  const prefix = actingAs ? `[AUTO-ACTION for ${actingAs}]\n` : '';

  try {
    await ensureActiveEncounterPlan(gameId, gameConfig, gs).catch(err => {
      console.error('[encounter-plan] Auto-plan failed:', err.message);
    });
    const pacing = encounterDirector.prepareEncounterPacing(gs);
    const storyFlags = pacing.shouldAdvance
      ? { story: true, [pacing.encounter?.pillar || 'exploration']: true }
      : undefined;

    const result = await narrationPipeline.handlePlayerAction(
      gameId, gameConfig, gs, characterName, prefix + actionText, io,
      { initiateCombat, parseAction, resolveEnemyTurns, persistCombatState, emitCombatUpdate },
      storyFlags
    );
    await resolvePendingPlannedChallenge(gameId, gameConfig, gs);
    if (gs.combatEngine?.state?.active) {
      const nextCombatTurn = gs.combatEngine.getCurrentTurn();
      if (nextCombatTurn?.type === 'PC') {
        const tacticalOptions = templateEngine.generateCombatOptions(gs.combatEngine, nextCombatTurn.name);
        if (tacticalOptions.length) result.options = tacticalOptions;
      }
      emitCombatUpdate(gameId);
    }

    // Save to chat history (same format as legacy)
    const gd = gs.data;
    const historyContent = result.narration +
      (result.options?.length ? '\n\n' + result.options.map((o, i) => `${i + 1}️⃣ ${o}`).join('\n') : '');
    gd.chatHistory.push(
      { role: 'user', content: prefix + userMessage },
      { role: 'assistant', content: historyContent }
    );
    if (gd.chatHistory.length > MAX_CHAT_HISTORY) {
      gd.chatHistory = gd.chatHistory.slice(-MAX_CHAT_HISTORY);
    }

    // Apply world updates to game state
    if (result.world) {
      applyWorldUpdates(gameId, result.world);
    }

    // Trigger story summary refresh periodically
    const turnCount = gd.chatHistory.length / 2;
    if (turnCount > 6 && turnCount % 25 === 0) {
      refreshStorySummary(gameId, gameConfig).catch(() => {});
    }

    return result;
  } catch (err) {
    console.error('[pipeline] Error, falling back to legacy:', err.message, err.stack?.split('\n').slice(0, 3).join(' | '));
    return legacyCallLLM(gameId, gameConfig, userMessage, actingAs);
  }
}

function applyWorldUpdates(gameId, worldUpdates) {
  if (!worldUpdates) return;
  const gs = getGameState(gameId);
  const gd = gs.data;
  if (!gd.world) gd.world = { locations: [], npcs: [], accomplishments: [] };

  // Merge locations
  if (worldUpdates.locations) {
    for (const loc of worldUpdates.locations) {
      const existing = gd.world.locations.find(l => l.name.toLowerCase() === loc.name.toLowerCase());
      if (existing) {
        Object.assign(existing, loc);
      } else {
        gd.world.locations.push(loc);
      }
    }
  }

  // Merge NPCs
  if (worldUpdates.npcs) {
    for (const npc of worldUpdates.npcs) {
      const existing = gd.world.npcs.find(n => n.name.toLowerCase() === npc.name.toLowerCase());
      if (existing) {
        Object.assign(existing, npc);
      } else {
        gd.world.npcs.push(npc);
      }
    }
  }

  // Map update
  if (worldUpdates.map) {
    gd.world.currentMap = worldUpdates.map;
  }

  // Accomplishments
  if (worldUpdates.accomplishments) {
    gd.world.accomplishments = [...(gd.world.accomplishments || []), ...worldUpdates.accomplishments];
  }

  // Character updates
  if (worldUpdates.charUpdates) {
    for (const update of worldUpdates.charUpdates) {
      const char = gd.characters[update.character];
      if (char && update.field && update.value) {
        char[update.field] = update.value;
      }
    }
  }

  // Persist
  db.setState(gameId, 'world', gd.world).catch(() => {});
}

async function legacyCallLLM(gameId, gameConfig, userMessage, actingAs = null) {
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

  if (!gs.combatEngine?.state?.active) {
    if (isUntargetedOffensiveAction(userMessage, Object.keys(gs.data.characters || {}))) {
      return targetRequiredNarration(userMessage);
    }
    const started = await maybeStartCombatFromOffensiveAction(gameId, gameConfig, userMessage, gs).catch(err => {
      console.error('[auto-combat-action] failed:', err.message);
      return false;
    });
    if (started) return legacyCallLLM(gameId, gameConfig, userMessage, actingAs);
  }

  const prefix = actingAs
    ? `[AUTO-ACTION for ${actingAs} — timer expired]\n`
    : '';

  // Few-shot examples for terse mode (only on first few turns before history establishes pattern)
  const needsFewShot = gs.verbosity === 'terse' && gd.chatHistory.length < 6;
  const verbosityExample = needsFewShot ? [
    { role: 'user', content: 'Kael: I search the room for traps.' },
    { role: 'assistant', content: 'Kael finds a tripwire near the door — a poison dart trap.\n\n---OPTIONS---\n1️⃣ 🗡️ Disarm the trap\n2️⃣ 🛡️ Find another way around\n3️⃣ 🔥 Trigger it from a distance\n\n---SCENE---\nACTION: Examining trapped doorway\nMOOD: cautious\nNPC: none\n\n---WORLD---\nLOCATIONS:\n- Trapped Hallway | Stone corridor | current\nNPCS:\n- none\nMAP: Trapped Hallway' },
    { role: 'user', content: 'Kael: I attack the goblin with my longsword.' },
    { role: 'assistant', content: 'Kael lunges for the goblin, and the cave snaps from threat to open violence. The goblin shrieks an alarm while its archer scrambles for a firing angle; initiative begins before anyone\'s blow lands.\n\n---OPTIONS---\n1️⃣ 🗡️ Attack the goblin with longsword\n2️⃣ 🛡️ Take cover behind the pillar\n3️⃣ 🔥 Drive the archer back with a feint\n\n---SCENE---\nACTION: Combat begins in the goblin cave\nMOOD: fierce\nNPC: Goblin\n\n---WORLD---\nLOCATIONS:\n- Goblin Cave | Damp limestone | current\nNPCS:\n- Goblin Archer | Ambusher | hostile\nMAP: Goblin Cave\nENEMIES:\n- Goblin | 1 | goblin\n- Goblin Archer | 1 | goblin' },
  ] : [];

  const messages = [
    ...verbosityExample,
    ...gd.chatHistory,
    { role: 'user', content: prefix + userMessage },
  ];

  await ensureActiveEncounterPlan(gameId, gameConfig, gs).catch(err => {
    console.error('[encounter-plan] Auto-plan failed:', err.message);
  });
  const pacing = encounterDirector.prepareEncounterPacing(gs);

  // Determine which prompt to use based on game context
  let isStoryMoment = false;
  if (gs.turn?.flags?.story || gs.turn?.flags?.npc || gs.turn?.flags?.exploration) {
    isStoryMoment = true;
  }
  if (gs._pendingChallenge) {
    isStoryMoment = true;
  }
  if (pacing.shouldAdvance) {
    isStoryMoment = true;
  }
  // Game start is always a story moment (needs full context for opening narration)
  const isGameStart = gd.chatHistory.length === 0;

  const systemPrompt = gs.combatEngine?.state?.active
    ? buildMinimalPrompt(gameConfig, gs)
    : (isStoryMoment || isGameStart)
      ? buildSystemPrompt(gameId, gameConfig)
      : buildMinimalPrompt(gameConfig, gs);

  const startTime = Date.now();

  // Combat routing — resolve player action + enemy turns before calling the model.
  const combatActive = gs.combatEngine?.state?.active;

  // Token limits: combat narration needs fewer tokens (just describing pre-resolved results)
  let maxTokens;
  if (combatActive) {
    maxTokens = gs.verbosity === 'terse' ? 500 : gs.verbosity === 'brief' ? 700 : 1500;
  } else {
    maxTokens = gs.verbosity === 'terse' ? 400 : gs.verbosity === 'brief' ? 600 : 2500;
  }
  let combatContext = '';
  let combatResolvedLines = [];
  let combatTacticalReturn = null;

  if (combatActive) {
    try {
      const combatCtx = {
        combatants: gs.combatEngine.state.combatants,
        preTaggedOptions: gs.preTaggedOptions || null,
      };
      // Use combat engine's current turn, not the normal turn order
      const engineCurrent = gs.combatEngine.getCurrentTurn();
      const playerId = engineCurrent?.id || gs.data.turnOrder[gs.data.currentTurnIndex]?.toLowerCase().replace(/\s+/g, '-');
      const actionText = userMessage.replace(/^.*?:\s*/, '');

      // Check if this PC is downed — auto-resolve death save instead of normal action
      const playerCombatant = gs.combatEngine.state.combatants[playerId];
      const resolver = gs.combatEngine.getResolver();
      const isDown = playerCombatant && resolver.checkDeath(playerCombatant).status === 'unconscious';

      let parsedAction;
      if (isDown) {
        // Downed PC: auto-resolve death save
        parsedAction = { type: 'death_save', actorId: playerId };
      } else {
        parsedAction = parseAction(actionText, playerId, combatCtx);
        if (!parsedAction) {
          parsedAction = isAdvanceAction(actionText)
            ? makeAdvanceAction(actionText, playerId)
            : makeDialogueAction(actionText || 'speak cautiously', playerId);
        }
      }

      if (parsedAction) {
        const resolvedCombatResults = [];
        const playerResult = gs.combatEngine.resolveAction(parsedAction);
        resolvedCombatResults.push(playerResult);
        resolvedCombatResults.push(...gs.combatEngine.advanceTurn());

        // Auto-resolve death saves for any other downed PCs whose turns come up
        while (true) {
          const nextTurn = gs.combatEngine.getCurrentTurn();
          if (!nextTurn || nextTurn.type !== 'PC') break;
          const deathCheck = resolver.checkDeath(nextTurn);
          if (deathCheck.status !== 'unconscious') break;
          if (deathCheck.stable) {
            resolvedCombatResults.push(...gs.combatEngine.advanceTurn());
            continue;
          }
          const dsResult = gs.combatEngine.resolveAction({ type: 'death_save', actorId: nextTurn.id });
          resolvedCombatResults.push(dsResult);
          resolvedCombatResults.push(...gs.combatEngine.advanceTurn());
        }

        const enemyResults = await resolveEnemyTurns(gameId, gameConfig);
        resolvedCombatResults.push(...enemyResults);

        // Auto-resolve death saves for downed PCs after enemy turns
        while (true) {
          const nextTurn = gs.combatEngine.getCurrentTurn();
          if (!nextTurn || nextTurn.type !== 'PC') break;
          const deathCheck = resolver.checkDeath(nextTurn);
          if (deathCheck.status !== 'unconscious') break;
          if (deathCheck.stable) {
            resolvedCombatResults.push(...gs.combatEngine.advanceTurn());
            continue;
          }
          const dsResult = gs.combatEngine.resolveAction({ type: 'death_save', actorId: nextTurn.id });
          resolvedCombatResults.push(dsResult);
          resolvedCombatResults.push(...gs.combatEngine.advanceTurn());
        }

        persistCombatState(gameId);
        const allResults = resolvedCombatResults.filter(Boolean);
        const resultLines = allResults.map(r => gs.combatEngine.formatResultForPrompt(r));
        combatResolvedLines = resultLines;
        let combatOverCheck = null;
        let combatXpAward = null;

        combatContext = `\n\n${gs.combatEngine.getCombatStateForPrompt()}\n\nRESOLVED THIS ROUND:\n${resultLines.join('\n')}\n\nNarrate these results in your DM persona. It is now ${gs.combatEngine.getCurrentTurn()?.name || 'the next player'}'s turn.`;

        // Add enemy personalities for narration flavor
        const enemyPersonalities = Object.values(gs.combatEngine.state.combatants)
          .filter(c => c.type === 'Enemy' && c.personality && (c.hp > 0 || (c.totalHp && c.totalHp > 0)))
          .map(c => `${c.name}: ${c.personality}`)
          .join('\n');
        if (enemyPersonalities) {
          combatContext += `\n\nENEMY PERSONALITIES (use in narration):\n${enemyPersonalities}`;
        }

        const overCheck = gs.combatEngine.isCombatOver();
        combatOverCheck = overCheck;
        if (overCheck.over) {
          combatContext += `\n\nCOMBAT IS OVER: ${overCheck.reason === 'enemies_defeated' ? 'All enemies defeated. Narrate aftermath and loot.' : 'All PCs are down.'}`;
          recordCombatConclusion(gameId, overCheck.reason);
          const xpAward = overCheck.reason === 'enemies_defeated'
            ? await awardCombatXpForGame(gameId, overCheck.reason)
            : null;
          combatXpAward = xpAward;
          if (xpAward) {
            combatContext += `\n\nXP AWARDS:\n${formatXpAwardForPrompt(xpAward)}\nMention these XP grants and any level ups in the aftermath.`;
          }
          gs.combatEngine.endCombat();
          persistCombatState(gameId);
          // Collect DPR data from combat
          const combatSummary = gs.combatEngine.getCombatSummary();
          if (combatSummary && combatSummary.rounds > 0) {
            if (!gs.combatHistory) gs.combatHistory = {};
            for (const [id, data] of Object.entries(combatSummary.characters)) {
              if (data.type !== 'PC') continue;
              if (!gs.combatHistory[id]) gs.combatHistory[id] = { combats: [] };
              gs.combatHistory[id].combats.push({
                date: Date.now(), rounds: combatSummary.rounds,
                damageDealt: data.damageDealt, damageTaken: data.damageTaken,
                healed: data.healed, spellSlotsUsed: data.spellSlotsUsed,
              });
              if (gs.combatHistory[id].combats.length > 5) gs.combatHistory[id].combats.shift();
              gs.combatHistory[id].rollingDPR = ed.updateRollingDPR(gs.combatHistory[id]);
            }
            db.setState(gameId, 'combatHistory', gs.combatHistory).catch(() => {});

            // Difficulty correction
            if (gs.encounterPlan) {
              const encounters = gs.encounterPlan.encounters || [];
              const currentEnc = encounters.find(e => e.pillar === 'combat' && !e.completed && !e.rest && e.status !== 'skipped');
              if (currentEnc) {
                gs.difficultyCorrection = ed.applyDifficultyCorrection(
                  gs.difficultyCorrection || 1.0,
                  { predictedRounds: currentEnc.estimatedRounds || 4, actualRounds: combatSummary.rounds }
                );
                currentEnc.completed = true;
                currentEnc.status = 'resolved';
                gs.encounterPlanIndex = (gs.encounterPlanIndex || 0) + 1;
                db.setState(gameId, 'difficultyCorrection', gs.difficultyCorrection).catch(() => {});
                persistAndEmitPlannerProgress(gameId).catch(() => {});
              }
            }
          }
          // Save surviving/notable enemies to NPC memory
          if (!gs.npcMemory) gs.npcMemory = {};
          const combatants = gs.combatEngine.state.combatants || {};
          for (const [id, c] of Object.entries(combatants)) {
            if (c.type !== 'Enemy') continue;
            const hp = c.hp ?? c.totalHp ?? 0;
            const maxHp = c.maxHp ?? c.totalHp ?? 1;
            const survived = hp > 0;
            const wasSignificant = (c.personality || c.cr >= 2 || maxHp >= 30);

            if (survived || wasSignificant) {
              const key = c.name.toLowerCase().replace(/\s+\d+$/, ''); // Strip number suffix
              if (!gs.npcMemory[key]) gs.npcMemory[key] = { encounters: [] };
              gs.npcMemory[key].name = c.name;
              gs.npcMemory[key].personality = c.personality || '';
              gs.npcMemory[key].lastSeen = Date.now();
              gs.npcMemory[key].encounters.push({
                date: Date.now(),
                survived,
                hpRemaining: hp,
                fled: (c.morale === 'cowardly' || c.morale === 'normal') && hp > 0 && hp < maxHp * 0.5,
                roundsFought: gs.combatEngine.state.round,
                partyMembersPresent: Object.values(combatants).filter(x => x.type === 'PC').map(x => x.name),
              });
              // Keep last 5 encounters
              if (gs.npcMemory[key].encounters.length > 5) gs.npcMemory[key].encounters.shift();
            }
          }
          db.setState(gameId, 'npcMemory', gs.npcMemory).catch(() => {});

          io.to(gameId).emit('combat_ended', { reason: overCheck.reason, xp: xpAward });
        }
        const text = formatTacticalCombatText(gs, allResults, combatOverCheck, combatXpAward);
        const actorName = actingAs || userMessage.match(/^([^:]{1,80}):/)?.[1]?.trim() || 'Player';
        appendTacticalHistory(gameId, actorName, actionText, text);
        combatTacticalReturn = {
          narration: text,
          options: [],
          scene: null,
          world: null,
          isKillshot: false,
          mapMoved: false,
          llmRunId: null,
        };
      }
    } catch (combatErr) {
      // Combat engine error — fall back to normal AI processing (no combat context)
      const errDetail = `[${new Date().toISOString()}] Combat engine error: ${combatErr.message}\n${combatErr.stack}\n---\n`;
      console.error('Combat engine error (falling back to AI):', combatErr.message, combatErr.stack?.split('\n').slice(0, 5).join(' | '));
      // Persist to in-memory error ring buffer (last 50 errors)
      if (!global._combatErrors) global._combatErrors = [];
      global._combatErrors.push(errDetail);
      if (global._combatErrors.length > 50) global._combatErrors.shift();
      // Don't end combat — just skip engine resolution for this turn and let AI narrate
      // The engine state is preserved so it can retry next turn
      combatContext = '\n\n[Server combat engine encountered an error this turn. Narrate this combat turn normally using dice rolls.]';
    }
  }

  if (combatTacticalReturn) return combatTacticalReturn;

  const combatPromptInjection = combatActive ? `\n\nCOMBAT MODE ACTIVE — Server controls all combat.
DO NOT: roll dice, invent attack results, change HP, ask for initiative rolls, or resolve combat yourself.
DO: Narrate EVERY result from RESOLVED THIS ROUND as a bold dice line, then 1 sentence of flavor. That's it.
Preserve the combat engine math exactly. Show to-hit as "To hit: d20 [roll] + [bonus] = [total] vs AC [AC]" and damage as "Damage: [formula] ([dice] + [bonus] = [total]) [type]".
Do NOT add HIT/MISS to non-damage, heal, buff, movement, dodge, dash, disengage, or death-save results. If a resolved line has no roll, damage, or target HP, do not invent one.
Do NOT narrate a target as dead, defeated, motionless, or finished unless RESOLVED THIS ROUND explicitly says its HP reached 0 or COMBAT IS OVER is present.
ENEMY ATTACKS ON PCs are the most dramatic part — describe the PC getting hurt, bleeding, staggering.
KILLSHOT: [scene] when a target reaches 0 HP.
Keep narration SHORT — this is tactical combat, not a novel.` : '';
  const finalSystemPrompt = systemPrompt + combatPromptInjection;

  // Rebuild messages with combatContext appended to user message
  // Append system instruction before the content to override pattern-matching
  const systemOverride = `CRITICAL: The player has chosen an action below. You MUST narrate ONLY what happens as a direct consequence of that choice. Do not repeat previous narrations or generic descriptions.\n\n`;
  const userMessageFormatted = `${systemOverride}PLAYER ACTION: ${userMessage}\n\nRespond directly. Narrate what happens because of this choice ONLY.${combatContext}`;
  const messagesWithCombat = [
    ...gd.chatHistory,
    { role: 'user', content: prefix + userMessageFormatted },
  ];

  // Streaming state machine
  let accumulatedText = '';
  let narrationText = '';
  let structuredBuffer = '';
  let state = 'NARRATING'; // NARRATING or BUFFERING
  let pendingTail = '';
  const LOOKAHEAD = 30; // chars to hold back for marker detection
  const markerRegex = /(?:-{3,}\s*(?:OPTIONS|SCENE|WORLD)\s*-{3,}?|#{1,3}\s*(?:OPTIONS?|SCENE|WORLD)\s*(?=\n|$))/im;


  // Emit stream start
  io.to(gameId).emit('dm_stream_start', {
    auto: !!actingAs,
    player: actingAs || null,
  });

  let finalMessage;
  try {
    // Lower temperature for terse/brief = more instruction-following, less creative wandering
    const temperature = gs.verbosity === 'terse' ? 0.3 : gs.verbosity === 'brief' ? 0.5 : 0.8;

    console.log(`[stream-start] gameId=${gameId} task=narration maxTokens=${maxTokens} temp=${temperature} sysPromptLen=${finalSystemPrompt.length} messagesLen=${messagesWithCombat.length}`);

    finalMessage = await llm.streamText({
      task: 'narration',
      gameId,
      maxTokens,
      temperature,
      system: finalSystemPrompt,
      messages: messagesWithCombat,
      onToken: (delta) => {
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
      },
    });

    console.log(`[stream-started] gameId=${gameId} stream created successfully`);

    // Flush remaining
    if (state === 'NARRATING' && pendingTail) {
      io.to(gameId).emit('dm_stream_chunk', { text: pendingTail });
      narrationText += pendingTail;
    }

    console.log(`[stream-complete] gameId=${gameId} success`);
  } catch (streamErr) {
    console.error('[stream-error] gameId=${gameId} Error during streaming:', streamErr.message, 'Status:', streamErr.status, 'Type:', streamErr.type);
    console.error('[stream-error-full] Stack:', streamErr.stack?.split('\n').slice(0, 10).join(' | '));
    io.to(gameId).emit('dm_stream_end', { narration: cleanInvalidCombatNarration(narrationText.trim()), llmRunId: streamErr.llmRunId || null });
    throw streamErr;
  }

  const elapsed = Date.now() - startTime;
  const reply = accumulatedText;

  // Emit stream end with final narration for re-rendering
  io.to(gameId).emit('dm_stream_end', { narration: cleanInvalidCombatNarration(narrationText.trim()), llmRunId: finalMessage.llmRunId || null });

  // Log cost
  const inputTokens = finalMessage.usage?.inputTokens || 0;
  const outputTokens = finalMessage.usage?.outputTokens || 0;
  const cost = finalMessage.cost || llmModels.estimateCost(finalMessage.model, inputTokens, outputTokens);
  logCost({ gameId, model: finalMessage.model, inputTokens, outputTokens, cost, type: actingAs ? 'auto-action' : 'player-action' });
  console.log(`LLM call: ${finalMessage.model} | ${inputTokens}in/${outputTokens}out | $${cost.toFixed(4)} | ${elapsed}ms | ${actingAs ? 'auto' : 'human'}`);

  const parsed = parseResponse(reply);
  parsed.narration = cleanInvalidCombatNarration(parsed.narration);
  if (combatResolvedLines.length > 0 && !combatResolvedLines.every(line => parsed.narration.includes(line))) {
    parsed.narration = `${combatResolvedLines.map(line => `🎲 ${line}`).join('\n')}\n\n${parsed.narration}`.trim();
  }
  parsed.llmRunId = finalMessage.llmRunId || null;
  if (combatActive && gs.combatEngine?.state?.active) {
    const nextCombatTurn = gs.combatEngine.getCurrentTurn();
    if (nextCombatTurn?.type === 'PC') {
      const tacticalOptions = templateEngine.generateCombatOptions(gs.combatEngine, nextCombatTurn.name);
      if (tacticalOptions.length) parsed.options = tacticalOptions;
    }
  }
  console.log(`[stream-debug] state=${state} narration=${narrationText.length}ch structured=${structuredBuffer.length}ch options=${parsed.options.length} scene=${!!parsed.scene} world=${!!parsed.world}`);

  // Include a minimal structured block in history so the AI sees the output format pattern
  const historyContent = parsed.narration +
    (parsed.options?.length ? '\n\n---OPTIONS---\n' + parsed.options.map((o, i) => `${i + 1}️⃣ ${o}`).join('\n') : '') +
    '\n\n---SCENE---\nACTION: ' + (parsed.scene?.action || 'continuing') + '\nMOOD: ' + (parsed.scene?.mood || 'neutral') + '\nNPC: ' + (parsed.scene?.npc || 'none');
  gd.chatHistory.push(
    { role: 'user', content: prefix + userMessage },
    { role: 'assistant', content: historyContent }
  );
  if (gd.chatHistory.length > MAX_CHAT_HISTORY) {
    gd.chatHistory = gd.chatHistory.slice(-MAX_CHAT_HISTORY);
  }

  // If no options were extracted and this isn't an auto-action, make a cheap follow-up call
  if (parsed.options.length === 0 && !actingAs) {
    try {
      const nextPlayer = getVisiblePlayerForOptions(gameId);
      const optionsResponse = await llm.completeText({
        task: 'options-fallback',
        gameId,
        maxTokens: 200,
        temperature: 0.3,
        prompt: `Given this narration from a ${gameConfig.system || 'D&D 5e'} game, suggest exactly 3 scene-specific action options for ${nextPlayer || 'the next player'}. Avoid generic attack/defend/wild defaults; match the current scene and player intent. Output ONLY this format with number emojis, nothing else:\n\n1️⃣ [specific option]\n2️⃣ [distinct alternative]\n3️⃣ [bold but context-aware option]\n\nNarration: ${parsed.narration.slice(-500)}`,
      });
      const optLines = extractNumberedOptions(optionsResponse.text);
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

  // Process map hint (synchronous graph update). Combat is locked to the
  // current battlefield; the DM may describe positions, but not relocate the map.
  const combatMapLocked = combatActive && gs.combatEngine?.state?.active;
  const mapResult = combatMapLocked
    ? { moved: false, isNew: false, location: null }
    : processMapHint(gs.mapGraph, parsed.worldRaw, parsed.world?.locations);

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

  // Initiate combat — two paths:
  // Path 1: AI outputs formal ENEMIES: block (ideal)
  const nonHostileProgressIntent = hasNonHostileProgressIntent(userMessage);
  const hardCombatSignal = hasHardCombatSignal(parsed.narration || '');
  const explicitHostileAction = hasExplicitHostileAction(userMessage);
  if (parsed.world?.enemies?.length > 0 && !gs.combatEngine.state.active) {
    if (!hardCombatSignal && !explicitHostileAction) {
      const reason = nonHostileProgressIntent ? 'non-hostile/progress input' : 'no hostile trigger';
      console.log(`[intent-guard] Suppressed ENEMIES block after ${reason}: ${extractSubmittedActionText(userMessage)}`);
      parsed.world.enemies = [];
    } else {
      await initiateCombat(gameId, gameConfig, parsed.world.enemies).catch(e => console.error('Combat init error:', e));
    }
  }
  // Path 2: AI narrates combat without ENEMIES: block — server takes over
  // Only trigger on strong combat signals (actual attacks/charges, not just monster mentions)
  if (!gs.combatEngine.state.active && !parsed.world?.enemies?.length) {
    if (hardCombatSignal && !nonHostileProgressIntent) {
      // Try encounter plan first
      let enemies = null;
      if (gs.encounterPlan) {
        const nextCombat = gs.encounterPlan.encounters.find(
          (e, i) => i >= (gs.encounterPlanIndex || 0) && e.pillar === 'combat' && !e.completed && !e.rest && e.status !== 'skipped'
        );
        if (nextCombat?.monsters?.length > 0) {
          enemies = nextCombat.monsters.map(m => ({
            displayName: m.name || m.displayName, count: m.count, slug: m.slug, hint: null,
          }));
        }
      }

      // Fallback: extract monster names from narration and look them up
      if (!enemies) {
        const monsterDB = require('./monster-lookup').loadDefaultMonsters(gameConfig.system || 'dnd5e');
        const monsterSlugs = Object.keys(monsterDB);
        const found = [];
        for (const slug of monsterSlugs) {
          const name = monsterDB[slug].name;
          if (name && new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 's?\\b', 'i').test(parsed.narration)) {
            found.push({ displayName: name, count: 1, slug, hint: null });
          }
        }
        // Pick up to 4 unique monsters mentioned
        if (found.length > 0) enemies = found.slice(0, 4);
      }

      if (enemies?.length > 0) {
        console.log(`[auto-combat] Server taking over combat: ${enemies.map(e => `${e.count}x ${e.displayName}`).join(', ')}`);
        await initiateCombat(gameId, gameConfig, enemies).catch(e => console.error('Auto-combat init error:', e));
      }
    }
  }

  // Desync fix: AI narrated combat ending but engine still active → force-end engine
  if (gs.combatEngine.state.active && !combatActive) {
    // combatActive was true at start of this call but engine might have ended mid-resolution
    // This handles the case where AI says combat is over but engine disagrees
  }
  if (gs.combatEngine.state.active) {
    const aiSaysCombatOver = /(?:combat\s+(?:is\s+)?(?:over|ended|resolved|finished)|(?:all|the)\s+(?:enemies|monsters|foes|skeletons|goblins|orcs)\s+(?:are\s+)?(?:dead|defeated|slain|fallen|destroyed)|victory|(?:last|final)\s+(?:enemy|monster|foe)\s+(?:falls|drops|crumbles|collapses))/i;
    if (aiSaysCombatOver.test(parsed.narration || '')) {
      console.log(`[desync] AI narrated combat end but engine still active — force-ending combat`);
      recordCombatConclusion(gameId, 'narrated_combat_over');
      const xpAward = await awardCombatXpForGame(gameId, 'narrated_combat_over');
      gs.combatEngine.endCombat();
      persistCombatState(gameId);
      io.to(gameId).emit('combat_ended', { reason: 'enemies_defeated', xp: xpAward });
    }
  }

  await resolvePendingPlannedChallenge(gameId, gameConfig, gs);
  if (!combatActive && gs.combatEngine.state.active) {
    const nextCombatTurn = gs.combatEngine.getCurrentTurn();
    if (nextCombatTurn?.type === 'PC') {
      const tacticalOptions = templateEngine.generateCombatOptions(gs.combatEngine, nextCombatTurn.name);
      if (tacticalOptions.length) parsed.options = tacticalOptions;
    }
  }

  // Reset encounter counter when combat starts or ends
  if (gs.combatEngine.state.active) {
    gs._turnsSinceLastEncounter = 0;
  }

  // Pre-parse options for next combat turn
  if (gs.combatEngine.state.active && parsed.options?.length > 0) {
    const nextPlayer = gs.combatEngine.getCurrentTurn();
    if (nextPlayer) {
      const combatCtx = { combatants: gs.combatEngine.state.combatants, gameId };
      const tier1 = parseOptions(parsed.options, nextPlayer.id, combatCtx);
      if (tier1.some(r => r === null)) {
        parseOptionsWithAI(parsed.options, nextPlayer.id, combatCtx)
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

function slugCharacterName(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, '-');
}

function getCombatPlayerNameForCurrentTurn(gs) {
  const current = gs.combatEngine?.state?.active ? gs.combatEngine.getCurrentTurn() : null;
  if (!current || current.type !== 'PC') return null;
  return Object.keys(gs.data.characters || {}).find(name => slugCharacterName(name) === current.id) || current.name;
}

function getVisiblePlayerForOptions(gameId) {
  const gs = getGameState(gameId);
  return getCombatPlayerNameForCurrentTurn(gs) || getCurrentPlayer(gameId);
}

function splitActionList(text) {
  return String(text || '')
    .split(/[,;\n]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function getFirstLivingEnemy(combatants = {}) {
  return Object.values(combatants).find(c => c.type === 'Enemy' && ((c.hp ?? c.totalHp ?? c.maxHp ?? 1) > 0)) || null;
}

function chooseCombatAutoAction(gameId, playerName) {
  const gs = getGameState(gameId);
  const engine = gs.combatEngine;
  const current = engine?.state?.active ? engine.getCurrentTurn() : null;
  const actorId = current?.id || slugCharacterName(playerName);
  const combatants = engine?.state?.combatants || {};
  const actor = combatants[actorId] || {};
  const enemy = getFirstLivingEnemy(combatants);
  const char = gs.data.characters?.[playerName] || {};
  const ctx = { combatants, preTaggedOptions: null, gameId };

  for (const action of splitActionList(char.standardActions)) {
    const parsed = parseAction(action, actorId, ctx);
    if (parsed?.type === 'attack' && parsed.targetId) return action;
    if (parsed?.type === 'spell' && parsed.spell) {
      const spell = (actor.spells || []).find(s => s.name === parsed.spell || s.name?.toLowerCase() === parsed.spell?.toLowerCase());
      if (spell?.damage || spell?.attack || spell?.save || spell?.healing || spell?.effect === 'heal') return action;
    }
  }

  const weaponName = actor.weapons?.[0]?.name;
  if (enemy && weaponName) return `Attack ${enemy.name} with ${weaponName}`;
  if (enemy) return `Attack ${enemy.name}`;
  return 'Dodge';
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

    const autoAction = gs.combatEngine?.state?.active
      ? chooseCombatAutoAction(gameId, playerName)
      : (() => {
          const char = gs.data.characters[playerName];
          return char
            ? `It is ${playerName}'s turn but they did not respond. Act on their behalf as their character (${char.class}, personality: ${char.personality}). Choose the most fitting action given the current situation and their standard actions: ${char.standardActions || 'none'}. Narrate what they do.`
            : `It is ${playerName}'s turn but they did not respond. Have them take a cautious, sensible action.`;
        })();

    emitSystem(gameId, { text: `⏰ ${playerName} ran out of time. The GM is acting for them...` });

    try {
      // ✅ FIX: Serialize narration streaming per game
      const { narration, options, scene, world, isKillshot, mapMoved, llmRunId } = await withStreamingLock(gameId, () =>
        callGameLLM(gameId, gameConfig, gs.combatEngine?.state?.active ? `${playerName}: ${autoAction}` : autoAction, playerName)
      );
      await advanceTurn(gameId, gameConfig, false);
      const nextPlayer = getVisiblePlayerForOptions(gameId);
      emitDmMessage(gameId, { text: narration, options, auto: true, player: playerName, previousPlayer: playerName, forPlayer: nextPlayer, world, llmRunId });
      io.to(gameId).emit('action_complete', { forPlayer: nextPlayer });
      maybeGenerateImage(gameId, gameConfig, scene, isKillshot, mapMoved, narration)
        .catch(err => console.error('[scene-gen-after-auto-action]', err.message));
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

  // During combat, use the combat engine's current turn instead of normal rotation
  if (gs.combatEngine?.state?.active) {
    if (gs.combatEngine.getCurrentTurn()?.type === 'Enemy') {
      await resolveEnemyTurns(gameId, gameConfig);
      persistCombatState(gameId);
      emitCombatUpdate(gameId);
    }
    const engineNext = gs.combatEngine.getCurrentTurn();
    if (engineNext && engineNext.type === 'PC') {
      const enginePlayerName = getCombatPlayerNameForCurrentTurn(gs) || engineNext.name;
      const token = gd.characters[enginePlayerName]?.token || null;
      // Sync normal turn index to match
      const idx = gd.turnOrder.indexOf(enginePlayerName);
      if (idx >= 0) gd.currentTurnIndex = idx;
      emitTurnChange(gameId, { player: enginePlayerName, duration: gs.turnDuration * 1000, token });
      startTurnTimer(gameId, gameConfig, enginePlayerName);
      db.saveTurnState(gameId, gd.currentTurnIndex, gd.turnOrder)
        .catch(e => console.error('[turn-save]', e.message));
      return;
    }
  }

  gd.currentTurnIndex = (gd.currentTurnIndex + 1) % (gd.turnOrder.length || 1);
  const next = getCurrentPlayer(gameId);
  if (next) {
    const token = gd.characters[next]?.token || null;
    emitTurnChange(gameId, { player: next, duration: gs.turnDuration * 1000, token });
    startTurnTimer(gameId, gameConfig, next);
  }
  db.saveTurnState(gameId, gd.currentTurnIndex, gd.turnOrder)
    .catch(e => console.error('[turn-save]', e.message));
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
    generateCompositeScene(gameId, scene, gameConfig).then(async url => {
      if (url) {
        gs.imageUrl = url;
        gs.imageLabel = sceneLabel;
        db.updateGameImage(gameId, url).catch(e => console.error('[image-persist]', e));
        emitSceneImage(gameId, { url, label: sceneLabel, type: isKillshot ? 'killshot' : 'scene' });
        logCost({ gameId, model: 'FLUX', inputTokens: 0, outputTokens: 0, cost: IMAGE_COST, type: 'scene-image' });

        // Save killshot to hall of fame
        if (isKillshot && url) {
          const dramaScore = hasNat20 ? 8 : 6;
          const momentType = hasNat20 ? 'nat20' : 'boss_kill';
          const description = narration.slice(0, 200);
          const gameRow = await db.getGame(gameId);
          const charName = gs.data.turnOrder?.[gs.data.currentTurnIndex] || 'Unknown Hero';
          const enemyName = scene.npc || 'Unknown Foe';

          db.saveKillshot(gameId, gameRow?.name, charName, null, enemyName,
            momentType, description, url, dramaScore, gameConfig.system)
            .catch(e => console.error('[killshot-save]', e));
        }
      } else {
        io.to(gameId).emit('scene_gen_failed');
      }
    }).catch(err => console.error('[scene-gen-killshot]', err.message));
  }
}

// ── REST API ─────────────────────────────────────────────────────────────────
app.get('/api/games', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || null;
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

app.post('/api/games', requireAuth, async (req, res) => {
  try {
    const { system } = req.body;
    const name = truncate(req.body.name, 100);
    const id = crypto.randomUUID();
    await db.createGame(id, name, system || 'dnd5e');
    // Set host_user_id (authenticated user required)
    const hostId = req.user.id;
    await db.pool.query('UPDATE games SET host_user_id = $1 WHERE id = $2', [hostId, id]);
    const game = await db.getGame(id);
    res.json(game);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete individual game
app.delete('/api/games/:id', requireAuth, async (req, res) => {
  try {
    const gameId = req.params.id;
    const game = await db.getGame(gameId);

    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    // Check ownership: user must be the host or admin
    if (game.host_user_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: 'Only the host can delete this game' });
    }

    console.log(`[DELETE] Game ${gameId} deletion requested by ${req.user.email}`);

    // Delete in order of foreign key dependencies
    await db.pool.query('DELETE FROM game_state WHERE game_id = $1', [gameId]);
    await db.pool.query('DELETE FROM channel_links WHERE game_id = $1', [gameId]);
    await db.pool.query('DELETE FROM game_monster_sources WHERE game_id = $1', [gameId]);
    await db.pool.query('DELETE FROM monster_sources WHERE game_id = $1', [gameId]);
    await db.pool.query('DELETE FROM characters WHERE game_id = $1', [gameId]);
    await db.pool.query('UPDATE killshots SET game_id = NULL WHERE game_id = $1', [gameId]);
    const deleteResult = await db.pool.query('DELETE FROM games WHERE id = $1', [gameId]);

    console.log(`[DELETE] Game ${gameId} deleted successfully`);

    res.json({
      success: true,
      message: `Game "${game.name}" deleted`,
      deleted: deleteResult.rowCount,
    });
  } catch (err) {
    console.error('[DELETE] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Admin cleanup: Delete all games and characters
app.post('/api/admin/cleanup', requireAdmin, async (req, res) => {
  try {
    const { confirm } = req.body;
    if (confirm !== 'DELETE_ALL') {
      return res.status(400).json({ error: 'Confirmation required. Set confirm: "DELETE_ALL" in request body.' });
    }

    console.log(`[ADMIN] Cleanup requested by ${req.user?.email || 'unknown'}`);

    // Get counts before deletion
    const gamesCount = (await db.pool.query('SELECT COUNT(*) as count FROM games')).rows[0].count;
    const charsCount = (await db.pool.query('SELECT COUNT(*) as count FROM characters')).rows[0].count;

    // Delete only game-specific data, preserve reusable content
    // Delete dependent data (in order of foreign key dependencies)
    await db.pool.query('DELETE FROM game_state');
    await db.pool.query('DELETE FROM channel_links');
    // PRESERVE: rules_corrections (house rules library reusable)
    // PRESERVE: monster_templates (combat templates reusable)
    // PRESERVE: bug_reports (historical bug tracking)
    // PRESERVE: killshots (images shown to players during loading)
    await db.pool.query('DELETE FROM game_monster_sources');
    await db.pool.query('DELETE FROM monster_sources WHERE game_id IS NOT NULL');

    // Delete characters and games
    await db.pool.query('DELETE FROM characters');
    const gamesResult = await db.pool.query('DELETE FROM games');
    // NOTE: killshots.game_id will auto-set to NULL due to ON DELETE SET NULL constraint

    // Verify
    const finalGames = (await db.pool.query('SELECT COUNT(*) as count FROM games')).rows[0].count;
    const finalChars = (await db.pool.query('SELECT COUNT(*) as count FROM characters')).rows[0].count;

    console.log(`[ADMIN] Cleanup complete: deleted ${gamesResult.rowCount} games, ${charsCount} characters`);

    res.json({
      success: true,
      deleted: {
        games: gamesCount,
        characters: charsCount,
      },
      remaining: {
        games: finalGames,
        characters: finalChars,
      },
      message: `Deleted ${gamesCount} games and ${charsCount} characters. Database cleaned.`,
    });
  } catch (err) {
    console.error('[ADMIN] Cleanup error:', err.message);
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

      // Extract structured summary via configured LLM.
      console.log(`[PDF] Extracting summary for ${file.originalname} (${data.text.length} chars raw)...`);
      const extractionResponse = await llm.completeText({
        task: 'summary',
        gameId,
        maxTokens: 2000,
        temperature: 0.2,
        system: 'You are a tabletop RPG content analyzer. Extract and organize the key information from this source material into a structured summary. Be comprehensive but concise.',
        prompt: `Analyze this RPG source material and extract a structured summary covering:\n\n1. SETTING: World/region description, key themes, time period\n2. LOCATIONS: Name, description, notable features for each major location\n3. NPCS: Name, role, personality, motivations for each major NPC\n4. ENCOUNTERS: Key encounters/scenes with difficulty and rewards\n5. PLOT: Main quest hooks, story arc, key events\n6. RULES: Any custom rules, house rules, or system-specific modifications\n7. LOOT: Notable treasure, magic items, rewards\n8. LEVEL RANGE: Recommended character levels\n\nSource material:\n${rawText}`,
      });

      const summary = extractionResponse.text;
      const inputTokens = extractionResponse.usage?.inputTokens || 0;
      const outputTokens = extractionResponse.usage?.outputTokens || 0;
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
  try {
    const { text, category, is_private } = req.body;
    const gameId = req.params.id;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Text required' });

    // Get game's system
    const game = await db.getGame(gameId);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const rule = await db.addRuleCorrectionFull(gameId, text.trim().slice(0, MAX_RULE_TEXT), category, req.user.id, null, false, is_private || false, game.system);

    // Refresh game state
    const gs = getGameState(gameId);
    gs.rulesCorrections = await db.getRulesCorrections(gameId);

    res.json(rule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/rules/:id', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Text required' });
  await db.updateRuleCorrection(req.params.id, text.trim().slice(0, MAX_RULE_TEXT));
  res.json({ success: true });
});

app.delete('/api/rules/:id', requireAuth, async (req, res) => {
  await db.deleteRuleCorrection(req.params.id);
  res.json({ success: true });
});

// Search shared rules library (filtered by game system if gameId provided)
app.get('/api/rules/shared', async (req, res) => {
  try {
    const { search, category, gameId, limit, offset } = req.query;

    // If gameId is provided, get the game's system
    let gameSystem = null;
    if (gameId) {
      const game = await db.getGame(gameId);
      if (game) gameSystem = game.system;
    }

    const rules = await db.searchSharedRules(search, category, gameSystem, parseInt(limit) || 20, parseInt(offset) || 0);
    res.json(rules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add shared rule to current game
app.post('/api/games/:gameId/rules/add-shared', requireAuth, async (req, res) => {
  try {
    const { rule_id } = req.body;
    const gameId = req.params.gameId;

    // Verify user is host/participant of the game
    const game = await db.getGame(gameId);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    // Get the shared rule
    const ruleRes = await db.pool.query('SELECT * FROM rules_corrections WHERE id = $1 AND is_master = true AND is_private = false', [rule_id]);
    if (!ruleRes.rows.length) return res.status(404).json({ error: 'Rule not found' });

    // Copy it to the game
    const newRule = await db.copyRuleToGame(rule_id, gameId, req.user.id);

    // Refresh in-memory state
    const gs = getGameState(gameId);
    gs.rulesCorrections = await db.getRulesCorrections(gameId);

    res.json(newRule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Copy rules from another game
app.post('/api/games/:gameId/rules/copy-from-game', requireAuth, async (req, res) => {
  try {
    const { source_game_id, rule_ids } = req.body;
    const targetGameId = req.params.gameId;

    // Verify user owns/hosts both games
    const sourceGame = await db.getGame(source_game_id);
    const targetGame = await db.getGame(targetGameId);

    if (!sourceGame || !targetGame) return res.status(404).json({ error: 'Game not found' });
    if (sourceGame.host_user_id !== req.user.id || targetGame.host_user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Copy each rule
    const copied = [];
    for (const ruleId of rule_ids) {
      const newRule = await db.copyRuleToGame(ruleId, targetGameId, req.user.id);
      copied.push(newRule);
    }

    // Refresh in-memory state
    const gs = getGameState(targetGameId);
    gs.rulesCorrections = await db.getRulesCorrections(targetGameId);

    res.json({ copied: copied.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get exportable rules from a game (for import picker)
app.get('/api/games/:gameId/rules/exportable', requireAuth, async (req, res) => {
  try {
    const gameId = req.params.gameId;
    const game = await db.getGame(gameId);

    if (!game || game.host_user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const rules = await db.getExportableRules(gameId);
    res.json(rules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle rule privacy
app.patch('/api/rules/:ruleId/privacy', requireAuth, async (req, res) => {
  try {
    const { is_private } = req.body;
    await db.setRulePrivacy(req.params.ruleId, is_private, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Promote rule to master library
app.patch('/api/rules/:ruleId/promote', requireAuth, async (req, res) => {
  try {
    await db.promoteToMaster(req.params.ruleId, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Bug Reports API ────────────────────────────────────────────────────────────

// POST: Submit a bug report
app.post('/api/games/:id/bugs', requireAuth, uploadImage.single('screenshot'), async (req, res) => {
  try {
    const gameId = req.params.id;
    const game = await db.getGame(gameId);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const { description } = req.body;
    if (!description || description.trim().length === 0) {
      return res.status(400).json({ error: 'Description required' });
    }

    let imageUrl = null;
    if (req.file) {
      const base64 = req.file.buffer.toString('base64');
      imageUrl = `data:${req.file.mimetype};base64,${base64}`;
    }

    const bugReport = await db.saveBugReport(gameId, game.name, req.user.id, description, imageUrl);
    res.json(bugReport);
  } catch (err) {
    console.error('Bug report error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET: Retrieve bug reports for a game
app.get('/api/games/:id/bugs', requireAuth, async (req, res) => {
  try {
    const gameId = req.params.id;
    const game = await db.getGame(gameId);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const bugs = await db.getBugReports(gameId);
    res.json(bugs);
  } catch (err) {
    console.error('Fetch bugs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH: Update bug report status
app.patch('/api/games/:id/bugs/:bugId', requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['open', 'investigating', 'auto-fixed', 'closed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const bugReport = await db.updateBugReport(req.params.bugId, { status });
    if (!bugReport) return res.status(404).json({ error: 'Bug report not found' });

    res.json(bugReport);
  } catch (err) {
    console.error('Update bug error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST: Auto-fix a bug report with AI analysis
app.post('/api/games/:id/bugs/:bugId/autofix', requireAuth, async (req, res) => {
  try {
    const gameId = req.params.id;
    const bugId = req.params.bugId;

    // Get bug report to verify it exists
    const bugs = await db.getBugReports(gameId);
    const bug = bugs.find(b => b.id === parseInt(bugId));
    if (!bug) return res.status(404).json({ error: 'Bug report not found' });

    // Get game state
    const gs = getGameState(gameId);
    const game = await db.getGame(gameId);
    const characters = await db.getCharacters(gameId);
    const charNames = Object.keys(characters);
    const combatActive = gs.combatEngine && gs.combatEngine.state.active;
    const round = gs.combatEngine?.state.round || 0;
    const turnCount = gs.turnCount || 0;
    const recentErrors = (global._combatErrors || []).slice(-5).join('\n');

    // Build state context for AI
    const stateContext = `
Game: ${game.name} (${game.system})
Characters: ${charNames.join(', ') || 'none'}
Combat Active: ${combatActive}
Round: ${round}
Turn Count: ${turnCount}
Recent Errors:
${recentErrors || 'none'}

Bug Report: ${bug.description}
`;

    const analysis = await llm.completeText({
      task: 'summary',
      gameId,
      maxTokens: 500,
      temperature: 0.1,
      prompt: `Analyze this game bug and suggest fixes. Return JSON only: { "analysis": "...", "fixes": [...fix actions...], "manual_steps": "..." }. Available fix actions: RESET_COMBAT, CLEAR_PAUSE, RESET_IDLE, ADVANCE_TURN, CLEAR_ERRORS.\n\n${stateContext}`,
    });

    let fixData = { analysis: '', fixes: [], manual_steps: '' };
    const responseText = analysis.text || '';
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        fixData = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      fixData.analysis = responseText;
    }

    // Apply fixes to in-memory state
    const appliedFixes = [];
    for (const fix of (fixData.fixes || [])) {
      if (fix === 'RESET_COMBAT' && gs.combatEngine) {
        gs.combatEngine.state.active = false;
        appliedFixes.push('RESET_COMBAT');
      } else if (fix === 'CLEAR_PAUSE') {
        gs.paused = false;
        appliedFixes.push('CLEAR_PAUSE');
      } else if (fix === 'RESET_IDLE') {
        gs.idleTurns = 0;
        appliedFixes.push('RESET_IDLE');
      } else if (fix === 'ADVANCE_TURN') {
        // Simple turn advance
        const turnOrder = gs.data.turnOrder || [];
        if (turnOrder.length > 0) {
          gs.data.currentTurnIndex = (gs.data.currentTurnIndex + 1) % turnOrder.length;
          appliedFixes.push('ADVANCE_TURN');
        }
      } else if (fix === 'CLEAR_ERRORS') {
        global._combatErrors = [];
        appliedFixes.push('CLEAR_ERRORS');
      }
    }

    // Update bug report with analysis and fixes
    const updatedBug = await db.updateBugReport(bugId, {
      status: appliedFixes.length > 0 ? 'auto-fixed' : 'investigating',
      ai_analysis: fixData.analysis,
      ai_fixes_applied: JSON.stringify(appliedFixes),
    });

    // Emit system event to all clients
    emitSystem(gameId, {
      text: `Bug report auto-fix applied: ${appliedFixes.join(', ') || 'analysis only'}. ${fixData.manual_steps || ''}`,
    });

    res.json({ analysis: fixData.analysis, fixesApplied: appliedFixes, ok: true });
  } catch (err) {
    console.error('Auto-fix error:', err);
    res.status(500).json({ error: err.message });
  }
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
  const costLog = getCostLog();
  const games_detail = {};
  for (const entry of costLog) {
    if (!games_detail[entry.gameId]) games_detail[entry.gameId] = { calls: 0, cost: 0 };
    games_detail[entry.gameId].calls++;
    games_detail[entry.gameId].cost += entry.cost || 0;
  }
  res.json({ ...summary, games: games_detail, recentCalls: costLog.slice(-20) });
});

app.get('/api/killshots/random', async (req, res) => {
  try {
    const count = parseInt(req.query.count) || 3;
    const killshots = await db.getRandomKillshots(count);
    res.json(killshots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Server-side Combat Test Endpoint ─────────────────────────────────────────
app.post('/api/test/combat', requireAuth, async (req, res) => {
  const startTime = Date.now();
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  const partyMode = req.body.party || 'balanced';
  const numTurns = Math.min(parseInt(req.body.turns) || 30, 100);
  const verbosity = req.body.verbosity || 'terse';

  // Load stock party
  const stockParties = require('./tests/fixtures/stock-parties.json');
  const party = stockParties[partyMode];
  if (!party) {
    return res.status(400).json({ error: `Unknown party: "${partyMode}". Valid: balanced, melee-heavy, caster-heavy` });
  }

  // Create ephemeral game — prefix with test- so rate limiter gives 300 calls/hour
  const gameId = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  try {
    // Minimal game row for getGame calls inside callGameLLM.
    await db.pool.query(
      `INSERT INTO games (id, name, system, host_user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [gameId, `Combat Test ${gameId}`, 'dnd5e', req.user.id]
    );
  } catch (e) {
    return res.status(500).json({ error: 'Failed to create test game: ' + e.message });
  }

  // Bootstrap game state
  const gs = getGameState(gameId);
  gs.verbosity = verbosity;
  gs.ferocity = 3;
  gs.pillars = { exploration: 20, combat: 60, social: 20 };
  gs.dmPersona = 'epic';
  gs.rulesCorrections = [];

  // Register characters
  for (const char of party) {
    gs.data.characters[char.name] = {
      name: char.name,
      class: char.class,
      level: char.level,
      personality: char.personality,
      backstory: char.backstory,
      standardActions: char.standardActions,
      statsText: char.statsText,
      combatStats: char.combatStats,
      token: null,
    };
    gs.data.turnOrder.push(char.name);
  }

  const gameConfig = await db.getGame(gameId);

  // Tracking
  const turnLog = [];
  let combatsDetected = 0;
  let totalWords = 0;
  let errors = 0;
  let lastOptions = [];
  let wasInCombat = false;
  let timedOut = false;

  // Cost snapshot before test
  const costBefore = costLog.filter(e => e.gameId === gameId).reduce((s, e) => s + (e.cost || 0), 0);

  console.log(`[test/combat] Starting ${numTurns}-turn test (party: ${partyMode}, verbosity: ${verbosity}, gameId: ${gameId})`);

  // Stream NDJSON to avoid Railway gateway timeout (30s)
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.flushHeaders();

  for (let turn = 1; turn <= numTurns; turn++) {
    if (Date.now() - startTime >= TIMEOUT_MS) {
      timedOut = true;
      console.log(`[test/combat] Timeout after ${turn - 1} turns`);
      break;
    }

    // Pick action: use a previous option or a sensible default
    let action;
    if (lastOptions.length > 0) {
      // Strip markdown formatting from option text before sending as action
      const raw = lastOptions[Math.floor(Math.random() * lastOptions.length)];
      action = raw.replace(/\*\*|__|\[.*?\]|\(.*?\)|[🎲🗡️🛡️🔥⚔️💫🌟✨]/gu, '').trim() || 'I attack';
    } else {
      action = turn === 1 ? 'We enter the dungeon, weapons ready.' : 'I attack';
    }

    const currentChar = gs.data.turnOrder[gs.data.currentTurnIndex % gs.data.turnOrder.length];
    const userMessage = `${currentChar}: ${action}`;
    const turnStart = Date.now();

    try {
      // ✅ FIX: Serialize narration streaming per game
      const result = await withStreamingLock(gameId, () =>
        callGameLLM(gameId, gameConfig, userMessage)
      );
      const turnElapsed = Date.now() - turnStart;

      // Word count from narration
      const words = result.narration ? result.narration.split(/\s+/).filter(Boolean).length : 0;
      totalWords += words;
      lastOptions = result.options || [];

      // Combat detection: check engine state change
      const nowInCombat = !!gs.combatEngine?.state?.active;
      if (nowInCombat && !wasInCombat) {
        combatsDetected++;
        console.log(`[test/combat] Turn ${turn}: Combat #${combatsDetected} started`);
      }
      wasInCombat = nowInCombat;

      turnLog.push({ turn, words, combat: nowInCombat, elapsed_ms: turnElapsed });
      res.write(JSON.stringify({ type: 'turn', turn, words, combat: nowInCombat, elapsed_ms: turnElapsed }) + '\n');
      console.log(`[test/combat] Turn ${turn}/${numTurns}: ${words}w, combat=${nowInCombat}, ${turnElapsed}ms`);

      // Advance turn index
      gs.data.currentTurnIndex = (gs.data.currentTurnIndex + 1) % gs.data.turnOrder.length;
    } catch (err) {
      errors++;
      const turnElapsed = Date.now() - turnStart;
      console.error(`[test/combat] Turn ${turn} error: ${err.message}`);
      turnLog.push({ turn, words: 0, combat: wasInCombat, elapsed_ms: turnElapsed, error: err.message });
      res.write(JSON.stringify({ type: 'turn', turn, words: 0, combat: wasInCombat, elapsed_ms: turnElapsed, error: err.message }) + '\n');

      // Reset options on error
      lastOptions = [];
    }
  }

  // Cost snapshot after test
  const costAfter = costLog.filter(e => e.gameId === gameId).reduce((s, e) => s + (e.cost || 0), 0);
  const testCost = Math.round((costAfter - costBefore) * 10000) / 10000;

  // Cleanup — remove from in-memory games and delete ephemeral DB row
  delete games[gameId];
  db.pool.query('DELETE FROM games WHERE id = $1', [gameId]).catch(() => {});

  const totalElapsed = Date.now() - startTime;
  const completedTurns = turnLog.length;
  const avgWordsPerTurn = completedTurns > 0 ? Math.round(totalWords / completedTurns) : 0;

  console.log(`[test/combat] Done: ${completedTurns} turns, ${combatsDetected} combats, $${testCost}, ${totalElapsed}ms`);

  res.write(JSON.stringify({
    type: 'summary',
    turns: completedTurns,
    combatsDetected,
    avgWordsPerTurn,
    errors,
    elapsed_ms: totalElapsed,
    end_time: new Date().toISOString(),
    cost: testCost,
    timedOut,
    party: partyMode,
    verbosity,
  }) + '\n');
  res.end();
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

// Admin: view combat engine errors (ring buffer, last 50)
app.get('/api/admin/errors', requireAuth, requireAdmin, (req, res) => {
  const errors = global._combatErrors || [];
  res.type('text/plain').send(errors.length ? errors.join('\n') : 'No combat errors recorded.');
});

// Admin: clear error buffer
app.delete('/api/admin/errors', requireAuth, requireAdmin, (req, res) => {
  global._combatErrors = [];
  res.json({ cleared: true });
});

app.get('/api/admin/llm-summary', requireAuth, requireAdmin, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(90, parseInt(req.query.days || '30', 10)));
    const rows = await db.getLlmExperimentSummary(days);
    res.json({ days, rows });
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

// REMOVED: anonymous session creation — all users must authenticate

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

// ── Generate truly random prompts (scene/party) ──
app.post('/api/generate-prompt', async (req, res) => {
  try {
    const { type, system } = req.body;
    if (!type || !system) return res.status(400).json({ error: 'Missing type or system' });

    const systemLabels = {
      dnd5e: 'D&D 5e',
      runequest: 'RuneQuest Glorantha',
      custom: 'generic fantasy RPG',
    };
    const systemName = systemLabels[system] || 'fantasy RPG';

    const prompts = {
      scene: `Generate a single, unique opening scene prompt for a ${systemName} adventure. The prompt should be evocative, specific, and 1-2 sentences. It should create immediate intrigue or action. Return ONLY the prompt text, nothing else.`,
      party: `Generate a unique party composition description for a ${systemName} campaign. Describe the party in 1-2 sentences, specifying number of characters, approximate level/capability, and general theme/style. Return ONLY the description text, nothing else.`,
    };

    const msg = await llm.completeText({
      task: 'summary',
      maxTokens: 150,
      temperature: 0.8,
      prompt: prompts[type],
    });

    const prompt = msg.text?.trim() || '';
    res.json({ prompt });
  } catch (err) {
    console.error('Prompt generation error:', err.message);
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
  if (!req.user) return res.redirect('/lobby');
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

// ── Idle game eviction (every 10 minutes) ─────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [gameId, gs] of Object.entries(games)) {
    const clients = getConnectedClients(gameId);
    if (clients === 0) {
      if (!gs._lastActivity) gs._lastActivity = now;
      if (now - gs._lastActivity > GAME_EVICTION_MINUTES * 60 * 1000) { // 1 hour
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
io.use(async (socket, next) => {
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
        const resolved = await resolveAuthToken(token);
        if (resolved.decoded?.anonymous) {
          socket.anonId = resolved.decoded.anonId;
          socket.userId = null;
        } else if (resolved.user) {
          socket.userId = resolved.user.id;
          socket.userEmail = resolved.user.email;
          socket.isAdmin = !!resolved.user.is_admin;
          socket.anonId = null;
        }
      } catch (e) {
        // Invalid token — allow connection but mark as unauthenticated
      }
    }
  }
  next();
});

// ── Socket Data Validation Helper ──────────────────────────────────────────────
function validateSocketData(data, schema) {
  for (const [key, type] of Object.entries(schema)) {
    if (typeof data[key] !== type) return false;
  }
  return true;
}

// ── Safe Socket Handler Wrapper ────────────────────────────────────────────────
function safeSocketHandler(handler) {
  return async (data, callback) => {
    try {
      return await handler(data, callback);
    } catch (err) {
      console.error('[Socket Error]', err.message);
      if (callback) callback({ error: err.message });
    }
  };
}

function buildGameplayDecisionTrace({ gs, playerName, message, source, llmRunId, rating, tags, note, llmRun }) {
  const combatActive = !!gs.combatEngine?.state?.active;
  const currentCombatant = combatActive ? gs.combatEngine.getCurrentTurn() : null;
  return {
    source,
    playerName,
    message: truncate(message, 1200),
    llmRunId: llmRunId || null,
    rating: rating || null,
    tags: tags || [],
    note: note || '',
    turnCount: gs.turnCount || 0,
    currentPlayer: gs.data?.turnOrder?.[gs.data?.currentTurnIndex || 0] || null,
    combatActive,
    combatRound: gs.combatEngine?.state?.round || null,
    combatTurn: currentCombatant ? { id: currentCombatant.id, name: currentCombatant.name, type: currentCombatant.type } : null,
    recentHistory: (gs.data?.chatHistory || []).slice(-8).map(entry => ({
      role: entry.role,
      content: truncate(entry.content, 1400),
    })),
    llmRun: llmRun ? {
      task: llmRun.task,
      model: llmRun.model,
      prompt: truncate(llmRun.prompt_text, 1800),
      output: truncate(llmRun.output_text, 1800),
      createdAt: llmRun.created_at,
    } : null,
  };
}

async function selfAssessAndMaybeLogBug({ gameId, game, gs, playerName, message, source, llmRunId = null, rating = null, tags = [], note = '', reporterUserId = null, force = false }) {
  if (!force && !looksLikeBehaviorReview(message)) return { bug: null, assessment: null };

  const llmRun = llmRunId ? await db.getLlmRun(llmRunId).catch(() => null) : null;
  const trace = buildGameplayDecisionTrace({ gs, playerName, message, source, llmRunId, rating, tags, note, llmRun });
  const prompt = `You are a QA triage assistant for an AI tabletop RPG server.

Decide whether this player feedback points to a programming improvement, not just a taste preference.

Log a bug when parser intent, combat routing, state preservation, prompt instructions, turn flow, rules handling, or context memory should be improved in code or prompts.
Do not log a bug for pure praise, tone preference, or one-off fiction preference with no actionable programming change.

Return ONLY JSON:
{
  "shouldLog": true,
  "slug": "lower_snake_case_short_codex_slug",
  "summary": "one sentence",
  "programmingImprovement": "specific code/prompt behavior to improve",
  "decisionTrace": ["brief evidence item", "brief evidence item"],
  "severity": "low|medium|high"
}

Feedback source: ${source}
Player: ${playerName || 'unknown'}
Feedback/OOC: ${message || '(none)'}
Rating: ${rating || 'n/a'}
Tags: ${(tags || []).join(', ') || 'none'}
Note: ${note || 'none'}

Decision context:
${JSON.stringify(trace, null, 2)}`;

  let assessment = null;
  try {
    const response = await llm.completeText({
      task: 'summary',
      gameId,
      maxTokens: 450,
      temperature: 0.1,
      prompt,
    });
    assessment = extractJsonObject(response.text) || {
      shouldLog: false,
      summary: truncate(response.text, 500),
      decisionTrace: [],
    };
    trace.selfAssessmentRunId = response.llmRunId || null;
    trace.selfAssessmentModel = response.model || null;
  } catch (err) {
    console.warn('[self-assess] failed:', err.message);
    return { bug: null, assessment: null };
  }

  if (!assessment?.shouldLog && !force) return { bug: null, assessment };
  if (!assessment?.shouldLog && force) {
    assessment.shouldLog = true;
    assessment.slug = assessment.slug || `${source}_needs_review`;
    assessment.summary = assessment.summary || 'Player requested an actionable review of this behavior.';
    assessment.programmingImprovement = assessment.programmingImprovement || 'Inspect the recorded decision trace and improve the related parser, option generation, prompt, or state-routing behavior.';
    assessment.decisionTrace = Array.isArray(assessment.decisionTrace) && assessment.decisionTrace.length
      ? assessment.decisionTrace
      : ['Player used an actionable feedback control that should produce a code-reviewable trace.'];
    assessment.severity = assessment.severity || 'medium';
  }

  const slug = sanitizeBugSlug(assessment.slug || assessment.summary || message);
  const decisionTrace = {
    ...trace,
    assessment: {
      ...assessment,
      slug,
    },
  };
  const description = [
    `Auto-logged gameplay programming issue from ${source}.`,
    `Slug: ${slug}`,
    `Severity: ${assessment.severity || 'medium'}`,
    `Summary: ${assessment.summary || 'No summary provided.'}`,
    `Programming improvement: ${assessment.programmingImprovement || 'Review decision trace.'}`,
    ``,
    `Decision trace:`,
    ...(Array.isArray(assessment.decisionTrace) && assessment.decisionTrace.length
      ? assessment.decisionTrace.map(item => `- ${item}`)
      : ['- See structured decision_trace metadata.']),
    ``,
    `Player feedback/OOC: ${message || '(none)'}`,
    llmRunId ? `LLM run: ${llmRunId}` : '',
  ].filter(line => line !== '').join('\n');

  const bug = await db.saveBugReport(
    gameId,
    game?.name || gameId,
    reporterUserId,
    description,
    null,
    { slug, decisionTrace, source }
  );
  io.to(hostRoom(gameId)).emit('bug_report_created', { bug, source });
  return { bug, assessment };
}

// ── Socket Events ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('narration_feedback', safeSocketHandler(async (data, ack) => {
    const gameId = socket.gameId;
    const llmRunId = data?.llmRunId;
    const rating = Number(data?.rating || 1);
    if (!gameId || !llmRunId || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      if (ack) ack({ error: 'Invalid feedback' });
      return;
    }
    const allowedTags = new Set([
      'rules_wrong', 'forgot_context', 'review', 'retcon', 'redo_options',
    ]);
    const tags = Array.isArray(data.tags)
      ? data.tags.filter(tag => allowedTags.has(tag)).slice(0, 6)
      : [];
    const note = truncate(String(data.note || ''), 500);
    const saved = await db.saveNarrationFeedback({
      id: crypto.randomUUID(),
      llmRunId,
      gameId,
      userId: socket.userId || null,
      rating,
      tags,
      note,
    });
    let reviewBug = null;
    if (tags.some(tag => ['review', 'retcon', 'redo_options', 'rules_wrong', 'forgot_context'].includes(tag))) {
      const gs = getGameState(gameId);
      const game = await db.getGame(gameId);
      const source = tags.includes('redo_options') ? 'redo_options_feedback'
        : tags.includes('retcon') ? 'retcon_feedback'
          : 'narration_feedback';
      const message = note || `Tune GM feedback: ${tags.join(', ')}`;
      const result = await selfAssessAndMaybeLogBug({
        gameId,
        game,
        gs,
        playerName: data.playerName || socket.userName || null,
        message,
        source,
        llmRunId,
        rating,
        tags,
        note,
        reporterUserId: socket.userId || null,
        force: tags.includes('review') || tags.includes('retcon') || tags.includes('redo_options'),
      });
      reviewBug = result.bug;
    }
    if (ack) ack({ ok: true, feedbackId: saved.id, reviewBugId: reviewBug?.id || null });
  }));

  socket.on('redo_options', safeSocketHandler(async (data, ack) => {
    const gameId = socket.gameId;
    const llmRunId = data?.llmRunId || null;
    if (!gameId) {
      if (ack) ack({ ok: false, error: 'No game joined' });
      return;
    }

    const gs = getGameState(gameId);
    const game = await db.getGame(gameId);
    const targetPlayer = getVisiblePlayerForOptions(gameId) || getCurrentPlayer(gameId);
    const character = targetPlayer ? gs.data.characters?.[targetPlayer] : null;
    const llmRun = llmRunId ? await db.getLlmRun(llmRunId).catch(() => null) : null;
    const sourceNarration = truncate(
      (llmRun?.output_text ? parseResponse(llmRun.output_text).narration : '') ||
      (gs.data.chatHistory || []).slice(-1)[0]?.content ||
      '',
      1800
    );

    await selfAssessAndMaybeLogBug({
      gameId,
      game,
      gs,
      playerName: data?.playerName || targetPlayer || null,
      message: 'Player requested Redo Options because the current suggested actions were off, generic, or not scene-suited.',
      source: 'redo_options',
      llmRunId,
      rating: 1,
      tags: ['redo_options'],
      note: '',
      reporterUserId: socket.userId || null,
      force: true,
    });

    const response = await llm.completeText({
      task: 'options-fallback',
      gameId,
      maxTokens: 220,
      temperature: 0.4,
      prompt: `Regenerate exactly 3 scene-specific player options for ${targetPlayer || 'the current player'} in this ${game?.system || 'D&D 5e'} game.

Avoid generic "attack / defend / wild move" defaults. Use concrete details from the current scene. Do not duplicate spell/skill button basics unless the scene specifically calls for them.
If the scene is social or travel-focused, include social, investigative, or advancement options rather than combat.

Character standard actions and capabilities:
${character?.standardActions || 'unknown'}

Current narration:
${sourceNarration || 'No narration available.'}

Output ONLY this format:
1️⃣ [specific option]
2️⃣ [specific option]
3️⃣ [specific option]`,
    });

    const options = extractNumberedOptions(response.text);
    if (options.length < 2) {
      if (ack) ack({ ok: false, error: 'Could not regenerate useful options' });
      return;
    }

    gs.lastOptions = options;
    if (targetPlayer) gs.lastOptionsForPlayer = targetPlayer;
    if (gs.combatEngine.state.active && targetPlayer) {
      const nextPlayer = gs.combatEngine.getCurrentTurn();
      if (nextPlayer) {
        const combatCtx = { combatants: gs.combatEngine.state.combatants, gameId };
        const tier1 = parseOptions(options, nextPlayer.id, combatCtx);
        gs.preTaggedOptions = tier1.some(r => r === null)
          ? await parseOptionsWithAI(options, nextPlayer.id, combatCtx).catch(() => tier1)
          : tier1;
      }
    }

    const payload = { options, forPlayer: targetPlayer, llmRunId: response.llmRunId || null, sourceRunId: llmRunId };
    socket.emit('options_redone', payload);
    if (ack) ack({ ok: true, ...payload });
  }));

  // Join a game room
  socket.on('join_game', async (gameId) => {
    let game = await db.getGame(gameId);
    if (!game) {
      if (TEST_MODE) {
        // Auto-create games in test mode
        console.log(`[TEST_MODE] Auto-creating game: ${gameId}`);
        await db.createGame(gameId, `Test Game ${gameId.substring(0, 8)}`, 'dnd5e');
        game = await db.getGame(gameId);
      } else {
        socket.emit('error_msg', { text: 'Game not found.' });
        return;
      }
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
      gs.imageStyle = game?.image_style || 'oil-painting';
      gs.imageUrl = game?.last_image_url || null;
      gs.imageLabel = await db.getState(gameId, 'imageLabel', null);
      gs.storySummary = await db.getState(gameId, 'storySummary', null);
      gs.combatHistory = await db.getState(gameId, 'combatHistory', {});
      gs.difficultyCorrection = await db.getState(gameId, 'difficultyCorrection', 1.0);
      gs.npcMemory = await db.getState(gameId, 'npcMemory', {});
      gs.lastCombatConclusion = await db.getState(gameId, 'lastCombatConclusion', null);
      gs.targetPreferences = await db.getState(gameId, 'targetPreferences', {});
      gs.currentCombatId = await db.getState(gameId, 'currentCombatId', null);
      gs.combatXpAwardedForCombatId = await db.getState(gameId, 'combatXpAwardedForCombatId', null);
      gs.lastCombatXpAward = await db.getState(gameId, 'lastCombatXpAward', null);
      gs.encounterPlan = plannerState.normalizeEncounterPlan(await db.getState(gameId, 'encounterPlan', null));
      gs.encounterPlanIndex = gs.encounterPlan?._currentIndex || 0;
      const savedCombat = await db.getState(gameId, 'combatState', null);
      if (savedCombat) gs.combatEngine.loadState(savedCombat);
    }

    const gs = getGameState(gameId);
    const isHost = socketIsHost(socket, game);
    if (isHost) socket.join(hostRoom(gameId));
    gs.rulesCorrections = await db.getRulesCorrections(gameId);
    const joinedTurnOrder = gs.data.turnOrder?.length
      ? gs.data.turnOrder
      : Object.keys(gs.data.characters || {});

    socket.emit('game_joined', {
      game,
      chatHistory: gs.data.chatHistory,
      characters: gs.data.characters,
      turnOrder: joinedTurnOrder,
      currentPlayer: getCurrentPlayer(gameId) || joinedTurnOrder[0] || null,
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
      imageStyle: gs.imageStyle,
      pdfUploads: await db.getState(gameId, 'pdf_uploads', []),
      encounterPlan: isHost ? plannerState.toHostPlan(gs.encounterPlan) : null,
      targetPreferences: gs.targetPreferences || {},
      isHost,
      currentUserId: socket.userId || null,
    });

    // If combat is active, send current state to the joining client
    if (gs.combatEngine.state.active) {
      socket.emit('combat_started', combatSocketPayload(gameId));
      socket.emit('combat_update', combatSocketPayload(gameId));
    }
  });

  // Register / update character
  socket.on('register_character', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;

    // Validate input data
    if (!validateSocketData(data, { name: 'string' })) {
      socket.emit('error_msg', { text: 'Invalid data format' });
      return;
    }

    // Preserve existing token if re-registering and no new upload
    const gs = getGameState(gameId);
    const existing = gs.data.characters[data.name];

    data.name = truncate(data.name, 50);
    const charData = {
      statsText: truncate(data.statsText, MAX_CHAR_FIELD) || '',
      personality: truncate(data.personality, MAX_CHAR_FIELD) || 'Brave and curious',
      standardActions: truncate(data.standardActions, MAX_CHAR_FIELD) || '',
      backstory: truncate(data.backstory, MAX_CHAR_FIELD) || '',
      combatStats: existing?.combatStats || null,
      token: data.token === null ? null : (data.token || (existing && existing.token) || null),
    };
    const parsedLocalStats = parseStatsLocal(charData.statsText);
    if (parsedLocalStats) {
      charData.combatStats = normalizeDnd5eCombatStats({
        ...parsedLocalStats,
        spells: existing?.combatStats?.spells?.length ? existing.combatStats.spells : parsedLocalStats.spells,
        spellSlots: existing?.combatStats?.spellSlots || parsedLocalStats.spellSlots,
        spellcastingAbility: existing?.combatStats?.spellcastingAbility || parsedLocalStats.spellcastingAbility,
        attackProfiles: existing?.combatStats?.attackProfiles || parsedLocalStats.attackProfiles,
      });
    } else if (charData.combatStats?.system === 'dnd5e') {
      charData.combatStats = normalizeDnd5eCombatStats(charData.combatStats);
    }

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
      }).catch(err => console.error('[token-gen]', err.message));
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
      const result = await discordGameEngine.generateParty(gameId, direction);
      socket.emit('party_generated', { count: result.count });

      // COMBAT_JSON is now parsed directly during party generation.
      const gs = getGameState(gameId);
      let withStats = 0;
      const charStats = {};
      for (const [name, char] of Object.entries(gs.data.characters)) {
        if (char.combatStats) {
          charStats[name] = char.combatStats;
          withStats++;
        }
      }
      console.log(`Party generated: ${result.count} characters, ${withStats} with combatStats (from COMBAT_JSON)`);

      // Fallback: for characters missing combatStats, try regex-based local parsing
      for (const [name, char] of Object.entries(gs.data.characters)) {
        if (!char.combatStats && char.statsText) {
          const parsed = parseStatsLocal(char.statsText);
          if (parsed) {
            char.combatStats = parsed;
            charStats[name] = parsed;
            withStats++;
            db.upsertCharacter(gameId, name, char).catch(() => {});
          }
        }
      }

	      io.to(gameId).emit('party_ready', { count: result.count, statsParsed: withStats, combatStats: charStats });
	    } catch (err) {
	      console.error('Party generation failed:', err.message);
	      try {
	        const gameConfig = await db.getGame(gameId);
	        const gs = getGameState(gameId);
	        const fallbackParty = createFallbackParty(gameConfig.system || 'dnd5e');
	        let fallbackCount = 0;
	        const charStats = {};

	        for (const character of fallbackParty) {
	          const charData = {
	            statsText: character.statsText,
	            personality: character.personality,
	            standardActions: character.standardActions,
	            backstory: character.backstory,
	            combatStats: character.combatStats,
	            token: null,
	          };

	          gs.data.characters[character.name] = charData;
	          if (!gs.data.turnOrder.includes(character.name)) {
	            gs.data.turnOrder.push(character.name);
	          }
	          if (charData.combatStats) charStats[character.name] = charData.combatStats;
	          await db.upsertCharacter(gameId, character.name, charData);
	          io.to(gameId).emit('character_registered', { name: character.name, character: charData });
	          emitSystem(gameId, { text: `📜 ${character.name} has joined the campaign.` });
	          fallbackCount++;
	        }

	        await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);
	        socket.emit('party_generated', { count: fallbackCount, fallback: true });
	        io.to(gameId).emit('party_ready', { count: fallbackCount, statsParsed: Object.keys(charStats).length, combatStats: charStats, fallback: true });
	        console.log(`Fallback party generated: ${fallbackCount} characters after party generation failure`);
	      } catch (fallbackErr) {
	        console.error('Fallback party generation failed:', fallbackErr.message);
	        socket.emit('party_gen_failed', { error: err.message });
	      }
	    }
	  });

  // Player sends an action
  socket.on('player_action', async (data, ack) => {
    let actionAcknowledged = false;
    const ackAction = (payload) => {
      if (actionAcknowledged || typeof ack !== 'function') return;
      actionAcknowledged = true;
      try { ack(payload); } catch {}
    };

    let gameId = socket.gameId;
    if (!gameId && typeof data?.gameId === 'string') {
      const requestedGameId = truncate(data.gameId, 100);
      const game = await db.getGame(requestedGameId);
      if (!game) {
        ackAction({ ok: false, error: 'Game not found.' });
        socket.emit('error_msg', { text: 'Game not found.' });
        return;
      }
      socket.join(requestedGameId);
      socket.gameId = requestedGameId;
      gameId = requestedGameId;
      if (socket.handshake.auth?.userId) {
        socket.userId = socket.handshake.auth.userId;
      }
    }
    if (!gameId) {
      ackAction({ ok: false, error: 'Reconnecting to the game. Try again in a moment.' });
      socket.emit('system', { text: 'Reconnecting to the game. Try again in a moment.' });
      return;
    }

    const playerName = truncate(data?.playerName, 50);
    const action = truncate(data?.action, 2000);
    if (!playerName || !action) {
      ackAction({ ok: false, error: 'Choose a character and action before sending.' });
      socket.emit('system', { text: 'Choose a character and action before sending.' });
      return;
    }

    // Block anonymous users past 120-minute limit
    if (socket.anonId && !socket.userId) {
      const anonSession = await db.getAnonSession(socket.anonId);
      if (anonSession && anonSession.minutes_used >= MAX_ANON_MINUTES) {
        ackAction({ ok: false, error: 'Create a free account to keep playing.' });
        socket.emit('signup_required', {
          minutesUsed: anonSession.minutes_used,
          message: 'Create a free account to keep playing. It takes 10 seconds.',
        });
        return;
      }
    }

    // Block spectators from taking actions
    if (socket.userId && billingTicker.isSpectator(gameId, socket.userId)) {
      ackAction({ ok: false, error: 'You are in spectator mode. Add time to resume control.' });
      socket.emit('system', { text: 'You are in spectator mode. Add time to resume control.' });
      return;
    }

    // Gate: combat initializing — only allow OOC during monster loading
    const gsCheck = games[gameId];
    if (gsCheck?.combatInitializing) {
      ackAction({ ok: false, error: 'Combat is loading. Try again in a moment.' });
      socket.emit('system', { text: '⏳ Combat is loading — use OOC to chat while initiative is rolled.' });
      return;
    }

    const current = getCurrentPlayer(gameId);

    if (current && current.toLowerCase() !== playerName.toLowerCase()) {
      ackAction({ ok: false, error: `It's ${current}'s turn, not yours.` });
      socket.emit('system', { text: `It's ${current}'s turn, not yours.` });
      return;
    }

    const gs = getGameState(gameId);
    clearTimeout(gs.turnTimer);
    if (data?.targetPreferences && typeof data.targetPreferences === 'object') {
      gs.targetPreferences = gs.targetPreferences || {};
      gs.targetPreferences[playerName] = targetAuthority.normalizeTargetPreferences(data.targetPreferences);
      db.setState(gameId, 'targetPreferences', gs.targetPreferences).catch(() => {});
    }

    // Auto-unpause on human action
    if (gs.paused) {
      gs.paused = false;
      gs.idleTurns = 0;
      emitSystem(gameId, { text: '▶️ Game resumed!' });
      io.to(gameId).emit('game_resumed');
    }

    const playerToken = gs.data.characters[playerName]?.token || null;
    ackAction({ ok: true });
    io.to(gameId).emit('player_message', { player: playerName, text: action, token: playerToken });
    discord.onSystem(gameId, { text: `**${playerName}:** ${action}` }).catch(() => {});

    try {
      const gameConfig = await db.getGame(gameId);
      const combatFastPath = await tryResolveCombatActionFastPath(gameId, gameConfig, playerName, action);
      if (combatFastPath?.handled) {
        if (!combatFastPath.blocked) {
          await advanceTurn(gameId, gameConfig, true);
        } else {
          appendTacticalHistory(gameId, playerName, action, combatFastPath.text);
        }
        const nextPlayer = combatFastPath.blocked ? playerName : getVisiblePlayerForOptions(gameId);
        const fastOptions = combatFastPath.blocked
          ? combatFastPath.options
          : (() => {
              const turn = gs.combatEngine?.state?.active ? gs.combatEngine.getCurrentTurn() : null;
              return turn?.type === 'PC' ? templateEngine.generateCombatOptions(gs.combatEngine, turn.name) : [];
            })();
        emitDmMessage(gameId, {
          text: combatFastPath.text,
          options: fastOptions,
          auto: false,
          tactical: true,
          previousPlayer: playerName,
          forPlayer: nextPlayer,
          llmRunId: combatFastPath.llmRunId,
        });
        io.to(gameId).emit('action_complete', { forPlayer: nextPlayer });
        return;
      }
      // ✅ FIX: Serialize narration streaming per game to prevent concurrent chunk interleaving
      const { narration, options, scene, world, isKillshot, mapMoved, llmRunId, blocked } = await withStreamingLock(gameId, () =>
        callGameLLM(gameId, gameConfig, `${playerName}: ${action}`)
      );
      if (!blocked) await advanceTurn(gameId, gameConfig, true);
      const nextPlayer = blocked ? playerName : getVisiblePlayerForOptions(gameId);
      emitDmMessage(gameId, { text: narration, options, auto: false, previousPlayer: playerName, forPlayer: nextPlayer, world, llmRunId });
      io.to(gameId).emit('action_complete', { forPlayer: nextPlayer });
      maybeGenerateImage(gameId, gameConfig, scene, isKillshot, mapMoved, narration)
        .catch(err => console.error('[scene-gen-after-player-action]', err.message));
    } catch (err) {
      console.error('player_action error:', err.message, err.stack?.split('\n').slice(0, 3).join(' | '));
      socket.emit('system', { text: 'Error communicating with the DM. Try again.' });
    }
  });

  socket.on('set_target_preferences', async (data, ack) => {
    const gameId = socket.gameId || truncate(data?.gameId, 100);
    if (!gameId) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Join a game before setting targets.' });
      return;
    }
    const player = truncate(data?.playerName, 50);
    if (!player) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Choose a character before setting targets.' });
      return;
    }
    const gs = getGameState(gameId);
    gs.targetPreferences = gs.targetPreferences || {};
    gs.targetPreferences[player] = targetAuthority.normalizeTargetPreferences(data || {});
    await db.setState(gameId, 'targetPreferences', gs.targetPreferences);
    const payload = {
      playerName: player,
      targetPreferences: gs.targetPreferences,
      targetSuggestions: gs.combatEngine?.state?.active ? getCurrentTargetSuggestions(gs) : null,
    };
    io.to(gameId).emit('target_preferences_updated', payload);
    if (gs.combatEngine?.state?.active) emitCombatUpdate(gameId);
    if (typeof ack === 'function') ack({ ok: true });
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

      const response = await llm.completeText({
        task: 'ooc',
        gameId,
        maxTokens: 256,
        temperature: 0.5,
        system: buildTrimmedPrompt(gameId, gameConfig),
        messages: [...gs.data.chatHistory, { role: 'user', content: oocPrompt }],
      });

      let reply = response.text;
      const reviewResult = await selfAssessAndMaybeLogBug({
        gameId,
        game: gameConfig,
        gs,
        playerName,
        message,
        source: 'ooc_self_assessment',
        reporterUserId: socket.userId || null,
      });
      if (reviewResult.bug?.slug) {
        reply = `${reply}\n\nProgramming review logged for Codex: ${reviewResult.bug.slug}`;
      }

      // Save OOC exchanges in history so the GM remembers.
      gs.data.chatHistory.push(
        { role: 'user', content: `[OOC: ${message}]` },
        { role: 'assistant', content: `[OOC acknowledged: ${reply}]` }
      );
      await db.saveChatHistory(gameId, gs.data.chatHistory);

      // Broadcast to all players
      io.to(gameId).emit('ooc_message', { player: playerName, message, reply });
      discord.onSystem(gameId, { text: `💭 [OOC] ${playerName}: ${message}\n💭 [GM]: ${reply}` }).catch(() => {});

      // Auto-save OOC instruction as a rules correction
      await db.addRuleCorrection(gameId, message.slice(0, MAX_RULE_TEXT), 'ooc');
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
      await ensurePlayablePartyForStart(gameId, gameConfig, gs, socket);
      publishCurrentTurn(gameId, gameConfig, { startTimer: false });
      // ✅ FIX: Serialize narration streaming per game
      const { narration, options, scene, world, llmRunId } = await withStreamingLock(gameId, () =>
        callGameLLM(gameId, gameConfig, prompt || 'Begin the adventure. Set the scene vividly.')
      );
      const firstPlayer = getCurrentPlayer(gameId);
      emitDmMessage(gameId, { text: narration, options, auto: false, forPlayer: firstPlayer, world, llmRunId });
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
        }).catch(err => console.error('[scene-gen]', err.message));
      }
      publishCurrentTurn(gameId, gameConfig);
      // Generate encounter plan for the adventuring day
      const plannerDay = await buildPlannerDay(gameId, gameConfig, gs);
      if (plannerDay.ok) {
        gs.encounterPlan = plannerState.createEncounterPlan(plannerDay.day, plannerDay.metadata);
        gs.encounterPlanIndex = 0;
        await persistEncounterPlan(gameId);
        emitPlannerUpdate(gameId);
      }
      // Start billing ticker for this game
      billingTicker.startForGame(gameId, gameConfig.host_user_id, gs);
    } catch (err) {
      console.error('[dm_start] Error:', err.message, err.stack?.split('\n').slice(0, 5).join(' | '));
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

  socket.on('move_to_next_beat', async (data, ack) => {
    const ctx = await ensureHostSocket(socket, ack);
    if (!ctx) return;
    try {
      const actorName = truncate(data?.playerName, 50) || 'Host';
      const result = await moveToNextBeat(ctx.gameId, ctx.game, actorName);
      if (typeof ack === 'function') ack({ ok: true, llmRunId: result.llmRunId || null });
    } catch (err) {
      console.error('move_to_next_beat error:', err.message);
      if (typeof ack === 'function') ack({ ok: false, error: 'Failed to move to the next beat.' });
      socket.emit('system', { text: 'Failed to move to the next beat.' });
    }
  });

  socket.on('finish_cinematic', async (data, ack) => {
    const gameId = socket.gameId;
    if (!gameId) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Join a game before proposing a finish.' });
      return;
    }
    const gs = getGameState(gameId);
    if (!gs.combatEngine?.state?.active) {
      if (typeof ack === 'function') ack({ ok: false, error: 'No active combat.' });
      return;
    }
    const gameConfig = await db.getGame(gameId);
    const proposer = truncate(data?.playerName, 50) || getCombatPlayerNameForCurrentTurn(gs) || 'A player';
    if (getConnectedClients(gameId) <= 1) {
      const result = await finishCombatCinematically(gameId, gameConfig, proposer);
      if (typeof ack === 'function') ack(result);
      return;
    }
    gs.pendingCinematicFinish = { id: crypto.randomUUID(), proposer, createdAt: new Date().toISOString() };
    io.to(gameId).emit('cinematic_finish_proposed', gs.pendingCinematicFinish);
    if (typeof ack === 'function') ack({ ok: true, pending: true });
  });

  socket.on('finish_cinematic_confirm', async (data, ack) => {
    const ctx = await ensureHostSocket(socket, ack);
    if (!ctx) return;
    const proposer = ctx.gs.pendingCinematicFinish?.proposer || truncate(data?.playerName, 50) || 'The table';
    const result = await finishCombatCinematically(ctx.gameId, ctx.game, proposer);
    if (typeof ack === 'function') ack(result);
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
    socket.emit('system', { text: `📝 Backstory note added for ${data.name}. The GM will weave it into the narrative.` });
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
        const locationName = data.name || (data.context ? data.context.split(' ')[0] : 'Unknown Location');
        gs.world.locations.push({ name: locationName, description: data.context || '', distance: '' });
      }
    } else if (data.type === 'npc') {
      const existing = gs.world.npcs.find(n => n.name.toLowerCase() === data.name?.toLowerCase());
      if (existing) {
        existing.description += ` | ${data.context}`;
      } else {
        const npcName = data.name || (data.context ? data.context.split(' ')[0] : 'Unknown NPC');
        gs.world.npcs.push({ name: npcName, description: data.context || '', location: '' });
      }
    }
    await db.setState(gameId, 'world', gs.world);
    io.to(gameId).emit('world_updated', gs.world);
    socket.emit('system', { text: `🗺️ World context added. The GM will use this in the narrative.` });
  });

  socket.on('save_character', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const gs = getGameState(gameId);
    const char = gs.data.characters[data.name];
    if (!char) return;
    if (data.statsText !== undefined) char.statsText = truncate(data.statsText, MAX_CHAR_FIELD);
    if (data.personality !== undefined) char.personality = truncate(data.personality, MAX_CHAR_FIELD);
    if (data.standardActions !== undefined) char.standardActions = truncate(data.standardActions, MAX_CHAR_FIELD);
    if (data.backstory !== undefined) char.backstory = truncate(data.backstory, MAX_CHAR_FIELD);
    const parsedLocalStats = parseStatsLocal(char.statsText || '');
    if (parsedLocalStats) {
      char.combatStats = normalizeDnd5eCombatStats({
        ...parsedLocalStats,
        spells: char.combatStats?.spells?.length ? char.combatStats.spells : parsedLocalStats.spells,
        spellSlots: char.combatStats?.spellSlots || parsedLocalStats.spellSlots,
        spellcastingAbility: char.combatStats?.spellcastingAbility || parsedLocalStats.spellcastingAbility,
        attackProfiles: char.combatStats?.attackProfiles || parsedLocalStats.attackProfiles,
      });
    } else if (char.combatStats?.system === 'dnd5e') {
      char.combatStats = normalizeDnd5eCombatStats(char.combatStats);
    }
    if (char.combatStats?.system === 'dnd5e' && Array.isArray(data.combatProfiles)) {
      char.combatStats = applyCombatProfileEdits(char.combatStats, data.combatProfiles);
    }
    await db.upsertCharacter(gameId, data.name, char);
    socket.emit('system', { text: `✅ ${data.name}'s character sheet saved.` });
    io.to(gameId).emit('character_updated', { name: data.name, character: char });
  });

  socket.on('catch_up', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    try {
      const result = await discordGameEngine.catchUp(gameId, data.playerName);
      socket.emit('catch_up_result', result);
    } catch (err) {
      socket.emit('catch_up_result', { summary: 'Error generating summary.' });
    }
  });

  socket.on('skip_turn', safeSocketHandler(async () => {
    const gameId = socket.gameId;
    if (!gameId) return;
    await discordGameEngine.skipTurn(gameId);
  }));

  socket.on('set_pillars', safeSocketHandler(async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    await discordGameEngine.setPillars(gameId, data.exploration || 33, data.combat || 33, data.social || 34);
  }));

  socket.on('set_verbosity', safeSocketHandler(async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    await discordGameEngine.setVerbosity(gameId, data.level);
  }));

  socket.on('set_ferocity', safeSocketHandler(async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    await discordGameEngine.setFerocity(gameId, data.level);
  }));

  socket.on('set_dm_persona', safeSocketHandler(async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    discordGameEngine.setDmPersona(gameId, data.persona);
  }));

  socket.on('set_image_style', safeSocketHandler(async (style) => {
    const gameId = socket.gameId;
    if (!gameId || !ART_STYLES[style]) return;
    const gs = getGameState(gameId);
    gs.imageStyle = style;
    await db.pool.query('UPDATE games SET image_style = $1 WHERE id = $2', [style, gameId])
      .catch(e => console.error('[style-save]', e));
    io.to(gameId).emit('setting_changed', { key: 'imageStyle', value: style });
  }));

  socket.on('set_timer', safeSocketHandler(async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    discordGameEngine.setTimer(gameId, data.seconds);
  }));

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
    await discordGameEngine.deleteCharacter(gameId, data.name);
  });

  socket.on('deactivate_character', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    await discordGameEngine.deactivateCharacter(gameId, data.name);
  });

  socket.on('activate_character', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    await discordGameEngine.activateCharacter(gameId, data.name);
  });

  socket.on('reveal_location', async (data) => {
    const gameId = socket.gameId;
    if (!gameId) return;

    // Validate input data
    if (!validateSocketData(data, { name: 'string' })) {
      socket.emit('error_msg', { text: 'Invalid data format' });
      return;
    }

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

  async function handlePlannerGenerate(data = {}, ack, append = false) {
    const ctx = await ensureHostSocket(socket, ack);
    if (!ctx) return;
    const { gameId, game, gs } = ctx;
    const plannerDay = await buildPlannerDay(gameId, game, gs, data || {});
    if (!plannerDay.ok) {
      if (typeof ack === 'function') ack({ ok: false, error: plannerDay.error });
      socket.emit('error_msg', { text: plannerDay.error });
      return;
    }

    gs.encounterPlan = append && gs.encounterPlan
      ? plannerState.appendAdventuringDay(gs.encounterPlan, plannerDay.day, plannerDay.metadata)
      : plannerState.createEncounterPlan(plannerDay.day, plannerDay.metadata);
    gs.encounterPlanIndex = gs.encounterPlan._currentIndex || 0;
    await persistEncounterPlan(gameId);
    const hostPlan = emitPlannerUpdate(gameId);
    if (typeof ack === 'function') ack({
      ok: true,
      plan: hostPlan,
      message: append ? 'Queued the next adventuring day.' : 'Planned the adventuring day.',
    });
  }

  async function handlePlannerDifficulty(data = {}, ack) {
    const ctx = await ensureHostSocket(socket, ack);
    if (!ctx) return;
    if (!validateSocketData(data, { harder: 'boolean' })) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Invalid data format' });
      socket.emit('error_msg', { text: 'Invalid data format' });
      return;
    }
    if (!ctx.gs.encounterPlan) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Generate a day plan first.' });
      return;
    }

    ctx.gs.encounterPlan = plannerState.scalePendingDifficulty(ctx.gs.encounterPlan, data.harder ? 1.2 : 0.8);
    ctx.gs.encounterPlanIndex = ctx.gs.encounterPlan._currentIndex || 0;
    await persistEncounterPlan(ctx.gameId);
    const hostPlan = emitPlannerUpdate(ctx.gameId);
    if (typeof ack === 'function') ack({ ok: true, plan: hostPlan, message: data.harder ? 'Pending encounters hardened.' : 'Pending encounters eased.' });
  }

  async function handlePlannerBoss(ack) {
    const ctx = await ensureHostSocket(socket, ack);
    if (!ctx) return;
    if (!ctx.gs.encounterPlan) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Generate a day plan first.' });
      return;
    }
    ctx.gs.encounterPlan = plannerState.setBossAsNext(ctx.gs.encounterPlan);
    ctx.gs.encounterPlanIndex = ctx.gs.encounterPlan._currentIndex || 0;
    await persistEncounterPlan(ctx.gameId);
    const hostPlan = emitPlannerUpdate(ctx.gameId);
    if (typeof ack === 'function') ack({ ok: true, plan: hostPlan, message: 'Boss set as the next planned encounter.' });
  }

  async function handlePlannerRest(ack) {
    const ctx = await ensureHostSocket(socket, ack);
    if (!ctx) return;
    if (!ctx.gs.encounterPlan) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Generate a day plan first.' });
      return;
    }
    ctx.gs.encounterPlan = plannerState.insertRestAtCurrent(ctx.gs.encounterPlan, 'short');
    ctx.gs.encounterPlanIndex = ctx.gs.encounterPlan._currentIndex || 0;
    await persistEncounterPlan(ctx.gameId);
    const hostPlan = emitPlannerUpdate(ctx.gameId);
    if (typeof ack === 'function') ack({ ok: true, plan: hostPlan, message: 'Short rest inserted before the next encounter.' });
  }

  socket.on('adjust_difficulty', (data, ack) => handlePlannerDifficulty(data, ack));
  socket.on('planner:adjust_difficulty', (data, ack) => handlePlannerDifficulty(data, ack));
  socket.on('regenerate_plan', (data, ack) => handlePlannerGenerate(data, ack, false));
  socket.on('planner:generate_day', (data, ack) => handlePlannerGenerate(data, ack, false));
  socket.on('planner:plan_next_day', (data, ack) => handlePlannerGenerate(data, ack, true));
  socket.on('force_boss', (_data, ack) => handlePlannerBoss(ack));
  socket.on('planner:set_boss_next', (_data, ack) => handlePlannerBoss(ack));
  socket.on('insert_rest', (_data, ack) => handlePlannerRest(ack));
  socket.on('planner:insert_rest', (_data, ack) => handlePlannerRest(ack));

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
const discordGameEngine = {
  getGameState,

  async playerAction(gameId, playerName, action) {
    const current = getCurrentPlayer(gameId);
    if (current && current.toLowerCase() !== playerName.toLowerCase()) {
      return { error: `It's ${current}'s turn, not yours.` };
    }
    const gs = getGameState(gameId);
    clearTimeout(gs.turnTimer);

    const gameConfig = await db.getGame(gameId);
    // ✅ FIX: Serialize narration streaming per game
    const { narration, options, scene, world, isKillshot, mapMoved, llmRunId, blocked } = await withStreamingLock(gameId, () =>
      callGameLLM(gameId, gameConfig, `${playerName}: ${action}`)
    );
    if (!blocked) await advanceTurn(gameId, gameConfig, true);
    const nextPlayer = blocked ? playerName : getVisiblePlayerForOptions(gameId);
    emitDmMessage(gameId, { text: narration, options, auto: false, previousPlayer: playerName, forPlayer: nextPlayer, world, llmRunId });
    io.to(gameId).emit('action_complete', { forPlayer: nextPlayer });
    const playerToken = gs.data.characters[playerName]?.token || null;
    io.to(gameId).emit('player_message', { player: playerName, text: action, token: playerToken });
    maybeGenerateImage(gameId, gameConfig, scene, isKillshot, mapMoved, narration)
      .catch(err => console.error('[scene-gen-after-discord-action]', err.message));
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
      }).catch(err => console.error('[token-gen-char]', err.message));
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
    await ensurePlayablePartyForStart(gameId, gameConfig, gs);
    publishCurrentTurn(gameId, gameConfig, { startTimer: false });
    // ✅ FIX: Serialize narration streaming per game
    const { narration, options, scene, world, llmRunId } = await withStreamingLock(gameId, () =>
      callGameLLM(gameId, gameConfig, prompt || 'Begin the adventure. Set the scene vividly.')
    );
    const firstPlayer = getCurrentPlayer(gameId);
    emitDmMessage(gameId, { text: narration, options, auto: false, forPlayer: firstPlayer, world, llmRunId });
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
      }).catch(err => console.error('[scene-gen]', err.message));
    }
    publishCurrentTurn(gameId, gameConfig);
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

    const response = await llm.completeText({
      task: 'catch-up',
      gameId,
      maxTokens: 600,
      temperature: 0.4,
      system: `Summarize what happened in this RPG session in 400 words or less. Focus on key events, combat outcomes, discoveries, and story developments. Write from a third-person perspective. Be vivid but concise.`,
      prompt: `Summarize what ${playerName} missed:\n\n${transcript}`,
    });

    return { summary: response.text };
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

    const response = await llm.completeText({
      task: 'ooc',
      gameId,
      maxTokens: 256,
      temperature: 0.5,
      system: buildTrimmedPrompt(gameId, gameConfig),
      messages: [...gs.data.chatHistory, { role: 'user', content: oocPrompt }],
    });

    let reply = response.text;
    const reviewResult = await selfAssessAndMaybeLogBug({
      gameId,
      game: gameConfig,
      gs,
      playerName,
      message,
      source: 'discord_ooc_self_assessment',
      reporterUserId: null,
    });
    if (reviewResult.bug?.slug) {
      reply = `${reply}\n\nProgramming review logged for Codex: ${reviewResult.bug.slug}`;
    }

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
${levelGuidance || (direction ? 'Use the level specified in the player direction above.' : 'Start at level 1.')}`;
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
CRITICAL: Read the PLAYER DIRECTION above to determine HOW MANY characters to generate. Then output EXACTLY that many characters using the format below.

For EACH character, output this format ON SEPARATE LINES. Repeat for each character:

---CHARACTER---
NAME: [A fitting fantasy name]
STATS: [Full stat block as a single text block — include level, race, class, HP, ability scores, AC, speed, proficiencies, equipment, spells if any, class features]
COMBAT_JSON: {"level":N,"ac":N,"hp":N,"maxHp":N,"speed":30,"abilities":{"str":N,"dex":N,"con":N,"int":N,"wis":N,"cha":N},"proficiencyBonus":N,"saveProficiencies":["str","con"],"weapons":[{"name":"longsword","attackMod":"str","damage":"1d8","damageType":"slashing","properties":[]}],"spells":[],"spellSlots":{},"spellcastingAbility":null,"features":[]}
PERSONALITY: [2-3 sentences — personality traits, ideals, bonds, flaws]
ACTIONS: [Comma-separated standard actions: e.g., Attack with longsword, Cast Fireball, Dodge, Help ally]
BACKSTORY: [3-4 sentences — origin, motivation, how they joined the party]

IMPORTANT:
- COMBAT_JSON must be a single line of valid JSON with accurate numbers from the STATS block
- Include ALL weapons and spells the character has
- For spellcasters, include spellcastingAbility ("int"/"wis"/"cha"), spellSlots (e.g. {"1":4,"2":3,"3":2}), and spells with damage/healing info
- Each character MUST start with ---CHARACTER--- on its own line
- Each NAME: field MUST be on its own line after ---CHARACTER---

Now generate the characters. Remember: check the PLAYER DIRECTION first to see how many characters to create.`;

    const response = await llm.completeText({
      task: 'party-gen',
      gameId,
      maxTokens: 4000,
      temperature: 0.8,
      system: 'You are a character creation assistant for tabletop RPGs. Generate detailed, playable characters.',
      prompt,
    });

    const text = response.text;

    // Parse the characters
    const charBlocks = text.split('---CHARACTER---').filter(b => b.trim());
    let count = 0;

    for (const block of charBlocks) {
      const nameMatch = block.match(/NAME:\s*(.+)/i);
      const statsMatch = block.match(/STATS:\s*([\s\S]*?)(?=COMBAT_JSON:|PERSONALITY:|$)/i);
      const combatJsonMatch = block.match(/COMBAT_JSON:\s*(\{[\s\S]*?\})\s*(?=PERSONALITY:|$)/i);
      const personalityMatch = block.match(/PERSONALITY:\s*([\s\S]*?)(?=ACTIONS:|$)/i);
      const actionsMatch = block.match(/ACTIONS:\s*([\s\S]*?)(?=BACKSTORY:|$)/i);
      const backstoryMatch = block.match(/BACKSTORY:\s*([\s\S]*?)(?=---CHARACTER---|$)/i);

      if (!nameMatch) continue;

      // Parse COMBAT_JSON if present
      let combatStats = null;
      if (combatJsonMatch) {
        try {
          combatStats = JSON.parse(combatJsonMatch[1].trim());
          combatStats.system = system;
          // Apply defaults for missing fields
          if (!combatStats.conditions) combatStats.conditions = [];
          if (!combatStats.concentrating) combatStats.concentrating = null;
          if (!combatStats.deathSaves) combatStats.deathSaves = { successes: 0, failures: 0 };
          if (!combatStats.inspiration) combatStats.inspiration = false;
          if (!combatStats.resistances) combatStats.resistances = [];
          if (!combatStats.vulnerabilities) combatStats.vulnerabilities = [];
          if (!combatStats.immunities) combatStats.immunities = [];
          if (system === 'dnd5e') combatStats = normalizeDnd5eCombatStats(combatStats);
        } catch (e) {
          console.error(`Failed to parse COMBAT_JSON for ${nameMatch[1].trim()}: ${e.message}`);
        }
      }

      const name = nameMatch[1].trim();
      const charData = {
        statsText: (statsMatch?.[1] || '').trim(),
        personality: (personalityMatch?.[1] || '').trim(),
        standardActions: (actionsMatch?.[1] || '').trim(),
        backstory: (backstoryMatch?.[1] || '').trim(),
        combatStats,
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
      }).catch(err => console.error('[token-gen-char]', err.message));

      count++;
    }

    await db.saveTurnState(gameId, gs.data.currentTurnIndex, gs.data.turnOrder);

    const inputTokens = response.usage?.inputTokens || 0;
    const outputTokens = response.usage?.outputTokens || 0;
    logCost({ gameId, model: response.model, inputTokens, outputTokens,
      cost: response.cost || llmModels.estimateCost(response.model, inputTokens, outputTokens), type: 'party-gen' });

    return { count };
  },
};

discord.setGameEngine(discordGameEngine);

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3020;

async function boot() {
  await db.initDB();
  console.log('DB initialized');
  llmTelemetry.scheduleCleanup();

  // Cost estimate on startup
  const gamesList = await db.listGames();
  const activeGames = gamesList.length;
  console.log('\n══════════════════════════════════════════');
  console.log('  💰 COST ESTIMATE');
  console.log('══════════════════════════════════════════');
  console.log(`  Active games: ${activeGames}`);
  console.log(`  Default narration variants: ${process.env.LLM_NARRATION_VARIANTS || llmModels.DEFAULT_NARRATION_VARIANTS}`);
  console.log(`  Turn timer: ${DEFAULT_TURN_DURATION}s | Idle pause: after 2 auto-turns`);
  console.log(`  Rate limit: ${MAX_CALLS_PER_HOUR} calls/game/hour`);
  console.log('  ─────────────────────────────────────');
  console.log('  Per narration call: tracked in llm_runs with model-specific pricing');
  console.log('  Per image (FLUX):                     ~$0.003');
  console.log('  ─────────────────────────────────────');
  console.log('  Max hourly: depends on experiment mix; monitor /api/costs and /api/admin/llm-summary');
  console.log('  ─────────────────────────────────────');
  console.log('  Safety: no timer without clients, 2-turn idle pause,');
  console.log('  60 calls/hr rate limit, timer killed on disconnect');
  console.log('  Monitor: GET /api/costs for live cost tracking');
  console.log('══════════════════════════════════════════\n');

  await discord.startBot();

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('[SIGTERM] Persisting game state and shutting down...');
    try {
      // Persist all active games to database
      for (const [gameId, gs] of Object.entries(games)) {
        if (gs.chatHistory && gs.chatHistory.length > 0) {
          await db.pool.query(
            'UPDATE game_state SET value = $1 WHERE game_id = $2 AND key = $3',
            [JSON.stringify(gs.chatHistory), gameId, 'chatHistory']
          );
        }
      }
      console.log('[SIGTERM] State persisted. Exiting.');
      process.exit(0);
    } catch (err) {
      console.error('[SIGTERM] Error during shutdown:', err.message);
      process.exit(1);
    }
  });

  server.listen(PORT, () => {
    console.log(`D&D Server running on http://localhost:${PORT}`);
  });
}

boot().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
