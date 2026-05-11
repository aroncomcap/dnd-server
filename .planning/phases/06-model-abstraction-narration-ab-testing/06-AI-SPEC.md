# AI-SPEC - Phase 6: Model Abstraction And Narration A/B Testing

> AI design contract generated manually under GSD conventions because `gsd-sdk` is not available in this Codex shell.
> Consumed by future `gsd-plan-phase` / implementation planning before code changes.

---

## 1. System Classification

**System Type:** Hybrid conversational content generation plus structured extraction.

**Description:**
They Still Sing needs to replace Anthropic as the runtime LLM dependency while gaining a model abstraction layer that can route different tasks to any supported model provider. The player-facing experiment surface is Game Master narration: models compete on qualitative player experience, latency, reliability, and cost. Hidden structured tasks use cheaper reliable models and schema validation rather than A/B testing every internal call.

**Critical Failure Modes:**
1. Player-facing turns stall, double-send, or lose action controls because a provider stream fails.
2. Narration quality improves in isolated examples but worsens the live game through continuity breaks, excessive length, weak options, or rules mistakes.
3. Experiment data cannot answer the real question: which narration model gives the best experience per dollar.
4. Hidden structured extraction emits invalid data that corrupts world state, combat state, maps, or turn order.
5. Provider-specific assumptions leak back into game logic, recreating the current lock-in under a new SDK.

---

## 1b. Domain Context

**Industry Vertical:** Consumer entertainment, tabletop RPG assistant, live multiplayer web game.

**User Population:** Hosts and players in casual RPG sessions. Players are not evaluating model benchmarks; they are deciding whether the AI Game Master makes the next action feel worth taking.

**Stakes Level:** Medium. Bad AI output is not life-critical, but it can waste paid minutes, break a live session, or damage trust in the app.

**Output Consequence:** Narration is immediately displayed in a live game and drives the next player decision. Structured extraction updates durable game state and can affect future turns.

### What Domain Experts Evaluate Against

| Dimension | Good | Bad | Stakes |
|-----------|------|-----|--------|
| Player momentum | The player immediately understands the situation and wants to act. | The response is generic, flat, confusing, or leaves no clear next move. | Retention and session fun |
| Table agency | The GM reacts to player intent without overriding character choices. | The model railroads the party, invents actions for players, or resolves mechanics it should not. | Trust and fairness |
| RPG continuity | NPCs, locations, combat outcomes, and prior decisions remain stable. | Dead enemies return, NPCs drift, locations reset, or previous choices disappear. | Campaign coherence |
| Rules respect | Narrative stays compatible with D&D 5e / configured system and lets the engine resolve combat. | The model rolls dice, invents illegal mechanics, or bypasses combat resolution. | Correctness and player trust |
| Pacing and style | Tone matches persona and verbosity settings; options are distinct and actionable. | Too long, too terse, repetitive, marker leakage, or three near-identical options. | UX quality |
| Cost efficiency | Quality gains justify token cost and latency. | Expensive model gives little visible advantage over cheaper model. | Unit economics |

### Known Failure Modes In This Domain

- "Novelty over continuity": the model creates fresh drama while forgetting the campaign state.
- "DM overreach": the model resolves combat, rolls dice, or decides player intent instead of describing consequences.
- "Option collapse": suggested actions are bland, redundant, or not usable by the current turn holder.
- "Style drift": persona becomes too comedic, too grim, or too verbose after a few turns.
- "Invisible quality debt": hidden extraction works until one malformed update poisons future turns.
- "Biased ratings": players rate a model name or expectation instead of the actual narration.

### Regulatory / Compliance Context

No domain-specific regulation identified. General privacy and billing expectations still apply:
- Store only telemetry needed to compare model quality, cost, latency, and failures.
- Treat raw prompts/outputs as potentially sensitive campaign content.
- Keep experiment participation and feedback controls transparent to players.

### Domain Expert Roles For Evaluation

| Role | Responsibility |
|------|----------------|
| Product owner / designer | Define player-visible feedback tags and decide winner thresholds. |
| Experienced tabletop GM | Review sampled narrations for agency, pacing, rules respect, and continuity. |
| Engineer | Validate schema outputs, cost accounting, latency, failure handling, and rollout safety. |
| Live players | Provide in-product ratings and qualitative tags after narrations. |

