'use strict';

// Agent-half tests: reduce, validate, execute (cdp backend), and the full loop
// driven by a fake provider + fake session. No Chrome and no network — none of
// these modules pull in chrome-remote-interface, so this file runs anywhere
// (unlike test.js, whose integration half needs a live browser).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { reduce, computeBriefHash } = require('../lib/reduce');
const { validate } = require('../lib/validate');
const registry = require('../lib/actions');
const { createExecutor } = require('../lib/execute');
const planMod = require('../lib/plan');
const { run } = require('../lib/loop');
const { loadConfig, ConfigError } = require('../lib/config');
const { createLogger } = require('../lib/log');
const { estimateTokens } = require('../lib/tokens');

// ─── tiny sequential runner ──────────────────────────────────────────────────
// Sequential matters: the loop tests share the injected fake provider, so they
// must not run concurrently.

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ✓', name); passed++; }
  catch (err) { console.error('  ✗', name); console.error('   ', err.stack || err.message); failed++; }
}

// ─── fixtures ────────────────────────────────────────────────────────────────

// A fresh brief each call so refs stay valid every turn. bbox uses the array
// form to also exercise bboxArr→obj normalization.
function makeBrief(overrides = {}) {
  return {
    schemaVersion: '2.0',
    url: 'http://example.test/',
    title: 'Example',
    timestamp: '2026-01-01T00:00:00Z',
    viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 0 },
    elements: [{ ref: '@e1', role: 'textbox', name: 'Search', bbox: [100, 200, 300, 40] }],
    text: [{ ref: '@t1', role: 'heading', name: 'Welcome', bbox: [100, 50, 300, 30] }],
    lookup: { '@e1': 111, '@t1': 222 },
    stats: {},
    ...overrides,
  };
}

// Fake CDP session: records every client call so tests can assert dispatch.
function makeFakeSession(briefQueue) {
  const calls = [];
  const settleArgs = [];
  let extractCount = 0;
  const client = {
    Input: {
      dispatchMouseEvent: async (p) => { calls.push(['mouse', p]); },
      dispatchKeyEvent:   async (p) => { calls.push(['key', p]); },
      insertText:         async (p) => { calls.push(['insertText', p]); },
    },
    DOM: {
      enable: async () => {},
      getDocument: async () => {},
      pushNodesByBackendIdsToFrontend: async ({ backendNodeIds }) => ({ nodeIds: backendNodeIds.map(() => 9001) }),
      focus: async (p) => { calls.push(['focus', p]); },
    },
    Runtime: {
      // selectText reads the live selection through here; return a fixed string.
      evaluate: async (p) => { calls.push(['evaluate', p]); return { result: { value: 'Selected Heading' } }; },
    },
  };
  return {
    client,
    calls,
    settleArgs,
    get extractCount() { return extractCount; },
    async extract() {
      const b = briefQueue[Math.min(extractCount, briefQueue.length - 1)];
      extractCount++;
      return typeof b === 'function' ? b() : b;   // function ⇒ fresh brief per call
    },
    async settle(opts) { settleArgs.push(opts); return 0; },
    async close() {},
  };
}

// Returns the array of `req` objects the loop sent, so tests can inspect the
// exact prompt assembled each turn.
function installFakeProvider(turns) {
  let i = 0;
  const requests = [];
  planMod.providers.fake = {
    name: 'fake',
    defaultModel: 'fake-1',
    async plan(req) {
      requests.push(req);
      const actions = turns[Math.min(i, turns.length - 1)];
      i++;
      return {
        kind: 'completion', version: '1.0', provider: 'fake', model: 'fake-1',
        raw: {}, actions, usage: {}, elapsedMs: 0,
      };
    },
  };
  return requests;
}

let tuSeq = 0;
function action(verb, extra = {}) {
  return { kind: 'action', verb, args: {}, toolUseId: `tu_${verb}_${++tuSeq}`, ...extra };
}

const baseConfig = (overrides = {}) => ({
  provider: 'fake',
  model: null,
  loop: { maxSteps: 10, shortCircuitOnNoChange: false, pollMs: 0, maxNoChangePolls: 1, maxEmptyPlans: 3, ...(overrides.loop || {}) },
  settle: { afterActionMs: 0, maxMs: 0 },
  view: { includeText: true, includeCoords: true, maxTextChars: 200, dedupeText: true },
  executor: { backend: 'cdp' },
  log: { enabled: false },
});

// ─── suites ──────────────────────────────────────────────────────────────────

