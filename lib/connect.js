'use strict';

const CDP = require('chrome-remote-interface');
const { getTarget } = require('./launch');
const { performExtract } = require('./extract');

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
    result.url = this._target.url;
    result.title = this._target.title;
    return result;
  }

  // Wait for the page to be visually/structurally stable after an action.
  // Slice 1 implementation: a fixed quiet wait, capped at maxMs. The seam is
  // in place for slice 2+ to layer in Page.lifecycleEvent listening and an
  // AX-tree-quiet check. See DESIGN.md § Settle contract.
  async settle(opts = {}) {
    const start = Date.now();
    const quietMs = opts.quietMs ?? 150;
    const maxMs = opts.maxMs ?? 2000;
    const wait = Math.min(quietMs, maxMs);
    await new Promise(r => setTimeout(r, wait));
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
