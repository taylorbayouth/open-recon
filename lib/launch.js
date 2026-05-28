'use strict';

const { spawn } = require('child_process');
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

// Returns true if a Chrome process is running (with or without the debug port).
function isChromeProcessRunning() {
  if (process.platform !== 'darwin') return false;
  try {
    execSync('pgrep -x "Google Chrome" > /dev/null 2>&1');
    return true;
  } catch {
    return false;
  }
}

// Quit Chrome gracefully (AppleScript), then wait up to maxMs for the process to exit.
async function quitChrome(maxMs = 5000) {
  try {
    execSync(`osascript -e 'quit app "Google Chrome"'`, { stdio: 'ignore' });
  } catch {}
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!isChromeProcessRunning()) return;
    await new Promise(r => setTimeout(r, 200));
  }
  // If still alive after graceful quit, force-kill.
  try { execSync('pkill -x "Google Chrome"', { stdio: 'ignore' }); } catch {}
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

  // If Chrome is already running without the debug port, macOS will hand any
  // new launch attempt to the existing process, which ignores --remote-debugging-port.
  // Quit it first so our spawn starts a fresh instance with the right flags.
  if (isChromeProcessRunning()) {
    process.stderr.write(
      '[preflight] Chrome is running without the debug port — restarting with --remote-debugging-port...\n'
    );
    await quitChrome();
  }

  const userDataDir = opts.userDataDir || path.join(os.homedir(), '.open-recon', 'profile');

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
