'use strict';

// CDP-only page commands.

// Bounded wait for the page's load event after a full navigation. A navigate
// (address-bar) always triggers a real document load, so Page.loadEventFired is
// the browser-authoritative signal that the next snapshot won't catch a blank /
// still-parsing page. Bounded by a timeout because some pages never fully
// quiesce (long-polling, websockets, beacons) or never fire load — a slow load
// must not stall the agent. Default 5s; override with OPEN_RECON_NAV_TIMEOUT_MS.
const NAV_LOAD_TIMEOUT_MS = Number(process.env.OPEN_RECON_NAV_TIMEOUT_MS) || 5000;

// Resolve on the next Page.loadEventFired, or after `timeoutMs` — whichever is
// first. Never rejects: this only bounds how long we block, it must not turn a
// slow load into a failed navigate. The caller MUST construct this (which arms
// the listener) BEFORE triggering the navigation; arming after the trigger races
// a fast load and would wait out the whole timeout for nothing.
function waitForLoad(client, timeoutMs = NAV_LOAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.removeListener('Page.loadEventFired', onLoad); } catch {}
      resolve(reason);
    };
    const onLoad = () => finish('load');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    timer.unref?.();
    client.on('Page.loadEventFired', onLoad);
  });
}

// One-shot readiness wait for the page the agent connects to on turn 1. There's
// no navigation to arm a listener ahead of — the page may already be loaded, in
// which case loadEventFired will never fire again — so we check readyState first
// and only fall back to the (bounded) load-event wait when it's still loading.
// Best-effort: a client without the Page/Runtime domains (e.g. a test double)
// returns 'unsupported' rather than throwing. Returns the reason for logging.
async function waitUntilLoaded(client, timeoutMs = NAV_LOAD_TIMEOUT_MS) {
  if (typeof client?.Page?.enable !== 'function') return 'unsupported';
  await client.Page.enable();
  let state = null;
  try {
    const r = await client.Runtime.evaluate({ expression: 'document.readyState', returnByValue: true });
    state = r?.result?.value ?? null;
  } catch { /* readyState unreadable — fall through to the load-event wait */ }
  if (state === 'complete') return 'already-complete';
  return waitForLoad(client, timeoutMs);
}

// Navigate the current tab to a URL via CDP. A bare host like "example.com" gets
// an https:// scheme prepended so the model doesn't have to remember it.
function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) throw new Error('navigate requires a url');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

// Page.navigate resolves on *commit* (first bytes), not load. Arm the load wait
// first, trigger the navigation, then block on the load event (bounded) so the
// next snapshot sees a loaded document instead of a blank / parsing one.
async function navigate({ session, url }) {
  const u = normalizeUrl(url);
  const client = session.client;
  await client.Page.enable();
  const loaded = waitForLoad(client);
  await client.Page.navigate({ url: u });
  const reason = await loaded;
  if (process.env.RECON_DEBUG_NAV) console.error(`[nav] ${u} → ${reason}`);
}

function bbox(node) {
  const b = node?.bbox;
  if (!b) return null;
  return Array.isArray(b) ? { x: b[0], y: b[1], width: b[2], height: b[3] } : b;
}

// Ensure the ref's element is within the viewport, scrolling it in if its center
// has fallen outside (inViewportOnly only requires *intersection*, so a node can
// be in the brief with its clickable center below the fold — which is how we got
// a cursor driven off the page). Returns the LIVE scroll offset after any scroll,
// so callers using page-coordinate bboxes compute correct positions. The os
// backend reads live scroll in pageToScreen and can ignore the return; the cdp
// backend needs it because it subtracts scroll from page coords itself.
//
// Fast path: when the center is already in view, no DOM work — just hand back the
// brief's own scroll offset, so the common case stays a no-op.
async function ensureInView({ session, brief, ref }) {
  const node = (brief.elements || []).find(n => n.ref === ref)
    || (brief.text || []).find(n => n.ref === ref);
  const b = bbox(node);
  const vp = brief.viewport || {};
  const sx = vp.scrollX ?? 0, sy = vp.scrollY ?? 0;

  if (b) {
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const inX = cx >= sx && cx <= sx + (vp.width ?? Infinity);
    const inY = cy >= sy && cy <= sy + (vp.height ?? Infinity);
    if (inX && inY) return { scrollX: sx, scrollY: sy, scrolled: false };
  }

  const backendNodeId = brief.lookup?.[ref];
  if (typeof backendNodeId !== 'number') return { scrollX: sx, scrollY: sy, scrolled: false };

  const client = session.client;
  await client.DOM.enable();
  await client.DOM.getDocument();
  const { nodeIds } = await client.DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds: [backendNodeId] });
  const nodeId = nodeIds?.[0];
  if (!nodeId) return { scrollX: sx, scrollY: sy, scrolled: false };

  try { await client.DOM.scrollIntoViewIfNeeded({ nodeId }); } catch {}
  const m = await client.Page.getLayoutMetrics();
  const lv = m.cssLayoutViewport || m.layoutViewport || {};
  return { scrollX: lv.pageX ?? sx, scrollY: lv.pageY ?? sy, scrolled: true };
}

module.exports = { navigate, ensureInView, normalizeUrl, waitForLoad, waitUntilLoaded, NAV_LOAD_TIMEOUT_MS };
