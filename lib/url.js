'use strict';

// Prompt-facing URL cleanup. Keep semantically useful query params (e.g. `q`)
// but remove common tracking/search boilerplate and cap long tails.
const NOISY_URL_PARAMS = new Set([
  'dclid', 'fbclid', 'gclid', 'gbraid', 'wbraid', 'igshid', 'mc_cid', 'mc_eid', 'msclkid',
  // Common Google/Search boilerplate. Keep `q`, `tbm`, `tbs`, etc.
  'ei', 'gs_lcrp', 'gs_lp', 'ie', 'oq', 'sca_esv', 'sclient', 'sourceid', 'sxsrf', 'uact', 'ved',
  'biw', 'bih',
]);

function cleanUrl(url, { max = 500 } = {}) {
  if (!url) return null;
  let clean;
  try {
    const u = new URL(String(url));
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith('utm_') || NOISY_URL_PARAMS.has(lower) || u.searchParams.get(key) === '') {
        u.searchParams.delete(key);
      }
    }
    clean = u.toString();
  } catch {
    const raw = String(url);
    const hash = raw.indexOf('#');
    clean = hash === -1 ? raw : raw.slice(0, hash);
  }
  return max > 0 && clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

module.exports = { cleanUrl };