---

## 2. Framework Decision

**Selected Framework:** Custom Tavern `llm` product abstraction backed by Vercel AI SDK Core provider registry, with OpenAI as the first production provider.

**Version:** Pin current `ai`, `@ai-sdk/openai`, and `@ai-sdk/openai-compatible` npm packages at implementation time. Prices and supported model IDs must be loaded from config rather than hardcoded assumptions.

**Rationale:**
The app already has direct Express, Socket.IO, PostgreSQL, and test patterns. It does not need agent orchestration; it needs a stable boundary between game logic and model providers. A Tavern-owned adapter keeps telemetry, experiments, and game semantics under local control, while AI SDK Core supplies a mature provider registry, model aliases, streaming helpers, and OpenAI-compatible provider support. That combination keeps future cheap/good model trials mostly config-driven instead of requiring another migration.

**Alternatives Considered:**

| Framework | Ruled Out Because |
|-----------|-------------------|
| OpenAI Agents SDK | Useful for agent workflows, but this phase is provider routing, streaming narration, and structured extraction, not tool-using agent orchestration. |
| LangChain.js / LangGraph.js | More abstraction than the app needs right now; adds framework concepts without solving the core experiment telemetry problem. |
| Raw Vercel AI SDK everywhere | Strong provider and streaming ergonomics, but Tavern still needs a product-specific boundary for experiments, cost tracking, retention, and feedback. Use it underneath the local adapter, not as the game-layer API. |
| Direct OpenAI calls throughout code | Fastest short-term migration, but it recreates provider lock-in and makes A/B telemetry inconsistent. |
| LiteLLM proxy | Excellent future gateway for many providers, budgets, and central admin, but it adds another service to deploy/debug before the model lab has proven its local telemetry shape. |

**Vendor Lock-In Accepted:** Partial. Phase 6 replaces Anthropic runtime dependency with OpenAI as the primary provider, but all game code must call the local `llm` interface rather than any provider SDK or AI SDK primitive directly.

---

## 3. Framework Quick Reference

### Installation

```bash
npm install ai @ai-sdk/openai @ai-sdk/openai-compatible
```

### Core Imports

```js
const { createProviderRegistry, streamText: aiStreamText, generateObject, generateText } = require('ai');
const { openai } = require('@ai-sdk/openai');
const { createOpenAICompatible } = require('@ai-sdk/openai-compatible');
```

### Entry Point Pattern

```js
// llm/index.js
async function streamText({ task, model, system, messages, maxTokens, temperature, metadata, onToken }) {
  const provider = selectProvider(model);
  return provider.streamText({ task, model, system, messages, maxTokens, temperature, metadata, onToken });
}

async function completeJson({ task, model, schema, system, messages, maxTokens, metadata }) {
  const provider = selectProvider(model);
  return provider.completeJson({ task, model, schema, system, messages, maxTokens, metadata });
}

module.exports = { streamText, completeJson };
```

```js
// llm/provider-registry.js
const registry = createProviderRegistry({
  openai,
  custom: createOpenAICompatible({
    name: 'custom',
    apiKey: process.env.CUSTOM_LLM_API_KEY,
    baseURL: process.env.CUSTOM_LLM_BASE_URL,
  }),
});

module.exports = { registry };
```

```js
// llm/providers/ai-sdk.js
async function streamText({ model, system, messages, maxTokens, temperature, onToken }) {
  const result = aiStreamText({
    model: registry.languageModel(model),
    system,
    messages,
    maxOutputTokens: maxTokens,
    temperature,
  });

  let text = '';
  for await (const chunk of result.textStream) {
    text += chunk;
    onToken?.(chunk);
  }

  return normalizeRunResult({ text, usage: await result.usage });
}
```

### Key Abstractions

