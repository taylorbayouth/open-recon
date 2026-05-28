'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const { flattenProperties, isInViewport, isLeanVisible, bboxArr } = require('../lib/extract');
const { isRunning } = require('../lib/launch');
const { connect } = require('../lib/connect');
const { resolveKey, scrollDeltaY } = require('../lib/executors/cdp');
const { computeScreenPoint } = require('../lib/executors/os');
const ACTIONS = require('../lib/actions');

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

test('isLeanVisible: opacity:0', () => {
  assert.strictEqual(isLeanVisible({ x: 0, y: 0, width: 100, height: 50 }, { opacity: '0' }), false);
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

test('bboxArr: rounds floats and returns array', () => {
  const result = bboxArr({ x: 1.7, y: 2.3, width: 100.9, height: 50.1 });
  assert.deepStrictEqual(result, [2, 2, 101, 50]);
});

// ─── Action registry: new verbs ──────────────────────────────────────────────

test('registry: scroll/key/navigate are refless with expected args', () => {
  for (const verb of ['scroll', 'key', 'navigate']) {
    assert.ok(ACTIONS[verb], `${verb} should be registered`);
    assert.strictEqual(ACTIONS[verb].requiresRef, false, `${verb} should not require a ref`);
  }
  assert.strictEqual(ACTIONS.scroll.args.direction, 'string');
  assert.strictEqual(ACTIONS.scroll.args.amount, 'number?');
  assert.strictEqual(ACTIONS.key.args.key, 'string');
  assert.strictEqual(ACTIONS.navigate.args.url, 'string');
});

// ─── CDP key resolution ───────────────────────────────────────────────────────

test('resolveKey: enter carries text and keyCode 13', () => {
  const k = resolveKey('Enter');
  assert.strictEqual(k.keyCode, 13);
  assert.strictEqual(k.key, 'Enter');
  assert.strictEqual(k.text, '\r');
});

test('resolveKey: case-insensitive and aliases', () => {
  assert.strictEqual(resolveKey('enter').keyCode, resolveKey('return').keyCode);
  assert.strictEqual(resolveKey('ESC').keyCode, 27);
  // delete is aliased to backspace to match the OS helper
  assert.strictEqual(resolveKey('delete').keyCode, resolveKey('backspace').keyCode);
});

test('resolveKey: rawKeyDown keys carry no text', () => {
  assert.strictEqual(resolveKey('Tab').text, undefined);
  assert.strictEqual(resolveKey('ArrowDown').keyCode, 40);
});

test('resolveKey: unknown key throws', () => {
  assert.throws(() => resolveKey('NopeKey'), /unknown key/);
});

// ─── CDP scroll delta ─────────────────────────────────────────────────────────

test('scrollDeltaY: down is positive, up is negative', () => {
  assert.strictEqual(scrollDeltaY('down', 300, 800), 300);
  assert.strictEqual(scrollDeltaY('up', 300, 800), -300);
});

test('scrollDeltaY: default amount is ~80% of viewport height', () => {
  assert.strictEqual(scrollDeltaY('down', undefined, 1000), 800);
  assert.strictEqual(scrollDeltaY('up', 0, 1000), -800);   // 0/NaN falls back
  assert.strictEqual(scrollDeltaY('down', undefined, undefined), 640); // 800*0.8
});

// ─── OS page→screen coordinate math ──────────────────────────────────────────

test('computeScreenPoint: window origin + chrome offset, no scroll', () => {
  const p = computeScreenPoint({
    windowBounds: { left: 100, top: 50, width: 1200, height: 900 },
    layout: { clientWidth: 1200, clientHeight: 800, pageX: 0, pageY: 0 },
    visual: { clientWidth: 1200, clientHeight: 800 },
    pageX: 10, pageY: 20,
  });
  // chromeOffsetY = 900-800 = 100, chromeOffsetX = 0
  assert.deepStrictEqual(p, { x: 100 + 0 + 10, y: 50 + 100 + 20 });
});

test('computeScreenPoint: subtracts scroll offset', () => {
  const p = computeScreenPoint({
    windowBounds: { left: 0, top: 0, width: 1200, height: 888 },
    layout: { clientWidth: 1200, clientHeight: 800, pageX: 5, pageY: 300 },
    visual: { clientWidth: 1200, clientHeight: 800 },
    pageX: 50, pageY: 500,
  });
  // chromeOffsetY = 888-800 = 88; y = 0 + 88 + (500-300) = 288
  assert.deepStrictEqual(p, { x: 0 + 0 + (50 - 5), y: 288 });
});

test('computeScreenPoint: 88px fallback when no viewport metrics', () => {
  const p = computeScreenPoint({
    windowBounds: { left: 0, top: 0, width: 1000, height: 900 },
    layout: {}, visual: {},
    pageX: 0, pageY: 0,
  });
  // cssViewportHeight falls back to height-88 = 812 → chromeOffsetY = 88
  assert.strictEqual(p.y, 88);
  assert.strictEqual(p.x, 0);
});

// ─── Integration tests (requires Chrome running on port 9222) ────────────────

(async () => {
  const chromeAvailable = await isRunning(9222);
  if (!chromeAvailable) {
    console.log('\nIntegration tests: skipped (Chrome not running on port 9222)');
    console.log('  Run `npm run launch` then `node test/test.js` to include them.\n');
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

    // ─── Ref / lookup convention ─────────────────────────────────────────────
    const REF_RE = /^@[et]\d+$/;

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
      const usedRefs = new Set([...result.elements, ...result.text].map(r => r.ref));
      const lookupKeys = new Set(Object.keys(result.lookup));
      assert.deepStrictEqual(lookupKeys, usedRefs, 'lookup keys should equal set of used refs');
    });

    await testAsync('full mode: refs + lookup invariants', async () => {
      const result = await session.extract({ format: 'full' });
      assert.strictEqual(result.schemaVersion, '2.0');
      assertRefInvariants(result.elements, result.lookup, '@e');
      assertRefInvariants(result.text, result.lookup, '@t');
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
