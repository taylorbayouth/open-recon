'use strict';

const crypto = require('crypto');
const actions = require('./actions');
const { buildSystemPrompt } = require('./prompt');
const { reduce, computeBriefHash } = require('./reduce');
const { plan, toolsFromRegistry } = require('./plan');
const { validate } = require('./validate');
const { createExecutor } = require('./execute');
const { deepMerge, DEFAULTS } = require('./config');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The orchestrator. The only stateful piece of the engine. Everything else
// is a pure function of its inputs.
//
// Loop body (DESIGN.md § Loop semantics):
//   1. extract snapshot
//   2. reduce → LLMView
//   3. build messages from history + LLMView
//   4. plan → Completion (LLM call)
//   5. validate completion.actions against snapshot.lookup
//   6. execute → Observations
//   7. record Steps; if `done`, exit; else repeat
//
// See DESIGN.md § Message conversion for the per-turn message shape.

// The agent's memory is NOT a transcript of every page it has seen — that grows
// quadratically (each turn would re-send every prior snapshot). Instead we keep
// a compact, deterministic event log of what *happened* ("typed … into …",
// "clicked …", "navigated to …") plus ONLY the current page. The log is derived
// from Steps the loop already has, so it costs no extra LLM call.

function quote(s) {
  return `"${String(s ?? '').replace(/"/g, '\\"')}"`;
}

// Resolve a ref to its human name from the brief it was acted on (elements or
// text), so the log reads `clicked "Sign in"` rather than `clicked @e4`.
function refName(brief, ref) {
  if (!ref) return null;
  const node = [...(brief.elements || []), ...(brief.text || [])].find(n => n.ref === ref);
  return node?.name || null;
}

// Render one action as a past-tense event line for the progress log.
function describeAction(action, brief) {
  const name = refName(brief, action.ref);
  const target = name ? quote(name) : (action.ref || '');
  switch (action.verb) {
    case 'click':  return `clicked ${target}`.trimEnd();
    case 'type':   return `typed ${quote(action.args?.text)} into ${target}`.trimEnd();
    case 'scroll': return `scrolled ${action.args?.direction || 'down'}`;
    case 'press':  return `pressed ${action.args?.key || ''}`.trimEnd();
    default:       return `${action.verb}${action.ref ? ' ' + action.ref : ''}`;
  }
}

// Build the single user message for one turn: the goal, the event log so far,
// and the current page listing. One combined user message — no replayed
// assistant tool_use blocks — keeps the request provider-agnostic and sidesteps
// the tool_use/tool_result pairing the transcript approach needed.
function buildTurnMessage(task, events, llmView) {
  const progress = events.length
    ? events.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
    : '  (nothing yet — this is your first action)';
  const dims = `${llmView.viewport?.width || '?'}x${llmView.viewport?.height || '?'}`;
  const listing = llmView.listing || '(no interactive elements)';
  return {
    role: 'user',
    content:
`Task: ${task}

What you've done so far:
${progress}

Current page (${dims}) — the [@e…] refs below are valid only for this snapshot:
${listing}

Choose the single best next action, or emit "done" when the task is complete.`,
  };
}

async function extractBrief(session) {
  const brief = await session.extract({ format: 'lean', inViewportOnly: true });
  brief.briefHash = brief.briefHash ?? computeBriefHash(brief);
  return brief;
}

// Get the next brief, short-circuiting redundant LLM work. While the page is
// byte-identical to what the model last acted on (`lastHash`), we poll every
// `pollMs` instead of re-prompting with input that would yield the same answer.
// Returns as soon as the page changes, or after `maxNoChangePolls` polls — a
// genuinely static page then falls through so the model can try something else
// or finish. `lastHash == null` (first turn, or after a no-op/validation error)
// always returns immediately.
async function nextChangedBrief(session, lastHash, loopCfg, verbose) {
  let brief = await extractBrief(session);
  if (!loopCfg.shortCircuitOnNoChange || lastHash == null) return brief;

  let polls = 0;
  while (brief.briefHash === lastHash) {
    if (polls >= loopCfg.maxNoChangePolls) {
      if (verbose) console.error(`[loop] page unchanged after ${polls} polls — proceeding`);
      return brief;
    }
    polls++;
    if (verbose) {
      console.error(`[loop] no change (hash ${brief.briefHash}); waiting ${loopCfg.pollMs}ms [${polls}/${loopCfg.maxNoChangePolls}]`);
    }
    await sleep(loopCfg.pollMs);
    brief = await extractBrief(session);
  }
  return brief;
}

