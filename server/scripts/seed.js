// ===========================================================================
//  Seed data demo: "Kopi Senja" (kedai kopi dengan resep bahan baku).
//  Jalankan: npm run seed         (idempoten: menimpa hanya bila --force)
//            npm run reset && npm run seed   (dari nol)
// ===========================================================================
import { db, allRows, firstRow, exec, uid, nowIso, round2, saveSetting } from '../src/db/index.js';
import { DEFAULTS } from '../src/config.js';
import { hashPassword, hashPin } from '../src/auth.js';
import { postMovement, reconcileStock } from '../src/inventory.js';
import * as salesMod from '../src/sales.js';
const createSale = (p) => salesMod.createSale(p);
import { generateAlerts } from '../src/stockhealth.js';
import { tx } from '../src/db/index.js';
import { ROLE_PRESETS } from '../src/rbac.js';

const FORCE = process.argv.includes('--force');
const QUIET = process.argv.includes('--quiet');
const log = QUIET ? () => {} : (...a) => console.log(...a);
const existing = firstRow(`SELECT COUNT(*) AS n FROM stores`).n;
if (existing > 0 && !FORCE) {
  log('ℹ️  Database sudah berisi data. Pakai `npm run reset` untuk mengulang dari nol, atau `node server/scripts/seed.js --force` untuk menambah.');
  process.exit(0);
}

log('🌱 Menyiapkan data demo Kopi Senja...');

