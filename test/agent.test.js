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
const { loadConfig, deepMerge, DEFAULTS, ConfigError } = require('../lib/config');
const { createLogger } = require('../lib/log');
const { estimateTokens } = require('../lib/tokens');
const shared = require('../lib/providers/_shared');
const { normalizeUrl } = require('../lib/executors/page');
const { createScratchpad } = require('../lib/scratchpad');
const { buildSystemPrompt } = require('../lib/prompt');

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

  await test('deepMerge preserves sibling defaults and skips undefined overrides', () => {
    const merged = deepMerge(DEFAULTS, {
      loop: { maxSteps: 7, pollMs: undefined },
      view: { includeCoords: false },
    });
    assert.strictEqual(merged.loop.maxSteps, 7);
    assert.strictEqual(merged.loop.pollMs, DEFAULTS.loop.pollMs);
    assert.strictEqual(merged.loop.shortCircuitOnNoChange, DEFAULTS.loop.shortCircuitOnNoChange);
    assert.strictEqual(merged.view.includeCoords, false);
    assert.strictEqual(merged.executor.backend, DEFAULTS.executor.backend);
  });

  await test('env overrides do not mutate DEFAULTS across reloads', () => {
    const oldProvider = process.env.OPEN_RECON_PROVIDER;
    const oldExecutor = process.env.OPEN_RECON_EXECUTOR;
    try {
      process.env.OPEN_RECON_PROVIDER = 'anthropic';
      process.env.OPEN_RECON_EXECUTOR = 'cdp';
      const overridden = loadConfig({ path: path.join(os.tmpdir(), 'missing-open-recon-config.json'), reload: true });
      assert.strictEqual(overridden.provider, 'anthropic');
      assert.strictEqual(overridden.executor.backend, 'cdp');

      delete process.env.OPEN_RECON_PROVIDER;
      delete process.env.OPEN_RECON_EXECUTOR;
      const fresh = loadConfig({ path: path.join(os.tmpdir(), 'missing-open-recon-config.json'), reload: true });
      assert.strictEqual(fresh.provider, DEFAULTS.provider);
      assert.strictEqual(fresh.executor.backend, DEFAULTS.executor.backend);
    } finally {
      if (oldProvider === undefined) delete process.env.OPEN_RECON_PROVIDER;
      else process.env.OPEN_RECON_PROVIDER = oldProvider;
      if (oldExecutor === undefined) delete process.env.OPEN_RECON_EXECUTOR;
      else process.env.OPEN_RECON_EXECUTOR = oldExecutor;
      loadConfig({ path: path.join(os.tmpdir(), 'missing-open-recon-config.json'), reload: true });
    }
  });

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

