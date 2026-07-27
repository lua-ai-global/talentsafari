// Per-IP sliding-window rate limiter backed by Vercel KV (Upstash Redis).
//
// Each (route, ip) pair gets its own ZSET keyed `rl:<route>:<windowSeconds>s:<ip>`.
// Members are unique timestamp-suffixed tokens; scores are millisecond timestamps.
// On every call we atomically (MULTI/EXEC):
//   1. Drop members older than `now - windowMs`     (ZREMRANGEBYSCORE)
//   2. Insert the current request                   (ZADD)
//   3. Count remaining members                      (ZCARD)
//   4. Refresh the key TTL                          (PEXPIRE)
//   5. Read the oldest remaining score              (ZRANGE 0 0 WITHSCORES) — for resetAt
//
// If KV env vars are missing (local dev, preview without KV) we no-op with allowed:true.
// If a KV call throws (transient network) we also fail open — we'd rather serve a real
// user than 500 the whole site over a rate-limiter outage.

import { kv } from '@vercel/kv';

let kvMissingWarned = false;

function isKvConfigured() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  const xri = req.headers['x-real-ip'];
  if (typeof xri === 'string' && xri.trim()) return xri.trim();
  // Shared bucket for unknown IPs — intentionally the *most* rate-limited path,
  // not an unlimited bypass.
  return 'unknown';
}

export async function checkRateLimit(req, { route, limit, windowSeconds }) {
  if (!isKvConfigured()) {
    if (!kvMissingWarned) {
      kvMissingWarned = true;
      console.warn('[rate-limit] KV_REST_API_URL / KV_REST_API_TOKEN not set — rate limiting disabled');
    }
    return { allowed: true, remaining: limit, resetAt: 0 };
  }

  const ip = clientIp(req);
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const cutoff = now - windowMs;
  const key = `rl:${route}:${windowSeconds}s:${ip}`;
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    const tx = kv.multi();
    tx.zremrangebyscore(key, 0, cutoff);
    tx.zadd(key, { score: now, member });
    tx.zcard(key);
    tx.pexpire(key, windowMs + 1000);
    tx.zrange(key, 0, 0, { withScores: true });
    const results = await tx.exec();

    // results: [removed, added, count, expireOk, oldestEntry]
    const count = Number(results[2] ?? 0);
    const oldestScore = parseOldestScore(results[4], now);
    const resetAt = oldestScore + windowMs;
    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);
    return { allowed, remaining, resetAt };
  } catch (err) {
    console.error('[rate-limit] KV error, failing open:', err?.message || err);
    return { allowed: true, remaining: limit, resetAt: 0 };
  }
}

// @upstash/redis has shipped ZRANGE WITHSCORES in two shapes across versions:
// flat [member, score, ...] and [{ member, score }, ...]. Tolerate both, fall
// back to `now` (gives resetAt = now + windowMs, a safe worst-case upper bound).
function parseOldestScore(entry, fallbackNow) {
  if (!Array.isArray(entry) || entry.length === 0) return fallbackNow;
  if (entry.length >= 2 && (typeof entry[1] === 'number' || typeof entry[1] === 'string')) {
    const n = Number(entry[1]);
    if (Number.isFinite(n)) return n;
  }
  const first = entry[0];
  if (first && typeof first === 'object') {
    const n = Number(first.score);
    if (Number.isFinite(n)) return n;
  }
  return fallbackNow;
}

// Pick the stricter of two checkRateLimit results: any block wins; among blocks,
// the one with the latest resetAt; among allows, the one with the lowest remaining.
export function pickStricter(a, b) {
  if (!a.allowed && !b.allowed) return a.resetAt >= b.resetAt ? a : b;
  if (!a.allowed) return a;
  if (!b.allowed) return b;
  return a.remaining <= b.remaining ? a : b;
}

// Send a 429 with standard rate-limit headers and a JSON body the FE can read.
export function send429(res, { route, result }) {
  const retryAfterSec = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  res.setHeader('Retry-After', String(retryAfterSec));
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
  return res.status(429).json({
    error: 'Too Many Requests',
    route,
    retryAfterSeconds: retryAfterSec,
    resetAt: new Date(result.resetAt).toISOString(),
  });
}
