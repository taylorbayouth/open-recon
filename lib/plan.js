'use strict';

// Thin provider facade. Picks a provider module by name, forwards the call,
// and returns the Completion artifact unchanged. No translation lives here —
// that's each provider's job.
//
// Also exports toolsFromRegistry(actions) which turns the action registry into
// the generic tool-definition shape consumed by providers.

const providers = {
  anthropic: require('./providers/anthropic'),
  openai: require('./providers/openai'),
  ollama: require('./providers/ollama'),
};

// Default provider. Override per-call via the `provider` arg, or globally via
// the OPEN_RECON_PROVIDER env var (mirrors OPEN_RECON_EXECUTOR).
const DEFAULT_PROVIDER = 'openai';

function toolsFromRegistry(actions) {
  const tools = [];
  for (const [name, spec] of Object.entries(actions)) {
    const inputSchema = {};
    if (spec.requiresRef) inputSchema.ref = 'string';
    else if (spec.optionalRef) inputSchema.ref = 'string?';
    for (const [k, v] of Object.entries(spec.args || {})) inputSchema[k] = v;
    tools.push({
      name,
      description: spec.description || '',
      inputSchema,
    });
  }
  return tools;
}

async function plan(req, { provider } = {}) {
  const name = provider || process.env.OPEN_RECON_PROVIDER || DEFAULT_PROVIDER;
  const mod = providers[name];
  if (!mod) throw new Error(`Unknown provider: ${name} (have: ${Object.keys(providers).join(', ')})`);
  return mod.plan(req);
}

module.exports = { plan, toolsFromRegistry, providers, DEFAULT_PROVIDER };
