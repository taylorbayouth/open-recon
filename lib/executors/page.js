'use strict';

// Backend-agnostic page commands. `navigate` issues a CDP Page.navigate, which
// is identical for the cdp and os executors (it drives the renderer, not OS
// input), so both import it here instead of each owning a copy.

// Navigate the current tab to a URL. A bare host like "example.com" gets an
// https:// scheme prepended so the model doesn't have to remember it. Returns
// once navigation is committed; the loop's change-polling waits for the load to
// settle, so we don't block on the load event here.
async function navigate({ session, url }) {
  let u = String(url || '').trim();
  if (!u) throw new Error('navigate requires a url');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
  const client = session.client;
  await client.Page.enable();
  await client.Page.navigate({ url: u });
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

module.exports = { navigate, ensureInView };
