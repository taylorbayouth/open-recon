'use strict';

const { spawn } = require('child_process');
const { existsSync } = require('fs');
const { execSync } = require('child_process');
const os = require('os');
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
  return pages[0];
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

  const userDataDir = opts.userDataDir || `${os.homedir()}/.chrome-agent`;
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    // Hides the navigator.webdriver bit that some detection libraries probe
    // for even when only --remote-debugging-port is set.
    '--disable-blink-features=AutomationControlled',
    ...(opts.headless ? ['--headless=new', '--disable-gpu', '--no-sandbox'] : []),
    ...(opts.extraArgs || []),
  ];

  const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
  child.unref();

  const ready = await waitForReady(port, opts.timeout || 10000);
  if (!ready) {
    throw new Error(
      `Chrome did not respond within ${opts.timeout || 10000}ms. Path: ${chromePath}`
    );
  }
}

module.exports = { launch, isRunning, waitForReady, findChromePath, getActiveTabUrl, getTarget };
