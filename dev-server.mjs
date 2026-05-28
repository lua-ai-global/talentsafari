// Local dev server — serves static files + /api/* handlers (mirrors Vercel layout)
// Usage: npm run dev  →  http://localhost:3000

import express from 'express';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually (no dotenv dep needed — just parse key=value)
const envFile = join(__dirname, '.env');
if (existsSync(envFile)) {
  readFileSync(envFile, 'utf8')
    .split('\n')
    .forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx === -1) return;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    });
  console.log('[dev] .env loaded');
}

const app = express();
app.use(express.json());
app.use(express.text());

// Dynamically import and mount API handlers
const handlers = ['lua-chat', 'fetch-jd', 'slack-notify'];
for (const name of handlers) {
  try {
    const mod = await import(`./api/${name}.js`);
    app.all(`/api/${name}`, mod.default);
    console.log(`[dev] mounted /api/${name}`);
  } catch (e) {
    console.warn(`[dev] could not load api/${name}.js:`, e.message);
  }
}

// Serve static files
app.use(express.static(__dirname));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n✅  Running at http://localhost:${PORT}\n`);
});
