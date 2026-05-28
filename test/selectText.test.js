'use strict';

// Integration test for the selectText verb (cdp backend).
//
// Drives the REAL executor against a live Chrome tab, then reads back the
// browser's actual selection — so it verifies the thing that unit tests can't:
// that a corner-to-corner drag produces a visible highlight of the whole node.
//
// Uses the cdp backend so it needs no Accessibility permission and runs in CI.
// Skips cleanly if Chrome isn't on port 9222.
//
//   npm run launch && OPEN_RECON_E2E=1 node test/selectText.test.js
//   (or: npm run test:e2e — runs all browser tests)
//
// Covers: single-line @t, multi-line @t (the wrap case), a node below the fold
// after scrolling (exercises scroll-offset math), and an @e <input> (verified
// via selectionStart/End since getSelection() doesn't see input contents).

const assert = require('assert');
const http = require('http');
const CDP = require('chrome-remote-interface');

const { isRunning } = require('../lib/launch');
const { connect } = require('../lib/connect');
const cdp = require('../lib/executors/cdp');

let passed = 0, failed = 0;
async function testAsync(name, fn) {
  try { await fn(); console.log('  ✓', name); passed++; }
  catch (err) { console.error('  ✗', name); console.error('   ', err.message); failed++; }
}

// Generous margins so a corner-to-corner drag stays inside each node and can't
// bleed into a neighbor. #para is narrow on purpose to force multi-line wrap.
const FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; }
  body { font: 16px/1.6 sans-serif; }
  #heading { margin: 60px; }
  #para    { margin: 60px; width: 280px; }
  #spacer  { height: 1500px; }
  #below   { margin: 60px; }
  #inp     { margin: 60px; width: 320px; font-size: 16px; }
  #farbtn  { margin: 60px; }
</style></head><body>
  <h1 id="heading">Turing Machine</h1>
  <p id="para">The quick brown fox jumps over the lazy dog and then keeps running far enough that this paragraph must wrap across several visual lines for the test.</p>
  <div id="spacer"></div>
  <h2 id="below">Below The Fold Heading</h2>
  <input id="inp" value="SelectableInputText">
  <div style="height: 1500px"></div>
  <button id="farbtn">Far Down Button</button>
  <script>document.getElementById('farbtn').addEventListener('click', () => { window.__btnClicked = true; });</script>