// ------------------------------------------------------------------ 1. toko
const storeId = uid('sto');
exec(
  `INSERT INTO stores (id, name, legal_name, address, phone, email, npwp, timezone, currency, locale, is_active)
   VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
  storeId, 'Kopi Senja', 'CV Senja Rasa Group', 'Jl. Cendana No. 12, Jakarta Selatan', '021-7788990',
  'halo@kopisenja.id', '01.234.567.8-901.000', 'Asia/Jakarta', 'IDR', 'id-ID'
);
const branchA = uid('brn');
const branchB = uid('brn');
exec(`INSERT INTO branches (id, store_id, name, address, phone, is_default) VALUES (?,?,?,?,?,1)`,
  branchA, storeId, 'Kopi Senja — Cendana', 'Jl. Cendana No. 12, Jakarta Selatan', '021-7788990');
exec(`INSERT INTO branches (id, store_id, name, address, phone, is_default) VALUES (?,?,?,?,?,0)`,
  branchB, storeId, 'Kopi Senja — Dago', 'Jl. Ranca Kendal No. 3, Bandung', '022-2034567');

// ------------------------------------------------------------------ 2. user
const users = [
  { id: uid('usr'), username: 'budi', display_name: 'Budi (Pemilik)', role: 'owner', password: 'rahasia123', pin: '1111' },
  { id: uid('usr'), username: 'sari', display_name: 'Sari (Inventaris)', role: 'inventory', password: 'rahasia123', pin: '2222' },
  { id: uid('usr'), username: 'rina', display_name: 'Rina (Manajer)', role: 'manager', password: 'rahasia123', pin: '3333' },
  { id: uid('usr'), username: 'dewi', display_name: 'Dewi (Kasir)', role: 'cashier', password: 'rahasia123', pin: '4444' },
  { id: uid('usr'), username: 'adi', display_name: 'Adi (Kasir)', role: 'cashier', password: 'rahasia123', pin: '5555' },
];
for (const u of users) {
  exec(`INSERT INTO users (id, store_id, branch_id, username, password_hash, display_name, pin, role, is_active)
        VALUES (?,?,?,?,?,?,?, ?,1)`,
    u.id, storeId, branchA, u.username, hashPassword(u.password), u.display_name, hashPin(u.pin), u.role);
}

// ------------------------------------------------------------------ 3. setting
saveSetting(storeId, 'store', {
  ...DEFAULTS.store, name: 'Kopi Senja', legal_name: 'CV Senja Rasa Group',
  address: 'Jl. Cendana No. 12, Jakarta Selatan', phone: '021-7788990', email: 'halo@kopisenja.id',
  npwp: '01.234.567.8-901.000', invoice_prefix: 'KS',
}, users[0].id);
saveSetting(storeId, 'tax', {
  ...DEFAULTS.tax, enabled: true, default_rate_pct: 11, inclusive: false, service_charge_pct: 0,
  rounding_mode: 'nearest', rounding_step: 50, allow_negative_stock: false, alert_lookahead_days: 7,
  consumption_window_days: 14,
}, users[0].id);
saveSetting(storeId, 'receipt', {
  ...DEFAULTS.receipt,
  header: 'Kopi Senja — Nikmati secangkir ketenangan',
  subheader: 'Jl. Cendana No. 12, Jakarta Selatan · 021-7788990',
  footer: 'Terima kasih sudah mendukung petani kopi lokal ☕',
  thank_you: 'Sampai jumpa lagi!',
  paper_width: 58, font_scale: 1, line_char: '-', center_char: '=', social: '@kopisenja',
  show: { ...DEFAULTS.receipt.show, npwp: true, cashier: true, change: true, social: true, barcode: true },
  custom_lines: [{ position: 'bottom', text: 'Pesan online: gofood/grabfood "Kopi Senja Cendana"' }],
}, users[0].id);
saveSetting(storeId, 'theme', {
  ...DEFAULTS.theme, app_name: 'Kopi Senja POS', accent: '#b1663b', canvas: '#faf6f1', radius: 14,
  density: 'comfortable', font: 'system', mode: 'light', bg_pattern: 'dots', sidebar_width: 240,
  menu: DEFAULTS.theme.menu,
}, users[0].id);
saveSetting(storeId, 'pos', {
  ...DEFAULTS.pos, quick_amounts: [20000, 50000, 100000], default_order_type: 'take_away', show_raw_preview: true,
}, users[0].id);
saveSetting(storeId, 'rbac', {
  roles: Object.fromEntries(Object.entries(ROLE_PRESETS).map(([k, v]) => [k, v.permissions])),
}, users[0].id);

// ------------------------------------------------------------------ 4. kategori
const cats = [
  { id: uid('cat'), name: 'Kopi Susu', sort_order: 1, color: '#8b5e34' },
  { id: uid('cat'), name: 'Americano & Black', sort_order: 2, color: '#3f3f46' },
  { id: uid('cat'), name: 'Non-Kopi', sort_order: 3, color: '#4d7c0f' },
  { id: uid('cat'), name: 'Pastry', sort_order: 4, color: '#d97706' },
  { id: uid('cat'), name: 'Lainnya', sort_order: 9, color: '#6b7280' },
];
for (const c of cats) exec(`INSERT INTO categories (id, store_id, name, sort_order, color, is_active) VALUES (?,?,?,?,?,1)`, c.id, storeId, c.name, c.sort_order, c.color);

// ------------------------------------------------------------------ 5. bahan baku
const RAW = [
  { key: 'biji',   name: 'Biji Kopi House Blend', unit: 'gr',  cost: 0.55,  opening: 26000,  min: 4000,  lead: 5, supplier: 'PT Roastery Nusantara' },
  { key: 'susu',   name: 'Susu UHT Full Cream',   unit: 'ml',  cost: 0.018, opening: 95000,  min: 20000, lead: 2, supplier: 'CV Maju Susu' },
  { key: 'gula',   name: 'Gula Aren Cair',         unit: 'ml',  cost: 0.03,  opening: 14000,  min: 3000,  lead: 3, supplier: 'CV Maju Susu' },
  { key: 'cup',    name: 'Cup Plastik 16oz + Lid', unit: 'pcs', cost: 1300,  opening: 2600,   min: 600,   lead: 7, supplier: 'CV Kemas Mandiri' },
  { key: 'es',     name: 'Es Batu Food Grade',     unit: 'gr',  cost: 0.002, opening: 140000, min: 30000, lead: 1, supplier: 'CV Es Sentosa' },
  { key: 'matcha', name: 'Matcha Premium',         unit: 'gr',  cost: 1.6,   opening: 2600,   min: 500,   lead: 6, supplier: 'Importmatcha ID' },
  { key: 'dough',  name: 'Dough Croissant Beku',   unit: 'pcs', cost: 4200,  opening: 420,    min: 120,   lead: 4, supplier: 'Bakery Prima' },
  { key: 'mentega', name: 'Mentega Tawar',         unit: 'gr',  cost: 0.12,  opening: 16000,  min: 4000,  lead: 4, supplier: 'Bakery Prima' },
  { key: 'kertas', name: 'Tumpeng / Paper Bag',    unit: 'pcs', cost: 700,   opening: 3200,   min: 800,   lead: 7, supplier: 'CV Kemas Mandiri' },
];
const rawId = {};
for (const r of RAW) {
  const id = uid('itm');
  rawId[r.key] = id;
  exec(`INSERT INTO items (id, store_id, name, item_type, unit, cost_price, selling_price, stock_qty, min_stock,
            lead_time_days, supplier_name, tax_mode, is_non_stock, is_active)
        VALUES (?,?,?,'raw',?,?, 0, 0, ?,?,?, 'inherit',0,1)`,
    // stock_qty & selling_price = 0 literal (stok awal diisi lewat ledger); kolom ke-9..11 = min_stock, lead, supplier
    id, storeId, r.name, r.unit, r.cost, r.min, r.lead, r.supplier);
}

// ------------------------------------------------------------------ 6. barang jadi
const FIN = [
  { key: 'kopisusu', name: 'Kopi Susu Gula Aren', price: 20000, cat: 0, mode: 'make_to_order', yield: 100,
    bom: [['biji', 18, 2], ['susu', 120, 0], ['gula', 25, 3], ['cup', 1, 0], ['es', 120, 8]], addons: 'shot' },
  { key: 'kopipanaskopi', name: 'Kopi Susu Panas', price: 21000, cat: 0, mode: 'make_to_order',
    bom: [['biji', 18, 2], ['susu', 150, 0], ['gula', 22, 3]] },
  { key: 'americano', name: 'Americano', price: 18000, cat: 1, mode: 'make_to_order',
    bom: [['biji', 20, 2], ['cup', 1, 0], ['es', 100, 8]] },
  { key: 'espresso', name: 'Single Espresso', price: 16000, cat: 1, mode: 'make_to_order',
    bom: [['biji', 9, 2]] },
  { key: 'matcha', name: 'Matcha Latte', price: 25000, cat: 2, mode: 'make_to_order',
    bom: [['matcha', 4, 1], ['susu', 150, 0], ['gula', 15, 3], ['cup', 1, 0], ['es', 100, 8]] },
  { key: 'croissant', name: 'Butter Croissant', price: 17000, cat: 3, mode: 'make_to_stock', opening: 260,
    bom: [['dough', 1, 0], ['mentega', 12, 5]] },
  { key: 'paketbelajar', name: 'Paket Belajar (2 Kopi + Air)', price: 35000, cat: 4, mode: 'make_to_order',
    bom: [['biji', 36, 2], ['susu', 240, 0], ['gula', 50, 3], ['cup', 2, 0], ['es', 240, 8], ['kertas', 1, 0]] },
  { key: 'tumpeng', name: 'Paper Bag Tambahan', price: 1000, cat: 4, mode: 'make_to_stock', opening: 400,
    bom: [['kertas', 1, 0]] },
  { key: 'jasa', name: 'Titip Belanja (Jasa)', price: 5000, cat: 4, mode: 'make_to_stock', nonStock: true, bom: [] },
];
const finId = {};
for (const f of FIN) {
  const id = uid('itm');
  finId[f.key] = id;
  exec(`INSERT INTO items (id, store_id, name, item_type, category_id, sku, unit, cost_price, selling_price, stock_qty,
            min_stock, lead_time_days, production_mode, yield_pct, is_non_stock, is_active, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, storeId, f.name, 'finished', cats[f.cat].id, 'SKU-' + f.key.toUpperCase().slice(0, 8), 'pcs', 0,
    f.price, 0, 0, 3, f.mode || 'make_to_order', f.yield ?? 100,
    f.nonStock ? 1 : 0, 1, f.nonStock ? 'Item jasa, stok tidak dilacak' : null);
  if (f.nonStock) exec(`UPDATE items SET min_stock = 0 WHERE id = ?`, id);
  if (!f.nonStock) exec(`UPDATE items SET min_stock = ? WHERE id = ?`, f.mode === 'make_to_stock' ? 8 : 0, id);
  (f.bom || []).forEach(([key, qty, waste], i) => {
    exec(`INSERT INTO item_recipes (id, parent_id, raw_item_id, qty, unit, waste_pct, is_optional, sort_order)
          VALUES (?,?,?,?,?,?,0,?)`, uid('rcp'), id, rawId[key], qty, RAW.find((r) => r.key === key).unit, waste, i);
  });
  if (f.addons === 'shot') {
    exec(`INSERT INTO item_addons (id, item_id, name, price_delta, raw_item_id, raw_qty, is_required, sort_order) VALUES
          (?,?,?, ?,?,?,0,0), (?,?,?, ?,?,?,0,1)`,
      uid('adn'), id, 'Extra shot espresso', 6000, rawId.biji, 9,
      uid('adn'), id, 'Less ice', 0, null, 0);
  }
}
// stok awal (via ledger!) untuk bahan baku & barang jadi make_to_stock
for (const r of RAW) {
  postMovement({ storeId, branchId: branchA, itemId: rawId[r.key], type: 'adjustment', qty: r.opening, unitCost: r.cost, refType: 'manual', refId: 'opening', reason: 'Stok awal toko', userId: users[1].id, createdAt: nowIso() });
}
for (const f of FIN) {
  if (f.mode === 'make_to_stock' && f.opening) {
    const consumed = [];
    for (const [key, qty] of f.bom || []) consumed.push([rawId[key], qty * f.opening]);
    for (const [id2, q] of consumed) postMovement({ storeId, branchId: branchA, itemId: id2, type: 'bom_consume', qty: -q, refType: 'production', refId: 'opening-produksi', reason: 'Produksi awal', userId: users[1].id });
    postMovement({ storeId, branchId: branchA, itemId: finId[f.key], type: 'production_in', qty: f.opening, unitCost: 0, refType: 'production', refId: 'opening-produksi', reason: 'Produksi awal', userId: users[1].id });
  }
}

