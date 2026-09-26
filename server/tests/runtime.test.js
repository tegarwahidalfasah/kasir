// ===========================================================================
//  Test pagar runtime produksi (docs/11 §10)
//
//  Data demo memuat kredensial yang dipublikasikan di README (budi/rahasia123,
//  PIN 1111). Karena itu: seed OTOMATIS dilarang di produksi, seed manual harus
//  disengaja, dan server menolak start tanpa KASIR_JWT_SECRET eksplisit.
// ===========================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, assert, standalone } from './harness.js';
import { autoSeedAllowed } from '../../api/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

/** Jalankan proses node sekali, kembalikan keluaran & exit code. */
function run(args, env = {}, { timeout = 25000 } = {}) {
  const logs = { out: '' };
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => { logs.out += d; });
  proc.stderr.on('data', (d) => { logs.out += d; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* noop */ } }, timeout);
    proc.once('exit', (code) => { clearTimeout(timer); resolve({ code, out: logs.out }); });
  });
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-runtime-'));

describe('pagar runtime produksi', () => {
  it('auto-seed hanya dengan KASIR_AUTOSEED=1 dan tidak pernah di produksi', () => {
    assert.equal(autoSeedAllowed({}), false, 'default: mati');
    assert.equal(autoSeedAllowed({ KASIR_AUTOSEED: '1' }), true, 'dev/staging: boleh bila diminta');
    assert.equal(autoSeedAllowed({ KASIR_AUTOSEED: '1', NODE_ENV: 'production' }), false, 'produksi: tetap dilarang');
    assert.equal(autoSeedAllowed({ NODE_ENV: 'production' }), false);
  });

  it('seed manual menolak berjalan di NODE_ENV=production (harus disengaja)', async () => {
    const { code, out } = await run(['server/scripts/seed.js'], { KASIR_DATA_DIR: tmpDir(), NODE_ENV: 'production' });
    assert.notEqual(code, 0, 'proses harus gagal, bukan diam-diam mengisi data demo');
    assert.match(out, /Menolak mengisi data demo/, out.slice(0, 300));
    assert.match(out, /KASIR_ALLOW_SEED=1/, 'pesan menunjukkan cara menyengajanya');
  });

  it('seed diizinkan di produksi hanya bila KASIR_ALLOW_SEED=1', async () => {
    const { code, out } = await run(['server/scripts/seed.js', '--quiet'], {
      KASIR_DATA_DIR: tmpDir(), NODE_ENV: 'production', KASIR_ALLOW_SEED: '1',
    });
    assert.equal(code, 0, `harus sukses: ${out.slice(-300)}`);
  });

  it('server menolak start di produksi tanpa KASIR_JWT_SECRET', async () => {
    const { code, out } = await run(['server/src/index.js'], { KASIR_DATA_DIR: tmpDir(), NODE_ENV: 'production', PORT: '4771' }, { timeout: 15000 });
    assert.notEqual(code, 0, 'harus gagal start');
    assert.match(out, /KASIR_JWT_SECRET wajib diisi/, out.slice(0, 400));
    assert.ok(!out.includes('Kasir API'), 'server tidak boleh sempat melayani');
  });

  it('server tetap start di produksi bila rahasianya diisi', async () => {
    const dir = tmpDir();
    await run(['server/scripts/seed.js', '--quiet'], { KASIR_DATA_DIR: dir, NODE_ENV: 'production', KASIR_ALLOW_SEED: '1' });
    const port = 4772 + Math.floor(Math.random() * 20);
    const logs = { out: '' };
    const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.js'], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'production', KASIR_JWT_SECRET: 'x'.repeat(64), KASIR_DATA_DIR: dir, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => { logs.out += d; });
    proc.stderr.on('data', (d) => { logs.out += d; });
    try {
      for (let i = 0; i < 100 && !logs.out.includes('Kasir API'); i += 1) await new Promise((r) => setTimeout(r, 50));
      assert.match(logs.out, /Kasir API/, `server harus start: ${logs.out.slice(0, 300)}`);
      const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
      const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'budi', password: 'rahasia123' }),
      }).then((r) => r.json());
      const token = login.token;
      assert.ok(token, `login produksi harus bekerja: ${JSON.stringify(login).slice(0, 200)}`);
      assert.equal(health.ok, true);
      // default-deny: path /api/* tak dikenal pun butuh token (401), bukan terbuka
      const anon = await fetch(`http://127.0.0.1:${port}/api/tidak-ada`);
      assert.equal(anon.status, 401, `path tak dikenal harus 401, dapat ${anon.status}`);
      const auth = await fetch(`http://127.0.0.1:${port}/api/tidak-ada`, { headers: { authorization: 'Bearer ' + token } });
      assert.equal(auth.status, 404, 'dengan token: 404 (bukan membocorkan stack)');
    } finally {
      proc.kill('SIGKILL');
      await new Promise((r) => { proc.once('exit', r); setTimeout(r, 2000); });
    }
  });

  it('boot produksi yang ditolak tidak meninggalkan berkas .jwt-secret acak', async () => {
    const dir = tmpDir();
    const { out } = await run(['server/src/index.js'], {
      KASIR_DATA_DIR: dir, NODE_ENV: 'production', PORT: '4790', KASIR_SECRET_FILE: path.join(dir, '.jwt-secret'),
    }, { timeout: 15000 });
    assert.match(out, /KASIR_JWT_SECRET/, 'pesan pagar muncul');
    assert.equal(fs.existsSync(path.join(dir, '.jwt-secret')), false,
      'tidak ada rahasia acak yang ditulis diam-diam saat produksi');
  });
});

await standalone(import.meta.url);
