'use strict';

const CDP = require('chrome-remote-interface');
const { getTarget } = require('./launch');
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
