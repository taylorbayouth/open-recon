'use strict';

// Per-run logging. Writes two artifacts under `dir` (default ./logs):
//   <timestamp>-<runid>.jsonl  — one JSON line per turn, flushed as it happens
//                                so a Ctrl-C'd or crashed run still has a trace
//   latest.json                — the final run artifact, overwritten each run
//
// Appends are synchronous on purpose: turn volume is tiny and we want each line
// on disk before the next action, so an interrupted run loses nothing.

const fs = require('fs');
const path = require('path');

function createLogger({ dir = path.resolve(process.cwd(), 'logs'), runId, startedAt } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = (startedAt || new Date().toISOString()).replace(/[:.]/g, '-');
  const base = `${stamp}-${String(runId || 'run').slice(0, 8)}`;
  const turnsPath = path.join(dir, `${base}.jsonl`);
  const latestPath = path.join(dir, 'latest.json');

  function event(obj) {
    try {
      fs.appendFileSync(turnsPath, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
    } catch {}
  }

  function finalize(runArtifact) {
    try { fs.writeFileSync(latestPath, JSON.stringify(runArtifact, null, 2)); } catch {}
    event({
      kind: 'run-final',
      status: runArtifact.status,
      result: runArtifact.result ?? null,
      error: runArtifact.error ?? null,
      stats: runArtifact.stats,
    });
  }

  return { event, finalize, turnsPath, latestPath };
}

module.exports = { createLogger };
