'use strict';

let registryPromise = null;

async function buildRegistry() {
  const ai = await import('ai');
  const openaiModule = await import('@ai-sdk/openai');
  const compatibleModule = await import('@ai-sdk/openai-compatible');

  const providers = {
    openai: openaiModule.openai,
  };

  if (process.env.CUSTOM_LLM_BASE_URL) {
    providers.custom = compatibleModule.createOpenAICompatible({
      name: process.env.CUSTOM_LLM_NAME || 'custom',
      apiKey: process.env.CUSTOM_LLM_API_KEY,
      baseURL: process.env.CUSTOM_LLM_BASE_URL,
    });
  }

  return {
    ...ai,
    registry: ai.createProviderRegistry(providers),
  };
}

function loadRegistry() {
  if (!registryPromise) registryPromise = buildRegistry();
  return registryPromise;
}

function normalizeMessages(messages = []) {
  return messages.map(message => ({
    role: message.role,
    content: typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map(part => part.text || part.content || '').join('\n')
        : String(message.content || ''),
  }));
}

function getTokenUsage(usage) {
  const inputTokens = usage?.inputTokens ?? usage?.promptTokens ?? usage?.input_tokens ?? 0;
  const outputTokens = usage?.outputTokens ?? usage?.completionTokens ?? usage?.output_tokens ?? 0;
  return { inputTokens, outputTokens };
}

function getMaxRetries() {
  const parsed = Number(process.env.LLM_MAX_RETRIES ?? 0);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function getCallSettings(model, maxTokens, temperature) {
  const modelId = String(model || '').split(':').pop();
  const settings = {
    maxOutputTokens: maxTokens,
    maxRetries: getMaxRetries(),
  };

  if (temperature !== undefined && !/^gpt-5(?:[.-]|$)/i.test(modelId)) {
    settings.temperature = temperature;
  }

  return settings;
}

async function streamText({ model, system, messages, maxTokens, temperature, onToken }) {
  const { registry, streamText: aiStreamText } = await loadRegistry();
  const result = aiStreamText({
    model: registry.languageModel(model),
    system,
    messages: normalizeMessages(messages),
    ...getCallSettings(model, maxTokens, temperature),
  });

  let text = '';
  for await (const chunk of result.textStream) {
    text += chunk;
    if (onToken) onToken(chunk);
  }

  const usage = await Promise.resolve(result.usage).catch(() => null);
  return {
    text,
    usage: getTokenUsage(usage),
    finishReason: await Promise.resolve(result.finishReason).catch(() => null),
  };
}

async function completeText({ model, system, messages, maxTokens, temperature }) {
  const { registry, generateText } = await loadRegistry();
  const result = await generateText({
    model: registry.languageModel(model),
    system,
    messages: normalizeMessages(messages),
    ...getCallSettings(model, maxTokens, temperature),
  });

  return {
    text: result.text || '',
    usage: getTokenUsage(result.usage),
    finishReason: result.finishReason || null,
  };
}

async function completeJson({ model, system, messages, schema, maxTokens, temperature }) {
  const { registry, generateObject, jsonSchema } = await loadRegistry();
  const result = await generateObject({
    model: registry.languageModel(model),
    system,
    messages: normalizeMessages(messages),
    schema: jsonSchema(schema),
    ...getCallSettings(model, maxTokens, temperature),
  });

  return {
    object: result.object,
    text: JSON.stringify(result.object),
    usage: getTokenUsage(result.usage),
    finishReason: result.finishReason || null,
  };
}

function resetForTesting() {
  registryPromise = null;
}

module.exports = {
  streamText,
  completeText,
  completeJson,
  resetForTesting,
};
