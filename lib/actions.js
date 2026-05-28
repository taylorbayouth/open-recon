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
    refType: ['e'],
    args: {},
    description: 'Click the element identified by ref.',
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
  done: {
    requiresRef: false,
    args: { result: 'string?' },
    description: 'Signal that the task is complete. Optional `result` summarizes the outcome.',
  },
};

module.exports = ACTIONS;
