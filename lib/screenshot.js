'use strict';

// The `screenshot` verb. Backend-agnostic: it captures via the CDP client that
// every Session holds (so it works the same whether the os or cdp executor is
// driving input), then hands the image to the configured vision model. The
// returned `description` rides back as the Observation's `detail`, which the
// loop folds into the event log so the planner can read what was on the page.
//
// Captures the whole viewport by default. When the action carries a ref, it
// crops to that element's DOM rectangle — the geometry comes straight from the
// snapshot, so the crop is exact and needs no model-supplied coordinates.

const vision = require('./vision');

// Normalize a brief bbox (array [x,y,w,h] in tree mode, object in flat mode).
function toBox(bbox) {
  if (!bbox) return null;
  return Array.isArray(bbox)
    ? { x: bbox[0], y: bbox[1], width: bbox[2], height: bbox[3] }
    : bbox;
}

// Resolve a ref to a captureScreenshot clip, using the brief the ref was taken
// against. bbox is in page coordinates / CSS px (the same space the clip wants),
// so it maps directly; scale:1 means "no extra zoom". Returns null — i.e. fall
// back to a full-viewport capture — when the ref is absent, unknown, or boxless,
// so a stale or odd ref degrades gracefully instead of failing the action.
function clipForRef(brief, ref) {
  if (!ref || !brief) return null;
  const node = [...(brief.elements || []), ...(brief.text || []), ...(brief.regions || [])]
    .find(n => n.ref === ref);
  const b = toBox(node?.bbox);
  if (!b || b.width <= 0 || b.height <= 0) return null;
  return { x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 };
}

async function screenshot({ session, hint, ref, brief, signal } = {}) {
  if (!session?.client) throw new Error('screenshot requires a CDP session');

  // captureScreenshot is a one-shot command (no Page.enable needed) and reads
  // composited pixels — including cross-origin iframe content like CAPTCHAs.
  // captureBeyondViewport lets a clip reach content scrolled off-screen, so a
  // cropped read works without scrolling the element into view first.
  const clip = clipForRef(brief, ref);
  const params = { format: 'png' };
  if (clip) { params.clip = clip; params.captureBeyondViewport = true; }

  const { data } = await session.client.Page.captureScreenshot(params);
  if (!data) throw new Error('screenshot: Chrome returned no image data');

  const description = await vision.describe({ imageBase64: data, mimeType: 'image/png', hint, signal });
  // `image` is the raw base64 PNG. The loop persists it to the run dir and then
  // strips it (so the 1MB+ payload never lands in the JSONL log or re-enters the
  // model's context) — only the saved path and description go back to the model.
  return {
    description: description || '(vision model returned no description)',
    hint: hint || null,
    ref: ref || null,
    cropped: !!clip,
    image: data,
    mimeType: 'image/png',
  };
}

module.exports = { screenshot, clipForRef };
