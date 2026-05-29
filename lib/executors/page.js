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
//
// Only http/https are allowed. The navigate target can originate from page text
// the model just read (prompt injection: a hostile page says "go to ..."), so we
// must not let it steer the browser into local files or privileged pages —
// file:// (read the user's disk), chrome://, about:, view-source:, data:, etc.
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) throw new Error('navigate requires a url');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
  let parsed;
  try { parsed = new URL(u); } catch { throw new Error(`invalid url: ${url}`); }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(`refusing to navigate to "${parsed.protocol}" — only http/https are allowed`);
  }
  return parsed.href;
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

// click/selectText target text (@t) or element (@e) refs, so look in both.
function nodeByRef(brief, ref) {
  return (brief.elements || []).find(n => n.ref === ref)
    ?? (brief.text || []).find(n => n.ref === ref)
    ?? null;
}

// Roles whose value is free-text the user edits — the only nodes where a
// "clear before type" (select-all) is meaningful and safe. Gating clear on
// these prevents a stray clear:true on a button from issuing a page-wide
// Cmd/Ctrl+A. `combobox` is included: an editable combobox (autocomplete) holds
// a text value; a non-editable one ignores select-all harmlessly.
const TEXT_INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
function isTextInput(node) {
  if (!node) return false;
  if (TEXT_INPUT_ROLES.has(node.role)) return true;
  // A node carrying a string `value` is a filled field even if its role is a
  // custom/non-semantic one (some sites label inputs only via aria).
  return typeof node.value === 'string';
}

// ─── Click targeting ──────────────────────────────────────────────────────────

