# Open Recon

**A stealth browser-control engine for LLM agents.**

Open Recon connects to a real Chrome tab, extracts what's on screen as structured JSON, hands it to an LLM, and dispatches the LLM's actions back to Chrome — optionally driving the actual macOS mouse cursor and keyboard so the page sees real OS-level input.

Two design choices set it apart from typical browser-automation stacks:

- **Perception with zero in-page footprint.** Element extraction uses Chrome's internal DevTools APIs (`Accessibility.getFullAXTree`, `DOMSnapshot.captureSnapshot`) — no scripts are injected into the page, no DOM is mutated. The page cannot observe that it's being inspected.
- **Action via real input events.** A small Swift helper (`recon-input`) posts `CGEvent`s to the macOS HID pipeline, so in-page JavaScript sees `isTrusted: true` events with humanlike Bezier motion and randomized keystroke timing. The same kernel path a real mouse and keyboard travel.

Together: no script-injection fingerprint going in, no synthetic-input fingerprint going out.

> **Status: early.** The pipeline runs end-to-end (`agent.js` is a working smoke test against a live tab), but this is week-one code. Expect rough edges around iframes, multi-monitor setups, and pages with aggressive layout shifts. Issues and PRs welcome.

---

## Architecture

```
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ Connect  │──▶│ Extract  │──▶│  Reduce  │──▶│   Plan   │──▶│ Validate │──▶│ Execute  │
│  (CDP)   │   │ (recon)  │   │ (prompt) │   │  (LLM)   │   │ (refs)   │   │ (cdp|os) │
└──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘
                    ▲                                                            │
                    └────────── settle() + Observe (re-snapshot) ────────────────┘
```

Each stage is a pure function (or async equivalent) with a typed input and output. See [`DESIGN.md`](DESIGN.md) for the full contract.

You can use Open Recon in three modes:

1. **As a perception library.** `node cli.js --pretty` (or the `extract` API) prints the page snapshot. No LLM, no agent loop. Useful as the eyes for any custom automation.
2. **As an agent runner.** `node agent.js "<task>"` hands the snapshot to the configured LLM and dispatches the actions it returns, looping until done.
3. **As an engine.** `require('open-recon')` and wire your own loop, provider, or executor.

---

## Two execution backends

The `Execute` stage is pluggable. Choose per-run via config:

| Backend | When to use | Detectability |
|---|---|---|
| `cdp`  | CI, headless tests, Linux dev, quick iteration. Zero install, zero permissions. | **Higher.** CDP-synthesized events skip the HID layer, motion is teleported, timing is uniformly tight — modern bot-detection vendors (Akamai, DataDome, Kasada, Cloudflare Bot Management) fingerprint this even though `event.isTrusted === true`. |
| `os` (macOS) | Production runs against real sites. Requires the Swift helper to be built once and Accessibility permission granted. | **Lower.** `CGEventPost` travels the same kernel input pipeline as a real mouse/keyboard. Humanlike Bezier mouse motion, randomized per-keystroke delays, and small per-click jitter mean the input trace looks like a human's. |

Default is `cdp` so tests stay trivial. Production should set `--executor os` or `OPEN_RECON_EXECUTOR=os`.

---

## Requirements

- **Node.js** ≥ 18
- **Google Chrome** (stable channel)
- **macOS** — required for the `os` executor and active-tab detection. The `cdp` executor and the extractor itself run on Linux too.
- **Xcode command-line tools** (`xcode-select --install`) — only if you build the `os` executor.

---

## Install

```bash
git clone https://github.com/taylorbayouth/open-recon.git
cd open-recon
npm install
```

For the `os` executor, also:

```bash
bash native/macos/recon-input/build.sh
```

This compiles `native/macos/recon-input/main.swift` into a single binary at `native/macos/recon-input/bin/recon-input`. The binary is git-ignored — per-platform, build locally.

---

## Quickstart

### As a perception library

```bash
npm run launch                                # starts Chrome on port 9222
# navigate Chrome to any page
npm run extract                               # tree snapshot
node cli.js --lean --in-viewport-only --pretty # flat snapshot
```

```
$ node cli.js --lean --in-viewport-only --pretty --verbose
Connecting to Chrome on port 9222...
Attached to: Feed | LinkedIn (https://www.linkedin.com/feed/)
Done. 23 elements in 373ms
```

