# Open Recon — Engine Design

This document captures the architecture, contracts, and conventions for the broader Open Recon engine: the pipeline that goes from a live Chrome tab through an LLM and back to dispatched browser actions. Open Recon's existing extractor (`lib/extract.js`) is one stage in this pipeline; the rest of the engine is what's being built on top of it.

**Status.** This is a working design doc. Decisions here are settled unless explicitly marked deferred. The doc should be updated as the design evolves — it is the single source of truth for cross-module contracts.

---

## Goals

1. **Componentized pipeline.** Each stage is a pure function (or async equivalent) with typed inputs and outputs. Stages communicate via JSON-serializable artifacts. Any stage can be swapped, replayed, logged, cached, or moved to a separate process without touching the others.
2. **Speed as a design constraint.** Caching is not implemented yet, but every interface is shaped so caching can be added later as an additive change — never a refactor. Where a cache will eventually live is marked as a *seam*.
3. **Provider-agnostic LLM layer.** Anthropic, OpenAI, and Ollama are all first-class. The rest of the engine never imports a vendor SDK.
4. **Determinism wherever possible.** Reduced briefs, hashes, and serializations are deterministic so replay, cache, and eval workflows work without bespoke plumbing.

---

## Architecture

```
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ Connect  │──▶│ Extract  │──▶│  Reduce  │──▶│   Plan   │──▶│ Validate │──▶│ Execute  │
│  (CDP)   │   │ (recon)  │   │ (prompt) │   │  (LLM)   │   │ (refs)   │   │  (CDP)   │
└──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘
                    ▲                                                            │
                    └────────── settle() + Observe (re-snapshot) ────────────────┘
```

| Stage | Input | Output | Module | Status |
|---|---|---|---|---|
| Connect | port, target hints | `Session` | [lib/connect.js](lib/connect.js) | exists |
| Extract | `Session`, opts | `Brief` | [lib/extract.js](lib/extract.js) | exists |
| Reduce | `Brief`, history | `LLMView` | `lib/reduce.js` | planned |
| Plan | `LLMView`, goal, tools | `Completion` (→ `Action[]`) | `lib/plan.js` + `lib/providers/*` | planned |
| Validate | `Action[]`, `Brief.lookup` | checked `Action[]` or errors | `lib/validate.js` | planned |
| Execute | `Action[]`, `Session` | `Observation[]` | `lib/execute.js` | planned |
| Loop | task, session | `Run` | `lib/loop.js` | planned |

`lib/actions.js` (registry) and `lib/prompt.js` (system prompt + vocab generation) are shared modules used by multiple stages.

---

## Artifacts

Every artifact is a plain JSON object with `kind` and `version`. Safe to log, persist, diff, replay, or ship across a wire.

### Brief

The output of `extract.js`. Already implemented (`schemaVersion: "2.0"`). One addition: a content-derived `briefHash` field.

```jsonc
{
  "kind": "brief",
  "schemaVersion": "2.0",
  "briefHash": "<sha256 of deterministic content>",
  "url": "...", "title": "...", "timestamp": "...",
  "viewport": { "width": …, "height": …, "scrollX": …, "scrollY": … },
  "elements": [ { "ref": "@e1", "role": "button", "name": "...", "bbox": [...] }, … ],
  "text":     [ { "ref": "@t1", "role": "heading", "name": "...", "level": 2, … }, … ],
  "lookup":   { "@e1": 1276, "@t1": 1419 },
  "stats":    { … }
}
```

`briefHash` is computed over a canonical serialization: sorted refs and their resolved data, viewport, url, title. Timestamps, `elapsedMs`, and other ephemeral fields are excluded. Two semantically-identical pages produce the same hash.

### LLMView

What actually goes into the prompt. No `lookup` (executor-only). Deterministic ordering.

```jsonc
{
  "kind": "llm-view",
  "version": "1.0",
  "briefHash": "<refers back to source Brief>",
  "viewport": { "width": …, "height": … },
  "listing": "[@e1]  button    \"Home\"\n[@e2]  link      \"Jobs\" -> /jobs\n…"
}
```

The `listing` is a compact, fixed-width-ish text format optimized for LLM tokenization and grep-ability. Refs are bracketed (`[@e1]`) to keep them visually distinct from text content. Text nodes may or may not appear in the listing depending on `Reduce` configuration; if they do, they use `[@t<n>]`.

### Action

One verb the LLM wants executed.

