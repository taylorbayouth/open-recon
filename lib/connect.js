'use strict';

const CDP = require('chrome-remote-interface');
const { getTarget, getActiveTabUrl } = require('./launch');
const { performExtract } = require('./extract');
const { loadConfig } = require('./config');

function isConnectionError(err) {
  const msg = err?.message || '';
  return (
    msg.includes('WebSocket') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('Session closed') ||
    msg.includes('Protocol error') ||
    err?.code === 'ECONNREFUSED' ||
    err?.code === 'ECONNRESET'
  );
}

class Session {
  constructor(client, target, opts) {
    this._client = client;
    this._target = target;
    this._opts = opts;
    this._axEnabled = false;
  }

  // Raw CDP client for power users who need direct protocol access.
  get client() { return this._client; }

  async _ensureAxEnabled() {
    if (!this._axEnabled) {
      await this._client.Accessibility.enable();
      this._axEnabled = true;
    }
  }

  async _reconnect() {
    try { await this._client.close(); } catch {}
    this._axEnabled = false;
    this._target = await getTarget(this._opts);
    this._client = await CDP({ target: this._target, port: this._opts.port || 9222 });
    await this._ensureAxEnabled();
  }

  // Re-pin the session to whatever tab is now frontmost. A click that opens a
  // link in a new tab leaves the CDP session bound to the *original* tab, so
  // every later extract reads a stale page that never changes — the agent then
  // re-clicks and spawns yet more tabs. Following the active tab (which the new
  // tab becomes on macOS) keeps perception aligned with where the action landed.
  // Returns true if it switched. macOS-only signal; no-op without an active URL.
  async followActiveTab() {
    const port = this._opts.port || 9222;
    let pages;
    try {
      pages = (await CDP.List({ port })).filter(t => t.type === 'page');
    } catch {
      return false;
    }
    if (!pages.length) return false;

    const activeUrl = getActiveTabUrl();
    let desired = activeUrl ? pages.find(p => p.url === activeUrl) : null;
    // No active-tab signal (non-macOS, or Chrome not frontmost): fall back to
    // the newest page target only when our current one is gone.
    if (!desired) {
      if (pages.some(p => p.id === this._target.id)) return false;
      desired = pages[pages.length - 1];
    }
    if (desired.id === this._target.id) return false;

    try { await this._client.close(); } catch {}
    this._axEnabled = false;
    this._target = desired;
    this._client = await CDP({ target: desired, port });
    await this._ensureAxEnabled();
    return true;
  }

  async extract(opts = {}) {
    const mergedOpts = { ...this._opts, ...opts };
    await this._ensureAxEnabled();
    let result;
    try {
      result = await performExtract(this._client, mergedOpts);
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      await this._reconnect();
      result = await performExtract(this._client, mergedOpts);
    }
    // Refresh url/title from the live target rather than the connect-time
    // snapshot — an in-page navigation changes them, which would otherwise
    // leave every brief reporting the original URL (and feed a stale value
    // into briefHash). Out-of-page (no Runtime.evaluate), so the no-footprint
    // guarantee holds. Falls back to the cached target on any error.
    const { url, title } = await this._currentUrlTitle();
    result.url = url;
    result.title = title;
    return result;
  }

  async _currentUrlTitle() {
    try {
      const { targetInfo } = await this._client.Target.getTargetInfo({ targetId: this._target.id });
      if (targetInfo) {
        this._target.url = targetInfo.url;
        this._target.title = targetInfo.title;
        return { url: targetInfo.url, title: targetInfo.title };
      }
    } catch {}
    return { url: this._target.url, title: this._target.title };
  }

  // Brief pause after an action so the next snapshot isn't taken mid-mutation.
  // This is deliberately small — the loop's change-polling (see lib/loop.js,
  // controlled by config.loop.pollMs) does the real "wait until the page
  // actually changes" work. Defaults come from config.settle; opts override.
  async settle(opts = {}) {
    const cfg = loadConfig().settle;
    const start = Date.now();
    const afterActionMs = opts.afterActionMs ?? cfg.afterActionMs;
    const maxMs = opts.maxMs ?? cfg.maxMs;
    await new Promise(r => setTimeout(r, Math.min(afterActionMs, maxMs)));
    return Date.now() - start;
  }

  async close() {
    if (this._client) {
      try { await this._client.close(); } catch {}
      this._client = null;
    }
  }
}

async function connect(opts = {}) {
  const target = await getTarget(opts);
  const client = await CDP({ target, port: opts.port || 9222 });
  return new Session(client, target, opts);
}

module.exports = { connect, Session };
