'use strict';

// Config-driven executor dispatcher. Selects a backend (cdp | os) and routes
// each Action to its verb handler. The backend owns dispatch mechanics;
// `executeAction` here owns the Observation envelope, settle, and errors.
//
// Usage:
//   const exec = createExecutor({ backend: 'os', humanize: { ... } });
//   await exec.init();                         // boots the Swift helper, etc.
//   const obs = await exec.execute(actions, session, brief);
//   await exec.close();
//
// See DESIGN.md § Verb contracts and § Settle contract.

const cdp = require('./executors/cdp');
const osExec = require('./executors/os');

function buildBackend(opts) {
  const backend = opts.backend || (process.env.OPEN_RECON_EXECUTOR) || 'cdp';
  if (backend === 'os')  return osExec.create(opts);
  if (backend === 'cdp') return cdp;
  throw new Error(`unknown executor backend: ${backend}`);
}

function createExecutor(opts = {}) {
  const backend = buildBackend(opts);
  let inited = false;

  async function init() {
    if (inited) return;
    await backend.init();
    inited = true;
  }

  async function close() {
    if (!inited) return;
    await backend.close();
    inited = false;
  }

  async function executeAction(action, session, brief) {
    const start = Date.now();
    const base = { kind: 'observation', verb: action.verb, ref: action.ref ?? null };

    try {
      if (action.verb === 'done') {
        // `done` never reaches a backend — it's a Loop-level signal. We
        // construct an ok Observation so it shows up in `steps` for the
        // history, but skip dispatch and skip settle.
        return { ...base, status: 'ok', error: null, elapsedMs: Date.now() - start, settleMs: 0 };
      }

      const handler = backend[action.verb];
      if (!handler) throw new Error(`verb "${action.verb}" not implemented by backend "${backend.name}"`);

      // Spread `args` so handlers can destructure named params (e.g. `text`)
      // alongside the standard `{ session, brief, ref }` envelope.
      const args = action.args || {};
      await handler({ session, brief, ref: action.ref, ...args });

      // Settle is universal infrastructure (see DESIGN.md § Settle contract).
      // Even fast-completing actions wait for the page to stop mutating, so
      // the next snapshot the LLM sees is consistent.
      const settleMs = await session.settle();
      return { ...base, status: 'ok', error: null, elapsedMs: Date.now() - start, settleMs };
    } catch (err) {
      return {
        ...base,
        status: 'error',
        error: err?.message || String(err),
        elapsedMs: Date.now() - start,
        settleMs: 0,
      };
    }
  }

  async function execute(actions, session, brief) {
    if (!inited) await init();
    const observations = [];
    for (const action of actions) {
      const obs = await executeAction(action, session, brief);
      observations.push(obs);
      if (action.verb === 'done') break;
    }
    return observations;
  }

  return { init, close, execute, executeAction, backend };
}

module.exports = { createExecutor };
