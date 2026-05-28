'use strict';

// Preflight — the "just works" front door for the single entry point.
// Walks a fixed sequence of checks, fixing what it can and giving a clear,
// actionable message for the one thing it can't (Accessibility permission).
// Each step is a no-op when already satisfied, so re-running is always safe.
//
//   1. deps        node_modules present (else `npm install`)
//   2. driver      recon-input binary built (os executor only; else build.sh)
//   3. permission  Accessibility granted    (os executor only)
//   4. creds       provider API key present
//   5. chrome      running on the debug port (else launch it)

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { isRunning, launch } = require('./launch');

const ROOT = path.resolve(__dirname, '..');
const RECON_INPUT_BIN = path.resolve(ROOT, 'native', 'macos', 'recon-input', 'bin', 'recon-input');
const BUILD_SCRIPT = path.resolve(ROOT, 'native', 'macos', 'recon-input', 'build.sh');

class PreflightError extends Error {}

function log(verbose, msg) {
  if (verbose) process.stderr.write(`[preflight] ${msg}\n`);
}

// Step 1 — dependencies.
function ensureDeps(verbose) {
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) return;
  log(verbose, 'node_modules missing — running npm install...');
  execFileSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit' });
}

// Step 2 — native input driver (os executor only).
function ensureDriver(binPath, verbose) {
  if (fs.existsSync(binPath)) return;
  if (process.platform !== 'darwin') {
    throw new PreflightError(
      `OS executor requires macOS; binary not found at ${binPath}. ` +
      'Use the cdp executor instead (set executor.backend to "cdp").'
    );
  }
  log(verbose, 'recon-input binary missing — building...');
  try {
    execFileSync('bash', [BUILD_SCRIPT], { cwd: ROOT, stdio: 'inherit' });
  } catch {
    throw new PreflightError(
      'Failed to build recon-input. Install Xcode command-line tools:\n' +
      '  xcode-select --install\n' +
      `then re-run, or build manually: bash ${BUILD_SCRIPT}`
    );
  }
}

// Step 3 — Accessibility permission (os executor only). Probed via the
// recon-input `axtrusted` op, which calls AXIsProcessTrusted(). CGEvent posting
// silently no-ops without it, so we stop with guidance rather than run blind.
function accessibilityError() {
  return new PreflightError(
    'Accessibility permission is not granted for this process.\n' +
    'The OS executor drives the real cursor/keyboard and macOS blocks that\n' +
    'until you allow it:\n\n' +
    '  System Settings → Privacy & Security → Accessibility\n' +
    '  → enable your terminal (Terminal, iTerm, VS Code, ...)\n\n' +
    'Then re-run. (Or use the cdp executor: executor.backend "cdp".)'
  );
}

// Step 3 — Accessibility permission (os executor only).
async function ensureAccessibility(binPath, verbose) {
  log(verbose, 'checking Accessibility permission...');
  const trusted = await probeAxTrusted(binPath);
  if (!trusted) throw accessibilityError();
}

function probeAxTrusted(binPath) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return finish(false);
    }
    let buf = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(false); }, 3000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      try {
        const resp = JSON.parse(buf.slice(0, nl));
        finish(resp.ok === true && resp.data && resp.data.trusted === true);
      } catch { finish(false); }
      try { child.kill(); } catch {}
    });
    child.on('error', () => { clearTimeout(timer); finish(false); });
    child.stdin.write(JSON.stringify({ id: 'pf', op: 'axtrusted' }) + '\n');
  });
}

// Step 4 — provider credentials. Mirrors the matrix in agent.js.
function ensureCreds(provider) {
  if (provider === 'openai' && !process.env.OPENAI_API_KEY) {
    throw new PreflightError(
      'OPENAI_API_KEY is not set (required for the openai provider).\n' +
      'Add it to .env or your environment, then re-run.'
    );
  }
  if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    throw new PreflightError(
      'ANTHROPIC_API_KEY is not set (required for the anthropic provider).\n' +
      'Add it to .env or your environment, then re-run.'
    );
  }
  // ollama needs no key — its local server is checked at call time.
}

// Step 5 — Chrome on the debug port.
async function ensureChrome(port, verbose) {
  if (await isRunning(port)) return;
  log(verbose, `Chrome not running on port ${port} — launching...`);
  await launch({ port });
}

// Run all checks. Resolves when the environment is ready to run a task; rejects
// with a PreflightError carrying a user-facing message when a step can't be
// auto-fixed.
async function preflight({ config, port = 9222, verbose = false } = {}) {
  ensureDeps(verbose);

  if (config.executor && config.executor.backend === 'os') {
    const binPath = config.executor.binPath || RECON_INPUT_BIN;
    ensureDriver(binPath, verbose);
    await ensureAccessibility(binPath, verbose);
  }

  ensureCreds(config.provider);
  await ensureChrome(port, verbose);
  log(verbose, 'ready.');
}

module.exports = { preflight, PreflightError };
