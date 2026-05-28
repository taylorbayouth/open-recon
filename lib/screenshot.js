'use strict';

// The `screenshot` verb. Backend-agnostic: it captures via the CDP client that
// every Session holds (so it works the same whether the os or cdp executor is
// driving input), then hands the image to the configured vision model. The
// returned `description` rides back as the Observation's `detail`, which the
// loop folds into the event log so the planner can read what was on the page.
//
// Full viewport only for now — no element/region cropping.

const vision = require('./vision');

async function screenshot({ session, hint, signal } = {}) {
  if (!session?.client) throw new Error('screenshot requires a CDP session');

  // captureScreenshot is a one-shot command (no Page.enable needed) and reads
  // composited pixels — including cross-origin iframe content like CAPTCHAs.
  const { data } = await session.client.Page.captureScreenshot({ format: 'png' });
  if (!data) throw new Error('screenshot: Chrome returned no image data');

  const description = await vision.describe({ imageBase64: data, mimeType: 'image/png', hint, signal });
  // `image` is the raw base64 PNG. The loop persists it to the run dir and then
  // strips it (so the 1MB+ payload never lands in the JSONL log or re-enters the
  // model's context) — only the saved path and description go back to the model.
  return {
    description: description || '(vision model returned no description)',
    hint: hint || null,
    image: data,
    mimeType: 'image/png',
  };
}

module.exports = { screenshot };
