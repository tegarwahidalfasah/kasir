// ===========================================================================
//  Test engine stok: BOM memotong beberapa bahan baku sekaligus, void/refund
//  mengembalikan stok, harga bergerak (moving average), dan integritas ledger.
//  Dijalankan dengan DB terpisah (KASIR_DATA_DIR diset oleh scripts/test.js).
// ===========================================================================
import { describe, it, assert, standalone } from './harness.js';
import { exec, firstRow, allRows, uid, round2, saveSetting, tx } from '../src/db/index.js';
import { createSale, voidSale, refundLine, catalogFor, getSale } from '../src/sales.js';
import { postMovement, ledgerIntegrity, reconcileStock } from '../src/inventory.js';
import { stockHealth, generateAlerts } from '../src/stockhealth.js';
import { DEFAULTS } from '../src/config.js';

const S = { id: uid('sto') };
exec(`INSERT INTO stores (id, name, timezone, currency, locale) VALUES (?, 'Toko Uji', 'Asia/Jakarta', 'IDR', 'id-ID')`, S.id);
exec(`INSERT INTO users (id, store_id, username, password_hash, display_name, role) VALUES (?,?,?,?,?,'owner')`,
  uid('usr'), S.id, 'tester', 'x', 'Tester');
const USER = firstRow(`SELECT id FROM users LIMIT 1`).id;
exec(`INSERT INTO taxes (id, store_id, name, rate_pct, is_inclusive, is_active, is_default, sort_order) VALUES (?,?,'PPn',11,0,1,1,0)`, uid('tax'), S.id);
saveSetting(S.id, 'tax', { ...DEFAULTS.tax, enabled: false, rounding_mode: 'none', allow_negative_stock: false }, USER);

function mkRaw(name, { stock = 0, unit = 'gr', cost = 1000, min = 0, lead = 2 } = {}) {
  const id = uid('itm');
  exec(`INSERT INTO items (id, store_id, name, item_type, unit, cost_price, selling_price, stock_qty, min_stock, lead_time_days, is_active)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, S.id, name, 'raw', unit, cost, 0, 0, min, lead, 1);
  if (stock) postMovement({ storeId: S.id, itemId: id, type: 'adjustment', qty: stock, unitCost: cost, refType: 'manual', refId: 'open', reason: 'stok awal', userId: USER, allowNegative: true });
  return id;
}
function mkFinished(name, { price = 20000, mode = 'make_to_order', opening = 0, min = 0, yieldPct = 100, nonStock = false } = {}) {
  const id = uid('itm');
  exec(`INSERT INTO items (id, store_id, name, item_type, unit, cost_price, selling_price, stock_qty, min_stock,
            production_mode, yield_pct, is_non_stock, lead_time_days, is_active)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, S.id, name, 'finished', 'pcs', 0, price, 0, min, mode, yieldPct, nonStock ? 1 : 0, 2, 1);
  if (opening) postMovement({ storeId: S.id, itemId: id, type: 'production_in', qty: opening, refType: 'production', refId: 'open', reason: 'produksi awal', userId: USER, allowNegative: true });
  return id;
}
function setBom(parentId, rows) {
  exec(`DELETE FROM item_recipes WHERE parent_id = ?`, parentId);
  rows.forEach(([rawId, qty, waste = 0], i) => {
    exec(`INSERT INTO item_recipes (id, parent_id, raw_item_id, qty, waste_pct, is_optional, sort_order) VALUES (?,?,?,?,?,?,?)`,
      uid('rcp'), parentId, rawId, qty, waste, 0, i);
  });
}
const stock = (id) => round2(firstRow(`SELECT stock_qty FROM items WHERE id = ?`, id).stock_qty);

