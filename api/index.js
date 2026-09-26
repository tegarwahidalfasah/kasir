// ===========================================================================
//  Vercel Serverless Function entry point for Kasir API (/api/*)
// ===========================================================================
import { createApp } from '../server/src/index.js';
import { firstRow } from '../server/src/db/index.js';
import { runSeed } from '../server/scripts/seed.js';
import { assertJwtSecret } from '../server/src/auth.js';

let cachedApp = null;

/**
 * Auto-seed HANYA dengan izin eksplisit (`KASIR_AUTOSEED=1`) dan tidak pernah di
 * NODE_ENV=production (docs/11 §10): data demo berisi kredensial publik
 * (`budi`/`rahasia123`, PIN 1111) sehingga URL preview yang bocor = toko milik siapa pun.
 *
 * Catatan penting: di Vercel `KASIR_DATA_DIR=/tmp` bersifat ephemeral & per-instance —
 * DB hilang setiap container didaur ulang dan dua instance punya data berbeda. Untuk
 * pencatatan keuangan, pakai VPS/container dengan volume persisten (ops/, docs/09).
 * Deployment ini hanya layak untuk demo/pratinjau UI.
 */
export function autoSeedAllowed(env = process.env) {
  if (env.KASIR_AUTOSEED !== '1') return false;
  if (env.NODE_ENV === 'production') return false;
  return true;
}

function getApp() {
  if (!cachedApp) {
    if (process.env.VERCEL) {
      console.warn(
        '[vercel] Mode demo: SQLite di /tmp (ephemeral, per-instance). ' +
        (autoSeedAllowed() ? 'Auto-seed AKTIF (KASIR_AUTOSEED=1).' : 'Auto-seed NONAKTIF.')
      );
    }
    assertJwtSecret();   // produksi tanpa KASIR_JWT_SECRET -> gagal, bukan sesi acak (docs/11 §10)
    if (autoSeedAllowed()) {
      try {
        const existing = firstRow(`SELECT COUNT(*) AS n FROM stores`);
        if (!existing || Number(existing.n) === 0) {
          runSeed({ quiet: true, auto: true });
        }
      } catch (err) {
        console.warn('[vercel] Auto-seed check:', err.message);
      }
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