```json
{
  "schemaVersion": "2.0",
  "url": "https://www.linkedin.com/feed/",
  "title": "Feed | LinkedIn",
  "timestamp": "2026-05-28T00:15:27.016Z",
  "viewport": { "width": 1200, "height": 840, "scrollX": 0, "scrollY": 0 },
  "elements": [
    {
      "ref": "@e1",
      "role": "button",
      "name": "LinkedIn",
      "bbox": { "x": 72, "y": 18, "width": 68, "height": 68 },
      "inViewport": true
    }
  ],
  "text": [
    {
      "ref": "@t1",
      "role": "heading",
      "name": "Taylor's Feed",
      "bbox": { "x": 140, "y": 24, "width": 220, "height": 32 },
      "inViewport": true,
      "level": 1
    }
  ],
  "lookup": { "@e1": 1276, "@t1": 1419 },
  "stats": {
    "totalAXNodes": 2443, "interactiveFound": 208, "textFound": 293,
    "withBounds": 208, "inViewport": 23, "returned": 23, "elapsedMs": 373
  }
}
```

### As an agent

One command does everything. It runs preflight — installs deps if missing,
builds the `os` driver and checks Accessibility permission when that backend is
selected, verifies your provider key, and launches Chrome if it isn't already
running — then runs your task. Re-running is safe; satisfied steps are skipped.

```bash
export OPENAI_API_KEY=sk-...
node agent.js "search for hello world"                   # openai + cdp (defaults)
node agent.js --executor os "post 'hello' on twitter"    # os backend
node agent.js --provider anthropic "..."                 # different LLM
node agent.js --no-preflight "..."                       # skip checks (CI)
```

Just navigate the launched Chrome tab to the page your task expects. The manual
`npm run launch` and `build.sh` steps above are only needed when using the
extractor on its own — the agent entry point handles them for you.

---

## Configuration

All knobs live in `open-recon.config.json` at the repo root. CLI flags override the file; env vars sit in between. Precedence: built-in defaults → `open-recon.config.json` → env → CLI flags.

```jsonc
{
  "provider": "openai",          // openai | anthropic | ollama
  "model": null,                  // null → provider's own default

  "loop": {
    "maxSteps": 30,
    "shortCircuitOnNoChange": true, // skip the LLM call while the page is unchanged
    "pollMs": 1500,               // wait between re-checks while unchanged
    "maxNoChangePolls": 10        // give up waiting after this many polls
  },

  "settle": { "afterActionMs": 150, "maxMs": 2000 },

  "view": {                       // how the page is rendered for the LLM
    "includeText": true,          // interleave headings/labels/prose as @t lines
    "includeCoords": true,        // append a compact (x,y) per line
    "maxTextChars": 200,          // truncate long text
    "dedupeText": true            // collapse consecutive identical text
  },

  "executor": {
    "backend": "cdp",             // cdp | os
    "binPath": null,
    "humanize": { "enabled": true, "mouseSpeedPxPerSec": 1400, "mouseJitterPx": 2,
                  "keystrokeDelayMsMin": 25, "keystrokeDelayMsMax": 85,
                  "preClickPauseMsMin": 40, "preClickPauseMsMax": 160 }
  }
}
```

Point `OPEN_RECON_CONFIG` at a different path to use an alternate file.

### No-change short-circuit

Each turn, the loop hashes the page (content only — `timestamp`, `bbox`, and `stats` are excluded) and compares it to what the model last acted on. If nothing changed, it **doesn't burn an LLM call** — it waits `loop.pollMs` and re-checks, repeating until the page changes (proceed immediately) or `loop.maxNoChangePolls` is hit (proceed anyway). This is how the agent waits out a slow page load without a fixed timer, and avoids paying for identical turns. Disable with `--no-short-circuit`.

---

## LLM providers

The `Plan` stage is provider-agnostic. Three are built in; pick per-run with `--provider` or the `OPEN_RECON_PROVIDER` env var.

| Provider | Default model | Credentials | Notes |
|---|---|---|---|
| `openai` (default) | `gpt-5.4-mini` | `OPENAI_API_KEY` | Native `fetch`, no SDK. Set `OPENAI_BASE_URL` to target a compatible gateway. |
| `anthropic` | `claude-opus-4-7` | `ANTHROPIC_API_KEY` | Native `fetch`, no SDK. Set `ANTHROPIC_BASE_URL` to target a compatible gateway. |
| `ollama` | `llama3.1` | none | Local server (`OLLAMA_HOST`, default `http://localhost:11434`). Needs a tool-capable model pulled locally. |

