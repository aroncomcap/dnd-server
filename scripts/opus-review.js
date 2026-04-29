#!/usr/bin/env node

/**
 * Opus Review: Analyzes prompt-builder.js for bloat and drift
 * Triggers: On-edit via git hook, or weekly via cron
 */

const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const client = new Anthropic();

async function reviewPrompt(filePath, briefMode = false) {
  console.log(`🔍 Reviewing ${path.basename(filePath)}...`);

  const content = fs.readFileSync(filePath, "utf-8");
  const lineCount = content.split("\n").length;

  const reviewPrompt = `Review this D&D game narration system prompt builder for bloat and drift.

FILE: ${path.basename(filePath)}
LINES: ${lineCount}

CODE:
\`\`\`javascript
${content}
\`\`\`

MINIMAL PROMPT REVIEW (buildMinimalPrompt_DnD):
- Are all ~80 lines necessary for basic gameplay?
- Any duplicate rules or redundant sections?
- Is the word limit rule clear?

FULL PROMPT REVIEW (buildFullPrompt_DnD):
- World context: Still relevant?
- NPC memory section: Are old NPCs still listed?
- Encounter plans: Do they match game-engine.js?

DRIFT DETECTION:
- New handlers in game-engine.js not mentioned in prompt?
- New game features documented?
- Old features still described but removed?

${briefMode ? 'BRIEF REPORT: Only list issues if any found.' : 'FULL REPORT: Bloat candidates, drift issues, recommendations (prioritized).'}`;

  const message = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: reviewPrompt,
      },
    ],
  });

  const report = message.content[0].text;
  const timestamp = new Date().toISOString();

  console.log(`\n📊 Opus Review Report (${timestamp})`);
  console.log("=".repeat(60));
  console.log(report);
  console.log("=".repeat(60));

  // Log to file
  const logDir = path.join(path.dirname(filePath), "..", "logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  const logFile = path.join(logDir, `opus-review-${Date.now()}.log`);
  fs.writeFileSync(
    logFile,
    `Opus Review Report
Timestamp: ${timestamp}
File: ${filePath}
Lines: ${lineCount}

${report}`
  );

  console.log(`📁 Report saved to: ${logFile}`);
}

const args = process.argv.slice(2);
const targetFile = args.includes("--target")
  ? args[args.indexOf("--target") + 1]
  : "prompt-builder.js";
const briefMode = args.includes("--mode") && args[args.indexOf("--mode") + 1] === "brief";

const filePath = path.join(__dirname, "..", targetFile);

if (!fs.existsSync(filePath)) {
  console.error(`❌ File not found: ${filePath}`);
  process.exit(1);
}

reviewPrompt(filePath, briefMode).catch((err) => {
  console.error("❌ Review failed:", err.message);
  process.exit(1);
});
