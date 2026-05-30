'use strict';

const crypto = require('crypto');
const actions = require('./actions');
const { buildSystemPrompt } = require('./prompt');
const { reduce, computeBriefHash } = require('./reduce');
const { plan, toolsFromRegistry } = require('./plan');
const { validate } = require('./validate');
const { createExecutor } = require('./execute');
const { waitUntilLoaded } = require('./executors/page');
const { deepMerge, DEFAULTS } = require('./config');
const { createLogger } = require('./log');
const { createScratchpad } = require('./scratchpad');
const { estimateTokens } = require('./tokens');
const { cleanUrl } = require('./url');

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

function hasText(s) {
  return String(s ?? '').trim().length > 0;
}

function compactWords(s, maxWords = 15) {
  const words = String(s ?? '').trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (!words.length) return '';
  return words.length > maxWords ? `${words.slice(0, maxWords).join(' ')}...` : words.join(' ');
}

function actionArgsForIdentity(action) {
  const args = { ...(action?.args || {}) };
  delete args.intent; // metadata must not weaken no-op/repeated-action guards
  return args;
}

function briefNodeCount(brief) {
  return (brief.elements?.length || 0) + (brief.text?.length || 0) + (brief.regions?.length || 0);
}

function isSparseBrief(brief, loopCfg) {
  return briefNodeCount(brief) < (loopCfg.sparsePageMinNodes ?? 2);
}

async function retrySparseNavigationBrief(session, brief, prevUrl, loopCfg) {
  const maxRetries = Math.max(0, loopCfg.maxSparsePageRetries ?? 0);
  const retryMs = Math.max(0, loopCfg.sparsePageRetryMs ?? 0);
  const prev = cleanUrl(prevUrl, { max: 0 });
  const cur = cleanUrl(brief.url, { max: 0 });
  if (!maxRetries || !prev || !cur || prev === cur || !isSparseBrief(brief, loopCfg)) return brief;

  let current = brief;
  for (let i = 0; i < maxRetries && isSparseBrief(current, loopCfg); i++) {
    await sleep(retryMs);
    current = await extractBrief(session, false);
  }
  return current;
}

function normalizeScrollIntent(action) {
  return compactWords(action.args?.intent, 15) || '(missing intent)';
}

function scrollIntentWarning(step, state, loopCfg) {
  const threshold = loopCfg.maxSameIntentScrolls ?? 0;
  if (!threshold || step.action.verb !== 'scroll') {
    state.key = null;
    state.count = 0;
    state.warned = false;
    return null;
  }

  const intent = normalizeScrollIntent(step.action);
  const key = `${cleanUrl(step.url, { max: 0 }) || ''}|${intent.toLowerCase()}`;
  if (state.key === key) {
    state.count++;
  } else {
    state.key = key;
    state.count = 1;
    state.warned = false;
  }

  if (state.count >= threshold && !state.warned) {
    state.warned = true;
    return `WARNING: scroll intent repeated ${state.count}x on this page (${quote(intent)}); pivot, save findings, go back, or finish.`;
  }
  return null;
}

// Resolve a ref to its human name from the brief it was acted on (elements or
// text), so the log reads `clicked "Sign in"` rather than `clicked @e4`.
function refName(brief, ref) {
  if (!ref) return null;
  const node = [...(brief.elements || []), ...(brief.text || []), ...(brief.regions || [])].find(n => n.ref === ref);
  return node?.name || null;
}

