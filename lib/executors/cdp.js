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
  await client.DOM.enable();
  await client.DOM.getDocument();
  const { nodeIds } = await client.DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds: [backendNodeId] });
  const nodeId = nodeIds?.[0];
  if (!nodeId) throw new Error(`could not resolve nodeId for ${ref}`);
  await client.DOM.focus({ nodeId });
  await client.Input.insertText({ text });
}

module.exports = {
  name: 'cdp',
  async init() {},
  async close() {},
  click,
  type,
};
