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
    // gpt-5.4-mini (and other modern agentic models) reject the legacy
    // `max_tokens` field and a non-default `temperature` on chat/completions —
    // hence `max_completion_tokens` and no temperature. If you point
    // OPENAI_BASE_URL at an older model that only knows `max_tokens`, swap this.
    max_completion_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: openaiStyleMessages(req.system, req.messages || [], { argsAsString: true }),
  };

  // Only advertise tools when there are some. Sending `tools: []` with
  // `tool_choice: 'required'` is meaningless and some endpoints reject it; omitting
  // both also lets this provider serve plain text completions (no tools).
  // `required` (not `auto`) forces a tool call every turn — the only way the model
  // can signal completion is by invoking the `done` tool, preventing prose-done loops.
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map(openaiStyleTool);
    body.tool_choice = 'required';
  }

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
    // Tool calls → Actions. No tool_calls (model answered in prose, or refused)
    // ⇒ empty list; the loop then leans on `text`/`refusal` below to explain why.
    actions: message.tool_calls
      ? parseOpenAIStyleToolCalls(message.tool_calls, { argsAsString: true, synthId: null })
      : [],
    // Prose the model returned instead of / alongside a tool call.
    text: message.content || null,
    // OpenAI's dedicated safety-refusal field (distinct from ordinary content).
    refusal: message.refusal || null,
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
      cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? null,
    },
  });
}

module.exports = { name: 'openai', defaultModel: DEFAULT_MODEL, plan };
