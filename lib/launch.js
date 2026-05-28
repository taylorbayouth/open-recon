'use strict';

const { spawn, execFileSync } = require('child_process');
const { existsSync, mkdirSync } = require('fs');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const CDP = require('chrome-remote-interface');

const CHROME_PATHS = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
  win32: [
    `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ].filter(Boolean),
};

function findChromePath() {
  const candidates = CHROME_PATHS[process.platform] || [];
  for (const p of candidates) {
    // Bare names (linux) — check PATH
    if (!p.includes('/') && !p.includes('\\')) {
      try { execSync(`which ${p}`, { stdio: 'ignore' }); return p; } catch {}
    } else if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

async function isRunning(port = 9222) {
  try { await CDP.List({ port }); return true; } catch { return false; }
}

async function waitForReady(port = 9222, maxMs = 10000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await isRunning(port)) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

// Returns the URL of the frontmost Chrome tab. macOS only; returns null elsewhere.
function getActiveTabUrl() {
  if (process.platform !== 'darwin') return null;
  try {
    return execSync(
      `osascript -e 'tell application "Google Chrome" to get URL of active tab of front window'`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim() || null;
  } catch {
    return null;
  }
}

async function getTarget(opts = {}) {
  const port = opts.port || 9222;
  const targets = await CDP.List({ port });
  const pages = targets.filter(t => t.type === 'page');
  if (!pages.length) {
    throw new Error(
      `No page targets found on port ${port}. ` +
      'Is Chrome running with --remote-debugging-port?'
    );
  }
  if (opts.url) {
    const match = pages.find(t => t.url.includes(opts.url));
    if (!match) throw new Error(`No tab found matching URL: ${opts.url}`);
    return match;
  }
  const activeUrl = getActiveTabUrl();
  if (activeUrl) {
    const match = pages.find(t => t.url === activeUrl);
    if (match) return match;
  }
  if (pages.length > 1) {
    process.stderr.write(
      `[connect] ${pages.length} tabs open and active-tab detection failed — ` +
      `targeting the first CDP page target. Pass a URL via opts.url to be explicit.\n`
    );
  }
  return pages[0];
}

// PIDs of Chrome processes launched against a SPECIFIC profile dir. We match on
// the --user-data-dir argument rather than the app name, because the user's
// everyday Chrome and our isolated profile are the same binary ("Google Chrome")
// — a name-based match would sweep up (and quit) the personal browser too. Only
// the main browser process carries --user-data-dir in its argv (renderer/GPU
// helpers don't), so this matches just the instance owning that profile.
function chromePidsForProfile(userDataDir) {
  if (process.platform !== 'darwin') return [];
  try {
    // pgrep -f matches against the full command line. execFileSync (no shell)
    // sidesteps quoting issues if the path contains spaces. Exit 1 = no match.
    const out = execFileSync('pgrep', ['-f', `--user-data-dir=${userDataDir}`], { encoding: 'utf8' });
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Quit only the Chrome instance bound to `userDataDir`: SIGTERM (Chrome shuts
// down gracefully on it), wait up to maxMs, then SIGKILL any stragglers. Leaves
// every other Chrome — notably the user's personal browser — untouched.
async function quitChromeProfile(userDataDir, maxMs = 5000) {
  const pids = chromePidsForProfile(userDataDir);
  if (!pids.length) return;
  for (const pid of pids) { try { process.kill(Number(pid), 'SIGTERM'); } catch {} }
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!chromePidsForProfile(userDataDir).length) return;
    await new Promise(r => setTimeout(r, 200));
  }
  for (const pid of chromePidsForProfile(userDataDir)) {
    try { process.kill(Number(pid), 'SIGKILL'); } catch {}
  }
  await new Promise(r => setTimeout(r, 500));
}

async function launch(opts = {}) {
  const port = opts.port || 9222;
  if (await isRunning(port)) return;

  const chromePath = opts.executablePath || findChromePath();
  if (!chromePath) {
    throw new Error(
      'Could not find Chrome. Install Google Chrome or set opts.executablePath.'
    );
  }

  const userDataDir = opts.userDataDir || path.join(os.homedir(), '.open-recon', 'profile');

  // Chrome allows only one process per --user-data-dir. If an instance is
  // already running on OUR profile but isn't listening on the debug port (a
  // crashed prior run, or one launched without the flag), spawning again gets
  // folded into that process and the new --remote-debugging-port is ignored — so
  // the port never opens. Quit *that* instance (only it) and start fresh. The
  // user's personal Chrome runs a different profile, so it's left alone.
  if (chromePidsForProfile(userDataDir).length) {
    process.stderr.write(
      '[preflight] open-recon Chrome is running without the debug port — restarting with --remote-debugging-port...\n'
    );
    await quitChromeProfile(userDataDir);
  }

  // First launch with this profile? Chrome creates the dir on start, so its
  // absence means a brand-new, logged-out profile — tell the user once so the
  // empty session state isn't a surprise, and that signing in here persists.
  const firstRun = !existsSync(userDataDir);
  mkdirSync(userDataDir, { recursive: true });
  if (firstRun) {
    process.stderr.write(
      '[open-recon] First run — launching an isolated Chrome profile at:\n' +
      `  ${userDataDir}\n` +
      'This browser is separate from your everyday Chrome and starts logged OUT\n' +
      'of everything. Sign in to the sites your task needs once, in this window,\n' +
      'and those sessions persist across runs. Delete that folder to reset.\n'
    );
  }

  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    // NOTE: we deliberately do NOT pass --disable-blink-features=AutomationControlled.
    // navigator.webdriver is only true when Chrome is launched with --enable-automation
    // (which we never set), so with a bare --remote-debugging-port it's already false —
    // verified empirically. The flag's only observable effect was Chrome's "unsupported
    // command-line flag" warning bar, which shifts layout and is itself a bot signal.
    ...(opts.headless ? ['--headless=new', '--disable-gpu', '--no-sandbox'] : []),
    ...(opts.extraArgs || []),
  ];

  const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
  child.unref();

  const ready = await waitForReady(port, opts.timeout || 30000);
  if (!ready) {
    throw new Error(
      `Chrome did not respond within ${opts.timeout || 30000}ms. Path: ${chromePath}`
    );
  }
}

module.exports = { launch, isRunning, waitForReady, findChromePath, getActiveTabUrl, getTarget };
