'use strict';

// Per-run scratchpad. The model saves targeted pieces it points at (a text
// selection today; images later) into one Markdown file per run:
//
//   runs/<run-id>/saved.md
//   runs/<run-id>/images/      (created on first image save)
//
// The bulk content lives on disk, never in the model's working context — the
// loop only ever sees a short "Saving to scratch pad" note. At the end of a run
// the file's contents are folded into the returned report (see loop.finish).

const fs = require('fs');
const path = require('path');

function createScratchpad({ enabled = true, dir = path.resolve(process.cwd(), 'runs'), runId } = {}) {
  if (!enabled) {
    return { append() {}, readMarkdown() { return ''; }, count: 0, dir: null };
  }
  if (!path.isAbsolute(dir)) dir = path.resolve(process.cwd(), dir);
  const runDir = path.join(dir, runId || 'run');
  const savedPath = path.join(runDir, 'saved.md');
  let count = 0;

  // One block per saved item: title, URL, timestamp, then the body. Markdown so
  // the file is both the on-disk artifact and a ready-to-read deliverable.
  function append({ title, url, text, note } = {}) {
    fs.mkdirSync(runDir, { recursive: true });
    const ts = new Date().toISOString();
    const heading = title ? `### ${title}` : `### Saved item ${count + 1}`;
    const block = [
      heading,
      url ? `- URL: ${url}` : null,
      `- Saved: ${ts}`,
      note ? `- Note: ${note}` : null,
      '',
      (text ?? '').trim(),
      '',
    ].filter(l => l !== null).join('\n');
    fs.appendFileSync(savedPath, block + '\n');
    count++;
    return { count };
  }

  function readMarkdown() {
    try { return fs.readFileSync(savedPath, 'utf8'); } catch { return ''; }
  }

  return {
    get count() { return count; },
    dir: runDir,
    savedPath,
    append,
    readMarkdown,
  };
}

module.exports = { createScratchpad };
