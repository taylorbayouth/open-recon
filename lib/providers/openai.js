'use strict';

// OpenAI provider. Chat Completions + tool calling over native fetch.
// Shares request/response shaping with ollama.js via _shared.js — this file
// only declares OpenAI's specifics: endpoint, auth, model default, the
// omitted temperature, and where the response/usage live.
//
// Prompt caching is automatic on OpenAI (no breakpoints): it caches the longest
// common prefix of a request ≥1024 tokens and routes by a hash of the first
// ~256 tokens. We keep the static content (tools, then system) at the front and
// the dynamic turn message last so the prefix is maximally shared — see the
// body assembly below. Two extra levers from the caching guide:
//   - prompt_cache_key: a per-run id (passed as req.cacheKey) that's combined
//     with the prefix hash to keep a run's turns sticky to one machine, lifting
//     the hit rate. A run does ~1 request/turn, far below the ~15 req/min/key
//     ceiling above which requests overflow to other machines.
//   - prompt_cache_retention: optional, via OPENAI_PROMPT_CACHE_RETENTION
//     ('24h' for extended retention on supported models). Left unset by default
//     so each model uses its own default and unsupported models aren't sent a
//     field they'd reject.
// Cache hits surface as usage.prompt_tokens_details.cached_tokens.
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

  // Stable fields first (model, tools) before the dynamic messages array so the
  // serialized JSON body has the longest cacheable prefix at the front.
  // gpt-5.4-mini (and other modern agentic models) reject the legacy `max_tokens`
  // field and a non-default `temperature` — hence `max_completion_tokens` and no
  // temperature. If you point OPENAI_BASE_URL at an older model that only knows
  // `max_tokens`, swap this.
  const body = {
    model,
    max_completion_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
  };

  // Tools before messages: stable schema comes before dynamic turn content.
  // `required` (not `auto`) forces a tool call every turn — the only way the model
  // can signal completion is by invoking the `done` tool, preventing prose-done loops.
  // Omitting tools entirely lets this provider serve plain text completions.
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map(openaiStyleTool);
    body.tool_choice = 'required';
  }

  body.messages = openaiStyleMessages(req.system, req.messages || [], { argsAsString: true });

  // Caching levers (see header). Both are optional and additive: with no key,
  // automatic prefix caching still applies; with no retention env, the model's
  // own default is used.
  if (req.cacheKey) body.prompt_cache_key = String(req.cacheKey);
  const retention = process.env.OPENAI_PROMPT_CACHE_RETENTION;
  if (retention) body.prompt_cache_retention = retention;

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
      cachedRatio: data.usage?.prompt_tokens
        ? ((data.usage?.prompt_tokens_details?.cached_tokens ?? 0) / data.usage.prompt_tokens)
        : null,
    },
  });
}

module.exports = { name: 'openai', defaultModel: DEFAULT_MODEL, plan };
