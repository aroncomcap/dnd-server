'use strict';

const DEFAULT_NARRATION_VARIANTS = 'openai:gpt-5.4-mini:70,openai:gpt-5.4:30';
const DEFAULT_PROVIDER = process.env.LLM_PROVIDER || 'openai';

// Prices are per 1M tokens. Keep this table local/configurable so new models can
// be trialed without threading provider-specific logic through gameplay code.
const MODEL_PRICES = {
  'openai:gpt-5.5': { input: 5.00, output: 30.00 },
  'openai:gpt-5.4': { input: 2.50, output: 15.00 },
  'openai:gpt-5.4-mini': { input: 0.75, output: 4.50 },
  'openai:gpt-5.4-nano': { input: 0.20, output: 1.25 },
  'gpt-5.5': { input: 5.00, output: 30.00 },
  'gpt-5.4': { input: 2.50, output: 15.00 },
  'gpt-5.4-mini': { input: 0.75, output: 4.50 },
  'gpt-5.4-nano': { input: 0.20, output: 1.25 },
};

const TASK_DEFAULTS = {
  narration: {
    model: process.env.LLM_NARRATION_MODEL || 'openai:gpt-5.4-mini',
    maxTokens: 400,
    temperature: 0.7,
  },
  'options-fallback': {
    model: process.env.LLM_OPTIONS_MODEL || process.env.LLM_STRUCTURED_MODEL || 'openai:gpt-5.4-nano',
    maxTokens: 180,
    temperature: 0.3,
  },
  'world-extraction': {
    model: process.env.LLM_STRUCTURED_MODEL || 'openai:gpt-5.4-nano',
    maxTokens: 700,
    temperature: 0,
  },
  validation: {
    model: process.env.LLM_STRUCTURED_MODEL || 'openai:gpt-5.4-nano',
    maxTokens: 300,
    temperature: 0,
  },
  summary: {
    model: process.env.LLM_SUMMARY_MODEL || 'openai:gpt-5.4-nano',
    maxTokens: 300,
    temperature: 0.2,
  },
  ooc: {
    model: process.env.LLM_OOC_MODEL || 'openai:gpt-5.4-mini',
    maxTokens: 500,
    temperature: 0.6,
  },
  'catch-up': {
    model: process.env.LLM_OOC_MODEL || 'openai:gpt-5.4-mini',
    maxTokens: 500,
    temperature: 0.4,
  },
  'party-gen': {
    model: process.env.LLM_PARTY_MODEL || 'openai:gpt-5.4-mini',
    maxTokens: 1800,
    temperature: 0.8,
  },
  'enemy-tactics': {
    model: process.env.LLM_STRUCTURED_MODEL || 'openai:gpt-5.4-nano',
    maxTokens: 100,
    temperature: 0.2,
  },
  'action-parse': {
    model: process.env.LLM_STRUCTURED_MODEL || 'openai:gpt-5.4-nano',
    maxTokens: 220,
    temperature: 0,
  },
  'stat-parse': {
    model: process.env.LLM_STRUCTURED_MODEL || 'openai:gpt-5.4-nano',
    maxTokens: 900,
    temperature: 0,
  },
  generic: {
    model: process.env.LLM_DEFAULT_MODEL || 'openai:gpt-5.4-mini',
    maxTokens: 600,
    temperature: 0.5,
  },
};

function normalizeModelRef(model) {
  const value = String(model || TASK_DEFAULTS.generic.model).trim();
  if (!value) return TASK_DEFAULTS.generic.model;
  return value.includes(':') ? value : `${DEFAULT_PROVIDER}:${value}`;
}

function unprefixedModel(modelRef) {
  return String(modelRef || '').split(':').pop();
}

function getModelConfig(task = 'generic', overrides = {}) {
  const base = TASK_DEFAULTS[task] || TASK_DEFAULTS.generic;
  const model = normalizeModelRef(overrides.model || base.model);
  return {
    task,
    model,
    maxTokens: overrides.maxTokens || overrides.max_tokens || base.maxTokens,
    temperature: overrides.temperature ?? base.temperature,
  };
}

function estimateCost(modelRef, inputTokens = 0, outputTokens = 0) {
  const normalized = normalizeModelRef(modelRef);
  const prices = MODEL_PRICES[normalized] || MODEL_PRICES[unprefixedModel(normalized)] || MODEL_PRICES['openai:gpt-5.4-mini'];
  return (Number(inputTokens || 0) / 1_000_000 * prices.input)
    + (Number(outputTokens || 0) / 1_000_000 * prices.output);
}

function parseWeightedVariants(value = process.env.LLM_NARRATION_VARIANTS || DEFAULT_NARRATION_VARIANTS) {
  const parts = String(value || DEFAULT_NARRATION_VARIANTS)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const variants = parts.map((part, index) => {
    const segments = part.split(':');
    const maybeWeight = Number(segments[segments.length - 1]);
    const hasWeight = Number.isFinite(maybeWeight) && maybeWeight > 0;
    const model = hasWeight ? segments.slice(0, -1).join(':') : part;
    const normalized = normalizeModelRef(model);
    return {
      id: `v${index + 1}-${normalized.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      model: normalized,
      weight: hasWeight ? maybeWeight : 1,
    };
  });

  return variants.length ? variants : parseWeightedVariants(DEFAULT_NARRATION_VARIANTS);
}

function getRetentionDays() {
  const days = parseInt(process.env.LLM_TEXT_RETENTION_DAYS || '30', 10);
  return Number.isFinite(days) && days > 0 ? days : 30;
}

module.exports = {
  DEFAULT_NARRATION_VARIANTS,
  MODEL_PRICES,
  TASK_DEFAULTS,
  normalizeModelRef,
  unprefixedModel,
  getModelConfig,
  estimateCost,
  parseWeightedVariants,
  getRetentionDays,
};
