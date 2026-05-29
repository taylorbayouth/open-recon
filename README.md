# Open Recon

**The browser agent that reads instead of looks. Fast, invisible, cheap.**

Most browser agents take a screenshot every single turn and ship it to a vision model. That's slow, it's expensive, and the page can see the automation coming. Open Recon does the opposite: it reads Chrome's own **accessibility tree** — the same structured data a screen reader sees — and drives the page through real OS-level input.

A full-page snapshot takes **~400ms** and a few thousand tokens. The page can't tell it's a bot. And when a task genuinely needs eyes — an image CAPTCHA, a chart — it takes *one* screenshot on demand instead of paying that tax every turn.

The result is one of the fastest, cheapest, and smartest browser agents you can run. *(Benchmarks coming soon.)*

- ⚡ **Insanely fast** — ~400ms snapshots, no screenshot round-trips, and the per-turn prompt prefix is cached across the whole run.
- 👻 **Invisible** — no injected JS, no `navigator.webdriver`, no patched binary. Perception rides Chrome's internal DevTools APIs; clicks go through kernel-level `CGEvent` with humanized motion.
- 💸 **Token-light** — a complex page fits in 2,000–5,000 tokens of clean, deduplicated text. Vision is the exception, not the default.
- 📁 **It keeps a project folder** — every run gets a `runs/<id>/` workspace: notes, screenshots, downloaded files, and a Markdown report you can hand to a human or another model.
- 📎 **It downloads what it finds** — a PDF, an image, the real original bytes — straight to disk.
- 🧠 **It knows when to stop** — short-circuits redundant LLM calls, waits out lazy loads, and bails cleanly if it's flailing.
- 🖥️ **Your Chrome, no new browser** — attaches over the remote debugging port. No Playwright, no Puppeteer, no profile to babysit.

---

## Feel it

Ask for a live browser task in plain English:

```bash
node agent.js --verbose "Go to github.com/trending/javascript?since=daily. \
  Collect the first 5 repositories with owner/name, description, total stars, \
  and stars today. Don't open repo pages. Return a compact markdown table."
```

Open Recon attaches to Chrome, reads the tab through its accessibility/layout channels, and hands the model a compact text view — interactive elements marked `@e`, text marked `@t`, each with its on-screen position:

```text
[step 2] snapshot → 63 elements, 118 text nodes, 341ms

[@t7]   heading     "Trending JavaScript repositories"       (322,151)
[@e14]  link        "facebook / react"                       (214,241)
[@t18]  StaticText  "The library for web and native user interfaces."
[@t23]  StaticText  "230,000"
[@t24]  StaticText  "174 stars today"
[@e27]  link        "vercel / next.js"                       (207,385)
```

Then it acts on those refs and returns the answer:

```text
| Repository     | Description                                      |   Stars | Today |
|----------------|--------------------------------------------------|--------:|------:|
| facebook/react | The library for web and native user interfaces.  | 230,000 |   174 |
| vercel/next.js | The React Framework                              | 128,000 |    96 |
```

No script ran in the page. No DOM dump went to the model. It saw the on-screen controls and text, and drove Chrome like a person would.

---

## How it pulls this off

**It reads, it doesn't screenshot.** Perception uses Chrome's internal DevTools APIs — `Accessibility.getFullAXTree` and `DOMSnapshot.captureSnapshot` — not page-visible JavaScript. The model gets a typed, reading-order listing with exact `(x,y)` coordinates, so it never has to *visually* parse where a button is. That's where the ~400ms snapshots and the small token bills come from.

**It acts like a human.** On macOS, input goes through `CGEventPost` — the same kernel API as a real mouse and keyboard — moving along a randomized Bezier path with per-click jitter and per-keystroke timing. There's no `navigator.webdriver`, no injected script, no automation flag. The page sees a user.

**It sees on purpose, not by reflex.** When pixels actually matter, `take_screenshot` grabs one frame and routes it to a configurable vision model for a description that flows back into the agent's memory. One deliberate action — not a per-turn cost.

---

## It does more than click

Reading a page is the floor. The agent has a small set of capture verbs, and everything it gathers lands in the run's project folder:

- **`save_text`** — banks findings as it goes; the full text hits disk while only a short summary stays in context, so a long task stays cheap and on-track.
- **`get_images` / `get_files` → `save_file`** — discovers images and downloadable files (PDFs, docs, archives) via pure DOM reads, then pulls the **real bytes** from Chrome's resource cache (so cross-origin and authenticated files work) to disk.
- **`take_screenshot`** — viewport capture + vision description, on demand.

```
runs/<id>/
  saved.md          ← rollup: every note, image, and file with its summary
  assets/
    screenshot-1.png
    report-q3.pdf
    cat.jpg
```

When the run finishes, `agent.js` returns a structured Markdown report — the task, the result, a numbered step log, and the full scratchpad — ready to feed straight into a downstream model or read yourself.

