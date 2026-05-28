'use strict';

// Ollama provider. Translates the engine's generic { system, tools, messages }
// shape into a local Ollama /api/chat call with tool calling, then parses
// tool_calls back into Action[]. Returns a Completion artifact.
//
// Implemented with native fetch — Ollama is a local HTTP server, no SDK or API
// key needed. Tool calling requires a tool-capable model (llama3.1, qwen2.5,
// mistral-nemo, …) pulled locally via `ollama pull <model>`.
//
// Ollama's chat API deliberately mirrors OpenAI's, with two differences we
// handle below:
//   - tool-call arguments arrive as an *object*, not a JSON string.
//   - tool calls have no id, so we synthesize one for the engine's history.
//
// See DESIGN.md § Providers.

const DEFAULT_MODEL = 'llama3.1';
const DEFAULT_HOST = 'http://localhost:11434';

function getBaseURL() {
  // OLLAMA_HOST is the variable the ollama CLI itself uses.
  return (process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || DEFAULT_HOST).replace(/\/$/, '');
}

// Convert generic tool defs → Ollama tool format (same as OpenAI).
function toOllamaTool(tool) {
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

// Convert generic messages → Ollama messages. Like OpenAI: assistant tool
// calls go in a `tool_calls` array, tool results become role:'tool' messages.
// Ollama wants tool-call arguments as an object (not a JSON string).
function toOllamaMessages(system, messages) {
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
          toolCalls.push({ function: { name: block.name, arguments: block.input || {} } });
        } else if (block.type === 'text') {
          text += block.text || '';
        }
      }
      const msg = { role: 'assistant', content: text };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }

    for (const block of m.content || []) {
      if (block.type === 'tool_result') {
        out.push({
          role: 'tool',
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        });
      } else if (block.type === 'text') {
        out.push({ role: 'user', content: block.text || '' });
      }
    }
  }
  return out;
}

// Parse Ollama's message.tool_calls into Action[]. Arguments are already an
// object. Ollama omits a tool-call id, so we synthesize a stable one (the loop
// needs it to pair the eventual tool_result).
function parseActions(message) {
  const actions = [];
  const calls = message?.tool_calls || [];
  for (let i = 0; i < calls.length; i++) {
    const tc = calls[i];
    const input = tc.function?.arguments || {};
    const action = { kind: 'action', verb: tc.function?.name, args: {} };
    for (const [k, v] of Object.entries(input)) {
      if (k === 'ref') action.ref = v;
      else action.args[k] = v;
    }
    action.toolUseId = `ollama_${Date.now()}_${i}`;
    actions.push(action);
  }
  return actions;
}

async function plan(req) {
  const start = Date.now();
  const model = req.model || DEFAULT_MODEL;
  const baseURL = getBaseURL();

  const body = {
    model,
    stream: false,
    messages: toOllamaMessages(req.system, req.messages || []),
    tools: (req.tools || []).map(toOllamaTool),
    options: { temperature: 0 },  // forced deterministic
  };

  const res = await fetch(`${baseURL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama API ${res.status}: ${text}`);
  }

  const data = await res.json();
  const message = data.message || {};

  return {
    kind: 'completion',
    version: '1.0',
    provider: 'ollama',
    model,
    raw: data,
    actions: parseActions(message),
    usage: {
      inputTokens: data.prompt_eval_count ?? null,
      outputTokens: data.eval_count ?? null,
      cacheCreationTokens: null,
      cacheReadTokens: null,
    },
    elapsedMs: Date.now() - start,
  };
}

module.exports = {
  name: 'ollama',
  defaultModel: DEFAULT_MODEL,
  plan,
};
