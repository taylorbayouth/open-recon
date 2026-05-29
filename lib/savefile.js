'use strict';

// The `save_file` verb. Downloads the real bytes at a URL — typically one the
// model got from get_images / get_files (or a link it sees in the listing) — and
// hands them back for the loop to persist under assets/. Images are described by
// the vision model; other files get a metadata note.
//
// Download strategy (no page JS):
//   data:        decode the URI directly.
//   loaded:      Page.getResourceContent reads the page's cached bytes — exact
//                original, no CSP/CORS check (the page already loaded it).
//   cold:        Network.loadNetworkResource re-fetches in page context; this IS
//                subject to the page's CSP, so a cold cross-origin URL may fail —
//                the error tells the model to navigate to it first.

const vision = require('./vision');

// Magic-byte sniff → mime + extension. Reliable regardless of URL/headers.
function sniff(buf) {
  const hex = buf.slice(0, 12).toString('hex');
  if (hex.startsWith('89504e47')) return { mime: 'image/png', ext: 'png' };
  if (hex.startsWith('ffd8ff')) return { mime: 'image/jpeg', ext: 'jpg' };
  if (hex.startsWith('47494638')) return { mime: 'image/gif', ext: 'gif' };
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (hex.startsWith('25504446')) return { mime: 'application/pdf', ext: 'pdf' };
  return { mime: null, ext: null };
}

async function download(client, frameId, url) {
  // Primary: already-loaded bytes from cache — exact original, no CSP check.
  try {
    const { content, base64Encoded } = await client.Page.getResourceContent({ frameId, url });
    if (content != null) return Buffer.from(content, base64Encoded ? 'base64' : 'utf8');
  } catch {}
  // Fallback: re-fetch in page context (subject to CSP; works same-origin).
  try {
    await client.Network.enable();
    const res = await client.Network.loadNetworkResource({
      frameId, url, options: { disableCache: false, includeCredentials: true },
    });
    if (res.resource?.success && res.resource.stream) {
      let buf = Buffer.alloc(0), eof = false;
      while (!eof) {
        const c = await client.IO.read({ handle: res.resource.stream });
        buf = Buffer.concat([buf, Buffer.from(c.data, c.base64Encoded ? 'base64' : 'utf8')]);
        eof = c.eof;
      }
      await client.IO.close({ handle: res.resource.stream });
      return buf;
    }
  } catch {}
  return null;
}

async function saveFile({ session, brief, url, hint, signal } = {}) {
  if (!session?.client) throw new Error('save_file requires a CDP session');
  if (!url || typeof url !== 'string') throw new Error('save_file requires a url (use get_images / get_files to find one)');
  const client = session.client;

  let buf, resolvedUrl;
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const isB64 = /;base64/i.test(url.slice(5, comma));
    buf = Buffer.from(url.slice(comma + 1), isB64 ? 'base64' : 'utf8');
    resolvedUrl = '(data URI)';
  } else {
    resolvedUrl = new URL(url, brief?.url || undefined).href;   // resolve relative against the page
    const { frameTree } = await client.Page.getFrameTree();
    buf = await download(client, frameTree.frame.id, resolvedUrl);
  }
  if (!buf || !buf.length) {
    throw new Error(`save_file: could not download ${resolvedUrl} — it may not be loaded yet, or the page's CSP blocked the fetch. Navigate to it first, then save_file.`);
  }

  const { mime, ext } = sniff(buf);
  let filename = url.startsWith('data:') ? 'file' : (new URL(resolvedUrl).pathname.split('/').pop() || 'file');
  if (!/\.\w+$/.test(filename) && ext) filename = `${filename}.${ext}`;

  let summary;
  if (mime && mime.startsWith('image/')) {
    summary = await vision.describe({ imageBase64: buf.toString('base64'), mimeType: mime, hint, signal });
  } else {
    const kb = Math.max(1, Math.round(buf.length / 1024));
    summary = `Downloaded ${filename} (${mime || ext || 'unknown type'}, ${kb} KB) from ${resolvedUrl}`;
  }

  return { fileBytes: buf.toString('base64'), filename, mimeType: mime, sourceUrl: resolvedUrl, summary };
}

module.exports = { saveFile };
