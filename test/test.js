'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const CDP = require('chrome-remote-interface');

const { flattenProperties, isInViewport, isLeanVisible, isCursorClickable, bboxArr } = require('../lib/extract');
const { isRunning } = require('../lib/launch');
const { connect, chooseTab } = require('../lib/connect');

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  ✓', name);
    passed++;
  } catch (err) {
    console.error('  ✗', name);
    console.error('   ', err.message);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log('  ✓', name);
    passed++;
  } catch (err) {
    console.error('  ✗', name);
    console.error('   ', err.message);
    failed++;
  }
}

// ─── Unit tests (no Chrome required) ─────────────────────────────────────────

console.log('\nUnit tests:');

test('flattenProperties: empty input', () => {
  assert.deepStrictEqual(flattenProperties(null), {});
  assert.deepStrictEqual(flattenProperties(undefined), {});
  assert.deepStrictEqual(flattenProperties([]), {});
});

test('flattenProperties: basic values', () => {
  const props = [
    { name: 'focusable', value: { value: true } },
    { name: 'disabled', value: { value: false } },
    { name: 'level', value: { value: 2 } },
  ];
  const result = flattenProperties(props);
  assert.strictEqual(result.focusable, true);
  assert.strictEqual(result.disabled, false);
  assert.strictEqual(result.level, 2);
});

test('flattenProperties: missing value field', () => {
  const props = [{ name: 'foo', value: null }];
  assert.strictEqual(flattenProperties(props).foo, null);
});

test('isInViewport: element fully visible', () => {
  const vp = { width: 1200, height: 800, scrollX: 0, scrollY: 0 };
  assert.strictEqual(isInViewport({ x: 100, y: 100, width: 200, height: 50 }, vp), true);
});

test('isInViewport: element above fold (scrolled past)', () => {
  const vp = { width: 1200, height: 800, scrollX: 0, scrollY: 1000 };
  // element is at y=0..50 in document coords; viewport shows y=1000..1800
  assert.strictEqual(isInViewport({ x: 100, y: 0, width: 200, height: 50 }, vp), false);
});

test('isInViewport: element partially visible', () => {
  const vp = { width: 1200, height: 800, scrollX: 0, scrollY: 0 };
  // element starts at y=780, extends past viewport bottom
  assert.strictEqual(isInViewport({ x: 100, y: 780, width: 200, height: 100 }, vp), true);
});

test('isInViewport: null bbox returns false', () => {
  assert.strictEqual(isInViewport(null, { width: 1200, height: 800, scrollX: 0, scrollY: 0 }), false);
});

test('isLeanVisible: normal element is visible', () => {
  const style = { visibility: 'visible', opacity: '1', 'pointer-events': 'auto', display: 'block' };
  assert.strictEqual(isLeanVisible({ x: 0, y: 0, width: 100, height: 50 }, style), true);
});

test('isLeanVisible: visibility:hidden', () => {
  assert.strictEqual(isLeanVisible({ x: 0, y: 0, width: 100, height: 50 }, { visibility: 'hidden' }), false);
});

test('isLeanVisible: opacity:0 (non-focusable) is hidden', () => {
  assert.strictEqual(isLeanVisible({ x: 0, y: 0, width: 100, height: 50 }, { opacity: '0' }), false);
});

test('isLeanVisible: opacity:0 + focusable is kept (transparent input)', () => {
  // A real input rendered transparent (its visible styling is a sibling), e.g.
  // LinkedIn's search box — focusable and pointer-reachable, so it stays.
  const style = { opacity: '0', 'pointer-events': 'auto' };
  assert.strictEqual(isLeanVisible({ x: 0, y: 0, width: 100, height: 50 }, style, true), true);
});

test('isLeanVisible: opacity:0 + focusable but pointer-events:none is hidden', () => {
  const style = { opacity: '0', 'pointer-events': 'none' };
  assert.strictEqual(isLeanVisible({ x: 0, y: 0, width: 100, height: 50 }, style, true), false);
});

test('isLeanVisible: pointer-events:none', () => {
  assert.strictEqual(isLeanVisible({ x: 0, y: 0, width: 100, height: 50 }, { 'pointer-events': 'none' }), false);
});

test('isLeanVisible: zero-width bbox', () => {
  assert.strictEqual(isLeanVisible({ x: 0, y: 0, width: 0, height: 50 }, null), false);
});

test('isLeanVisible: null bbox', () => {
  assert.strictEqual(isLeanVisible(null, null), false);
});

