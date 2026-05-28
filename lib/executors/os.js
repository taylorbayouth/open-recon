'use strict';

// OS executor — drives the actual macOS mouse cursor and keyboard via a long-
// lived `recon-input` Swift helper. CGEvents are posted at the HID layer, so
// in-page JS sees `isTrusted: true` events with real timing and (when
// configured) humanlike motion. This is the path designed to avoid bot
// detection.
//
// Requires:
//   - macOS
//   - The `recon-input` binary built once via native/macos/recon-input/build.sh
//   - Accessibility permission for the calling process (Terminal, Node, etc.)
//     in System Settings → Privacy & Security → Accessibility.
//
// Communication: newline-delimited JSON over stdin/stdout.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ensureInView, normalizeUrl } = require('./page');

const DEFAULT_BIN = path.resolve(__dirname, '..', '..', 'native', 'macos', 'recon-input', 'bin', 'recon-input');

const DEFAULT_HUMANIZE = {
  enabled: true,
  mouseSpeedPxPerSec: 1400,
  mouseJitterPx: 2,
  keystrokeDelayMsMin: 25,
  keystrokeDelayMsMax: 85,
  preClickPauseMsMin: 40,
  preClickPauseMsMax: 160,
};

function mergeHumanize(opts) {
  return { ...DEFAULT_HUMANIZE, ...(opts || {}) };
}

function bboxArrToObj(bbox) {
  if (!bbox) return null;
  if (Array.isArray(bbox)) return { x: bbox[0], y: bbox[1], width: bbox[2], height: bbox[3] };
  return bbox;
}

function elementByRef(brief, ref) {
  return brief.elements?.find(e => e.ref === ref) ?? null;
}

// selectText targets text (@t) or element (@e) refs, so look in both arrays.
function nodeByRef(brief, ref) {
  return brief.elements?.find(n => n.ref === ref)
    ?? brief.text?.find(n => n.ref === ref)
    ?? null;
}

// Chrome's bundle ids across channels (+ Chromium). Frontmost must be one of
// these before we post any OS input.
const CHROME_BUNDLES = new Set([
  'com.google.Chrome', 'com.google.Chrome.beta', 'com.google.Chrome.dev',
  'com.google.Chrome.canary', 'org.chromium.Chromium',
]);

// Hard safety gate for the OS backend. CGEvents land on whatever app is in the
// foreground, so if focus has left Chrome — the user alt-tabbed, a dialog stole
// focus, Chrome was minimized — sending a click/keystroke/drag would act on
// some *other* app. We refuse, and mark the error `fatal` so the dispatcher
// aborts the whole run instead of retrying the action into the wrong window.
async function ensureFrontmost(client) {
  let info;
  try {
    info = await client.send({ op: 'frontapp' });
  } catch (err) {
    const e = new Error(`aborted: could not confirm Chrome is frontmost (${err.message}); refusing to send OS input`);
    e.fatal = true;
    throw e;
  }
  if (!CHROME_BUNDLES.has(info?.bundleId)) {
    const front = info?.name || info?.bundleId || 'unknown';
    const e = new Error(`aborted: Chrome is not the frontmost app (foreground: ${front}); refusing to send OS-level input to another application`);
    e.fatal = true;
    throw e;
  }
}

// Long-lived stdin/stdout JSON-RPC client for the Swift helper.
class ReconInputClient {
  constructor(binPath) {
    this.binPath = binPath;
    this.child = null;
    this.buf = '';
    this.pending = new Map();
    this.seq = 0;
    this.closed = false;
  }

