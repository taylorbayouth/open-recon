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
    description: 'Click the node identified by ref — an element (@e…), or a text node (@t…) when the clickable thing only surfaced as text (e.g. a heading or list item inside a clickable container). The click lands at the node\'s center.',
  },
  type: {
    requiresRef: true,
    refType: ['e'],
    args: { text: 'string' },
    description: 'Focus the element identified by ref and type the given text into it.',
  },
  scroll: {
    requiresRef: false,
    args: { direction: 'string', amount: 'number?' },
    description: 'Scroll the page. direction is up|down|left|right; amount is pixels (defaults to ~85% of the viewport). Re-snapshot after to see newly-revealed elements.',
  },
  press: {
    requiresRef: false,
    args: { key: 'string' },
    description: 'Press a single named key at the current focus, e.g. Enter, Tab, Escape, ArrowDown. Use after typing into a field to submit.',
  },
  navigate: {
    requiresRef: false,
    args: { url: 'string' },
    description: 'Load a URL in the current tab (the browser address bar is not part of the page, so this is the only way to go to a site directly). A bare host like "example.com" is fine. Causes a full page load — all prior refs become invalid.',
  },
  selectText: {
    requiresRef: true,
    refType: ['e', 't'],
    args: { save: 'boolean?' },
    // Selection isn't part of the hashed page view, so it never registers as a
    // "page change" — the loop must not wait for one (it would poll pointlessly)
    // and re-prompts immediately instead.
    changesPage: false,
    description: 'Select (highlight) the full text of the node identified by ref — a text node (@t…) like a heading or paragraph, or an element (@e…). Drags the cursor from the start to the end of the node, like a mouse click-drag. Selects the whole node, not a sub-phrase. The selected text is reported back so you can read it. Pass save:true to also keep the selected text in the scratchpad — use this to collect results (the bulk text stays out of your context; only a short confirmation comes back).',
  },
  take_screenshot: {
    requiresRef: false,
    args: { hint: 'string?' },
    // A screenshot reads pixels; it doesn't alter the page, so (like selectText)
    // it never registers as a "page change" — the loop must re-prompt now rather
    // than poll for one that won't come.
    changesPage: false,
    // Re-shooting an unchanged page yields the same image — repeating it on the
    // same page is flailing (see the loop's stuck-guard).
    idempotentRead: true,
    description: 'Capture the visible page as an image. It is saved to the run folder and described by a vision model; you get back the saved file path and the description. Use it for visual things the text listing can\'t convey — an image CAPTCHA, a chart, a photo, a canvas — or when the task asks for a screenshot. Optional `hint` says what to focus on (e.g. "read the distorted characters").',
  },
  get_images: {
    requiresRef: false,
    args: {},
    changesPage: false,
    idempotentRead: true,
    description: 'List the images on the current page — images are NOT in the normal element listing, so run this when you need to find or save one. Returns each image\'s URL, name/caption, pixel size, and on-page position (biggest first). Pick one and pass its URL to save_file. If the names don\'t tell you which is which, take_screenshot to see the page, then match by position.',
  },
  get_files: {
    requiresRef: false,
    args: {},
    changesPage: false,
    idempotentRead: true,
    description: 'List the downloadable files linked on the current page — PDFs, spreadsheets, documents, archives, etc. Returns each file\'s URL and type. Pick one and pass its URL to save_file. (Lists only files the page reveals through a link; a file behind a link you haven\'t opened may need you to navigate to it first.)',
  },
  save_text: {
    requiresRef: false,
    args: { content: 'string', summary: 'string' },
    // Saving is bookkeeping, not a page interaction — it never changes the page,
    // so the loop must re-prompt immediately rather than poll for a change.
    changesPage: false,
    description: 'Save a block of text you gathered or wrote — notes, findings, an extracted list — to the run\'s files so it ends up in the result. Pass the full `content` and a short `summary` of it. The full text is stored on disk; only your `summary` stays visible on later turns, so make the summary specific enough to track progress and avoid duplicates (e.g. "3 of 10 job URLs: Staff SWE@Google, PM@Stripe, …"). Append-only — call it again to add more.',
  },
  save_file: {
    requiresRef: false,
    args: { url: 'string', hint: 'string?' },
    changesPage: false,
    description: 'Download the file at a URL — typically one from get_images or get_files (or a link URL you can see in the listing) — and save it to the run\'s files. Images come back with a vision description; other files with their name/type/size. Optional `hint` focuses an image description. For visual content with no underlying file (a canvas, a CSS background), use take_screenshot instead.',
  },
  done: {
    requiresRef: false,
    args: { result: 'string?' },
    description: 'Signal that the task is complete. Optional `result` summarizes the outcome.',
  },
};

module.exports = ACTIONS;