async function scratchpadSuite() {
  console.log('\nscratchpad:');

  await test('disabled scratchpad performs no filesystem writes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-recon-scratch-'));
    try {
      const scratch = createScratchpad({ enabled: false, dir, runId: 'x' });
      scratch.append({ title: 'Ignored', text: 'Nope' });
      assert.strictEqual(scratch.saveText({ content: 'Nope' }), null);
      assert.strictEqual(scratch.saveImage({ base64: Buffer.from('x').toString('base64') }), null);
      assert.strictEqual(scratch.readMarkdown(), '');
      assert.deepStrictEqual(fs.readdirSync(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('saveText and saveImage persist assets and markdown references', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-recon-scratch-'));
    try {
      const scratch = createScratchpad({ dir, runId: 'run-1' });
      const text = scratch.saveText({ content: 'Full captured text', summary: 'Captured note', url: 'https://example.test/a' });
      const image = scratch.saveImage({ base64: Buffer.from('png bytes').toString('base64'), title: 'Shot' });
      const md = scratch.readMarkdown();

      assert.strictEqual(fs.readFileSync(text.path, 'utf8'), 'Full captured text');
      assert.strictEqual(fs.readFileSync(image.path, 'utf8'), 'png bytes');
      assert.ok(md.includes('### Captured note'));
      assert.ok(md.includes('- File: assets/note-1.txt'));
      assert.ok(md.includes('- Image: assets/screenshot-1.png'));
      assert.strictEqual(scratch.textCount, 1);
      assert.strictEqual(scratch.imageCount, 1);
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

async function promptSuite() {
  console.log('\nprompt:');

  await test('system prompt renders action signatures from the registry', () => {
    const prompt = buildSystemPrompt({
      click: registry.click,
      type: registry.type,
      done: registry.done,
    });
    assert.ok(prompt.includes('click[@e|@t]'), 'click ref types should be shown');
    assert.ok(prompt.includes('type[@e] (text: string)'), 'required args should be shown');
    assert.ok(prompt.includes('done (result: string?)'), 'optional args should be marked');
  });

  await test('context is omitted (no header) when null/empty', () => {
    const reg = { click: registry.click, done: registry.done };
    const base = buildSystemPrompt(reg);
    assert.ok(!base.includes('Context ('), 'no context header when absent');
    assert.strictEqual(buildSystemPrompt(reg, null), base, 'null → identical to no arg');
    assert.strictEqual(buildSystemPrompt(reg, '   '), base, 'whitespace-only → omitted');
  });

  await test('context, when present, is appended as a trusted block at the very end', () => {
    const reg = { click: registry.click, done: registry.done };
    const base = buildSystemPrompt(reg);
    const ctx = 'The user is Taylor; prefers concise replies.';
    const withCtx = buildSystemPrompt(reg, ctx);
    // The static template must remain an unmodified prefix, so providers can
    // cache it across runs regardless of the per-run context value.
    assert.ok(withCtx.startsWith(base), 'static template stays an intact prefix');
    assert.ok(withCtx.endsWith(ctx), 'context sits at the very end (nothing cacheable after it)');
    assert.ok(withCtx.includes('Context ('), 'trusted header is shown when present');
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

// Provider wire-format translation lives in _shared.js and feeds all three
// providers. A regression here silently breaks a whole provider, and the loop
// tests use a fake provider that never exercises it — so test it directly.
async function providerTranslationSuite() {
  console.log('\nprovider translation (_shared):');
  const { buildJsonSchema, hoistRef, openaiStyleMessages, parseOpenAIStyleToolCalls } = shared;

  await test('buildJsonSchema marks optional (?) fields not-required', () => {
    const s = buildJsonSchema({ text: 'string', amount: 'number?' });
    assert.deepStrictEqual(s.required, ['text']);
    assert.strictEqual(s.properties.amount.type, 'number');
  });

  await test('hoistRef splits ref from the rest of the args', () => {
    assert.deepStrictEqual(hoistRef({ ref: '@e1', text: 'hi' }), { ref: '@e1', args: { text: 'hi' } });
    assert.deepStrictEqual(hoistRef({ direction: 'down' }), { ref: undefined, args: { direction: 'down' } });
  });

  await test('openaiStyleMessages: system hoisted, string content passthrough', () => {
    const out = openaiStyleMessages('SYS', [{ role: 'user', content: 'hello' }], { argsAsString: true });
    assert.deepStrictEqual(out, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hello' }]);
  });

  await test('openaiStyleMessages: assistant tool_use → tool_calls (args stringified)', () => {
    const msgs = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'click', input: { ref: '@e1' } }] }];
    const out = openaiStyleMessages(null, msgs, { argsAsString: true });
    assert.strictEqual(out[0].content, null, 'OpenAI wants null content alongside tool_calls');
    assert.strictEqual(out[0].tool_calls[0].function.name, 'click');
    assert.strictEqual(out[0].tool_calls[0].function.arguments, JSON.stringify({ ref: '@e1' }));
  });

  await test('openaiStyleMessages: tool_result → standalone role:tool message', () => {
    const msgs = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] }];
    const out = openaiStyleMessages(null, msgs, { argsAsString: true });
    assert.strictEqual(out[0].role, 'tool');
    assert.strictEqual(out[0].tool_call_id, 'tu1');
    assert.strictEqual(out[0].content, 'ok');
  });

  await test('parseOpenAIStyleToolCalls: JSON-string args → Action with hoisted ref', () => {
    const calls = [{ id: 'c1', function: { name: 'type', arguments: JSON.stringify({ ref: '@e2', text: 'hi' }) } }];
    const [a] = parseOpenAIStyleToolCalls(calls, { argsAsString: true });
    assert.deepStrictEqual(a, { kind: 'action', verb: 'type', args: { text: 'hi' }, ref: '@e2', toolUseId: 'c1' });
  });

  await test('parseOpenAIStyleToolCalls: object args (ollama) + synthesized id', () => {
    const calls = [{ function: { name: 'scroll', arguments: { direction: 'down' } } }];
    const [a] = parseOpenAIStyleToolCalls(calls, { argsAsString: false, synthId: (i) => 'synth' + i });
    assert.deepStrictEqual(a.args, { direction: 'down' });
    assert.strictEqual(a.toolUseId, 'synth0');
  });

  await test('parseOpenAIStyleToolCalls: malformed JSON args default to {}', () => {
    const calls = [{ id: 'c1', function: { name: 'done', arguments: '{not json' } }];
    const [a] = parseOpenAIStyleToolCalls(calls, { argsAsString: true });
    assert.deepStrictEqual(a.args, {});
  });
}

async function cacheSuite() {
  console.log('\nprompt caching (provider breakpoints):');
  const { toAnthropicTools } = require('../lib/providers/anthropic');

  await test('anthropic: cache breakpoint lands only on the last tool', () => {
    const tools = [
      { name: 'click', inputSchema: { ref: 'string' } },
      { name: 'done', inputSchema: { result: 'string?' } },
    ];
    const out = toAnthropicTools(tools);
    assert.strictEqual(out[0].cache_control, undefined, 'non-last tools carry no breakpoint');
    assert.deepStrictEqual(out[out.length - 1].cache_control, { type: 'ephemeral' },
      'the last tool caches the tool-definitions prefix');
    assert.strictEqual(out[1].name, 'done', 'tool order/content is otherwise preserved');
  });

  await test('anthropic: empty tool list is handled without a breakpoint', () => {
    assert.deepStrictEqual(toAnthropicTools([]), []);
    assert.deepStrictEqual(toAnthropicTools(undefined), []);
  });
}

async function normalizeUrlSuite() {
  console.log('\nnormalizeUrl (scheme allowlist):');

  await test('prepends https:// to a bare host', () => {
    assert.strictEqual(normalizeUrl('example.com'), 'https://example.com/');
  });

  await test('keeps an explicit http/https url', () => {
    assert.strictEqual(normalizeUrl('http://example.com/x'), 'http://example.com/x');
  });

  await test('rejects non-web schemes (file/chrome/about/view-source)', () => {
    for (const u of ['file:///etc/passwd', 'chrome://settings', 'about:blank', 'view-source:http://x']) {
      assert.throws(() => normalizeUrl(u), `${u} should be rejected`);
    }
  });

  await test('rejects an empty url', () => {
    assert.throws(() => normalizeUrl('   '), /requires a url/);
  });
}

// Exercises the timeout + retry guard in postJSON by swapping global fetch.
async function postJSONSuite() {
  console.log('\npostJSON (timeout + retry):');
  const { postJSON } = shared;
  const origFetch = global.fetch;
  const res = (status, payload) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: { get: () => null },   // no Retry-After
  });

  await test('returns parsed JSON on success without retrying', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; return res(200, { ok: true }); };
    try {
      assert.deepStrictEqual(await postJSON('http://x', { body: {}, retries: 2 }), { ok: true });
      assert.strictEqual(calls, 1);
    } finally { global.fetch = origFetch; }
  });

  await test('retries a 503 then succeeds', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; return calls < 3 ? res(503, {}) : res(200, { done: true }); };
    try {
      assert.deepStrictEqual(await postJSON('http://x', { body: {}, retries: 3 }), { done: true });
      assert.strictEqual(calls, 3);
    } finally { global.fetch = origFetch; }
  });

  await test('fails fast on a 400 (no retry)', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; return res(400, { error: 'bad' }); };
    try {
      await assert.rejects(() => postJSON('http://x', { body: {}, retries: 3, label: 'Test' }), /Test 400/);
      assert.strictEqual(calls, 1);
    } finally { global.fetch = origFetch; }
  });

  await test('aborts on timeout and surfaces a timeout error', async () => {
    // Hang until aborted, then reject with the abort reason — like real fetch.
    global.fetch = (_url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
    });
    try {
      await assert.rejects(
        () => postJSON('http://x', { body: {}, retries: 0, timeoutMs: 20, label: 'Test' }),
        /timed out after 20ms/,
      );
    } finally { global.fetch = origFetch; }
  });

  await test('caller abort is surfaced immediately and not retried', async () => {
    let calls = 0;
    const ac = new AbortController();
    global.fetch = (_url, opts) => new Promise((_, reject) => {
      calls++;
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
    });
    try {
      const p = postJSON('http://x', { body: {}, retries: 3, signal: ac.signal });
      ac.abort(new Error('shutdown'));
      await assert.rejects(() => p, /shutdown/);
      assert.strictEqual(calls, 1);
    } finally { global.fetch = origFetch; }
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

(async () => {
  await reduceSuite();
  await validateSuite();
  await executeSuite();
  await configSuite();
  await scratchpadSuite();
  await logSuite();
  await promptSuite();
  await tokenSuite();
  await loopSuite();
  await memorySuite();
  await providerTranslationSuite();
  await cacheSuite();
  await normalizeUrlSuite();
  await postJSONSuite();
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