| Concept | What It Is | When You Use It |
|---------|------------|-----------------|
| Provider | SDK/API implementation for one vendor or protocol. | AI SDK OpenAI provider, OpenAI-compatible providers, future native providers. |
| Model config | Declarative model registry with provider, task fit, price, token limits, and defaults. | Routing, cost estimation, experiments. |
| Task type | Stable product intent such as `narration`, `world-extraction`, `validation`, `party-gen`, `ooc`, `summary`. | Selecting model, prompt, schema, temperature, and metrics. |
| Run record | One provider call with timing, usage, cost, output metadata, error state. | Cost and reliability analysis. |
| Experiment assignment | Sticky mapping from game/session to narration variant. | Player-facing A/B testing. |

### Common Pitfalls

1. Do not let `server.js`, `narration-pipeline.js`, `action-parser.js`, or `stat-parser.js` call OpenAI directly.
2. Do not compare models turn-by-turn inside the same player session; personality shifts will pollute quality feedback.
3. Do not expose model names in the player feedback UI; this biases ratings.
4. Do not store only aggregate cost. Store per-run task, model, latency, token usage, status, and experiment variant.
5. Do not A/B test hidden extraction at first. Make it deterministic, cheap, schema-valid, and observable.

### Recommended Project Structure

```text
llm/
  index.js
  provider-registry.js
  model-registry.js
  experiments.js
  telemetry.js
  providers/
    ai-sdk.js
  schemas/
    world-extraction.js
    narration-validation.js
tests/
  llm-provider.test.js
  llm-experiments.test.js
  llm-telemetry.test.js
```

---

## 4. Implementation Guidance

**Model Configuration:**

Use environment-driven defaults so models can be changed without code deploy:

```text
LLM_PROVIDER=openai
LLM_NARRATION_EXPERIMENT=2026-q2-openai-narration
LLM_NARRATION_VARIANTS=openai:gpt-5.4-mini:70,openai:gpt-5.4:30
LLM_STRUCTURED_MODEL=openai:gpt-5.4-nano
LLM_SUMMARY_MODEL=openai:gpt-5.4-nano
LLM_OOC_MODEL=openai:gpt-5.4-mini
LLM_STORE_TEXT=true
LLM_TEXT_RETENTION_DAYS=30
LLM_EXPERIMENTS_ENABLED=true
OPENAI_API_KEY=...
```

Initial model roles:
- `gpt-5.4-mini`: default narration candidate; likely best first quality/cost balance.
- `gpt-5.4`: higher-quality narration challenger.
- `gpt-5.5`: optional premium challenger only if budget allows.
- `gpt-5.4-nano`: extraction, validation, summaries, rankings, simple classifications.

OpenAI pricing references as of 2026-05-11:
- `gpt-5.5`: $5.00 / 1M input, $30.00 / 1M output.
- `gpt-5.4`: $2.50 / 1M input, $15.00 / 1M output.
- `gpt-5.4-mini`: $0.75 / 1M input, $4.50 / 1M output.
- `gpt-5.4-nano`: $0.20 / 1M input, $1.25 / 1M output.

**Core Pattern:**

All AI calls pass through the local `llm` layer. The game layer supplies product context, task name, desired schema, and streaming callbacks. The provider returns normalized text/JSON, usage, cost estimate, latency, model, provider, and status.

**Task Routing:**

| Task | First OpenAI Model | Streaming | Temperature | Notes |
|------|--------------------|-----------|-------------|-------|
| Narration | Experiment variant | Yes | Persona/verbosity based | Player-visible A/B surface. |
| Options fallback | `gpt-5.4-nano` or same variant | No | 0.3 | Only when narration parser finds fewer than 3 options. |
| World extraction | `gpt-5.4-nano` | No | 0.0 | Structured output with JSON Schema. |
| Validation | `gpt-5.4-nano` | No | 0.0 | Checks rule/format violations. |
| Party generation | `gpt-5.4-mini` | No | 0.7 | Creativity matters, but not A/B initially. |
| OOC / catch-up / summary | `gpt-5.4-mini` or `nano` by task | No | 0.2-0.6 | Optimize after narration path is stable. |

**State Management:**

Add PostgreSQL tables through `initDB()` migrations:

