// ===========================================================================
//  Entry smoke test UI: dipakai client/tests/ui-smoke.mjs (di-bundle esbuild).
// ===========================================================================
import './env.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act as actLegacy } from 'react-dom/test-utils';
import { dom, BASE } from './env.js';
import { setToken } from '../src/api.js';
import { AppProvider } from '../src/store.jsx';
import { App } from '../src/App.jsx';
import PosPage from '../src/features/pos/PosPage.jsx';
import SalesHistory from '../src/features/pos/SalesHistory.jsx';
import StockPage from '../src/features/inventory/StockPage.jsx';
import ItemsPage from '../src/features/inventory/ItemsPage.jsx';
import PurchasePage from '../src/features/inventory/PurchasePage.jsx';
import Dashboard from '../src/features/report/Dashboard.jsx';
import ReportsPage from '../src/features/report/ReportsPage.jsx';
import AlertsPage from '../src/features/alerts/AlertsPage.jsx';
import UsersPage from '../src/features/admin/UsersPage.jsx';
import SettingsPage from '../src/features/settings/SettingsPage.jsx';
import { buildReceiptLines } from '../src/features/receipt/receipt.jsx';

const act = React.act || actLegacy;   // React 18.3 punya act resmi; fallback ke test-utils
const h = React.createElement;
let fails = 0;
const ok = (cond, msg) => { if (cond) console.log('  ✓', msg); else { fails++; console.log('  ❌', msg); } };

// ---------------------------------------------------------------- sesi & data
const login = async (username, password) => fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
}).then((r) => r.json());
const sesi = await login('budi', 'rahasia123');
if (!sesi?.token) throw new Error('login demo gagal — jalankan seed lebih dulu');
setToken(sesi.token);
const api = (p, o = {}) => fetch(`${BASE}/api` + p, { ...o, headers: { authorization: `Bearer ${sesi.token}`, 'content-type': 'application/json', ...(o.headers || {}) } }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

let boot = (await api('/bootstrap')).data;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const u = String(url);
  if (u.includes('/api/bootstrap')) return Promise.resolve(new Response(JSON.stringify(boot), { headers: { 'content-type': 'application/json' } }));
  if (u.startsWith('/api')) return realFetch(`${BASE}${u}`, opts);
  return realFetch(u, opts);
};
// ambil data baru LANGSUNG dari server (bukan lewat stub di bawah) untuk assertion
const refreshBoot = async () => {
  const res = await realFetch(`${BASE}/api/bootstrap`, { headers: { authorization: `Bearer ${sesi.token}` } });
  boot = await res.json();
};

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 220)); }); };
const text = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
const find = (root, sel, needle) => [...root.querySelectorAll(sel)].find((e) => !needle || text(e).includes(needle));
const click = async (el) => { if (!el) throw new Error('elemen tidak ditemukan untuk diklik'); await act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); }); await settle(2); };
const has = (t, ...needles) => {
  const miss = needles.filter((n) => !t.includes(n));
  if (miss.length) throw new Error('teks hilang: ' + miss.join(' , ') + ' || ' + t.slice(0, 200));
};

/** Render elemen apa pun (biasanya sudah dibungkus AppProvider) di jsdom. */
async function mount(node) {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  let root;
  await act(async () => { root = createRoot(container); });
  await act(async () => { root.render(node); });
  await settle(5);
  return { container, unmount: () => { act(() => root.unmount()); container.remove(); } };
}
async function check(name, node, assertions) {
  const errs = [];
  const onErr = (e) => errs.push(String(e.error || e.message));
  dom.window.addEventListener('error', onErr);
  const { container, unmount } = await mount(node);
  try {
    const t = text(container);
    if (/Transform failed|is not defined|Cannot read|Unexpected token/.test(t)) errs.push(t.slice(0, 200));
    if (assertions) assertions(container, t);
    if (errs.length) { fails++; console.log(`❌ ${name}\n   ${errs.slice(0, 2).join(' | ').slice(0, 300)}`); }
    else console.log(`✅ ${name} — ${container.querySelectorAll('*').length} elemen dirender`);
  } catch (e) {
    fails++;
    console.log(`❌ ${name}: ${e.message}\n   teks: ${text(container).slice(0, 180)}`);
  } finally {
    dom.window.removeEventListener('error', onErr);
    unmount();
  }
}

