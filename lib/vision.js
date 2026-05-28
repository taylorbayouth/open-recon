'use strict';

// Secondary vision model. The `screenshot` verb captures the page as an image
// and calls describe() here to turn it into text the planner can read. Kept
// separate from lib/providers/* (which are tool-calling planners): this is a
// single-shot "image in, prose out" call, no tools, no history.
//
// Reuses postJSON from the provider shared layer for the same timeout/retry
// behavior, and reads its provider/model/prompt from config.vision.

const { postJSON } = require('./providers/_shared');
const { loadConfig } = require('./config');

const DEFAULT_PROMPT = 'Describe what you see in detail. Aim for 1500-2000 characters.';

// A multimodal default per provider, used when config.vision.model is null.
const DEFAULT_MODEL = {
  openai: 'gpt-5.4-mini',
  anthropic: 'claude-opus-4-7',
  ollama: 'llama3.2-vision',
};

// Static base prompt + an optional caller hint about what to look for. The hint
// is what makes this useful for targeted reads (a CAPTCHA wants "read the
// characters", not a paragraph about the page's color scheme).
function buildPrompt(base, hint) {
  const p = base || DEFAULT_PROMPT;
  return hint ? `${p}\n\nFocus especially on: ${hint}` : p;
}

async function describeOpenAI({ baseURL, apiKey, model, prompt, dataUrl, maxTokens, signal }) {
  const data = await postJSON(`${baseURL}/chat/completions`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    body: {
      model,
      max_completion_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
    },
    signal,
    label: 'Vision (OpenAI)',
  });
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function describeAnthropic({ baseURL, apiKey, model, prompt, imageBase64, mimeType, maxTokens, signal }) {
  const data = await postJSON(`${baseURL}/v1/messages`, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: {
      model,
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
        ],
      }],
    },
    signal,
    label: 'Vision (Anthropic)',
  });
  const textBlock = (data.content || []).find(b => b.type === 'text');
  return (textBlock?.text || '').trim();
}

async function describeOllama({ baseURL, model, prompt, imageBase64, maxTokens, signal }) {
  // Ollama's native /api/chat takes raw base64 in an `images` array on the
  // message (not OpenAI-style content parts).
  const data = await postJSON(`${baseURL}/api/chat`, {
    body: {
      model,
      stream: false,
      messages: [{ role: 'user', content: prompt, images: [imageBase64] }],
      options: { temperature: 0, num_predict: maxTokens },
    },
    signal,
    label: 'Vision (Ollama)',
  });
  return (data.message?.content || '').trim();
}

// imageBase64: raw base64 PNG (no data: prefix). Returns the model's text, or
// throws with a provider-attributable message on failure.
async function describe({ imageBase64, mimeType = 'image/png', hint, signal } = {}) {
  if (!imageBase64) throw new Error('vision.describe requires imageBase64');

  const cfg = loadConfig().vision || {};
  const provider = cfg.provider || 'openai';
  const model = cfg.model || DEFAULT_MODEL[provider];
  const maxTokens = Number.isFinite(cfg.maxTokens) ? cfg.maxTokens : 1024;
  const prompt = buildPrompt(cfg.prompt, hint);
  if (!model) throw new Error(`vision: no model configured for provider "${provider}" (set vision.model)`);

  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('vision: OPENAI_API_KEY not set');
    const baseURL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    return describeOpenAI({ baseURL, apiKey, model, prompt, dataUrl: `data:${mimeType};base64,${imageBase64}`, maxTokens, signal });
  }

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('vision: ANTHROPIC_API_KEY not set');
    const baseURL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
    return describeAnthropic({ baseURL, apiKey, model, prompt, imageBase64, mimeType, maxTokens, signal });
  }

  if (provider === 'ollama') {
    const baseURL = (process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
    return describeOllama({ baseURL, model, prompt, imageBase64, maxTokens, signal });
  }

  throw new Error(`vision: unknown provider "${provider}" (have: openai, anthropic, ollama)`);
}

module.exports = { describe, DEFAULT_PROMPT };
