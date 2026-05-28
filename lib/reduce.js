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
  // viewport is intentionally excluded: width/height changes on window resize
  // and scrollX/Y changes are already captured via the in-viewport element list
  // (inViewportOnly:true). Including them caused false "page changed" signals
  // on resize, burning an extra LLM turn on identical content.
  const stable = {
    url: brief.url,
    title: brief.title,
    elements: brief.elements?.map(e => ({ ...e, bbox: undefined })) ?? [],
    text: brief.text?.map(t => ({ ...t, bbox: undefined })) ?? [],
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

const DEFAULT_VIEW = {
  includeText: true,    // interleave @t text nodes (headings, labels, prose)
  includeCoords: true,  // append a compact (x,y) center per line
  maxTextChars: 200,    // truncate long text node names
  dedupeText: true,     // collapse consecutive identical text nodes
};

function bboxFromAny(b) {
  if (!b) return null;
  if (Array.isArray(b)) return { x: b[0], y: b[1], width: b[2], height: b[3] };
  return b;
}

function center(bbox) {
  const b = bboxFromAny(bbox);
  if (!b) return null;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// Reading-order sort key: band rows by ~10px so items on the same visual line
// sort left-to-right rather than by sub-pixel baseline differences. Nodes
// without a bbox sort last.
function sortKey(bbox) {
  const c = center(bbox);
  // Large finite sentinel (not Infinity): two bbox-less nodes would otherwise
  // compute Infinity - Infinity = NaN in the comparator, which is spec-undefined
  // and yields nondeterministic ordering. MAX_SAFE_INTEGER still sorts them last.
  if (!c) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  return [Math.round(c.y / 10), c.x];
}

function truncate(s, max) {
  if (!max || s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function coordSuffix(bbox, view) {
  if (!view.includeCoords) return '';
  const c = center(bbox);
  if (!c) return '';
  return `  (${Math.round(c.x)},${Math.round(c.y)})`;
}

// Interactive element line: ref, role, name, state extras, optional coords.
function formatInteractive(el, view) {
  const role = (el.role || '?').padEnd(10);
  const name = el.name ? `"${el.name.replace(/"/g, '\\"')}"` : '(unnamed)';
  const extras = [];
  if (el.value) extras.push(`= "${String(el.value).replace(/"/g, '\\"')}"`);
  if (el.url) extras.push(`-> ${el.url}`);
  if (el.checked) extras.push('(checked)');
  if (el.selected) extras.push('(selected)');
  if (el.expanded) extras.push('(expanded)');
  if (el.disabled) extras.push('(disabled)');
  if (el.focused) extras.push('(focused)');
  const suffix = extras.length ? '  ' + extras.join(' ') : '';
  return `[${el.ref}]  ${role}  ${name}${suffix}${coordSuffix(el.bbox, view)}`;
}

// Text context line: ref, role, truncated name, optional coords. No action
// extras — @t refs are read-only context, not targets (the validator enforces
// this).
function formatText(t, view) {
  const role = (t.role || 'text').padEnd(10);
  const raw = (t.name || '').trim();
  const name = `"${truncate(raw, view.maxTextChars).replace(/"/g, '\\"')}"`;
  return `[${t.ref}]  ${role}  ${name}${coordSuffix(t.bbox, view)}`;
}

function reduce(brief, viewCfg = {}) {
  const view = { ...DEFAULT_VIEW, ...viewCfg };
  const elements = brief.elements ?? [];
  const text = view.includeText ? (brief.text ?? []) : [];

  // Merge elements and text into one reading-order list so labels sit next to
  // the fields they describe.
  const merged = [
    ...elements.map(node => ({ kind: 'e', node, key: sortKey(node.bbox) })),
    ...text.map(node => ({ kind: 't', node, key: sortKey(node.bbox) })),
  ].sort((a, b) => (a.key[0] - b.key[0]) || (a.key[1] - b.key[1]));

  const lines = [];
  let lastText = null; // for consecutive-dedupe; reset by any element so only
                       // directly-adjacent repeats collapse (spatially separated
                       // identical strings — e.g. per-row prices — are kept).
  for (const { kind, node } of merged) {
    if (kind === 't') {
      const raw = (node.name || '').trim();
      if (!raw) continue;                                  // drop empty/whitespace
      if (view.dedupeText && raw === lastText) continue;   // collapse adjacent repeat
      lastText = raw;
      lines.push(formatText(node, view));
    } else {
      lastText = null;
      lines.push(formatInteractive(node, view));
    }
  }

  return {
    kind: 'llm-view',
    version: '1.0',
    briefHash: brief.briefHash ?? computeBriefHash(brief),
    url: brief.url ?? null,
    title: brief.title ?? null,
    viewport: brief.viewport,
    listing: lines.join('\n'),
  };
}

module.exports = { reduce, computeBriefHash, DEFAULT_VIEW };