// ------------------------------------------------------------------ 7. pajak & diskon
exec(`INSERT INTO taxes (id, store_id, name, rate_pct, is_inclusive, is_active, is_default, sort_order) VALUES (?,?,?, ?,0,1,1,0)`,
  uid('tax'), storeId, 'PPn 11%', 11);
exec(`INSERT INTO taxes (id, store_id, name, rate_pct, is_inclusive, is_active, is_default, sort_order) VALUES (?,?,?, ?,1,0,0,1)`,
  uid('tax'), storeId, 'Pajak Daerah 10% (uji)', 10);

const DISC = [
  { name: 'Pelanggan Setia (10%)', kind: 'percent', value: 10, applies_to: 'global', trigger: 'manual', stackable: 0 },
  { name: 'Promo Senin Rabu Jumat', kind: 'percent', value: 10, applies_to: 'global', trigger: 'auto_weekday', days: [1, 3, 5], stackable: 0 },
  { name: 'Happy Hour 15:00-17:00', kind: 'percent', value: 15, applies_to: 'item', ref_ids: [finId.kopisusu, finId.americano], trigger: 'auto_time', start_time: '15:00', end_time: '17:00', max_discount: 8000, stackable: 0 },
  { name: 'Potongan Kirim Rp3.000', kind: 'fixed', value: 3000, applies_to: 'global', trigger: 'auto_min_subtotal', min_subtotal: 60000, stackable: 1 },
];
for (const d of DISC) {
  exec(`INSERT INTO discounts (id, store_id, name, kind, value, applies_to, ref_ids, trigger, days, start_time, end_time, min_subtotal, max_discount, stackable, is_active)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    uid('dsc'), storeId, d.name, d.kind, d.value, d.applies_to || 'global', d.ref_ids ? JSON.stringify(d.ref_ids) : null,
    d.trigger, d.days ? JSON.stringify(d.days) : null, d.start_time || null, d.end_time || null,
    d.min_subtotal || 0, d.max_discount ?? null, d.stackable || 0, 1);
}

const PM = [
  { name: 'Tunai', kind: 'cash', icon: '💵', fee: 0, def: 1 },
  { name: 'QRIS', kind: 'qris', icon: '📱', fee: 0.7 },
  { name: 'GoPay', kind: 'wallet', icon: '🟢', fee: 0.5 },
  { name: 'OVO', kind: 'wallet', icon: '🟣', fee: 0.5 },
  { name: 'Kartu Debit', kind: 'debit', icon: '💳', fee: 0.4 },
  { name: 'Transfer Bank', kind: 'transfer', icon: '🏦', fee: 0 },
];
const pmIds = {};
for (const [i, p] of PM.entries()) {
  const id = uid('pay');
  pmIds[p.name] = id;
  exec(`INSERT INTO payment_methods (id, store_id, name, kind, icon, service_fee_pct, is_enabled, is_default, sort_order)
        VALUES (?,?,?,?,?,?,?,?,?)`, id, storeId, p.name, p.kind, p.icon, p.fee, 1, p.def ? 1 : 0, i);
}

// ------------------------------------------------------------------ 8. supplier
for (const [i, s] of [...new Set(RAW.map((r) => r.supplier))].entries()) {
  exec(`INSERT INTO suppliers (id, store_id, name, contact, phone, email, lead_time_days, notes) VALUES (?,?,?,?,?,?,?,?)`,
    uid('sup'), storeId, s, 'Bagian Penjualan', '0812-3456-' + (7000 + i), 'sales@' + s.toLowerCase().replace(/[^a-z]/g, '') + '.id', 2 + i, null);
}

// HPP barang jadi disinkronkan dari biaya bahan bakunya
const syncAllCosts = () => {
  for (const r of allRows(`SELECT i.id, i.yield_pct FROM items i WHERE i.item_type = 'finished' AND i.store_id = ?`, storeId)) {
    const rows = allRows(`SELECT r.qty, r.waste_pct, x.cost_price FROM item_recipes r JOIN items x ON x.id = r.raw_item_id WHERE r.parent_id = ?`, r.id);
    if (!rows.length) continue;
    const per = rows.reduce((s2, x) => s2 + x.qty * x.cost_price * (1 + x.waste_pct / 100), 0);
    exec(`UPDATE items SET cost_price = ? WHERE id = ?`, round2(per / Math.max(1, (r.yield_pct || 100) / 100)), r.id);
  }
};
syncAllCosts();

// ------------------------------------------------------------------ 9. transaksi 30 hari
log('   membuat riwayat penjualan 30 hari...');
const rnd = (seed => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(42);
const combos = [
  [['kopisusu', 1]], [['kopisusu', 2], ['croissant', 1]], [['americano', 1]], [['matcha', 1]],
  [['espresso', 1], ['tumpeng', 1]], [['paketbelajar', 1]], [['kopipanaskopi', 1]],
  [['kopisusu', 1], ['matcha', 1], ['croissant', 2]], [['croissant', 1]], [['americano', 2]],
];
let created = 0;
for (let back = 29; back >= 0; back -= 1) {
  const day = new Date(Date.now() - back * 86400000);
  const salesCount = 6 + Math.floor(rnd() * 9) + (day.getDay() === 0 || day.getDay() === 6 ? 4 : 0);
  for (let s = 0; s < salesCount; s += 1) {
    const hour = 8 + Math.floor(rnd() * 12);
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, Math.floor(rnd() * 60));
    const stamp = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:00`;
    const lines = combos[Math.floor(rnd() * combos.length)].map(([key, qty]) => ({ item_id: finId[key], qty }));
    const pm = Object.keys(pmIds)[Math.floor(rnd() * Object.keys(pmIds).length)];
    try {
      const out = tx(() => createSale({
        storeId, branchId: rnd() > 0.6 ? branchB : branchA, userId: users[3 + Math.floor(rnd() * 2)].id,
        cashierName: users[3 + Math.floor(rnd() * 2)].display_name, lines, paymentMethodId: pmIds[pm],
        paidAmount: null, orderType: rnd() > 0.5 ? 'take_away' : 'dine_in', externalRef: `seed-${back}-${s}`,
      }));
      exec(`UPDATE transactions SET created_at = ? WHERE id = ?`, stamp, out.id);
      exec(`UPDATE stock_movements SET created_at = ? WHERE ref_id = ? AND ref_type = 'transaction'`, stamp, out.id);
      created += 1;
    } catch (err) {
      if (!/tidak cukup/.test(err.message)) console.warn('   skip:', err.message);
    }
  }
}

