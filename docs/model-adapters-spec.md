# Model Adapters — Design Spec

**Status:** Implemented (Phases 1–5, 7) · Phase 6 dropped by decision
**Branch:** `claude/model-adapters-package-scope-qpMT5`
**Author:** generated for review, 2026-05-30

> **Implementation note (update):** Phases 1–5 and 7 are built and tested.
> **Phase 6 (config Option B: `providers` + `roles`) was dropped** — the flat
> config (Option A) already supports a separate planner vs. vision model, and the
> valuable half of Option B (a `providers` block owning endpoints/keys) duplicates
> what `.env` already does. Credentials stay in environment variables, where
> secrets belong. The §6 design below is retained for the record but is not
> implemented.

> This is a written design spec, intended to be approved before any implementation.
> It is grounded in the current code (file:line references throughout) and in
> verified provider API behaviour (see the **Verified API Appendix**). `DESIGN.md`
> remains the authoritative architecture doc; this spec proposes an update to its
> provider section (§9 below) rather than competing with it.

---

## 1. Goals & non-goals

### Goals
1. **Formalize the implicit adapter contract** that already exists (`{ name, defaultModel, async plan(req) }` → `Completion`) into a typed, documented interface using **plain JS + `.d.ts` + JSDoc** — no TypeScript build step, no runtime dependency change.
2. **Add a Gemini adapter** (`lib/providers/gemini.js`) covering both planning and vision, since no Gemini provider exists today (registry is `openai`/`anthropic`/`ollama` only — `lib/plan.js:10-14`).
3. **De-duplicate the vision dispatch ladder.** `lib/vision.js:132-165` reimplements per-provider dispatch inline, bypassing `_shared.postJSON`'s retry/backoff. Fold image description into the same adapter abstraction.
4. **Restructure config to Option B (providers + roles)** — credentials/baseUrl declared once under `providers`, with `roles` (planner, vision) referencing them — behind a **back-compat shim** that maps the current flat schema forward with zero breakage.
5. **Close the silent-drop gaps** with capability-aware validation, so e.g. `reasoningEffort` sent to a provider that can't use it surfaces a warning instead of vanishing (`lib/loop.js:413` → ignored by `anthropic`/`ollama`).
6. **Document the caching matrix** across all four providers, including Gemini implicit vs. explicit.

### Non-goals
- No change to loop semantics, executor, or the `Completion` artifact shape (`_shared.js:136-154`) — downstream code keeps working unchanged.
- No streaming, no multi-turn conversation memory changes.
- Not a TypeScript migration. Types are advisory (`.d.ts` + JSDoc), checked optionally via `tsc --checkJs`, never required to run.

---

## 2. Current state (grounded)

| Concern | Today | File:line |
|---|---|---|
| Registry | Static object, string lookup | `lib/plan.js:10-14, 36-41` |
| Contract (implicit) | `{ name, defaultModel, async plan(req) }` | `DESIGN.md:450-499` |
| Request shape | `{ system, tools, messages, model, cacheKey, reasoningEffort, signal, maxTokens }` | `lib/loop.js:407-415` |
| Response shape | `Completion` via `buildCompletion()` | `lib/providers/_shared.js:136-154` |
| Usage fields | `inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens` | `_shared.js:146-151` |
| Vision | Inlined `describeOpenAI/Anthropic/Ollama`, no shared transport | `lib/vision.js:132-165` |
| Config (flat) | `provider, model, reasoningEffort, vision.{provider,model,prompt,maxTokens}` | `lib/config.js:12-84` |
| Env overrides | only `BROWSER_AGENT_PROVIDER`, `_EXECUTOR`, `_CONTEXT` | `lib/config.js:122-127` |
| Tests | fake provider injected into `planMod.providers`; no real-call fixtures | `test/agent.test.js:96-113` |
| Keys | env-only, never logged ✓ | `openai.js:36-40`, `anthropic.js:37-42`, `ollama.js:32-35` |

**Confirmed silent drops:** `reasoningEffort` accepted-then-ignored by anthropic/ollama; `maxTokens` hardcoded `4096` per provider (no call override); temperature force-set.

---

## 3. The adapter contract (JS + `.d.ts` + JSDoc)

