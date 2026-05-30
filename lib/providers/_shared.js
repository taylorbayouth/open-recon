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

// A single LLM call is the most failure-prone step in a run: it can hang, get
// rate-limited (429), or hit a transient 5xx. Without these guards a stalled
// connection would wedge the whole agent loop forever, and a blip would fail an
// otherwise-recoverable run. Defaults are generous so a legitimately slow
// completion isn't cut off; override per provider if needed.
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_RETRIES = 2;            // 3 attempts total

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Backoff before the next attempt. Honor a server-sent Retry-After (seconds)
// when present — the server knows better than we do — else exponential with a
// little jitter so concurrent clients don't retry in lockstep.
function backoffMs(attempt, retryAfter) {
  const ra = Number(retryAfter);
  if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 30000);
  return 500 * 2 ** attempt + Math.floor(Math.random() * 250);   // 500, 1000, 2000 (+jitter)
}

// POST JSON, parse JSON, with a per-attempt timeout and bounded retry. `label`
// prefixes errors so failures are attributable to a provider.
//
// Retries network errors, timeouts, 429, and 5xx; fails fast on other 4xx
// (a bad request won't fix itself). A caller-provided `signal` aborts
// immediately and is never retried — it means "the run is shutting down".
async function postJSON(url, {
  headers = {}, body, signal, label = 'API',
  timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES,
} = {}) {
  const payload = JSON.stringify(body);
  const reqHeaders = { 'Content-Type': 'application/json', ...headers };
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error(`${label} aborted`);

    // Compose the caller's signal (if any) with a per-attempt timeout. Manual
    // AbortController instead of AbortSignal.any/timeout to stay Node-18 safe.
    const ac = new AbortController();
    const onAbort = () => ac.abort(signal.reason);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () => ac.abort(new Error(`${label} request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    try {
      const res = await fetch(url, { method: 'POST', headers: reqHeaders, body: payload, signal: ac.signal });
      if (res.ok) {
        // A misconfigured base URL (a gateway/login HTML page, a captive proxy)
        // can answer 200 with a non-JSON body. Without this guard res.json()
        // throws a bare SyntaxError that reads like an engine bug and burns the
        // retry budget; tag it noRetry and attribute it so it fails fast and clear.
        try { return await res.json(); }
        catch (e) {
          const err = new Error(`${label} returned a non-JSON 200 body (is the endpoint URL correct?): ${e.message}`);
          err.noRetry = true;
          throw err;
        }
      }

      const text = await res.text().catch(() => '');
      const err = new Error(`${label} ${res.status}: ${text}`);
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < retries) {
        lastErr = err;
        await sleep(backoffMs(attempt, res.headers.get('retry-after')));
        continue;
      }
      // A 4xx (or exhausted 5xx) won't fix itself. Tag it so the catch below —
      // which also sees this throw — knows not to treat it as a retryable
      // network error and loop again.
      err.noRetry = true;
      throw err;
    } catch (err) {
      // Don't retry: a caller abort (run shutdown) or an HTTP error we already
      // decided is terminal. Everything else (network error, timeout) retries.
      if (signal?.aborted || err.noRetry) throw err;
      lastErr = err;
      if (attempt < retries) { await sleep(backoffMs(attempt)); continue; }
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr;   // unreachable (loop always returns or throws), but keeps intent explicit
}

// Assemble the Completion artifact uniformly. The caller passes already-
// normalized usage; we backfill the four standard fields with null.
//
// `text` and `refusal` are part of the shared shape so every provider produces
// the same artifact and downstream code (the loop) can rely on them:
//   - text:    the model's natural-language output, if any. Usually empty on a
//              clean tool call, but populated when the model answers in prose
//              instead of (or alongside) calling a tool. The loop surfaces it so
//              an action-less turn shows the model's reasoning, not a blank.
//   - refusal: a provider-native safety refusal, kept separate from `text` so a
//              caller can distinguish "won't" from "didn't".
// Each provider populates these from its own response shape; both default null.
function buildCompletion({ provider, model, raw, actions, usage, start, text = null, refusal = null }) {
  return {
    kind: 'completion',
    version: '1.0',
    provider,
    model,
    raw,
    actions,
    text,
    refusal,
    usage: {
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cacheCreationTokens: usage?.cacheCreationTokens ?? null,
      cacheReadTokens: usage?.cacheReadTokens ?? null,
    },
    elapsedMs: Date.now() - start,
  };
}

// Assemble the VisionResult artifact uniformly — the single-shot "image in,
// prose out" sibling of buildCompletion. Same usage normalization; no actions.
function buildVisionResult({ provider, model, raw, text, usage, start }) {
  return {
    kind: 'vision',
    version: '1.0',
    provider,
    model,
    raw,
    text: text ?? '',
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

// Flat tool shape for the OpenAI Responses API — no nested `function` wrapper.
function responsesStyleTool(tool) {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description ?? '',
    parameters: buildJsonSchema(tool.inputSchema),
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
    if (argsAsString) {
      try { input = JSON.parse(input || '{}'); }
      catch {
        process.stderr.write(`[provider] malformed JSON in tool-call args — defaulting to {}: ${input}\n`);
        input = {};
      }
    }
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
  buildVisionResult,
  openaiStyleTool,
  responsesStyleTool,
  openaiStyleMessages,
  parseOpenAIStyleToolCalls,
};