// `config` is the merged knob set (see lib/config.js). Callers (agent.js) layer
// CLI flags on top before passing it in. Partial config is fine — it's merged
// over DEFAULTS here so library callers can pass just { provider } etc.
async function run({ session, task, config = {}, verbose = false } = {}) {
  if (!session) throw new Error('run() requires a session');
  if (!task) throw new Error('run() requires a task');

  const cfg = deepMerge(DEFAULTS, config);
  const provider = cfg.provider;                 // undefined never happens (DEFAULTS sets it)
  const model = cfg.model || undefined;          // null/empty → provider's own default
  const loopCfg = cfg.loop;

  const system = buildSystemPrompt(actions);
  const tools = toolsFromRegistry(actions);
  const exec = createExecutor(cfg.executor || {}, cfg.settle || {});

  const runArtifact = {
    kind: 'run',
    version: '1.0',
    id: crypto.randomUUID(),
    task,
    model: model || 'default',
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'running',
    result: null,
    steps: [],
    completions: [],
    stats: { stepCount: 0, totalElapsedMs: 0, totalInputTokens: 0, totalOutputTokens: 0 },
  };

  let iter = 0;
  // Hash of the page the model last acted on. null forces an immediate prompt
  // (first turn, or after a no-op / validation error where waiting is pointless
  // because nothing executed to change the page).
  let lastHash = null;
  // Compact "what happened" memory, rebuilt into each turn's prompt instead of
  // an ever-growing transcript of past snapshots (see buildTurnMessage).
  const events = [];
  let prevUrl = null;  // for detecting navigation between turns

  try {
    // Inside the try so a failed init (os backend: missing binary / denied
    // Accessibility) is reported as a failed Run and still hits the finally's
    // exec.close() instead of throwing out of run() and leaking the helper.
    await exec.init();

    while (iter < loopCfg.maxSteps) {
      iter++;
      if (verbose) console.error(`[loop] turn ${iter}/${loopCfg.maxSteps}`);

      // 1. Extract — short-circuits while the page is unchanged (polls instead
      //    of re-prompting). See nextChangedBrief.
      const brief = await nextChangedBrief(session, lastHash, loopCfg, verbose);

      // Log a navigation event when the URL changed since the last turn.
      if (prevUrl !== null && brief.url && brief.url !== prevUrl) {
        events.push(`page navigated to ${brief.url}`);
      }
      prevUrl = brief.url ?? prevUrl;

      // 2. Reduce
      const llmView = reduce(brief, cfg.view);

      // 3. Plan — the prompt is rebuilt fresh each turn from the event log plus
      //    only the current page (see buildTurnMessage), not a growing transcript.
      const completion = await plan(
        { system, tools, messages: [buildTurnMessage(task, events, llmView)], model },
        { provider }
      );
      runArtifact.completions.push(completion);
      runArtifact.stats.totalInputTokens += completion.usage?.inputTokens || 0;
      runArtifact.stats.totalOutputTokens += completion.usage?.outputTokens || 0;
      if (!runArtifact.model || runArtifact.model === 'default') runArtifact.model = completion.model;

      if (verbose) {
        console.error(`[loop] LLM returned ${completion.actions.length} action(s):`,
          completion.actions.map(a => `${a.verb}${a.ref ? ' ' + a.ref : ''}`).join(', '));
      }

      // 4. Validate
      const { ok: validActions, errors } = validate(completion.actions, brief.lookup || {}, actions);

      // 5. Execute the valid actions (none ⇒ nothing to dispatch this turn).
      const observations = validActions.length
        ? await exec.execute(validActions, session, brief)
        : [];

      // 6. Record Steps + append executed events.
      for (let i = 0; i < observations.length; i++) {
        const step = { kind: 'step', action: validActions[i], observation: observations[i] };
        runArtifact.steps.push(step);
        runArtifact.stats.stepCount++;

        if (step.action.verb === 'done') {
          runArtifact.status = 'completed';
          runArtifact.result = step.action.args?.result ?? null;
          return finish(runArtifact);
        }

        const failed = step.observation.status === 'error';
        events.push(`${describeAction(step.action, brief)}${failed ? ` — FAILED: ${step.observation.error}` : ''}`);
      }

      // Rejected actions become events too, so the next turn the model sees what
      // it tried and why it was refused (unknown verb, bad ref, wrong arg types).
      for (const { action, error } of errors) {
        events.push(`✗ ${describeAction(action, brief)} — rejected: ${error}`);
      }

      if (validActions.length === 0) {
        // Nothing executed, so the page can't change. Clear lastHash so the next
        // turn re-prompts immediately instead of polling for a change that will
        // never come. (Still counts toward max-steps — iter already incremented.)
        lastHash = null;
        continue;
      }

      // Remember the page the model just acted on. Next turn's extract is
      // compared against this: if the action changed nothing, we poll/wait; if
      // it changed the page, we proceed immediately. But if every action errored
      // (nothing executed, page unchanged) clear lastHash to re-prompt now.
      const anyExecuted = observations.some(o => o.status === 'ok');
      lastHash = anyExecuted ? brief.briefHash : null;
    }

    runArtifact.status = 'max-steps';
    return finish(runArtifact);
  } catch (err) {
    runArtifact.status = 'failed';
    runArtifact.error = err?.message || String(err);
    return finish(runArtifact);
  } finally {
    try { await exec.close(); } catch {}
  }
}

function finish(runArtifact) {
  runArtifact.endedAt = new Date().toISOString();
  runArtifact.stats.totalElapsedMs = Date.parse(runArtifact.endedAt) - Date.parse(runArtifact.startedAt);
  return runArtifact;
}

module.exports = { run };
