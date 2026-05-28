'use strict';

// Thin provider facade. Picks a provider module by name, forwards the call,
// and returns the Completion artifact unchanged. No translation lives here —
// that's each provider's job.
//
// Also exports toolsFromRegistry(actions) which turns the action registry into
// the generic tool-definition shape consumed by providers.

const providers = {
  anthropic: require('./providers/anthropic'),
  // openai / ollama land in slice 2
};

function toolsFromRegistry(actions) {
  const tools = [];
  for (const [name, spec] of Object.entries(actions)) {
    const inputSchema = {};
    if (spec.requiresRef) inputSchema.ref = 'string';
    for (const [k, v] of Object.entries(spec.args || {})) inputSchema[k] = v;
    tools.push({
      name,
      description: spec.description || '',
      inputSchema,
    });
  }
  return tools;
}

async function plan(req, { provider = 'anthropic' } = {}) {
  const mod = providers[provider];
  if (!mod) throw new Error(`Unknown provider: ${provider}`);
  return mod.plan(req);
}

module.exports = { plan, toolsFromRegistry, providers };
