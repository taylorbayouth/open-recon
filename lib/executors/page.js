'use strict';

// Backend-agnostic page commands. `navigate` issues a CDP Page.navigate, which
// is identical for the cdp and os executors (it drives the renderer, not OS
// input), so both import it here instead of each owning a copy.

// Navigate the current tab to a URL. A bare host like "example.com" gets an
// https:// scheme prepended so the model doesn't have to remember it. Returns
// once navigation is committed; the loop's change-polling waits for the load to
// settle, so we don't block on the load event here.
async function navigate({ session, url }) {
  let u = String(url || '').trim();
  if (!u) throw new Error('navigate requires a url');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
  const client = session.client;
  await client.Page.enable();
  await client.Page.navigate({ url: u });
}

module.exports = { navigate };
