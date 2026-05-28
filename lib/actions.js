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
  done: {
    requiresRef: false,
    args: { result: 'string?' },
    description: 'Signal that the task is complete. Optional `result` summarizes the outcome.',
  },
};

module.exports = ACTIONS;
