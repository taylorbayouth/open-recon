'use strict';

const fs = require('fs');
const path = require('path');

// Single home for tunable knobs. Resolution order, lowest to highest priority:
//   DEFAULTS  <  browser-agent.config.json  <  env vars  <  explicit args (CLI)
//
// loadConfig() returns the merged DEFAULTS+file+env config; callers (agent.js)
// layer CLI flags on top via deepMerge before passing it to run().

const DEFAULTS = {
  provider: 'openai',            // openai | anthropic | ollama
  model: null,                   // null → the provider's own default model
  reasoningEffort: 'high',       // OpenAI gpt-5/o-series reasoning effort:
                                 // minimal|low|medium|high. Higher = more
                                 // deliberation per turn → better convergence and
                                 // fewer wasted/looping turns. null disables the
                                 // field (set it for non-reasoning models).
                                 // Ignored by anthropic/ollama.
  context: null,                 // optional operator-supplied background (user info,
                                 // preferences) injected as a trusted block at the end
                                 // of the system prompt. null → no Context section.

  chrome: {
    executablePath: null,         // explicit Chrome/Chromium executable path
                                 // (also BROWSER_AGENT_CHROME_PATH)
  },

  loop: {
    maxSteps: 30,                // hard cap on LLM turns (reflections don't count — see reflect)
    maxIterations: null,         // absolute ceiling on loop passes, counting EVERYTHING (reflections
                                 // included) so nothing can loop forever. null → maxSteps +
                                 // reflect.maxReflections + 10 buffer, computed at run start.
    shortCircuitOnNoChange: true, // skip the LLM call while the page is unchanged
    pollMs: 1500,                // wait between re-checks while the page is unchanged
    maxNoChangePolls: 10,        // give up waiting after this many polls and let the model act/finish
    maxStuckRepeats: 2,          // abort if the model repeats the same action with no page change this many times
    maxEmptyPlans: 1,            // reflect (then abort) after this many consecutive LLM turns with no tool action
    maxUrlVisits: 4,             // fire a reflection turn on the Nth arrival at the same page — circling back to seen pages
    revisitUrlMatch: 'clean',    // how the revisit counter keys URLs: 'clean' (strip #fragment + tracking junk; merges re-run searches) or 'full' (raw URL, exact match — never merges distinct URLs)
    maxSparsePageRetries: 4,     // after navigation, retry sparse snapshots before prompting
    sparsePageRetryMs: 400,      // wait between sparse post-navigation re-extracts
    sparsePageMinNodes: 2,       // elements + text + regions below this is considered sparse
    maxSameDirectionScrolls: 3,  // soft warning when same scroll direction repeats this many times on a page
    maxScrollReversals: 3,       // fire a reflection turn after this many scroll direction reversals (down↔up) on a page — oscillation = thrashing
  },

  // Reflection — a loop-triggered reflection turn (lib/reflect.js).
  // When the agent shows signs of flailing (stuck/empty-plan) or crosses a
  // budget threshold, the loop strips the page away and feeds it only its
  // scratchpad, asking it to stay the course or pivot. The <15-word decision
  // lands in the event log as a permanent step the next turn reads.
  reflect: {
    enabled: true,
    provider: null,              // provider for the reflection turn. null → the planner's provider.
    model: 'gpt-5.5',            // model for the reflection turn — independent of the planner, so a
                                 // cheap planner can pause to think on a stronger model. null → the
                                 // planner's model. (Pair with `provider` when crossing vendors.)
    maxReflections: 10,          // hard cap on reflections per run
    cooldownTurns: 4,            // minimum turns between reflections (no back-to-back firing)
    budgetTurnFraction: 0.6,     // fire one budget reflection once past this fraction of maxSteps
    savedMaxChars: 16000,        // scratchpad chars fed in (headings always kept; body tail-trimmed)
  },

  // Final report synthesis. At the end of a run, saved.md is handed to this
  // model once if it fits the raw token budget; otherwise saved-index.md is used
  // for a summary-oriented report. If disabled or unavailable, loop falls back
  // to a small deterministic evidence report.
  report: {
    enabled: true,
    provider: 'openai',
    model: 'gpt-5.5',
    rawTokenBudget: 3000,
  },

  settle: {
    afterActionMs: 150,          // pause after an action before the next snapshot
    maxMs: 2000,                 // hard cap on settle
  },

  view: {                        // how the brief is rendered for the LLM (reduce.js)
    includeText: true,           // interleave @t text nodes (headings, labels, prose)
    includeCoords: true,         // append a compact (x,y) center per line
    maxTextChars: 200,           // truncate long text node names
    dedupeText: true,            // collapse consecutive identical text nodes
    maxListingLines: 1000,       // hard cap on lines sent to the LLM (0 = unlimited).
                                 // This is the value the loop actually uses — it's
                                 // passed to reduce() as viewCfg and OVERRIDES
                                 // reduce.js's DEFAULT_VIEW, so keep the two in sync.
  },

  executor: {
    backend: 'os',               // os | cdp
    binPath: null,               // override path to the browser-input binary (os backend)
    pauseOnUserInput: true,      // os: pause input while the human uses the mouse/keyboard
    userIdleMs: 600,             // os: resume only after the human is idle this long
    raiseChromeOnStart: true,    // os: foreground the agent's Chrome at run start
    humanize: {
      enabled: true,
      mouseSpeedPxPerSec: 1400,
      mouseJitterPx: 2,
      keystrokeDelayMsMin: 25,
      keystrokeDelayMsMax: 85,
      postFocusPauseMs: 80,
      postClearPauseMs: 50,
      preClickPauseMsMin: 40,
      preClickPauseMsMax: 160,
    },
  },

  // Secondary vision model used by the `screenshot` verb to describe what's on
  // the page. Independent of the planner provider, so you can pair a cheap
  // planner with a strong vision model (or vice versa). `model: null` falls back
  // to a multimodal default for the chosen provider.
  vision: {
    provider: 'openai',          // openai | anthropic | ollama
    model: null,                 // null → provider's default multimodal model
    prompt: 'Describe what you see in detail. Aim for 1500-2000 characters.',
    maxTokens: 1024,
  },

  // Encoding of the image handed to the vision model. The model downscales
  // internally, so a lossless full-page PNG just burns bytes, tokens, and disk.
  // Quality is tiered by how the shot will be read: a whole-viewport "describe"
  // (take_screenshot with no ref) tolerates heavy compression, but a cropped
  // read (take_screenshot with a ref — usually small text, chart labels, or a
  // CAPTCHA) is effectively OCR, where JPEG artifacts eat thin glyphs, so it
  // gets a higher quality. format:'png' ignores both quality knobs.
  screenshot: {
    format: 'jpeg',              // jpeg | png
    quality: 55,                 // full-viewport describe (no ref)
    croppedQuality: 92,          // cropped @ref read
  },

  log: {
    enabled: true,
    dir: 'logs',
  },
};

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Recursively merge `override` onto `base`. Nested plain objects merge; scalars
// and arrays replace. `undefined` values in override are skipped, so a partial
// override (e.g. a CLI flag setting only loop.maxSteps) never wipes siblings.
function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function applyEnvOverrides(cfg) {
  if (process.env.BROWSER_AGENT_PROVIDER) cfg.provider = process.env.BROWSER_AGENT_PROVIDER;
  if (process.env.BROWSER_AGENT_EXECUTOR) cfg.executor.backend = process.env.BROWSER_AGENT_EXECUTOR;
  if (process.env.BROWSER_AGENT_CONTEXT) cfg.context = process.env.BROWSER_AGENT_CONTEXT;
  if (process.env.BROWSER_AGENT_CHROME_PATH) {
    cfg.chrome = cfg.chrome || {};
    cfg.chrome.executablePath = process.env.BROWSER_AGENT_CHROME_PATH;
  }
  return cfg;
}

let cached = null;

class ConfigError extends Error {}

// Load + merge config (DEFAULTS < file < env). Cached after first call; pass
// { reload: true } to force a re-read (e.g. in tests). The file path defaults
// to ./browser-agent.config.json, overridable via BROWSER_AGENT_CONFIG.
function loadConfig(opts = {}) {
  if (cached && !opts.reload) return cached;
  const file = opts.path
    || process.env.BROWSER_AGENT_CONFIG
    || path.resolve(process.cwd(), 'browser-agent.config.json');
  let fileCfg = {};
  if (fs.existsSync(file)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new ConfigError(`Invalid config JSON in ${file}: ${e.message}`);
    }
  }
  // Clone DEFAULTS first: deepMerge only shallow-copies the top level, so a
  // config without (say) an `executor` block would leave cfg.executor === the
  // shared DEFAULTS.executor — and applyEnvOverrides mutating cfg.executor.backend
  // would then corrupt the module-level DEFAULTS for the rest of the process.
  cached = applyEnvOverrides(deepMerge(structuredClone(DEFAULTS), fileCfg));
  return cached;
}

module.exports = { loadConfig, deepMerge, DEFAULTS, ConfigError };
