#!/usr/bin/env node
'use strict';

// Convenience entry point for `npm run launch`.
// Equivalent to: node cli.js --launch
process.argv.splice(2, 0, '--launch');
require('./cli');
