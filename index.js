'use strict';

const { launch, isRunning } = require('./lib/launch');
const { connect } = require('./lib/connect');

// One-shot convenience: open a connection, extract, close.
// For repeated calls (agent loops), use connect() directly to reuse the session.
async function extract(opts = {}) {
  if (opts.launch) opts = { ...opts, port: await launch(opts) };
  const session = await connect(opts);
  try {
    return await session.extract(opts);
  } finally {
    await session.close();
  }
}

module.exports = { connect, extract, launch, isRunning };
