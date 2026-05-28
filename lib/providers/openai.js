'use strict';

// OpenAI provider. Translates the engine's generic { system, tools, messages }
// shape into a Chat Completions call with function/tool calling, then parses
// tool_calls back into Action[]. Returns a Completion artifact.
//
// Implemented with native fetch (Node 18+) — no SDK dependency. OpenAI's
// chat-completions + tools shape is small enough that a single POST is simpler
// than another vendor SDK.
//
// See DESIGN.md § Providers.

const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function getConfig() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const baseURL = process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
  return { apiKey, baseURL };
}

// Convert generic tool defs → OpenAI tool format.
//   generic: { name, description, inputSchema: { foo: 'string', bar: 'number?' } }
//   openai:  { type: 'function', function: { name, description, parameters: {...} } }
function toOpenAITool(tool) {
  const props = {};
  const required = [];
  for (const [key, type] of Object.entries(tool.inputSchema)) {
    const optional = type.endsWith('?');
    const baseType = optional ? type.slice(0, -1) : type;
    props[key] = { type: baseType };
    if (!optional) required.push(key);
  }
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: { type: 'object', properties: props, required },
    },
  };
}

// Convert the engine's generic messages → OpenAI messages.
//
// The generic shape uses Anthropic-style content blocks. OpenAI differs in two
// ways we have to translate:
//   - assistant tool calls live in a `tool_calls` array (args are a JSON
//     *string*), not inline content blocks.
//   - tool results are their own message with role 'tool', keyed by
//     tool_call_id — not a content block inside a user message.
function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });

  for (const m of messages) {
    if (m.role === 'system') { out.push({ role: 'system', content: m.content }); continue; }

    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    if (m.role === 'assistant') {
      const toolCalls = [];
      let text = '';
      for (const block of m.content || []) {
        if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
          });
        } else if (block.type === 'text') {
          text += block.text || '';
        }
      }
      const msg = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }

    // user message with content blocks → one OpenAI message per block
    for (const block of m.content || []) {
      if (block.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        });
      } else if (block.type === 'text') {
        out.push({ role: 'user', content: block.text || '' });
      }
    }
  }
  return out;
}

// Parse OpenAI's response message.tool_calls into Action[]. `arguments` arrives
// as a JSON string and must be parsed.
function parseActions(message) {
  const actions = [];
  for (const tc of message?.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
    const action = { kind: 'action', verb: tc.function?.name, args: {} };
    for (const [k, v] of Object.entries(input)) {
      if (k === 'ref') action.ref = v;
      else action.args[k] = v;
    }
    action.toolUseId = tc.id;
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
    // No `temperature` field: the default model (gpt-5.4-mini) rejects any
    // non-default temperature, so we let it use its own default rather than
    // 400 on every call. Anthropic and Ollama still force temperature: 0.
    max_tokens: req.maxTokens || DEFAULT_MAX_TOKENS,
    messages: toOpenAIMessages(req.system, req.messages || []),
    tools: (req.tools || []).map(toOpenAITool),
    tool_choice: 'auto',
  };

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI API ${res.status}: ${text}`);
  }

  const data = await res.json();
  const message = data.choices?.[0]?.message || {};

  return {
    kind: 'completion',
    version: '1.0',
    provider: 'openai',
    model,
    raw: data,
    actions: parseActions(message),
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
      cacheCreationTokens: null,
      cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? null,
    },
    elapsedMs: Date.now() - start,
  };
}

module.exports = {
  name: 'openai',
  defaultModel: DEFAULT_MODEL,
  plan,
};
