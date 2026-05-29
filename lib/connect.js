'use strict';

const CDP = require('chrome-remote-interface');
const { getTarget } = require('./launch');
const { performExtract } = require('./extract');
const { loadConfig } = require('./config');

// Pure tab-following policy. Given the live page targets and what we last saw,
// decide which target the session should pin to — returns a targetId, or null
// to stay put. Deterministic and cross-platform: it reads CDP's own target
// graph (openerId) instead of guessing from OS window focus.
//
//   - current tab still open, and it opened a popup/tab (openerId === current):
//     follow the newest child. window.open keeps openerId, and OAuth popups
//     MUST (they postMessage their result back to window.opener), so this nails
//     the sign-in-popup case on every platform.
//   - current still open, no child, but a brand-new target appeared since last
//     poll (e.g. target=_blank rel=noopener, which severs openerId): follow it.
//     Gated on having a baseline so the first poll doesn't jump to a pre-existing
//     background tab.
//   - current tab gone (popup/tab closed): return to its opener if still around
//     (the OAuth return trip), else the newest remaining page.
function chooseTab({ pages, currentId, openerId, knownIds }) {
  if (!pages.length) return null;
  const current = pages.find(p => p.targetId === currentId);
  if (current) {
    const children = pages.filter(p => p.openerId === currentId);
    if (children.length) return children[children.length - 1].targetId;
    if (knownIds && knownIds.size) {
      const fresh = pages.filter(p => p.targetId !== currentId && !knownIds.has(p.targetId));
      if (fresh.length) return fresh[fresh.length - 1].targetId;
    }
    return null;
  }
  const opener = openerId && pages.find(p => p.targetId === openerId);
  return (opener || pages[pages.length - 1]).targetId;
}

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
    // Tab-following state (see chooseTab + followActiveTab): the targets we've
    // seen so far, and the opener of the tab we're currently pinned to.
    this._knownTargetIds = new Set();
    this._openerId = null;
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

  // Re-pin the session to the tab where the last action actually landed. A click
  // that opens a popup or new tab (sign-in flows do this constantly) leaves the
  // CDP session bound to the *original* tab, so every later extract reads a stale
  // page — the agent then re-clicks and spawns yet more popups, never seeing the
  // login window. We read the live target graph (Target.getTargets exposes
  // openerId) and let chooseTab decide where to go. Returns true if it switched.
  async followActiveTab() {
    const port = this._opts.port || 9222;
    let infos;
    try {
      ({ targetInfos: infos } = await this._client.Target.getTargets());
    } catch {
      return false;
    }
    const pages = (infos || []).filter(t => t.type === 'page');
    const currentId = this._target.id;
    const desiredId = chooseTab({ pages, currentId, openerId: this._openerId, knownIds: this._knownTargetIds });
    // Refresh the baseline every poll so "appeared since last time" stays honest.
    this._knownTargetIds = new Set(pages.map(p => p.targetId));

    if (!desiredId || desiredId === currentId) return false;
    const desired = pages.find(p => p.targetId === desiredId);

    try { await this._client.close(); } catch {}
    this._axEnabled = false;
    this._openerId = desired.openerId || null;
    this._target = { id: desired.targetId, url: desired.url, title: desired.title, type: desired.type };
    this._client = await CDP({ target: desiredId, port });   // CRI resolves a bare target id
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

module.exports = { connect, Session, chooseTab };