async function reduceSuite() {
  console.log('\nreduce:');

  await test('interleaves @e and @t in reading order with coords', () => {
    const v = reduce(makeBrief(), { includeText: true, includeCoords: true });
    const lines = v.listing.split('\n');
    assert.ok(lines[0].includes('@t1'), 'heading (y=50) sorts first');
    assert.ok(lines[1].includes('@e1'), 'textbox (y=200) sorts second');
    assert.match(lines[1], /\(250,220\)/, 'appends rounded (x,y) center');
  });

  await test('includeText:false drops @t lines', () => {
    const v = reduce(makeBrief(), { includeText: false });
    assert.ok(!v.listing.includes('@t1'));
    assert.ok(v.listing.includes('@e1'));
  });

  await test('includeCoords:false omits coordinates', () => {
    const v = reduce(makeBrief(), { includeCoords: false });
    assert.ok(!/\(\d+,\d+\)/.test(v.listing), 'no coords expected');
  });

  await test('marks the focused element and carries url/title', () => {
    const brief = makeBrief({
      url: 'http://example.test/x',
      title: 'X',
      elements: [{ ref: '@e1', role: 'textbox', name: 'Search', bbox: [100, 200, 300, 40], focused: true }],
    });
    const v = reduce(brief, {});
    assert.match(v.listing, /\(focused\)/, 'focused marker present');
    assert.strictEqual(v.url, 'http://example.test/x');
    assert.strictEqual(v.title, 'X');
  });

  await test('dedupeText collapses consecutive identical text', () => {
    const brief = makeBrief({
      elements: [],
      text: [
        { ref: '@t1', role: 'paragraph', name: 'Same', bbox: [0, 10, 50, 10] },
        { ref: '@t2', role: 'paragraph', name: 'Same', bbox: [0, 20, 50, 10] },
        { ref: '@t3', role: 'paragraph', name: 'Other', bbox: [0, 30, 50, 10] },
      ],
      lookup: {},
    });
    const v = reduce(brief, { dedupeText: true });
    assert.strictEqual((v.listing.match(/Same/g) || []).length, 1, 'adjacent identical collapses');
    assert.ok(v.listing.includes('Other'));
  });

  await test('bbox-less nodes do not throw and order deterministically', () => {
    const brief = makeBrief({
      elements: [{ ref: '@e1', role: 'button', name: 'A' }, { ref: '@e2', role: 'link', name: 'B' }],
      text: [], lookup: { '@e1': 1, '@e2': 2 },
    });
    assert.strictEqual(reduce(brief, {}).listing, reduce(brief, {}).listing);
  });

  await test('computeBriefHash: stable on content, ignores bbox, changes on name', () => {
    const a = makeBrief();
    assert.strictEqual(computeBriefHash(a), computeBriefHash(makeBrief()));
    const moved = makeBrief({ elements: [{ ref: '@e1', role: 'textbox', name: 'Search', bbox: [9, 9, 1, 1] }] });
    assert.strictEqual(computeBriefHash(a), computeBriefHash(moved), 'bbox excluded from hash');
    const renamed = makeBrief({ elements: [{ ref: '@e1', role: 'textbox', name: 'Find', bbox: [100, 200, 300, 40] }] });
    assert.notStrictEqual(computeBriefHash(a), computeBriefHash(renamed), 'name change busts hash');
  });
}

