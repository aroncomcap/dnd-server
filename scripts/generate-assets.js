#!/usr/bin/env node

/**
 * Tavern Table Asset Generator
 * Generates all "They Still Sing" visual assets using Together AI FLUX.1-schnell
 * Usage: node scripts/generate-assets.js [--set icons,flames,...]
 */

const fs = require('fs');
const path = require('path');
const Together = require('together-ai');

const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;
if (!TOGETHER_API_KEY) {
  console.error('❌ TOGETHER_API_KEY not set');
  process.exit(1);
}

const together = new Together({ apiKey: TOGETHER_API_KEY });

// Asset output directory
const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'tavern-table-assets');
const MANIFEST_FILE = path.join(ASSETS_DIR, 'manifest.json');

// Ensure directories exist
[
  ASSETS_DIR,
  path.join(ASSETS_DIR, 'icons'),
  path.join(ASSETS_DIR, 'flames'),
  path.join(ASSETS_DIR, 'tokens'),
  path.join(ASSETS_DIR, 'parchment'),
  path.join(ASSETS_DIR, 'borders'),
  path.join(ASSETS_DIR, 'banners'),
  path.join(ASSETS_DIR, 'frames'),
  path.join(ASSETS_DIR, 'backgrounds'),
  path.join(ASSETS_DIR, 'icons-misc'),
  path.join(ASSETS_DIR, 'animations'),
].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// ASSET DEFINITIONS
// ────────────────────────────────────────────────────────────────────────────