```jsonc
{
  "kind": "action",
  "verb": "type",
  "ref": "@e3",                  // omitted for ref-less verbs
  "args": { "text": "hello" }
}
```

### Completion

What a provider returned. First-class artifact — captures raw provider output for debugging, replay, and eval workflows.

```jsonc
{
  "kind": "completion",
  "version": "1.0",
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "briefHash": "...",
  "raw": { /* provider's native response, unmodified */ },
  "actions": [ /* parsed Action[] */ ],
  "usage": {
    "inputTokens": …, "outputTokens": …,
    "cacheCreationTokens": …, "cacheReadTokens": …
  },
  "elapsedMs": …
}
```

Loop persists every Completion as part of the Run.

### Observation

Outcome of one executed Action.

```jsonc
{
  "kind": "observation",
  "verb": "click",
  "ref": "@e3",
  "status": "ok",                // "ok" | "error"
  "error": null,                  // string when status === "error"
  "elapsedMs": 42,
  "settleMs": 180                 // ms spent settling after dispatch
}
```

### Step

One paired (Action, Observation). Forms the canonical history unit.

```jsonc
{ "kind": "step", "action": { … }, "observation": { … } }
```

### Run

The top-level artifact. Loop builds this incrementally and emits it on exit. This is the persistable / replayable unit.

```jsonc
{
  "kind": "run",
  "version": "1.0",
  "id": "<uuid>",
  "task": "<the original goal>",
  "model": "claude-opus-4-7",
  "startedAt": "...", "endedAt": "...",
  "status": "completed" | "failed" | "max-steps" | "aborted",
  "result": "...",                // from `done` action if status=completed
  "steps":       [ /* Step[] */ ],
  "completions": [ /* Completion[] */ ],
  "briefs":      [ /* Brief[] in temporal order, optional */ ],
  "stats": {
    "stepCount": …, "totalElapsedMs": …,
    "totalInputTokens": …, "totalOutputTokens": …
  }
}
```

Briefs are large; including them is optional and controlled by a verbosity flag on Loop. By default Loop keeps only the most recent Brief in memory and discards earlier ones.

---

## Action registry (`lib/actions.js`)

The single source of truth for every verb. Validator, Executor, and Prompt all read from this registry.

```js
module.exports = {
  click:    { requiresRef: true,  refType: ['e'],       args: {} },
  focus:    { requiresRef: true,  refType: ['e'],       args: {} },
  type:     { requiresRef: true,  refType: ['e'],       args: { text: 'string' } },
  press:    { requiresRef: false,                       args: { key: 'string' } },
  scroll:   { requiresRef: false,                       args: { direction: 'string', amount: 'number?' } },
  navigate: { requiresRef: false,                       args: { url: 'string' } },
  wait:     { requiresRef: false,                       args: { ms: 'number' } },
  done:     { requiresRef: false,                       args: { result: 'string?' } },
};
```

Rules:

- `refType` is always an array, even when it contains only `['e']`. Adding a verb that targets `@t` later is non-breaking.
- `args` declares argument names and types as compact strings. Trailing `?` means optional. The validator interprets this — no separate schema file.
- Adding a verb is one entry. The system prompt's vocab section, the validator's argument check, and the executor's dispatch table are all derived from this registry.

### Verb contracts

| Verb | Effect | Notes |
|---|---|---|
| `click` | Mouse click at the resolved element's coordinates | Uses `Input.dispatchMouseEvent` (not `DOM.focus + click` — more reliable on custom widgets). |
| `focus` | Focus the element | Useful before `type` on inputs that need explicit focus. |
| `type` | Type the literal string into the element | Focuses first, then dispatches per-character `Input.dispatchKeyEvent`. |
| `press` | Send a single key (Enter, Tab, Escape, ArrowDown, …) | Top-level — does not target a ref. Useful for form submission. |
| `scroll` | Scroll the page | `direction: "up"|"down"`, optional `amount` in CSS pixels (default: one viewport). |
| `navigate` | Load a new URL | Causes a full re-snapshot; refs from prior briefs are invalidated. |
| `wait` | Sleep for `ms` milliseconds | For *deliberate* pauses only. Universal settle still runs after every verb — `wait` is not the settle mechanism. |
| `done` | Signal task completion | Loop captures the optional `result` string and exits with status `completed`. |

### `done` semantics

