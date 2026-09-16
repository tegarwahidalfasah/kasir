// ===========================================================================
//  Smoke test UI (QA Fase 4):
//   • setiap halaman dirender memakai data asli server (tidak ada error JS)
//   • alur kasir nyata: klik barang → pratinjau bahan → bayar → struk → stok potong
//   • panel tema: ganti warna langsung memengaruhi CSS var & tersimpan ke server
//  Menjalankan seed + API pada pangkalan data sementara, jadi aman di CI.
//  Pemakaian: npm run test:ui  [-- --api=http://127.0.0.1:4100  (pakai server yang sudah hidup)]
// ===========================================================================
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(__dirname, '..');
const ROOT = path.resolve(CLIENT, '..');
const REUSE = process.argv.find((a) => a.startsWith('--api='))?.split('=')[1] || '';
const PORT = Number(process.env.PORT || 4399);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kasirui-'));
// bundel ditaruh di dalam repo agar `import 'jsdom'` (eksternal) teresolusi dari node_modules
const tmp = path.join(CLIENT, 'tests', '.cache');
fs.mkdirSync(tmp, { recursive: true });
const bundle = path.join(tmp, 'ui-smoke.entry.mjs');
let child = null;

const wait = (proc, marker, ms = 120000) => new Promise((resolve, reject) => {
  let buf = '';
  const started = Date.now();
  const tick = () => {
    if (buf.includes(marker)) return resolve(buf);
    if (proc.exitCode !== null) return reject(new Error(`proses keluar (code ${proc.exitCode})\n${buf}`));
    if (Date.now() - started > ms) return reject(new Error('waktu tunggu habis\n' + buf));
    setTimeout(tick, 60);
  };
  proc.stdout.on('data', (d) => { buf += d.toString(); });
  proc.stderr.on('data', (d) => { buf += d.toString(); });
  tick();
});

const cleanup = () => {
  try { child?.kill('SIGTERM'); } catch { }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!REUSE) { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { } }
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });

try {
  let api = REUSE;
  if (!REUSE) {
    const env = { ...process.env, KASIR_DATA_DIR: DATA_DIR, PORT: String(PORT), NODE_NO_WARNINGS: '1' };
    const seed = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server/scripts/seed.js'), '--force', '--quiet'], { env, cwd: ROOT });
    await wait(seed, 'KASIR_READY');
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server/src/index.js')], { env, cwd: ROOT });
    await wait(child, 'Kasir API', 60000);
    api = `http://127.0.0.1:${PORT}`;
  }

  await build({
    entryPoints: [path.join(CLIENT, 'tests/ui-smoke.entry.jsx')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    logLevel: 'warning',
    external: ['jsdom'],
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"development"', 'process.env.KASIR_API': JSON.stringify(api) },
  });

  await import(pathToFileURL(bundle).href);
  cleanup();
} catch (err) {
  console.error('\n❌ smoke UI gagal:', err.message);
  cleanup();
  process.exit(1);
}
