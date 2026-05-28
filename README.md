# Open Recon

Extracts every interactive element and visible text node from a live Chrome tab — with bounding boxes and computed styles — and returns it as structured JSON.

Designed as a **perception layer for browser agents**: give an LLM a clean, semantic snapshot of what's on screen and where, without injecting scripts into the page or leaving any detectable footprint.

```
$ node index.js --lean --in-viewport-only --pretty
Attaching to: Feed | LinkedIn (https://www.linkedin.com/feed/)
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
  "lookup": {
    "@e1": 1276,
    "@t1": 1419
  },
  "stats": {
    "totalAXNodes": 2443,
    "interactiveFound": 208,
    "textFound": 293,
    "withBounds": 208,
    "inViewport": 23,
    "returned": 23,
    "elapsedMs": 373
  }
}
```

---

## How it works

Open Recon connects to Chrome via the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) (CDP) on the remote debugging port. It fires three CDP calls in parallel:

1. **`Accessibility.getFullAXTree`** — the browser's own accessibility tree, which gives roles, names, ARIA state, and `backendNodeId` references for every element.
2. **`DOMSnapshot.captureSnapshot`** — a layout snapshot that maps `backendNodeId` → bounding box and computed CSS values, without evaluating JavaScript in the page.
3. **`Page.getLayoutMetrics`** — viewport dimensions and scroll position.

It then correlates the AX tree with the layout snapshot to attach pixel coordinates and styles to each node, filters to interactive elements and visible text, and emits the result as JSON.

**No scripts are evaluated in the page context.** The entire extraction runs through Chrome's internal DevTools APIs, which are not observable from the page itself.

---

## Requirements

- **Node.js** ≥ 18
- **Google Chrome** (stable channel)
- macOS (active-tab detection in `launch.js` uses AppleScript; the extractor itself is cross-platform)

---

## Install

```bash
git clone https://github.com/taylorbayouth/open-recon.git
cd open-recon
npm install
```

---

## Usage

### 1. Launch Chrome with remote debugging

If Chrome isn't already running with the debug port open:

```bash
npm run launch
# or: node launch.js
```

This starts Chrome on port `9222` with a dedicated profile at `~/.chrome-agent` and detaches it. If Chrome is already running on that port, it prints a message and exits.

> You can also start Chrome manually:
> ```bash
> "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
>   --remote-debugging-port=9222 \
>   --remote-allow-origins=* \
>   --user-data-dir=$HOME/.chrome-agent
> ```

### 2. Navigate to any page in Chrome

### 3. Run the extractor

```bash
node index.js --pretty
```

Output goes to **stdout**. Logs (`Attaching to:`, `Done.`) go to **stderr**, so you can pipe the JSON safely:

```bash
node index.js --lean --in-viewport-only > snapshot.json
```

---

## CLI flags

| Flag | Description |
|---|---|
| `--pretty` | Pretty-print JSON output (2-space indent). Default: minified. |
| `--in-viewport-only` | Only include elements that intersect the current viewport. |
| `--lean` | Compact output mode: drops null/empty fields, strips CSS-hidden elements (visibility:hidden, opacity:0, pointer-events:none, display:none), and omits `computedStyle`. Ideal for LLM context windows. |

Flags can be combined:

```bash
node index.js --lean --in-viewport-only --pretty
```

---