const ASSET_SETS = {
  icons: {
    dir: 'icons',
    description: 'Bardic Ledger deed type icons',
    images: [
      {
        name: 'deed-swords.png',
        prompt: 'Medieval fantasy icon: crossed swords in gold (#D4AF37), clean vector art, medieval manuscript illumination style, 64x64px design, transparent background. Single clear icon of two crossed swords ready for battle, no background, elegant and simple.',
      },
      {
        name: 'deed-shield.png',
        prompt: 'Medieval fantasy icon: raised shield in gold (#D4AF37), clean vector art, medieval manuscript illumination style, 64x64px design, transparent background. Single clear icon of an upright shield with emblem, no background, elegant and simple.',
      },
      {
        name: 'deed-heart.png',
        prompt: 'Medieval fantasy icon: glowing heart in gold (#D4AF37), clean vector art, medieval manuscript illumination style, 64x64px design, transparent background. Single clear icon of a bright glowing heart with soft radiance, no background, elegant and simple.',
      },
      {
        name: 'deed-star.png',
        prompt: 'Medieval fantasy icon: star burst in gold (#D4AF37), clean vector art, medieval manuscript illumination style, 64x64px design, transparent background. Single clear icon of a dramatic multi-pointed star with radiating rays, no background, elegant and simple.',
      },
    ],
  },

  flames: {
    dir: 'flames',
    description: 'Renown tier progression flame icons',
    images: [
      {
        name: 'renown-1-candle.png',
        prompt: 'Medieval fantasy icon: single lit candle flame in gold (#D4AF37) and orange (#E67E22). Pixel art or watercolor style. 64x64px design, transparent background. Warm glow effect. Simple single candle with flame rising from top.',
      },
      {
        name: 'renown-2-torch.png',
        prompt: 'Medieval fantasy icon: candle and torch side by side, gold (#D4AF37) and orange (#E67E22) with warm glow. Pixel art or watercolor style, 64x64px, transparent background. Two flames, one smaller candle, one larger torch.',
      },
      {
        name: 'renown-3-campfire.png',
        prompt: 'Medieval fantasy icon: campfire with logs burning, gold (#D4AF37) and orange (#E67E22) flames. Pixel art or watercolor style, 64x64px, transparent background. Warm glowing campfire viewed from above, logs forming base.',
      },
      {
        name: 'renown-4-brazier.png',
        prompt: 'Medieval fantasy icon: ornate brazier with rising flames, gold (#D4AF37) and orange (#E67E22) fire. Pixel art or watercolor style, 64x64px, transparent background. Metal brazier bowl with bright flames rising upward.',
      },
      {
        name: 'renown-5-bonfire.png',
        prompt: 'Medieval fantasy icon: roaring bonfire, gold (#D4AF37) and orange (#E67E22) flames rising high. Pixel art or watercolor style, 64x64px, transparent background. Large dramatic bonfire with intense flames, warm glow spreading outward.',
      },
    ],
  },

  tokens: {
    dir: 'tokens',
    description: 'Lyre token (Bardic Inspiration currency)',
    images: [
      {
        name: 'lyre-token.png',
        prompt: 'Medieval fantasy coin token: ornate golden lyre taking up most of the coin face. Embossed coin style with depth, relief shadow, and soft golden glow (#D4AF37). Decorative filigree border around rim. 64x64px design, transparent background. Fantasy RPG currency, elegant and detailed.',
      },
    ],
  },

  parchment: {
    dir: 'parchment',
    description: 'Parchment card backgrounds (3 variants)',
    images: [
      {
        name: 'parchment-scroll.png',
        prompt: 'Aged parchment scroll background, 4:3 aspect ratio (400x300px). Rolled edges at top and bottom with curl effect. Slight tear and age marks. Warm candlelight glow from corner (#D4AF37 at 40% opacity). Colors #F5E6D3 to #E8D4A0. Transparent background. Medieval manuscript aesthetic.',
      },
      {
        name: 'parchment-deed-card.png',
        prompt: 'Aged parchment deed card, portrait orientation (300x400px). Space for deed icon (top-left area). Wax seal in bottom-right corner (red/gold wax blob with imprint). Quill pen decoration in top-left. Aged paper texture with creases. Colors #F5E6D3 to #E8D4A0 with candlelight glow. Transparent background.',
      },
      {
        name: 'parchment-legend-card.png',
        prompt: 'Aged parchment legend card, landscape orientation (400x300px). Left side has circular frame space (128x128px for character portrait). Right side text area. Small tankard icon (bottom-right). Gold accent border on left edge (#D4AF37). Aged paper texture. Colors #F5E6D3 to #E8D4A0. Transparent background. Medieval manuscript style.',
      },
    ],
  },

  borders: {
    dir: 'borders',
    description: 'Ornate borders and flourishes',
    images: [
      {
        name: 'border-top-flourish.png',
        prompt: 'Medieval manuscript decorative top border flourish, ~400px wide × 60px tall. Ornate corner spirals with leaves and vines. Gold (#D4AF37) with cream (#F5E6D3) highlights and brown (#2A2520) shadows. Clean vector or hand-drawn style. Transparent background. Fantasy tavern aesthetic.',
      },
      {
        name: 'border-bottom-flourish.png',
        prompt: 'Medieval manuscript decorative bottom border flourish, ~400px wide × 60px tall. Matching style to top border, complementary design with leaves and vines. Gold (#D4AF37) with cream (#F5E6D3) highlights and brown (#2A2520) shadows. Clean vector or hand-drawn style. Transparent background.',
      },
      {
        name: 'border-horizontal-band.png',
        prompt: 'Medieval manuscript decorative horizontal band for section dividers, ~400px wide × 60px tall. Ornate filigree pattern. Gold (#D4AF37) with cream and brown accents. Clean vector line art style. Transparent background. Suitable for separating content sections.',
      },
      {
        name: 'initial-D.png',
        prompt: 'Ornate medieval initial letter "D" in fantasy blackletter style, 64x64px design, gold (#D4AF37) with cream (#F5E6D3) highlights. Illuminated manuscript style with decorative flourishes around the letter. Clean vector art. Transparent background.',
      },
      {
        name: 'initial-S.png',
        prompt: 'Ornate medieval initial letter "S" in fantasy blackletter style, 64x64px design, gold (#D4AF37) with cream (#F5E6D3) highlights. Illuminated manuscript style with decorative flourishes around the letter. Clean vector art. Transparent background.',
      },
      {
        name: 'initial-K.png',
        prompt: 'Ornate medieval initial letter "K" in fantasy blackletter style, 64x64px design, gold (#D4AF37) with cream (#F5E6D3) highlights. Illuminated manuscript style with decorative flourishes around the letter. Clean vector art. Transparent background.',
      },
      {
        name: 'initial-T.png',
        prompt: 'Ornate medieval initial letter "T" in fantasy blackletter style, 64x64px design, gold (#D4AF37) with cream (#F5E6D3) highlights. Illuminated manuscript style with decorative flourishes around the letter. Clean vector art. Transparent background.',
      },
      {
        name: 'gold-leaf-sprigs.png',
        prompt: 'Medieval gold leaf flourish cluster, ~60x60px design. Decorative sprigs with leaves and tendrils in gold (#D4AF37) with cream highlights. Corner accent element for manuscripts. 4-6 small sprigs arranged in a cluster. Clean vector or hand-drawn. Transparent background.',
      },
    ],
  },

  banners: {
    dir: 'banners',
    description: 'Achievement banners',
    images: [
      {
        name: 'chorus-banner.png',
        prompt: 'Fantasy RPG achievement banner with "CHORUS" text. Landscape orientation, ~400px wide × 180px tall. Gold (#D4AF37) text in medieval blackletter font, center-aligned, with shadow depth. Ornate gold filigree borders at top and bottom (~40px each). Curved/arched top edge. 4-6 sparkle and star effects around text. Crimson accents (#C0392B). Subtle fabric texture. Transparent background. Dramatic and celebratory fantasy style.',
      },
    ],
  },

  frames: {
    dir: 'frames',
    description: 'Killshot frame and couplet banner',
    images: [
      {
        name: 'killshot-frame.png',
        prompt: 'Ornate square frame border (1:1 aspect, ~256x256px) for killshot images. Gold (#D4AF37) and crimson (#C0392B) ornate border, 2-3px thick. Crossed swords ornament at top center. Crowned skull or laurel wreath at bottom center. Decorative corner flourishes in gold. Medieval fantasy aesthetic. Transparent background.',
      },
      {
        name: 'couplet-banner.png',
        prompt: 'Semi-transparent dark overlay band for bottom ~25% of image (~400px wide × 100px tall). Gold ornate border along top edge. Interior space for 2 lines of gold italic serif text. Subtle linen/fabric texture in dark band (#1A1410). Fades to transparency at bottom. Medieval fantasy style. Suitable for image overlay.',
      },
    ],
  },

  backgrounds: {
    dir: 'backgrounds',
    description: 'Tavern bulletin board background',
    images: [
      {
        name: 'tavern-notice-board.png',
        prompt: 'Atmospheric medieval tavern notice board scene, ~1600x1000px or suitable for full webpage background (16:9 aspect). Dark wooden plank texture (vertical boards, grain, knots, age marks). 6-8 worn brass push pins scattered across board. 3-4 pinned parchment scrolls with torn edges, wax seals, quill markings. Candlelight ambient glow from bottom-left corner (warm yellow/gold #D4AF37 at 40% opacity). Shadows and depth for worn, aged tavern setting. Subtle atmospheric haze/dust particles in light. Colors: dark browns (#2A2520, #1A1410), gold candlelight, cream parchment (#F5E6D3). Cinematic fantasy atmosphere, inviting and lived-in.',
      },
    ],
  },

  'icons-misc': {
    dir: 'icons-misc',
    description: 'Miscellaneous icons',
    images: [
      {
        name: 'bard-silhouette.png',
        prompt: 'Simple elegant line art bard/minstrel icon for fantasy RPG UI. Figure sitting or standing with lute/lyre in hand. Flowing robes and feathered hat. Minimal detail, clean lines, elegant simplicity. Gold (#D4AF37) on transparent background. 64x64px design. Suitable for small UI badges and decorative elements. Should convey "storyteller/bard" immediately.',
      },
      {
        name: 'tankard-icon.png',
        prompt: 'Fantasy RPG icon: foaming ale tankard raised in toast, gold (#D4AF37) with warm tones. Simple, iconic style, 48x48px design. Transparent background. Suitable for upvote/like button ("Raise a Tankard"). Clean vector art, medieval tavern aesthetic.',
      },
    ],
  },

  animations: {
    dir: 'animations',
    description: 'Animation assets',
    images: [
      {
        name: 'ripple-burst.png',
        prompt: 'Radial burst or ripple effect asset for fantasy RPG UI animation. Concentric circular ripples or radial light rays emanating from center point. Soft glow, warm golden tones. Gold (#D4AF37) primary, orange (#E67E22) secondary, fading to complete transparency at outer edges. 400x400px design. Transparent background. Magical fantasy glow effect, suitable for celebration/achievement moments. Will be used with CSS keyframe animation.',
      },
    ],
  },
};

