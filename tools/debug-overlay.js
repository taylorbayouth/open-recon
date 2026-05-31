#!/usr/bin/env node
'use strict';

require('dotenv').config();

// Verification tool: extracts the SAME lean brief the agent loop sends the LLM,
// then paints a labeled box over every detected element on the live page. This
// confirms the whole extract→reduce pipeline end-to-end:
//   - box in the right place        → bbox geometry is correct
//   - box on the wrong element      → extractor geometry bug
//   - your target has no box        → extractor dropped it (the real bug when
//                                      the agent "can't find" something)
//   - box present but labeled wrong → naming/selection problem, not geometry
//
// Usage:
//   node debug-overlay.js            # draw boxes, leave them up
//   node debug-overlay.js --clear    # remove a previous overlay
//
// Boxes are drawn in page (document) coordinates, matching brief bbox space.
// Color shows click hittability at the current scroll position:
//   green  center hits target
//   yellow center is covered, but an alternate candidate point hits
//   red    all candidate points are covered
//   gray   geometry/hit-test unavailable

// ../ — this script lives in tools/; the library is at the repo root.
const { connect } = require('../lib/connect');
const { visibleQuadRects, diagnoseClickTarget } = require('../lib/executors/page');

const CLEAR = process.argv.includes('--clear');

async function main() {
  const session = await connect({ port: 9222 });
  try {
    if (CLEAR) {
      await clearOverlay(session.client);
      console.log('overlay cleared');
      return;
    }

    // A previous overlay can distort the hit-test diagnosis below, so clear it
    // before extracting/probing and let overlayFn remove any race leftovers too.
    await clearOverlay(session.client);

    const brief = await session.extract({ format: 'lean', inViewportOnly: true });
    const els = (brief.elements || []).map(e => {
      const b = Array.isArray(e.bbox)
        ? { x: e.bbox[0], y: e.bbox[1], width: e.bbox[2], height: e.bbox[3] }
        : e.bbox;
      return { ref: e.ref, role: e.role || '?', name: e.name || '', bbox: b };
    }).filter(e => e.bbox);

    await annotateHittability(session.client, brief, els);

    const counts = els.reduce((m, e) => {
      m[e.hit?.status || 'unknown'] = (m[e.hit?.status || 'unknown'] || 0) + 1;
      return m;
    }, {});
    console.log(
      `drawing ${els.length} element boxes ` +
      `(clear:${counts.clear || 0} partial:${counts.partial || 0} covered:${counts.covered || 0} unknown:${counts.unknown || 0})`
    );

    // Inject an absolutely-positioned overlay. data is passed by value so no
    // page globals are read; the overlay sits above page content via z-index.
    await session.client.Runtime.evaluate({
      expression: `(${overlayFn.toString()})(${JSON.stringify(els)})`,
    });
    console.log('overlay drawn. Run "node debug-overlay.js --clear" to remove.');
  } finally {
    await session.close();
  }
}

async function clearOverlay(client) {
  await client.Runtime.evaluate({
    expression: `document.getElementById('__browser_agent_overlay__')?.remove();`,
  });
}

async function annotateHittability(client, brief, els) {
  if (typeof client.DOM?.getNodeForLocation !== 'function') {
    for (const e of els) e.hit = { status: 'unknown', detail: 'hit-test unavailable' };
    return;
  }

  let scrollX = brief.viewport?.scrollX ?? 0;
  let scrollY = brief.viewport?.scrollY ?? 0;
  let vw = brief.viewport?.width ?? Infinity;
  let vh = brief.viewport?.height ?? Infinity;

  try {
    await client.DOM.enable();
    await client.DOM.getDocument();
    const m = await client.Page.getLayoutMetrics();
    const lv = m.cssLayoutViewport || m.layoutViewport || {};
    scrollX = lv.pageX ?? scrollX;
    scrollY = lv.pageY ?? scrollY;
    vw = lv.clientWidth ?? vw;
    vh = lv.clientHeight ?? vh;
  } catch {
    for (const e of els) e.hit = { status: 'unknown', detail: 'DOM geometry unavailable' };
    return;
  }

  for (const e of els) {
    const backendNodeId = brief.lookup?.[e.ref];
    if (typeof backendNodeId !== 'number') {
      e.hit = { status: 'unknown', detail: 'no backend node id' };
      continue;
    }

    let rects;
    try {
      const { quads } = await client.DOM.getContentQuads({ backendNodeId });
      rects = visibleQuadRects(quads, vw, vh);
    } catch {
      e.hit = { status: 'unknown', detail: 'content quads unavailable' };
      continue;
    }

    e.quads = rects.map(r => ({ x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }));
    const hit = await diagnoseClickTarget({ client, backendNodeId, rects });
    e.hit = hit.point
      ? { ...hit, point: { x: hit.point.x + scrollX, y: hit.point.y + scrollY } }
      : hit;
  }
}