// ------------------------------------------------------- 0. form login
// Regression: tombol "Masuk" wajib benar-benar submit form (dulu <Button>
// mengunci type="button" sehingga klik = tidak terjadi apa-apa, tanpa error).
console.log('\n▶ form login: klik tombol "Masuk" harus memicu submit');
setToken('');
{
  const lp = await mount(h(App));
  const t0 = text(lp.container);
  ok(t0.includes('Nama pengguna'), 'layar login tampil (status anonim)');
  const userInput = lp.container.querySelector('input[autocomplete="username"]');
  const passInput = lp.container.querySelector('input[type="password"]');
  ok(!!userInput && !!passInput, 'input username & password ada');
  const setVal = async (input, value) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  await setVal(userInput, 'budi');
  await setVal(passInput, 'rahasia123');
  await click(find(lp.container, 'button', 'Masuk'));
  await settle(6);
  ok(!!lp.container.querySelector('.sidebar'), 'klik "Masuk" berhasil masuk ke shell (sidebar tampil)');
  ok(!text(lp.container).includes('Nama pengguna'), 'layar login sudah hilang setelah masuk');
  lp.unmount();
}

// ------------------------------------------------------- 1. semua halaman
console.log('\n▶ render setiap halaman dengan data asli');
await check('Shell aplikasi (login/boot)', h(App), (c, t) => has(t, 'Kopi Senja'));
await check('Kasir (POS)', h(AppProvider, null, h(PosPage)), (c, t) => { has(t, 'Bayar'); if (!c.querySelector('.item-tile')) throw new Error('tidak ada tile barang'); });
await check('Stok', h(AppProvider, null, h(StockPage)), (c, t) => has(t, 'Kesehatan stok', 'Nilai persediaan'));
await check('Barang & bahan', h(AppProvider, null, h(ItemsPage)), (c, t) => has(t, 'Katalog barang'));
await check('Pembelian', h(AppProvider, null, h(PurchasePage)), (c, t) => has(t, 'Purchase Order', 'Supplier'));
await check('Dasbor', h(AppProvider, null, h(Dashboard, null)), (c, t) => has(t, 'Omzet', 'Jam ramai', 'Produk terlaris'));
await check('Laporan', h(AppProvider, null, h(ReportsPage)), (c, t) => has(t, 'Produk terlaris', 'Omzet kotor'));
await check('Peringatan', h(AppProvider, null, h(AlertsPage)), (c, t) => has(t, 'Pusat peringatan', 'Rencana pembelian'));
await check('Riwayat transaksi', h(AppProvider, null, h(SalesHistory)), (c, t) => has(t, 'No. struk'));
await check('User & role', h(AppProvider, null, h(UsersPage)), (c, t) => has(t, 'Anggota tim', 'Hak akses'));
await check('Pengaturan', h(AppProvider, null, h(SettingsPage)), (c, t) => has(t, 'Profil toko', 'Pajak & pembulatan', 'Tema & menu'));