```sql
CREATE TABLE IF NOT EXISTS llm_experiments (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  variants JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS llm_experiment_assignments (
  experiment_id TEXT REFERENCES llm_experiments(id),
  game_id TEXT REFERENCES games(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (experiment_id, game_id)
);

CREATE TABLE IF NOT EXISTS llm_runs (
  id TEXT PRIMARY KEY,
  experiment_id TEXT,
  variant_id TEXT,
  game_id TEXT REFERENCES games(id) ON DELETE CASCADE,
  turn_id TEXT,
  task TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INT,
  input_tokens INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  estimated_cost_usd NUMERIC(12, 6) DEFAULT 0,
  prompt_hash TEXT,
  output_hash TEXT,
  output_text TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS narration_feedback (
  id TEXT PRIMARY KEY,
  llm_run_id TEXT REFERENCES llm_runs(id) ON DELETE CASCADE,
  game_id TEXT REFERENCES games(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  rating INT CHECK (rating BETWEEN 1 AND 5),
  tags JSONB NOT NULL DEFAULT '[]',
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (llm_run_id, user_id)
);
```

**Context Window Strategy:**

Keep the current split-pipeline discipline: narration receives compact character/persona/story context, not raw full-state dumps. Use summaries and capped campaign context. Structured extraction receives only the completed narration, player action, and relevant current world state.

---

## 4b. AI Systems Best Practices

### Structured Outputs With JSON Schema

The repo is JavaScript, so prefer JSON Schema or Zod over Pydantic. The GSD template asks for Pydantic, but using Pydantic in this Node service would add a Python boundary for no product gain.

```js
const worldExtractionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scene', 'locations', 'npcs', 'enemies', 'accomplishments', 'charUpdates'],
  properties: {
    scene: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'mood', 'npc'],
      properties: {
        action: { type: 'string' },
        mood: { type: 'string' },
        npc: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
    locations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'distance', 'isNew', 'img'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          distance: { type: 'string' },
          isNew: { type: 'boolean' },
          img: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
    },
    npcs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'location', 'isNew', 'img'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          location: { type: 'string' },
          isNew: { type: 'boolean' },
          img: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
    },
    enemies: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['displayName', 'count', 'slug'],
        properties: {
          displayName: { type: 'string' },
          count: { type: 'integer' },
          slug: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
    },
    accomplishments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['character', 'achievement'],
        properties: {
          character: { type: 'string' },
          achievement: { type: 'string' },
        },
      },
    },
    charUpdates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['character', 'field', 'value'],
        properties: {
          character: { type: 'string' },
          field: { type: 'string' },
          value: { type: 'string' },
        },
      },
    },
  },
};
```

Provider implementation should use AI SDK object generation backed by OpenAI Structured Outputs / JSON Schema for non-tool responses and normalize refusals or schema failures into retryable errors.

### Async-First Design

Narration remains streaming-first. Extraction and validation run after the completed narration and should not block the player from receiving text or restored controls unless the extracted data is required for the next action.

### Prompt Engineering Discipline

Keep system prompt and user/action message separate. The narration prompt must define persona, verbosity, rules boundaries, and option format. The player message must contain recent history, pending corrections, and the current action only.

### Context Window Management

Continue to cap custom campaign context, use rolling story summaries, and include only the last useful chat turns. Do not rely on larger OpenAI context windows as a substitute for prompt discipline.

### Cost And Latency Budget

Track each call in `llm_runs`. Primary decision metric should be "quality-adjusted cost per 100 completed turns", not raw model price. Cached input can help if prompts become stable, but the first implementation should treat cached input as an optimization rather than a requirement.

---

## 5. Evaluation Strategy

### Dimensions

| Dimension | Rubric | Measurement Approach | Priority |
|-----------|--------|----------------------|----------|
| Player rating | 1-5 stars after narration; 4+ means good, 3 neutral, 1-2 needs review. | Human/player | Critical |
| Player feedback tags | Positive tags: great moment, funny, vivid, useful options. Negative tags: confusing, boring, too long, rules wrong, forgot context. | Human/player | Critical |
| Cost per 100 turns | Estimated provider cost normalized to 100 completed player turns. | Code metric | Critical |
| Latency | p50/p95 first-token and full-completion latency. | Code metric | High |
| Reliability | Stream completion rate, fallback rate, schema validation failures, API errors. | Code metric | Critical |
| Narration format | No marker leakage; exactly 3 parsed options; no markdown headers. | Code metric | High |
| RPG quality sample | GM review on continuity, agency, rules respect, and pacing. | Human review, optional LLM judge after calibration | High |