  async init() {
    if (this.child) return;
    if (process.platform !== 'darwin') {
      throw new Error('OS executor requires macOS');
    }
    if (!fs.existsSync(this.binPath)) {
      throw new Error(
        `recon-input binary not found at ${this.binPath}. ` +
        `Build it once with: bash native/macos/recon-input/build.sh`
      );
    }
    this.closed = false;  // fresh spawn — clear any closed flag from a prior close()/exit
    this.child = spawn(this.binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.stderr.on('data', (chunk) => process.stderr.write(`[recon-input] ${chunk}`));
    this.child.on('exit', (code) => {
      this.closed = true;
      const err = new Error(`recon-input exited (code=${code})`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
    // Sanity ping — also surfaces a clear error if Accessibility perms missing.
    // On failure, tear down the child we just spawned so a failed init doesn't
    // leak a recon-input process.
    try {
      await this.send({ op: 'ping' });
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const id = msg.id;
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      if (msg.ok) p.resolve(msg.data || {});
      else        p.reject(new Error(msg.error || 'recon-input error'));
    }
  }

  // timeoutMs bounds how long we wait for a reply. Without it, a helper that
  // accepts a command but never replies (wedged CGEvent, a reply line dropped
  // by _onData's JSON guard) would leave the promise pending forever and hang
  // the whole agent loop. Generous default so legitimate long `type` ops don't
  // trip it; a truly-stuck helper still fails instead of hanging indefinitely.
  send(cmd, timeoutMs = 60000) {
    if (this.closed) return Promise.reject(new Error('recon-input is closed'));
    if (!this.child) return Promise.reject(new Error('recon-input not initialized'));
    const id = String(++this.seq);
    const payload = JSON.stringify({ id, ...cmd }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`recon-input timed out after ${timeoutMs}ms (op=${cmd.op})`));
        }
      }, timeoutMs);
      timer.unref?.();
      // Wrap settlers so the timer is always cleared, whether the reply arrives
      // via _onData, the exit handler, or close().
      const wrap = (fn) => (val) => { clearTimeout(timer); fn(val); };
      const settle = { resolve: wrap(resolve), reject: wrap(reject) };
      this.pending.set(id, settle);
      this.child.stdin.write(payload, (err) => {
        if (err && this.pending.delete(id)) settle.reject(err);
      });
    });
  }

  async close() {
    // Mark closed and reject any in-flight sends so awaiters don't hang past
    // shutdown; the exit handler does the same, but close() may run first.
    this.closed = true;
    const err = new Error('recon-input is closed');
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    if (this.child) {
      try { this.child.stdin.end(); } catch {}
      this.child = null;
    }
  }
}

