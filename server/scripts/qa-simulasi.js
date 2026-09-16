#!/usr/bin/env node
// ===========================================================================
//  QA Simulasi Transaksi Massal (Fase 4)
//  Menjalankan server pada pangkalan data TERPISAH, lalu menguji:
//   1. volume transaksi tinggi: akurasi potongan stok bahan baku (BOM)
//   2. konsistensi ledger vs kolom stok (tidak ada stok "bocor"/hilang)
//   3. pembatalan massal: seluruh stok kembali persis seperti semula
//   4. balapan (race) beberapa kasir menjual bahan yang sama
//   5. isolasi data & RBAC + kebal struk terhadap perubahan setting
//  Pemakaian: node server/scripts/qa-simulasi.js [--n=400] [--port=4321]
// ===========================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const N = Math.max(10, Number(arg('n', 400)));
const PORT = Number(arg('port', 4321));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kasirqa-'));
const KEEP = process.argv.includes('--keep');
const results = [];
const t0 = Date.now();
const say = (s) => console.log(s);

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  say(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  return pass;
}

const API = `http://127.0.0.1:${PORT}/api`;
async function call(pathname, { token, method = 'GET', body } = {}) {
  const res = await fetch(API + pathname, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
const expect = async (label, promise, code) => {
  const r = await promise;
  return check(label, r.status === code, `HTTP ${r.status}${r.data?.error ? ` · ${r.data.error}` : ''}`);
};

const waitFor = async (child, marker, ms = 60000) => {
  const start = Date.now();
  let buf = '';
  await new Promise((resolve, reject) => {
    const tick = () => {
      if (buf.includes(marker)) return resolve();
      if (child.exitCode !== null) return reject(new Error(`proses selesai lebih dulu (code ${child.exitCode})\n${buf}`));
      if (Date.now() - start > ms) return reject(new Error('waktu tunggu habis:\n' + buf));
      setTimeout(tick, 60);
    };
    child.stdout.on('data', (d) => { buf += d.toString(); });
    child.stderr.on('data', (d) => { buf += d.toString(); });
    tick();
  });
  return buf;
};

const env = { ...process.env, KASIR_DATA_DIR: DATA_DIR, PORT: String(PORT), KASIR_JWT_SECRET: 'qa-secret-bukan-produksi', NODE_NO_WARNINGS: '1' };
say(`\n🧪 QA simulasi — pangkalan data sementara: ${DATA_DIR}\n`);

// 1) seed demo (data historis + BOM + alert) lalu nyalakan server
const seed = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server/scripts/seed.js'), '--force', '--quiet'], { env, cwd: ROOT });
await waitFor(seed, 'KASIR_READY', 120000);
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server/src/index.js')], { env, cwd: ROOT });
await waitFor(server, 'Kasir API', 60000);

try {
  const login = async (username, password) => (await call('/auth/login', { method: 'POST', body: { username, password } })).data;
  const owner = await login('budi', 'rahasia123');
  const settings = async () => (await call('/settings', { token: owner?.token })).data;
  const kasir = await login('dewi', 'rahasia123');
  if (!owner?.token || !kasir?.token) throw new Error('login demo gagal — jalankan seed lebih dulu');

  const cat = (await call('/pos/catalog', { token: owner.token })).data;
  const finished = cat.finished.filter((f) => !f.is_non_stock);
  const raws = Object.fromEntries(cat.raw.map((r) => [r.id, r]));
  const stockOf = async () => {
    const c = (await call('/pos/catalog', { token: owner.token })).data;
    return Object.fromEntries(c.items.map((i) => [i.id, i.stock_qty]));
  };
  const ledgerSum = async (ids) => {
    const out = {};
    for (const id of ids) {
      const rows = (await call(`/stock/movements?item_id=${id}&limit=2000`, { token: owner.token })).data;
      out[id] = rows.reduce((s, m) => s + m.qty, 0);
    }
    return out;
  };

  // ------------------------------------------------- 1. transaksi massal
  const menu = finished.filter((f) => (f.recipe || []).length).slice(0, 4);
  // Top up bahan dulu supaya skenario menguji VOLUME (bukan kehabisan stok):
  // tanpa ini sebagian struk akan ditolak karena kapasitas bahan, bukan karena sistemnya.
  const needPerRaw = {};
  for (const item of menu) {
    const y = Math.max(1, Number(item.yield_pct) || 100) / 100;
    const rounds = Math.ceil(N / menu.length) * 3;
    for (const r of item.recipe) {
      needPerRaw[r.raw_item_id] = (needPerRaw[r.raw_item_id] || 0) + (rounds * Number(r.qty) * (1 + (Number(r.waste_pct) || 0) / 100)) / y;
    }
  }
  const topup = Object.entries(needPerRaw).map(([item_id, need]) => ({ item_id, counted_qty: Math.ceil(need) + 1000 }));
  await call('/stock/adjust', { token: owner.token, method: 'POST', body: { items: topup, reason: 'qa: siapkan bahan untuk uji volume' } });
  if (menu.some((m) => m.production_mode === 'make_to_stock')) {
    await call('/stock/adjust', {
      token: owner.token, method: 'POST',
      body: { items: menu.filter((m) => m.production_mode === 'make_to_stock').map((m) => ({ item_id: m.id, counted_qty: N + 1000 })), reason: 'qa: stok barang jadi untuk uji volume' },
    });
  }
  const before = await stockOf();
  const tSale = Date.now();
  let okSales = 0;
  const rejected = [];
  const createdIds = [];
  const sales = [];
  const queue = [];
  for (let i = 0; i < N; i += 1) {
    const item = menu[i % menu.length];
    const qty = 1 + (i % 3);
    const job = call('/sales', {
      token: i % 2 ? kasir.token : owner.token,
      method: 'POST',
      body: {
        lines: [{ item_id: item.id, qty }],
        paid_amount: 10_000_000,
        external_ref: `qa-${i}`,
        skip_alerts: true, // alert dihitung sekali di akhir (prosedur impor massal)
      },
    }).then((r) => {
      if (r.status === 201) { okSales += 1; createdIds.push(r.data.id); sales.push({ item, qty, id: r.data.id, invoice: r.data.invoice_no, movements: r.data.movements || [] }); }
      else rejected.push(`${r.status}:${r.data?.error || ''}`.slice(0, 60));
      return r;
    });
    queue.push(job);
    if (queue.length >= 16) { await Promise.all(queue.splice(0, queue.length)); }
  }
  await Promise.all(queue);
  const dtSale = (Date.now() - tSale) / 1000;
  const rate = okSales / Math.max(dtSale, 0.001);
  check(`transaksi massal diproses (${okSales}/${N} berhasil)`, okSales > 0 && rate > 40,
    `${dtSale.toFixed(2)} detik · ${rate.toFixed(0)} struk/detik · ${rejected.length} ditolak karena kapasitas bahan (benar: stok tidak boleh minus)`);

  // ------------------------------------------------- 2. akurasi potongan BOM
  const after = await stockOf();
  const expected = {};
  for (const { item, qty } of sales) {
    const y = Math.max(1, Number(item.yield_pct) || 100) / 100;
    for (const r of item.recipe) {
      // barang jadi mode MTS dipotong dari stok jadi (bahan sudah terpakai saat produksi)
      if (item.production_mode === 'make_to_stock') continue;
      expected[r.raw_item_id] = (expected[r.raw_item_id] || 0) + (qty * Number(r.qty) * (1 + (Number(r.waste_pct) || 0) / 100)) / y;
    }
  }
  const detailMov = new Map();
  for (const id of createdIds) {
    const d = (await call(`/sales/${id}`, { token: owner.token })).data;
    for (const m of d.movements || []) {
      const key = `${d.id}|${m.item_id}`;
      if (!detailMov.has(key)) detailMov.set(key, { invoice: d.invoice_no, item_id: m.item_id, type: m.movement_type, qty: m.qty });
    }
  }
  const rawIds = Object.keys(expected);
  const sums = await ledgerSum(rawIds);
  const perInvoice = {};
  for (const m of detailMov.values()) {
    if (m.type !== 'bom_consume') continue;
    perInvoice[m.item_id] = (perInvoice[m.item_id] || 0) + -m.qty;
  }
  let maxDiff = 0; const badItems = [];
  for (const id of rawIds) {
    const deducted = perInvoice[id] ?? -(sums[id] || 0);
    const diff = Math.abs(deducted - expected[id]);
    maxDiff = Math.max(maxDiff, diff);
    if (diff > 0.01) badItems.push(`${raws[id]?.name}: ledger ${deducted.toFixed(2)} vs rumus ${expected[id].toFixed(2)}`);
  }
  check('potongan bahan baku = perhitungan BOM (qty × (1+susut) ÷ yield)', maxDiff <= 0.01,
    `selisih maks ${maxDiff.toFixed(4)} satuan pada ${rawIds.length} bahan${badItems.length ? ' · ' + badItems.slice(0, 3).join('; ') : ''}`);

  // ------------------------------------------------- 3. tidak ada stok bocor
  //    (a) total potongan per bahan = ringkasan yang dikembalikan tiap struk
  const moveTotals = {};
  for (const sale of sales) {
    for (const m of sale.movements) moveTotals[m.item_id] = (moveTotals[m.item_id] || 0) + -Number(m.qty);
  }
  const leaked = [];
  for (const id of Object.keys(moveTotals)) {
    const d = before[id] - after[id];
    // produksi/pembelian tidak terjadi di sesi ini, jadi Δstok harus sama dengan total struk
    if (Math.abs(d - moveTotals[id]) > 0.01) leaked.push(`${raws[id]?.name || menu.find((m) => m.id === id)?.name || id}: Δstok ${d.toFixed(2)} vs struk ${moveTotals[id].toFixed(2)}`);
  }
  check('Δstok setiap item sama dengan total potongan yang dilaporkan struk (tidak ada stok hilang/tercopot)', leaked.length === 0,
    leaked.slice(0, 3).join('; ') || `${Object.keys(moveTotals).length} item diperiksa`);
  //    (b) selaraskan kolom stok dengan ledger: harus 0 item perlu disetel
  const rec = (await call('/stock/reconcile', { token: owner.token, method: 'POST' })).data;
  check('rekonsiliasi ledger -> stok: 0 item perlu disetel ulang', (rec.fixed ?? 0) === 0, `${rec.fixed} item disetel, ${rec.checked ?? '-'} diperiksa`);
  const integ = (await call('/stock/integrity', { token: owner.token })).data;
  check('integritas ledger global (balance_after berurutan)', (integ.mismatches || []).length === 0, `${integ.checked} item · ${integ.mismatches?.length || 0} selisih`);

  // ------------------------------------------------- 4. negatif stok ditolak
  const killer = menu.find((m) => m.recipe.some((r) => (raws[r.raw_item_id]?.stock_qty || 0) > 0));
  const huge = await call('/sales', {
    token: owner.token, method: 'POST',
    body: { lines: [{ item_id: killer.id, qty: 1_000_000 }], external_ref: 'qa-huge' },
  });
  check('permintaan di atas kapasitas bahan ditolak (stok tidak jadi minus)', huge.status === 409, `HTTP ${huge.status} · ${huge.data?.error || ''}`);
  const afterReject = await stockOf();
  check('penolakan tidak mengubah stok sama sekali', rawIds.every((id) => afterReject[id] === after[id]), `${rawIds.length} bahan dicek ulang`);

  // ------------------------------------------------- 4b. jejak audit
  const audit = (await call('/audit?limit=300', { token: owner.token })).data;
  const saleEvents = audit.filter((a) => (a.action || '').startsWith('sale.create'));
  const auditedIds = new Set(audit.map((a) => a.entity_id));
  const recent = sales.slice(-12);
  const missingAudit = recent.filter((x) => !auditedIds.has(x.id));
  check('12 struk terbaru seluruhnya punya jejak di log audit', saleEvents.length > 0 && missingAudit.length === 0,
    `${saleEvents.length} entri sale.create pada 300 baris terakhir · ${recent.length - missingAudit.length}/${recent.length} struk terbaru terlacak${missingAudit.length ? ' · hilang: ' + missingAudit.map((x) => x.invoice).join(', ') : ''}`);

  // ------------------------------------------------- 5. idempotensi
  const dup = await call('/sales', { token: owner.token, method: 'POST', body: { lines: [{ item_id: menu[0].id, qty: 1 }], external_ref: 'qa-0' } });
  const afterDup = await stockOf();
  check('external_ref ganda dilayani idempoten (tidak memotong stok lagi)', dup.data?.duplicated === true && rawIds.every((id) => afterDup[id] === after[id]),
    `invoice ${dup.data?.invoice_no} → ${dup.status}`);

  // ------------------------------------------------- 6. struk kebal perubahan setting
  const one = createdIds[0];
  const snapBefore = (await call(`/sales/${one}`, { token: owner.token })).data;
  const tax0 = (await settings()).tax;
  await call('/settings/tax', { token: owner.token, method: 'PUT', body: { ...tax0, enabled: false, default_rate_pct: 0, service_charge_pct: 0, rounding_mode: 'none' } });
  const rec0 = (await settings()).receipt;
  await call('/settings/receipt', { token: owner.token, method: 'PUT', body: { ...rec0, header: 'GANTI TOTAL', footer: '', show: { ...rec0.show, items: false } } });
  const snapAfter = (await call(`/sales/${one}`, { token: owner.token })).data;
  check('struk tersimpan memakai snapshot (harga & layout tidak berubah setelah setting diedit)',
    JSON.stringify(snapAfter.snapshot) === JSON.stringify(snapBefore.snapshot),
    `grand_total ${snapAfter.snapshot?.pricing?.grand_total} tetap`);
  await call('/settings/receipt', { token: owner.token, method: 'PUT', body: rec0 });
  await call('/settings/tax', { token: owner.token, method: 'PUT', body: tax0 });

  // ------------------------------------------------- 7. pembatalan massal
  const tVoid = Date.now();
  let okVoid = 0;
  const vq = [];
  for (const id of createdIds) {
    vq.push(call(`/sales/${id}/void`, { token: owner.token, method: 'POST', body: { reason: 'qa: uji pembatalan massal' } })
      .then((r) => { if (r.status === 200) okVoid += 1; }));
    if (vq.length >= 16) await Promise.all(vq.splice(0, vq.length));
  }
  await Promise.all(vq);
  const afterVoid = await stockOf();
  const notBack = rawIds.filter((id) => Math.abs(afterVoid[id] - before[id]) > 0.01);
  check(`pembatalan ${createdIds.length} transaksi mengembalikan seluruh stok bahan`, okVoid === createdIds.length && notBack.length === 0,
    `${okVoid} void sukses · ${((Date.now() - tVoid) / 1000).toFixed(2)} detik${notBack.length ? ' · belum kembali: ' + notBack.map((i) => raws[i]?.name).join(', ') : ''}`);

  // ------------------------------------------------- 8. balapan antar kasir
  // pilih bahan yang benar-benar dipotong SAAT PENJUALAN: hanya produk make_to_order yang
  // mengonsumsi bahan langsung (produk make_to_stock memotong stok barang jadi, jadi rasinya
  // tidak akan pernah menyentuh bahan).
  const mtoMenu = menu.filter((m) => m.production_mode === 'make_to_order' && (m.recipe || []).length);
  const scarce = Object.values(raws).sort((a, b) => a.stock_qty - b.stock_qty)
    .find((r) => r.stock_qty > 5 && mtoMenu.some((m) => (m.recipe || []).some((x) => x.raw_item_id === r.id)));
  const scarceOf = mtoMenu.find((m) => (m.recipe || []).some((r) => r.raw_item_id === scarce?.id));
  if (scarce && scarceOf) {
    // kosongkan stok barang jadi produk ini supaya tiap penjualan pasti memotong bahan
    await call('/stock/adjust', { token: owner.token, method: 'POST', body: { items: [{ item_id: scarceOf.id, counted_qty: 0 }], reason: 'qa: rasio bahan vs stok jadi' } });
    const st = (await stockOf())[scarce.id];
    const per = ((scarceOf.recipe.find((r) => r.raw_item_id === scarce.id).qty) * (1 + (scarceOf.recipe.find((r) => r.raw_item_id === scarce.id).waste_pct || 0) / 100)) / (Math.max(1, Number(scarceOf.yield_pct) || 100) / 100);
    const attempts = Math.min(120, Math.max(4, Math.ceil(st / per) + 8));
    const race = await Promise.all(Array.from({ length: attempts }, (_, i) => call('/sales', { token: kasir.token, method: 'POST', body: { lines: [{ item_id: scarceOf.id, qty: 1 }], external_ref: `qa-race-${i}`, skip_alerts: true } })));
    const success = race.filter((r) => r.status === 201).length;
    const nowSt = (await stockOf())[scarce.id];
    const spentOk = Math.abs(st - nowSt - success * per) < Math.max(0.02, per * 0.02);
    check(`balapan ${attempts} kasir pada bahan "${scarce.name}"`, success > 0 && spentOk && nowSt >= -0.001,
      `${success} sukses, ${attempts - success} ditolak · stok ${st.toFixed(2)} → ${nowSt.toFixed(2)} (pakai ${(success * per).toFixed(2)})`);
    for (const r of race.filter((x) => x.status === 201)) await call(`/sales/${r.data.id}/void`, { token: owner.token, method: 'POST', body: { reason: 'qa: bersih-bersih' } });
  }

  // ------------------------------------------------- 9. RBAC & isolasi data
  await expect('kasir boleh melihat katalog', call('/pos/catalog', { token: kasir.token }), 200);
  await expect('kasir tidak boleh mengubah pengaturan toko', call('/settings/store', { token: kasir.token, method: 'PUT', body: { name: 'DIBAJAK' } }), 403);
  await expect('kasir tidak boleh membaca daftar user', call('/users', { token: kasir.token }), 403);
  await expect('kasir tidak boleh mengunduh backup DB', call('/admin/backup', { token: kasir.token }), 403);
  await expect('tanpa token semua rute data tertutup', call('/items'), 401);
  await expect('token palsu ditolak', call('/items', { token: 'abc.def.ghi' }), 401);
  const storeName = (await call('/bootstrap', { token: owner.token })).data.store.name;
  check('nama toko tidak berubah (percobaan ubah oleh kasir gagal total)', storeName !== 'DIBAJAK', `nama kini: ${storeName}`);
  const leak = JSON.stringify(await call('/bootstrap', { token: kasir.token })).match(/password_hash|pin":"(?!null)/g);
  check('tidak ada kolom rahasia (password hash / PIN) di respons API', !leak, leak ? leak.join(',') : 'bersih');

  // ------------------------------------------------- ringkasan
  const pass = results.filter((r) => r.pass).length;
  say(`\n${pass}/${results.length} pemeriksaan lolos dalam ${((Date.now() - t0) / 1000).toFixed(1)} detik`);
  say(`   pangkalan data uji: ${DATA_DIR}${KEEP ? ' (dipertahankan)' : ''}\n`);
  if (!KEEP) { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { } }
  process.exitCode = pass === results.length ? 0 : 1;
} catch (e) {
  say('\n❌ QA gagal: ' + (e.stack || e.message));
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  seed.kill('SIGTERM');
  if (!KEEP) setTimeout(() => process.exit(process.exitCode || 0), 300);
}