### Eval Tooling

**Primary Tool:** Built-in PostgreSQL telemetry plus an admin report for Phase 6. Add Braintrust or Promptfoo later only after the local dataset and rubrics stabilize.

**Setup:**

```bash
npm install openai
```

**CI/CD Integration:**

```bash
npm test
npx playwright test tests/e2e/campaign-verbose.spec.ts --project=chromium
```

Add focused unit tests for:
- provider normalization,
- experiment assignment stickiness,
- model cost calculation,
- feedback API validation,
- structured-output schema handling.

### Reference Dataset

**Size:** Start with 20 stored turn scenarios.

**Composition:**
- 5 social / NPC interaction turns.
- 5 exploration / location discovery turns.
- 5 combat-adjacent turns where the model must not resolve engine mechanics.
- 3 continuity stress turns involving prior NPCs, completed fights, or old locations.
- 2 failure-regression turns for marker leakage and missing options.

**Labeling:**
Product owner and one experienced tabletop GM rate examples using the Phase 6 rubric. Live player ratings are collected continuously and compared against the expert sample.

### Output Quality Harness

The implementation must include a deterministic test harness that replays saved turn fixtures against configured models and evaluates every output before production rollout. It should check:
- visible narration is non-empty and free of structured marker leakage,
- exactly 3 options parse from the output,
- options are distinct and actionable,
- narration stays within verbosity budget,
- combat-adjacent turns do not resolve engine-owned mechanics,
- structured extraction validates against schema,
- token/cost/latency telemetry is recorded for each run.

The harness should support fixture-only CI with mocked providers and an opt-in live mode for real model comparisons.

---

## 6. Guardrails

### Online Real-Time

| Guardrail | Trigger | Intervention |
|-----------|---------|--------------|
| Stream failure | Provider stream errors or ends without completed response. | Finalize pending UI state, emit fallback narration/options, record failed `llm_run`. |
| Missing options | Parser finds fewer than 3 options. | Generate cheap fallback options or use deterministic fallback options. |
| Marker leakage | Narration contains `---OPTIONS---`, `---SCENE---`, `---WORLD---`, or schema fragments. | Sanitize before display and flag run for review. |
| Excessive length | Narration exceeds verbosity cap by configured threshold. | Trim display only if necessary, queue correction for next turn, flag run. |
| Structured schema failure | Extraction/validation output fails schema. | Retry once on same structured model, then skip state mutation and log failure. |
| Cost anomaly | Per-call estimated cost exceeds task threshold. | Flag in telemetry; optionally disable expensive variant if rolling cost threshold is exceeded. |
| Retention cleanup | Stored prompt/output rows exceed retention window. | Scheduled cleanup deletes raw text while preserving aggregate metadata. |

### Offline Flywheel

| Metric | Sampling Strategy | Action On Degradation |
|--------|-------------------|-----------------------|
| Low ratings | Review all 1-2 star narrations and a sample of 3-star narrations. | Prompt/model adjustment or experiment variant pause. |
| Rules wrong tag | Sample 100% until rate drops below threshold. | Add rule prompt correction, improve validation, or reroute model. |
| High cost per rating point | Weekly comparison across variants. | Shift traffic away from expensive underperformers. |
| High latency | Review p95 by model and provider. | Reduce model tier, token cap, or prompt size. |
| Fallback rate | Review by provider/model/task. | Fix provider adapter or remove unstable variant. |

---

## 7. Production Monitoring

**Tracing Tool:** Phase 6 default is local PostgreSQL telemetry and admin reporting. External tracing such as Arize Phoenix, Langfuse, Braintrust, or Promptfoo can be added after the local run schema proves useful.

**Key Metrics To Track:**
- Rating average and rating count by experiment variant.
- Positive/negative feedback tag distribution by variant.
- Cost per 100 completed turns by variant.
- p50/p95 first-token and full-response latency.
- Stream failure, fallback, schema failure, and marker-leak rates.

**Alert Thresholds:**
- Any provider-wide stream failure rate above 5% over the last 50 narration runs.
- Any variant cost per 100 turns more than 2x baseline without a rating lift of at least 0.4.
- Missing-options fallback rate above 10%.
- Any marker leakage to sanitized client payloads.

