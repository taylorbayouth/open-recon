'use strict';

function tokenText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(tokenText).join('\n');
  if (typeof value === 'object') return Object.values(value).map(tokenText).join('\n');
  return '';
}

function estimateTokens(value) {
  const text = tokenText(value);
  return text ? Math.ceil(text.length / 4) : 0;
}

module.exports = { estimateTokens };
