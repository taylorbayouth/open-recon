'use strict';

// On-demand media discovery, invisible by construction.
//
// Images and file links are deliberately NOT in the perception listing (which
// stays lean — interactive elements + text). When the model needs to find or
// save one, get_images / get_files scan for it here, using only DevTools DOM
// reads — DOM.querySelectorAll / getAttributes / getBoxModel. No JavaScript runs
// in the page, nothing mutates, no events fire: the same out-of-process channel
// perception uses, so it's no more detectable than listing a link.
//
// Both views share one scan helper. Per-node reads (vs parsing a DOMSnapshot's
// column tables) are a deliberate choice: a few more protocol calls in exchange
// for code that's obvious to read and debug.

// File extensions get_files treats as "downloadable". Images are handled by
// get_images, so they're intentionally absent here.
const FILE_EXTS = new Set([
  'pdf', 'csv', 'tsv', 'xls', 'xlsx', 'doc', 'docx', 'ppt', 'pptx',
  'zip', 'gz', 'tar', 'rtf', 'txt', 'md', 'json', 'xml', 'epub',
]);

// Drop tracking pixels / tiny icons: keep images whose rendered area clears this
// (≈ 80×80). Content images are far larger; this is the noise floor.
const MIN_IMAGE_AREA = 6400;

// Hard cap on nodes examined per scan, so a pathological page (thousands of
// nodes) can't turn discovery into a protocol-call storm.
const MAX_NODES = 400;

function attrMap(flat) {
  const m = {};
  for (let i = 0; i + 1 < (flat || []).length; i += 2) m[flat[i]] = flat[i + 1];
  return m;
}

function absUrl(raw, base) {
  try { return new URL(raw, base || undefined).href; } catch { return null; }
}

function extOf(url) {
  try {
    const ext = (new URL(url).pathname.split('.').pop() || '').toLowerCase();
    return /^[a-z0-9]{1,5}$/.test(ext) ? ext : null;
  } catch { return null; }
}

function basenameOf(url) {
  try {
    const name = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(name) || null;
  } catch { return null; }
}

// One scan setup: register the document and return a scoped querySelectorAll plus
// the page URL (for resolving relative links).
async function begin(client) {
  await client.DOM.enable();
  const { root } = await client.DOM.getDocument({});
  const rootId = root.nodeId;
  const baseUrl = root.documentURL || null;
  const query = async (selector) => {
    try {
      const { nodeIds } = await client.DOM.querySelectorAll({ nodeId: rootId, selector });
      return (nodeIds || []).slice(0, MAX_NODES);
    } catch { return []; }
  };
  return { baseUrl, query };
}

async function attrsOf(client, nodeId) {
  try { return attrMap((await client.DOM.getAttributes({ nodeId })).attributes); }
  catch { return {}; }
}

// Rendered box (page coords) or null if the node isn't laid out (display:none,
// detached) — which conveniently filters hidden media out of the results.
async function boxOf(client, nodeId) {
  try {
    const { model } = await client.DOM.getBoxModel({ nodeId });
    const q = model.content; // [x1,y1, x2,y2, x3,y3, x4,y4]
    return { x: Math.round(q[0]), y: Math.round(q[1]), width: Math.round(model.width), height: Math.round(model.height) };
  } catch { return null; }
}

async function scanImages(client) {
  if (!client) return [];
  const { baseUrl, query } = await begin(client);
  const ids = await query('img');
  const out = [];
  for (const nodeId of ids) {
    const a = await attrsOf(client, nodeId);
    const src = a.src || (a.srcset ? a.srcset.split(',').pop().trim().split(/\s+/)[0] : null);
    const url = src ? absUrl(src, baseUrl) : null;
    if (!url || url.startsWith('data:')) continue;   // skip inline data: blobs (no point listing them)
    const box = await boxOf(client, nodeId);
    if (!box || box.width * box.height < MIN_IMAGE_AREA) continue;
    out.push({
      url,
      name: (a.alt || a['aria-label'] || a.title || '').trim(),
      width: box.width, height: box.height, x: box.x, y: box.y,
    });
  }
  out.sort((p, c) => c.width * c.height - p.width * p.height);   // biggest first
  return out;
}

async function scanFiles(client) {
  if (!client) return [];
  const { baseUrl, query } = await begin(client);
  const ids = await query('a[href], embed[src], object[data], iframe[src]');
  const seen = new Set();
  const out = [];
  for (const nodeId of ids) {
    const a = await attrsOf(client, nodeId);
    const url = absUrl(a.href || a.src || a.data, baseUrl);
    if (!url || seen.has(url)) continue;
    const ext = extOf(url);
    const isFile = a.download != null || (ext && FILE_EXTS.has(ext));
    if (!isFile) continue;
    seen.add(url);
    out.push({ url, filename: basenameOf(url) || (a.download || '').trim() || 'file', ext: ext || null });
  }
  return out;
}

// ── Verb handlers ─────────────────────────────────────────────────────────────
// Format a scan into one compact, capped block for the event log. The model
// reads it next turn and passes a chosen URL to save_file. Capped so a gallery
// page can't flood the prompt; biggest/first entries are the useful ones.

const IMAGE_LIST_CAP = 15;
const FILE_LIST_CAP = 20;

function formatImages(images) {
  if (!images.length) return 'No images found on this page.';
  const shown = images.slice(0, IMAGE_LIST_CAP).map((im, i) => {
    const label = im.name || basenameOf(im.url) || 'image';
    return `  ${i + 1}. ${im.width}x${im.height} "${label}" at (${im.x},${im.y}) — ${im.url}`;
  });
  const more = images.length > IMAGE_LIST_CAP ? `\n  …and ${images.length - IMAGE_LIST_CAP} more` : '';
  return `Found ${images.length} image(s), biggest first:\n${shown.join('\n')}${more}\n` +
         `Pass one of these URLs to save_file to save it.`;
}

function formatFiles(files) {
  if (!files.length) return 'No downloadable files found on this page.';
  const shown = files.slice(0, FILE_LIST_CAP).map((f, i) =>
    `  ${i + 1}. ${f.filename}${f.ext ? ` (.${f.ext})` : ''} — ${f.url}`);
  const more = files.length > FILE_LIST_CAP ? `\n  …and ${files.length - FILE_LIST_CAP} more` : '';
  return `Found ${files.length} file(s):\n${shown.join('\n')}${more}\n` +
         `Pass one of these URLs to save_file to save it.`;
}

async function getImages({ session } = {}) {
  const images = await scanImages(session?.client);
  return { summary: formatImages(images), count: images.length };
}

async function getFiles({ session } = {}) {
  const files = await scanFiles(session?.client);
  return { summary: formatFiles(files), count: files.length };
}

module.exports = { scanImages, scanFiles, getImages, getFiles, FILE_EXTS, MIN_IMAGE_AREA };