**Smart Sampling Strategy:**
Prioritize human review for low ratings, negative tags, expensive runs, high-latency runs, fallback runs, schema failures, and long sessions where continuity matters.

**Retention Policy:**
Store full prompt/output text for complete evaluation during the active model lab window. A scheduled cleanup deletes raw prompt/output text after `LLM_TEXT_RETENTION_DAYS` days, while preserving hashes, task metadata, usage, cost, latency, model, variant, rating, and tags for long-term analysis.

---

## Player-Visible Experiment UX

Player feedback appears below each completed DM narration after the message finishes streaming. The UI should be compact and optional:

- 5-star or thumb-based primary rating, implemented consistently across desktop/mobile.
- Tag chips: `Great moment`, `Funny`, `Vivid`, `Useful options`, `Confusing`, `Boring`, `Too long`, `Rules wrong`, `Forgot context`.
- Optional short note behind a small "add note" affordance.
- A one-line neutral disclosure in the feedback surface: "Rate this narration to help tune the Game Master."
- Model/provider identity hidden from players to avoid bias.
- Admin/debug view can show model, variant, cost, and run id.
- The control should be visually quiet: small icons/chips below the narration, muted until hover/focus, never competing with action buttons.

Feedback must not block the next turn, resize old messages dramatically, or steal focus from active play.

---

## Rollout Plan For Future Implementation

1. Add the `llm` adapter, OpenAI provider, model registry, and tests while preserving current gameplay behavior behind a feature flag.
2. Migrate narration pipeline to OpenAI through the adapter and remove direct Anthropic streaming.
3. Migrate structured and side calls through `completeJson` / `completeText`.
4. Add telemetry tables and cost estimation.
5. Add sticky narration experiment assignment.
6. Add player-visible feedback UI and feedback API.
7. Add admin/reporting view.
8. Run local unit tests, browser campaign, production smoke, then deploy with conservative traffic weights.

---

## Open Questions

1. Should raw prompt/output text be stored by default for review, or should production store hashes plus sampled outputs only?
2. Should players see a feedback prompt after every narration, or should the UI sample feedback requests to reduce fatigue after the first few turns?
3. What budget threshold should pause an expensive narration variant automatically?

Recommended defaults for implementation unless overridden:
- Store full prompt/output text for active model-lab runs, then purge raw text after `LLM_TEXT_RETENTION_DAYS`.
- Show feedback after every narration but collapse it after the first response if ignored repeatedly.
- Pause a variant if it costs 2x baseline with less than 0.4 average-rating lift after 50 rated runs.

---

## Checklist

- [x] System type classified.
- [x] Critical failure modes identified.
- [x] Domain context researched and grounded in tabletop RPG use.
- [x] Regulatory/compliance context identified as general privacy/billing, no domain-specific regulation.
- [x] Domain expert roles defined.
- [x] Framework selected with rationale documented.
- [x] Alternatives considered and ruled out.
- [x] Framework quick reference written.
- [x] AI systems best practices written for JavaScript/JSON Schema.
- [x] Evaluation dimensions grounded in domain rubric ingredients.
- [x] Each eval dimension has a concrete measurement approach.
- [x] Eval tooling selected with local telemetry as Phase 6 default.
- [x] Reference dataset spec written.
- [x] CI/CD eval integration specified.
- [x] Online guardrails defined.
- [x] Production monitoring and sampling strategy defined.

---

## References

- OpenAI streaming responses: https://platform.openai.com/docs/api-reference/streaming
- OpenAI structured outputs: https://platform.openai.com/docs/guides/structured-outputs?api-mode=responses&lang=javascript
- OpenAI API pricing: https://openai.com/api/pricing/
- AI SDK provider management: https://ai-sdk.dev/docs/ai-sdk-core/provider-management
- AI SDK providers and models: https://ai-sdk.dev/docs/foundations/providers-and-models
- GPT-5.4 mini model page: https://developers.openai.com/api/docs/models/gpt-5.4-mini/
- GPT-5.4 nano model page: https://developers.openai.com/api/docs/models/gpt-5.4-nano/
