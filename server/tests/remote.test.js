// Integration: SDK HTTP asli -> endpoint Hrana fixture -> SQLite bersama.
// Tidak memakai kredensial nyata, tidak menghubungi database pengguna.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, assert, flush, standalone } from './harness.js';
import { remoteConfig } from '../src/db/remote-config.js';
import { createClient } from '@libsql/client/sqlite3';
import { provision } from '../src/db/provision.js';
import { buildSync } from 'esbuild';
import { verifyPassword } from '../src/passwords.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-remote-'));
const cert = path.join(dir, 'cert.pem');
const key = path.join(dir, 'key.pem');
const ssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { encoding: 'utf8' });
assert.equal(ssl.status, 0, 'openssl diperlukan untuk TLS fixture');
const fixture = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/tests/fixtures/hrana-server.mjs'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  env: { ...process.env, TEST_DB: path.join(dir, 'shared.db'), TEST_CERT: cert, TEST_KEY: key },
});
let fixtureError = '';
fixture.stderr.on('data', data => { fixtureError += data; });
process.on('exit', () => { fixture.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Hrana fixture startup timeout')), 10000);
  fixture.once('message', data => { clearTimeout(timer); resolve(data.port); });
  fixture.once('exit', () => { clearTimeout(timer); reject(new Error(fixtureError)); });
});
const env = {
  ...process.env, VERCEL: '', NODE_ENV: 'production', TURSO_DATABASE_URL: `https://127.0.0.1:${port}`,
  TURSO_AUTH_TOKEN: 'fixture-token', KASIR_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  NODE_EXTRA_CA_CERTS: cert, KASIR_AUTOSEED: '1',
};
const run = (source, extra = {}) => {
  const out = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', source], {
    cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8', timeout: 45000,
  });
  assert.equal(out.status, 0, out.stderr || out.error?.message || out.stdout);
  return out.stdout.trim() ? JSON.parse(out.stdout.trim().split('\n').at(-1)) : null;
};
const runAsync = (source, extra = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', source], {
    cwd: ROOT, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  const timeout = setTimeout(() => child.kill('SIGKILL'), 45000);
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.once('exit', code => {
    clearTimeout(timeout);
    if (code !== 0) return reject(new Error(stderr || 'child failed'));
    try { resolve(stdout.trim() ? JSON.parse(stdout.trim().split('\n').at(-1)) : null); }
    catch (err) { reject(err); }
  });
});
const apiHarness = `
  import assert from 'node:assert/strict';
  import {createApp} from './server/src/index.js';
  import {db} from './server/src/db/index.js';
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = async (path, body, token = process.env.TEST_TOKEN) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api' + path, {
      method: body ? 'POST' : 'GET', headers: {'content-type':'application/json', ...(token ? {authorization:'Bearer '+token} : {})},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return {status:response.status, data:text ? JSON.parse(text) : null};
  };
`;
const finish = 'db.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));';
let token, userId;