// ------------------------------------------------------------------ 10. pembelian bahan (PO)
const poId = uid('po');
exec(`INSERT INTO purchase_orders (id, store_id, po_number, supplier_id, branch_id, status, order_date, expected_date, total_amount, note, created_by, created_at)
      VALUES (?,?,?,?,?,'received', datetime('now','-9 days'), datetime('now','-5 days'), ?,'Restock mingguan', ?, datetime('now','-9 days'))`,
  poId, storeId, `PO${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-01`,
  firstRow(`SELECT id FROM suppliers WHERE store_id = ? AND name = 'PT Roastery Nusantara'`, storeId)?.id,
  branchA, 5500000, users[1].id);
exec(`INSERT INTO purchase_order_items (id, po_id, raw_item_id, qty_ordered, qty_received, unit_cost) VALUES (?,?,?, 6000, 6000, 0.55)`, uid('poi'), poId, rawId.biji);
postMovement({ storeId, branchId: branchA, itemId: rawId.biji, type: 'purchase_in', qty: 6000, unitCost: 0.55, refType: 'purchase_order', refId: poId, reason: 'Restock mingguan', userId: users[1].id, createdAt: nowIso() });
// dua bahan sengaja ditipiskan supaya fitur peringatan & proyeksi kehabisan langsung terlihat
salesMod.setQuietAlerts(true); // jangan spam alert saat menata data demo
const drain = (key, target) => {
  const cur = firstRow(`SELECT stock_qty FROM items WHERE id = ?`, rawId[key]).stock_qty;
  const qty = Math.round((target - cur) * 1e6) / 1e6;
  if (qty !== 0) postMovement({ storeId, branchId: branchA, itemId: rawId[key], type: 'adjustment', qty, refType: 'manual', refId: 'demo-lowstock', reason: 'Demo stok menipis (susut)', userId: users[1].id });
};
drain('matcha', 420);   // < min 500 -> warning & proyeksi kehabisan
drain('es', 45000);     // laju pemakaian tinggi -> peringatan hari-hari terakhir
drain('cup', 700);      // sedikit di atas reorder point
salesMod.setQuietAlerts(false);