And it's built to run unattended: it skips LLM calls while the page is byte-identical (sitting through navigations, lazy loads, and pagination without spending turns), aborts if the model repeats a dead action, and — on the `os` executor — pauses the instant you grab the mouse, resuming once you're idle.

---

## Install

```bash
git clone https://github.com/taylorbayouth/open-recon.git
cd open-recon
npm install
```

The first `node agent.js` runs a preflight that walks you through the rest: it prompts for your **API key** and saves it to `.env`, offers to download the notarized **macOS input driver**, and points you to the **Accessibility permission** if it's not set. Re-running is safe — each step is a no-op once satisfied.

<details>
<summary>Manual setup (optional)</summary>

**API key** — `cp .env.example .env`, then add `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. (If you previously `export`ed a key in your shell, that wins over `.env` — `unset` it if the agent uses a stale key.)

**macOS input driver** — the Swift helper that posts real OS input. Download `recon-input-*-macos-universal.zip` from the [latest release](https://github.com/taylorbayouth/open-recon/releases/latest) (signed, notarized, stapled — Gatekeeper accepts it offline), or build from source with `bash native/macos/recon-input/build.sh` (Xcode CLI tools required; the unsigned build may need `xattr -d com.apple.quarantine native/macos/recon-input/bin/recon-input`).

**Accessibility permission** — System Settings → Privacy & Security → Accessibility → enable Terminal (or whatever runs Node). Required once for the `os` executor.

</details>

---

## Quickstart

```bash
export OPENAI_API_KEY=sk-...
node agent.js "go to github.com/trending and collect the top 5 repos"
```

Just want a snapshot, no agent loop?

```bash
npm run launch
node cli.js --lean --in-viewport-only --pretty   # → Done. 23 elements in 373ms
```

---

## Knobs

All defaults live in `open-recon.config.json`; env vars override the file, and CLI flags override those.

**Providers** — `--provider` or `OPEN_RECON_PROVIDER`:

| Provider | Default model | Key |
|---|---|---|
| `openai` (default) | `gpt-5.4-mini` | `OPENAI_API_KEY` |
| `anthropic` | `claude-opus-4-7` | `ANTHROPIC_API_KEY` |
| `ollama` | `llama3.1` | none (local) |

**Execution backend** — `--executor` or `OPEN_RECON_EXECUTOR`:

| Backend | Use when | Detection profile |
|---|---|---|
| `os` (default) | Real sites, anything that must stay invisible | Low — humanized kernel input |
| `cdp` | CI, headless tests, local iteration | Higher — synthetic events |

**Other useful settings** — `context` (trusted background about the user, injected into the prompt), `loop.maxSteps`, `loop.shortCircuitOnNoChange`, the `humanize` motion/timing block, and a `vision` block that picks the secondary model for screenshots (independent of the planner, so you can pair a cheap planner with a sharp vision model). See `open-recon.config.json` and [`DESIGN.md`](DESIGN.md).

---

## Under the hood

```
Connect → Extract → Reduce → Plan → Validate → Execute
  (CDP)   (recon)  (prompt)  (LLM)   (refs)   (cdp|os)
             ↑                                     │
             └──── settle() + re-snapshot ─────────┘
```

Each stage hands the next a clean artifact — `Brief`, `LLMView`, `Completion`, `Action`, `Observation` — so the whole pipeline is easy to log, replay, and debug. Full contracts in [`DESIGN.md`](DESIGN.md).

**Requirements:** Node ≥ 18 and Chrome. macOS for the `os` executor; `cdp` and extraction also run on Linux.

---

## Security & trust model

Open Recon drives a real browser from an LLM, so it sits between two untrusted inputs — the model's output and the page's content. What's guarded today:

- **Isolated profile.** It runs against a dedicated Chrome profile (`~/.open-recon/profile`), never your everyday browser. But sessions you sign into there persist across runs and the agent can use them — only log into what a task needs.
- **Page text is data, not instructions.** The prompt makes only the `Task:` line authoritative and treats page content as untrusted. A mitigation, not a guarantee — prompt injection is unsolved; don't run high-stakes tasks unattended on hostile pages.
- **Navigation is `http`/`https` only.** `file://`, `chrome://`, `about:`, and friends are rejected, so an injected URL can't reach local files or privileged pages.
- **No page JavaScript is evaluated** for perception or capture — DevTools APIs only. (The lone exception is `selectText` reading `window.getSelection()` to confirm what it highlighted.)
- **Secrets and artifacts stay local.** Keys live in git-ignored `.env`; `runs/` and `logs/` are git-ignored too, but may contain sensitive page content.
- **The `os` executor gates on Chrome being frontmost** and backs off while you're using the machine, so input never lands in the wrong window.

---

## Contributing

PRs and issues welcome — good starting points:

- More providers through the existing `plan()` facade.
- A Linux stealth executor (`XTestFakeMotionEvent` / `uinput`).
- Better humanize defaults tuned against real detector traces (reproducible measurements especially welcome).

See [`DESIGN.md`](DESIGN.md) for the full architecture.

## License

MIT
