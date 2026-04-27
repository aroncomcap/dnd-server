#!/usr/bin/env node
// ────────────────────────────────────────────────────────────────────────────────
// Opus Review Script — Automated Prompt Analysis
//
// Analyzes prompt-builder.js for bloat, drift, and maintenance issues.
// - Called by post-commit hook (on-edit)
// - Can be run manually: node scripts/opus-review.js
// - Reports saved to logs/opus-review-YYYY-MM-DD.txt
//
// Non-blocking: Always exits 0 (reports are informational)
// ────────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const LOGS_DIR = path.join(__dirname, '../logs');
const PROMPT_BUILDER_PATH = path.join(__dirname, '../prompt-builder.js');
const GAME_ENGINE_PATH = path.join(__dirname, '../game-engine.js');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

async function runOpusReview() {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn('⚠️  ANTHROPIC_API_KEY not set. Skipping Opus review.');
      process.exit(0);
    }

    const client = new Anthropic({ apiKey });

    // Read both files
    const promptBuilder = fs.readFileSync(PROMPT_BUILDER_PATH, 'utf8');
    const gameEngine = fs.readFileSync(GAME_ENGINE_PATH, 'utf8');

    // Count approximate line counts for major sections
    const minimalMatch = promptBuilder.match(
      /function buildMinimalPrompt_DnD\([\s\S]*?\n\}/
    );
    const fullMatch = promptBuilder.match(
      /function buildFullPrompt_DnD\([\s\S]*?\n}/
    );

    const minimalLines = minimalMatch ? minimalMatch[0].split('\n').length : 0;
    const fullLines = fullMatch ? fullMatch[0].split('\n').length : 0;

    // Prepare analysis prompt
    const analysisPrompt = `You are a prompt engineer reviewing a D&D narration system for bloat and drift.

TASK: Analyze the attached prompt-builder.js and game-engine.js for:
1. BLOAT in buildMinimalPrompt_DnD() and buildFullPrompt_DnD()
2. DRIFT between prompts and actual game-engine.js
3. REDUNDANCY and outdated sections

MINIMAL PROMPT REVIEW (buildMinimalPrompt_DnD ~${minimalLines} lines):
- Are all lines necessary for basic gameplay?
- Any duplicate rules or redundant sections?
- Is the word limit rule clear and enforced?
- Are character stats and location always up-to-date?
- Is the output format (---OPTIONS---, ---SCENE---, ---WORLD---) necessary?

FULL PROMPT REVIEW (buildFullPrompt_DnD ~${fullLines} lines):
- World context: Still relevant? Outdated?
- NPC memory section: Are NPCs from old encounters still needed?
- Encounter plans: Do they match game-engine.js code?
- Story summary: Is it consistent with game state?
- Are ferocity, pillars, and pacing instructions clear?
- SPELLS/POWERS/RESOURCES: Is this section needed given game-engine.js tracking?

DRIFT DETECTION:
- Features in game-engine.js NOT mentioned in prompts (ferocity, pillars, etc.)?
- Features described in prompts but removed from game-engine.js?
- New handlers/functions in game-engine.js not reflected in prompts?
- Output format (---ENEMIES---, KILLSHOT, etc.) matching game-engine.js?

REPORT FORMAT:
Return exactly:

🔴 BLOAT CANDIDATES:
- [section name] | [reason] | [line approx]
- ...

🟡 DRIFT ISSUES:
- [feature name] | [status] | [recommended action]
- ...

💚 WORKING WELL:
- [aspect] | [why it works]

📋 RECOMMENDATIONS (prioritized):
1. [Most impactful change]
2. [Next highest impact]
3. [Nice-to-have]

Keep report concise (under 500 words).`;

    // Call Opus API
    console.log('⏳ Calling Opus for prompt analysis...');
    const response = await client.messages.create({
      model: 'claude-opus-4-6-20250514',
      max_tokens: 2000,
      system:
        'You are a prompt engineering expert. Analyze code for unnecessary bloat, drift from implementation, and improvement opportunities. Be direct and actionable.',
      messages: [
        {
          role: 'user',
          content: `${analysisPrompt}\n\n--- PROMPT BUILDER (${promptBuilder.length} chars) ---\n${promptBuilder}\n\n--- GAME ENGINE (excerpt, ${gameEngine.length} chars) ---\n${gameEngine}`,
        },
      ],
    });

    const report = response.content[0].text;

    // Save report with timestamp
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const timeStr = now.toTimeString().split(' ')[0]; // HH:MM:SS
    const reportPath = path.join(LOGS_DIR, `opus-review-${dateStr}.txt`);

    const reportContent = `Opus Prompt Review Report
Generated: ${dateStr} ${timeStr}

API Model: claude-opus-4-6-20250514
Input Files: prompt-builder.js (${promptBuilder.length} chars), game-engine.js (${gameEngine.length} chars)

────────────────────────────────────────────────────────────────────────────────

${report}

────────────────────────────────────────────────────────────────────────────────
End of Report`;

    fs.writeFileSync(reportPath, reportContent);

    // Log usage stats
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    const totalTokens = inputTokens + outputTokens;

    console.log('✅ Opus review complete');
    console.log(`   Report: ${reportPath}`);
    console.log(`   Tokens: ${inputTokens} input + ${outputTokens} output = ${totalTokens} total`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Opus review error:', error.message);
    // Non-blocking: always exit 0
    process.exit(0);
  }
}

runOpusReview();