A new `lib/providers/types.d.ts` declares the contract; each provider file carries JSDoc `@typedef`/`@implements` references so editors and `tsc --checkJs` enforce it without a build.

```ts
// lib/providers/types.d.ts  (advisory types; ships as-is, never compiled to run)

export interface PlanRequest {
  system: string;
  tools: ToolDef[];
  messages: Message[];
  model: string | null;          // null → adapter.defaultModel
  cacheKey?: string;
  reasoningEffort?: ReasoningEffort | null;
  maxTokens?: number;            // NEW: honored, no longer hardcoded
  signal?: AbortSignal;
}

export interface VisionRequest {
  model: string | null;
  prompt: string;
  imageBase64: string;
  mimeType: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface Capabilities {
  reasoningEffort: boolean;      // OpenAI Responses API only, today
  vision: boolean;
  toolUse: 'native' | 'emulated';
  cache: 'none' | 'automatic' | 'explicit' | 'implicit+explicit';
}

export interface Adapter {
  readonly name: string;
  readonly defaultModel: string;
  readonly defaultVisionModel?: string;
  readonly capabilities: Capabilities;
  plan(req: PlanRequest): Promise<Completion>;
  describe?(req: VisionRequest): Promise<VisionResult>;
}

export interface VisionResult {
  kind: 'vision';
  version: '1.0';
  provider: string;
  model: string;
  text: string;
  usage: Usage;
  elapsedMs: number;
}
```

`Completion`, `Usage`, `ToolDef`, `Message`, `Action`, `ReasoningEffort` are typed to match the **existing** runtime shapes exactly — no behavioural change, just a name for what `buildCompletion()` already returns.

**Runtime guard at the seam.** `plan.js` gains a thin assertion (dev-only, behind a flag) that an adapter has the required keys and that `capabilities` is present — so a malformed adapter fails loudly at registration, not mid-run. Production path stays a plain property read.

---

## 4. File layout & registry

```
lib/providers/
  types.d.ts        NEW  the contract above
  index.js          NEW  self-registering registry (replaces the static map in plan.js)
  _shared.js        ext  + describe-side helpers, error taxonomy, redaction
  openai.js         ext  + capabilities, + describe(), honor maxTokens
  anthropic.js      ext  + capabilities, + describe(), honor maxTokens
  ollama.js         ext  + capabilities, + describe(), honor maxTokens
  gemini.js         NEW  plan() + describe()
```

- `plan.js` keeps its public surface (`plan`, `toolsFromRegistry`, `providers`, `DEFAULT_PROVIDER`) but sources the map from `providers/index.js`. **This preserves `test/agent.test.js:96-113`**, which injects `planMod.providers.fake` — the registry stays a mutable object so the fake-provider test keeps working unchanged.
- Vision stops dispatching by hand: `vision.js` resolves an adapter from the registry and calls `adapter.describe(req)`, reusing `_shared.postJSON` retry/backoff for free.

---

## 5. Gemini adapter

New `lib/providers/gemini.js`, both roles:

- **Endpoint:** `POST {baseUrl}/v1beta/models/{model}:generateContent` (key via `x-goog-api-key` header or `?key=`). Env: `GEMINI_API_KEY`, optional `GEMINI_BASE_URL` (default `https://generativelanguage.googleapis.com`).
- **Request:** `{ systemInstruction, contents:[{role, parts:[…]}], tools:[{functionDeclarations:[…]}], toolConfig:{functionCallingConfig:{mode:'ANY'}}, generationConfig:{maxOutputTokens} }`. `mode:'ANY'` is Gemini's equivalent of the `tool_choice:'required'` the other providers force.
- **Tool schema:** `{ name, description, parameters }` (OpenAPI-subset). Reuses the generic `ToolDef` → maps cleanly.
- **Response:** `candidates[0].content.parts[]` containing `functionCall:{name, args}` (args is an **object**, like Anthropic — no `JSON.parse`) and/or `text`. Map to `Action[]` + `text` via `buildCompletion()`.
- **Vision:** same endpoint, an `inlineData:{mimeType, data:<base64>}` part alongside the text prompt.
- **Usage:** `usageMetadata.{promptTokenCount, candidatesTokenCount, cachedContentTokenCount}` → `inputTokens/outputTokens/cacheReadTokens`.
- **Defaults:** `defaultModel: 'gemini-3.1-pro'`, `defaultVisionModel: 'gemini-3.5-flash'` (verified current — see appendix).
- **Capabilities:** `{ reasoningEffort:false, vision:true, toolUse:'native', cache:'implicit+explicit' }`.

