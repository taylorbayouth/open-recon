'use strict';

const crypto = require('crypto');
const actions = require('./actions');
const { buildSystemPrompt } = require('./prompt');
const { reduce } = require('./reduce');
const { plan, toolsFromRegistry } = require('./plan');
const { validate } = require('./validate');
const { execute } = require('./execute');

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

const DEFAULT_MAX_STEPS = 30;

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

// Convert one Step into the assistant tool_use block + the matching user
// tool_result block. Provider adapters translate these into native shapes.
function stepToMessages(step) {
  const { action, observation } = step;
  if (!action.toolUseId) {
    // No tool_use id (e.g., validate rejected before LLM dispatched, or
    // history rebuild). Fall back to plain text representation.
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

async function run({ session, task, provider = 'anthropic', model, maxSteps = DEFAULT_MAX_STEPS, verbose = false } = {}) {
  if (!session) throw new Error('run() requires a session');
  if (!task) throw new Error('run() requires a task');

  const system = buildSystemPrompt(actions);
  const tools = toolsFromRegistry(actions);

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

  try {
    while (iter < maxSteps) {
      iter++;
      if (verbose) console.error(`[loop] turn ${iter}/${maxSteps}`);

      // 1. Extract
      const brief = await session.extract({ format: 'lean', inViewportOnly: true });

      // 2. Reduce
      const llmView = reduce(brief);

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
        // Nothing executable — feed errors back and try again
        messages.push(...turnMessages.slice(messages.length)); // include LLMView in history
        messages.push(validationErrorsToMessage(errors));
        continue;
      }

      // 5. Execute
      const observations = await execute(validActions, session, brief);

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
    }

    runArtifact.status = 'max-steps';
    return finish(runArtifact);
  } catch (err) {
    runArtifact.status = 'failed';
    runArtifact.error = err?.message || String(err);
    return finish(runArtifact);
  }
}

function finish(runArtifact) {
  runArtifact.endedAt = new Date().toISOString();
  runArtifact.stats.totalElapsedMs = Date.parse(runArtifact.endedAt) - Date.parse(runArtifact.startedAt);
  return runArtifact;
}

module.exports = { run };
