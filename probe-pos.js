#!/usr/bin/env node
'use strict';

// Coordinate ground-truth probe. Reports the live mouse position (top-left
// screen coords, the same space recon-input posts clicks to) every 500ms.
//
// Usage:
//   node probe-pos.js
// Then physically hover your mouse over the target element and read the x,y.
// Compare against the [coords] "screen" value the agent computed for that
// element to find the offset/scale error in lib/executors/os.js pageToScreen.

const { spawn } = require('child_process');
const path = require('path');

const bin = path.resolve(__dirname, 'native', 'macos', 'recon-input', 'bin', 'recon-input');
const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
let seq = 0;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.data && msg.data.x != null) {
        process.stdout.write(`\rmouse @ screen (${Math.round(msg.data.x)}, ${Math.round(msg.data.y)})   `);
      }
    } catch {}
  }
});

console.log('Hover the target element. Ctrl+C to stop.\n');
setInterval(() => {
  child.stdin.write(JSON.stringify({ id: String(++seq), op: 'pos' }) + '\n');
}, 500);