// Translate a page-coordinate point (CSS pixels, relative to the top-left of
// the document) into a screen point CGEventPost can dispatch to.
//
// Visualization:
//
//                ┌───── window.left
//                │              ┌────── chromeOffsetX (≈ 0)
//                ▼              ▼
//     ┌──────────────────────────────────┐ ◀── window.top
//     │   ▒▒▒▒▒ title / tabs / URL ▒▒▒▒▒  │ ◀── chromeOffsetY = window.height
//     │   ▒▒▒▒▒▒▒▒▒ bookmarks ▒▒▒▒▒▒▒▒▒▒  │                    - viewport.height
//     ├──────────────────────────────────┤
//     │                                  │ ◀── viewport top, where pageY = 0
//     │     ┌──────────────┐             │      (after subtracting scrollY)
//     │     │   target     │             │
//     │     └──────────────┘             │
//     │                                  │
//     └──────────────────────────────────┘
//
// Formula:    screen = window.origin + chromeOffset + (pagePoint - scroll)
//
// All values are in CSS-pixel-equivalent points:
//   - Browser.getWindowBounds returns DIPs (device-independent points).
//   - cssVisualViewport.{client,page}* are in CSS pixels.
//   - CGEvent takes screen points.
// On macOS, all three units are 1:1 (retina scaling happens below this
// layer), so no devicePixelRatio multiplication is needed.
//
// We recompute the chrome offset on every dispatch instead of measuring it
// once: it changes when the user toggles the bookmarks bar, enters/exits
// fullscreen, or zooms. Cost is one CDP round-trip per click — negligible
// next to the humanlike mouse-move that follows.
async function pageToScreen(session, pageX, pageY) {
  const client = session.client;
  const { targetInfos } = await client.Target.getTargets();
  const tabId = session._target?.id;
  const targetInfo = targetInfos.find(t => t.targetId === tabId) || targetInfos.find(t => t.type === 'page');

  let windowBounds;
  try {
    const { windowId } = await client.Browser.getWindowForTarget(
      targetInfo ? { targetId: targetInfo.targetId } : {}
    );
    const r = await client.Browser.getWindowBounds({ windowId });
    windowBounds = r.bounds;
  } catch (err) {
    throw new Error(`Browser.getWindowBounds failed: ${err.message}`);
  }

  const metrics = await client.Page.getLayoutMetrics();
  // Prefer the `css*` variants on modern Chrome; fall back for older builds.
  // `layout` gives us scroll position (pageX/pageY) in page coordinates;
  // `visual` gives us the rendered viewport size inside the OS window.
  const layout = metrics.cssLayoutViewport || metrics.layoutViewport || {};
  const visual = metrics.cssVisualViewport || metrics.visualViewport || {};

  // Derive the chrome offset by subtraction. Chrome doesn't expose
  // "title bar height + tab strip height + URL bar height + bookmarks bar"
  // as a single value, but the difference between the OS window and the
  // rendered viewport must be exactly that. The `88` fallback is a sensible
  // default for a normal Chrome window with the bookmarks bar visible — it
  // only kicks in if Chrome returns no viewport metrics at all.
  const cssViewportWidth  = visual.clientWidth  ?? layout.clientWidth  ?? windowBounds.width;
  const cssViewportHeight = visual.clientHeight ?? layout.clientHeight ?? (windowBounds.height - 88);
  const chromeOffsetY = Math.max(0, windowBounds.height - cssViewportHeight);
  const chromeOffsetX = Math.max(0, windowBounds.width  - cssViewportWidth);

  const scrollX = layout.pageX ?? 0;
  const scrollY = layout.pageY ?? 0;

  const screen = {
    x: windowBounds.left + chromeOffsetX + (pageX - scrollX),
    y: windowBounds.top  + chromeOffsetY + (pageY - scrollY),
  };

  // Set RECON_DEBUG_COORDS=1 to dump the raw numbers behind each mapping. Used
  // to diagnose cursor-offset bugs on scaled / Retina displays, where CSS px
  // and screen points may not be 1:1 (the formula above assumes they are).
  if (process.env.RECON_DEBUG_COORDS) {
    let dpr = null;
    try {
      const r = await client.Runtime.evaluate({ expression: 'window.devicePixelRatio', returnByValue: true });
      dpr = r?.result?.value ?? null;
    } catch {}
    console.error('[coords] ' + JSON.stringify({
      page: { x: Math.round(pageX), y: Math.round(pageY) },
      windowBounds,
      cssViewport: { w: cssViewportWidth, h: cssViewportHeight },
      chromeOffset: { x: chromeOffsetX, y: chromeOffsetY },
      scroll: { x: scrollX, y: scrollY },
      devicePixelRatio: dpr,
      screen: { x: Math.round(screen.x), y: Math.round(screen.y) },
    }));
  }

  return screen;
}

function jitterPause(humanize) {
  if (!humanize.enabled) return 0;
  const lo = Math.max(0, humanize.preClickPauseMsMin);
  const hi = Math.max(lo, humanize.preClickPauseMsMax);
  return lo === hi ? lo : lo + Math.floor(Math.random() * (hi - lo + 1));
}

