'use strict';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(value) {
  const tokens = [];
  const store = (html) => {
    const token = `%%MDTOKEN${tokens.length}%%`;
    tokens.push([token, html]);
    return token;
  };

  let text = String(value ?? '');
  text = text.replace(/`([^`]+)`/g, (_, code) =>
    store(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) =>
    store(`<img src="${escapeHtml(safeUrl(src))}" alt="${escapeHtml(alt)}">`));
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) =>
    store(linkHtml(href, label)));
  text = text.replace(/\bhttps?:\/\/[^\s<]+/g, (raw) => {
    let url = raw;
    let suffix = '';
    while (/[),.;:!?]$/.test(url)) {
      suffix = url.slice(-1) + suffix;
      url = url.slice(0, -1);
    }
    return store(linkHtml(url, url)) + suffix;
  });

  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  for (const [token, rendered] of tokens) html = html.replaceAll(token, rendered);
  return html;
}

function safeUrl(value) {
  const url = String(value || '').trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(url);
  return !hasScheme || /^(https?:|mailto:)/i.test(url) ? url : '#';
}

function linkHtml(href, label) {
  return `<a href="${escapeHtml(safeUrl(href))}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function markdownToHtml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let list = null;
  let code = null;

  function flushParagraph() {
    if (!paragraph.length) return;
    out.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!list) return;
    out.push(`<${list.type}>${list.items.map(item => `<li>${renderInline(item)}</li>`).join('')}</${list.type}>`);
    list = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (code) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }

    const fence = line.match(/^```/);
    if (fence) {
      flushParagraph();
      flushList();
      code = { lines: [] };
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      flushList();
      const headers = tableCells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(tableCells(lines[i]));
        i++;
      }
      i--;
      out.push(
        '<table><thead><tr>'
        + headers.map(cell => `<th>${renderInline(cell)}</th>`).join('')
        + '</tr></thead><tbody>'
        + rows.map(row => `<tr>${row.map(cell => `<td>${renderInline(cell)}</td>`).join('')}</tr>`).join('')
        + '</tbody></table>'
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const type = unordered ? 'ul' : 'ol';
      if (!list || list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push((unordered || ordered)[1]);
      continue;
    }

    const quote = line.match(/^\s*>\s?(.+)$/);
    if (quote) {
      flushParagraph();
      flushList();
      out.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    if (/^\s*-{3,}\s*$/.test(line)) {
      flushParagraph();
      flushList();
      out.push('<hr>');
      continue;
    }

    paragraph.push(line.trim());
  }

  if (code) out.push(`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
  flushParagraph();
  flushList();
  return out.join('\n');
}

function markdownToHtmlDocument(markdown, { title = 'Report' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;color:#1f2937;background:#f8fafc}
main{max-width:920px;margin:0 auto;padding:40px 24px 64px;background:#fff;min-height:100vh}
h1,h2,h3,h4,h5,h6{line-height:1.2;color:#111827;margin:1.6em 0 .5em}
h1{font-size:2rem;margin-top:0} h2{font-size:1.35rem;border-bottom:1px solid #e5e7eb;padding-bottom:.25rem}
p,ul,ol,blockquote,pre,table{margin:0 0 1rem}
a{color:#0f766e} img{max-width:100%;height:auto;border:1px solid #e5e7eb}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f3f4f6;padding:.1rem .25rem;border-radius:4px}
pre{overflow:auto;background:#111827;color:#f9fafb;padding:1rem;border-radius:6px}
pre code{background:transparent;color:inherit;padding:0}
blockquote{border-left:4px solid #d1d5db;padding-left:1rem;color:#4b5563}
table{border-collapse:collapse;width:100%;display:block;overflow:auto}
th,td{border:1px solid #e5e7eb;padding:.45rem .6rem;text-align:left;vertical-align:top}
th{background:#f3f4f6}
@media (prefers-color-scheme:dark){body{background:#111827;color:#d1d5db}main{background:#0f172a}h1,h2,h3,h4,h5,h6{color:#f9fafb}h2{border-color:#374151}code{background:#1f2937}th{background:#1f2937}th,td,img{border-color:#374151}blockquote{border-color:#4b5563;color:#d1d5db}}
</style>
</head>
<body>
<main>
${markdownToHtml(markdown)}
</main>
</body>
</html>
`;
}

module.exports = { markdownToHtml, markdownToHtmlDocument, escapeHtml };
