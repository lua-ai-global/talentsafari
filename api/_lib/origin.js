// Shared origin allowlist for all /api/* functions.
//
// Allowed origins come from three sources:
//  1. ALLOWED_ORIGINS env var (comma-separated, set per environment in Vercel)
//  2. Vercel's auto-injected URLs: VERCEL_URL, VERCEL_BRANCH_URL, VERCEL_PROJECT_PRODUCTION_URL
//     (these are hostnames without protocol — we prepend https:// before comparing)
//  3. Common local dev origins (vercel dev, vite, plain http servers)
//
// Defeats casual browser-based abuse from other sites. Curl/server-to-server requests
// with forged Origin headers can still hit the endpoint — for production-scale abuse
// protection, add a rate limiter (Upstash Redis / Vercel KV) keyed on req.headers
// ['x-forwarded-for'].

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8000',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
];

function buildAllowedOrigins() {
  const fromEnv = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((o) => o.trim()).filter(Boolean);

  const vercelHosts = [
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ].filter(Boolean);
  const vercelOrigins = vercelHosts.map((h) => `https://${h}`);

  return new Set([...fromEnv, ...vercelOrigins, ...DEFAULT_DEV_ORIGINS]);
}

export function isOriginAllowed(origin, host) {
  if (!origin) return false;
  const allowed = buildAllowedOrigins();
  if (allowed.has(origin)) return true;
  // Same-origin fallback: Origin host matches the request host (e.g. preview deploys).
  try { return new URL(origin).host === host; } catch { return false; }
}
