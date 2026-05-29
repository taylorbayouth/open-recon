'use strict';

// Preflight — the "just works" front door for the single entry point.
// Walks a fixed sequence of checks, fixing what it can and prompting for the
// rest. Each step is a no-op when already satisfied, so re-running is safe.
//
//   0. env          .env exists (copy from .env.example if not)
//   1. deps         node_modules present (else `npm install`)
//   2. driver       recon-input binary present — offers download or build
//   3. permission   Accessibility granted (os executor only)
//   4. creds        provider API key set — prompts and saves to .env if not
//   5. chrome       running on the debug port (else launch it)

const { spawn, execFileSync, execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { isRunning, launch, mainChromePid, DEFAULT_PROFILE_DIR } = require('./launch');

const ROOT         = path.resolve(__dirname, '..');
const ENV_PATH     = path.join(ROOT, '.env');
const ENV_EXAMPLE  = path.join(ROOT, '.env.example');
const BIN_PATH     = path.resolve(ROOT, 'native', 'macos', 'recon-input', 'bin', 'recon-input');
const BUILD_SCRIPT = path.resolve(ROOT, 'native', 'macos', 'recon-input', 'build.sh');
const GITHUB_REPO  = 'taylorbayouth/open-recon';

const KEY_FOR = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };

class PreflightError extends Error {}

function log(msg) {
  process.stderr.write(`[preflight] ${msg}\n`);
}

// ── Interactive helpers ────────────────────────────────────────────────────────