The LLM marks task completion by emitting `{ verb: "done", args: { result: "…" } }`. Loop captures the result and exits without re-snapshotting. `done` does *not* count toward step budget exhaustion (it always terminates cleanly).

---

## Settle contract

The biggest hidden risk in any browser-agent loop is snapshotting mid-transition: a click fires, the DOM mutates, async work runs, and a brief taken immediately after captures a half-rendered page. The LLM gets garbage on the next turn.

**Decision: settle is mandatory infrastructure, not an LLM responsibility.**

### Implementation

Add `session.settle(opts)` as a primitive on the Session object. It returns when the page is judged stable.

Settle waits for the **first** of:

1. `Page.lifecycleEvent` reporting `networkAlmostIdle` or `load` (if a navigation happened);
2. An AX-tree-quiet check — poll `Accessibility.getFullAXTree` briefly and confirm no structural changes for ~150ms;
3. A hard cap (~2000ms, configurable) to avoid hanging on infinite spinners.

```js
await session.settle({ quietMs: 150, maxMs: 2000 });
```

Execute calls `settle()` after every dispatched action, before constructing the Observation. `settle.elapsedMs` is recorded on the Observation as `settleMs` so we can tune the defaults from real data.

The LLM verb `wait` is *not* the settle mechanism — it's for deliberate pauses (animation, debouncing, throttled UI). Universal settle still runs after every `wait`.

---

## Loop semantics

Loop is the only stateful module. Everything else is pure.

### The loop body

```
1. snapshot  = extract(session)
2. llmView   = reduce(snapshot, history)
3. completion = plan({ system, tools, messages: [ ...history, llmView ], provider, model })
4. actions   = validate(completion.actions, snapshot.lookup, registry)
5. for each action:
     observation = execute(action, session)   // settles internally
     steps.push({ action, observation })
     if action.verb === "done" → exit "completed"
6. goto 1
```

### Message conversion

Loop is responsible for converting each Step into messages for the next Plan call. The provider-agnostic message shape:

```js
[
  { role: "system",    content: "<system prompt>" },     // sent once, cacheable
  { role: "user",      content: "<task description>" },
  { role: "assistant", content: [ { type: "tool_use", name: "click", input: {...} } ] },
  { role: "user",      content: [ { type: "tool_result", content: "ok" } ] },
  // … repeats per step …
  { role: "user",      content: "<latest LLMView listing>" },
]
```

Providers translate this generic shape into their native API. The shape supports tool-use natively (Anthropic) but degrades cleanly to text-based protocols (Ollama) inside each provider adapter.

### Failure handling

- A failed Observation is included in history exactly like a successful one. The LLM sees the error and decides what to do next. **Loop never retries automatically.**
- Validate failures (LLM emitted a ref not in lookup, an unknown verb, malformed args) feed the error string back into the next turn's message history the same way. The LLM gets a chance to correct.
- Infrastructure errors (lost CDP connection, provider returned non-JSON, settle timed out 3x in a row) abort with status `failed`.

### Abort conditions

| Condition | Status |
|---|---|
| `done` verb emitted | `completed` |
| Step count exceeds `maxSteps` (default: 30) | `max-steps` |
| Infrastructure error or unrecoverable exception | `failed` |
| External cancel (`AbortSignal`) | `aborted` |

---

## Providers

### Interface

Every provider exports the same shape:

```js
module.exports = {
  name: 'anthropic',                 // 'openai' | 'ollama'
  defaultModel: 'claude-opus-4-7',
  /**
   * @param {{
   *   system: string,
   *   tools: object[],               // generic tool definitions
   *   messages: object[],            // generic message shape (see Loop)
   *   model?: string,
   *   signal?: AbortSignal
   * }} req
   * @returns {Promise<Completion>}   // returns full Completion artifact
   */
  async plan(req) { … }
};
```

`plan.js` is a thin facade that picks a provider by name and forwards the call. It does no translation — that's the provider's job.

### Tool definitions

Generated once per Run from `actions.js`:

```js
{ name: "click", description: "...", inputSchema: { ref: "string" } }
{ name: "type",  description: "...", inputSchema: { ref: "string", text: "string" } }
…
```

Each provider's `plan()` translates these generic tool defs into its native format (Anthropic tool_use, OpenAI function calling, Ollama prompt-embedded). The rest of the engine doesn't care.

---

## Prompt construction

