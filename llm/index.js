'use strict';

const provider = require('./providers/ai-sdk');
const { getModelConfig } = require('./model-registry');
const { getNarrationAssignment } = require('./experiments');
const telemetry = require('./telemetry');

let providerOverride = null;

function activeProvider() {
  return providerOverride || provider;
}

function normalizeMessages({ messages, prompt }) {
  if (messages && messages.length) return messages;
  return [{ role: 'user', content: prompt || '' }];
}

function getUsage(result) {
  return {
    inputTokens: result?.usage?.inputTokens || 0,
    outputTokens: result?.usage?.outputTokens || 0,
  };
}

async function resolveConfig(task, options) {
  if (task === 'narration' && !options.model) {
    const assignment = await getNarrationAssignment(options.gameId);
    const config = getModelConfig(task, { ...options, model: assignment.model });
    return { ...config, experimentId: assignment.experimentId, variantId: assignment.variantId };
  }
  return getModelConfig(task, options);
}

async function streamText(options = {}) {
  const task = options.task || 'generic';
  const config = await resolveConfig(task, options);
  const messages = normalizeMessages(options);
  const start = Date.now();

  try {
    const result = await activeProvider().streamText({
      model: config.model,
      system: options.system || '',
      messages,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      onToken: options.onToken,
    });

    const latencyMs = Date.now() - start;
    const run = await telemetry.recordRun({
      ...options.metadata,
      task,
      model: config.model,
      gameId: options.gameId || options.metadata?.gameId,
      turnId: options.turnId || options.metadata?.turnId,
      experimentId: config.experimentId || options.experimentId,
      variantId: config.variantId || options.variantId,
      system: options.system,
      messages,
      outputText: result.text,
      usage: getUsage(result),
      latencyMs,
      status: 'success',
    });

    return {
      ...result,
      llmRunId: run.id,
      model: config.model,
      experimentId: config.experimentId || null,
      variantId: config.variantId || null,
      latencyMs,
      cost: run.cost,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const run = await telemetry.recordRun({
      ...options.metadata,
      task,
      model: config.model,
      gameId: options.gameId || options.metadata?.gameId,
      turnId: options.turnId || options.metadata?.turnId,
      experimentId: config.experimentId || options.experimentId,
      variantId: config.variantId || options.variantId,
      system: options.system,
      messages,
      outputText: '',
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs,
      status: 'error',
      errorCode: err.code || err.name || 'LLM_ERROR',
      errorMessage: err.message,
    });
    err.llmRunId = run.id;
    throw err;
  }
}

async function completeText(options = {}) {
  const task = options.task || 'generic';
  const config = await resolveConfig(task, options);
  const messages = normalizeMessages(options);
  const start = Date.now();

  try {
    const result = await activeProvider().completeText({
      model: config.model,
      system: options.system || '',
      messages,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    });
    const latencyMs = Date.now() - start;
    const run = await telemetry.recordRun({
      ...options.metadata,
      task,
      model: config.model,
      gameId: options.gameId || options.metadata?.gameId,
      turnId: options.turnId || options.metadata?.turnId,
      system: options.system,
      messages,
      outputText: result.text,
      usage: getUsage(result),
      latencyMs,
      status: 'success',
    });
    return { ...result, llmRunId: run.id, model: config.model, latencyMs, cost: run.cost };
  } catch (err) {
    const latencyMs = Date.now() - start;
    await telemetry.recordRun({
      ...options.metadata,
      task,
      model: config.model,
      gameId: options.gameId || options.metadata?.gameId,
      turnId: options.turnId || options.metadata?.turnId,
      system: options.system,
      messages,
      outputText: '',
      latencyMs,
      status: 'error',
      errorCode: err.code || err.name || 'LLM_ERROR',
      errorMessage: err.message,
    });
    throw err;
  }
}

async function completeJson(options = {}) {
  const task = options.task || 'generic';
  const config = await resolveConfig(task, options);
  const messages = normalizeMessages(options);
  const start = Date.now();

  try {
    const result = await activeProvider().completeJson({
      model: config.model,
      system: options.system || '',
      messages,
      schema: options.schema,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    });
    const latencyMs = Date.now() - start;
    const run = await telemetry.recordRun({
      ...options.metadata,
      task,
      model: config.model,
      gameId: options.gameId || options.metadata?.gameId,
      turnId: options.turnId || options.metadata?.turnId,
      system: options.system,
      messages,
      outputText: result.text,
      usage: getUsage(result),
      latencyMs,
      status: 'success',
    });
    return { ...result, llmRunId: run.id, model: config.model, latencyMs, cost: run.cost };
  } catch (err) {
    const latencyMs = Date.now() - start;
    await telemetry.recordRun({
      ...options.metadata,
      task,
      model: config.model,
      gameId: options.gameId || options.metadata?.gameId,
      turnId: options.turnId || options.metadata?.turnId,
      system: options.system,
      messages,
      outputText: '',
      latencyMs,
      status: 'error',
      errorCode: err.code || err.name || 'LLM_ERROR',
      errorMessage: err.message,
    });
    throw err;
  }
}

function setProviderForTesting(mockProvider) {
  providerOverride = mockProvider;
}

function resetProviderForTesting() {
  providerOverride = null;
  provider.resetForTesting?.();
}

module.exports = {
  streamText,
  completeText,
  completeJson,
  setProviderForTesting,
  resetProviderForTesting,
};