All three translate the engine's generic message/tool shape into their native format and return the same `Completion` artifact, so the agent loop never changes. Anthropic and Ollama force `temperature: 0`; OpenAI omits the field because the default mini model rejects a non-default temperature.

---

## How perception works

Open Recon connects to Chrome over the [DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) on the remote debugging port and fires three calls in parallel:

1. **`Accessibility.getFullAXTree`** — the browser's own accessibility tree. Provides roles, names, ARIA state, and `backendNodeId` references for every element.
2. **`DOMSnapshot.captureSnapshot`** — a layout snapshot mapping `backendNodeId` → bounding box and computed CSS, with no JavaScript evaluated in the page.
3. **`Page.getLayoutMetrics`** — viewport dimensions and scroll position.

It then correlates the AX tree with the layout snapshot to attach pixel coordinates and styles, filters to interactive elements and text, and emits the result as JSON.

**No scripts are evaluated in the page context.** The entire extraction runs through Chrome's internal DevTools APIs, which are not observable from the page itself.

---

## How action works

The agent loop produces a stream of `Action`s — `click(@e3)`, `type(@e7, "hello")`, `done`. The Execute stage routes each to the configured backend:

**CDP backend:** dispatches via `Input.dispatchMouseEvent` and `Input.insertText`. Targets the geometric center of the element's bbox in page coordinates. Fast, dependency-free, headless-friendly — but synthetic.

**OS backend (macOS):** computes the same bbox-center target, jitters it slightly (±~4px max) so successive clicks don't land on identical pixels, then translates page coordinates → screen coordinates using `Browser.getWindowBounds` + `Page.getLayoutMetrics`. The screen point is handed to `recon-input` (the Swift helper), which moves the actual mouse cursor along a randomized cubic Bezier path and posts a `CGEvent` mouse click. Typing goes through `keyboardSetUnicodeString` with a randomized per-character delay.

See `lib/executors/os.js` for the full pixel-to-screen math, and `native/macos/recon-input/main.swift` for the Bezier motion.

---

## CLI

### Extractor (`node cli.js` or `open-recon`)

| Flag | Description |
|---|---|
| `--tree` | Emit a hierarchical tree of containers, interactive elements, and text leaves. Uses compact array bboxes. |
| `--pretty` | Pretty-print JSON output (2-space indent). Default: minified. |
| `--in-viewport-only` | Only include elements that intersect the current viewport. |
| `--lean` | Compact output: drops null/empty fields, strips CSS-hidden elements (`visibility:hidden`, `opacity:0`, `pointer-events:none`, `display:none`), and omits `computedStyle`. Ideal for LLM context windows. |
| `--verbose` | Print connection and completion logs to stderr. |
| `--launch` | Launch Chrome with remote debugging and exit. |

Extractor JSON always goes to stdout. Progress logs are only emitted with
`--verbose`, so output can be piped safely.

### Agent (`node agent.js`)

| Flag | Description |
|---|---|
| `--task <string>`, positional | The task for the agent (required). |
| `--max-steps <n>` | Max loop iterations (default: 30). |
| `--model <id>` | Override the default model. |
| `--verbose`, `-v` | Log each loop turn to stderr. |
| `--executor <cdp\|os>` | Input backend. Default: env `OPEN_RECON_EXECUTOR` or `cdp`. |
| `--no-humanize` | Disable Bezier motion / keystroke delays (`os` only). |
| `--mouse-speed <px/s>` | Cursor travel speed. Default: 1400. |
| `--mouse-jitter <px>` | Max ± per-frame deviation from the Bezier path. Default: 2. |
| `--keystroke-delay <lo[,hi]>` | Per-character delay range, ms. Default: 25,85. |

---

## Output schema

Flat modes (`full` and `--lean`) return `elements` and `text` arrays:

```
{
  schemaVersion: "2.0"
  url:       string          — URL of the captured tab
  title:     string          — page title
  timestamp: string          — ISO 8601 capture time
  viewport:  {
    width:   number          — CSS pixels
    height:  number
    scrollX: number          — horizontal scroll offset
    scrollY: number          — vertical scroll offset
  }
  elements:  Element[]       — interactive elements (see below)
  text:      TextNode[]      — text nodes
  lookup:    { [ref]: number } — maps each `ref` to its CDP backendNodeId
  stats:     Stats
}
```

