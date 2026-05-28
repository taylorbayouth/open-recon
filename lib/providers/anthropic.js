'use strict';

// Anthropic provider. Messages API + tool use over native fetch (no SDK).
// Shares the schema builder, ref hoist, postJSON, and Completion envelope with
// the other providers via _shared.js; only Anthropic's distinct wire format
// (system as a top-level field, `input_schema` tool key, `content` blocks)
// lives here.
//
// Prompt caching: the system prompt and tool definitions are byte-identical on
// every turn of a run (only the user message changes), yet a run is 30–50 turns.
// We mark a cache breakpoint on the system block — Anthropic caches the whole
// prefix up to and including it (tools come before system in the request), so
// both the tools and the system prompt are served from cache on turns 2..N.
// Cache hits show up as `cache_read_input_tokens` in usage. The ephemeral cache
// has a ~5-minute TTL that refreshes on each hit, and a miss simply costs full
// input tokens (the prior behavior), so this is upside with no downside.
//
// See DESIGN.md § Providers.

const { buildJsonSchema, hoistRef, postJSON, buildCompletion } = require('./_shared');

const DEFAULT_MODEL = 'claude-opus-4-7';
const DEFAULT_MAX_TOKENS = 4096;
// Base URL excludes /v1 and we append /v1/messages below — this matches the
// Anthropic SDK's convention (its baseURL is the bare origin), so an
// ANTHROPIC_BASE_URL set for the SDK keeps working. OpenAI's convention is the
// opposite (baseURL includes /v1), which is why the two providers differ here.
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

function getConfig() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const baseURL = (process.env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  return { apiKey, baseURL };
}

// Anthropic tool format: { name, description, input_schema } — note the key is
// input_schema, not the OpenAI-style nested function/parameters shape.
function toAnthropicTool(tool) {
  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: buildJsonSchema(tool.inputSchema),
  };
}

// The engine's generic content blocks already match Anthropic's native shape
// (tool_use / tool_result), so message translation is just dropping the
// system messages — those go in a top-level `system` field instead.
function toAnthropicMessages(messages) {
  return messages.filter(m => m.role !== 'system');
}

function parseActions(content) {
  const actions = [];
  for (const block of content || []) {
    if (block.type !== 'tool_use') continue;
    const { ref, args } = hoistRef(block.input || {});
    const action = { kind: 'action', verb: block.name, args };
    if (ref !== undefined) action.ref = ref;
    action.toolUseId = block.id;
    actions.push(action);
  }
  return actions;
}

async function plan(req) {
  const start = Date.now();
  const model = req.model || DEFAULT_MODEL;
  const { apiKey, baseURL } = getConfig();

  const body = {
    model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: 0,  // forced deterministic
    // System as a single cache-marked text block (see header note). A bare
    // string would also work but can't carry cache_control.
    system: req.system
      ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
      : undefined,
    tools: (req.tools || []).map(toAnthropicTool),
    messages: toAnthropicMessages(req.messages || []),
  };

  const data = await postJSON(`${baseURL}/v1/messages`, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    body,
    signal: req.signal,
    label: 'Anthropic API',
  });

  return buildCompletion({
    provider: 'anthropic',
    model,
    raw: data,
    start,
    actions: parseActions(data.content),
    usage: {
      inputTokens: data.usage?.input_tokens ?? null,
      outputTokens: data.usage?.output_tokens ?? null,
      cacheCreationTokens: data.usage?.cache_creation_input_tokens ?? null,
      cacheReadTokens: data.usage?.cache_read_input_tokens ?? null,
    },
  });
}

module.exports = { name: 'anthropic', defaultModel: DEFAULT_MODEL, plan };
