'use strict';

const crypto = require('crypto');
const db = require('../db');
const { estimateCost, getRetentionDays } = require('./model-registry');

function sha256(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function shouldStoreText() {
  return process.env.LLM_STORE_TEXT !== 'false';
}

function serializePrompt({ system, messages, prompt }) {
  if (prompt) return String(prompt);
  const parts = [];
  if (system) parts.push(`SYSTEM:\n${system}`);
  for (const message of messages || []) {
    parts.push(`${String(message.role || 'user').toUpperCase()}:\n${message.content || ''}`);
  }
  return parts.join('\n\n');
}

async function recordRun(entry) {
  const inputTokens = entry.usage?.inputTokens || entry.inputTokens || 0;
  const outputTokens = entry.usage?.outputTokens || entry.outputTokens || 0;
  const promptText = serializePrompt(entry);
  const outputText = entry.outputText ?? entry.text ?? '';
  const cost = estimateCost(entry.model, inputTokens, outputTokens);

  const row = {
    id: entry.id || crypto.randomUUID(),
    experimentId: entry.experimentId || null,
    variantId: entry.variantId || null,
    gameId: entry.gameId || null,
    turnId: entry.turnId || null,
    task: entry.task || 'generic',
    provider: String(entry.model || '').split(':')[0] || 'unknown',
    model: entry.model || 'unknown',
    status: entry.status || 'success',
    latencyMs: entry.latencyMs || null,
    inputTokens,
    outputTokens,
    estimatedCostUsd: cost,
    promptHash: sha256(promptText),
    outputHash: sha256(outputText),
    promptText: shouldStoreText() ? promptText : null,
    outputText: shouldStoreText() ? outputText : null,
    errorCode: entry.errorCode || null,
    errorMessage: entry.errorMessage || null,
  };

  if (process.env.DATABASE_URL) {
    try {
      await db.saveLlmRun(row);
    } catch (err) {
      console.warn(`[llm] Failed to record run ${row.id}: ${err.message}`);
    }
  }

  return { ...row, cost };
}

async function cleanupOldText() {
  try {
    return await db.cleanupOldLlmRunText(getRetentionDays());
  } catch (err) {
    console.warn(`[llm] Failed to cleanup old run text: ${err.message}`);
    return 0;
  }
}

function scheduleCleanup() {
  if (process.env.TEST_MODE === 'true' || process.env.LLM_TEXT_CLEANUP_DISABLED === 'true') return null;
  const run = () => cleanupOldText().catch(() => {});
  const interval = setInterval(run, 24 * 60 * 60 * 1000);
  interval.unref();
  setTimeout(run, 30_000).unref();
  return interval;
}

module.exports = {
  sha256,
  serializePrompt,
  recordRun,
  cleanupOldText,
  scheduleCleanup,
};