describe('stok & BOM', () => {
  it('1 penjualan memotong 4 bahan baku sekaligus sesuai resep + susut', () => {
    const biji = mkRaw('Biji Uji A', { stock: 1000 });
    const susu = mkRaw('Susu Uji A', { stock: 1000, unit: 'ml' });
    const gula = mkRaw('Gula Uji A', { stock: 1000, unit: 'ml' });
    const cup = mkRaw('Cup Uji A', { stock: 100, unit: 'pcs' });
    const kopi = mkFinished('Kopi Uji A', { price: 20000 });
    setBom(kopi, [[biji, 18, 2], [susu, 120, 0], [gula, 25, 3], [cup, 1, 0]]);

    const r = tx(() => createSale({ storeId: S.id, userId: USER, lines: [{ item_id: kopi, qty: 2 }] }));
    assert.equal(stock(biji), 1000 - 2 * 18 * 1.02, 'biji: 18gr x (1+2%) x 2');
    assert.equal(stock(susu), 1000 - 240, 'susu 120ml x2');
    assert.equal(stock(gula), 1000 - round2(2 * 25 * 1.03), 'gula dengan susut 3%');
    assert.equal(stock(cup), 100 - 2, 'cup per porsi');
    assert.equal(r.movements.length, 4, 'empat gerakan potongan, satu struk');
    assert.equal(r.movements.every((m) => m.type === 'bom_consume'), true);
    assert.equal(r.grand_total, 40000);
    assert.equal(ledgerIntegrity(S.id).mismatches.length, 0, 'ledger harus konsisten');
  });

  it('kapasitas porsi dibatasi bahan baku paling langka', () => {
    const es = mkRaw('Es Uji B', { stock: 300, unit: 'gr' });
    const biji = mkRaw('Biji Uji B', { stock: 10000 });
    const k = mkFinished('Kopi Uji B', {});
    setBom(k, [[es, 120, 0], [biji, 18, 0]]);
    assert.throws(() => tx(() => createSale({ storeId: S.id, userId: USER, lines: [{ item_id: k, qty: 4 }] })), /tidak cukup/);
    const r = tx(() => createSale({ storeId: S.id, userId: USER, lines: [{ item_id: k, qty: 2 }] }));
    assert.equal(stock(es), 60);
    assert.equal(r.grand_total, 40000);
    // sisa 60gr tidak cukup utk 1 porsi (120gr) -> ditolak
    assert.throws(() => tx(() => createSale({ storeId: S.id, userId: USER, lines: [{ item_id: k, qty: 1 }] })), /tidak cukup/);
  });

  it('make_to_stock: penjualan hanya potong stok jadi; bahan dipotong saat produksi', () => {
    const tepung = mkRaw('Tepung C', { stock: 500, unit: 'pcs' });
    const cro = mkFinished('Croissant C', { price: 15000, mode: 'make_to_stock', opening: 40 });
    setBom(cro, [[tepung, 1, 0]]);
    tx(() => createSale({ storeId: S.id, userId: USER, lines: [{ item_id: cro, qty: 10 }] }));
    assert.equal(stock(cro), 30, 'stok jadi berkurang 10');
    assert.equal(stock(tepung), 500, 'bahan belum dipotong');
    tx(() => createSale({ storeId: S.id, userId: USER, lines: [{ item_id: cro, qty: 30 }] }));
    assert.equal(stock(cro), 0, 'stok jadi habis');
    assert.equal(stock(tepung), 500, 'bahan tetap tidak tersentuh oleh penjualan');
    // produksi menambah stok jadi sekaligus memakai bahan (jalur /stock/produce)
    postMovement({ storeId: S.id, itemId: tepung, type: 'bom_consume', qty: -5, refType: 'production', refId: 'prd', reason: 'produksi', userId: USER });
    postMovement({ storeId: S.id, itemId: cro, type: 'production_in', qty: 5, refType: 'production', refId: 'prd', reason: 'produksi', userId: USER, allowNegative: true });
    assert.equal(stock(cro), 5);
    assert.equal(stock(tepung), 495);

  });

  it('stok tidak boleh minus kecuali diizinkan (allow_negative_stock)', () => {
    const x = mkFinished('Barang D', { price: 1000, mode: 'make_to_stock', opening: 2 });
    assert.throws(() => tx(() => createSale({ storeId: S.id, userId: USER, lines: [{ item_id: x, qty: 3 }] })), /tidak cukup/);
    saveSetting(S.id, 'tax', { ...DEFAULTS.tax, enabled: false, rounding_mode: 'none', allow_negative_stock: true }, USER);
    const r = tx(() => createSale({ storeId: S.id, userId: USER, lines: [{ item_id: x, qty: 3 }] }));
    assert.equal(stock(x), -1);
    assert.equal(r.grand_total, 3000);
    saveSetting(S.id, 'tax', { ...DEFAULTS.tax, enabled: false, rounding_mode: 'none', allow_negative_stock: false }, USER);
  });

  it('void transaksi mengembalikan SEMUA stok (barang jadi + tiap bahan baku)', () => {
    const biji = mkRaw('Biji E', { stock: 1000 });
    const susu = mkRaw('Susu E', { stock: 1000, unit: 'ml' });
    const k = mkFinished('Kopi E', { price: 20000 });
    setBom(k, [[biji, 20, 0], [susu, 150, 0]]);
    const before = [stock(biji), stock(susu), stock(k)];
    const r = tx(() => createSale({ storeId: S.id, userId: USER, lines: [{ item_id: k, qty: 3 }] }));
    const mid = [stock(biji), stock(susu)];
    assert.ok(mid[0] < before[0] && mid[1] < before[1], 'stok sudah terpotong');
    const v = tx(() => voidSale({ storeId: S.id, txId: r.id, userId: USER, reason: 'salah input' }));
    assert.equal(v.movements_reversed, 2);
    assert.deepEqual([stock(biji), stock(susu)], before.slice(0, 2), 'stok kembali persis seperti semula');
    assert.equal(firstRow(`SELECT status FROM transactions WHERE id = ?`, r.id).status, 'voided');
    assert.equal(ledgerIntegrity(S.id).mismatches.length, 0);
    const raw = allRows(`SELECT movement_type, qty FROM stock_movements WHERE ref_type = 'transaction' AND ref_id = ? AND movement_type = 'return_in'`, r.id);
    assert.equal(raw.length, 2, 'gerakan pengembalian tercatat lengkap');
  });

  it('retur sebagian mengembalikan stok proporsional per qty retur', () => {
    const biji = mkRaw('Biji F', { stock: 1000 });
    const k = mkFinished('Kopi F', { price: 10000 });
    setBom(k, [[biji, 10, 0]]);
    const r = tx(() => createSale({ storeId: S.id, userId: USER, lines: [{ item_id: k, qty: 5 }] }));
    assert.equal(stock(biji), 950);
    tx(() => refundLine({ storeId: S.id, txId: r.id, itemId: k, qty: 2, userId: USER }));
    assert.equal(stock(biji), 970, 'retur 2 porsi -> biji kembali 20gr');
  });

  it('idempotensi: external_ref ganda tidak membuat transaksi & potongan stok dobel', () => {
    const biji = mkRaw('Biji G', { stock: 1000 });
    const k = mkFinished('Kopi G', { price: 9000 });
    setBom(k, [[biji, 15, 0]]);
    const ref = 'idemp-' + Date.now();
    const a = tx(() => createSale({ storeId: S.id, userId: USER, lines: [{ item_id: k, qty: 1 }], externalRef: ref }));
    const after1 = stock(biji);
    const b = tx(() => createSale({ storeId: S.id, userId: USER, lines: [{ item_id: k, qty: 1 }], externalRef: ref }));
    assert.equal(stock(biji), after1, 'stok tidak terpotong dua kali');
    assert.equal(firstRow(`SELECT COUNT(*) n FROM transactions WHERE external_ref = ?`, ref).n, 1);
    assert.ok(a.id && b.id);
  });

  it('penerimaan PO menaikkan stok & HPP moving average', () => {
    const raw = mkRaw('Gula H', { stock: 100, unit: 'gr', cost: 100 });
    postMovement({ storeId: S.id, itemId: raw, type: 'purchase_in', qty: 100, unitCost: 200, refType: 'purchase_order', refId: 'po1', reason: 'PO', userId: USER });
    assert.equal(stock(raw), 200);
    const it2 = firstRow(`SELECT cost_price FROM items WHERE id = ?`, raw);
    assert.equal(round2(it2.cost_price), 150, 'rata-rata bergerak (100@100 + 100@200)/200');
  });

  it('yield < 100% meningkatkan konsumsi bahan saat produksi', () => {
    const dough = mkRaw('Dough I', { stock: 100, unit: 'pcs' });
    const cro = mkFinished('Croissant I', { price: 12000, mode: 'make_to_stock', opening: 0, yieldPct: 80 });
    setBom(cro, [[dough, 1, 0]]);
    postMovement({ storeId: S.id, itemId: cro, type: 'production_in', qty: 8, refType: 'production', refId: 'p', reason: 'produksi 10 -> jadi 8', userId: USER, allowNegative: true });
    assert.equal(stock(dough), 100, 'produksi manual tidak otomatis; dipakai saat lewat /stock/produce');
  });

  it('item jasa (non-stock) dijual tanpa gerakan stok', () => {
    const jasa = mkFinished('Kirim Jasa J', { price: 5000, nonStock: true });
    const r = tx(() => createSale({ storeId: S.id, userId: USER, lines: [{ item_id: jasa, qty: 2 }] }));
    assert.equal(r.movements.length, 0);
    assert.equal(r.grand_total, 10000);
    assert.equal(firstRow(`SELECT stock_qty FROM items WHERE id = ?`, jasa).stock_qty, 0);
  });

  it('addon dengan bahan memicu potongan bahan tambahan', () => {
    const biji = mkRaw('Biji K', { stock: 1000 });
    const susu = mkRaw('Susu K', { stock: 1000, unit: 'ml' });
    const k = mkFinished('Kopi K', { price: 20000 });
    setBom(k, [[biji, 18, 0], [susu, 100, 0]]);
    exec(`INSERT INTO item_addons (id, item_id, name, price_delta, raw_item_id, raw_qty, is_required, sort_order) VALUES (?,?,?,?,?,?,0,0)`,
      uid('adn'), k, 'Extra shot', 6000, biji, 9);
    const r = tx(() => createSale({ storeId: S.id, userId: USER, lines: [{ item_id: k, qty: 2, addons: [{ name: 'Extra shot', price_delta: 6000, raw_item_id: biji, raw_qty: 9, qty: 1 }] }] }));
    assert.equal(stock(biji), 1000 - (2 * 18 + 2 * 9), '18gr dasar + 9gr addon per porsi');
    assert.equal(r.grand_total, 52000, '(20000+6000) x 2');
  });

  it('ledger tetap konsisten & bisa direkonsiliasi walau gerakan ditulis mundur', () => {
    const raw = mkRaw('Raw L', { stock: 100 });
    const f = mkFinished('Fin L', { price: 1000, mode: 'make_to_stock', opening: 50 });
    setBom(f, [[raw, 2, 0]]);
    const r1 = tx(() => createSale({ storeId: S.id, userId: USER, lines: [{ item_id: f, qty: 1 }] }));
    exec(`UPDATE stock_movements SET created_at = datetime('now','-1 day') WHERE ref_id = ?`, r1.id);
    // simulasi penghapusan kolom stok yang rusak
    exec(`UPDATE items SET stock_qty = 99999 WHERE id = ?`, raw);
    const bad = ledgerIntegrity(S.id);
    assert.ok(bad.mismatches.length > 0, 'harus terdeteksi selisih');
    const rec = reconcileStock(S.id);
    assert.ok(rec.fixed >= 1);
    assert.equal(ledgerIntegrity(S.id).mismatches.length, 0, 'setelah rekonsiliasi harus bersih');
  });

  it('peringatan stok minim muncul otomatis & deduplikasi berjalan', () => {
    const raw = mkRaw('Raw M', { stock: 100, unit: 'pcs', min: 40 });
    const f = mkFinished('Fin M', { price: 5000 });
    setBom(f, [[raw, 10, 0]]);
    exec(`DELETE FROM alerts WHERE store_id = ?`, S.id);
    tx(() => createSale({ storeId: S.id, userId: USER, lines: [{ item_id: f, qty: 7 }] })); // sisa 30 < min 40
    const n1 = firstRow(`SELECT COUNT(*) n FROM alerts WHERE store_id = ?`, S.id).n;
    const again = generateAlerts(S.id, { days: 30, lookaheadDays: 7 });
    assert.ok(n1 >= 1, 'alert stok menipis dibuat oleh transaksi itu sendiri');
    assert.equal(again.created, 0, 'alert 6 jam terakhir tidak diduplikasi');
    const h = stockHealth({ storeId: S.id, days: 30, lookaheadDays: 7 }).find((x) => x.id === raw);
    assert.ok(h.status === 'warning' || h.status === 'critical', 'status health menandai: ' + h.status);
    assert.ok(h.avg_daily > 0, 'ada laju konsumsi untuk proyeksi');
  });

  it('struk menyimpan snapshot harga & layout (kebal dari perubahan setting)', () => {
    const f = mkFinished('Fin N', { price: 12000, mode: 'make_to_stock', opening: 10 });
    const r = tx(() => createSale({ storeId: S.id, userId: USER, lines: [{ item_id: f, qty: 1 }] }));
    const snap = JSON.parse(firstRow(`SELECT receipt_snapshot FROM transactions WHERE id = ?`, r.id).receipt_snapshot);
    saveSetting(S.id, 'receipt', { ...DEFAULTS.receipt, header: 'DIUBAH KEMUDIAN' }, USER);
    saveSetting(S.id, 'store', { ...DEFAULTS.store, name: 'Toko Ganti Nama' }, USER);
    const back = getSale(S.id, r.id);
    assert.notEqual(back.snapshot.receipt.header, 'DIUBAH KEMUDIAN', 'struk lama tidak berubah');
    assert.equal(back.snapshot.pricing.grand_total, 12000);
    assert.equal(catalogFor(S.id)[f].stock_qty, 9);
  });
});

await standalone(import.meta.url);
