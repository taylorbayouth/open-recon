'use strict';

// Dispatch validated Action[] against a real browser via CDP.
//
// Slice 1 verbs: click, type, done.
//
// Every action returns an Observation. Settle runs after every dispatched
// action (except `done`, which terminates the loop).
//
// See DESIGN.md § Verb contracts and § Settle contract.

function bboxArrToObj(bbox) {
  if (!bbox) return null;
  if (Array.isArray(bbox)) return { x: bbox[0], y: bbox[1], width: bbox[2], height: bbox[3] };
  return bbox;
}

function elementByRef(brief, ref) {
  return brief.elements?.find(e => e.ref === ref) ?? null;
}

async function dispatchClick({ session, brief, ref }) {
  const el = elementByRef(brief, ref);
  if (!el) throw new Error(`element ${ref} not found in brief`);
  const bbox = bboxArrToObj(el.bbox);
  if (!bbox) throw new Error(`element ${ref} has no bbox`);
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  const client = session.client;
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: cx, y: cy });
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
}

async function dispatchType({ session, brief, ref, text }) {
  const el = elementByRef(brief, ref);
  if (!el) throw new Error(`element ${ref} not found in brief`);
  const backendNodeId = brief.lookup?.[ref];
  if (typeof backendNodeId !== 'number') throw new Error(`no backendNodeId for ${ref}`);
  const client = session.client;
  await client.DOM.enable();
  await client.DOM.getDocument();  // required before pushNodesByBackendIdsToFrontend will work
  const { nodeIds } = await client.DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds: [backendNodeId] });
  const nodeId = nodeIds?.[0];
  if (!nodeId) throw new Error(`could not resolve nodeId for ${ref}`);
  await client.DOM.focus({ nodeId });
  await client.Input.insertText({ text });
}

async function executeAction(action, session, brief) {
  const start = Date.now();
  const base = { kind: 'observation', verb: action.verb, ref: action.ref ?? null };

  try {
    if (action.verb === 'done') {
      // Terminal verb — no dispatch, no settle. Loop handles exit.
      return { ...base, status: 'ok', error: null, elapsedMs: Date.now() - start, settleMs: 0 };
    }

    if (action.verb === 'click') {
      await dispatchClick({ session, brief, ref: action.ref });
    } else if (action.verb === 'type') {
      await dispatchType({ session, brief, ref: action.ref, text: action.args.text });
    } else {
      throw new Error(`verb "${action.verb}" not implemented in slice 1`);
    }

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
  const observations = [];
  for (const action of actions) {
    const obs = await executeAction(action, session, brief);
    observations.push(obs);
    // If `done` fires, stop dispatching further actions in this batch — the
    // task is over. Loop is also expected to detect `done` and not re-prompt.
    if (action.verb === 'done') break;
  }
  return observations;
}

module.exports = { execute, executeAction };
