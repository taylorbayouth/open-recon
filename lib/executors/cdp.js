'use strict';

// CDP executor — dispatches actions via Chrome DevTools Protocol input events.
//
// This path produces JS MouseEvents with `isTrusted: true` (per CDP spec) but
// still leaves a CDP-shaped fingerprint: synthesized events don't traverse the
// HID layer, motion is teleported (no curve), and timing is uniformly tight.
// Use the `os` executor for production / stealth runs. This executor exists
// for CI, headless tests, and quick iteration where Accessibility permission
// isn't available.

function bboxArrToObj(bbox) {
  if (!bbox) return null;
  if (Array.isArray(bbox)) return { x: bbox[0], y: bbox[1], width: bbox[2], height: bbox[3] };
  return bbox;
}

function elementByRef(brief, ref) {
  return brief.elements?.find(e => e.ref === ref) ?? null;
}

async function click({ session, brief, ref }) {
  const el = elementByRef(brief, ref);
  if (!el) throw new Error(`element ${ref} not found in brief`);
  const bbox = bboxArrToObj(el.bbox);
  if (!bbox) throw new Error(`element ${ref} has no bbox`);
  // bbox is in page coordinates (see extract.js), but Input.dispatchMouseEvent
  // wants coordinates relative to the viewport. Subtract the snapshot's scroll
  // offset — otherwise clicks miss by the scroll amount on any scrolled page.
  // (The os backend does the equivalent in pageToScreen.) bbox and scroll come
  // from the same brief, so they're coherent.
  const scrollX = brief.viewport?.scrollX ?? 0;
  const scrollY = brief.viewport?.scrollY ?? 0;
  const cx = bbox.x + bbox.width / 2 - scrollX;
  const cy = bbox.y + bbox.height / 2 - scrollY;
  const client = session.client;
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: cx, y: cy });
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
}

// Named-key → CDP dispatch fields. Mirrors the OS helper's NAMED_KEYS so both
// backends accept the same names. Keys that produce a character (Enter, Space)
// carry `text` so the renderer fires keypress/input listeners; the rest dispatch
// as rawKeyDown. "delete" maps to Backspace to match the OS helper.
const CDP_KEYS = {
  enter:     { key: 'Enter',      code: 'Enter',      keyCode: 13, text: '\r' },
  return:    { key: 'Enter',      code: 'Enter',      keyCode: 13, text: '\r' },
  tab:       { key: 'Tab',        code: 'Tab',        keyCode: 9 },
  space:     { key: ' ',          code: 'Space',      keyCode: 32, text: ' ' },
  backspace: { key: 'Backspace',  code: 'Backspace',  keyCode: 8 },
  delete:    { key: 'Backspace',  code: 'Backspace',  keyCode: 8 },
  escape:    { key: 'Escape',     code: 'Escape',     keyCode: 27 },
  esc:       { key: 'Escape',     code: 'Escape',     keyCode: 27 },
  arrowup:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
  arrowdown:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
  arrowleft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up:        { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
  down:      { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
  left:      { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
  right:     { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home:      { key: 'Home',       code: 'Home',       keyCode: 36 },
  end:       { key: 'End',        code: 'End',        keyCode: 35 },
  pageup:    { key: 'PageUp',     code: 'PageUp',     keyCode: 33 },
  pagedown:  { key: 'PageDown',   code: 'PageDown',   keyCode: 34 },
};

function resolveKey(name) {
  const k = CDP_KEYS[String(name).toLowerCase()];
  if (!k) throw new Error(`unknown key: ${name}`);
  return k;
}

// Vertical wheel delta for a scroll. CDP's mouseWheel uses positive deltaY for
// "down" (the same sign as DOM WheelEvent.deltaY). Falls back to ~80% of the
// viewport height when no explicit amount is given.
function scrollDeltaY(direction, amount, viewportHeight) {
  const dist = Number.isFinite(amount) && amount > 0
    ? amount
    : Math.round((viewportHeight || 800) * 0.8);
  return direction === 'up' ? -dist : dist;
}

async function scroll({ session, brief, direction, amount }) {
  const vp = brief?.viewport || {};
  const deltaY = scrollDeltaY(direction, amount, vp.height);
  // mouseWheel needs a viewport-relative anchor point; the center is always
  // over the page. Clamp to ≥1 so a missing viewport doesn't anchor at (0,0).
  const x = Math.max(1, Math.round((vp.width || 0) / 2));
  const y = Math.max(1, Math.round((vp.height || 0) / 2));
  await session.client.Input.dispatchMouseEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY });
}

async function key({ session, key: keyName }) {
  const k = resolveKey(keyName);
  const client = session.client;
  const fields = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
  await client.Input.dispatchKeyEvent({ type: k.text ? 'keyDown' : 'rawKeyDown', ...fields, text: k.text });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', ...fields });
}

// Page-level navigation. Shared with the OS backend (it has no HID dimension —
// a real load looks identical whether the URL was typed or scripted). Waits for
// the load event so the next snapshot isn't taken mid-navigation, with a hard
// timeout so a streaming/never-idle page can't hang the loop.
async function navigate({ session, url }) {
  if (!url || typeof url !== 'string') throw new Error('navigate requires a url string');
  const client = session.client;
  await client.Page.enable();
  const loaded = client.Page.loadEventFired();
  const res = await client.Page.navigate({ url });
  if (res?.errorText) throw new Error(`navigation failed: ${res.errorText}`);
  await Promise.race([loaded, new Promise(r => setTimeout(r, 15000))]);
}

async function type({ session, brief, ref, text }) {
  const el = elementByRef(brief, ref);
  if (!el) throw new Error(`element ${ref} not found in brief`);
  const backendNodeId = brief.lookup?.[ref];
  if (typeof backendNodeId !== 'number') throw new Error(`no backendNodeId for ${ref}`);
  const client = session.client;
  // The extractor uses `backendNodeId` (stable across snapshots) but DOM.focus
  // wants `nodeId` (a renderer-local handle that may not yet exist on the
  // frontend side). The two-step dance below registers the node with the
  // frontend and gets us a usable `nodeId`. `DOM.getDocument()` is the
  // documented prerequisite — without it, push returns nothing.
  await client.DOM.enable();
  await client.DOM.getDocument();
  const { nodeIds } = await client.DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds: [backendNodeId] });
  const nodeId = nodeIds?.[0];
  if (!nodeId) throw new Error(`could not resolve nodeId for ${ref}`);
  await client.DOM.focus({ nodeId });
  // insertText is the IME-style path: bypasses per-key keymapping, works for
  // any Unicode. Per-character timing is uniform (no humanize) — that's the
  // tradeoff for using the CDP backend.
  await client.Input.insertText({ text });
}

module.exports = {
  name: 'cdp',
  async init() {},
  async close() {},
  click,
  type,
  scroll,
  key,
  navigate,
  // exported for testing
  resolveKey,
  scrollDeltaY,
};
