'use strict';

const crypto = require('crypto');
const db = require('../db');
const { parseWeightedVariants } = require('./model-registry');

function experimentsEnabled() {
  return process.env.LLM_EXPERIMENTS_ENABLED !== 'false';
}

function getNarrationExperimentId() {
  return process.env.LLM_NARRATION_EXPERIMENT || '2026-q2-openai-narration';
}

function weightedChoice(key, variants) {
  const total = variants.reduce((sum, variant) => sum + variant.weight, 0);
  const hash = crypto.createHash('sha256').update(String(key)).digest();
  const value = hash.readUInt32BE(0) / 0xffffffff;
  let cursor = value * total;
  for (const variant of variants) {
    cursor -= variant.weight;
    if (cursor <= 0) return variant;
  }
  return variants[variants.length - 1];
}

async function getNarrationAssignment(gameId) {
  const variants = parseWeightedVariants();
  const experimentId = getNarrationExperimentId();
  const fallback = weightedChoice(`${experimentId}:${gameId || 'anonymous'}`, variants);

  if (!experimentsEnabled() || !gameId || !process.env.DATABASE_URL) {
    return { experimentId, variantId: fallback.id, model: fallback.model, variants };
  }

  try {
    await db.upsertLlmExperiment({
      id: experimentId,
      task: 'narration',
      variants,
      status: 'active',
    });

    const existing = await db.getLlmExperimentAssignment(experimentId, gameId);
    if (existing) {
      const variant = variants.find(v => v.id === existing.variant_id) || fallback;
      return { experimentId, variantId: variant.id, model: variant.model, variants };
    }

    await db.saveLlmExperimentAssignment(experimentId, gameId, fallback.id);
    return { experimentId, variantId: fallback.id, model: fallback.model, variants };
  } catch (err) {
    console.warn(`[llm] Experiment assignment fallback for game ${gameId}: ${err.message}`);
    return { experimentId, variantId: fallback.id, model: fallback.model, variants };
  }
}

module.exports = {
  experimentsEnabled,
  getNarrationExperimentId,
  getNarrationAssignment,
  weightedChoice,
};
