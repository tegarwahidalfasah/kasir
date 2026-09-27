import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client/sqlite3';
import { describe, it, assert, standalone } from './harness.js';
import { previewDemoConfig, setupPreviewDemo } from '../scripts/setup-preview-demo.js';

const preview = {
  VERCEL: '1', VERCEL_ENV: 'preview', NODE_ENV: 'production', KASIR_SETUP_DEMO: '1',
  TURSO_DATABASE_URL: 'libsql://demo.example', TURSO_AUTH_TOKEN: 'test-token-not-a-real-secret',
  KASIR_JWT_SECRET: 'test-jwt-secret-with-at-least-32-characters',
};

describe('setup demo lewat build Preview', () => {
  it('default build tidak membuka DB meskipun variabel DB tersedia', async () => {
    const env = { ...preview, KASIR_SETUP_DEMO: '' };
    const result = await setupPreviewDemo(env, { connect: () => { throw new Error('must not connect'); } });
    assert.deepEqual(result, { skipped: true });
    assert.equal(previewDemoConfig({ ...preview, KASIR_SETUP_DEMO: '0' }), null);
  });

  it('flag salah ditolak agar tidak mengira setup sudah berjalan', () => {
    assert.throws(() => previewDemoConfig({ ...preview, KASIR_SETUP_DEMO: 'true' }), /harus 1/);
  });

  it('Production, Development, lokal, dan env Vercel tidak lengkap ditolak', async () => {
    for (const overrides of [{ VERCEL_ENV: 'production' }, { VERCEL_ENV: 'development' }, { VERCEL_ENV: '' }, { VERCEL: '' }]) {
      let connected = false;
      await assert.rejects(setupPreviewDemo({ ...preview, ...overrides }, { connect: () => { connected = true; } }), /hanya diizinkan/);
      assert.equal(connected, false);
    }
  });

  it('Preview tetap NODE_ENV=production; konfigurasi dan JWT wajib lengkap', () => {
    assert.equal(previewDemoConfig(preview).url, preview.TURSO_DATABASE_URL);
    for (const overrides of [{ KASIR_JWT_SECRET: '' }, { KASIR_JWT_SECRET: 'short' }, { TURSO_AUTH_TOKEN: '' }, { TURSO_DATABASE_URL: '' }]) {
      assert.throws(() => previewDemoConfig({ ...preview, ...overrides }));
    }
  });

  it('setup memakai mode demo, menutup koneksi, dan tidak mencetak token DB/JWT', async () => {
    let closed = false;
    const logs = [];
    const client = { close: () => { closed = true; } };
    const result = await setupPreviewDemo(preview, {
      connect: config => { assert.equal(config.authToken, preview.TURSO_AUTH_TOKEN); return client; },
      initialize: async (actual, options) => { assert.equal(actual, client); assert.deepEqual(options, { demo: true }); return { initialized: true, version: 1 }; },
      log: message => logs.push(message),
    });
    assert.equal(result.initialized, true);
    assert.equal(closed, true);
    assert.ok(logs.join('\n').includes('Akun demo berhasil dibuat'));
    assert.ok(!logs.join('\n').includes(preview.TURSO_AUTH_TOKEN));
    assert.ok(!logs.join('\n').includes(preview.KASIR_JWT_SECRET));
  });

  it('build berikutnya tidak mengganti ID akun, password, atau menambah akun ganda', async () => {
    const client = createClient({ url: 'file::memory:' });
    const connect = () => ({
      transaction: (...args) => client.transaction(...args), close: () => {},
    });
    try {
      const first = await setupPreviewDemo(preview, { connect, log: () => {} });
      const before = (await client.execute("SELECT id, password_hash FROM users WHERE username='budi'")).rows[0];
      const second = await setupPreviewDemo(preview, { connect, log: () => {} });
      const after = (await client.execute("SELECT id, password_hash FROM users WHERE username='budi'")).rows[0];
      assert.equal(first.initialized, true);
      assert.equal(second.initialized, false);
      assert.equal(before.id, after.id);
      assert.equal(before.password_hash, after.password_hash);
      assert.equal((await client.execute('SELECT COUNT(*) AS n FROM users')).rows[0].n, 2);
    } finally { client.close(); }
  });

  it('kegagalan provisioning diteruskan dan koneksi tetap ditutup', async () => {
    let closed = false;
    await assert.rejects(setupPreviewDemo(preview, {
      connect: () => ({ close: () => { closed = true; } }),
      initialize: async () => { throw new Error('test failed setup'); }, log: () => {},
    }), /test failed setup/);
    assert.equal(closed, true);
  });

  it('entrypoint keluar nonzero saat flag dipasang di Production', () => {
    const run = spawnSync(process.execPath, ['server/scripts/setup-preview-demo.js'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, ...preview, VERCEL_ENV: 'production' }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /hanya diizinkan/);
    assert.ok(!run.stderr.includes(preview.TURSO_AUTH_TOKEN));
  });
});

await standalone(import.meta.url);
