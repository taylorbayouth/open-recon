'use strict';

// Quick DPR sanity check. Run with:
//   RECON_DEBUG_COORDS=1 node check-dpr.js
//
// Expects Chrome on port 9222 (`npm run launch` first).
// Navigates to example.com and dumps the bounds scale logged by extract.js.

const { connect } = require('./index');

(async () => {
  const session = await connect({ port: 9222 });
  try {
    await session.navigate('https://example.com');
    await session.extract({ format: 'brief' });
  } finally {
    await session.close();
  }
})().catch(err => { console.error(err); process.exit(1); });
