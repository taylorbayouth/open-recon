'use strict';

// OpenAI provider. Chat Completions + tool calling over native fetch.
// Shares request/response shaping with ollama.js via _shared.js — this file
// only declares OpenAI's specifics: endpoint, auth, model default, the
// omitted temperature, and where the response/usage live.
//
// See DESIGN.md § Providers.

const {
  postJSON, buildCompletion,
  openaiStyleTool, openaiStyleMessages, parseOpenAIStyleToolCalls,
} = require('./_shared');

const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function getConfig() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  return { apiKey, baseURL: process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL };
}

async function plan(req) {
  const start = Date.now();
  const model = req.model || DEFAULT_MODEL;
  const { apiKey, baseURL } = getConfig();

  const body = {
    model,
    // No `temperature`: the default model (gpt-5.4-mini) rejects a non-default
    // temperature, so we let it use its own default rather than 400 every call.
    max_tokens: req.maxTokens || DEFAULT_MAX_TOKENS,
    messages: openaiStyleMessages(req.system, req.messages || [], { argsAsString: true }),
    tools: (req.tools || []).map(openaiStyleTool),
    tool_choice: 'auto',
  };

  const data = await postJSON(`${baseURL}/chat/completions`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    signal: req.signal,
    label: 'OpenAI API',
  });

  const message = data.choices?.[0]?.message || {};
  return buildCompletion({
    provider: 'openai',
    model,
    raw: data,
    start,
    actions: parseOpenAIStyleToolCalls(message.tool_calls, { argsAsString: true, synthId: null }),
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
      cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? null,
    },
  });
}

module.exports = { name: 'openai', defaultModel: DEFAULT_MODEL, plan };