## Output schema

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
  text:      TextNode[]      — visible text nodes
  lookup:    { [ref]: number } — maps each `ref` to its CDP backendNodeId
  stats:     Stats
}
```

### Reference convention

Every interactive element and text node gets a stable string `ref` of the form `@<type><n>`:

- `@` prefix marks the string as a reference, so it can't be confused with numbers on the page.
- `<type>` is one lowercase letter: `e` for interactive element, `t` for text node.
- `<n>` is a positive integer, assigned in document order. Elements and text use independent counters — `@e1` and `@t1` can coexist.

Regex: `/^@[et]\d+$/`.

Refs are **scoped to a single snapshot**. A new extraction reassigns everything — never cache a ref across snapshots, and never act on a ref from an earlier brief. After any action that may have changed the page (click, navigation, scroll, keypress), re-snapshot before deciding what to do next. The `lookup` table maps each ref to a live CDP `backendNodeId` for the current session; executors should treat refs as opaque strings and resolve via `lookup`.

**Action targets:** `@e` refs are the only valid targets for action verbs (click, focus, type, …). `@t` refs are grounding context — the LLM may reference them in prose ("the heading @t3 says X") but should not emit `click(@t3)`. The validator should reject `@t` refs in target-bearing actions. If a future verb addresses text directly (e.g., `extract(@t3)`), it can be added explicitly without breaking this default.

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

---

## Interactive elements captured

Elements are included if their ARIA role is one of:

`button` `link` `textbox` `combobox` `checkbox` `radio` `menuitem` `menuitemcheckbox` `menuitemradio` `tab` `searchbox` `slider` `spinbutton` `switch` `treeitem` `option` `columnheader` `rowheader`

**Custom widgets** (e.g. `<div tabindex="0">`) are also included when an element is focusable but has no semantic role (`generic`, `none`, `presentation`).

## Text nodes captured

`heading` `paragraph` `StaticText` `label` `caption` `listitem` `term` `definition` `blockquote` `code`

Sub-runs (`InlineTextBox`, `LineBreak`) are intentionally excluded — they're fragments of `StaticText` nodes and would inflate output without adding information.

---

## Using with an LLM

Pass the snapshot to any LLM that can read JSON. In `--lean --in-viewport-only` mode, a typical page compresses to a few thousand tokens — small enough to fit alongside system prompts and tool definitions.

Each element and text node carries a short `ref` string (`@e1`, `@t1`, …) that the LLM can reference in actions. The snapshot's `lookup` table resolves each ref to a CDP `backendNodeId` for the same session:

```js
// LLM says: { action: "focus", ref: "@e3" }
const backendNodeId = snapshot.lookup[ref];               // e.g. 144
const { nodeId } = await DOM.requestNode({ backendNodeId });
await DOM.focus({ nodeId });
// or use Input.dispatchMouseEvent with the element's bbox coordinates
```

Refs are reassigned on every snapshot, so pair each LLM action with the snapshot it was derived from. Executors should treat refs as opaque strings — validate against `/^@[et]\d+$/` and look them up rather than parsing.

---

## Driving the browser (OS-level input)

Open Recon's perception layer is observation-only. To actually drive Chrome, the agent loop in `lib/loop.js` dispatches `Action`s through an executor backend. Two are available:

| Backend | When to use | Detectability |
|---|---|---|
| `cdp` | Tests, CI, dev iteration, headless | Higher — CDP-synthesized input is fingerprintable even though events carry `isTrusted: true` |
| `os` (macOS) | Production runs against real sites | Lower — `CGEventPost` events travel the HID pipeline, indistinguishable from real input |

### Building the OS backend (one-time, macOS)

```bash
bash native/macos/recon-input/build.sh
```

Builds `native/macos/recon-input/bin/recon-input` from `main.swift`. Requires the Xcode command-line tools (`xcode-select --install`). The binary is git-ignored — per-platform, build locally.

### Granting Accessibility permission

`CGEventPost` requires the calling process to have Accessibility permission. The first time Node spawns `recon-input`, macOS will prompt — or you can pre-grant it: **System Settings → Privacy & Security → Accessibility → enable Terminal (or whatever process runs Node)**.

### Running with the OS backend

```bash
OPEN_RECON_EXECUTOR=os node agent.js "search for hello world"
# or:
node agent.js --executor os "search for hello world"
```

Humanize knobs are CLI-tunable:

```bash
node agent.js --executor os \
  --mouse-speed 1200 --mouse-jitter 3 \
  --keystroke-delay 40,120 \
  "post 'hello' on twitter"
```

Pass `--no-humanize` to disable Bezier motion and per-keystroke delays (fast, but defeats the point of `os`).

---

## Target selection

When multiple tabs are open, Open Recon connects to the **frontmost tab** in the frontmost Chrome window (detected via AppleScript on macOS). If that fails, it falls back to the first page target returned by CDP.

---

## License

MIT
