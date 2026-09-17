// ===========================================================================
//  Test integrasi API (Fase 4 QA) — menyalakan server sungguhan di DB terpisah,
//  lalu menguji login, RBAC, transaksi, pemotongan stok, alert, laporan, CSV.
// ===========================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, assert, standalone } from './harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 4780 + Math.floor(Math.random() * 60);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-api-test-'));

let child = null;
let child2 = null;   // server kedua (KASIR_TRUST_PROXY=false) untuk tes pembatas login
const token = {};

async function req(p, { method = 'GET', body, as = 'owner', raw = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token[as]) headers.authorization = 'Bearer ' + token[as];
  const res = await fetch(BASE + '/api' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (raw) return { status: res.status, text, headers: res.headers };
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const must = async (p, opts) => {
  const r = await req(p, opts);
  assert.ok(r.status < 400, `${p} -> ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tunggu proses anak selesai (atau timeout) tanpa menambah jeda bila sudah exit. */
function waitExit(proc, ms = 4000) {
  if (proc.exitCode !== null || proc.killed) return Promise.resolve();
  return new Promise((r) => {
    const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* noop */ } r(); }, ms);
    proc.once('exit', () => { clearTimeout(t); r(); });
  });
}

async function spawnAndWait(args, marker, opts = {}) {
  const logs = { out: '' };
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], {
    cwd: ROOT,
    env: { ...process.env, KASIR_DATA_DIR: dataDir, ...(opts.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
    env: { ...process.env, KASIR_DATA_DIR: dataDir, ...(opts.env || {}) },
  });
  proc.stdout.on('data', (d) => { logs.out += d; });
  proc.stderr.on('data', (d) => { logs.out += d; });
  for (let i = 0; i < (opts.ticks || 200); i += 1) {
    if (logs.out.includes(marker)) return { proc, logs: logs.out };
    if (proc.exitCode !== null && i > 6) break;
    if (proc.exitCode !== null && !logs.out.includes(marker)) {
      throw new Error(`proses ${args[0]} keluar (${proc.exitCode}):\n` + logs.out.slice(-2500));
    }
    await sleep(150);
  }
  try { proc.kill('SIGKILL'); } catch { /* noop */ }
  throw new Error('timeout menunggu "' + marker + '"\n' + logs.out.slice(-2500));
}

async function boot() {
  // seed di proses anak (script memanggil process.exit) -> DB tes terisi, tanpa race port
  const { proc } = await spawnAndWait([path.join(ROOT, 'scripts', 'seed.js'), '--quiet', '--force'], 'KASIR_READY', { ticks: 400 });
  await waitExit(proc);
  const srv = await spawnAndWait([path.join(ROOT, 'src', 'index.js')], 'Kasir API', {
    env: { ...process.env, KASIR_DATA_DIR: dataDir, PORT: String(PORT) }, ticks: 150,
  });
  child = srv.proc;
}

// boot harus selesai sebelum tes lain menembak endpoint (semua it di-queue sinkron)
await boot();
assert.ok(fs.existsSync(path.join(dataDir, 'kasir.db')), 'DB tes terbentuk');

describe('api', () => {

  it('login menyimpan token per role', async () => {
    for (const [key, u] of Object.entries({ owner: 'budi', cashier: 'dewi', inventory: 'sari', manager: 'rina' })) {
      const r = await req('/auth/login', { method: 'POST', body: { username: u, password: 'rahasia123' } });
      assert.equal(r.status, 200, u + ' gagal login');
      token[key] = r.data.token;
    }
    assert.ok(token.owner && token.cashier);
  });

  it('login password salah -> 401, dan PIN kasir bisa dipakai', async () => {
    const bad = await req('/auth/login', { method: 'POST', body: { username: 'budi', password: 'salah' } });
    assert.equal(bad.status, 401);
    const pin = await req('/auth/login', { method: 'POST', body: { username: 'dewi', password: '4444' } });
    assert.equal(pin.status, 200);
  });

  it('endpoint tanpa token -> 401', async () => {
    const r = await req('/bootstrap', { as: null });
    assert.equal(r.status, 401);
  });

  it('bootstrap mengirim katalog, BOM, tema, menu, dan permission', async () => {
    const b = await must('/bootstrap');
    assert.ok(b.catalog.length >= 15, 'katalog demo ada');
    assert.ok(Object.keys(b.bom).length >= 5, 'beberapa item punya resep');
    assert.ok(b.settings.theme.menu.length >= 8, 'menu modular terkirim');
    assert.ok(b.settings.receipt.paper_width, 'layout struk terkirim');
    assert.equal(b.permissions.includes('*'), true, 'owner = akses penuh');
    assert.ok(b.payment_methods.some((m) => m.kind === 'qris'));
    const c = await must('/bootstrap', { as: 'cashier' });
    assert.equal(c.permissions.includes('*'), false);
    assert.equal(c.permissions.includes('sale.create'), true);
    assert.equal(c.permissions.includes('setting.tax'), false);
  });

  it('POS: preview lalu simpan transaksi; stok bahan berkurang tepat', async () => {
    const cat = await must('/pos/catalog', { as: 'cashier' });
    const kopi = cat.finished.find((i) => i.name.startsWith('Kopi Susu Gula'));
    assert.ok(kopi.recipe.length >= 4, 'item demo punya beberapa bahan');
    const rawBefore = Object.fromEntries(cat.raw.map((r) => [r.id, r.stock_qty]));
    const capBefore = kopi.capacity;

    const prev = await must('/pos/preview', { method: 'POST', as: 'cashier', body: { lines: [{ item_id: kopi.id, qty: 2 }] } });
    assert.ok(prev.pricing.grand_total > 0);
    assert.equal(prev.stock_impact.raw.length, kopi.recipe.length, 'semua bahan muncul di dampak stok');

    const sale = await must('/sales', { method: 'POST', as: 'cashier', body: {
      lines: [{ item_id: kopi.id, qty: 2 }], payment_method_id: null, paid_amount: prev.pricing.grand_total + 20000,
      external_ref: 'test-' + Date.now(),
    } });
    assert.equal(sale.movements.length >= 4, true, 'terdapat >= 4 gerakan stok');
    assert.equal(sale.change_amount > 0, true, 'kembalian dihitung');

    const cat2 = await must('/pos/catalog', { as: 'cashier' });
    for (const m of sale.movements.filter((x) => x.type === 'bom_consume')) {
      const d = Math.round((rawBefore[m.item_id] - cat2.raw.find((r) => r.id === m.item_id).stock_qty) * 1000) / 1000;
      assert.equal(d, Math.abs(m.qty), `konsumsi ${m.name} cocok dengan struk (${d} vs ${Math.abs(m.qty)})`);
    }
    assert.ok(cat2.finished.find((i) => i.id === kopi.id).capacity < capBefore, 'kapasitas porsi ikut turun');
  });

  it('idempoten: external_ref sama tidak membuat transaksi kedua', async () => {
    const cat = await must('/pos/catalog');
    const it1 = cat.finished[0];
    const ref = 'idem-' + Date.now();
    const a = await must('/sales', { method: 'POST', body: { lines: [{ item_id: it1.id, qty: 1 }], external_ref: ref } });
    const b = await must('/sales', { method: 'POST', body: { lines: [{ item_id: it1.id, qty: 1 }], external_ref: ref } });
    assert.equal(b.duplicated, true);
    assert.equal(a.id, b.id, 'transaksi yang sama dikembalikan');
  });

  it('void mengembalikan seluruh stok', async () => {
    const cat = await must('/pos/catalog');
    const kopi = cat.finished.find((i) => i.name.startsWith('Kopi Susu Gula'));
    const before = Object.fromEntries(cat.raw.map((r) => [r.id, r.stock_qty]));
    const sale = await must('/sales', { method: 'POST', body: { lines: [{ item_id: kopi.id, qty: 3 }] } });
    const v = await must(`/sales/${sale.id}/void`, { method: 'POST', body: { reason: 'uji' } });
    assert.equal(v.status, 'voided');
    const cat2 = await must('/pos/catalog');
    for (const m of sale.movements.filter((x) => x.type === 'bom_consume')) {
      assert.equal(Math.abs(cat2.raw.find((r) => r.id === m.item_id).stock_qty - before[m.item_id]) < 1e-6, true, `stok ${m.name} pulih`);
    }
  });

  it('kasir dibloki mengubah setting/pajak/user (RBAC), manajer boleh', async () => {
    const denied = await req('/settings/tax', { method: 'PUT', as: 'cashier', body: { default_rate_pct: 0 } });
    assert.equal(denied.status, 403, 'kasir tidak boleh ubah pajak');
    const denied2 = await req('/users', { method: 'POST', as: 'cashier', body: { username: 'x', password: 'yyy', display_name: 'X', role: 'admin' } });
    assert.equal(denied2.status, 403);
    const denied3 = await req('/roles/cashier', { method: 'PUT', as: 'manager', body: { permissions: ['*'] } });
    assert.equal(denied3.status, 403, 'manajer tidak boleh mengatur role');
    const ok = await must('/settings/tax', { method: 'PUT', body: { default_rate_pct: 11, enabled: true } });
    assert.equal(ok.value.default_rate_pct, 11);
    assert.equal((await req('/items', { method: 'POST', as: 'inventory', body: { name: 'Bahan Uji API', item_type: 'raw', unit: 'gr', cost_price: 100, opening_stock: 500 } })).status, 201);
    assert.equal((await req('/items', { method: 'POST', as: 'cashier', body: { name: 'x' } })).status, 403, 'kasir tidak boleh menambah barang');
  });

  it('CRUD item + resep BOM lewat API', async () => {
    // netralkan aturan diskon otomatis agar angka tes deterministik
    for (const d of await must('/discounts')) {
      if (d.trigger !== 'manual') await must(`/discounts/${d.id}`, { method: 'PUT', body: { is_active: 0 } });
    }
    await must('/settings/tax', { method: 'PUT', body: { enabled: false, rounding_mode: 'none', service_charge_pct: 0 } });
    const raw = await must('/items', { method: 'POST', body: { name: 'Biji Uji API-2', item_type: 'raw', unit: 'gr', cost_price: 900, opening_stock: 1000 } });
    const fin = await must('/items', { method: 'POST', body: { name: 'Kopi Uji API-2', item_type: 'finished', selling_price: 22000, production_mode: 'make_to_order', tax_mode: 'exempt' } });
    await must(`/items/${fin.id}/recipe`, { method: 'PUT', body: { recipe: [{ raw_item_id: raw.id, qty: 20, waste_pct: 5 }] } });
    const detail = await must(`/items/${fin.id}`);
    assert.equal(detail.recipe.length, 1);
    assert.ok(Math.abs(detail.cost_price - 20 * 900 * 1.05) < 1, 'HPP tersinkron dari bahan: ' + detail.cost_price);
    const sim = await must(`/items/${fin.id}/simulate`, { method: 'POST', body: { qty: 3 } });
    assert.equal(Math.round(sim.deduct_raw[0].qty * 100) / 100, 63, '3 porsi x 20gr x 1.05');
    const sale = await must('/sales', { method: 'POST', body: { lines: [{ item_id: fin.id, qty: 3 }] } });
    assert.equal(sale.tax_total, 0, `item exempt pajak tidak menambah PPn (dapat ${sale.tax_total})`);
    assert.equal(sale.subtotal, 66000, 'subtotal = harga x qty');
    assert.equal(sale.discount_total, 0);
    assert.equal(sale.grand_total, 66000, `total = ${sale.grand_total}`);
    assert.equal(Math.round(sale.movements.find((m) => m.item_id === raw.id).qty * 100) / 100, -63);
    await must(`/items/${fin.id}`, { method: 'DELETE' });
    assert.equal((await must(`/items/${fin.id}`)).is_active, 0, 'item dengan transaksi dilunakkan, tidak dihapus');
  });

  it('pembelian bahan baku menaikkan stok lewat PO receive', async () => {
    const raws = (await must('/pos/catalog')).raw;
    const target = raws[0];
    const po = await must('/purchase-orders', { method: 'POST', as: 'inventory', body: {
      supplier_name: 'Uji', items: [{ raw_item_id: target.id, qty_ordered: 500, unit_cost: target.cost_price || 100 }], status: 'ordered',
    } });
    const full = await must(`/purchase-orders/${po.id}`);
    const before = (await must('/pos/catalog')).raw.find((r) => r.id === target.id).stock_qty;
    await must(`/purchase-orders/${po.id}/receive`, { method: 'POST', as: 'inventory' });
    const after = (await must('/pos/catalog')).raw.find((r) => r.id === target.id).stock_qty;
    assert.equal(Math.round((after - before) * 1000) / 1000, 500, 'stok naik persis qty diterima');
    assert.equal((await must(`/purchase-orders/${po.id}`)).status, 'received');
  });

  it('stock opname & rekonsiliasi & integritas ledger', async () => {
    const cat = await must('/pos/catalog', { as: 'inventory' });
    const target = cat.raw[1];
    await must('/stock/adjust', { method: 'POST', as: 'inventory', body: { items: [{ item_id: target.id, counted_qty: Math.max(0, Math.round((target.stock_qty || 100) - 3)) }], reason: 'opname API test' } });
    const after = (await must('/pos/catalog')).raw.find((r) => r.id === target.id).stock_qty;
    assert.equal(Math.round(after * 1000) / 1000, Math.max(0, Math.round((target.stock_qty || 100) - 3)));
    const ig = await must('/stock/integrity');
    assert.equal(ig.mismatches.length, 0, 'ledger utuh: ' + JSON.stringify(ig.mismatches).slice(0, 200));
  });

  it('alert low-stock & rekomendasi pembelian', async () => {
    const al = await must('/alerts');
    assert.ok(Array.isArray(al.items));
    const rep = await must('/alerts/replenish');
    assert.ok(Array.isArray(rep.items));
    assert.equal(typeof rep.total_est_cost, 'number');
  });

  it('kustomisasi: tema, menu, layout struk tersimpan & dibaca lagi', async () => {
    const theme = { app_name: 'Kopi Uji', accent: '#123456', radius: 20, mode: 'dark', menu: [
      { key: 'pos', label: 'Kasir Saya', icon: '🧾', visible: true, perm: 'sale.create' },
      { key: 'reports', label: 'Laporan Toko', icon: '📈', visible: true, perm: 'report.view' },
    ] };
    await must('/settings/theme', { method: 'PUT', body: theme });
    const read = await must('/settings');
    assert.equal(read.theme.accent, '#123456');
    assert.equal(read.theme.menu.length, 2);
    assert.equal(read.theme.menu[0].label, 'Kasir Saya');
    const brand = await must('/branding/brand');
    assert.equal(brand.theme.mode, 'dark');
    const pub = await must('/public/brand');
    assert.equal(pub.theme.app_name, 'Kopi Uji', 'logo/nama dipakai juga di layar login');
    await must('/settings/theme', { method: 'PUT', body: { menu: null } });
    const back = await must('/settings');
    assert.ok(Array.isArray(back.theme.menu) && back.theme.menu.length >= 1);
  });

  it('pajak & diskon dinamis memengaruhi transaksi berikutnya', async () => {
    await must('/settings/tax', { method: 'PUT', body: { enabled: true, default_rate_pct: 5, rounding_mode: 'none', service_charge_pct: 0 } });
    const cat = await must('/pos/catalog');
    const item = cat.finished.find((i) => i.tax_mode !== 'exempt' && i.item_type === 'finished') || cat.finished[0];
    const sale = await must('/sales', { method: 'POST', body: { lines: [{ item_id: item.id, qty: 1 }] } });
    assert.ok(sale.tax_total > 0, 'pajak 5% masuk ke struk');
    const d = await must('/discounts', { method: 'POST', body: { name: 'Kupon API 50rb', kind: 'fixed', value: 50000, trigger: 'manual', applies_to: 'global' } });
    const sale2 = await must('/sales', { method: 'POST', body: { lines: [{ item_id: item.id, qty: 3 }], selected_discount_ids: [d.id] } });
    assert.ok(sale2.discount_total >= 50000, 'diskon manual terpakai: ' + sale2.discount_total);
    await must(`/discounts/${d.id}`, { method: 'DELETE' });
    const after = await must('/discounts');
    assert.equal(after.find((x) => x.id === d.id), undefined);
  });

  it('laporan: ringkasan, pemakaian bahan, valuasi stok, CSV', async () => {
    const sum = await must('/reports/summary');
    assert.ok(sum.totals.tx_count > 0);
    assert.ok(Array.isArray(sum.by_day) && sum.by_day.length > 1, 'tren harian ada');
    assert.ok(sum.by_item.length > 0 && sum.by_payment.length > 0 && sum.by_cashier.length > 0);
    const rawUse = await must('/reports/raw-usage');
    assert.ok(rawUse.items.length > 0);
    const valuation = await must('/reports/inventory-valuation');
    assert.ok(valuation.total_cost > 0);
    for (const kind of ['sales', 'movements', 'stock']) {
      const csv = await req(`/reports/export/${kind}`, { raw: true });
      assert.equal(csv.status, 200, kind + ' export');
      assert.ok(/text\/csv/.test(csv.headers.get('content-type')), 'tipe CSV');
      assert.ok(csv.text.split('\n').length > 2, 'isi CSV ' + kind);
    }
  });

  it('manajemen user: kasir tidak bisa bikin admin; owner bisa', async () => {
    const uname = 'uji' + Date.now();
    const denied = await req('/users', { method: 'POST', as: 'cashier', body: { username: uname, password: 'pass1234', display_name: 'Uji', role: 'admin' } });
    assert.equal(denied.status, 403);
    const ok = await must('/users', { method: 'POST', body: { username: uname, password: 'pass1234', display_name: 'Uji Manajer', role: 'manager' } });
    assert.ok(ok.id);
    const canLogin = await req('/auth/login', { method: 'POST', body: { username: uname, password: 'pass1234' } });
    assert.equal(canLogin.status, 200, 'user baru bisa langsung login');
    const list = await must('/users');
    assert.ok(list.some((u) => u.username === uname));
    await must(`/users/${ok.id}`, { method: 'DELETE' });
  });

  it('health & openapi tersedia', async () => {
    const h = await must('/health');
    assert.equal(h.ok, true);
    assert.ok(h.items > 0 && h.sales > 0 && h.movements > 0, 'health melaporkan jumlah baris: ' + JSON.stringify(h));
    const spec = await must('/openapi.json');
    assert.ok(Object.keys(spec.paths).length > 25, 'endpoint terdokumentasi otomatis');
  });

  it('simulasi transaksi massal: puluhan order beruntun, stok & ledger tetap akurat', async () => {
    const cat = await must('/pos/catalog');
    const kopi = cat.finished.find((i) => i.name.startsWith('Kopi Susu Gula'));
    const perPortion = {};
    for (const r of kopi.recipe) perPortion[r.raw_item_id] = Math.round(r.qty * (1 + (r.waste_pct || 0) / 100) * 1000) / 1000;
    const raw0 = Object.fromEntries(cat.raw.map((r) => [r.id, r.stock_qty]));
    const N = 60;
    const ids = [];
    for (let i = 0; i < N; i += 1) {
      const qty = 1 + (i % 3);
      const r = await req('/sales', { method: 'POST', as: 'cashier', body: { lines: [{ item_id: kopi.id, qty }], skip_alerts: true } });
      if (r.status === 201) ids.push({ id: r.data.id, qty });
    }
    const sold = ids.reduce((s, x) => s + x.qty, 0);
    const cat2 = await must('/pos/catalog');
    for (const [id, per] of Object.entries(perPortion)) {
      const before = raw0[id] ?? 0;
      const after = cat2.raw.find((r) => r.id === id)?.stock_qty ?? 0;
      const expected = Math.max(0, before - per * sold);
      const ok = Math.abs(after - expected) < 0.05 || after <= 0.001;
      assert.ok(ok, `bahan ${id}: ${after} seharusnya ${expected} (terjual ${sold} porsi)`);
    }
    const ig = await must('/stock/integrity');
    assert.equal(ig.mismatches.length, 0, 'setelah 120 order massal, ledger tetap 0 selisih');
    // batalkan separuh -> stok kembali ke proyeksi
    for (const x of ids.slice(0, Math.floor(ids.length / 2))) await must(`/sales/${x.id}/void`, { method: 'POST', body: { reason: 'uji massal' } });
    const halfSold = ids.slice(Math.floor(ids.length / 2)).reduce((s, x) => s + x.qty, 0);
    const cat3 = await must('/pos/catalog');
    for (const [id, per] of Object.entries(perPortion)) {
      const expected = Math.max(0, (raw0[id] ?? 0) - per * halfSold);
      const after = cat3.raw.find((r) => r.id === id)?.stock_qty ?? 0;
      assert.ok(Math.abs(after - expected) < 0.05 || after <= 0.001, `pasca-void ${id}: ${after} vs ${expected}`);
    }
    assert.equal((await must('/stock/integrity')).mismatches.length, 0, 'ledger tetap bersih setelah seluruh void');
  });

  it('unduh backup menghasilkan berkas SQLite sungguhan + tercatat di audit', async () => {
    const r = await fetch(`${BASE}/api/admin/backup`, { headers: { authorization: `Bearer ${token.owner}` } });
    assert.equal(r.status, 200, 'backup untuk owner');
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.subarray(0, 6).toString(), 'SQLite', 'magic header SQLite');
    assert.ok(buf.length > 100_000, `ukuran wajar (${buf.length})`);
    const denied = await fetch(`${BASE}/api/admin/backup`, { headers: { authorization: `Bearer ${token.cashier}` } });
    assert.equal(denied.status, 403, 'kasir tidak boleh mengunduh backup');
    const aud = await must('/audit?entity=database&limit=10');
    assert.ok(aud.length > 0 && aud.every((x) => x.action === 'backup.download'), 'backup.download tercatat');
  });

  it('addon dari klien divalidasi ke item_addons (harga & bahan tidak bisa dipalsukan)', async () => {
    const finished = (await must('/items?type=finished')).find((i) => i.item_type === 'finished' && !i.is_non_stock);
    const raws = await must('/items?type=raw');
    const biji = raws.find((r) => /Kopi|Biji/i.test(r.name)) || raws[0];
    const asing = raws.find((r) => r.id !== biji.id) || raws[1];
    await must(`/items/${finished.id}/addons`, { method: 'PUT', body: { addons: [{ name: 'Extra Shot', price_delta: 6000, raw_item_id: biji.id, raw_qty: 9 }] }, token: token.owner });
    // siapkan stok bahan agar transaksi tidak ditolak kapasitas
    await must('/stock/adjust', {
      method: 'POST', token: token.owner,
      body: { items: raws.map((r) => ({ item_id: r.id, counted_qty: Math.max(5000, Math.ceil(r.stock_qty)) })), reason: 'api test: siapkan bahan' },
    });
    const stockBefore = Object.fromEntries(raws.map((r) => [r.id, r.stock_qty]));
    const forged = await must('/sales', {
      method: 'POST', token: token.cashier,
      body: {
        lines: [{ item_id: finished.id, qty: 2, addons: [{ name: 'Extra Shot', price_delta: -19000, raw_item_id: asing.id, raw_qty: 999999 }] }],
        external_ref: `forge-${Date.now()}`,
      },
    });
    const line = forged.lines?.[0] || (await must(`/sales/${forged.id}`)).items[0];
    const hargaDb = Number(finished.selling_price) || 0;
    // price_delta PALSU (-19000) harus digantikan nilai DB (+6000); qty 2 -> (harga+6000) x 2 sebelum pajak
    assert.equal(line.addon_delta, 6000, 'addon_delta diambil dari item_addons, bukan payload klien');
    assert.equal(line.line_total, (hargaDb + 6000) * 2, 'line_total memakai harga master + addon DB');
    assert.ok(forged.grand_total >= 2 * hargaDb, `total ${forged.grand_total} tidak boleh lebih murah dari 2x harga master`);
    const after = Object.fromEntries((await must('/items')).filter((i) => stockBefore[i.id] != null).map((i) => [i.id, i.stock_qty]));
    const dipakaiAsing = stockBefore[asing.id] - (after[asing.id] ?? stockBefore[asing.id]);
    assert.ok(dipakaiAsing < 100, `bahan yang tidak ada di resep (${asing.name}) tidak boleh terpotong ${dipakaiAsing}`);
    await must(`/sales/${forged.id}/void`, { method: 'POST', body: { reason: 'bersih-bersih' }, token: token.owner });
    await must(`/items/${finished.id}/addons`, { method: 'PUT', body: { addons: [] }, token: token.owner });
  });

  it('isolasi antar toko: admin toko lain tidak bisa mengubah data toko A', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const crypto = await import('node:crypto');
    const raw = new DatabaseSync(path.join(dataDir, 'kasir.db'));
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = 's2:' + salt + ':' + crypto.scryptSync('rahasia-b', salt, 32).toString('hex');
    const storeB = 'sto' + crypto.randomBytes(10).toString('hex');
    const userB = 'usr' + crypto.randomBytes(10).toString('hex');
    raw.prepare(`INSERT INTO stores (id, name) VALUES (?, 'Toko B Uji')`).run(storeB);
    raw.prepare(`INSERT INTO users (id, store_id, username, password_hash, display_name, role, is_active)
                 VALUES (?, ?, 'owner-b', ?, 'Pemilik Toko B', 'owner', 1)`).run(userB, storeB, hash);
    raw.close();

    const loginB = await req('/auth/login', { method: 'POST', body: { username: 'owner-b', password: 'rahasia-b' } });
    assert.equal(loginB.status, 200, 'login toko B');
    token.storeB = loginB.data.token;
    const bootB = await must('/bootstrap', { as: 'storeB' });
    assert.equal(bootB.store.name, 'Toko B Uji', 'bootstrap memakai toko milik token');
    assert.equal((bootB.catalog || []).length, 0, 'katalog toko B kosong (tidak menumpang toko A)');

    const ownerId = (await must('/auth/me')).user.id;
    const itemsA = await must('/items');
    const someItem = itemsA[0];
    const catsA = await must('/categories');
    assert.ok(someItem, 'ada barang di toko A untuk diuji');
    assert.ok(catsA.length > 0, 'ada kategori di toko A untuk diuji');

    const edits = [
      ['PUT', `/items/${someItem.id}`, { selling_price: 1 }],
      ['POST', '/stock/adjust', { item_id: someItem.id, counted_qty: 0, reason: 'kros-toko' }],
      ['PUT', `/users/${ownerId}`, { role: 'cashier' }],          // sempat bisa mengubah peran user toko lain
      ['DELETE', `/users/${ownerId}`, undefined],
      ['PUT', `/items/${someItem.id}/addons`, { addons: [{ name: 'suntik', price_delta: 0 }] }],
      ['DELETE', `/categories/${catsA[0]?.id || 'x'}`, undefined],
    ];
    for (const [method, p, body] of edits) {
      const r = await req(p, { method, as: 'storeB', body });
      assert.ok(r.status === 404, `${method} ${p} -> ${r.status} (harus 404, bukan ${r.status}) ${JSON.stringify(r.data).slice(0, 120)}`);
    }

    const after = await must('/items');
    assert.equal(after.length, itemsA.length, 'daftar barang toko A tidak berubah');
    assert.equal(after.find((i) => i.id === someItem.id).selling_price, someItem.selling_price, 'harga barang A tidak ditimpa');
    const stillOwner = await must('/auth/me');
    assert.ok(stillOwner.user.role === 'owner', 'akun owner toko A masih owner');
    assert.ok((await req('/auth/login', { method: 'POST', body: { username: 'budi', password: 'rahasia123' } })).status === 200, 'budi tetap bisa login');

    const h = new DatabaseSync(path.join(dataDir, 'kasir.db'));
    h.prepare(`DELETE FROM users WHERE id = ?`).run(userB);
    h.prepare(`DELETE FROM stores WHERE id = ?`).run(storeB);
    h.close();
  });
});

// ===========================================================================
//  Regresi putaran analisis kedua (docs/11-analisis-2026-09-17.md):
//  order tertahan (#5), header keamanan (#9), pembatas login (#6).
// ===========================================================================
describe('penguatan (docs/11)', () => {

  it('order tertahan: tahan → daftar → lanjutkan → hapus (dulu 500 storeId is not defined)', async () => {
    const cat = await must('/pos/catalog', { as: 'cashier' });
    const item = cat.finished.find((i) => !i.is_non_stock && (i.stock_qty || 0) > 0) || cat.finished[0];
    assert.ok(item, 'ada barang untuk ditahan');

    const kosong = await req('/pos/hold', { method: 'POST', as: 'cashier', body: { lines: [] } });
    assert.equal(kosong.status, 400, 'keranjang kosong ditolak 400');

    const hold = await req('/pos/hold', {
      method: 'POST', as: 'cashier',
      body: { lines: [{ item_id: item.id, qty: 2 }], customer_name: 'Meja 7', selected_discount_ids: [] },
    });
    assert.equal(hold.status, 201, `POST /pos/hold -> ${hold.status} ${JSON.stringify(hold.data).slice(0, 200)}`);
    assert.match(hold.data.invoice_no, /^HOLD\d{6}/, 'nomor order tertahan terbaca kasir');
    assert.equal(hold.data.lines.length, 1, 'baris ternormalisasi dikembalikan');

    // dua order pada detik yang sama tidak boleh menabrak uq_tx_invoice
    const hold2 = await req('/pos/hold', { method: 'POST', as: 'cashier', body: { lines: [{ item_id: item.id, qty: 1 }] } });
    assert.equal(hold2.status, 201, `hold kedua -> ${hold2.status} ${JSON.stringify(hold2.data).slice(0, 200)}`);
    assert.notEqual(hold2.data.invoice_no, hold.data.invoice_no, 'nomor hold unik walau dibuat beruntun');

    const held = await must('/pos/held', { as: 'cashier' });
    assert.ok(held.some((h) => h.id === hold.data.id), 'order muncul di daftar tertahan');
    assert.equal(held.find((h) => h.id === hold.data.id).customer_name, 'Meja 7', 'nama pelanggan ikut terbawa');

    const detail = await must(`/pos/hold/${hold.data.id}`, { as: 'cashier' });
    assert.equal(detail.lines[0].item_id, item.id, 'isi keranjang bisa dibaca ulang');
    assert.equal(detail.lines[0].qty, 2, 'qty utuh untuk dilanjutkan');
    assert.equal(detail.customer_name, 'Meja 7');

    const del = await req(`/pos/hold/${hold.data.id}`, { method: 'DELETE', as: 'cashier' });
    assert.equal(del.status, 200, 'hapus order tertahan');
    const heldAfter = await must('/pos/held', { as: 'cashier' });
    assert.equal(heldAfter.some((h) => h.id === hold.data.id), false, 'order yang dihapus tidak muncul lagi');

    const notFound = await req(`/pos/hold/${hold.data.id}`, { as: 'cashier' });
    assert.equal(notFound.status, 404, 'order yang sudah dihapus -> 404');
    await req(`/pos/hold/${hold2.data.id}`, { method: 'DELETE', as: 'cashier' });   // bersihkan
  });

  it('order tertahan butuh hak sale.hold (RBAC tetap jalan)', async () => {
    const inv = await req('/pos/hold', { method: 'POST', as: 'inventory', body: { lines: [{ item_id: 'x', qty: 1 }] } });
    assert.equal(inv.status, 403, `manajer inventaris -> ${inv.status}`);
  });

  it('header keamanan: aplikasi tidak boleh dibingkai situs lain', async () => {
    const r = await req('/health', { as: null, raw: true });
    const csp = r.headers.get('content-security-policy') || '';
    assert.ok(csp.includes("frame-ancestors 'self'"), `frame-ancestors harus 'self', dapat: ${csp.slice(0, 160)}`);
    assert.equal(csp.includes('frame-ancestors *'), false, 'frame-ancestors * membuka clickjacking');
    assert.ok(csp.includes("object-src 'none'"), 'object-src dinonaktifkan');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });

  it('X-Forwarded-For palsu tidak melewati pembatas login (ember per-username)', async () => {
    const username = 'brute-probe-user';
    const codes = [];
    const messages = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await fetch(BASE + '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 1}` },  // IP berbeda tiap percobaan
        body: JSON.stringify({ username, password: 'salah-' + i }),
      });
      codes.push(res.status);
      if (res.status === 429) messages.push((await res.json()).error || '');
    }
    assert.ok(codes.includes(429), `harus kena 429 walau IP dipalsukan, dapat: ${codes.join(',')}`);
    assert.equal(codes[codes.length - 1], 429, 'percobaan terakhir diblokir');
    assert.ok(codes.filter((c) => c === 401).length <= 10, `401 tidak boleh tak terbatas: ${codes.join(',')}`);
    assert.ok(messages.some((m) => m.includes('akun ini')), `429 harus dari ember per-username, pesan: ${messages[0] || '-'}`);
  });

  it('login pemilik tetap berhasil setelah percobaan brute force akun lain', async () => {
    const r = await req('/auth/login', { method: 'POST', body: { username: 'budi', password: 'rahasia123' } });
    assert.equal(r.status, 200, `budi -> ${r.status} (tidak boleh kena lockout kolateral)`);
    assert.ok(r.data.token, 'token diterbitkan');
  });

  it('KASIR_TRUST_PROXY=false membuat X-Forwarded-For diabaikan (pembatas per-IP jalan)', async () => {
    const PORT2 = PORT + 200;
    const srv2 = await spawnAndWait([path.join(ROOT, 'src', 'index.js')], 'Kasir API', {
      env: { ...process.env, KASIR_DATA_DIR: dataDir, PORT: String(PORT2), KASIR_TRUST_PROXY: 'false' }, ticks: 150,
    });
    child2 = srv2.proc;
    try {
      const codes = [];
      const messages = [];
      for (let i = 0; i < 8; i += 1) {
        const res = await fetch(`http://127.0.0.1:${PORT2}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i + 1}` },
          body: JSON.stringify({ username: 'brute-probe-ip-' + i, password: 'salah' }),   // username berbeda: hanya ember IP yang bisa memicu
        });
        codes.push(res.status);
        if (res.status === 429) messages.push((await res.json()).error || '');
      }
      assert.ok(codes.includes(429), `XFF harus diabaikan -> 429 per-IP, dapat: ${codes.join(',')}`);
      assert.ok(messages.some((m) => m.includes('jaringan ini')), `429 harus dari ember per-IP, pesan: ${messages[0] || '-'}`);
    } finally {
      try { child2.kill('SIGKILL'); } catch { /* noop */ }
      child2 = null;
    }
  });
});

process.on('exit', () => {
  if (child) { try { child.kill('SIGKILL'); } catch { /* noop */ } }
  if (child2) { try { child2.kill('SIGKILL'); } catch { /* noop */ } }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ }
});

await standalone(import.meta.url);