// A bbox center is the wrong aim point for two real shapes: a large container
// whose center sits over a non-interactive child, and a multi-line inline link
// whose center falls in the gap between its line boxes. DOM.getContentQuads
// returns the element's actual hit polygon(s) — one rect per line box — so we
// can aim inside the real, visible geometry. Coordinates come back relative to
// the layout VIEWPORT (scroll already applied), matching what
// Input.dispatchMouseEvent and DOM.getNodeForLocation expect.
function quadToRect(q) {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function intersectRect(r, vw, vh) {
  const x1 = Math.max(0, r.x), y1 = Math.max(0, r.y);
  const x2 = Math.min(r.x + r.width, vw), y2 = Math.min(r.y + r.height, vh);
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

// Pick the quad with the largest VISIBLE area (clamped to the viewport) so we
// aim at the on-screen part of the element. Fall back to the largest raw quad
// if nothing intersects the viewport (e.g. it couldn't be fully scrolled in) so
// we still aim at real geometry rather than giving up.
function bestQuadRect(quads, vw, vh) {
  if (!Array.isArray(quads) || quads.length === 0) return null;
  const clampable = Number.isFinite(vw) && Number.isFinite(vh);
  let best = null, bestArea = -1, bestRaw = null, bestRawArea = -1;
  for (const q of quads) {
    if (!Array.isArray(q) || q.length < 8) continue;
    const raw = quadToRect(q);
    const rawArea = raw.width * raw.height;
    if (rawArea > bestRawArea) { bestRawArea = rawArea; bestRaw = raw; }
    const clamped = clampable ? intersectRect(raw, vw, vh) : raw;
    const area = clamped.width * clamped.height;
    if (area > bestArea) { bestArea = area; best = clamped; }
  }
  if (best && bestArea > 0) return best;
  return bestRaw;
}

// Resolve a ref to a viewport-relative aim point, scrolling it into view first.
// Returns { x, y, width, height, scrollX, scrollY, backendNodeId, source }, all
// in CSS pixels relative to the layout viewport. Tries the precise content-quad
// path; on any failure — an unsupported CDP call (e.g. the test double), a node
// with no layout — it falls back to the brief's bbox center (the prior behavior),
// so this is a strict accuracy improvement with no new failure modes.
async function clickablePoint({ session, brief, ref }) {
  const client = session.client;
  const backendNodeId = brief.lookup?.[ref];
  const node = nodeByRef(brief, ref);
  const fallback = bbox(node);

  const vp = brief.viewport || {};
  let scrollX = vp.scrollX ?? 0, scrollY = vp.scrollY ?? 0;
  let vw = vp.width ?? Infinity, vh = vp.height ?? Infinity;

  if (typeof backendNodeId === 'number' && client.DOM && client.Page) {
    try {
      await client.DOM.enable();
      await client.DOM.getDocument();
      try { await client.DOM.scrollIntoViewIfNeeded({ backendNodeId }); } catch {}
      // Re-read scroll/viewport AFTER any scroll so the quad coords (which are
      // post-scroll viewport coords) line up with the offsets we report.
      const m = await client.Page.getLayoutMetrics();
      const lv = m.cssLayoutViewport || m.layoutViewport || {};
      scrollX = lv.pageX ?? scrollX;
      scrollY = lv.pageY ?? scrollY;
      vw = lv.clientWidth ?? vw;
      vh = lv.clientHeight ?? vh;
      const { quads } = await client.DOM.getContentQuads({ backendNodeId });
      const rect = bestQuadRect(quads, vw, vh);
      if (rect && rect.width >= 0 && rect.height >= 0) {
        return {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          width: rect.width,
          height: rect.height,
          scrollX, scrollY, backendNodeId, source: 'quad',
        };
      }
    } catch { /* fall through to bbox center */ }
  }

  if (!node) throw new Error(`element ${ref} not found in brief`);
  if (!fallback) throw new Error(`element ${ref} has no bbox`);
  return {
    x: fallback.x + fallback.width / 2 - scrollX,
    y: fallback.y + fallback.height / 2 - scrollY,
    width: fallback.width,
    height: fallback.height,
    scrollX, scrollY, backendNodeId, source: 'bbox',
  };
}

// ─── Hit-test verification ──────────────────────────────────────────────────────

// Walk the (pierced) subtree of `rootBackendId` looking for `needleBackendId`.
// Pure CDP — no page JS — so it preserves the no-footprint perception contract.
async function subtreeContains(client, rootBackendId, needleBackendId) {
  const { node } = await client.DOM.describeNode({ backendNodeId: rootBackendId, depth: -1, pierce: true });
  let found = false;
  (function walk(n) {
    if (!n || found) return;
    if (n.backendNodeId === needleBackendId) { found = true; return; }
    for (const k of n.children || []) walk(k);
    if (n.contentDocument) walk(n.contentDocument);
    for (const sr of n.shadowRoots || []) walk(sr);
  })(node);
  return found;
}

// Build a short, human-readable label for the node intercepting a click, for
// the error the agent sees ("...covered by <div id=cookie-wall>").
async function describeNodeForError(client, backendNodeId) {
  try {
    const { node } = await client.DOM.describeNode({ backendNodeId });
    const tag = String(node.localName || node.nodeName || 'element').toLowerCase();
    const attrs = node.attributes || [];
    const get = (name) => {
      for (let i = 0; i + 1 < attrs.length; i += 2) if (attrs[i] === name) return attrs[i + 1];
      return null;
    };
    const id = get('id'), aria = get('aria-label'), cls = get('class');
    let s = `<${tag}`;
    if (id) s += ` id="${id}"`;
    else if (aria) s += ` aria-label="${aria}"`;
    else if (cls) s += ` class="${String(cls).split(/\s+/).slice(0, 2).join(' ')}"`;
    return s + '>';
  } catch {
    return 'another element';
  }
}

// Confirm the topmost node at (x,y) — viewport coords — is the target ref or in
// its subtree (or vice-versa: the target is inside the painted node, e.g. a
// styled child). If a wholly unrelated node is on top — a modal, cookie wall,
// sticky overlay — the click would be intercepted, so throw a NON-FATAL error:
// executeAction turns it into an error Observation and the loop re-plans (e.g.
// dismiss the overlay) instead of clicking into the void.
//
// Fail-open everywhere: if the verification machinery itself is unavailable
// (test double) or errors (point off the render surface, OOPIF, describeNode
// unsupported), we proceed with the click rather than block a valid action.
async function assertHittable({ session, brief, ref, x, y }) {
  const client = session.client;
  const targetId = brief.lookup?.[ref];
  if (typeof targetId !== 'number') return;
  if (!client.DOM || typeof client.DOM.getNodeForLocation !== 'function') return;

  let hit;
  try {
    hit = await client.DOM.getNodeForLocation({
      x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false,
    });
  } catch { return; }

  const hitId = hit?.backendNodeId;
  if (typeof hitId !== 'number' || hitId === targetId) return;

  try {
    if (await subtreeContains(client, targetId, hitId)) return;  // hit is a descendant of target
    if (await subtreeContains(client, hitId, targetId)) return;  // target is a descendant of hit
  } catch { return; }

  const label = await describeNodeForError(client, hitId);
  throw new Error(
    `click target ${ref} is covered at (${Math.round(x)},${Math.round(y)}) by ${label} — ` +
    `dismiss or scroll past the overlay, then retry`
  );
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

module.exports = {
  navigate, ensureInView, normalizeUrl, waitForLoad, waitUntilLoaded, NAV_LOAD_TIMEOUT_MS,
  clickablePoint, assertHittable, isTextInput,
  // exported for testing
  bestQuadRect, quadToRect, intersectRect,
};
