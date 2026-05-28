#!/usr/bin/env node
'use strict';

const { extract, launch, isRunning } = require('./index');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { format: 'full', inViewportOnly: false, pretty: false };
  for (const arg of args) {
    if (arg === '--tree')             opts.format = 'tree';
    else if (arg === '--lean')        opts.format = 'lean';
    else if (arg === '--in-viewport-only') opts.inViewportOnly = true;
    else if (arg === '--pretty')      opts.pretty = true;
    else if (arg === '--launch')      opts._launchOnly = true;
    else if (arg === '--verbose')     opts.verbose = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  if (opts._launchOnly) {
    const running = await isRunning(opts.port || 9222);
    if (running) {
      console.log(`Chrome already running on port ${opts.port || 9222}.`);
    } else {
      process.stderr.write('Launching Chrome...\n');
      await launch(opts);
      console.log(`Chrome ready on port ${opts.port || 9222}.`);
    }
    console.log('Navigate to any page, then run: open-recon --tree');
    return;
  }

  if (opts.verbose) process.stderr.write(`Connecting to Chrome on port ${opts.port || 9222}...\n`);

  const result = await extract(opts);

  if (opts.verbose) {
    const s = result.stats;
    const count = s.returned ?? s.interactiveReturned;
    process.stderr.write(`Attached to: ${result.title} (${result.url})\n`);
    process.stderr.write(`Done. ${count} elements in ${s.elapsedMs}ms\n`);
  }

  process.stdout.write(opts.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result));
  process.stdout.write('\n');
}

main().catch(err => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