test('isCursorClickable: named generic node with cursor:pointer is clickable', () => {
  assert.strictEqual(isCursorClickable('generic', 'Close dialog', { cursor: 'pointer' }), true);
  assert.strictEqual(isCursorClickable('none', 'Menu', { cursor: 'pointer' }), true);
  assert.strictEqual(isCursorClickable(undefined, 'X', { cursor: 'pointer' }), true);
});

test('isCursorClickable: requires a non-empty accessible name', () => {
  // Name-gated to avoid inherited-cursor noise (nested spans) and ignored nodes.
  assert.strictEqual(isCursorClickable('generic', null, { cursor: 'pointer' }), false);
  assert.strictEqual(isCursorClickable('generic', '', { cursor: 'pointer' }), false);
  assert.strictEqual(isCursorClickable('generic', '   ', { cursor: 'pointer' }), false);
});

test('isCursorClickable: requires cursor:pointer', () => {
  assert.strictEqual(isCursorClickable('generic', 'Close', { cursor: 'default' }), false);
  assert.strictEqual(isCursorClickable('generic', 'Close', { cursor: 'auto' }), false);
  assert.strictEqual(isCursorClickable('generic', 'Close', null), false);
  assert.strictEqual(isCursorClickable('generic', 'Close', {}), false);
});

test('isCursorClickable: semantic roles are excluded (handled by role/text paths)', () => {
  // A real button/link/heading already gets captured by its role — the cursor
  // path must not double-claim it.
  assert.strictEqual(isCursorClickable('button', 'Save', { cursor: 'pointer' }), false);
  assert.strictEqual(isCursorClickable('link', 'Home', { cursor: 'pointer' }), false);
  assert.strictEqual(isCursorClickable('heading', 'Title', { cursor: 'pointer' }), false);
});

test('bboxArr: rounds floats and returns array', () => {
  const result = bboxArr({ x: 1.7, y: 2.3, width: 100.9, height: 50.1 });
  assert.deepStrictEqual(result, [2, 2, 101, 50]);
});

// ─── chooseTab: tab-following policy (pure) ──────────────────────────────────
// Models the OAuth/popup lifecycle: open a popup, then close it and return.

test('chooseTab: follows a popup our tab opened (openerId), newest wins', () => {
  const pages = [
    { targetId: 'A', openerId: undefined },           // our tab
    { targetId: 'pop1', openerId: 'A' },              // first popup
    { targetId: 'pop2', openerId: 'A' },              // second popup (newer)
  ];
  const got = chooseTab({ pages, currentId: 'A', openerId: null, knownIds: new Set(['A']) });
  assert.strictEqual(got, 'pop2');
});

test('chooseTab: ignores unrelated background tabs on the first poll (no baseline)', () => {
  const pages = [
    { targetId: 'A', openerId: undefined },           // our tab
    { targetId: 'bg', openerId: undefined },          // pre-existing, not opened by us
  ];
  // Empty knownIds = first poll: a pre-existing tab must NOT be treated as fresh.
  const got = chooseTab({ pages, currentId: 'A', openerId: null, knownIds: new Set() });
  assert.strictEqual(got, null);
});

test('chooseTab: follows a brand-new no-opener tab once we have a baseline', () => {
  const pages = [
    { targetId: 'A', openerId: undefined },
    { targetId: 'new', openerId: undefined },         // appeared since last poll (e.g. _blank rel=noopener)
  ];
  const got = chooseTab({ pages, currentId: 'A', openerId: null, knownIds: new Set(['A']) });
  assert.strictEqual(got, 'new');
});

test('chooseTab: when our tab closes, returns to its opener (the OAuth round-trip)', () => {
  const pages = [
    { targetId: 'A', openerId: undefined },           // opener still open
    { targetId: 'other', openerId: undefined },
  ];
  // currentId 'pop' is gone from pages; we recorded its opener as 'A'.
  const got = chooseTab({ pages, currentId: 'pop', openerId: 'A', knownIds: new Set(['A', 'pop', 'other']) });
  assert.strictEqual(got, 'A');
});

test('chooseTab: closed tab with a vanished opener falls back to the newest page', () => {
  const pages = [{ targetId: 'X', openerId: undefined }, { targetId: 'Y', openerId: undefined }];
  const got = chooseTab({ pages, currentId: 'pop', openerId: 'gone', knownIds: new Set(['pop']) });
  assert.strictEqual(got, 'Y');
});

test('chooseTab: stays put when nothing changed', () => {
  const pages = [{ targetId: 'A', openerId: undefined }];
  assert.strictEqual(chooseTab({ pages, currentId: 'A', openerId: null, knownIds: new Set(['A']) }), null);
});