async function click({ session, brief, ref, client, humanize }) {
  await ensureFrontmost(client);
  const el = elementByRef(brief, ref);
  if (!el) throw new Error(`element ${ref} not found in brief`);
  const bbox = bboxArrToObj(el.bbox);
  if (!bbox) throw new Error(`element ${ref} has no bbox`);

  // Target = geometric center of the element's bbox. This is the right answer
  // for ~all interactive elements: buttons, links, inputs, checkboxes — the
  // center is always inside the hit region. It can be wrong for two cases
  // we don't currently handle:
  //   1. Very large containers whose center sits over a non-interactive
  //      child overlay (a hero banner with a small inset CTA).
  //   2. Elements partially scrolled off-screen, where the center falls
  //      outside the viewport. The OS would still post the event, but the
  //      cursor would move outside the visible window.
  // If either becomes a problem, use DOM.getContentQuads to get the actual
  // hit polygon and aim at a point clamped to the visible portion.
  //
  // With humanize on, we jitter the aim by ±min(dim, 8)/2 — enough that
  // back-to-back clicks on the same element don't land on identical pixels
  // (a strong bot signal), but small enough to stay within the bbox.
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  const aimX = humanize.enabled ? cx + (Math.random() - 0.5) * Math.min(bbox.width, 8) : cx;
  const aimY = humanize.enabled ? cy + (Math.random() - 0.5) * Math.min(bbox.height, 8) : cy;

  // Scroll the target in if its center is off-viewport. pageToScreen reads live
  // scroll, so after this the page-coordinate aim maps to the right screen point.
  await ensureInView({ session, brief, ref });
  const screen = await pageToScreen(session, aimX, aimY);

  await client.send({
    op: 'move',
    x: screen.x, y: screen.y,
    speedPxPerSec: humanize.enabled ? humanize.mouseSpeedPxPerSec : 1e9,
    jitterPx: humanize.enabled ? humanize.mouseJitterPx : 0,
  });

  const pause = jitterPause(humanize);
  if (pause > 0) await new Promise(r => setTimeout(r, pause));

  // Re-check after the move: focus may have changed during cursor travel. This
  // is the last gate before the actual button press lands on the foreground.
  await ensureFrontmost(client);
  await client.send({ op: 'click', button: 'left' });
}

// Select the whole node by click-dragging from its top-left to its bottom-right
// corner. Mouse down at the start anchors the selection; the move (posted as a
// drag because the button is held — see recon-input's leftButtonDown handling)
// extends it to the end; up commits. Covers every line between the corners.
async function selectText({ session, brief, ref, client, humanize }) {
  await ensureFrontmost(client);
  const node = nodeByRef(brief, ref);
  if (!node) throw new Error(`node ${ref} not found in brief`);
  const bbox = bboxArrToObj(node.bbox);
  if (!bbox) throw new Error(`node ${ref} has no bbox`);

  await ensureInView({ session, brief, ref });
  const start = await pageToScreen(session, bbox.x + 1, bbox.y + 1);
  const end = await pageToScreen(session, bbox.x + bbox.width - 1, bbox.y + bbox.height - 1);
  const speed = humanize.enabled ? humanize.mouseSpeedPxPerSec : 1e9;
  const jitter = humanize.enabled ? humanize.mouseJitterPx : 0;

  await client.send({ op: 'move', x: start.x, y: start.y, speedPxPerSec: speed, jitterPx: jitter });
  const pause = jitterPause(humanize);
  if (pause > 0) await new Promise(r => setTimeout(r, pause));
  // Last gate before mouse-down begins the drag — see click().
  await ensureFrontmost(client);
  await client.send({ op: 'down', button: 'left' });
  await client.send({ op: 'move', x: end.x, y: end.y, speedPxPerSec: speed, jitterPx: jitter });
  await client.send({ op: 'up', button: 'left' });
}