// Render one action as a past-tense event line for the progress log.
function describeAction(action, brief) {
  const name = refName(brief, action.ref);
  const target = name ? quote(name) : (action.ref || '');
  let line;
  switch (action.verb) {
    case 'click':  line = hasText(target) ? `clicked ${target}` : 'clicked'; break;
    case 'type': {
      const text = action.args?.text != null ? quote(action.args.text) : '';
      if (hasText(text) && hasText(target)) line = `typed ${text} into ${target}`;
      else if (hasText(text)) line = `typed ${text}`;
      else if (hasText(target)) line = `typed into ${target}`;
      else line = 'typed';
      break;
    }
    case 'scroll': line = `scrolled ${action.args?.direction || 'down'}`; break;
    case 'press':  line = hasText(action.args?.key) ? `pressed ${action.args.key}` : 'pressed'; break;
    case 'wait':   line = action.args?.ms != null ? `waited ${action.args.ms}ms` : 'waited'; break;
    case 'take_screenshot': line = action.args?.hint ? `looked at the page (${action.args.hint})` : 'looked at the page'; break;
    case 'save_text': line = 'saved text'; break;
    case 'save_file': line = 'saved file'; break;
    case 'get_images': line = 'listed page images'; break;
    case 'get_files': line = 'listed page files'; break;
    default:       line = `${action.verb}${action.ref ? ' ' + action.ref : ''}`;
  }
  const intent = compactWords(action.args?.intent, 15);
  return intent ? `${line} — intent: ${intent}` : line;
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

// Horizontal rule that brackets the history block, so the model can clearly tell
// "what I've already done" apart from the current page it must act on.
const RULE = '────────────────────────────────────────────────────';

// `revisits` is how many times the model has already been on the current page
// before this turn (see run()); >0 triggers a prominent warning so it stops
// looping back to pages whose content is already in the history.
function buildTurnMessage(task, events, llmView, revisits = 0) {
  const progress = events.length
    ? events.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
    : '  (nothing yet — this is your first action)';
  const listing = llmView.listing || '(no interactive elements)';
  const url = cleanUrl(llmView.url);
  const revisitNote = revisits >= 1
    ? `   ⚠ REVISIT — you've already been here ${revisits}×; its content is in the History above. Don't re-inspect it: use what you have, or go somewhere new.`
    : '';
  const page = [
    url ? `URL: ${url}${revisitNote}` : null,
    llmView.title ? `Title: ${llmView.title}` : null,
    `Viewport: ${scrollSummary(llmView.viewport)}`,
  ].filter(Boolean).join('\n');
  return {
    role: 'user',
    content:
`Task: ${task}

${RULE}
History — what you've already done (oldest first):
${progress}
${RULE}

Current page
${page}

Elements ([@e…] refs are valid only for this snapshot):
${listing}

Choose the single best next action.`,
  };
}

async function extractBrief(session, allowFreshTab = true) {
  // Re-pin to the frontmost tab first, so a new-tab navigation from the last
  // action is what we perceive (not the stale tab the click started on).
  // allowFreshTab gates following a brand-new no-opener tab (see chooseTab): true
  // right after we act, false while idle-polling so a user-opened tab can't hijack.
  if (session.followActiveTab) {
    let switched = false;
    try { switched = await session.followActiveTab(allowFreshTab); } catch {}
    // A switch lands us on a tab that may still be loading (a click that opened
    // a new tab, an OAuth popup). The turn-1 and navigate gates don't cover a
    // mid-loop switch, so without this the brief is extracted with a blank/stale
    // url+title. Bounded by NAV_LOAD_TIMEOUT_MS and best-effort — never blocks.
    if (switched) {
      try { await waitUntilLoaded(session.client); } catch {}
    }
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
async function nextChangedBrief(session, lastHash, loopCfg) {
  // First extract of the turn follows the action we just executed, so allow
  // following a brand-new tab that action may have opened (target=_blank).
  let brief = await extractBrief(session, true);
  if (!loopCfg.shortCircuitOnNoChange || lastHash == null) return { brief, changed: true };

  let polls = 0;
  while (brief.briefHash === lastHash) {
    if (polls >= loopCfg.maxNoChangePolls) {
      return { brief, changed: false };
    }
    polls++;
    await sleep(loopCfg.pollMs);
    // Idle poll: do NOT follow a brand-new tab here — a tab the user opens in the
    // background mid-wait would otherwise steal the session (popups/OAuth still
    // follow via the always-on opener path).
    brief = await extractBrief(session, false);
  }
  return { brief, changed: true };
}

// Stable identity for a target across snapshots. Refs can change every snapshot,
// so key on the accessible name or rounded center when possible.
function targetKey(brief, ref) {
  if (!ref) return null;
  const node = [...(brief.elements || []), ...(brief.text || []), ...(brief.regions || [])].find(n => n.ref === ref);
  let id = `ref:${ref}`;
  if (node?.name) {
    id = `n:${node.name}`;
  } else if (node?.bbox) {
    const b = Array.isArray(node.bbox)
      ? { x: node.bbox[0], y: node.bbox[1], width: node.bbox[2], height: node.bbox[3] }
      : node.bbox;
    id = `xy:${Math.round(b.x + b.width / 2)},${Math.round(b.y + b.height / 2)}`;
  }
  return id;
}

// Stable identity for an action across snapshots, so we can tell when the model
// repeats the *same* target.
function actionKey(brief, action) {
  if (!action) return null;
  const args = JSON.stringify(actionArgsForIdentity(action));
  const id = action.ref ? targetKey(brief, action.ref) : null;
  return action.ref ? `${action.verb}|${id}|${args}` : `${action.verb}|${args}`;
}

function idempotentReadKey(brief, action) {
  if (!action || actions[action.verb]?.idempotentRead !== true) return null;
  if (action.verb === 'take_screenshot') {
    return action.ref ? `${action.verb}|${targetKey(brief, action.ref)}` : `${action.verb}|viewport`;
  }
  return action.verb;
}

// "Turn 3/25 | 2,623 in · 145 out | 63% cached"
function fmtTurn(iter, maxSteps, usage) {
  const parts = [`Turn ${iter}/${maxSteps}`];
  if (usage) {
    const fmt = (n) => (n || 0).toLocaleString();
    parts.push(`${fmt(usage.inputTokens)} in · ${fmt(usage.outputTokens)} out`);
    const pct = (usage.cacheReadTokens && usage.inputTokens)
      ? Math.round(usage.cacheReadTokens / usage.inputTokens * 100)
      : 0;
    parts.push(`${pct}% cached`);
  }
  return parts.join(' | ');
}

// Short, clean terminal label for a step — separate from the full event string
// that goes to the model. Only shows what an operator needs at a glance.
function termDesc(action, brief, observation) {
  const name = refName(brief, action.ref);
  const named = (prefix) => name ? `${prefix} "${name}"` : prefix;
  switch (action.verb) {
    case 'navigate':        return `↳ ${action.args?.url || ''}`;
    case 'click':           return named('Clicked');
    case 'type':            return named('Typed into');
    case 'scroll':          return `Scrolled ${action.args?.direction || 'down'}`;
    case 'press':           return hasText(action.args?.key) ? `Pressed ${action.args.key}` : 'Pressed';
    case 'wait':            return action.args?.ms != null ? `⏱ Waited ${action.args.ms}ms` : '⏱ Waited';
    case 'take_screenshot': return observation?.detail?.cropped ? 'Screenshot (cropped)' : 'Screenshot';
    case 'save_text':       return 'Saved text';
    case 'save_file': {
      const p = observation?.detail?.savedPath;
      return p ? `Saved file → ${p.split('/').pop()}` : 'Saved file';
    }
    case 'get_images':      return 'Got images';
    case 'get_files':       return 'Got files';
    case 'select_text':     return named('Selected');
    case 'done':            return `Done${action.args?.result ? ` — ${action.args.result}` : ''}`;
    default:                return action.verb;
  }
}

// `config` is the merged knob set (see lib/config.js). Callers (agent.js) layer
// CLI flags on top before passing it in. Partial config is fine — it's merged
// over DEFAULTS here so library callers can pass just { provider } etc.
async function run({ session, task, config = {} } = {}) {
  if (!session) throw new Error('run() requires a session');
  if (!task) throw new Error('run() requires a task');

  // Single output channel keeps terminal progress formatting consistent.
  const emit = (msg) => console.error(msg);

  const cfg = deepMerge(DEFAULTS, config);
  const provider = cfg.provider;                 // undefined never happens (DEFAULTS sets it)
  const model = cfg.model || undefined;          // null/empty → provider's own default
  const loopCfg = cfg.loop;

  const system = buildSystemPrompt(actions, cfg.context);
  const tools = toolsFromRegistry(actions);
  const exec = createExecutor({ ...(cfg.executor || {}) }, cfg.settle || {});

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
  const logger = createLogger(cfg.log || {});
  if (logger.turnsPath) emit(`logging → ${logger.turnsPath}`);
  logger.event({ kind: 'run-start', task, provider, model: model || 'default' });

  // Per-run scratchpad: the model saves targeted text into runs/<id>/saved.md.
  // Bulk content stays on disk; the loop only logs a short "Saving to scratch
  // pad" note. Folded into runArtifact.report on finish.
  const scratchpad = createScratchpad({ ...(cfg.scratchpad || {}), runId: runArtifact.id });

  let iter = 0;
  // Hash of the page the model last acted on. null forces an immediate prompt
  // (first turn, or after a no-op / validation error where waiting is pointless
  // because nothing executed to change the page).
  let lastHash = null;
  // Compact "what happened" memory, rebuilt into each turn's prompt instead of
  // an ever-growing transcript of past snapshots (see buildTurnMessage).
  const events = [];
  let prevUrl = null;  // for detecting navigation between turns
  // (Re-)arrivals per fragment-stripped URL — navigating IN counts, staying on a
  // page to scroll/read does not. Drives the revisit warning in the turn message
  // that stops the agent looping back to pages it has already inspected.
  const visitCounts = new Map();
  // No-op loop guard: the stable key of the action executed last turn, and how
  // many times in a row the model has re-picked it while the page stayed put.
  let lastActionKey = null;
  // Read-key + page hash of the last executed action, so we can also catch a
  // changesPage:false read being repeated on an unchanged page.
  let lastReadKey = null;
  let lastActionBriefHash = null;
  let stuckStreak = 0;
  // Companion to the no-op guard for actions that ERROR rather than no-op (e.g. a
  // click whose target is covered by a sticky overlay). An errored action nulls
  // lastHash + lastActionKey below — which forces `changed` true and wipes
  // `sameAction` next turn — so the no-op guard can never count a *repeated
  // erroring* action. lastErroredKey is the stable key of the primary action that
  // errored last turn; re-planning it folds into stuckStreak and the same abort.
  let lastErroredKey = null;
  let emptyPlanStreak = 0;
  const scrollIntentState = { key: null, count: 0, warned: false };

  try {
    // Inside the try so a failed init (os backend: missing binary / denied
    // Accessibility) is reported as a failed Run and still hits the finally's
    // exec.close() instead of throwing out of run() and leaking the helper.
    await exec.init();

    // Turn-1 readiness: the tab we connect to may still be loading, and the
    // change-poll short-circuits on the first turn (lastHash == null), so without
    // this the very first snapshot could capture a half-loaded page. The navigate
    // gate covers later full loads; this covers the initial cold connect.
    // Best-effort — a readiness failure must never block the run.
    try {
      const reason = await waitUntilLoaded(session.client);
      emit(`\ninit · page ready (${reason})`);
    } catch (err) {
      emit(`\ninit · readiness check skipped: ${err?.message || err}`);
    }

    while (iter < loopCfg.maxSteps) {
      iter++;
      if (exec.backend.waitUntilReady) await exec.backend.waitUntilReady();

      // 1. Extract — short-circuits while the page is unchanged (polls instead
      //    of re-prompting). See nextChangedBrief.
      let { brief, changed } = await nextChangedBrief(session, lastHash, loopCfg);
      brief = await retrySparseNavigationBrief(session, brief, prevUrl, loopCfg);

      // If the last action left the page unchanged, tell the model so — annotate
      // its most recent event line. This gives it a chance to pick something
      // else before the stuck-guard below aborts the run.
      if (!changed && lastActionKey && events.length && !events[events.length - 1].endsWith('(no page change)')) {
        events[events.length - 1] += ' (no page change)';
      }

      // Log a navigation event when the URL changed since the last turn.
      if (prevUrl !== null && brief.url && brief.url !== prevUrl) {
        events.push(`page navigated to ${cleanUrl(brief.url)}`);
        emit(`  ↳ ${brief.url}`);
      }
      // Count genuine (re-)arrivals per page for the revisit warning. An arrival
      // is the URL changing since last turn (incl. the first turn's initial page);
      // fragment-stripped so #anchors don't read as new pages, and staying put to
      // scroll/read doesn't count.
      const curUrl = cleanUrl(brief.url, { max: 0 });
      if (curUrl && curUrl !== cleanUrl(prevUrl, { max: 0 })) {
        visitCounts.set(curUrl, (visitCounts.get(curUrl) || 0) + 1);
      }
      prevUrl = brief.url ?? prevUrl;
      const revisits = curUrl ? (visitCounts.get(curUrl) || 0) - 1 : 0;

      // 2. Reduce
      const llmView = reduce(brief, cfg.view);

      // Set RECON_DEBUG_VIEW=1 to dump the exact condensed listing sent to the
      // LLM — the ground truth for "did the model even see the right element?".
      if (process.env.RECON_DEBUG_VIEW) {
        console.error(`[view] turn ${iter} — ${llmView.listing.split('\n').length} lines:\n${llmView.listing}`);
      }

      // 3. Plan — the prompt is rebuilt fresh each turn from the event log plus
      //    only the current page (see buildTurnMessage), not a growing transcript.
      const turnMessage = buildTurnMessage(task, events, llmView, revisits);
      const estimatedPromptTokens = estimateTokens(turnMessage);
      const completion = await plan(
        // cacheKey groups this run's turns for OpenAI prompt caching. Stable for
        // the whole run, so every turn routes to the same warmed prefix. Other
        // providers ignore it — Anthropic caches via explicit breakpoints, and
        // Ollama via automatic local KV-cache prefix reuse (no key parameter);
        // both already benefit from the stable static-first prompt prefix.
        { system, tools, messages: [turnMessage], model, cacheKey: runArtifact.id, reasoningEffort: cfg.reasoningEffort },
        { provider }
      );
      const plannedActions = Array.isArray(completion.actions) ? completion.actions : [];
      // Prose the model returned instead of an action (a refusal, or it "thought
      // out loud" without calling a tool). Without this, an action-less turn is a
      // silent blank — surfacing it turns the empty-plan abort from a mystery into
      // the model's own stated reason, and lets it see that note next turn.
      const modelText = (completion.refusal || completion.text || '').trim();
      runArtifact.completions.push(completion);
      runArtifact.stats.totalEstimatedPromptTokens += estimatedPromptTokens;
      runArtifact.stats.totalInputTokens += completion.usage?.inputTokens || 0;
      runArtifact.stats.totalOutputTokens += completion.usage?.outputTokens || 0;
      if (!runArtifact.model || runArtifact.model === 'default') runArtifact.model = completion.model;

      emit(`\n${fmtTurn(iter, loopCfg.maxSteps, completion.usage)}`);
      if (plannedActions.length) {
        emit(`  → ${plannedActions.map(a => termDesc(a, brief)).join('; ')}`);
      } else if (modelText) {
        emit(`  (no action) model said: "${modelText.length > 200 ? modelText.slice(0, 199) + '…' : modelText}"`);
      }

      // No-op loop guard. If the page didn't change after our last action and the
      // model is asking to repeat that same action, it's flailing on a dead
      // target. Count consecutive repeats; once we cross the threshold, stop the
      // run cleanly instead of grinding to max-steps (each stuck turn costs a full
      // no-change wait). `done` is never a stuck target.
      const primary = plannedActions.find(a => a.verb !== 'done') || null;
      const primaryKey = actionKey(brief, primary);
      // Two stuck shapes:
      //  - the exact same action again after the page didn't change (the original
      //    case — a dead click/press that the change-poll confirms had no effect).
      //  - an `idempotentRead` repeated on a page that hashes identical to the
      //    one it last ran on. Screenshots are keyed by crop target; image/file
      //    listings remain verb-level reads. These null lastHash (so `changed`
      //    is always true and the first test can't catch them).
      const sameAction = !changed && lastActionKey && primaryKey && primaryKey === lastActionKey;
      const primaryReadKey = idempotentReadKey(brief, primary);
      const repeatedRead = primaryReadKey && primaryReadKey === lastReadKey
        && lastActionBriefHash != null && brief.briefHash === lastActionBriefHash;
      // Third stuck shape: re-planning the exact action that ERRORED last turn (a
      // covered click, etc.). Independent of `changed` — an errored action leaves
      // the page untouched yet nulls lastHash, so `changed` is misleadingly true.
      const sameErroredTarget = lastErroredKey && primaryKey && primaryKey === lastErroredKey;
      if (sameAction || repeatedRead || sameErroredTarget) {
        stuckStreak++;
      } else {
        stuckStreak = 0;
      }
      if (stuckStreak >= loopCfg.maxStuckRepeats) {
        const desc = describeAction(primary, brief);
        emit(`\nstuck — "${desc}" repeated ${stuckStreak}×; aborting`);
        logger.event({ kind: 'stuck', turn: iter, action: primary, repeats: stuckStreak });
        runArtifact.status = 'stuck';
        runArtifact.result = `Stopped: repeatedly chose the same action with no effect on the page (${desc}). The target is likely unresponsive or the wrong element.`;
        return finish(runArtifact, { events, scratchpad });
      }

      // 4. Validate
      const { ok: validActions, errors } = validate(completion.actions, brief.lookup || {}, actions);

      // 5. Execute the valid actions (none ⇒ nothing to dispatch this turn).
      const observations = validActions.length
        ? await exec.execute(validActions, session, brief)
        : [];

      // Persist captured images to the run dir before logging: keeps the base64
      // out of the JSONL and gives the model a saved path to reference in `done`
      // (so a "take a screenshot" task produces a real artifact, not just prose).
      for (let i = 0; i < observations.length; i++) {
        const obs = observations[i];
        const action = validActions[i] || {};
        const stepId = runArtifact.steps.length + i + 1;
        if (obs.detail?.image) {
          const saved = scratchpad.saveImage({
            base64: obs.detail.image,
            title: brief.title,
            url: brief.url,
            description: obs.detail.description,
            hint: action.args?.hint,
            id: stepId,
            ext: obs.detail.ext || 'png',
          });
          obs.detail.savedPath = saved?.path || null;
          delete obs.detail.image;
        }
        if (obs.verb === 'save_text' && obs.detail) {
          const saved = scratchpad.saveText({
            content: obs.detail.content,
            summary: obs.detail.summary,
            url: brief.url,
          });
          obs.detail.savedPath = saved?.path || null;
          delete obs.detail.content;   // keep only the model's summary in context
        }
        if (obs.verb === 'save_file' && obs.detail?.fileBytes) {
          const saved = scratchpad.saveAsset({
            base64: obs.detail.fileBytes,
            filename: obs.detail.filename,
            summary: obs.detail.description || obs.detail.summary,
            url: obs.detail.sourceUrl,
            hint: action.args?.hint,
            id: stepId,
          });
          obs.detail.savedPath = saved?.path || null;
          delete obs.detail.fileBytes;   // bytes stay on disk; only the summary re-enters context
        }
      }

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
      // Record the model's prose for an action-less turn so it shows up in the
      // event log (the model sees it next turn, and it lands in the report).
      if (plannedActions.length === 0 && modelText) {
        events.push(`(no action) model said: "${modelText.length > 300 ? modelText.slice(0, 299) + '…' : modelText}"`);
      }
      if (emptyPlanStreak >= loopCfg.maxEmptyPlans) {
        emit(`\nempty plan repeated ${emptyPlanStreak} turns; aborting`);
        logger.event({ kind: 'empty-plan', turn: iter, repeats: emptyPlanStreak, modelText: modelText || null });
        runArtifact.status = 'empty-plan';
        runArtifact.result = `Stopped: the model returned no actions for ${emptyPlanStreak} consecutive turns.`
          + (modelText ? ` Last message: ${modelText}` : '');
        return finish(runArtifact, { events, scratchpad });
      }

      // 6. Record Steps + append executed events.
      for (let i = 0; i < observations.length; i++) {
        const resolvedName = refName(brief, validActions[i].ref);
        const step = { kind: 'step', url: brief.url, title: brief.title, targetName: resolvedName, action: validActions[i], observation: observations[i] };
        runArtifact.steps.push(step);
        runArtifact.stats.stepCount++;

        if (step.action.verb === 'done') {
          runArtifact.status = 'completed';
          runArtifact.result = step.action.args?.result ?? null;
          emit(`  ✓ ${termDesc(step.action, brief)}`);
          return finish(runArtifact, { events, scratchpad });
        }

        const failed = step.observation.status === 'error';
        const line = describeAction(step.action, brief);
        let note = '';
        if (failed) {
          note = ` — FAILED: ${step.observation.error}`;
        } else if (step.observation.detail?.selectedText != null) {
          // Report what select_text actually highlighted so the model can read it
          // and finish (or save_text it to keep it), instead of re-selecting blind.
          // Only this 200-char preview re-enters the model's context; to persist
          // the full text the model follows up with save_text.
          const sel = step.observation.detail.selectedText;
          note = sel
            ? ` — selected: "${sel.length > 200 ? sel.slice(0, 199) + '…' : sel}"`
            : ' — selected nothing (empty selection)';
        } else if (step.observation.detail?.description != null) {
          // Full vision descriptions are saved with artifacts; only the compact
          // summary re-enters prompt history so long runs do not balloon.
          const desc = step.observation.detail.summary || step.observation.detail.description;
          note = step.action.verb === 'save_file' ? ` — "${desc}"` : ` — saw: "${desc}"`;
          // Report the saved file so the model knows the artifact exists.
          const saved = step.observation.detail.savedPath;
          if (saved) note += step.action.verb === 'save_file' ? ` → ${saved}` : ` — saved image to ${saved}`;
        } else if (step.observation.detail?.summary != null) {
          // save_text: the full content is on disk; only the model's own summary
          // re-enters context, so it stays aware of what it has saved (progress,
          // dedup) without re-ingesting the bulk text.
          note = ` — "${step.observation.detail.summary}"`;
          const saved = step.observation.detail.savedPath;
          if (saved) note += ` → ${saved}`;
        }
        const entry = `${line}${note}`;
        events.push(entry);
        const scrollWarning = scrollIntentWarning(step, scrollIntentState, loopCfg);
        if (scrollWarning) events.push(scrollWarning);
        const tDesc = termDesc(step.action, brief, step.observation.detail ? step.observation : undefined);
        emit(failed ? `  ✗ ${tDesc} — ${step.observation.error}` : `  ✓ ${tDesc}`);
      }

      // Rejected actions become events too, so the next turn the model sees what
      // it tried and why it was refused (unknown verb, bad ref, wrong arg types).
      for (const { action, error } of errors) {
        const entry = `${describeAction(action, brief)} — rejected: ${error}`;
        events.push(`✗ ${entry}`);
        emit(`  ✗ ${entry}`);
      }

      if (validActions.length === 0) {
        // Nothing executed, so the page can't change. Clear lastHash so the next
        // turn re-prompts immediately instead of polling for a change that will
        // never come. (Still counts toward max-steps — iter already incremented.)
        lastHash = null;
        lastActionKey = null;
        lastReadKey = null;
        // Treat the rejected primary like an errored target, keyed on the current
        // page: a model that re-emits the SAME invalid action every turn then
        // trips sameErroredTarget → stuckStreak and aborts, instead of grinding to
        // max-steps re-rejecting it. A different or valid action next turn clears it.
        lastActionBriefHash = brief.briefHash;
        lastErroredKey = primaryKey;
        continue;
      }

      // Remember the page the model just acted on. Next turn's extract is
      // compared against this: if the action changed nothing, we poll/wait; if
      // it changed the page, we proceed immediately. But if every action errored
      // (nothing executed, page unchanged) clear lastHash to re-prompt now.
      const anyExecuted = observations.some(o => o.status === 'ok');
      const primaryExecuted = anyExecuted ? validActions.find(a => a.verb !== 'done') : null;
      // Actions flagged changesPage:false (e.g. select_text) never alter the
      // hashed view, so waiting for a change is pointless — clear lastHash to
      // re-prompt immediately instead of polling maxNoChangePolls for nothing.
      const changesPage = primaryExecuted ? actions[primaryExecuted.verb]?.changesPage !== false : false;
      lastHash = (anyExecuted && changesPage) ? brief.briefHash : null;
      // Track the executed action for the no-op guard (first non-done action),
      // plus its read key + page hash so the guard can catch idempotent reads
      // repeated on an unchanged page.
      lastActionKey = primaryExecuted ? actionKey(brief, primaryExecuted) : null;
      lastReadKey = primaryExecuted ? idempotentReadKey(brief, primaryExecuted) : null;
      lastActionBriefHash = primaryExecuted ? brief.briefHash : null;
      // If the primary (first non-done) action ERRORED, remember its stable key so
      // re-planning it next turn increments stuckStreak via sameErroredTarget. A
      // success or a different target leaves this null, resetting the streak — so a
      // legitimate dismiss-overlay-then-retry isn't mistaken for flailing.
      const primaryIdx = validActions.findIndex(a => a.verb !== 'done');
      const primaryErrored = primaryIdx >= 0 && observations[primaryIdx]?.status === 'error';
      lastErroredKey = primaryErrored ? actionKey(brief, validActions[primaryIdx]) : null;
    }

    runArtifact.status = 'max-steps';
    return finish(runArtifact, { events, scratchpad });
  } catch (err) {
    runArtifact.status = 'failed';
    runArtifact.error = err?.message || String(err);
    return finish(runArtifact, { events, scratchpad });
  } finally {
    try { logger.finalize(runArtifact); } catch {}
    try { await exec.close(); } catch {}
  }
}

// Assemble the deliverable: a single Markdown string with the steps taken and
// Build a Markdown report optimised for feeding into a downstream LLM.
// Steps include page context (shown once per URL, not repeated), the action
// verb + key args, and any text saved to the scratchpad — inline, so a reader
// can see what was captured and when. The full scratchpad follows at the end.
function buildReport(runArtifact, _events, scratchpad) {
  const out = [];

  out.push(`# Task\n${runArtifact.task}\n`);

  out.push(`## Result\n**Status:** ${runArtifact.status}\n`);
  if (runArtifact.result) out.push(runArtifact.result + '\n');
  if (runArtifact.error) out.push(`**Error:** ${runArtifact.error}\n`);

  out.push('## Steps\n');

  let currentUrl = null;
  let stepNum = 0;

  for (const step of runArtifact.steps) {
    const { action, observation } = step;

    // Show page header whenever the URL changes.
    const url = step.url ? cleanUrl(step.url) : null;
    if (url && url !== currentUrl) {
      const pageLabel = step.title ? `**${step.title}**  \n${url}` : url;
      if (stepNum > 0) out.push('');
      out.push(pageLabel + '\n');
      currentUrl = url;
    }

    stepNum++;
    let line = `${stepNum}. **${action.verb}**`;

    switch (action.verb) {
      case 'navigate':
        line += ` → ${action.args?.url || ''}`;
        break;
      case 'click': {
        const name = step.targetName;
        if (name) line += ` "${name}"`;
        else if (action.ref) line += ` ${action.ref}`;
        break;
      }
      case 'type':
        line += ` "${action.args?.text || ''}"`;
        if (step.targetName) line += ` into "${step.targetName}"`;
        else if (action.ref) line += ` into ${action.ref}`;
        break;
      case 'scroll':
        line += ` ${action.args?.direction || 'down'}`;
        if (action.args?.amount != null) line += ` (${action.args.amount}px)`;
        break;
      case 'press':
        if (hasText(action.args?.key)) line += ` ${action.args.key}`;
        break;
      case 'wait':
        if (action.args?.ms != null) line += ` ${action.args.ms}ms`;
        break;
      case 'select_text': {
        const sel = observation.detail?.selectedText;
        if (sel) {
          const preview = sel.length > 160 ? sel.slice(0, 159) + '…' : sel;
          line += ` → "${preview}"`;
        } else {
          line += ' → (empty)';
        }
        break;
      }
      case 'take_screenshot': {
        const desc = observation.detail?.description;
        const saved = observation.detail?.savedPath;
        if (action.args?.hint) line += ` (${action.args.hint})`;
        if (saved) line += ` → saved ${saved}`;
        if (desc) {
          const preview = desc.length > 200 ? desc.slice(0, 199) + '…' : desc;
          line += ` → "${preview}"`;
        }
        break;
      }
      case 'save_text': {
        const sum = observation.detail?.summary;
        if (sum) line += ` — "${sum}"`;   // full text is in the Scratchpad section below
        break;
      }
      case 'save_file': {
        const saved = observation.detail?.savedPath;
        const sum = observation.detail?.summary;
        if (saved) line += ` → saved ${saved}`;
        if (sum) {
          const preview = sum.length > 200 ? sum.slice(0, 199) + '…' : sum;
          line += ` → "${preview}"`;
        }
        break;
      }
      case 'done':
        line += action.args?.result ? ` — ${action.args.result}` : '';
        break;
    }

    if (observation.status === 'error') {
      line += ` _(error: ${observation.error})_`;
    }

    out.push(line);
  }

  out.push('');

  const saved = (scratchpad.readMarkdown() || '').trim();
  out.push(`## Scratchpad\n`);
  out.push(saved || '_(nothing saved)_');
  out.push('');

  return out.join('\n');
}

function finish(runArtifact, { events = [], scratchpad } = {}) {
  runArtifact.endedAt = new Date().toISOString();
  runArtifact.stats.totalElapsedMs = Date.parse(runArtifact.endedAt) - Date.parse(runArtifact.startedAt);
  if (scratchpad) {
    runArtifact.report = buildReport(runArtifact, events, scratchpad);
    const reportPath = scratchpad.writeReport?.(runArtifact.report);
    if (reportPath) scratchpad.removeMarkdown?.();
  }
  const s = runArtifact.stats;
  const elapsed = (s.totalElapsedMs / 1000).toFixed(1);
  const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const errNote = runArtifact.error ? `  error: ${runArtifact.error}` : '';
  console.error(`\nfinished · ${runArtifact.status} · ${s.stepCount} steps · ${elapsed}s · ${fmt(s.totalInputTokens)} in / ${fmt(s.totalOutputTokens)} out${errNote}`);
  return runArtifact;
}

module.exports = { run };
