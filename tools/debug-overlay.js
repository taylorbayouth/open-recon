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

// ../ — this script lives in tools/; the library is at the repo root.
const { connect } = require('../lib/connect');

const CLEAR = process.argv.includes('--clear');

async function main() {
  const session = await connect({ port: 9222 });
  try {
    if (CLEAR) {
      await session.client.Runtime.evaluate({
        expression: `document.getElementById('__recon_overlay__')?.remove();`,
      });
      console.log('overlay cleared');
      return;
    }

    const brief = await session.extract({ format: 'lean', inViewportOnly: true });
    const els = (brief.elements || []).map(e => {
      const b = Array.isArray(e.bbox)
        ? { x: e.bbox[0], y: e.bbox[1], width: e.bbox[2], height: e.bbox[3] }
        : e.bbox;
      return { ref: e.ref, role: e.role || '?', name: e.name || '', bbox: b };
    }).filter(e => e.bbox);

    console.log(`drawing ${els.length} element boxes (of ${brief.elements?.length || 0} extracted)`);

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

// Runs in the page. Draws one labeled box per element at its page-coordinate bbox.
function overlayFn(els) {
  document.getElementById('__recon_overlay__')?.remove();
  const root = document.createElement('div');
  root.id = '__recon_overlay__';
  Object.assign(root.style, {
    position: 'absolute', left: '0', top: '0', width: '0', height: '0',
    zIndex: '2147483647', pointerEvents: 'none',
  });
  for (const e of els) {
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'absolute',
      left: e.bbox.x + 'px', top: e.bbox.y + 'px',
      width: e.bbox.width + 'px', height: e.bbox.height + 'px',
      outline: '2px solid rgba(255,0,80,0.9)', boxSizing: 'border-box',
    });
    const tag = document.createElement('div');
    tag.textContent = e.ref + (e.name ? ' ' + e.name.slice(0, 24) : ' (unnamed)');
    Object.assign(tag.style, {
      position: 'absolute', left: e.bbox.x + 'px', top: (e.bbox.y - 14) + 'px',
      font: '11px/14px monospace', color: '#fff', background: 'rgba(255,0,80,0.9)',
      padding: '0 3px', whiteSpace: 'nowrap',
    });
    root.appendChild(box);
    root.appendChild(tag);
  }
  document.body.appendChild(root);
}

main().catch(err => { console.error('fatal:', err?.message || err); process.exit(1); });
