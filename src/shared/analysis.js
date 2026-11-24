// Pure helpers for analysing captured traffic. No browser APIs here so the
// functions can be unit-tested in Node.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{16,}$/i;
const NUM_RE = /^\d+$/;
const MIXED_ID_RE = /^(?=.*\d)[A-Za-z0-9_-]{20,}$/; // long tokens like Mongo/ULID/base64 ids

export function normalizePathSegment(seg) {
  if (NUM_RE.test(seg) || UUID_RE.test(seg) || HEX_RE.test(seg) || MIXED_ID_RE.test(seg)) return ':id';
  return seg;
}

/** Turn a URL into a stable "route" so /orders/123 and /orders/456 compare equal. */
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.split('/').map(normalizePathSegment).join('/');
    return `${u.origin}${path}`;
  } catch {
    return String(url || '');
  }
}

export function apiSignature(entry) {
  return `${String(entry.method || 'GET').toUpperCase()} ${normalizeUrl(entry.url)}`;
}

export function isApiLike(entry) {
  if (!entry) return false;
  if (entry.api === 'fetch' || entry.api === 'xhr') return true;
  return entry.method && entry.method.toUpperCase() !== 'GET'; // document form posts
}

/**
 * Compare the API traffic of a recording vs. a replay run.
 * Returns { matched[], missing[], unexpected[], statusChanged[], slower[] }.
 */
export function diffApiCalls(recorded, replayed) {
  const rec = recorded.filter(isApiLike);
  const rep = replayed.filter(isApiLike);
  const pool = new Map();
  for (const e of rep) {
    const sig = apiSignature(e);
    if (!pool.has(sig)) pool.set(sig, []);
    pool.get(sig).push(e);
  }
  const result = { matched: [], missing: [], unexpected: [], statusChanged: [], slower: [] };
  for (const r of rec) {
    const sig = apiSignature(r);
    const list = pool.get(sig);
    if (!list || !list.length) {
      result.missing.push({ signature: sig, recordedStatus: r.status });
      continue;
    }
    const p = list.shift();
    const pair = {
      signature: sig,
      recordedStatus: r.status,
      replayStatus: p.status,
      recordedMs: r.duration,
      replayMs: p.duration,
    };
    result.matched.push(pair);
    if ((r.status || 0) !== (p.status || 0)) result.statusChanged.push(pair);
    if (r.duration > 0 && p.duration > r.duration * 2 && p.duration - r.duration > 500) result.slower.push(pair);
  }
  for (const [sig, list] of pool) {
    for (const p of list) result.unexpected.push({ signature: sig, replayStatus: p.status });
  }
  return result;
}

export function matchesAnyPattern(url, patterns) {
  const u = String(url || '');
  return patterns.some((p) => p && u.includes(p));
}

/** Mask sensitive header values (case-insensitive header names). */
export function maskHeaders(headers, sensitiveNames, mask = true) {
  if (!headers) return headers;
  if (!mask) return { ...headers };
  const lower = new Set(sensitiveNames.map((s) => s.toLowerCase()));
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k] = lower.has(k.toLowerCase()) ? '***MASKED***' : v;
  return out;
}

/** Same-origin compare for "expected URL after step" checks. */
export function sameRoute(a, b) {
  return normalizeUrl(a) === normalizeUrl(b);
}