</body></html>`;

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function getSelectionText(session) {
  const { result } = await session.client.Runtime.evaluate({
    expression: 'window.getSelection().toString()',
    returnByValue: true,
  });
  return result.value || '';
}

async function clearSelection(session) {
  await session.client.Runtime.evaluate({ expression: 'window.getSelection().removeAllRanges()' });
}

// Find a text node (@t) in the brief by its (normalized) name.
function findText(brief, name) {
  const want = norm(name);
  return (brief.text || []).find(t => norm(t.name) === want)
    || (brief.text || []).find(t => norm(t.name).includes(want));
}

(async () => {
  // Opt-in: this test opens a tab and drives a real Chrome. Gate it behind the
  // same flag as the other e2e tests so it never runs by accident.
  if (!process.env.OPEN_RECON_E2E) {
    console.log('\nselectText tests: skipped (set OPEN_RECON_E2E=1 to run them).\n');
    return;
  }
  if (!(await isRunning(9222))) {
    console.log('\nselectText tests: skipped (Chrome not running on port 9222)');
    console.log('  Run `npm run launch`, then `OPEN_RECON_E2E=1 node test/selectText.test.js`.\n');
    return;
  }

  console.log('\nselectText integration tests (cdp backend):');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(FIXTURE);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;

  // Chrome can be alive with zero tabs (user closed the window; the macOS app
  // stays running). connect() needs a page target, so open one if none exist.
  const pages = (await CDP.List({ port: 9222 })).filter(t => t.type === 'page');
  if (!pages.length) await CDP.New({ port: 9222 });

  let session;
  try {
    session = await connect({ port: 9222 });
    await session.client.Page.enable();
    await session.client.Page.navigate({ url: fixtureUrl });
    await new Promise(r => setTimeout(r, 700));

    await testAsync('selects a single-line heading (@t) exactly', async () => {
      await clearSelection(session);
      const brief = await session.extract({ format: 'lean', inViewportOnly: true });
      const node = findText(brief, 'Turing Machine');
      assert.ok(node, 'heading text node not found in brief');
      await cdp.selectText({ session, brief, ref: node.ref });
      const sel = await getSelectionText(session);
      assert.strictEqual(norm(sel), 'Turing Machine', `got "${norm(sel)}"`);
    });

    await testAsync('selects a multi-line wrapped paragraph (@t) in full', async () => {
      await clearSelection(session);
      const expected = 'The quick brown fox jumps over the lazy dog and then keeps running far enough that this paragraph must wrap across several visual lines for the test.';
      const brief = await session.extract({ format: 'lean', inViewportOnly: true });
      const node = findText(brief, expected);
      assert.ok(node, 'paragraph text node not found in brief');
      await cdp.selectText({ session, brief, ref: node.ref });
      const sel = norm(await getSelectionText(session));
      // Whole-node selection: the full paragraph text must be covered. (Allow
      // exact match; includes guards against a stray trailing space.)
      assert.ok(sel.includes(expected), `selection did not cover full paragraph:\n  got "${sel}"`);
    });

    await testAsync('selects a node below the fold after scrolling (offset math)', async () => {
      await clearSelection(session);
      // Scroll the target into view, then re-extract so the brief carries the
      // new scrollY — selectText must subtract it or the drag misses entirely.
      await session.client.Runtime.evaluate({
        expression: "document.getElementById('below').scrollIntoView({block:'center'})",
      });
      await new Promise(r => setTimeout(r, 250));
      const brief = await session.extract({ format: 'lean', inViewportOnly: true });
      assert.ok((brief.viewport?.scrollY ?? 0) > 100, 'page should be scrolled for this test');
      const node = findText(brief, 'Below The Fold Heading');
      assert.ok(node, 'below-fold heading not found in brief');
      await cdp.selectText({ session, brief, ref: node.ref });
      assert.strictEqual(norm(await getSelectionText(session)), 'Below The Fold Heading');
    });

    await testAsync('selects all text inside an input (@e), read via selectionStart/End', async () => {
      await clearSelection(session);
      await session.client.Runtime.evaluate({
        expression: "document.getElementById('below').scrollIntoView({block:'center'})",
      });
      await new Promise(r => setTimeout(r, 250));
      const brief = await session.extract({ format: 'lean', inViewportOnly: true });
      const input = (brief.elements || []).find(e => e.role === 'textbox');
      assert.ok(input, 'input element not found in brief');
      await cdp.selectText({ session, brief, ref: input.ref });
      const { result } = await session.client.Runtime.evaluate({
        expression: "(() => { const i = document.getElementById('inp'); return i.value.substring(i.selectionStart, i.selectionEnd); })()",
        returnByValue: true,
      });
      assert.strictEqual(result.value, 'SelectableInputText', `got "${result.value}"`);
    });

    await testAsync('a fresh selection replaces the prior one (no bleed)', async () => {
      await clearSelection(session);
      const brief = await session.extract({ format: 'lean', inViewportOnly: true });
      const node = findText(brief, 'Below The Fold Heading');
      await cdp.selectText({ session, brief, ref: node.ref });
      assert.strictEqual(norm(await getSelectionText(session)), 'Below The Fold Heading');
    });

    // Last — reloads to reset scroll to the top.
    await testAsync('click scrolls an off-viewport target into view first', async () => {
      await session.client.Page.navigate({ url: fixtureUrl });
      await new Promise(r => setTimeout(r, 700));
      await session.client.Runtime.evaluate({ expression: 'window.__btnClicked = false' });
      // Unfiltered extract so the bottom button is in the brief with its center
      // far below the fold — exactly the case that drove the cursor off-page.
      const brief = await session.extract({ format: 'lean', inViewportOnly: false });
      const btn = (brief.elements || []).find(e => norm(e.name) === 'Far Down Button');
      assert.ok(btn, 'far-down button not found in brief');
      await cdp.click({ session, brief, ref: btn.ref });
      await new Promise(r => setTimeout(r, 200));
      const { result } = await session.client.Runtime.evaluate({ expression: '!!window.__btnClicked', returnByValue: true });
      assert.ok(result.value, 'button was not clicked — scroll-into-view failed');
    });

  } finally {
    if (session) await session.close();
    server.close();
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