`lib/prompt.js` owns the system prompt. The English template (behavior, constraints, output format hints) is in `prompt.js`. The available-actions section is **auto-generated from `actions.js`** so it can never drift from the registry.

```js
const prompt = require('./prompt');
const actions = require('./actions');

const system = prompt.buildSystemPrompt(actions);
// → "You are a browser agent. Available actions: …"
```

The system prompt is built once per Run, kept in `Run.system` (optional, for debugging), and sent as the first message of every Plan call.

---

## Caching seams (not implemented yet)

Caching is deferred. These are the named seams where it will land:

| Seam | Where | What gets cached |
|---|---|---|
| Anthropic prompt cache | `providers/anthropic.js` | System prompt + tool defs + (optionally) early steps. Marked with `cache_control: { type: "ephemeral" }`. Requires deterministic Reduce output. |
| Brief diff | `loop.js` | `briefHash` comparison: if a new Brief has the same hash as the previous one, optionally skip the Plan call entirely. |
| Element resolution | `lib/execute.js` | `backendNodeId → nodeId` (from `DOM.requestNode`). Lifetime: one Brief. Invalidated on re-snapshot. |
| LLMView | `reduce.js` | `briefHash → LLMView` map. Trivial — Reduce is pure. |

None of these are implemented in the first slice. The interfaces are shaped so that adding them is additive: a new module wrapping an existing call, never a refactor of the call site.

---

## Build sequence

### Slice 1 — vertical, minimal, anthropic-only

Three verbs, happy path, one provider. Goal: get a real brief through a real LLM and dispatch real actions back to a real Chrome tab. No retries, no `text` in the listing, no observability beyond `console.error`.

1. `actions.js` — `click`, `type`, `done` only.
2. `prompt.js` — system prompt template + vocab generator.
3. `reduce.js` — deterministic listing of `elements` only.
4. `providers/anthropic.js` + `plan.js` — tool-use mode, no caching yet.
5. `validate.js` — regex, lookup membership, refType, args shape.
6. `session.settle()` + `execute.js` — universal settle; dispatch three verbs via CDP.
7. `loop.js` — orchestrator, message conversion, Run construction, max-steps guard.
8. Smoke test: a real task against a real page (e.g., "search for X on LinkedIn").

### Slice 2 (after slice 1 runs end-to-end)

- Remaining verbs: `focus`, `press`, `scroll`, `navigate`, `wait`.
- `text` in LLMView (optional; controlled by Reduce flag).
- `briefHash` computed and threaded through artifacts.
- Persistence: write Run as JSON to a configurable directory.
- Additional providers: `openai.js`, `ollama.js`.

### Slice 3+

- Caching seams activated (in order of impact: Anthropic prompt cache → brief diff → element resolution → LLMView).
- Eval harness: replay a saved Run against a different model.
- Multi-tab support (deferred; needs a real use case first).

---

## Open / deferred decisions

These are noted here so they don't get forgotten, but they don't block slice 1.

- **History truncation policy.** When does Loop summarize or drop old Steps? Defer until a real task overflows.
- **Tool-result formatting for non-tool-use providers.** Ollama and older OpenAI models don't have native tool use. The provider adapter must serialize tool calls as text. Decide per-provider when those providers land.
- **Concurrency.** First version dispatches one action per turn. The Action shape supports arrays so batched actions can be added later, but the loop body is serial.
- **Screenshot in LLMView.** Open Recon's brief is text-only by design. Adding a screenshot would change the contract and the prompt-cache strategy. Defer until there's evidence the LLM needs visual context.
- **Goal/task input shape.** Free-form string for slice 1. Structured (sub-goals, constraints) later if needed.
- **Multi-frame / iframe handling.** Extract currently flattens. Same in execute. Real iframe support is a larger change — defer.

---

## Glossary

- **Brief** — the snapshot artifact emitted by `extract.js`. Contains elements, text, lookup, viewport.
- **Ref** — a short opaque string identifying an element or text node in a Brief, of the form `@e<n>` or `@t<n>`. See [README.md § Reference convention](README.md).
- **LLMView** — the prompt-ready, deterministic, text-formatted representation of a Brief. No `lookup`.
- **Step** — one `(Action, Observation)` pair.
- **Run** — the top-level artifact representing one task execution: task string, steps, completions, status.
- **Settle** — the wait-for-page-stable primitive on Session, called after every executed action.
- **Seam** — a named interface where a future cache, log, or replacement implementation can be added without refactoring callers.
