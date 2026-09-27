// ===========================================================================
//  Vercel Serverless Function entry point for Kasir API (/api/*)
// ===========================================================================
import { createApp } from '../server/src/index.js';
import { firstRow, IS_REMOTE } from '../server/src/db/index.js';
import { runSeed } from '../server/scripts/seed.js';
import { assertJwtSecret } from '../server/src/auth.js';

let cachedApp = null;

/** Auto-seed lama hanya untuk lokal. Database online diprovisi satu kali lewat
 * db:setup; jangan mengisi akun demo publik saat cold start atau saat DB gagal.
 */
export function autoSeedAllowed(env = process.env) {
  if (env.TURSO_DATABASE_URL || env.TURSO_AUTH_TOKEN || env.VERCEL) return false;
  if (env.KASIR_AUTOSEED !== '1') return false;
  if (env.NODE_ENV === 'production') return false;
  return true;
}

function getApp() {
  if (!cachedApp) {
    if (process.env.VERCEL) {
      console.warn(
        '[vercel] Database bersama: Turso. Auto-seed runtime NONAKTIF.'
      );
    }
    assertJwtSecret();   // produksi tanpa KASIR_JWT_SECRET -> gagal, bukan sesi acak (docs/11 §10)
    if (!IS_REMOTE && autoSeedAllowed()) {
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