// Runs in the page. Draws one labeled box per element at its page-coordinate bbox.
function overlayFn(els) {
  document.getElementById('__browser_agent_overlay__')?.remove();
  const palette = {
    clear:   { line: 'rgba(23,160,92,0.95)',  fill: 'rgba(23,160,92,0.10)',  label: 'rgba(23,120,76,0.95)' },
    partial: { line: 'rgba(234,179,8,0.98)',  fill: 'rgba(234,179,8,0.12)',  label: 'rgba(161,98,7,0.95)' },
    covered: { line: 'rgba(220,38,38,0.98)',  fill: 'rgba(220,38,38,0.12)',  label: 'rgba(185,28,28,0.96)' },
    unknown: { line: 'rgba(107,114,128,0.90)', fill: 'rgba(107,114,128,0.10)', label: 'rgba(75,85,99,0.95)' },
  };
  const root = document.createElement('div');
  root.id = '__browser_agent_overlay__';
  Object.assign(root.style, {
    position: 'absolute', left: '0', top: '0', width: '0', height: '0',
    zIndex: '2147483647', pointerEvents: 'none',
  });
  for (const e of els) {
    const hit = e.hit || { status: 'unknown', detail: 'not diagnosed' };
    const color = palette[hit.status] || palette.unknown;
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'absolute',
      left: e.bbox.x + 'px', top: e.bbox.y + 'px',
      width: e.bbox.width + 'px', height: e.bbox.height + 'px',
      outline: '2px solid ' + color.line, background: color.fill, boxSizing: 'border-box',
    });
    box.title = `${e.ref} ${hit.status}: ${hit.detail || ''}`;
    for (const q of e.quads || []) {
      const quad = document.createElement('div');
      Object.assign(quad.style, {
        position: 'absolute',
        left: q.x + 'px', top: q.y + 'px',
        width: q.width + 'px', height: q.height + 'px',
        outline: '1px dashed ' + color.line, boxSizing: 'border-box',
      });
      root.appendChild(quad);
    }
    if (hit.point) {
      const dot = document.createElement('div');
      Object.assign(dot.style, {
        position: 'absolute',
        left: (hit.point.x - 4) + 'px', top: (hit.point.y - 4) + 'px',
        width: '8px', height: '8px', borderRadius: '999px',
        background: color.line, boxShadow: '0 0 0 2px rgba(255,255,255,0.85)',
      });
      root.appendChild(dot);
    }
    const tag = document.createElement('div');
    tag.textContent = e.ref + ' ' + hit.status + (e.name ? ' ' + e.name.slice(0, 24) : ' (unnamed)');
    tag.title = hit.detail || '';
    Object.assign(tag.style, {
      position: 'absolute', left: e.bbox.x + 'px', top: (e.bbox.y - 14) + 'px',
      font: '11px/14px monospace', color: '#fff', background: color.label,
      padding: '0 3px', whiteSpace: 'nowrap',
    });
    root.appendChild(box);
    root.appendChild(tag);
  }
  const legend = document.createElement('div');
  legend.innerHTML = [
    ['clear', 'center hits'],
    ['partial', 'alternate hits'],
    ['covered', 'blocked'],
    ['unknown', 'unverified'],
  ].map(([status, text]) =>
    `<div><span style="display:inline-block;width:8px;height:8px;background:${palette[status].line};margin-right:5px"></span>${status}: ${text}</div>`
  ).join('');
  Object.assign(legend.style, {
    position: 'fixed', right: '10px', top: '10px',
    font: '11px/15px monospace', color: '#fff',
    background: 'rgba(17,24,39,0.88)', padding: '6px 8px',
    borderRadius: '4px', boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
  });
  root.appendChild(legend);
  document.body.appendChild(root);
}

main().catch(err => { console.error('fatal:', err?.message || err); process.exit(1); });
