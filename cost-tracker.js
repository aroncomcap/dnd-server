// ── Cost Tracking & Rate Limiting ─────────────────────────────────────────────

const { MODEL_PRICES, estimateCost } = require('./llm/model-registry');

const MODEL_COSTS = MODEL_PRICES; // per 1M tokens (input/output)
const IMAGE_COST = 0.003; // per Together AI FLUX image
const costLog = []; // { timestamp, gameId, model, inputTokens, outputTokens, cost, type }

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
  // Test games get higher limit
  const limit = gameId.startsWith('test-') ? 300 : MAX_CALLS_PER_HOUR;
  const now = Date.now();
  if (!apiCallLog[gameId]) apiCallLog[gameId] = [];
  // Prune old entries
  apiCallLog[gameId] = apiCallLog[gameId].filter(t => now - t < 3600000);
  if (apiCallLog[gameId].length >= limit) {
    console.error(`Rate limit hit for game ${gameId}: ${apiCallLog[gameId].length} calls in last hour`);
    return false;
  }
  apiCallLog[gameId].push(now);
  return true;
}

module.exports = {
  estimateCost,
  logCost,
  getCostSummary,
  checkRateLimit,
  MODEL_COSTS,
  IMAGE_COST,
  MAX_CALLS_PER_HOUR,
};