Tree mode (`--tree`) returns a hierarchy instead:

```
{
  schemaVersion: "2.0"
  url:       string
  title:     string
  timestamp: string
  viewport:  { width, height, scrollX, scrollY }
  tree:      TreeNode|null
  lookup:    { [ref]: number }
  stats: {
    totalAXNodes:        number
    interactiveReturned: number
    textReturned:        number
    elapsedMs:           number
  }
}
```

Tree mode and lean mode filter CSS-hidden, transparent, pointer-events-none, and
zero-area interactive elements. Full flat mode keeps those records when Chrome
exposes them in the accessibility tree and layout snapshot.

### Reference convention

Every interactive element and text node gets a stable string `ref` of the form `@<type><n>`:

- `@` prefix marks the string as a reference, so it can't be confused with numbers on the page.
- `<type>` is one lowercase letter: `e` for interactive element, `t` for text node.
- `<n>` is a positive integer, assigned in document order. Elements and text use independent counters — `@e1` and `@t1` can coexist.

Regex: `/^@[et]\d+$/`.

Refs are **scoped to a single snapshot**. A new extraction reassigns everything — never cache a ref across snapshots, and never act on a ref from an earlier brief. After any action that may have changed the page (click, navigation, scroll, keypress), re-snapshot before deciding what to do next. The `lookup` table maps each ref to a live CDP `backendNodeId` for the current session; executors should treat refs as opaque strings and resolve via `lookup`.

**Action targets:** `@e` refs are the only valid targets for action verbs (click, focus, type, …). `@t` refs are grounding context — the LLM may reference them in prose ("the heading @t3 says X") but should not emit `click(@t3)`. The validator rejects `@t` refs in target-bearing actions.

### Element

```
{
  ref:           string        — "@e<n>" — see Reference convention
  role:          string        — ARIA role (button, link, textbox, …)
  name:          string|null   — accessible name
  bbox:          Bbox|null     — { x, y, width, height } in page coordinates
  inViewport:    boolean

  // full mode only (omitted in --lean):
  source:        "role"|"focusable"
  focusable:     boolean|null
  computedStyle: { cursor, display, visibility, opacity, pointer-events,
                   position, z-index, background-color, color,
                   font-size, font-weight, border-radius, overflow }

  // present when applicable:
  value:         string        — current value of inputs, selects, etc.
  url:           string        — href for links
  checked:       boolean
  selected:      boolean
  expanded:      boolean
  disabled:      boolean
}
```

### TextNode

```
{
  ref:           string        — "@t<n>" — see Reference convention
  role:          string        — heading, paragraph, StaticText, label, …
  name:          string        — text content
  bbox:          Bbox|null
  inViewport:    boolean
  level:         number        — heading level (h1=1…h6=6), if applicable
}
```

### Stats

```
{
  totalAXNodes:    number   — total nodes in the AX tree
  interactiveFound:number   — nodes matching interactive roles/focusable
  textFound:       number   — nodes matching text roles with non-empty names
  withBounds:      number   — interactive nodes that have layout bounds
  inViewport:      number   — interactive nodes in the viewport
  returned:        number   — nodes in the final output (after filters)
  elapsedMs:       number   — total wall time in milliseconds
}
```

### Interactive roles captured

`button` `link` `textbox` `combobox` `checkbox` `radio` `menuitem` `menuitemcheckbox` `menuitemradio` `tab` `searchbox` `slider` `spinbutton` `switch` `treeitem` `option` `columnheader` `rowheader`

**Custom widgets** (e.g. `<div tabindex="0">`) are also included when an element is focusable but has no semantic role (`generic`, `none`, `presentation`).

### Text roles captured

`heading` `paragraph` `StaticText` `label` `caption` `listitem` `term` `definition` `blockquote` `code`

Sub-runs (`InlineTextBox`, `LineBreak`) are intentionally excluded — they're fragments of `StaticText` nodes and would inflate output without adding information.

---

## Using the brief with your own LLM

In `--lean --in-viewport-only` mode, a typical page compresses to a few thousand tokens — small enough to fit alongside system prompts and tool definitions.

