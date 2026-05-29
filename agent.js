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
// to whatever page the task expects.

const { connect } = require('./lib/connect');
const { run } = require('./lib/loop');
const { loadConfig, deepMerge, ConfigError } = require('./lib/config');
const { preflight, PreflightError } = require('./lib/preflight');

const PROVIDERS = new Set(['openai', 'anthropic', 'ollama']);
const EXECUTORS = new Set(['os', 'cdp']);

function usageError(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

// Parse CLI flags into a partial config override. Only keys actually passed are
// set (everything else stays undefined), so deepMerge leaves config-file values
// intact for unspecified flags.
function parseArgs(argv) {
  const args = { task: null, verbose: false };
  const override = { loop: {}, executor: {} };
  const positional = [];

  // Parse a numeric flag value, rejecting missing/non-numeric input with a clear
  // usage error. Without this, parseInt yields NaN, deepMerge keeps it (it only
  // skips `undefined`), and a NaN pollMs silently breaks the change-poll wait.
  const num = (raw, flag, parse = parseFloat) => {
    const n = raw === undefined ? NaN : parse(raw, 10);
    if (!Number.isFinite(n)) {
      usageError(`${flag} requires a number, got ${raw === undefined ? '(nothing)' : `"${raw}"`}`);
    }
    return n;
  };

  const value = (argv, i, flag) => {
    const raw = argv[i + 1];
    if (raw === undefined || raw.startsWith('--')) usageError(`${flag} requires a value`);
    return raw;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task' || a === '-t') args.task = value(argv, i++, a);
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--provider' || a === '-p') override.provider = value(argv, i++, a);
    else if (a === '--model') override.model = value(argv, i++, a);
    else if (a === '--context' || a === '-c') override.context = value(argv, i++, a);
    else if (a === '--poll-ms') override.loop.pollMs = num(value(argv, i++, a), '--poll-ms', parseInt);
    else if (a === '--executor') override.executor.backend = value(argv, i++, a);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (a.startsWith('-')) usageError(`unknown option: ${a}`);
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
  --context, -c <string>       Trusted background for the agent (user info,
                               preferences). Injected at the end of the system
                               prompt. Omit for none.
  --poll-ms <n>                Wait between re-checks while the page is unchanged
  --executor <os|cdp>          Input backend. Default 'os' uses recon-input (macOS).
  --verbose, -v                Log each loop turn to stderr
  --help, -h                   Show this help

Config file:
  open-recon.config.json       All defaults; CLI flags override. Path override:
                               OPEN_RECON_CONFIG.

Environment:
  OPENAI_API_KEY          Required for the openai provider (the default).
  ANTHROPIC_API_KEY       Required for the anthropic provider.
  OPEN_RECON_PROVIDER     Override config provider ('openai'|'anthropic'|'ollama').
  OPEN_RECON_EXECUTOR     Override config executor backend ('os'|'cdp').
  OPEN_RECON_CONTEXT      Trusted background injected into the system prompt.
  OPENAI_PROMPT_CACHE_RETENTION  Optional OpenAI cache retention ('24h' for
                          extended retention on supported models; unset = default).`);
}

function validateConfig(config) {
  if (!PROVIDERS.has(config.provider)) {
    usageError(`unknown provider "${config.provider}" (expected: ${[...PROVIDERS].join(', ')})`);
  }
  const backend = config.executor?.backend;
  if (!EXECUTORS.has(backend)) {
    usageError(`unknown executor "${backend}" (expected: ${[...EXECUTORS].join(', ')})`);
  }
  // Numeric loop knobs must be sane. A bad value from the config file or a flag
  // otherwise fails silently and weirdly: maxSteps <= 0 exits before the first
  // turn; a negative pollMs makes the no-change wait never elapse.
  const posInt = (v, name) => {
    if (!Number.isInteger(v) || v <= 0) usageError(`${name} must be a positive integer, got ${v}`);
  };
  posInt(config.loop?.maxSteps, 'loop.maxSteps');
  posInt(config.loop?.pollMs, 'loop.pollMs');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task) {
    console.error('error: no task provided (use --task "..." or a positional argument)');
    printHelp();
    process.exit(2);
  }

  // Final config: DEFAULTS < file < env (all from loadConfig) < CLI flags.
  let config;
  try {
    config = deepMerge(loadConfig(), args.override);
  } catch (err) {
    if (err instanceof ConfigError) usageError(err.message);
    throw err;
  }
  validateConfig(config);

  // Preflight gets the environment ready (and launches Chrome). Its errors are
  // user-facing setup guidance, so print them plainly without a stack trace.
  try {
    await preflight({ config, port: 9222, verbose: args.verbose });
  } catch (err) {
    if (err instanceof PreflightError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  let session;
  try {
    session = await connect({ port: 9222 });
    const runArtifact = await run({ session, task: args.task, config, verbose: args.verbose });
    process.stdout.write((runArtifact.report || JSON.stringify(runArtifact, null, 2)) + '\n');
    process.exitCode = runArtifact.status === 'completed' ? 0 : 1;
  } finally {
    if (session) await session.close();
  }
}

main().catch(err => {
  console.error('fatal:', err?.message || err);
  process.exit(1);
});