// ─── Integration tests (requires Chrome running on port 9222) ────────────────

(async () => {
  // Integration tests drive a real Chrome tab — they navigate it to the fixture,
  // which would hijack whatever you're doing. So they're opt-in: set
  // OPEN_RECON_E2E=1 to run them. `npm test` stays browser-free and deterministic.
  if (!process.env.OPEN_RECON_E2E) {
    console.log('\nIntegration tests: skipped (set OPEN_RECON_E2E=1 to run them).\n');
    printSummary();
    return;
  }
  const chromeAvailable = await isRunning(9222);
  if (!chromeAvailable) {
    console.log('\nIntegration tests: skipped (Chrome not running on port 9222)');
    console.log('  Run `npm run launch`, then `OPEN_RECON_E2E=1 node test/test.js`.\n');
    printSummary();
    return;
  }

  console.log('\nIntegration tests:');

  // Serve fixture.html locally
  const fixturePath = path.resolve(__dirname, 'fixture.html');
  const html = fs.readFileSync(fixturePath, 'utf8');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port: serverPort } = server.address();
  const fixtureUrl = `http://127.0.0.1:${serverPort}/`;

  let session;
  try {
    const pages = (await CDP.List({ port: 9222 })).filter(t => t.type === 'page');
    if (!pages.length) await CDP.New({ port: 9222 });

    session = await connect({ port: 9222 });

    // Navigate to fixture
    await session.client.Page.enable();
    await session.client.Page.navigate({ url: fixtureUrl });
    await new Promise(r => setTimeout(r, 600));

    await testAsync('tree mode returns a RootWebArea root', async () => {
      const result = await session.extract({ format: 'tree' });
      assert.strictEqual(result.schemaVersion, '2.0');
      assert.ok(result.tree, 'tree should not be null');
      assert.strictEqual(result.tree.role, 'RootWebArea');
      assert.ok(result.lookup && typeof result.lookup === 'object', 'lookup should be present');
    });

    await testAsync('tree mode finds form with inputs', async () => {
      const result = await session.extract({ format: 'tree' });
      function findAll(node, role, found = []) {
        if (!node) return found;
        if (node.role === role) found.push(node);
        if (node.children) node.children.forEach(c => findAll(c, role, found));
        return found;
      }
      const inputs = findAll(result.tree, 'textbox');
      assert.ok(inputs.length >= 2, `expected ≥2 textboxes, got ${inputs.length}`);
      const emailInput = inputs.find(n => n.name?.toLowerCase().includes('email'));
      assert.ok(emailInput, 'email input should have accessible name');
    });

    await testAsync('tree mode finds navigation links', async () => {
      const result = await session.extract({ format: 'tree' });
      function findAll(node, role, found = []) {
        if (!node) return found;
        if (node.role === role) found.push(node);
        if (node.children) node.children.forEach(c => findAll(c, role, found));
        return found;
      }
      const links = findAll(result.tree, 'link');
      assert.ok(links.length >= 3, `expected ≥3 links, got ${links.length}`);
    });

    await testAsync('tree mode finds disabled button', async () => {
      const result = await session.extract({ format: 'tree' });
      function findAll(node, role, found = []) {
        if (!node) return found;
        if (node.role === role) found.push(node);
        if (node.children) node.children.forEach(c => findAll(c, role, found));
        return found;
      }
      const buttons = findAll(result.tree, 'button');
      const disabledBtn = buttons.find(b => b.disabled === true);
      assert.ok(disabledBtn, 'disabled button should appear with disabled:true');
    });

    await testAsync('full mode returns elements + text arrays', async () => {
      const result = await session.extract({ format: 'full' });
      assert.ok(Array.isArray(result.elements));
      assert.ok(Array.isArray(result.text));
      assert.ok(result.elements.length > 0);
      assert.ok(typeof result.stats.interactiveFound === 'number');
    });

    await testAsync('lean mode strips computedStyle', async () => {
      const result = await session.extract({ format: 'lean' });
      for (const el of result.elements) {
        assert.strictEqual(el.computedStyle, undefined, 'lean mode should not include computedStyle');
      }
    });

    await testAsync('inViewportOnly filters elements', async () => {
      const all = await session.extract({ format: 'tree' });
      const filtered = await session.extract({ format: 'tree', inViewportOnly: true });
      assert.ok(
        filtered.stats.interactiveReturned <= all.stats.interactiveReturned,
        'inViewportOnly should return ≤ full count'
      );
    });

    await testAsync('session reuse: two extractions same connection', async () => {
      const r1 = await session.extract({ format: 'tree' });
      const r2 = await session.extract({ format: 'tree' });
      assert.strictEqual(r1.url, r2.url);
      assert.ok(r1.stats.elapsedMs > 0);
      assert.ok(r2.stats.elapsedMs > 0);
    });

    await testAsync('stats.elapsedMs is populated', async () => {
      const result = await session.extract({ format: 'full' });
      assert.ok(typeof result.stats.elapsedMs === 'number');
      assert.ok(result.stats.elapsedMs > 0);
      assert.ok(result.stats.elapsedMs < 30000);
    });

    const CSS_HIDDEN = [
      'CSS visibility hidden button',
      'CSS opacity zero button',
      'CSS pointer events none button',
    ];

    await testAsync('tree mode excludes CSS-invisible elements', async () => {
      const result = await session.extract({ format: 'tree' });
      function allNames(node, names = []) {
        if (!node) return names;
        if (node.name) names.push(node.name);
        if (node.children) node.children.forEach(c => allNames(c, names));
        return names;
      }
      const names = allNames(result.tree);
      for (const hidden of CSS_HIDDEN) {
        assert.ok(!names.includes(hidden), `"${hidden}" should be filtered in tree mode`);
      }
    });

    await testAsync('lean mode excludes CSS-invisible elements', async () => {
      const result = await session.extract({ format: 'lean' });
      const names = result.elements.map(e => e.name);
      for (const hidden of CSS_HIDDEN) {
        assert.ok(!names.includes(hidden), `"${hidden}" should be filtered in lean mode`);
      }
    });

    await testAsync('full mode includes CSS-invisible elements (unfiltered)', async () => {
      const result = await session.extract({ format: 'full' });
      const names = result.elements.map(e => e.name);
      // full mode does not apply isLeanVisible — at least one hidden element should appear
      const anyPresent = CSS_HIDDEN.some(h => names.includes(h));
      assert.ok(anyPresent, 'full mode should include at least one CSS-invisible element');
    });

    await testAsync('full mode surfaces a cursor:pointer clickable div (source "cursor")', async () => {
      const result = await session.extract({ format: 'full' });
      const close = result.elements.find(e => e.name === 'Close dialog');
      assert.ok(close, '"Close dialog" labelled div should be captured');
      assert.strictEqual(close.source, 'cursor', 'should be included via the cursor path, not role/focusable');
    });

    await testAsync('lean mode surfaces the cursor:pointer clickable div', async () => {
      const result = await session.extract({ format: 'lean' });
      assert.ok(result.elements.some(e => e.name === 'Close dialog'),
        '"Close dialog" should appear in lean output');
    });

    await testAsync('tree mode surfaces the cursor:pointer clickable div', async () => {
      const result = await session.extract({ format: 'tree' });
      function allNames(node, names = []) {
        if (!node) return names;
        if (node.name) names.push(node.name);
        if (node.children) node.children.forEach(c => allNames(c, names));
        return names;
      }
      assert.ok(allNames(result.tree).includes('Close dialog'),
        '"Close dialog" should appear in tree output');
    });

    // ─── Ref / lookup convention ─────────────────────────────────────────────
    const REF_RE = /^@[etr]\d+$/;

    function assertRefInvariants(records, lookup, prefix) {
      const refs = records.map(r => r.ref);
      // a) every record has a ref matching the regex
      for (const ref of refs) {
        assert.ok(REF_RE.test(ref), `ref "${ref}" should match ${REF_RE}`);
        assert.ok(ref.startsWith(prefix), `ref "${ref}" should start with "${prefix}"`);
      }
      // c) counters are dense, start at 1
      const ns = refs.map(r => Number(r.slice(2))).sort((a, b) => a - b);
      ns.forEach((n, i) => assert.strictEqual(n, i + 1, `${prefix} refs should be dense from 1`));
      // b) every ref resolves in lookup to a number
      for (const ref of refs) {
        assert.strictEqual(typeof lookup[ref], 'number', `lookup["${ref}"] should be a number`);
      }
      // d) no backendNodeId leaked onto record bodies
      for (const r of records) {
        assert.strictEqual(r.backendNodeId, undefined, 'record body should not include backendNodeId');
        assert.strictEqual(r.nodeId, undefined, 'record body should not include nodeId');
      }
    }

    await testAsync('lean mode: refs + lookup invariants', async () => {
      const result = await session.extract({ format: 'lean' });
      assert.strictEqual(result.schemaVersion, '2.0');
      assert.ok(result.lookup);
      assertRefInvariants(result.elements, result.lookup, '@e');
      assertRefInvariants(result.text, result.lookup, '@t');
      assertRefInvariants(result.regions || [], result.lookup, '@r');
      const usedRefs = new Set([...result.elements, ...result.text, ...(result.regions || [])].map(r => r.ref));
      const lookupKeys = new Set(Object.keys(result.lookup));
      assert.deepStrictEqual(lookupKeys, usedRefs, 'lookup keys should equal set of used refs');
    });

    await testAsync('full mode: refs + lookup invariants', async () => {
      const result = await session.extract({ format: 'full' });
      assert.strictEqual(result.schemaVersion, '2.0');
      assertRefInvariants(result.elements, result.lookup, '@e');
      assertRefInvariants(result.text, result.lookup, '@t');
      assertRefInvariants(result.regions || [], result.lookup, '@r');
    });

    await testAsync('tree mode: leaves carry refs, lookup covers them', async () => {
      const result = await session.extract({ format: 'tree' });
      const leafRefs = [];
      (function walk(node) {
        if (!node) return;
        if (node.ref) leafRefs.push(node.ref);
        if (node.children) node.children.forEach(walk);
      })(result.tree);
      assert.ok(leafRefs.length > 0, 'tree should have at least one ref leaf');
      for (const ref of leafRefs) {
        assert.ok(REF_RE.test(ref), `ref "${ref}" should match ${REF_RE}`);
        assert.strictEqual(typeof result.lookup[ref], 'number', `lookup["${ref}"] missing`);
      }
    });

    // ─── HiDPI: region bbox is CSS-px and the crop clip maps correctly ────────
    // The coordinate-space risk that fakes can't catch: extract divides snapshot
    // bounds by devicePixelRatio, and the screenshot clip rides on those bounds.
    // We force a 2× display via Emulation so this is deterministic regardless of
    // the physical screen, then check the fixed canvas surfaces at its CSS rect
    // (NOT doubled) and that a clip capture is scaled by the device ratio.
    await testAsync('HiDPI (2×): canvas region is CSS-px; crop clip maps correctly', async () => {
      const { clipForRef } = require('../lib/screenshot');
      await session.client.Emulation.setDeviceMetricsOverride({ width: 1000, height: 800, deviceScaleFactor: 2, mobile: false });
      try {
        await new Promise(r => setTimeout(r, 300));
        const brief = await session.extract({ format: 'lean' });
        const canvas = (brief.regions || []).find(r => r.role === 'canvas');
        assert.ok(canvas, 'fixed canvas should surface as an unreadable region');

        // The crux: bounds come back in CSS px (~40,50,160,90), not device px
        // (~80,100,320,180). A wrong dpr-divide would double these.
        const b = canvas.bbox;
        assert.ok(Math.abs(b.x - 40) <= 2 && Math.abs(b.y - 50) <= 2, `canvas at CSS (${b.x},${b.y}), expected ~(40,50)`);
        assert.ok(Math.abs(b.width - 160) <= 2 && Math.abs(b.height - 90) <= 2, `canvas ${b.width}×${b.height}, expected ~160×90`);

        // Our clip is exactly the bbox; verify, then capture it for real.
        const clip = clipForRef(brief, canvas.ref);
        assert.deepStrictEqual(clip, { x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 });

        const { data } = await session.client.Page.captureScreenshot({ format: 'png', clip, captureBeyondViewport: true });
        const png = Buffer.from(data, 'base64');
        const w = png.readUInt32BE(16), h = png.readUInt32BE(20);   // PNG IHDR width/height
        // scale:1 on a 2× display → the cropped image is the clip scaled by dpr.
        // Assert we're clearly in the 2× regime (not 1×, not the whole viewport),
        // and that the crop kept the canvas's aspect ratio.
        assert.ok(w / b.width > 1.5 && w / b.width < 2.5, `crop width ${w} ≈ ${b.width}×2`);
        assert.ok(h / b.height > 1.5 && h / b.height < 2.5, `crop height ${h} ≈ ${b.height}×2`);
        assert.ok(Math.abs((w / h) - (b.width / b.height)) < 0.1, 'crop preserved the canvas aspect ratio');
      } finally {
        await session.client.Emulation.clearDeviceMetricsOverride().catch(() => {});
      }
    });

  } finally {
    if (session) await session.close();
    server.close();
  }

  printSummary();
})();

function printSummary() {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}
