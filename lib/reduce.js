'use strict';

const crypto = require('crypto');

// Turn a Brief into an LLMView — the prompt-ready, deterministic, text-formatted
// representation. The lookup table is intentionally absent (executor-only).
//
// Slice 1: elements only. Text nodes are omitted from the listing — they're
// grounding context the LLM doesn't need yet.
//
// See DESIGN.md § Artifacts § LLMView.

// Compute briefHash from content. Excludes timestamp/elapsedMs/stats so two
// semantically-identical snapshots produce the same hash. Slice 2 will move
// this into extract.js as a field on Brief; for now reduce computes it.
function computeBriefHash(brief) {
  const stable = {
    url: brief.url,
    title: brief.title,
    viewport: brief.viewport,
    elements: brief.elements?.map(e => ({ ref: e.ref, ...e, bbox: undefined })) ?? [],
    text: brief.text?.map(t => ({ ref: t.ref, ...t, bbox: undefined })) ?? [],
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

function bboxFromAny(b) {
  if (!b) return null;
  if (Array.isArray(b)) return { x: b[0], y: b[1], width: b[2], height: b[3] };
  return b;
}

function formatElement(el) {
  const ref = el.ref;
  const role = (el.role || '?').padEnd(10);
  const name = el.name ? `"${el.name.replace(/"/g, '\\"')}"` : '(unnamed)';
  const extras = [];
  if (el.value) extras.push(`= "${String(el.value).replace(/"/g, '\\"')}"`);
  if (el.url) extras.push(`-> ${el.url}`);
  if (el.checked) extras.push('(checked)');
  if (el.selected) extras.push('(selected)');
  if (el.expanded) extras.push('(expanded)');
  if (el.disabled) extras.push('(disabled)');
  const suffix = extras.length ? '  ' + extras.join(' ') : '';
  return `[${ref}]  ${role}  ${name}${suffix}`;
}

function reduce(brief) {
  const elements = brief.elements ?? [];
  const lines = elements.map(formatElement);
  const listing = lines.join('\n');
  return {
    kind: 'llm-view',
    version: '1.0',
    briefHash: brief.briefHash ?? computeBriefHash(brief),
    viewport: brief.viewport,
    listing,
  };
}

module.exports = { reduce, computeBriefHash };
