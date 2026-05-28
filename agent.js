#!/usr/bin/env node
'use strict';

require('dotenv').config();

// Slice-1 smoke harness. Connects to Chrome on port 9222, runs an agent loop
// against the current tab, prints the Run artifact as JSON.
//
// Usage:
//   OPENAI_API_KEY=...    node agent.js "search for hello world"
//   ANTHROPIC_API_KEY=... node agent.js --provider anthropic "..."
//   node agent.js --provider ollama --model llama3.1 "..."
//
// Prerequisites:
//   - Chrome running with --remote-debugging-port=9222 (run `npm run launch`)
//   - Navigate Chrome to whatever page the task expects
//   - API key for the chosen provider (openai → OPENAI_API_KEY, anthropic →
//     ANTHROPIC_API_KEY; ollama needs none, just a running local server)

const { connect } = require('./lib/connect');
const { run } = require('./lib/loop');
const { loadConfig, deepMerge } = require('./lib/config');

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

// Each provider needs different credentials. Validate the one we'll actually
// use so the failure is a clear message instead of a mid-run API error.
function checkProviderCredentials(provider) {
  if (provider === 'openai' && !process.env.OPENAI_API_KEY) {
    return 'OPENAI_API_KEY is not set (required for --provider openai)';
  }
  if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    return 'ANTHROPIC_API_KEY is not set (required for --provider anthropic)';
  }
  // ollama needs no key — just a reachable local server, checked at call time.
  return null;
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

  const credError = checkProviderCredentials(config.provider);
  if (credError) {
    console.error(`error: ${credError}`);
    process.exit(2);
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
