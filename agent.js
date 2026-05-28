#!/usr/bin/env node
'use strict';

require('dotenv').config();

// Slice-1 smoke harness. Connects to Chrome on port 9222, runs an agent loop
// against the current tab, prints the Run artifact as JSON.
//
// Usage:
//   ANTHROPIC_API_KEY=... node agent.js "search for hello world"
//   ANTHROPIC_API_KEY=... node agent.js --task "..." --max-steps 10 --verbose
//
// Prerequisites:
//   - Chrome running with --remote-debugging-port=9222 (run `npm run launch`)
//   - Navigate Chrome to whatever page the task expects
//   - ANTHROPIC_API_KEY set in env

const { connect } = require('./lib/connect');
const { run } = require('./lib/loop');

function parseArgs(argv) {
  const args = {
    task: null,
    maxSteps: 30,
    verbose: false,
    model: undefined,
    executor: { backend: undefined, humanize: {} },
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task' || a === '-t') args.task = argv[++i];
    else if (a === '--max-steps') args.maxSteps = parseInt(argv[++i], 10);
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--executor') args.executor.backend = argv[++i];
    else if (a === '--no-humanize') args.executor.humanize.enabled = false;
    else if (a === '--mouse-speed') args.executor.humanize.mouseSpeedPxPerSec = parseFloat(argv[++i]);
    else if (a === '--mouse-jitter') args.executor.humanize.mouseJitterPx = parseFloat(argv[++i]);
    else if (a === '--keystroke-delay') {
      const [lo, hi] = argv[++i].split(',').map(n => parseInt(n, 10));
      args.executor.humanize.keystrokeDelayMsMin = lo;
      args.executor.humanize.keystrokeDelayMsMax = Number.isFinite(hi) ? hi : lo;
    }
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else positional.push(a);
  }
  if (!args.task && positional.length) args.task = positional.join(' ');
  return args;
}

function printHelp() {
  console.log(`Usage: node agent.js [options] <task>

Options:
  --task, -t <string>          The task for the agent (or pass as positional)
  --max-steps <n>              Max loop iterations (default: 30)
  --model <id>                 Override the default model
  --verbose, -v                Log each loop turn to stderr
  --executor <cdp|os>          Input backend. 'os' uses recon-input (macOS).
                               Default: env OPEN_RECON_EXECUTOR or 'cdp'.
  --no-humanize                Disable Bezier motion / keystroke delays (os only)
  --mouse-speed <px/s>         Cursor travel speed (default: 1400)
  --mouse-jitter <px>          Max ± deviation from path (default: 2)
  --keystroke-delay <lo[,hi]>  Per-character delay range in ms (default: 25,85)
  --help, -h                   Show this help

Environment:
  ANTHROPIC_API_KEY       Required.
  OPEN_RECON_EXECUTOR     Default executor backend ('cdp' or 'os').`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task) {
    console.error('error: no task provided (use --task "..." or a positional argument)');
    printHelp();
    process.exit(2);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('error: ANTHROPIC_API_KEY is not set');
    process.exit(2);
  }

  let session;
  try {
    session = await connect({ port: 9222 });
    const runArtifact = await run({
      session,
      task: args.task,
      provider: 'anthropic',
      model: args.model,
      maxSteps: args.maxSteps,
      verbose: args.verbose,
      executor: args.executor,
    });
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
