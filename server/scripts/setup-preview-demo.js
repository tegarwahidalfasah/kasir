// Jalur opt-in untuk demo dari dashboard Vercel saja. Bukan auto-seed runtime.
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client/http';
import { remoteConfig } from '../src/db/remote-config.js';
import { provision } from '../src/db/provision.js';

export function previewDemoConfig(env = process.env) {
  if (!env.KASIR_SETUP_DEMO || env.KASIR_SETUP_DEMO === '0') return null;
  if (env.KASIR_SETUP_DEMO !== '1') throw new Error('KASIR_SETUP_DEMO harus 1 untuk mengaktifkan setup demo Preview, atau hapus variabel ini.');
  if (env.VERCEL !== '1' || env.VERCEL_ENV !== 'preview') {
    throw new Error('KASIR_SETUP_DEMO hanya diizinkan pada build Vercel Preview. Hapus variabel dari scope Production/Development.');
  }
  if (!env.KASIR_JWT_SECRET || env.KASIR_JWT_SECRET.trim().length < 32) {
    throw new Error('Isi KASIR_JWT_SECRET minimal 32 karakter pada scope Preview sebelum setup demo.');
  }
  return remoteConfig(env);
}

export async function setupPreviewDemo(env = process.env, { connect = createClient, initialize = provision, log = console.log } = {}) {
  const config = previewDemoConfig(env);
  if (!config) return { skipped: true };
  log('[demo-setup] Menyiapkan DB Turso bersama. Gunakan database khusus demo dan aktifkan Deployment Protection.');
  const client = connect({ ...config, intMode: 'number', fetch: request => fetch(request, { signal: AbortSignal.timeout(15000) }) });
  try {
    const result = await initialize(client, { demo: true });
    log(result.initialized
      ? '[demo-setup] Akun demo berhasil dibuat. Login: budi / rahasia123; kasir dewi / PIN 4444.'
      : '[demo-setup] Database sudah berisi data; akun/password lama tidak diubah.');
    log('[demo-setup] Setelah berhasil, hapus KASIR_SETUP_DEMO dari Preview. Data tetap tersimpan di Turso.');
    return result;
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await setupPreviewDemo();
  } catch (err) {
    // SDK bisa memuat detail request. Jangan echo URL/token/parameter SQL.
    const message = err.code
      ? `Database gagal (${String(err.code).replace(/[^A-Z0-9_]/gi, '')}). Periksa URL/token Turso pada scope Preview.`
      : err.message;
    console.error('[demo-setup] ' + message);
    process.exitCode = 1; // build tidak diteruskan jika provisioning gagal
  }
}
