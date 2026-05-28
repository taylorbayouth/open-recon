'use strict';

const crypto = require('crypto');
const actions = require('./actions');
const { buildSystemPrompt } = require('./prompt');
const { reduce, computeBriefHash } = require('./reduce');
const { plan, toolsFromRegistry } = require('./plan');
const { validate } = require('./validate');
const { createExecutor } = require('./execute');
const { deepMerge, DEFAULTS } = require('./config');
const { createLogger } = require('./log');
const { estimateTokens } = require('./tokens');

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
// Drop the URL fragment (#…) — it's often a long opaque app-router/tracking
// blob that adds noise without telling the model anything about the page.
function cleanUrl(url) {
  if (!url) return null;
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

// One-line summary of where the viewport sits in the document, so the model can
// decide whether scrolling will reveal anything (it scrolls blind otherwise).
function scrollSummary(vp) {
  if (!vp) return '';
  const dims = `${vp.width || '?'}x${vp.height || '?'}`;
  const { scrollY, height, contentHeight } = vp;
  if (!contentHeight || !height || contentHeight <= height + 1) {
    return `${dims}, whole page fits in view (nothing to scroll)`;
  }
  const maxScroll = contentHeight - height;
  const pct = Math.round(Math.min(1, Math.max(0, scrollY / maxScroll)) * 100);
  const where = scrollY <= 1 ? 'at top, more below'
    : scrollY >= maxScroll - 1 ? 'at bottom'
    : 'more above and below';
  return `${dims}, scrolled ${Math.round(scrollY)}/${Math.round(contentHeight)}px (${pct}%, ${where})`;
}

function buildTurnMessage(task, events, llmView) {
  const progress = events.length
    ? events.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
    : '  (nothing yet — this is your first action)';
  const listing = llmView.listing || '(no interactive elements)';
  const url = cleanUrl(llmView.url);
  const locator = [
    url ? `URL: ${url}` : null,
    llmView.title ? `Title: ${llmView.title}` : null,
    `Viewport: ${scrollSummary(llmView.viewport)}`,
  ].filter(Boolean).join('\n');
  return {
    role: 'user',
    content:
`Task: ${task}

What you've done so far:
${progress}

${locator}

Page elements — the [@e…] refs below are valid only for this snapshot:
${listing}

Choose the single best next action, or emit "done" when the task is complete.`,
  };
}

async function extractBrief(session) {
  // Re-pin to the frontmost tab first, so a new-tab navigation from the last
  // action is what we perceive (not the stale tab the click started on).
  if (session.followActiveTab) {
    try { await session.followActiveTab(); } catch {}
  }
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
// Returns { brief, changed }. `changed` is false only when we gave up waiting
// for a still-identical page (maxNoChangePolls) — i.e. the last action had no
// visible effect. The loop uses that to detect a model repeating a dead action.
async function nextChangedBrief(session, lastHash, loopCfg, verbose) {
  let brief = await extractBrief(session);
  if (!loopCfg.shortCircuitOnNoChange || lastHash == null) return { brief, changed: true };

  let polls = 0;
  while (brief.briefHash === lastHash) {
    if (polls >= loopCfg.maxNoChangePolls) {
      if (verbose) console.error(`[loop] page unchanged after ${polls} polls — proceeding`);
      return { brief, changed: false };
    }
    polls++;
    if (verbose) {
      console.error(`[loop] no change (hash ${brief.briefHash}); waiting ${loopCfg.pollMs}ms [${polls}/${loopCfg.maxNoChangePolls}]`);
    }
    await sleep(loopCfg.pollMs);
    brief = await extractBrief(session);
  }
  return { brief, changed: true };
}

// Stable identity for an action across snapshots, so we can tell when the model
// repeats the *same* target. Refs change every snapshot, so key on the target's
// accessible name (stable) — or its rounded center when unnamed (the dead
// generic elements that cause flailing have no name but a fixed position).
function actionKey(brief, action) {
  if (!action) return null;
  const args = JSON.stringify(action.args || {});
  if (!action.ref) return `${action.verb}|${args}`;
  const node = [...(brief.elements || []), ...(brief.text || [])].find(n => n.ref === action.ref);
  let id = `ref:${action.ref}`;
  if (node?.name) {
    id = `n:${node.name}`;
  } else if (node?.bbox) {
    const b = Array.isArray(node.bbox)
      ? { x: node.bbox[0], y: node.bbox[1], width: node.bbox[2], height: node.bbox[3] }
      : node.bbox;
    id = `xy:${Math.round(b.x + b.width / 2)},${Math.round(b.y + b.height / 2)}`;
  }
  return `${action.verb}|${id}|${args}`;
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
  const exec = createExecutor({ ...(cfg.executor || {}), verbose }, cfg.settle || {});

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
    stats: {
      stepCount: 0,
      totalElapsedMs: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedPromptTokens: 0,
    },
  };

  // Per-run log: streamed JSONL (survives Ctrl-C) + latest.json on finish.
  const logger = createLogger({ ...(cfg.log || {}), runId: runArtifact.id, startedAt: runArtifact.startedAt });
  if (verbose && logger.turnsPath) console.error(`[loop] logging to ${logger.turnsPath}`);
  logger.event({ kind: 'run-start', task, provider, model: model || 'default' });

  let iter = 0;
  // Hash of the page the model last acted on. null forces an immediate prompt
  // (first turn, or after a no-op / validation error where waiting is pointless
  // because nothing executed to change the page).
  let lastHash = null;
  // Compact "what happened" memory, rebuilt into each turn's prompt instead of
  // an ever-growing transcript of past snapshots (see buildTurnMessage).
  const events = [];
  let prevUrl = null;  // for detecting navigation between turns
  // No-op loop guard: the stable key of the action executed last turn, and how
  // many times in a row the model has re-picked it while the page stayed put.
  let lastActionKey = null;
  let stuckStreak = 0;
  let emptyPlanStreak = 0;

  try {
    // Inside the try so a failed init (os backend: missing binary / denied
    // Accessibility) is reported as a failed Run and still hits the finally's
    // exec.close() instead of throwing out of run() and leaking the helper.
    await exec.init();

    while (iter < loopCfg.maxSteps) {
      iter++;
      if (verbose) console.error(`[loop] turn ${iter}/${loopCfg.maxSteps}`);
      if (exec.backend.waitUntilReady) await exec.backend.waitUntilReady();

      // 1. Extract — short-circuits while the page is unchanged (polls instead
      //    of re-prompting). See nextChangedBrief.
      const { brief, changed } = await nextChangedBrief(session, lastHash, loopCfg, verbose);

      // If the last action left the page unchanged, tell the model so — annotate
      // its most recent event line. This gives it a chance to pick something
      // else before the stuck-guard below aborts the run.
      if (!changed && lastActionKey && events.length && !events[events.length - 1].endsWith('(no page change)')) {
        events[events.length - 1] += ' (no page change)';
      }

      // Log a navigation event when the URL changed since the last turn.
      if (prevUrl !== null && brief.url && brief.url !== prevUrl) {
        events.push(`page navigated to ${brief.url}`);
      }
      prevUrl = brief.url ?? prevUrl;

      // 2. Reduce
      const llmView = reduce(brief, cfg.view);

      // Set RECON_DEBUG_VIEW=1 to dump the exact condensed listing sent to the
      // LLM — the ground truth for "did the model even see the right element?".
      if (process.env.RECON_DEBUG_VIEW) {
        console.error(`[view] turn ${iter} — ${llmView.listing.split('\n').length} lines:\n${llmView.listing}`);
      }

      // 3. Plan — the prompt is rebuilt fresh each turn from the event log plus
      //    only the current page (see buildTurnMessage), not a growing transcript.
      const turnMessage = buildTurnMessage(task, events, llmView);
      const estimatedPromptTokens = estimateTokens(turnMessage);
      const completion = await plan(
        { system, tools, messages: [turnMessage], model },
        { provider }
      );
      const plannedActions = Array.isArray(completion.actions) ? completion.actions : [];
      runArtifact.completions.push(completion);
      runArtifact.stats.totalEstimatedPromptTokens += estimatedPromptTokens;
      runArtifact.stats.totalInputTokens += completion.usage?.inputTokens || 0;
      runArtifact.stats.totalOutputTokens += completion.usage?.outputTokens || 0;
      if (!runArtifact.model || runArtifact.model === 'default') runArtifact.model = completion.model;

      if (verbose) {
        console.error(`[loop] LLM planned ${plannedActions.length} action(s): ` +
          plannedActions.map(a => describeAction(a, brief)).join('; '));
      }

      // No-op loop guard. If the page didn't change after our last action and the
      // model is asking to repeat that same action, it's flailing on a dead
      // target. Count consecutive repeats; once we cross the threshold, stop the
      // run cleanly instead of grinding to max-steps (each stuck turn costs a full
      // no-change wait). `done` is never a stuck target.
      const primary = plannedActions.find(a => a.verb !== 'done') || null;
      const primaryKey = actionKey(brief, primary);
      if (!changed && lastActionKey && primaryKey && primaryKey === lastActionKey) {
        stuckStreak++;
      } else {
        stuckStreak = 0;
      }
      if (stuckStreak >= loopCfg.maxStuckRepeats) {
        const desc = describeAction(primary, brief);
        if (verbose) console.error(`[loop] stuck — "${desc}" repeated with no page change; aborting`);
        logger.event({ kind: 'stuck', turn: iter, action: primary, repeats: stuckStreak });
        runArtifact.status = 'stuck';
        runArtifact.result = `Stopped: repeatedly chose the same action with no effect on the page (${desc}). The target is likely unresponsive or the wrong element.`;
        return finish(runArtifact, verbose);
      }

      // 4. Validate
      const { ok: validActions, errors } = validate(completion.actions, brief.lookup || {}, actions);

      // 5. Execute the valid actions (none ⇒ nothing to dispatch this turn).
      const observations = validActions.length
        ? await exec.execute(validActions, session, brief)
        : [];

      // Log the full turn now (before the done-path can return early): the page
      // the model saw, what it planned, what was rejected, and the outcomes.
      logger.event({
        kind: 'turn',
        turn: iter,
        url: brief.url,
        title: brief.title,
        llmPayload: {
          messages: [turnMessage],
          estimatedTokens: estimatedPromptTokens,
        },
        listing: llmView.listing,
        planned: completion.actions,
        rejected: errors.map(e => ({ action: e.action, error: e.error })),
        observations,
        usage: completion.usage || null,
      });

      emptyPlanStreak = plannedActions.length === 0 ? emptyPlanStreak + 1 : 0;
      if (emptyPlanStreak >= loopCfg.maxEmptyPlans) {
        if (verbose) console.error(`[loop] empty plan repeated ${emptyPlanStreak} turns; aborting`);
        logger.event({ kind: 'empty-plan', turn: iter, repeats: emptyPlanStreak });
        runArtifact.status = 'empty-plan';
        runArtifact.result = `Stopped: the model returned no actions for ${emptyPlanStreak} consecutive turns.`;
        return finish(runArtifact, verbose);
      }

      // 6. Record Steps + append executed events.
      for (let i = 0; i < observations.length; i++) {
        const step = { kind: 'step', action: validActions[i], observation: observations[i] };
        runArtifact.steps.push(step);
        runArtifact.stats.stepCount++;

        if (step.action.verb === 'done') {
          runArtifact.status = 'completed';
          runArtifact.result = step.action.args?.result ?? null;
          if (verbose) console.error(`[loop] done — ${describeAction(step.action, brief)}`);
          return finish(runArtifact, verbose);
        }

        const failed = step.observation.status === 'error';
        const line = describeAction(step.action, brief);
        let note = '';
        if (failed) {
          note = ` — FAILED: ${step.observation.error}`;
        } else if (step.observation.detail?.selectedText != null) {
          // Report what selectText actually highlighted so the model can read it
          // and finish, instead of re-selecting blind.
          const sel = step.observation.detail.selectedText;
          note = sel
            ? ` — selected: "${sel.length > 200 ? sel.slice(0, 199) + '…' : sel}"`
            : ' — selected nothing (empty selection)';
        }
        events.push(`${line}${note}`);
        if (verbose) {
          console.error(failed
            ? `[loop]   ✗ ${line} → ERROR: ${step.observation.error}`
            : `[loop]   ✓ ${line} → ok`);
        }
      }

      // Rejected actions become events too, so the next turn the model sees what
      // it tried and why it was refused (unknown verb, bad ref, wrong arg types).
      for (const { action, error } of errors) {
        events.push(`✗ ${describeAction(action, brief)} — rejected: ${error}`);
        if (verbose) console.error(`[loop]   ✗ ${describeAction(action, brief)} → rejected: ${error}`);
      }

      if (validActions.length === 0) {
        // Nothing executed, so the page can't change. Clear lastHash so the next
        // turn re-prompts immediately instead of polling for a change that will
        // never come. (Still counts toward max-steps — iter already incremented.)
        lastHash = null;
        lastActionKey = null;
        continue;
      }

      // Remember the page the model just acted on. Next turn's extract is
      // compared against this: if the action changed nothing, we poll/wait; if
      // it changed the page, we proceed immediately. But if every action errored
      // (nothing executed, page unchanged) clear lastHash to re-prompt now.
      const anyExecuted = observations.some(o => o.status === 'ok');
      const primaryExecuted = anyExecuted ? validActions.find(a => a.verb !== 'done') : null;
      // Actions flagged changesPage:false (e.g. selectText) never alter the
      // hashed view, so waiting for a change is pointless — clear lastHash to
      // re-prompt immediately instead of polling maxNoChangePolls for nothing.
      const changesPage = primaryExecuted ? actions[primaryExecuted.verb]?.changesPage !== false : false;
      lastHash = (anyExecuted && changesPage) ? brief.briefHash : null;
      // Track the executed action for the no-op guard (first non-done action).
      lastActionKey = primaryExecuted ? actionKey(brief, primaryExecuted) : null;
    }

    runArtifact.status = 'max-steps';
    return finish(runArtifact, verbose);
  } catch (err) {
    runArtifact.status = 'failed';
    runArtifact.error = err?.message || String(err);
    return finish(runArtifact, verbose);
  } finally {
    try { logger.finalize(runArtifact); } catch {}
    try { await exec.close(); } catch {}
  }
}

function finish(runArtifact, verbose = false) {
  runArtifact.endedAt = new Date().toISOString();
  runArtifact.stats.totalElapsedMs = Date.parse(runArtifact.endedAt) - Date.parse(runArtifact.startedAt);
  if (verbose) {
    const s = runArtifact.stats;
    console.error(`[loop] finished with status ${runArtifact.status}; steps=${s.stepCount}; estimated prompt tokens=${s.totalEstimatedPromptTokens}; provider input/output tokens=${s.totalInputTokens}/${s.totalOutputTokens}`);
  }
  return runArtifact;
}

module.exports = { run };
