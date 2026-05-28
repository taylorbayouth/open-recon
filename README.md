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
  "url": "https://www.linkedin.com/feed/",
  "title": "Feed | LinkedIn",
  "timestamp": "2026-05-28T00:15:27.016Z",
  "viewport": { "width": 1200, "height": 840, "scrollX": 0, "scrollY": 0 },
  "elements": [
    {
      "role": "button",
      "name": "LinkedIn",
      "backendNodeId": 1276,
      "bbox": { "x": 72, "y": 18, "width": 68, "height": 68 },
      "inViewport": true
    }
  ],
  "text": [
    {
      "role": "heading",
      "name": "Taylor's Feed",
      "bbox": { "x": 140, "y": 24, "width": 220, "height": 32 },
      "inViewport": true,
      "level": 1
    }
  ],
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
  stats:     Stats
}
```

### Element

```
{
  role:          string        — ARIA role (button, link, textbox, …)
  name:          string|null   — accessible name
  backendNodeId: number        — stable DOM node reference for CDP calls
  bbox:          Bbox|null     — { x, y, width, height } in page coordinates
  inViewport:    boolean

  // full mode only (omitted in --lean):
  nodeId:        number
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
  role:          string        — heading, paragraph, StaticText, label, …
  name:          string        — text content
  backendNodeId: number        — (full mode only)
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

The `backendNodeId` on each element is a stable CDP reference you can use to drive interactions in the same session:

```js
// Click a button by backendNodeId
const { nodeId } = await DOM.requestNode({ backendNodeId: 1276 });
await DOM.focus({ nodeId });
// or use Input.dispatchMouseEvent with the bbox coordinates
```

---

## Target selection

When multiple tabs are open, Open Recon connects to the **frontmost tab** in the frontmost Chrome window (detected via AppleScript on macOS). If that fails, it falls back to the first page target returned by CDP.

---

## License

MIT
