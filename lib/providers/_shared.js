'use strict';

// Shared scaffolding for all LLM providers. Each provider file implements only
// what is genuinely different about its wire format (request envelope, where
// the response lives, usage field names); everything common lives here so the
// three stay congruent.
//
// All providers hit their REST endpoint with native fetch — no vendor SDKs.

// Convert the engine's compact inputSchema ({ foo: 'string', bar: 'number?' })
// into a JSON Schema object. A trailing '?' marks a field optional.
function buildJsonSchema(inputSchema) {
  const properties = {};
  const required = [];
  for (const [key, type] of Object.entries(inputSchema || {})) {
    const optional = type.endsWith('?');
    properties[key] = { type: optional ? type.slice(0, -1) : type };
    if (!optional) required.push(key);
  }
  return { type: 'object', properties, required };
}

// Split a tool-call input object into the engine's Action fields: `ref` is
// hoisted to the top level, everything else becomes `args`.
function hoistRef(input) {
  let ref;
  const args = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (k === 'ref') ref = v;
    else args[k] = v;
  }
  return { ref, args };
}

// POST JSON, parse JSON, with uniform error + abort handling. `label` prefixes
// the error message so failures are attributable to a provider.
async function postJSON(url, { headers = {}, body, signal, label = 'API' } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${label} ${res.status}: ${text}`);
  }
  return res.json();
}

// Assemble the Completion artifact uniformly. The caller passes already-
// normalized usage; we backfill the four standard fields with null.
function buildCompletion({ provider, model, raw, actions, usage, start }) {
  return {
    kind: 'completion',
    version: '1.0',
    provider,
    model,
    raw,
    actions,
    usage: {
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cacheCreationTokens: usage?.cacheCreationTokens ?? null,
      cacheReadTokens: usage?.cacheReadTokens ?? null,
    },
    elapsedMs: Date.now() - start,
  };
}

// ─── OpenAI-style helpers (shared by openai.js and ollama.js) ─────────────────
//
// Ollama deliberately mirrors the OpenAI chat API, so these two providers share
// request/response shaping. The few real differences are parameterized:
//   - `argsAsString`: OpenAI serializes tool-call args to a JSON string;
//     Ollama keeps them as an object.
//   - `synthId`: Ollama omits tool-call ids, so we synthesize one; OpenAI
//     always supplies an id.

function openaiStyleTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: buildJsonSchema(tool.inputSchema),
    },
  };
}

// Generic messages → OpenAI-style messages. Translates the engine's Anthropic-
// shaped content blocks: assistant `tool_use` blocks become a `tool_calls`
// array, and `tool_result` blocks become standalone role:'tool' messages.
function openaiStyleMessages(system, messages, { argsAsString }) {
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
          const args = block.input || {};
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: argsAsString ? JSON.stringify(args) : args },
          });
        } else if (block.type === 'text') {
          text += block.text || '';
        }
      }
      // OpenAI wants content:null when only tool calls are present; Ollama
      // is happy with an empty string.
      const msg = { role: 'assistant', content: text || (argsAsString ? null : '') };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }

    for (const block of m.content || []) {
      if (block.type === 'tool_result') {
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        const msg = { role: 'tool', content };
        if (block.tool_use_id) msg.tool_call_id = block.tool_use_id;
        out.push(msg);
      } else if (block.type === 'text') {
        out.push({ role: 'user', content: block.text || '' });
      }
    }
  }
  return out;
}

// OpenAI-style tool_calls → Action[].
function parseOpenAIStyleToolCalls(toolCalls, { argsAsString, synthId }) {
  const actions = [];
  const calls = toolCalls || [];
  for (let i = 0; i < calls.length; i++) {
    const tc = calls[i];
    let input = tc.function?.arguments;
    if (argsAsString) { try { input = JSON.parse(input || '{}'); } catch { input = {}; } }
    const { ref, args } = hoistRef(input || {});
    const action = { kind: 'action', verb: tc.function?.name, args };
    if (ref !== undefined) action.ref = ref;
    action.toolUseId = tc.id || (synthId ? synthId(i) : undefined);
    actions.push(action);
  }
  return actions;
}

module.exports = {
  buildJsonSchema,
  hoistRef,
  postJSON,
  buildCompletion,
  openaiStyleTool,
  openaiStyleMessages,
  parseOpenAIStyleToolCalls,
};