---

## 6. Config — migration to Option B

### Target shape
```jsonc
{
  "providers": {
    "openai":    { "apiKeyEnv": "OPENAI_API_KEY",    "baseUrl": null },
    "anthropic": { "apiKeyEnv": "ANTHROPIC_API_KEY", "baseUrl": null },
    "gemini":    { "apiKeyEnv": "GEMINI_API_KEY",    "baseUrl": null },
    "ollama":    { "baseUrl": "http://localhost:11434" }
  },
  "roles": {
    "planner": { "provider": "openai", "model": "gpt-5.5", "reasoningEffort": "high", "maxTokens": 4096 },
    "vision":  { "provider": "openai", "model": null, "prompt": "Describe…", "maxTokens": 1024 }
  }
}
```
Creds/baseUrl live once under `providers`; each role references a provider by key. A cheap planner can pair with a strong vision model exactly as the current `vision.*` block intends (`config.js:75-84`).

### Back-compat shim (zero breakage)
`config.js` gains `normalizeConfig(raw)` run **before** `deepMerge` against defaults:
- Old flat `provider`/`model`/`reasoningEffort` → `roles.planner.*`.
- Old `vision.{provider,model,prompt,maxTokens}` → `roles.vision.*`.
- `BROWSER_AGENT_PROVIDER` continues to override `roles.planner.provider` (env path at `config.js:122-127` retargeted; behaviour identical).
- If a file already uses `providers`/`roles`, it's passed through untouched.
- The shim is **bidirectional for reads**: internal callers (`loop.js:275-281`, `vision.js:135-139`) get a resolved view, so call sites change minimally.

This means the existing `browser-agent.config.json` (flat, `gpt-5.4-mini`) keeps working with no edit required; migration is opt-in.

---

## 7. Hardening

1. **Capability-aware validation.** Before dispatch, `plan.js` checks `adapter.capabilities` against the request. `reasoningEffort` set on a `reasoningEffort:false` adapter → one-line `stderr` warning (not silent), field stripped. Same for unsupported knobs. Closes the `loop.js:413` silent-drop.
2. **`maxTokens` honored.** Plumb `req.maxTokens` through each provider instead of the hardcoded `4096` (`openai.js:62/130`, `anthropic.js:94`); default preserved when unset.
3. **Error taxonomy.** `_shared.postJSON` already classifies 429/5xx vs 4xx; normalize thrown errors into `{ type: 'auth'|'rate_limit'|'invalid_request'|'server'|'network'|'timeout', provider, status, retriable }` so the loop can react uniformly.
4. **Key redaction.** Keys are already never logged ✓. Add a `redact()` pass on any error/raw body that could echo an `Authorization`/`x-goog-api-key` header, as defense-in-depth before the new error objects get logged.
5. **Strict tool schemas.** Set `additionalProperties:false` / `strict` where each API supports it (OpenAI strict tools, Gemini OpenAPI subset) to cut malformed-arg retries (`_shared.js:248`).
6. **Record/replay fixtures.** Add `test/fixtures/providers/*.json` captured once from real calls; a replay transport lets `gemini.js` and the new `describe()` paths be tested in **keyless CI**, alongside the existing fake-provider unit tests.

---

## 8. Caching matrix (verified — see appendix)

| Provider | Mode | Min tokens | Mechanism | Discount |
|---|---|---|---|---|
| OpenAI | Automatic | 1024 (+128 incr.) | exact prefix match; `prompt_cache_key` hint already sent (`openai.js:142-144`) | ~90% |
| Anthropic | **Explicit** | 1024 (4096 on Opus 4.6/4.7 & Haiku 4.5) | `cache_control:{type:'ephemeral'}`, ≤4 breakpoints, optional `ttl:'1h'`; already on system + last tool (`anthropic.js:62,99`) | ~90% read (1.25× write) |
| Gemini | **Implicit (default) + explicit** | implicit: 1024 (3.5/2.5 Flash) · 4096 (Pro); explicit: varies by model | implicit auto; explicit via `cachedContents` resource referenced by `cachedContent` field, TTL default 1h | ~90% |
| Ollama | KV (local) | n/a | `keep_alive` (`ollama.js:53`) | n/a |