// ────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ────────────────────────────────────────────────────────────────────────────

async function generateImage(prompt) {
  try {
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
    return Buffer.from(b64, 'base64');
  } catch (err) {
    console.error(`  ❌ Generation failed: ${err.message}`);
    return null;
  }
}

async function saveImage(buffer, filepath) {
  fs.writeFileSync(filepath, buffer);
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN GENERATION LOOP
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  const manifest = {
    generatedAt: new Date().toISOString(),
    sets: {},
    stats: {
      totalImages: 0,
      successCount: 0,
      failureCount: 0,
      totalCost: 0,
      estimatedTokens: 0,
    },
  };

  const selectedSets = process.argv[3] ? process.argv[3].split(',').map(s => s.trim()) : Object.keys(ASSET_SETS);

  console.log('🎨 Tavern Table Asset Generator');
  console.log(`📦 Generating ${selectedSets.length} asset sets (FLUX.1-schnell)`);
  console.log('');

  let imageCount = 0;
  for (const setName of selectedSets) {
    if (!ASSET_SETS[setName]) {
      console.log(`⚠️  Unknown set: ${setName}`);
      continue;
    }

    const assetSet = ASSET_SETS[setName];
    console.log(`📂 ${setName.toUpperCase()}: ${assetSet.description}`);

    manifest.sets[setName] = {
      description: assetSet.description,
      images: [],
    };

    for (const img of assetSet.images) {
      imageCount++;
      process.stdout.write(`  [${imageCount}/${Object.values(ASSET_SETS).reduce((sum, s) => sum + s.images.length, 0)}] Generating ${img.name}... `);

      const buffer = await generateImage(img.prompt);
      if (buffer) {
        const filepath = path.join(ASSETS_DIR, assetSet.dir, img.name);
        saveImage(buffer, filepath);
        console.log(`✅`);
        manifest.sets[setName].images.push({
          filename: img.name,
          prompt: img.prompt.slice(0, 100) + '...',
          path: path.relative(ASSETS_DIR, filepath),
        });
        manifest.stats.successCount++;
        manifest.stats.totalCost += 0.003; // FLUX.1-schnell costs $0.003/image
      } else {
        console.log(`❌`);
        manifest.stats.failureCount++;
      }

      manifest.stats.totalImages++;

      // Rate limiting: 1 req/sec to stay under limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.log('');
  }

  // Save manifest
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));

  const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
  const elapsedMinutes = Math.round(elapsedSeconds / 60);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✨ Generation Complete`);
  console.log(`📂 Output directory: ${ASSETS_DIR}`);
  console.log(`📊 Generated: ${manifest.stats.successCount}/${manifest.stats.totalImages} images`);
  console.log(`💰 Estimated cost: $${manifest.stats.totalCost.toFixed(2)}`);
  console.log(`⏱️  Elapsed time: ${elapsedMinutes}m ${elapsedSeconds % 60}s`);
  console.log(`📋 Manifest: ${MANIFEST_FILE}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