async function validateSuite() {
  console.log('\nvalidate:');

  await test('accepts well-formed click/type/scroll/press/done', () => {
    const { ok, errors } = validate([
      action('click', { ref: '@e1' }),
      action('type', { ref: '@e1', args: { text: 'hi' } }),
      action('scroll', { args: { direction: 'down' } }),
      action('press', { args: { key: 'Enter' } }),
      action('done', { args: {} }),
    ], { '@e1': 111 }, registry);
    assert.strictEqual(errors.length, 0, JSON.stringify(errors));
    assert.strictEqual(ok.length, 5);
  });

  await test('click accepts both @e and @t targets', () => {
    const lookup = { '@e1': 111, '@t1': 222 };
    const { ok, errors } = validate([
      action('click', { ref: '@e1' }),
      action('click', { ref: '@t1' }),
    ], lookup, registry);
    assert.strictEqual(errors.length, 0, JSON.stringify(errors));
    assert.strictEqual(ok.length, 2);
  });

  await test('rejects wrong ref type, unknown verb, missing arg, bad/absent ref', () => {
    const lookup = { '@e1': 111, '@t1': 222 };
    const cases = [
      [action('type', { ref: '@t1', args: { text: 'x' } }), /requires ref type/],  // type is @e-only
      [action('frobnicate', { ref: '@e1' }), /unknown verb/],
      [action('type', { ref: '@e1', args: {} }), /missing required arg "text"/],
      [action('click', { ref: '@e9' }), /not present in current snapshot/],
      [action('scroll', { args: {} }), /missing required arg "direction"/],
    ];
    for (const [act, re] of cases) {
      const { ok, errors } = validate([act], lookup, registry);
      assert.strictEqual(ok.length, 0);
      assert.match(errors[0].error, re);
    }
  });

  await test('tolerates extra args', () => {
    const { ok } = validate([action('press', { args: { key: 'Enter', bogus: 1 } })], {}, registry);
    assert.strictEqual(ok.length, 1);
  });

  await test('malformed action records an error instead of throwing', () => {
    const { ok, errors } = validate([null, 'bad'], {}, registry);
    assert.strictEqual(ok.length, 0);
    assert.strictEqual(errors.length, 2);
    assert.match(errors[0].error, /action must be an object/);
  });

  await test('non-array actions payload records an error instead of throwing', () => {
    const { ok, errors } = validate({ verb: 'done', args: {} }, {}, registry);
    assert.strictEqual(ok.length, 0);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].error, /actions must be an array/);
  });
}

async function executeSuite() {
  console.log('\nexecute (cdp):');

  await test('click dispatches mouse at bbox-center minus scroll', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, { afterActionMs: 0, maxMs: 0 });
    const [obs] = await exec.execute([action('click', { ref: '@e1' })], session, makeBrief());
    assert.strictEqual(obs.status, 'ok', obs.error);
    const moves = session.calls.filter(c => c[0] === 'mouse');
    assert.strictEqual(moves.length, 3, 'move/press/release');
    assert.strictEqual(moves[0][1].x, 250);  // 100 + 300/2
    assert.strictEqual(moves[0][1].y, 220);  // 200 + 40/2
  });

  await test('click on a @t text node dispatches mouse at its bbox center', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, { afterActionMs: 0, maxMs: 0 });
    const [obs] = await exec.execute([action('click', { ref: '@t1' })], session, makeBrief());
    assert.strictEqual(obs.status, 'ok', obs.error);
    const moves = session.calls.filter(c => c[0] === 'mouse');
    assert.strictEqual(moves.length, 3, 'move/press/release');
    assert.strictEqual(moves[0][1].x, 250);  // @t1 bbox [100,50,300,30] → 100 + 300/2
    assert.strictEqual(moves[0][1].y, 65);   // 50 + 30/2
  });

  await test('type focuses via pushed nodeId then insertText', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, {});
    const [obs] = await exec.execute([action('type', { ref: '@e1', args: { text: 'hello' } })], session, makeBrief());
    assert.strictEqual(obs.status, 'ok', obs.error);
    assert.ok(session.calls.some(c => c[0] === 'focus' && c[1].nodeId === 9001));
    assert.ok(session.calls.some(c => c[0] === 'insertText' && c[1].text === 'hello'));
  });

  await test('press Enter dispatches keyDown+keyUp', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, {});
    const [obs] = await exec.execute([action('press', { args: { key: 'Enter' } })], session, makeBrief());
    assert.strictEqual(obs.status, 'ok', obs.error);
    const keys = session.calls.filter(c => c[0] === 'key');
    assert.strictEqual(keys.length, 2);
    assert.strictEqual(keys[0][1].type, 'keyDown');
    assert.strictEqual(keys[0][1].key, 'Enter');
    assert.strictEqual(keys[1][1].type, 'keyUp');
  });

  await test('scroll down dispatches a positive-deltaY wheel at viewport center', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, {});
    const [obs] = await exec.execute([action('scroll', { args: { direction: 'down' } })], session, makeBrief());
    assert.strictEqual(obs.status, 'ok', obs.error);
    const wheel = session.calls.find(c => c[0] === 'mouse' && c[1].type === 'mouseWheel');
    assert.ok(wheel, 'expected a mouseWheel event');
    assert.ok(wheel[1].deltaY > 0, 'down scrolls with positive deltaY');
    assert.strictEqual(wheel[1].x, 500);
    assert.strictEqual(wheel[1].y, 400);
  });

  await test('unknown scroll direction is an error observation with no wheel dispatch', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, {});
    const [obs] = await exec.execute([action('scroll', { args: { direction: 'sideways' } })], session, makeBrief());
    assert.strictEqual(obs.status, 'error');
    assert.match(obs.error, /unknown scroll direction/);
    assert.ok(!session.calls.some(c => c[0] === 'mouse' && c[1].type === 'mouseWheel'));
  });

  await test('done is ok with no dispatch and no settle', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, {});
    const [obs] = await exec.execute([action('done', { args: { result: 'x' } })], session, makeBrief());
    assert.strictEqual(obs.status, 'ok');
    assert.strictEqual(session.calls.length, 0, 'done dispatches nothing');
    assert.strictEqual(session.settleArgs.length, 0, 'done does not settle');
  });

  await test('settle receives the run settle config', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, { afterActionMs: 321, maxMs: 999 });
    await exec.execute([action('press', { args: { key: 'Tab' } })], session, makeBrief());
    assert.deepStrictEqual(session.settleArgs[0], { afterActionMs: 321, maxMs: 999 });
  });

  await test('invalid ref yields an error observation, not a throw', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, {});
    const [obs] = await exec.execute([action('click', { ref: '@e9' })], session, makeBrief());
    assert.strictEqual(obs.status, 'error');
    assert.match(obs.error, /not found in brief/);
  });
}