**Recommendation:** Gemini **implicit-first** (no code beyond reusing a stable prompt prefix). Explicit `cachedContents` only if we later pin large static system context. **Live gotcha to design around:** Gemini implicit caching can fail to trigger when `tools` are defined — and the planner always sends tools — so the adapter should (a) order `systemInstruction` + tools as a stable prefix and (b) surface `cachedContentTokenCount` in usage so we can *measure* whether implicit caching is actually hitting rather than assume it.

---

## 9. DESIGN.md update

Replace the provider section (`DESIGN.md:450-499`) with: the formal contract (§3), the registry/self-registration model (§4), Gemini as a first-class provider, the vision-unification note (resolves the deferred "tool-result formatting for non-tool-use providers" item at `DESIGN.md:582` for the native-tool providers), and the caching matrix (§8). The "single source of truth" status is preserved — this spec feeds into it.

---

## 10. Test plan

- **Unit:** extend the fake-provider pattern (`agent.test.js`) with a `fake.describe()` and a `fake.capabilities` to exercise validation + vision routing.
- **Replay:** fixture-driven tests for `gemini.js` plan + describe, and for the refactored `vision.js` adapter path (keyless).
- **Config:** `normalizeConfig` round-trip tests — old flat config and new Option B config both resolve to the same internal view; env override still wins.
- **Regression:** existing `node test/agent.test.js && node test/test.js` must pass untouched (the registry-as-mutable-object guarantee).

---

## 11. Rollout (phased, each independently shippable)

1. `types.d.ts` + JSDoc on existing providers + capabilities (no behaviour change).
2. `providers/index.js` self-registration + dev-only adapter guard (registry stays mutable for tests).
3. `maxTokens` + capability-aware validation (close silent drops).
4. `gemini.js` (plan) + fixtures.
5. Vision unification → `describe()` on every adapter; delete `vision.js` dispatch ladder; gemini vision.
6. Config Option B + back-compat shim.
7. Error taxonomy + redaction + DESIGN.md update + caching doc.

---

## Verified API Appendix (as of 2026-05-30)

Sourced from live docs/searches this session; **flagged** items couldn't be fetched authoritatively and need re-verification at implementation time.

**Current model IDs (training-era defaults are stale):**
- OpenAI: `gpt-5.5`, `gpt-5.2-codex` (current `config.json` pins `gpt-5.4-mini` — still valid family, but `gpt-5.5` is current frontier).
- Anthropic: `claude-opus-4-7`/`-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`.
- Gemini: `gemini-3.1-pro`, `gemini-3.5-flash`, `gemini-3.1-flash-lite`.

**Anthropic caching (authoritative — platform.claude.com):** ≤4 `cache_control:{type:'ephemeral'}` breakpoints; min 1024 tokens (4096 on Opus 4.6/4.7 & Haiku 4.5); `ttl:'1h'` optional; usage exposes `cache_creation_input_tokens`/`cache_read_input_tokens`.

**OpenAI caching (authoritative — developers.openai.com):** automatic, ≥1024 tokens, 128-token increments, no code required, ~90% discount, 5–10 min idle eviction.

**Gemini caching (authoritative — confirmed against the official caching doc):** implicit on by default for 2.5+ (min input: 1024 tokens for 3.5/2.5 Flash, 4096 for Pro); cached-token count returned in `usage_metadata`. Explicit: `POST /v1beta/cachedContents` with `{ model, contents, systemInstruction, ttl, display_name }`, then reference via the `cachedContent` field in `generateContent`. **TTL defaults to 1 hour** if unset; full lifecycle available — list (`GET cachedContents`), update (`PATCH` `ttl`/`expire_time`), delete (`DELETE`). Cached content is billed by token count × storage duration. Explicit minimum input varies by model (no single 4096/32768 threshold — earlier provisional figures retracted). The earlier HTTP 403 on the doc page is resolved: field names above are verified.

**Gemini wire format (authoritative — ai.google.dev):** `generateContent` with `contents[].parts[]`, `tools[].functionDeclarations[]`, response `functionCall:{name,args}` (args is an object).
