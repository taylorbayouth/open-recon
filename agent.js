#!/usr/bin/env node
'use strict';

require('dotenv').config();

// Single entry point. Runs preflight (deps, driver, Accessibility, creds,
// Chrome), then an agent loop against the current tab, and prints the Run
// artifact as JSON. The task and flags you pass are the agent's instructions.
//
// Usage:
//   OPENAI_API_KEY=...    node agent.js "search for hello world"
//   ANTHROPIC_API_KEY=... node agent.js --provider anthropic "..."
//   node agent.js --provider ollama --model llama3.1 "..."
//
// Preflight launches Chrome if it isn't already running; just navigate the tab
// to whatever page the task expects. Pass --no-preflight to skip the checks.

const { connect } = require('./lib/connect');
const { run } = require('./lib/loop');
const { loadConfig, deepMerge } = require('./lib/config');
const { preflight, PreflightError } = require('./lib/preflight');

// Parse CLI flags into a partial config override. Only keys actually passed are
// set (everything else stays undefined), so deepMerge leaves config-file values
// intact for unspecified flags.
function parseArgs(argv) {
  const args = { task: null, verbose: false };
  const override = { loop: {}, executor: { humanize: {} } };
  const positional = [];

  // Parse a numeric flag value, rejecting missing/non-numeric input with a clear
  // usage error. Without this, parseInt/parseFloat yield NaN, deepMerge keeps it
  // (it only skips `undefined`), and a NaN maxSteps makes `iter < NaN` always
  // false — the loop silently runs zero turns.
  const num = (raw, flag, parse = parseFloat) => {
    const n = raw === undefined ? NaN : parse(raw, 10);
    if (!Number.isFinite(n)) {
      console.error(`error: ${flag} requires a number, got ${raw === undefined ? '(nothing)' : `"${raw}"`}`);
      process.exit(2);
    }
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task' || a === '-t') args.task = argv[++i];
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--provider' || a === '-p') override.provider = argv[++i];
    else if (a === '--model') override.model = argv[++i];
    else if (a === '--max-steps') override.loop.maxSteps = num(argv[++i], '--max-steps', parseInt);
    else if (a === '--poll-ms') override.loop.pollMs = num(argv[++i], '--poll-ms', parseInt);
    else if (a === '--no-short-circuit') override.loop.shortCircuitOnNoChange = false;
    else if (a === '--no-preflight') args.noPreflight = true;
    else if (a === '--executor') override.executor.backend = argv[++i];
    else if (a === '--no-humanize') override.executor.humanize.enabled = false;
    else if (a === '--mouse-speed') override.executor.humanize.mouseSpeedPxPerSec = num(argv[++i], '--mouse-speed');
    else if (a === '--mouse-jitter') override.executor.humanize.mouseJitterPx = num(argv[++i], '--mouse-jitter');
    else if (a === '--keystroke-delay') {
      const raw = argv[++i];
      if (raw === undefined) { console.error('error: --keystroke-delay requires lo[,hi]'); process.exit(2); }
      const [loStr, hiStr] = raw.split(',');
      const lo = num(loStr, '--keystroke-delay', parseInt);
      override.executor.humanize.keystrokeDelayMsMin = lo;
      override.executor.humanize.keystrokeDelayMsMax = hiStr === undefined ? lo : num(hiStr, '--keystroke-delay', parseInt);
    }
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else positional.push(a);
  }
  if (!args.task && positional.length) args.task = positional.join(' ');
  args.override = override;
  return args;
}

function printHelp() {
  console.log(`Usage: node agent.js [options] <task>

All knobs live in open-recon.config.json. CLI flags below override the file.

Options:
  --task, -t <string>          The task for the agent (or pass as positional)
  --provider, -p <name>        LLM provider: openai | anthropic | ollama
  --model <id>                 Override the provider's default model
  --max-steps <n>              Max loop iterations
  --poll-ms <n>                Wait between re-checks while the page is unchanged
  --no-short-circuit           Always re-prompt, even if the page is unchanged
  --no-preflight               Skip setup/launch checks; assume Chrome is ready
  --executor <cdp|os>          Input backend. 'os' uses recon-input (macOS).
  --no-humanize                Disable Bezier motion / keystroke delays (os only)
  --mouse-speed <px/s>         Cursor travel speed
  --mouse-jitter <px>          Max ± deviation from path
  --keystroke-delay <lo[,hi]>  Per-character delay range in ms
  --verbose, -v                Log each loop turn to stderr
  --help, -h                   Show this help

Config file:
  open-recon.config.json       All defaults; CLI flags override. Path override:
                               OPEN_RECON_CONFIG.

Environment:
  OPENAI_API_KEY          Required for the openai provider (the default).
  ANTHROPIC_API_KEY       Required for the anthropic provider.
  OPEN_RECON_PROVIDER     Override config provider ('openai'|'anthropic'|'ollama').
  OPEN_RECON_EXECUTOR     Override config executor backend ('cdp'|'os').`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task) {
    console.error('error: no task provided (use --task "..." or a positional argument)');
    printHelp();
    process.exit(2);
  }

  // Final config: DEFAULTS < file < env (all from loadConfig) < CLI flags.
  const config = deepMerge(loadConfig(), args.override);

  // Preflight gets the environment ready (and launches Chrome). Its errors are
  // user-facing setup guidance, so print them plainly without a stack trace.
  if (!args.noPreflight) {
    try {
      await preflight({ config, port: 9222, verbose: args.verbose });
    } catch (err) {
      if (err instanceof PreflightError) {
        console.error(err.message);
        process.exit(2);
      }
      throw err;
    }
  }

  let session;
  try {
    session = await connect({ port: 9222 });
    const runArtifact = await run({ session, task: args.task, config, verbose: args.verbose });
    process.stdout.write(JSON.stringify(runArtifact, null, 2) + '\n');
    process.exitCode = runArtifact.status === 'completed' ? 0 : 1;
  } finally {
    if (session) await session.close();
  }
}

main().catch(err => {
  console.error('fatal:', err?.message || err);
  process.exit(1);
});
