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
  // CDP Input.dispatchMouseEvent takes page coordinates directly — no
  // screen-space translation needed. Target the bbox center, no jitter.
  // (See lib/executors/os.js for the same choice with humanize jitter.)
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  const client = session.client;
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: cx, y: cy });
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
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
};
