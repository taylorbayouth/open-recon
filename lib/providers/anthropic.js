'use strict';

const { Anthropic } = require('@anthropic-ai/sdk');

// Anthropic provider. Translates the engine's generic { system, tools, messages }
// shape into the Messages API tool-use call, then parses tool_use blocks back
// into Action[]. Returns a Completion artifact.
//
// Caching is deliberately not configured in slice 1. The seam for it is the
// system/tools blocks — slice 3+ can mark them with cache_control.
//
// See DESIGN.md § Providers.

const DEFAULT_MODEL = 'claude-opus-4-7';
const DEFAULT_MAX_TOKENS = 4096;

let client = null;
function getClient() {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  client = new Anthropic({ apiKey });
  return client;
}

// Convert generic tool defs → Anthropic tool format.
//   generic:    { name, description, inputSchema: { foo: 'string', bar: 'number?' } }
//   anthropic:  { name, description, input_schema: { type: 'object', properties: {...}, required: [...] } }
function toAnthropicTool(tool) {
  const props = {};
  const required = [];
  for (const [key, type] of Object.entries(tool.inputSchema)) {
    const optional = type.endsWith('?');
    const baseType = optional ? type.slice(0, -1) : type;
    props[key] = { type: baseType };
    if (!optional) required.push(key);
  }
  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: { type: 'object', properties: props, required },
  };
}

// Convert generic messages → Anthropic messages. Our internal shape already
// matches the Anthropic content-block shape closely, so this is mostly a
// pass-through that strips any role/content combinations the SDK rejects.
function toAnthropicMessages(messages) {
  // Anthropic doesn't accept role: "system" in messages — that goes top-level.
  // The caller is expected to pass system separately, but we filter defensively.
  return messages.filter(m => m.role !== 'system');
}

// Parse the API response's content blocks into Action[].
function parseActions(content) {
  const actions = [];
  for (const block of content || []) {
    if (block.type !== 'tool_use') continue;
    const { name, input } = block;
    const action = { kind: 'action', verb: name, args: {} };
    // The ref (if any) lives inside input. Hoist it to the top level so the
    // engine's Action shape is uniform.
    for (const [k, v] of Object.entries(input || {})) {
      if (k === 'ref') action.ref = v;
      else action.args[k] = v;
    }
    action.toolUseId = block.id; // needed to construct tool_result later
    actions.push(action);
  }
  return actions;
}

async function plan(req) {
  const start = Date.now();
  const model = req.model || DEFAULT_MODEL;
  const c = getClient();

  const response = await c.messages.create({
    model,
    max_tokens: req.maxTokens || DEFAULT_MAX_TOKENS,
    temperature: 0,  // forced deterministic, consistent across all providers
    system: req.system,
    tools: (req.tools || []).map(toAnthropicTool),
    messages: toAnthropicMessages(req.messages || []),
  }, req.signal ? { signal: req.signal } : undefined);

  return {
    kind: 'completion',
    version: '1.0',
    provider: 'anthropic',
    model,
    raw: response,
    actions: parseActions(response.content),
    usage: {
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      cacheCreationTokens: response.usage?.cache_creation_input_tokens ?? null,
      cacheReadTokens: response.usage?.cache_read_input_tokens ?? null,
    },
    elapsedMs: Date.now() - start,
  };
}

module.exports = {
  name: 'anthropic',
  defaultModel: DEFAULT_MODEL,
  plan,
};