describe('database bersama / Turso', () => {
  it('konfigurasi gagal tertutup: tidak ada fallback /tmp, URL tidak aman ditolak', () => {
    assert.equal(remoteConfig({}), null);
    for (const input of [{VERCEL:'1'}, {TURSO_AUTH_TOKEN:'x'}, {TURSO_DATABASE_URL:'libsql://example.turso.io'}, {TURSO_DATABASE_URL:'file:local.db',TURSO_AUTH_TOKEN:'x'}, {TURSO_DATABASE_URL:'http://example.com',TURSO_AUTH_TOKEN:'x'}, {TURSO_DATABASE_URL:'https://user:pass@example.com',TURSO_AUTH_TOKEN:'x'}]) {
      assert.throws(() => remoteConfig(input));
    }
    assert.equal(remoteConfig({TURSO_DATABASE_URL:'libsql://example.turso.io',TURSO_AUTH_TOKEN:'x'}).authToken, 'x');
  });

  it('setup demo melalui SDK HTTP; pengulangan tidak mengganti ID/password', () => {
    const result = run(`
      import {createClient} from '@libsql/client/http';
      import {provision} from './server/src/db/provision.js';
      const client = createClient({url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN});
      const a = await provision(client, {demo:true});
      const before = (await client.execute("SELECT id, password_hash FROM users WHERE username='budi'")).rows[0];
      const b = await provision(client, {demo:true});
      const after = (await client.execute("SELECT id, password_hash FROM users WHERE username='budi'")).rows[0];
      client.close(); console.log(JSON.stringify({a,b,same:before.id===after.id && before.password_hash===after.password_hash}));
    `);
    assert.equal(result.a.initialized, true);
    assert.equal(result.b.initialized, false);
    assert.equal(result.same, true);
  });

  it('provision owner pribadi tanpa akun demo; rollback bila batch gagal', async () => {
    const db = createClient({url:'file::memory:'});
    try {
      await assert.rejects(provision(db, {owner:true,ownerUsername:'owner',ownerPassword:'short'}), /12 karakter/);
      const ownerPassword = 'test-only-personal-password';
      await provision(db, {owner:true,ownerUsername:'owner',ownerPassword});
      const users = (await db.execute('SELECT * FROM users')).rows;
      assert.equal(users.length, 1);
      assert.equal(users[0].username, 'owner');
      assert.equal(users[0].pin, null);
      assert.ok(verifyPassword(ownerPassword, users[0].password_hash));
    } finally { db.close(); }
    const broken = createClient({url:'file::memory:'});
    try {
      await provision(broken);
      await broken.execute("CREATE TRIGGER reject_user BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT, 'test failure'); END");
      await assert.rejects(provision(broken, {demo:true}), /test failure/);
      assert.equal((await broken.execute('SELECT COUNT(*) AS n FROM stores')).rows[0].n, 0);
    } finally { broken.close(); }
  });

  it('login pada instance A dengan worker HTTP asli', () => {
    const result = run(apiHarness + `
      const health = await request('/health'); assert.equal(health.status,200); assert.equal(health.data.database,'turso');
      const login = await request('/auth/login',{username:'budi',password:'rahasia123'});
      assert.equal(login.status,200); console.log(JSON.stringify(login.data));
    ` + finish);
    token = result.token; userId = result.user.id;
    assert.ok(token);
  });

  it('token tetap berlaku di instance B dan restart; polling, bukan SSE', () => {
    for (let i = 0; i < 2; i++) {
      const result = run(apiHarness + `
        const boot = await request('/bootstrap'); assert.equal(boot.status,200); assert.equal(boot.data.stock_transport,'poll');
        const lite = await request('/bootstrap/lite'); assert.equal(lite.status,200);
        assert.equal((await request('/events')).status,204);
        assert.equal((await request('/admin/backup')).status,409);
        console.log(JSON.stringify({id:boot.data.user.id,items:boot.data.catalog.length}));
      ` + finish, {TEST_TOKEN:token});
      assert.equal(result.id, userId);
      assert.equal(result.items, 3);
    }
  });

  it('COMMIT dan ROLLBACK menjaga stok dan event; constraint FK tetap berlaku', () => {
    run(`
      import assert from 'node:assert/strict';
      import {db,tx,firstRow,exec} from './server/src/db/index.js';
      import {publish,subscribe} from './server/src/events.js';
      const item=firstRow("SELECT * FROM items WHERE name='Biji kopi'");
      let events=0; const stop=subscribe(item.store_id,()=>events++);
      assert.throws(()=>tx(()=>{exec('UPDATE items SET stock_qty=stock_qty-1 WHERE id=?',item.id); publish(item.store_id,{type:'stock'}); throw new Error('rollback');}),/rollback/);
      assert.equal(firstRow('SELECT stock_qty FROM items WHERE id=?',item.id).stock_qty,item.stock_qty); assert.equal(events,0);
      tx(()=>{exec('UPDATE items SET stock_qty=stock_qty-1 WHERE id=?',item.id);publish(item.store_id,{type:'stock'});});
      assert.equal(firstRow('SELECT stock_qty FROM items WHERE id=?',item.id).stock_qty,item.stock_qty-1); assert.equal(events,1);
      tx(()=>exec('UPDATE items SET stock_qty=? WHERE id=?',item.stock_qty,item.id));
      assert.throws(()=>tx(()=>exec("INSERT INTO branches (id,store_id,name) VALUES ('bad','missing','bad')")),/FOREIGN KEY/i);
      assert.equal(firstRow("SELECT COUNT(*) AS n FROM branches WHERE id='bad'").n,0);
      stop(); db.close();
    `);
  });

  it('penjualan memotong BOM dan tersimpan di instance lain; void mengembalikan stok', () => {
    const sale = run(apiHarness + `
      const boot=(await request('/bootstrap')).data;
      const product=boot.catalog.find(i=>i.name==='Americano');
      const body={lines:[{item_id:product.id,qty:1}],payment_method_id:boot.payment_methods[0].id,paid_amount:50000,external_ref:'remote-test-sale'};
      const sale=await request('/sales',body); assert.equal(sale.status,201,JSON.stringify(sale.data));
      assert.equal((await request('/sales',body)).data.duplicated,true);
      console.log(JSON.stringify({id:sale.data.id}));
    ` + finish, {TEST_TOKEN:token});
    run(apiHarness + `
      import {firstRow} from './server/src/db/index.js';
      assert.equal(firstRow("SELECT stock_qty FROM items WHERE name='Biji kopi'").stock_qty,982);
      assert.equal((await request('/sales/'+process.env.SALE_ID)).status,200);
      assert.equal((await request('/sales/'+process.env.SALE_ID+'/void',{reason:'test'})).status,200);
      assert.equal(firstRow("SELECT stock_qty FROM items WHERE name='Biji kopi'").stock_qty,1000);
    ` + finish, {TEST_TOKEN:token, SALE_ID:sale.id});
  });

  it('dua penjualan paralel dari proses berbeda tidak kehilangan potongan stok', async () => {
    const code = apiHarness + `
      const boot=(await request('/bootstrap')).data;
      const product=boot.catalog.find(i=>i.name==='Americano');
      const sale=await request('/sales',{lines:[{item_id:product.id,qty:1}],payment_method_id:boot.payment_methods[0].id,paid_amount:50000,external_ref:process.env.REFERENCE});
      assert.equal(sale.status,201,JSON.stringify(sale.data)); console.log(JSON.stringify({id:sale.data.id,invoice:sale.data.invoice_no}));
    ` + finish;
    const sales = await Promise.all(['parallel-a','parallel-b'].map(REFERENCE => runAsync(code, {REFERENCE,TEST_TOKEN:token})));
    assert.notEqual(sales[0].invoice,sales[1].invoice);
    run(apiHarness + `
      import {firstRow} from './server/src/db/index.js';
      assert.equal(firstRow("SELECT stock_qty FROM items WHERE name='Biji kopi'").stock_qty,964);
      assert.equal(firstRow("SELECT stock_qty FROM items WHERE name='Gelas'").stock_qty,98);
      for (const id of JSON.parse(process.env.SALE_IDS)) assert.equal((await request('/sales/'+id+'/void',{reason:'parallel test'})).status,200);
      assert.equal(firstRow("SELECT stock_qty FROM items WHERE name='Biji kopi'").stock_qty,1000);
    ` + finish, {TEST_TOKEN:token,SALE_IDS:JSON.stringify(sales.map(s=>s.id))});
  });

  it('bundle worker untuk Vercel dapat dijalankan dan tidak auto-seed', () => {
    buildSync({entryPoints:[path.join(ROOT,'server/src/db/libsql-worker.js')],bundle:true,platform:'node',format:'cjs',outfile:path.join(ROOT,'server/src/db/libsql-worker.bundle.cjs')});
    run(`
      import assert from 'node:assert/strict';
      import {autoSeedAllowed} from './api/index.js';
      import {db,firstRow} from './server/src/db/index.js';
      assert.equal(autoSeedAllowed({VERCEL:'1',KASIR_AUTOSEED:'1',NODE_ENV:'development'}),false);
      assert.equal(autoSeedAllowed({TURSO_DATABASE_URL:'libsql://db',KASIR_AUTOSEED:'1'}),false);
      assert.equal(firstRow('SELECT COUNT(*) AS n FROM users').n,2); db.close();
    `, {VERCEL:'1'});
  });

  it('timeout dibatasi, tidak replay query, worker rusak dibuang', () => {
    const worker = path.join(dir, 'silent-worker.mjs');
    fs.writeFileSync(worker, "import {workerData} from 'node:worker_threads'; workerData.port.on('message',()=>{});");
    run(`
      import assert from 'node:assert/strict';
      import {pathToFileURL} from 'node:url';
      import {LibsqlSync} from './server/src/db/libsql-sync.js';
      const db=new LibsqlSync({}, {timeoutMs:150,workerUrl:pathToFileURL(process.env.SILENT_WORKER)});
      const started=Date.now();
      assert.throws(()=>db.prepare('SELECT 1').get(),{code:'REMOTE_TIMEOUT'});
      assert.ok(Date.now()-started<3000);assert.equal(db.worker,null); db.close();
    `, {SILENT_WORKER:worker});
  });

  it('token Turso salah dan secret JWT hilang ditolak, bukan fallback lokal', () => {
    const result = spawnSync(process.execPath, ['--input-type=module','-e',"await import('./server/src/db/index.js')"], {cwd:ROOT,env:{...env,TURSO_AUTH_TOKEN:'wrong'},encoding:'utf8',timeout:20000});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/Database Turso belum siap/);
    run(`
      import assert from 'node:assert/strict';
      import {assertJwtSecret} from './server/src/auth.js';
      import {db} from './server/src/db/index.js';
      assert.throws(()=>assertJwtSecret({TURSO_DATABASE_URL:'libsql://db',NODE_ENV:'development'}),/KASIR_JWT_SECRET/);
      db.close();
    `);
  });
});

await flush();
fixture.kill('SIGTERM');
await standalone(import.meta.url);
