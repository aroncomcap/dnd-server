// ── Image Generation Engine (Together AI / FLUX) ────────────────────────────────

const db = require('./db');

let together; // Initialized by module caller
let io; // Initialized by module caller
let logCost; // Initialized by module caller
let getGameState; // Initialized by module caller
let ART_STYLES; // Initialized by module caller

function init(togetherInstance, ioInstance, logCostFn, getGameStateFn, artStyles) {
  together = togetherInstance;
  io = ioInstance;
  logCost = logCostFn;
  getGameState = getGameStateFn;
  ART_STYLES = artStyles;
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
  const styleDef = ART_STYLES[gs.imageStyle] || ART_STYLES['oil-painting'];
  const stylePrefix = styleDef.prefix;

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
  // Generate every 20th turn as a baseline (reduce frequency to lower costs)
  const gs = getGameState(gameId);
  if (gs.turnCount > 0 && gs.turnCount % 20 === 0) return true;
  return false;
}

// ── World Art Generation (Together AI / FLUX) ─────────────────────────────────
async function generateWorldArt(gameId, item) {
  if (!process.env.TOGETHER_API_KEY) return;
  const gs = getGameState(gameId);

  const styleDef = ART_STYLES[gs.imageStyle] || ART_STYLES['oil-painting'];
  const style = item.type === 'npc' ? styleDef.portraitPrefix : styleDef.prefix;

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

module.exports = {
  init,
  generateCharacterToken,
  generateCompositeScene,
  shouldGenerateImage,
  generateWorldArt,
};
