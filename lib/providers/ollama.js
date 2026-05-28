'use strict';

// Ollama provider. Local /api/chat + tool calling over native fetch. No API
// key — just a reachable local server and a tool-capable model (llama3.1,
// qwen2.5, mistral-nemo, …) pulled via `ollama pull <model>`.
//
// Shares request/response shaping with openai.js via _shared.js. Ollama's two
// quirks vs OpenAI: tool-call args are objects (not JSON strings), and tool
// calls carry no id (we synthesize one for the loop's history).
//
// See DESIGN.md § Providers.

const {
  postJSON, buildCompletion,
  openaiStyleTool, openaiStyleMessages, parseOpenAIStyleToolCalls,
} = require('./_shared');

const DEFAULT_MODEL = 'llama3.1';
const DEFAULT_HOST = 'http://localhost:11434';

function getBaseURL() {
  // OLLAMA_HOST is the variable the ollama CLI itself uses.
  return (process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || DEFAULT_HOST).replace(/\/$/, '');
}

async function plan(req) {
  const start = Date.now();
  const model = req.model || DEFAULT_MODEL;
  const baseURL = getBaseURL();

  const body = {
    model,
    stream: false,
    messages: openaiStyleMessages(req.system, req.messages || [], { argsAsString: false }),
    tools: (req.tools || []).map(openaiStyleTool),
    options: { temperature: 0 },  // forced deterministic
  };

  const data = await postJSON(`${baseURL}/api/chat`, {
    body,
    signal: req.signal,
    label: 'Ollama API',
  });

  const message = data.message || {};
  return buildCompletion({
    provider: 'ollama',
    model,
    raw: data,
    start,
    actions: parseOpenAIStyleToolCalls(message.tool_calls, {
      argsAsString: false,
      synthId: (i) => `ollama_${Date.now()}_${i}`,
    }),
    usage: {
      inputTokens: data.prompt_eval_count ?? null,
      outputTokens: data.eval_count ?? null,
    },
  });
}

module.exports = { name: 'ollama', defaultModel: DEFAULT_MODEL, plan };
