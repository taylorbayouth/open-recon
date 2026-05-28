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

function buildTaskMessage(task) {
  return { role: 'user', content: task };
}

function buildLLMViewMessage(llmView) {
  const header = `Page: ${llmView.viewport?.width || '?'}x${llmView.viewport?.height || '?'}`;
  return {
    role: 'user',
    content: `${header}\n\n${llmView.listing || '(no interactive elements)'}`,
  };
}

// Convert one Step into the pair of messages the LLM expects next turn:
//   - an assistant message replaying its own tool_use (so the API sees its
//     prior call), and
//   - a user message carrying the tool_result for that call.
//
// Anthropic (and tool-using OpenAI models) require these to be paired and
// reference each other by `tool_use_id`. The provider adapter passes them
// through unchanged.
//
// The fallback path (no `toolUseId`) is for synthetic Steps — e.g. a Step we
// constructed from a validator failure that never reached the LLM. It loses
// the tool-use envelope and becomes plain text. Providers that don't speak
// tool-use natively (Ollama, older OpenAI) use this same shape.
function stepToMessages(step) {
  const { action, observation } = step;
  if (!action.toolUseId) {
    return [
      { role: 'assistant', content: `(would have called) ${action.verb} ${JSON.stringify(action.args || {})}` },
      { role: 'user', content: `result: ${observation.status}${observation.error ? ' — ' + observation.error : ''}` },
    ];
  }
  const toolUseInput = { ...(action.args || {}) };
  if (action.ref) toolUseInput.ref = action.ref;
  const resultText = observation.status === 'ok'
    ? 'ok'
    : `error: ${observation.error || 'unknown'}`;
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: action.toolUseId, name: action.verb, input: toolUseInput }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: action.toolUseId, content: resultText }],
    },
  ];
}

// Format validation errors as a user message so the LLM can correct.
function validationErrorsToMessage(errors) {
  const lines = errors.map(({ action, error }) =>
    `- ${action.verb}${action.ref ? ' ' + action.ref : ''}: ${error}`
  );
  return { role: 'user', content: `Some of your last actions failed validation:\n${lines.join('\n')}\nTry again.` };
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
  const exec = createExecutor(cfg.executor || {});
  await exec.init();

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

  const messages = [buildTaskMessage(task)];
  let iter = 0;
  // Hash of the page the model last acted on. null forces an immediate prompt
  // (first turn, or after a no-op / validation error where waiting is pointless
  // because nothing executed to change the page).
  let lastHash = null;

  try {
    while (iter < loopCfg.maxSteps) {
      iter++;
      if (verbose) console.error(`[loop] turn ${iter}/${loopCfg.maxSteps}`);

      // 1. Extract — short-circuits while the page is unchanged (polls instead
      //    of re-prompting). See nextChangedBrief.
      const brief = await nextChangedBrief(session, lastHash, loopCfg, verbose);

      // 2. Reduce
      const llmView = reduce(brief, cfg.view);

      // 3. Plan
      const turnMessages = [...messages, buildLLMViewMessage(llmView)];
      const completion = await plan(
        { system, tools, messages: turnMessages, model },
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

      if (errors.length && validActions.length === 0) {
        // The LLM produced only invalid actions this turn (unknown verb, bad
        // ref, wrong arg types). We commit the page state we showed it plus
        // the error report to history, so the next turn the LLM sees both
        // what it was looking at and why its response was rejected. We do
        // NOT skip incrementing `iter` — this still counts toward max-steps.
        messages.push(...turnMessages.slice(messages.length));
        messages.push(validationErrorsToMessage(errors));
        // Nothing executed, so the page can't change. Clear lastHash so the
        // next turn re-prompts immediately instead of polling for a change
        // that will never come.
        lastHash = null;
        continue;
      }

      // 5. Execute
      const observations = await exec.execute(validActions, session, brief);

      // 6. Record Steps + accumulate history
      // Include LLMView in persistent history so subsequent turns see the prior page state.
      messages.push(buildLLMViewMessage(llmView));
      for (let i = 0; i < observations.length; i++) {
        const step = { kind: 'step', action: validActions[i], observation: observations[i] };
        runArtifact.steps.push(step);
        runArtifact.stats.stepCount++;
        messages.push(...stepToMessages(step));

        if (step.action.verb === 'done') {
          runArtifact.status = 'completed';
          runArtifact.result = step.action.args?.result ?? null;
          return finish(runArtifact);
        }
      }

      // 7. Surface any validation errors alongside successful execution
      if (errors.length) messages.push(validationErrorsToMessage(errors));

      // Remember the page the model just acted on. Next turn's extract is
      // compared against this: if the action changed nothing, we poll/wait;
      // if it changed the page, we proceed immediately.
      lastHash = brief.briefHash;
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