async function configSuite() {
  console.log('\nconfig:');

  await test('invalid config JSON fails explicitly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-recon-config-'));
    const file = path.join(dir, 'bad.json');
    try {
      fs.writeFileSync(file, '{ bad json');
      assert.throws(() => loadConfig({ path: file, reload: true }), ConfigError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

async function logSuite() {
  console.log('\nlog:');

  await test('disabled logger is a no-op and creates no files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-recon-log-'));
    const logDir = path.join(dir, 'logs');
    try {
      const logger = createLogger({ enabled: false, dir: logDir });
      logger.event({ kind: 'turn' });
      logger.finalize({ status: 'completed', result: null, stats: {} });
      assert.strictEqual(fs.existsSync(logDir), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

async function tokenSuite() {
  console.log('\ntokens:');

  await test('estimateTokens approximates strings and message objects', () => {
    assert.strictEqual(estimateTokens(''), 0);
    assert.strictEqual(estimateTokens('abcd'), 1);
    assert.strictEqual(estimateTokens({ role: 'user', content: 'abcdefgh' }), 4);
  });
}

async function loopSuite() {
  console.log('\nloop:');

  await test('type → press → scroll → done drives to completed', async () => {
    installFakeProvider([
      [action('type', { ref: '@e1', args: { text: 'hello' } })],
      [action('press', { args: { key: 'Enter' } })],
      [action('scroll', { args: { direction: 'down' } })],
      [action('done', { args: { result: 'searched' } })],
    ]);
    const session = makeFakeSession([makeBrief, makeBrief, makeBrief, makeBrief]);
    const r = await run({ session, task: 'search hello', config: baseConfig() });
    assert.strictEqual(r.status, 'completed', r.error);
    assert.strictEqual(r.result, 'searched');
    assert.deepStrictEqual(r.steps.map(s => s.action.verb), ['type', 'press', 'scroll', 'done']);
    assert.ok(session.calls.some(c => c[0] === 'insertText' && c[1].text === 'hello'));
    assert.ok(session.calls.some(c => c[0] === 'key' && c[1].key === 'Enter'));
    assert.ok(session.calls.some(c => c[0] === 'mouse' && c[1].type === 'mouseWheel'));
  });

  await test('an all-invalid turn feeds the error back and the run continues', async () => {
    installFakeProvider([
      [action('type', { ref: '@t1', args: { text: 'x' } })],  // invalid: type is @e-only
      [action('done', { args: { result: 'ok' } })],
    ]);
    const session = makeFakeSession([makeBrief, makeBrief]);
    const r = await run({ session, task: 'x', config: baseConfig() });
    assert.strictEqual(r.status, 'completed', r.error);
    assert.strictEqual(r.steps.length, 1, 'only the done step executed');
    assert.strictEqual(r.steps[0].action.verb, 'done');
  });

  await test('no-change short-circuit polls until the page changes', async () => {
    installFakeProvider([
      [action('press', { args: { key: 'ArrowDown' } })],  // executes; page "unchanged"
      [action('done', { args: {} })],
    ]);
    const same1 = makeBrief();
    const same2 = makeBrief();                          // identical content ⇒ same hash
    const changed = makeBrief({ title: 'Changed' });    // different hash
    const session = makeFakeSession([same1, same2, changed]);
    const r = await run({
      session, task: 'x',
      config: baseConfig({ loop: { shortCircuitOnNoChange: true, pollMs: 0, maxNoChangePolls: 5 } }),
    });
    assert.strictEqual(r.status, 'completed', r.error);
    // turn1: 1 extract; turn2: 1 (same) + 1 (poll→changed) = 2 ⇒ 3 total
    assert.strictEqual(session.extractCount, 3);
  });

  await test('max-steps is honored', async () => {
    installFakeProvider([[action('press', { args: { key: 'ArrowDown' } })]]);  // never finishes
    const session = makeFakeSession([makeBrief]);
    const r = await run({ session, task: 'x', config: baseConfig({ loop: { maxSteps: 3 } }) });
    assert.strictEqual(r.status, 'max-steps');
    assert.strictEqual(r.steps.length, 3);
  });

  await test('empty-plan guard aborts after consecutive no-action turns', async () => {
    installFakeProvider([[], [], [], [action('done', { args: {} })]]);
    const session = makeFakeSession([makeBrief, makeBrief, makeBrief, makeBrief]);
    const r = await run({
      session,
      task: 'x',
      config: baseConfig({ loop: { maxEmptyPlans: 3 } }),
    });
    assert.strictEqual(r.status, 'empty-plan');
    assert.match(r.result, /no actions for 3 consecutive turns/);
    assert.strictEqual(r.steps.length, 0);
  });

  await test('no-op guard aborts when the model repeats a dead action', async () => {
    installFakeProvider([[action('click', { ref: '@e1' })]]);  // same click forever
    const session = makeFakeSession([makeBrief]);              // page never changes ⇒ no-op
    const r = await run({
      session, task: 'x',
      config: baseConfig({ loop: { shortCircuitOnNoChange: true, pollMs: 0, maxNoChangePolls: 1, maxStuckRepeats: 2 } }),
    });
    assert.strictEqual(r.status, 'stuck', r.error);
    // click executes twice; the 3rd identical pick (with no page change) aborts.
    assert.strictEqual(r.steps.length, 2);
  });

  await test('selectText reports the selected text and skips the no-change wait', async () => {
    const reqs = installFakeProvider([
      [action('selectText', { ref: '@t1' })],
      [action('done', { args: {} })],
    ]);
    const session = makeFakeSession([makeBrief, makeBrief]);
    const r = await run({
      session, task: 'x',
      config: baseConfig({ loop: { shortCircuitOnNoChange: true, pollMs: 0, maxNoChangePolls: 5 } }),
    });
    assert.strictEqual(r.status, 'completed', r.error);
    // The next turn's prompt must show what got selected.
    assert.match(reqs[1].messages[0].content, /selected: "Selected Heading"/);
    // changesPage:false ⇒ no polling for a change that never comes: exactly one
    // extract per turn (2), not 2 + the maxNoChangePolls extras.
    assert.strictEqual(session.extractCount, 2);
  });

  await test('turn message carries URL (fragment stripped), title, and scroll position', async () => {
    const reqs = installFakeProvider([[action('done', { args: {} })]]);
    const brief = makeBrief({
      url: 'http://example.test/feed#tracking=abc123',
      title: 'My Feed',
      viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 400, contentHeight: 2400 },
    });
    await run({ session: makeFakeSession([brief]), task: 'x', config: baseConfig() });
    const msg = reqs[0].messages[0].content;
    assert.ok(msg.includes('URL: http://example.test/feed'), 'url present');
    assert.ok(!msg.includes('tracking=abc123'), 'fragment stripped');
    assert.ok(msg.includes('Title: My Feed'), 'title present');
    assert.match(msg, /scrolled 400\/2400px/, 'scroll position present');
  });

  await test('repeating an action does NOT abort when the page keeps changing', async () => {
    installFakeProvider([
      [action('click', { ref: '@e1' })],
      [action('click', { ref: '@e1' })],
      [action('done', { args: {} })],
    ]);
    // Distinct hashes each turn ⇒ changed=true ⇒ streak never builds.
    const session = makeFakeSession([
      () => makeBrief({ title: 'A' }),
      () => makeBrief({ title: 'B' }),
      () => makeBrief({ title: 'C' }),
    ]);
    const r = await run({
      session, task: 'x',
      config: baseConfig({ loop: { shortCircuitOnNoChange: true, pollMs: 0, maxNoChangePolls: 1, maxStuckRepeats: 2 } }),
    });
    assert.strictEqual(r.status, 'completed', r.error);
  });
}

async function memorySuite() {
  console.log('\nmemory (event log):');

  await test('prompt carries the event log + current page, not a transcript', async () => {
    const reqs = installFakeProvider([
      [action('type', { ref: '@e1', args: { text: 'hello' } })],
      [action('done', { args: {} })],
    ]);
    const session = makeFakeSession([makeBrief, makeBrief]);
    const r = await run({ session, task: 'find hello', config: baseConfig() });
    assert.strictEqual(r.status, 'completed', r.error);

    // turn 1: exactly one user message, no replayed assistant turns
    assert.strictEqual(reqs[0].messages.length, 1);
    assert.strictEqual(reqs[0].messages[0].role, 'user');
    const t1 = reqs[0].messages[0].content;
    assert.ok(t1.includes('find hello'), 'task present');
    assert.match(t1, /nothing yet/, 'empty progress on first turn');
    assert.ok(t1.includes('@e1'), 'current page listing present');

    // turn 2: progress now records the type; still one user message, no replay
    assert.strictEqual(reqs[1].messages.length, 1);
    assert.ok(!reqs[1].messages.some(m => m.role === 'assistant'), 'no transcript replay');
    assert.match(reqs[1].messages[0].content, /typed "hello" into "Search"/);
  });

  await test('turn log includes the simplified LLM payload', async () => {
    installFakeProvider([[action('done', { args: {} })]]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-recon-log-'));
    const session = makeFakeSession([makeBrief]);
    const r = await run({
      session,
      task: 'find hello',
      config: { ...baseConfig(), log: { enabled: true, dir } },
    });
    assert.strictEqual(r.status, 'completed', r.error);

    const file = fs.readdirSync(dir).find(f => f.endsWith('.jsonl'));
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').map(JSON.parse);
    const turn = lines.find(l => l.kind === 'turn');
    assert.strictEqual(turn.llmPayload.messages.length, 1);
    assert.ok(turn.llmPayload.estimatedTokens > 0);
    assert.strictEqual(turn.llmPayload.messages[0].role, 'user');
    assert.ok(turn.llmPayload.messages[0].content.includes('find hello'));
    assert.ok(turn.llmPayload.messages[0].content.includes('@e1'));
  });

  await test('only the current page is included, not prior snapshots', async () => {
    const reqs = installFakeProvider([
      [action('scroll', { args: { direction: 'down' } })],  // event has no ref
      [action('done', { args: {} })],
    ]);
    const session = makeFakeSession([makeBrief, makeBrief]);
    await run({ session, task: 'x', config: baseConfig() });
    // '@e1' lives only in the page listing; it must appear once in turn 2's
    // prompt (current page), not twice (current + a replayed prior snapshot).
    const t2 = reqs[1].messages[0].content;
    assert.strictEqual((t2.match(/@e1/g) || []).length, 1, 'no accumulated snapshots');
  });

  await test('navigation between turns is recorded as an event', async () => {
    const reqs = installFakeProvider([
      [action('click', { ref: '@e1' })],
      [action('done', { args: {} })],
    ]);
    const session = makeFakeSession([
      makeBrief({ url: 'http://example.test/a' }),
      makeBrief({ url: 'http://example.test/b' }),
    ]);
    const r = await run({ session, task: 'go', config: baseConfig() });
    assert.strictEqual(r.status, 'completed', r.error);
    const t2 = reqs[1].messages[0].content;
    assert.match(t2, /navigated to http:\/\/example\.test\/b/);
    assert.match(t2, /clicked "Search"/);
  });

  await test('a rejected action is recorded with its reason', async () => {
    const reqs = installFakeProvider([
      [action('type', { ref: '@t1', args: { text: 'x' } })],   // type is @e-only ⇒ rejected
      [action('done', { args: {} })],
    ]);
    const session = makeFakeSession([makeBrief, makeBrief]);
    const r = await run({ session, task: 'x', config: baseConfig() });
    assert.strictEqual(r.status, 'completed', r.error);
    const t2 = reqs[1].messages[0].content;
    assert.match(t2, /rejected:/);
    assert.match(t2, /typed "x" into "Welcome"/);   // @t1's name is "Welcome"
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

(async () => {
  await reduceSuite();
  await validateSuite();
  await executeSuite();
  await configSuite();
  await logSuite();
  await tokenSuite();
  await loopSuite();
  await memorySuite();
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
