'use strict';

// Single source of truth for the action vocabulary. The validator, executor,
// and prompt builder all read from this registry.
//
// Schema per verb:
//   requiresRef: bool    — does this verb target an element ref?
//   refType:    string[] — allowed ref-type letters (e.g. ['e']). Required iff requiresRef.
//   args:       object   — arg name → type. Trailing '?' on type marks optional.
//
// Argument types accepted by the validator:
//   'string', 'number', 'boolean', plus the '?' suffix for optional.
//
// See DESIGN.md § Action registry for the full contract.

const ACTIONS = {
  click: {
    requiresRef: true,
    refType: ['e', 't'],
    args: {},
    description: 'Click the node\'s center. Use @t when the clickable thing only appears as text (e.g. a list item inside a clickable container).',
  },
  type: {
    requiresRef: true,
    refType: ['e'],
    args: { text: 'string', clear: 'boolean?' },
    description: 'Focus the element and type text into it. Replaces any existing field value by default; pass clear:false to append instead.',
  },
  scroll: {
    requiresRef: false,
    args: { direction: 'string', amount: 'number?' },
    description: 'Scroll the page. direction: up|down|left|right; amount: pixels (default ~85% viewport).',
  },
  press: {
    requiresRef: false,
    args: { key: 'string' },
    description: 'Press a named key at current focus: Enter, Tab, Escape, ArrowDown, etc.',
  },
  navigate: {
    requiresRef: false,
    args: { url: 'string' },
    description: 'Load a URL in the current tab — the only way to go to a site directly. Bare host ("example.com") is fine. Invalidates all prior refs.',
  },
  back: {
    requiresRef: false,
    args: {},
    description: 'Go back to the previous page in this tab (the browser Back button). Use it to return to a search-results or listing page after opening a detail/company page, instead of re-searching. Invalidates all prior refs.',
  },
  wait: {
    requiresRef: false,
    args: { ms: 'number' },
    description: 'Pause deliberately for animations, debounced UI, throttled updates, or external steps. ms is capped at 30000. Normal settle still runs afterward.',
  },
  select_text: {
    requiresRef: true,
    refType: ['e', 't'],
    args: {},
    changesPage: false,
    description: 'Select and read back the full text of a node (the whole node, not a sub-phrase). Use it to read a specific label or block; to keep that text, follow up with save_text.',
  },
  take_screenshot: {
    requiresRef: false,
    optionalRef: true,
    refType: ['e', 't', 'r'],
    args: { hint: 'string?' },
    changesPage: false,
    idempotentRead: true,
    description: 'Capture the page; vision describes and saves it. With no ref, captures the whole visible viewport. To crop, pass an exact visible ref like @e12, @t8, or @r2; never pass punctuation, CSS selectors, words, or coordinates as ref. Cropping is best for reading a chart, diagram, canvas, scanned image, or CAPTCHA. Not for images that have a URL — use save_file instead. Optional hint focuses the description.',
  },
  get_images: {
    requiresRef: false,
    args: {},
    changesPage: false,
    idempotentRead: true,
    description: 'List images on the page (not in the element listing). Returns URL, caption, size, position (biggest first). Follow up with save_file(url) — do not screenshot to locate or verify.',
  },
  get_files: {
    requiresRef: false,
    args: {},
    changesPage: false,
    idempotentRead: true,
    description: 'List downloadable files (PDFs, spreadsheets, archives, etc.) linked on the page. Returns URL and type. Follow up with save_file(url) — do not navigate to the URL directly.',
  },
  save_text: {
    requiresRef: false,
    args: { content: 'string', summary: 'string' },
    changesPage: false,
    description: 'Save durable source material or facts needed after navigation. Pass full content and a short summary — only the summary stays visible on later turns, so make it specific enough to track progress and avoid duplicates. Do not use save_text for intermediate answer drafts; use done for the final report.',
  },
  save_file: {
    requiresRef: false,
    args: { url: 'string', hint: 'string?' },
    changesPage: false,
    description: 'Download and save a URL — from get_images, get_files, or a visible link. Images come back with a vision description; other files with name/type/size. Optional hint focuses image description.',
  },
  done: {
    requiresRef: false,
    args: { result: 'string?' },
    description: 'Signal that the task is complete. `result` is the final answer — only finish when it is grounded in content you actually read on the page, not a guess. If a key fact rests on a single unverified source, corroborate it elsewhere first, or state it in `result` as low-confidence rather than as established fact.',
  },
};

module.exports = ACTIONS;
