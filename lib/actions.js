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
    args: { text: 'string' },
    description: 'Focus the element and type text into it.',
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
  selectText: {
    requiresRef: true,
    refType: ['e', 't'],
    args: { save: 'boolean?' },
    changesPage: false,
    description: 'Select the full text of a node (whole node, not a sub-phrase); reported back. Pass save:true to persist to the scratchpad — if you do, do NOT also call save_text for the same content.',
  },
  take_screenshot: {
    requiresRef: false,
    args: { hint: 'string?' },
    changesPage: false,
    idempotentRead: true,
    description: 'Capture the visible page; vision describes and saves it. Use for charts, diagrams, canvases, CAPTCHAs, or when the task asks for a screenshot of a section. Not for images that have a URL — use save_file instead. Optional hint focuses the description.',
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
    description: 'Save text (notes, findings, lists) to the run. Pass full content and a short summary — only the summary stays visible on later turns, so make it specific enough to track progress and avoid duplicates. Call again to append.',
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
    description: 'Signal that the task is complete. Optional `result` summarizes the outcome.',
  },
};

module.exports = ACTIONS;
