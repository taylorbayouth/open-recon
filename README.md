# Open Recon

**Regular Chrome. Agent-grade perception. Mac-level stealth.**

Agents are learning to browse the web. The web has already learned to spot them.

Most browser agents still choose one of three bad shapes:

- **Playwright / Puppeteer**: fast, capable, and loudly fingerprinted.
- **Screenshots every turn**: broadly visible, painfully slow, expensive.
- **Full DOM dumps**: cheap-ish, noisy, huge, and not what the user actually sees.

Open Recon takes the fourth path.

It drives the Chrome binary you already have, reads the fully rendered page, and
rebuilds a compact agent-native map: controls, text, unreadable visual regions,
state, coordinates, and scroll context. Not the raw DOM. Not a screenshot loop.
A small "toy DOM" made for reasoning and action.

The model gets the page like this:

```text
[@t7]   heading     "Trending JavaScript repositories"       (322,151)
[@e14]  link        "facebook / react"                       (214,241)
[@t18]  StaticText  "The library for web and native user interfaces."
[@t23]  StaticText  "230,000"
[@t24]  StaticText  "174 stars today"
[@r2]   image       640x320 - unreadable; take_screenshot @r2 to read
```

Then it acts on refs. Click `@e14`. Read `@r2`. Save the PDF. Finish with a
Markdown report.

No Playwright. No Puppeteer. No cloned browser runtime. No screenshot tax unless
pixels actually matter.

## Why It Matters

Modern sites do not need to "solve AI" to block browser agents. They just need
to notice the harness.

Headless hints. WebDriver flags. Synthetic input. Extension residue. Strange
timing. DOM mutation. Screenshot-heavy loops that are too slow to operate like a
person.

Open Recon is built around a different threat model: use normal Chrome, avoid
page-visible automation, pass the model only the minimum rendered structure it
needs, and make every expensive action deliberate.

On macOS, the default `os` executor sends input through `CGEventPost`, the same
OS event path used by real mouse and keyboard input. It humanizes movement and
typing, refuses to type into the wrong foreground app, and pauses while you use
the machine.

From the site's side, the important parts look boring:

- real Chrome
- trusted click and key events
- no `navigator.webdriver`
- no Playwright or Puppeteer runtime
- no DOM dump sent to the model
- no per-turn screenshot loop

No anti-detection claim is absolute. But the macOS path removes the common
browser-automation fingerprints that make agent traffic easy to classify.

## What Is Fast

Open Recon is fast because it does less.

- **Rendered-page extraction**: accessibility + layout channels become a compact
  text view in hundreds of milliseconds.
- **Tiny prompts**: the model sees refs, labels, state, and positions, not a full
  DOM or image every turn.
- **Prompt-cache friendly**: stable system/tool prefixes; terminal output shows
  cache percentage as the run warms.
- **No-change polling**: if the page has not changed, it waits and rechecks
  instead of burning another LLM call.
- **Targeted vision**: screenshots are an action, not the default perception
  layer; cropped screenshots can target a specific `@e`, `@t`, or `@r` ref.

That is why Open Recon is designed to be one of the most token-efficient browser
agents you can run.

Run the benchmark harness:

```bash
npm run launch
npm run bench
```

It runs a fixed task suite and prints a Markdown-friendly table with `Steps`,
`Time`, `In`, `Out`, `Cache%`, and `Pass`. Use that table to compare models,
providers, executor modes, and competing browser approaches.

## What It Can Do

Open Recon is not just a clicker.

- navigate, click, type, press, scroll, wait, go back
- follow popups and new tabs when the browser opens them
- hit-test clicks and avoid obvious covered targets
- read text without selecting the whole page
- detect canvas/image/svg/cross-origin iframe regions the text tree cannot read
- screenshot the viewport or crop exactly to a ref
- list images and downloadable files without page JS
- save real bytes from loaded resources when possible
- save notes, images, screenshots, PDFs, docs, and archives to disk
- return a complete Markdown report

Every run gets a workspace:

```text
runs/<run-id>/
  report.md
  saved.md
  assets/
    note-1.txt
    screenshot-1.jpg
    product-sheet.pdf
    hero-image.png
```

The model can keep working without stuffing all of that back into context.
Large findings go to disk; compact summaries stay in memory.

## Try It

```bash
git clone https://github.com/taylorbayouth/open-recon.git
cd open-recon
npm install
```

Run a task:

```bash
node agent.js "Go to github.com/trending/javascript?since=daily. \
Collect the first 5 repositories with owner/name, description, total stars, \
and stars today. Return a compact markdown table."
```

The first run performs preflight:

- asks for an API key and stores it in `.env`
- launches regular Chrome with an Open Recon profile
- offers the signed macOS input helper for the stealth executor
- points you to Accessibility permission if macOS needs it

Want only the extractor?

```bash
npm run launch
node cli.js --lean --in-viewport-only --pretty
```

## Platform Story

Open Recon has two execution lanes:

| Lane | Best for | Runs where | Detection profile |
|---|---|---|---|
| `os` | real sites, logged-in browsing, stealth runs | macOS | lowest: trusted OS input, humanized timing |
| `cdp` | CI, tests, local iteration, non-macOS hosts | Chrome/Chromium via DevTools | higher: synthetic input |

The core extractor and agent loop are plain Node + Chrome DevTools Protocol.
The low-detection input backend is macOS today.

## Providers

Open Recon talks to providers through a small planning facade:

- OpenAI
- Anthropic
- Ollama

Defaults live in `open-recon.config.json`. Environment variables override the
file; CLI flags override both.

Useful flags:

```bash
node agent.js --provider openai --model gpt-5.4-mini "..."
node agent.js --provider anthropic "..."
node agent.js --provider ollama --model llama3.1 "..."
node agent.js --executor cdp "..."
node agent.js --context "Trusted operator context here" "..."
```

## How It Works

```text
Connect -> Extract -> Reduce -> Plan -> Validate -> Execute
   ^                                                     |
   +---------------- settle + re-snapshot ---------------+
```

The interesting part is the middle.

Open Recon reconstructs a compact reasoning surface from the rendered browser:
accessible controls, readable text, layout boxes, state, scroll position, and
explicit "unreadable" regions for visual content. The model receives that small
map plus a minimal event history. It does not receive the full DOM. It does not
receive a screenshot unless it asks for one.

Actions are validated against the current snapshot before execution. Refs expire
after navigation. Files and screenshots are persisted before their summaries go
back into the loop. Repeated dead actions trip a stuck guard instead of running
forever.

Full contracts live in [`DESIGN.md`](DESIGN.md).

## Security And Trust

Open Recon drives a browser from an LLM. Treat both the page and the model as
untrusted.

Guardrails today:

- dedicated Chrome profile at `~/.open-recon/profile`
- page content is prompt data, not trusted instruction
- navigation and file saving reject privileged URL schemes
- perception, screenshots, image/file discovery, and resource reads do not rely
  on page JavaScript
- optional `collapseNewTabs` uses one small page patch to keep
  `target="_blank"` links in the current tab; disable it in config for stricter
  no-patch runs
- OS executor only sends input when Chrome is frontmost
- OS executor pauses while the human is actively using the machine
- `runs/` and `logs/` are local and git-ignored

Prompt injection is not solved. Do not hand an autonomous browser high-stakes
accounts and walk away.

## Contributing

Good places to push:

- Linux/Windows OS-level input backends
- stronger evals in `bench.js`
- more providers behind the existing planning facade
- better detector-facing measurements for humanized input
- deeper artifact extraction without growing prompt size

MIT.