The agent loop renders the brief via `reduce()` into a reading-order listing that interleaves interactive elements and text context, e.g.:

```
[@t1]  heading     "Sign in to Acme"     (390,118)
[@t2]  label       "Email"               (270,168)
[@e1]  textbox     "Email"               (390,196)
[@t3]  label       "Password"            (280,228)
[@e2]  textbox     "Password"            (390,256)
[@e3]  link        "Forgot password?"  -> /reset  (310,295)
[@e4]  button      "Sign in"             (300,350)
```

`[@e…]` are action targets; `[@t…]` are read-only context the model can cite but not act on (the validator enforces this). The `(x,y)` suffixes let the model disambiguate repeated controls. Toggle text, coordinates, truncation, and dedupe under the `view` block in `open-recon.config.json`.

Each element and text node carries a short `ref` string (`@e1`, `@t1`, …) that the LLM can reference in actions. The snapshot's `lookup` table resolves each ref to a CDP `backendNodeId` for the same session:

```js
// LLM says: { action: "focus", ref: "@e3" }
const backendNodeId = snapshot.lookup[ref];               // e.g. 144
const { nodeId } = await DOM.requestNode({ backendNodeId });
await DOM.focus({ nodeId });
// or use Input.dispatchMouseEvent with the element's bbox coordinates
```

Refs are reassigned on every snapshot, so pair each LLM action with the snapshot it was derived from. Treat refs as opaque strings — validate against `/^@[et]\d+$/` and look them up rather than parsing.

---

## Launching Chrome

If Chrome isn't already running with the debug port open:

```bash
npm run launch
# or: node launch.js
```

This starts Chrome on port `9222` with a dedicated profile at `~/.chrome-agent` and detaches it. If Chrome is already running on that port, it prints a message and exits.

You can also start Chrome manually:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --remote-allow-origins=* \
  --user-data-dir=$HOME/.chrome-agent
```

> The launcher sets `--disable-blink-features=AutomationControlled` so `navigator.webdriver` is not advertised. The dedicated profile is fingerprintable as a fresh user (no history, no cookies) — for maximum blending, point `--user-data-dir` at your real Chrome profile after closing Chrome.

### Granting Accessibility permission (os executor only)

`CGEventPost` requires the calling process to have Accessibility permission. The first time Node spawns `recon-input`, macOS will prompt — or pre-grant it: **System Settings → Privacy & Security → Accessibility → enable Terminal (or whatever process runs Node)**.

### Target selection

When multiple tabs are open, Open Recon connects to the **frontmost tab** in the frontmost Chrome window (detected via AppleScript on macOS). If that fails, it falls back to the first page target returned by CDP.

---

## Project layout

```
index.js                       — public API (extract, connect, launch)
cli.js                         — extractor CLI
agent.js                       — agent loop runner (OpenAI by default)
launch.js                      — Chrome launcher

lib/
  extract.js                   — perception: AX tree + layout → Brief
  connect.js                   — CDP session + settle()
  launch.js                    — find/spawn Chrome with debug port
  reduce.js                    — Brief → LLMView (compact text listing)
  plan.js                      — provider-agnostic LLM facade
  validate.js                  — ref / verb / arg validation
  execute.js                   — backend dispatcher
  loop.js                      — agent orchestrator
  actions.js                   — verb registry (single source of truth)
  prompt.js                    — system prompt builder
  executors/
    cdp.js                     — CDP-based input (dev/CI)
    os.js                      — OS-level input via recon-input (stealth)
  providers/
    openai.js                  — OpenAI adapter (default; native fetch)
    anthropic.js               — Anthropic adapter (native fetch)
    ollama.js                  — Ollama adapter (local; native fetch)

native/macos/recon-input/
  main.swift                   — Swift helper: CGEvent mouse/keyboard
  build.sh                     — one-shot swiftc build

test/                          — unit + integration tests
DESIGN.md                      — full architecture and contracts
```

---

## Contributing

PRs and issues welcome. Useful starting points:

- Additional providers wired through the existing `plan()` facade.
- A `Linux` executor (e.g. via `XTestFakeMotionEvent` / `uinput`) so the stealth path works outside macOS.
- Better humanize defaults tuned against real detector traces (PRs with reproducible measurements especially welcome).

See `DESIGN.md` § Build sequence for the planned next slices.

---

## License

MIT
