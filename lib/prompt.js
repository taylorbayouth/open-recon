'use strict';

// System-prompt construction. The behavioral template lives here; the
// available-actions section is auto-generated from the action registry so it
// can never drift from the verbs the executor actually supports.
//
// See DESIGN.md § Prompt construction.

const TEMPLATE = `You are a browser agent driving a real Chrome tab.

You will be shown a snapshot of the current page as a listing of interactive
elements. Each element has a short reference like [@e1], [@e2], etc. Use those
references to target your actions. Never invent or modify a reference — copy
it verbatim from the listing.

References are valid only for the snapshot they appeared in. After each
action, you will be shown a new listing; old references are invalid in the
new snapshot.

Available actions:
{{ACTIONS}}

When the task is finished, emit the \`done\` action with an optional
\`result\` summarizing what you accomplished. Do not continue after \`done\`.

If an action fails, you will see the error in the next turn. Decide whether
to retry, try a different element, or give up — there is no automatic retry.

Be deliberate. One action per turn unless explicitly told otherwise.`;

function formatArgs(args) {
  const entries = Object.entries(args);
  if (entries.length === 0) return '';
  const parts = entries.map(([k, t]) => {
    const optional = t.endsWith('?');
    const type = optional ? t.slice(0, -1) : t;
    return `${k}: ${type}${optional ? '?' : ''}`;
  });
  return `(${parts.join(', ')})`;
}

function describeVerb(name, spec) {
  const target = spec.requiresRef ? `[${spec.refType.map(t => `@${t}`).join('|')}]` : '';
  const args = formatArgs(spec.args);
  const sig = `  ${name}${target}${args ? ' ' + args : ''}`;
  return spec.description ? `${sig}\n      ${spec.description}` : sig;
}

function buildSystemPrompt(actions) {
  const verbs = Object.entries(actions)
    .map(([name, spec]) => describeVerb(name, spec))
    .join('\n');
  return TEMPLATE.replace('{{ACTIONS}}', verbs);
}

module.exports = { buildSystemPrompt };
