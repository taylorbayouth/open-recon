'use strict';

const crypto = require('crypto');

// Turn a Brief into an LLMView — the prompt-ready, deterministic, text-formatted
// representation. The lookup table is intentionally absent (executor-only).
//
// Slice 1: elements only. Text nodes are omitted from the listing — they're
// grounding context the LLM doesn't need yet.
//
// See DESIGN.md § Artifacts § LLMView.

// Compute briefHash from content. This is a whitelist: only url, title,
// viewport, and per-element/text content go in. Ephemeral fields (timestamp,
// elapsedMs, stats) are excluded by construction — they're never read here — so
// re-snapshotting the same page yields the same hash and the loop can
// short-circuit redundant LLM calls. `bbox` is also dropped: the LLM's listing
// carries no coordinates, so two layouts with identical elements/labels are the
// same as far as the model is concerned, and must hash the same.
function computeBriefHash(brief) {
  const stable = {
    url: brief.url,
    title: brief.title,
    viewport: brief.viewport,
    elements: brief.elements?.map(e => ({ ...e, bbox: undefined })) ?? [],
    text: brief.text?.map(t => ({ ...t, bbox: undefined })) ?? [],
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
