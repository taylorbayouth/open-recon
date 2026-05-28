'use strict';

const fs = require('fs');
const path = require('path');

// Single home for tunable knobs. Resolution order, lowest to highest priority:
//   DEFAULTS  <  open-recon.config.json  <  env vars  <  explicit args (CLI)
//
// loadConfig() returns the merged DEFAULTS+file+env config; callers (agent.js)
// layer CLI flags on top via deepMerge before passing it to run().

const DEFAULTS = {
  provider: 'openai',            // openai | anthropic | ollama
  model: null,                   // null → the provider's own default model

  loop: {
    maxSteps: 30,                // hard cap on LLM turns
    shortCircuitOnNoChange: true, // skip the LLM call while the page is unchanged
    pollMs: 1500,                // wait between re-checks while the page is unchanged
    maxNoChangePolls: 10,        // give up waiting after this many polls and let the model act/finish
    maxStuckRepeats: 2,          // abort if the model repeats the same action with no page change this many times
    maxEmptyPlans: 3,            // abort after this many consecutive LLM turns with no actions
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
    maxListingLines: 200,        // hard cap on lines sent to the LLM (0 = unlimited)
  },

  executor: {
    backend: 'os',               // os | cdp
    binPath: null,               // override path to the recon-input binary (os backend)
    pauseOnUserInput: true,      // os: pause input while the human uses the mouse/keyboard
    userIdleMs: 600,             // os: resume only after the human is idle this long
    humanize: {
      enabled: true,
      mouseSpeedPxPerSec: 1400,
      mouseJitterPx: 2,
      keystrokeDelayMsMin: 25,
      keystrokeDelayMsMax: 85,
      preClickPauseMsMin: 40,
      preClickPauseMsMax: 160,
    },
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
  if (process.env.OPEN_RECON_PROVIDER) cfg.provider = process.env.OPEN_RECON_PROVIDER;
  if (process.env.OPEN_RECON_EXECUTOR) cfg.executor.backend = process.env.OPEN_RECON_EXECUTOR;
  return cfg;
}

let cached = null;

class ConfigError extends Error {}

// Load + merge config (DEFAULTS < file < env). Cached after first call; pass
// { reload: true } to force a re-read (e.g. in tests). The file path defaults
// to ./open-recon.config.json, overridable via OPEN_RECON_CONFIG.
function loadConfig(opts = {}) {
  if (cached && !opts.reload) return cached;
  const file = opts.path
    || process.env.OPEN_RECON_CONFIG
    || path.resolve(process.cwd(), 'open-recon.config.json');
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