// --------------------------------------------------------- finalisasi demo
// PO & penipisan stok ditulis setelah transaksi historis -> sinkronkan & buat alert di akhir.
syncAllCosts();
const rec = reconcileStock(storeId);
log('   rekonsiliasi stok: %d item diselaraskan dari ledger', rec.fixed);
exec(`DELETE FROM alerts`); exec(`DELETE FROM alert_reads`);
const alertRun = generateAlerts(storeId, { days: 30, lookaheadDays: 14 });
log(`✅ Seed selesai: ${created} transaksi, ${RAW.length} bahan baku, ${FIN.length} barang jadi`);
if (QUIET) console.log('KASIR_READY');
console.log('');
console.log('   Login demo (semua password: rahasia123)');
console.log('   ┌──────────┬────────────────────────┐');
console.log('   │ budi     │ Pemilik (akses penuh)  │');
console.log('   │ rina     │ Manajer                │');
console.log('   │ sari     │ Manajer Inventaris     │');
console.log('   │ dewi/adi │ Kasir                  │');
console.log('   └──────────┴────────────────────────┘');
console.log('   PIN kasir: dewi=4444, adi=5555');
void allRows; void FORCE;

// Pastikan proses keluar bersih (dipanggil juga oleh tes integrasi).
if (!process.env.KASIR_KEEP_OPEN) {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* noop */ }
  process.exit(0);
}
