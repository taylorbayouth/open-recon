'use strict';

// Per-run scratchpad. The model saves things it gathers (a text selection, a
// block of notes it wrote, a captured image) into one run folder:
//
//   runs/<run-id>/saved.md        (in-run staging rollup, removed after report)
//   runs/<run-id>/assets/         (note-N.txt, screenshot-N.png — created on first save)
//
// The bulk content lives on disk, never in the model's working context — the
// loop only re-injects a short summary. At the end of a run saved.md is folded
// into the returned report and then removed (see loop.finish).

const fs = require('fs');
const path = require('path');

function filenameStemFromHint(hint, maxLength = 80) {
  const stem = String(hint || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return stem || null;
}

function uniqueAssetName(assetsDir, name, counter) {
  if (!fs.existsSync(path.join(assetsDir, name))) return name;
  const parsed = path.parse(name);
  let n = counter;
  do {
    name = `${parsed.name}-${n++}${parsed.ext}`;
  } while (fs.existsSync(path.join(assetsDir, name)));
  return name;
}

function markdownLabel(text, fallback) {
  return String(text || fallback || 'asset')
    .split('\n')[0]
    .replace(/[\[\]]/g, '')
    .trim()
    .slice(0, 120) || fallback || 'asset';
}

function createScratchpad({ enabled = true, dir = path.resolve(process.cwd(), 'runs'), runId } = {}) {
  if (!enabled) {
    return {
      saveText() { return null; }, saveImage() { return null; },
      saveAsset() { return null; }, readMarkdown() { return ''; }, removeMarkdown() {},
      writeReport() { return null; }, dir: null, reportPath: null,
    };
  }
  if (!path.isAbsolute(dir)) dir = path.resolve(process.cwd(), dir);
  const runDir = path.join(dir, runId || 'run');
  const savedPath = path.join(runDir, 'saved.md');
  const reportPath = path.join(runDir, 'report.md');
  const assetsDir = path.join(runDir, 'assets');
  let textCount = 0;
  let imageCount = 0;
  let assetCount = 0;

  fs.mkdirSync(runDir, { recursive: true });

  // Save model-gathered text to runs/<id>/assets/note-N.txt and log a block in
  // saved.md headed by the model's summary. Full text stays on disk; only the
  // summary re-enters the loop. Returns the absolute path.
  function saveText({ content, summary, title, url } = {}) {
    if (content == null) return null;
    fs.mkdirSync(assetsDir, { recursive: true });
    textCount++;
    const name = `note-${textCount}.txt`;
    const filePath = path.join(assetsDir, name);
    fs.writeFileSync(filePath, String(content));
    const ts = new Date().toISOString();
    const block = [
      summary ? `### ${summary}` : (title ? `### ${title}` : `### Note ${textCount}`),
      url ? `- URL: ${url}` : null,
      `- Saved: ${ts}`,
      `- File: assets/${name}`,
      '',
      String(content).trim(),
      '',
    ].filter(l => l !== null).join('\n');
    fs.appendFileSync(savedPath, block + '\n');
    return { path: filePath, name, count: textCount };
  }

  // Write a captured image to runs/<id>/assets/ and log a reference block in
  // saved.md (so the image surfaces in the final report). Returns the absolute
  // path. The bulk bytes stay on disk — only the path/summary re-enters the loop.
  function saveImage({ base64, title, url, description, hint, id, ext = 'png' } = {}) {
    if (!base64) return null;
    fs.mkdirSync(assetsDir, { recursive: true });
    imageCount++;
    const hintStem = filenameStemFromHint(hint);
    const stem = hintStem ? `${hintStem}-screenshot-${id || imageCount}` : `screenshot-${imageCount}`;
    const name = uniqueAssetName(assetsDir, `${stem}.${ext}`, imageCount);
    const imgPath = path.join(assetsDir, name);
    fs.writeFileSync(imgPath, Buffer.from(base64, 'base64'));
    const ts = new Date().toISOString();
    const block = [
      title ? `### ${title}` : `### Image ${imageCount}`,
      url ? `- URL: ${url}` : null,
      `- Saved: ${ts}`,
      `- Image: assets/${name}`,
      '',
      `![${markdownLabel(description, name)}](assets/${name})`,
      '',
      (description ?? '').trim(),
      '',
    ].filter(l => l !== null).join('\n');
    fs.appendFileSync(savedPath, block + '\n');
    return { path: imgPath, name, count: imageCount };
  }

  // Save arbitrary downloaded bytes (a file the page linked or displayed) to
  // assets/ under a sanitized name, and log a saved.md block. `summary` is the
  // model-facing description (vision text for images, metadata otherwise).
  function saveAsset({ base64, filename, summary, url, hint, id } = {}) {
    if (!base64) return null;
    fs.mkdirSync(assetsDir, { recursive: true });
    assetCount++;
    // Keep just the basename, drop any query/hash, sanitize. The handler passes
    // a name that already carries an extension; fall back to a generic one.
    const fallback = String(filename || '').split(/[?#]/)[0].split('/').pop().replace(/[^\w.\-]/g, '_');
    const parsed = path.parse(fallback);
    const hinted = filenameStemFromHint(hint);
    let name = hinted ? `${hinted}-${id || assetCount}${parsed.ext}` : fallback;
    if (!name) name = `file-${assetCount}`;
    name = uniqueAssetName(assetsDir, name, assetCount);
    const filePath = path.join(assetsDir, name);
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    const ts = new Date().toISOString();
    const block = [
      summary ? `### ${summary.split('\n')[0].slice(0, 120)}` : `### File ${assetCount}`,
      url ? `- Source: ${url}` : null,
      `- Saved: ${ts}`,
      `- File: assets/${name}`,
      `- Link: [${markdownLabel(name, `File ${assetCount}`)}](assets/${name})`,
      '',
      (summary ?? '').trim(),
      '',
    ].filter(l => l !== null).join('\n');
    fs.appendFileSync(savedPath, block + '\n');
    return { path: filePath, name, count: assetCount };
  }

  function readMarkdown() {
    try { return fs.readFileSync(savedPath, 'utf8'); } catch { return ''; }
  }

  function removeMarkdown() {
    try { fs.rmSync(savedPath, { force: true }); } catch {}
  }

  function writeReport(markdown) {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(reportPath, String(markdown ?? ''));
    return reportPath;
  }

  return {
    get textCount() { return textCount; },
    get imageCount() { return imageCount; },
    dir: runDir,
    savedPath,
    reportPath,
    saveText,
    saveImage,
    saveAsset,
    readMarkdown,
    removeMarkdown,
    writeReport,
  };
}

module.exports = { createScratchpad, filenameStemFromHint };