async function type({ session, brief, ref, text, client, humanize }) {
  // Most reliable path: click to focus, then type. CDP's DOM.focus is faster
  // but it bypasses focus side effects (selection clearing, value committing)
  // that real keyboard focus triggers — which defeats the point of OS-level
  // input. Clicking via the same humanized path keeps the fingerprint clean.
  await click({ session, brief, ref, client, humanize });  // checks frontmost itself
  await ensureFrontmost(client);  // re-check before keystrokes land
  await client.send({
    op: 'type',
    text,
    delayMsMin: humanize.enabled ? humanize.keystrokeDelayMsMin : 0,
    delayMsMax: humanize.enabled ? humanize.keystrokeDelayMsMax : 0,
  });
}

// Map direction+amount → CGEvent scroll-wheel deltas. NOTE: CGEvent wheel sign
// is the OS gesture direction, the opposite of the DOM wheel convention the cdp
// backend uses — a negative wheel1 scrolls the page content down. This assumes
// the default (non-"natural") scroll setting and should be verified on real
// macOS; flip the signs if it scrolls the wrong way.
function osScrollDeltas(direction, amount, viewport) {
  const vw = viewport?.width ?? 1280;
  const vh = viewport?.height ?? 800;
  const step = (dim) => (amount != null ? amount : Math.round(dim * 0.85));
  const dir = String(direction || '').toLowerCase();
  switch (dir) {
    case 'up':    return { dx: 0, dy: step(vh) };
    case 'left':  return { dx: step(vw), dy: 0 };
    case 'right': return { dx: -step(vw), dy: 0 };
    case 'down':  return { dx: 0, dy: -step(vh) };
    default:      throw new Error(`unknown scroll direction "${direction}" (expected: up, down, left, right)`);
  }
}

async function scroll({ session, brief, direction, amount, client, humanize }) {
  await ensureFrontmost(client);
  const vp = brief.viewport || {};
  // Park the cursor over the page center first so the wheel lands on content,
  // not the browser chrome (scroll posts at the current cursor position).
  const pageCenterX = (vp.scrollX ?? 0) + (vp.width ?? 0) / 2;
  const pageCenterY = (vp.scrollY ?? 0) + (vp.height ?? 0) / 2;
  const screen = await pageToScreen(session, pageCenterX, pageCenterY);
  await client.send({
    op: 'move',
    x: screen.x, y: screen.y,
    speedPxPerSec: humanize.enabled ? humanize.mouseSpeedPxPerSec : 1e9,
    jitterPx: humanize.enabled ? humanize.mouseJitterPx : 0,
  });
  const { dx, dy } = osScrollDeltas(direction, amount, vp);
  await ensureFrontmost(client);  // last gate before the wheel event lands
  await client.send({ op: 'scroll', dx, dy });
}

async function press({ key, client }) {
  await ensureFrontmost(client);
  await client.send({ op: 'key', key: String(key) });
}

async function navigate({ url, client, humanize }) {
  const u = normalizeUrl(url);
  await ensureFrontmost(client);
  await client.send({ op: 'key', key: 'l', modifiers: ['cmd'] });
  await client.send({
    op: 'type',
    text: u,
    delayMsMin: humanize.enabled ? humanize.keystrokeDelayMsMin : 0,
    delayMsMax: humanize.enabled ? humanize.keystrokeDelayMsMax : 0,
  });
  await ensureFrontmost(client);
  await client.send({ op: 'key', key: 'return' });
}

function create(opts = {}) {
  const binPath = opts.binPath || DEFAULT_BIN;
  const humanize = mergeHumanize(opts.humanize);
  const client = new ReconInputClient(binPath);

  return {
    name: 'os',
    async init() { await client.init(); },
    async close() { await client.close(); },
    click:  (args) => click({ ...args, client, humanize }),
    selectText: (args) => selectText({ ...args, client, humanize }),
    type:   (args) => type({ ...args, client, humanize }),
    scroll: (args) => scroll({ ...args, client, humanize }),
    press:  (args) => press({ ...args, client }),
    navigate: (args) => navigate({ ...args, client, humanize }),
  };
}

module.exports = { create, DEFAULT_HUMANIZE };