// ------------------------------------------------------- 2. alur kasir nyata
console.log('\n▶ alur kasir: keranjang → proyeksi bahan → bayar → struk → stok');
const fresh = (await api('/pos/catalog')).data;
const item = fresh.items.find((i) => i.item_type === 'finished' && !i.is_non_stock && i.stock_qty > 5);
const st0 = (await api(`/items/${item.id}`)).data.stock_qty;
const pos = await mount(h(AppProvider, null, h(PosPage)));
await click(find(pos.container, '.item-tile', item.name));
await click(find(pos.container, '.item-tile', item.name));
ok(text(find(pos.container, '.qty-ctl span') || {}) === '2', `qty keranjang = ${text(find(pos.container, '.qty-ctl span') || {})} (harus 2)`);
await settle(4);
const grand = text(find(pos.container, '.cart-totals .grand') || {});
ok(/TOTAL\s*Rp[\d.]+/.test(grand), `total terhitung: ${grand}`);
const rawChips = [...pos.container.querySelectorAll('.raw-chip')].map(text);
ok(rawChips.length > 0, `proyeksi bahan di keranjang: ${rawChips.slice(0, 2).join(' / ') || '(item tanpa BOM)'}`);
await click(find(pos.container, 'button', 'Bayar Rp'));
ok(!!find(dom.window.document, '.modal', 'Pembayaran'), 'modal pembayaran terbuka');
const cashInput = find(dom.window.document, '.modal input[type="number"]');
ok(cashInput && Number(cashInput.value) > 0, `uang diterima otomatis terisi total (${cashInput ? cashInput.value : '—'})`);
await click([...dom.window.document.querySelectorAll('.modal button')].find((b) => text(b).startsWith('Proses')));
await settle(6);
const body = dom.window.document.body;
ok(!!find(body, '.receipt'), 'struk tampil setelah pembayaran');
const invoice = (text(body.querySelector('.modal-head h3') || {}) || '').match(/[A-Z]{2,3}\d+-\d+/)?.[0] || '';
ok(!!invoice, `nomor struk dari UI: ${invoice}`);
await click([...dom.window.document.querySelectorAll('.modal-head button')].find((b) => text(b) === '✕'));
pos.unmount();
const st1 = (await api(`/items/${item.id}`)).data.stock_qty;
ok(st1 === st0 - 2, `stok ${item.name}: ${st0} → ${st1} (harus -2)`);
const mv = (await api('/stock/movements?limit=60')).data;
ok(mv.some((m) => (m.reason || '').includes(invoice)), `ledger menyimpan gerakan untuk ${invoice}`);

// ------------------------------------------------------- 3. panel tema
console.log('\n▶ panel kustomisasi: tema live + tersimpan');
const st = await mount(h(AppProvider, null, h(SettingsPage)));
await click(find(st.container, 'button', 'Tema & menu'));
await settle(4);
const swatch = [...st.container.querySelectorAll('.palette-swatch')];
ok(swatch.length >= 4, `${swatch.length} palet siap pakai`);
await click(swatch[0]);
await settle(2);
const accent = dom.window.document.documentElement.style.getPropertyValue('--accent');
ok(!!accent, `pratinjau langsung mengubah --accent → ${accent}`);
await click(find(st.container, 'button', 'Simpan'));
await settle(4);
await refreshBoot();
ok(boot.settings.theme.accent === accent, `tema tersimpan ke server (${boot.settings.theme.accent})`);
ok(!!find(st.container, '.menu-row'), 'editor urutan menu tersedia (drag/urut/tampil)');
st.unmount();

// ------------------------------------------------------- 4. struk: semua ukuran kertas
console.log('\n▶ struk: tidak ada baris meluber di tiap lebar kertas');
for (const w of [58, 72, 80, 240]) {
  const lines = buildReceiptLines({
    snapshot: { store: boot.store, receipt: { ...boot.settings.receipt, paper_width: w } },
    tx: { invoice_no: 'KS-UJI', created_at: new Date().toISOString(), payment_name: 'Tunai', subtotal: 30000, grand_total: 33300, tax_total: 3300 },
    items: [{ name_snapshot: 'Nama barang yang sangat panjang untuk uji tata letak struk', qty: 3, unit_price: 10000, line_total: 30000 }],
    receipt: { ...boot.settings.receipt, paper_width: w }, store: boot.store,
  });
  const limit = w === 240 ? 120 : (w === 58 ? 32 : w === 72 ? 42 : 48);
  const widest = Math.max(...lines.map((l) => l.length));
  ok(widest <= limit, `${w}mm: ${lines.length} baris, terlebar ${widest} ≤ ${limit} kolom`);
}

console.log(fails ? `\n${fails} pemeriksaan UI gagal\n` : '\n🎉 smoke UI lolos\n');
process.exit(fails ? 1 : 0);

