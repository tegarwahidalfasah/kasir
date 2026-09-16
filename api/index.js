// ===========================================================================
//  Vercel Serverless Function entry point for Kasir API (/api/*)
// ===========================================================================
import { createApp } from '../server/src/index.js';
import { firstRow } from '../server/src/db/index.js';
import { runSeed } from '../server/scripts/seed.js';

let cachedApp = null;

function getApp() {
  if (!cachedApp) {
    try {
      const existing = firstRow(`SELECT COUNT(*) AS n FROM stores`);
      if (!existing || Number(existing.n) === 0) {
        runSeed({ quiet: true });
      }
    } catch (err) {
      console.warn('[vercel] Auto-seed check:', err.message);
    }
    cachedApp = createApp();
  }
  return cachedApp;
}

export default function handler(req, res) {
  if (req.url && !req.url.startsWith('/api')) {
    req.url = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }
  const app = getApp();
  return app(req, res);
}