function prompt(question) {
  // Interactive prompts need a TTY. In a non-interactive context (CI, a piped
  // run, a fresh-clone script) readline would block forever on stdin with no way
  // to answer — fail fast with actionable guidance instead. PreflightError prints
  // cleanly (no stack) and exits 2 via agent.js. Covers choose()/ensureCreds too.
  if (!process.stdin.isTTY) {
    throw new PreflightError(
      `Setup needs an interactive answer ("${question.trim()}") but stdin is not a TTY.\n` +
      `Run open-recon in a terminal, or pre-provide what it's asking for: set the\n` +
      `provider API key env var, pass --executor cdp, or set executor.binPath — so\n` +
      `preflight has nothing left to prompt for.`
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

async function choose(question, options) {
  process.stderr.write(`\n[preflight] ${question}\n`);
  options.forEach((o, i) => process.stderr.write(`  ${i + 1}. ${o.label}\n`));
  const raw = await prompt('> ');
  const idx = parseInt(raw, 10) - 1;
  return options[Math.max(0, Math.min(options.length - 1, isNaN(idx) ? 0 : idx))];
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { 'User-Agent': 'open-recon-preflight' } };
    https.get(url, opts, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, { headers: { 'User-Agent': 'open-recon-preflight' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) return follow(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} downloading ${u}`));
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

// ── Step 0 — .env ─────────────────────────────────────────────────────────────

function ensureEnvFile() {
  if (fs.existsSync(ENV_PATH)) return;
  if (fs.existsSync(ENV_EXAMPLE)) {
    fs.copyFileSync(ENV_EXAMPLE, ENV_PATH);
    log('Created .env from .env.example.');
  }
}

// ── Step 1 — node_modules ─────────────────────────────────────────────────────

function ensureDeps() {
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) return;
  log('node_modules missing — running npm install...');
  execFileSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit' });
}

// ── Step 2 — recon-input binary ───────────────────────────────────────────────

async function downloadDriver() {
  log('Fetching latest release from GitHub...');
  let release;
  try {
    release = await fetchJson(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
  } catch (e) {
    throw new PreflightError(`Could not reach GitHub releases: ${e.message}`);
  }

  const asset = release.assets?.find(a => a.name.endsWith('.zip') && a.name.includes('macos'));
  if (!asset) throw new PreflightError('No macOS binary found in latest release. Try building from source instead.');

  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-'));
  const zipPath    = path.join(tmpDir, asset.name);
  const mountPoint = path.join(tmpDir, 'mount');

  try {
    log(`Downloading ${asset.name}...`);
    await downloadFile(asset.browser_download_url, zipPath);

    execSync(`unzip -q "${zipPath}" -d "${tmpDir}"`);
    const dmgName = fs.readdirSync(tmpDir).find(f => f.endsWith('.dmg'));
    if (!dmgName) throw new PreflightError('No .dmg found inside the downloaded zip.');

    fs.mkdirSync(mountPoint, { recursive: true });
    execSync(`hdiutil attach -nobrowse -quiet -mountpoint "${mountPoint}" "${path.join(tmpDir, dmgName)}"`);

    try {
      fs.mkdirSync(path.dirname(BIN_PATH), { recursive: true });
      fs.copyFileSync(path.join(mountPoint, 'recon-input'), BIN_PATH);
      fs.chmodSync(BIN_PATH, 0o755);
    } finally {
      try { execSync(`hdiutil detach "${mountPoint}" -quiet`); } catch {}
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  log('recon-input installed.');
}

function buildDriver() {
  log('Building recon-input from source...');
  try {
    execFileSync('bash', [BUILD_SCRIPT], { cwd: ROOT, stdio: 'inherit' });
  } catch {
    throw new PreflightError(
      'Build failed. Install Xcode command-line tools:\n' +
      '  xcode-select --install\n' +
      'then re-run.'
    );
  }
}

async function ensureDriver(binPath) {
  if (fs.existsSync(binPath)) return;

  if (process.platform !== 'darwin') {
    throw new PreflightError(
      'The OS executor requires macOS. Use --executor cdp on Linux.'
    );
  }

  const choice = await choose(
    'recon-input (the macOS input driver) is not installed. How would you like to install it?',
    [
      { label: 'Download notarized binary from GitHub releases  (recommended)', value: 'download' },
      { label: 'Build from source  (requires Xcode CLI tools: xcode-select --install)', value: 'build' },
    ]
  );

  if (choice.value === 'download') {
    await downloadDriver();
  } else {
    buildDriver();
  }
}

// ── Step 3 — Accessibility permission ────────────────────────────────────────

async function ensureAccessibility(binPath) {
  log('checking Accessibility permission...');
  const trusted = await probeAxTrusted(binPath);
  if (!trusted) {
    throw new PreflightError(
      'Accessibility permission is not granted.\n' +
      'The OS executor drives the real cursor/keyboard and macOS blocks that until\n' +
      'you allow it:\n\n' +
      '  System Settings → Privacy & Security → Accessibility\n' +
      '  → enable Terminal (or whichever app runs Node)\n\n' +
      'Then re-run. (Or switch to CDP: --executor cdp)'
    );
  }
}

// Spawn the helper, send one command, resolve its `data` object (or null on any
// failure/timeout), then tear the child down. For one-shot probes from preflight
// — the long-lived client lives in the executor, not here.
function helperOneShot(binPath, cmd, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { return finish(null); }
    let buf = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, timeoutMs);
    child.stdout.on('data', d => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      let data = null;
      try { const resp = JSON.parse(buf.slice(0, nl)); if (resp.ok === true) data = resp.data || {}; } catch {}
      finish(data);
      try { child.kill(); } catch {}
    });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.stdin.write(JSON.stringify({ id: 'pf', ...cmd }) + '\n');
  });
}

async function probeAxTrusted(binPath) {
  const data = await helperOneShot(binPath, { op: 'axtrusted' });
  return data?.trusted === true;
}

// ── Step 6 — foreground the agent's Chrome ────────────────────────────────────

// The OS executor only sends input while Chrome is the frontmost app. When a run
// reuses an already-running Chrome (or launches one that doesn't grab focus),
// the loop would otherwise sit paused until the user manually clicks the window.
// Bring it forward for them. PID-targeted (not `open -a "Google Chrome"`) so we
// foreground the open-recon instance specifically, never a personal Chrome that
// happens to share the app bundle. Best-effort: any failure just falls back to
// the executor's existing wait-for-frontmost behavior.
async function raiseChrome(binPath) {
  const pid = mainChromePid(DEFAULT_PROFILE_DIR);
  if (!pid) return;   // nothing on the open-recon profile to raise (e.g. a different Chrome owns the port)
  const data = await helperOneShot(binPath, { op: 'raise', pid: Number(pid) });
  if (data?.raised) log('brought the open-recon Chrome window to the foreground.');
}

// ── Step 4 — provider credentials ────────────────────────────────────────────

function readEnvFile() {
  try { return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : ''; } catch { return ''; }
}

function writeKeyToEnvFile(keyName, value) {
  let contents = readEnvFile();
  const re = new RegExp(`^${keyName}=.*$`, 'm');
  if (re.test(contents)) {
    contents = contents.replace(re, `${keyName}=${value}`);
  } else {
    contents = contents.trimEnd() + `\n${keyName}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, contents);
}

async function ensureCreds(provider) {
  if (provider === 'ollama') return;
  const keyName = KEY_FOR[provider];
  if (!keyName) return;

  if (process.env[keyName]) {
    // Warn if shell env is shadowing a different value in .env — a stale
    // exported key otherwise keeps winning even after .env is updated.
    const fileContents = readEnvFile();
    const match = fileContents.match(new RegExp(`^${keyName}=(.+)$`, 'm'));
    if (match) {
      const fileVal = match[1].trim().replace(/^["']|["']$/g, '');
      if (fileVal && fileVal !== process.env[keyName]) {
        process.stderr.write(
          `[preflight] Warning: ${keyName} in your shell differs from .env.\n` +
          `  Shell value is being used — run \`unset ${keyName}\` if you want .env to win.\n`
        );
      }
    }
    return;
  }

  // Key not in environment at all — prompt and save.
  process.stderr.write(`\n[preflight] ${keyName} is not set.\n`);
  const key = await prompt(`  Enter your ${provider} API key: `);
  if (!key) throw new PreflightError(`${keyName} is required. Add it to .env and retry.`);

  writeKeyToEnvFile(keyName, key);
  process.env[keyName] = key;
  log(`${keyName} saved to .env.`);
}

// ── Step 5 — Chrome ───────────────────────────────────────────────────────────

async function ensureChrome(port) {
  if (await isRunning(port)) return;
  log(`Chrome not running on port ${port} — launching...`);
  await launch({ port });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function preflight({ config, port = 9222, verbose = false } = {}) {
  ensureEnvFile();
  ensureDeps();

  const isOs = config.executor?.backend === 'os';
  const binPath = config.executor?.binPath || BIN_PATH;
  if (isOs) {
    await ensureDriver(binPath);
    await ensureAccessibility(binPath);
  }

  await ensureCreds(config.provider);
  await ensureChrome(port);

  // Only meaningful for the os backend (cdp drives input over the wire and needs
  // no foreground); opt out via executor.raiseChromeOnStart: false.
  if (isOs && config.executor?.raiseChromeOnStart !== false) {
    await raiseChrome(binPath);
  }

  log('ready.');
}

module.exports = { preflight, PreflightError };
