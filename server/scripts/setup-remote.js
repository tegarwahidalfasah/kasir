// Jalankan dari komputer operator, bukan Build Command atau endpoint publik.
import { createClient } from '@libsql/client/http';
import { remoteConfig } from '../src/db/remote-config.js';
import { provision } from '../src/db/provision.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('npm run db:setup -- [--demo | --owner]\nTanpa flag: hanya skema/migrasi. --demo: akun publik untuk demo privat. --owner: akun pribadi dari KASIR_OWNER_USERNAME/PASSWORD.');
} else {
  let client;
  try {
    if (args.some(arg => !['--demo', '--owner'].includes(arg))) throw new Error('Opsi tidak dikenal. Gunakan --help.');
    const config = remoteConfig();
    if (!config) throw new Error('Isi TURSO_DATABASE_URL dan TURSO_AUTH_TOKEN di .env lokal atau environment terminal.');
    client = createClient({ ...config, intMode: 'number' });
    const result = await provision(client, {
      demo: args.includes('--demo'), owner: args.includes('--owner'),
      ownerUsername: process.env.KASIR_OWNER_USERNAME, ownerPassword: process.env.KASIR_OWNER_PASSWORD,
      storeName: process.env.KASIR_STORE_NAME,
    });
    console.log(`Skema online siap (versi ${result.version}).`);
    if (result.initialized) console.log('Toko dan akun awal berhasil dibuat satu kali.');
    else if (args.length) console.log('Data sudah ada; akun/password lama tidak diubah.');
    if (result.initialized && args.includes('--demo')) console.warn('DEMO PRIVAT: budi / rahasia123, dewi / PIN 4444. Lindungi deployment; jangan gunakan akun ini untuk toko sungguhan.');
  } catch (err) {
    // Jangan echo SDK request/URL/header yang mungkin mengandung kredensial.
    const safe = err.code ? `Database gagal (${String(err.code).replace(/[^A-Z0-9_]/gi, '')}). Periksa koneksi/token dan konfigurasi.` : err.message;
    console.error(safe);
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}
