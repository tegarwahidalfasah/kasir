// ===========================================================================
//  Modul Transaksi Kasir (Fase 2) — keranjang, kalkulasi, pembayaran, dan
//  PEMOTONGAN STOK Otomatis (barang jadi + seluruh bahan baku di BOM-nya).
//  Semuanya dalam SATU transaksi DB: struk tercatat <=> stok terpotong.
// ===========================================================================
import { allRows, firstRow, exec, uid, nowIso, round2, loadSetting } from './db/index.js';
import { DEFAULTS } from './config.js';
import { calculatePrice, bomUnitCost } from './pricing.js';
import { postMovement, reverseMovements } from './inventory.js';
import { recipesFor, planStockImpact } from './bom.js';
import { generateAlerts } from './stockhealth.js';
import { AppError } from './lib/http.js';

export function catalogFor(storeId) {
  const rows = allRows(
    `SELECT id, name, item_type, category_id, sku, barcode, unit, cost_price, selling_price,
            tax_mode, tax_rate, stock_qty, min_stock, reorder_point, lead_time_days, supplier_name,
            production_mode, yield_pct, is_non_stock, image, notes, is_active
     FROM items WHERE store_id = ? AND is_active = 1 ORDER BY item_type DESC, name ASC`,
    storeId
  );
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  // addon dilekatkan di sini supaya harga & bahan addon selalu diambil dari DB, bukan dari payload klien
  for (const ad of allRows(
    `SELECT a.* FROM item_addons a JOIN items i ON i.id = a.item_id
     WHERE i.store_id = ? ORDER BY a.sort_order`, storeId)) {
    const parent = byId[ad.item_id];
    if (parent) (parent.addons ||= []).push(ad);
  }
  return byId;
}

/**
 * Resolusi addon terhadap katalog server: payload klien hanya boleh menyebut `id` (atau `name`)
 * addon yang memang terdaftar pada barang itu. `price_delta`, `raw_item_id`, dan `raw_qty`
 * selalu diambil dari baris `item_addons` — jadi tidak ada cara menambah/mengubah harga lewat
 * body transaksi, dan bahan yang dipotong pasti milik toko yang sama.
 */
export function resolveAddons(catalog, itemId, addons) {
  const known = catalog?.[itemId]?.addons || [];
  if (!Array.isArray(addons) || !known.length) return [];
  const out = [];
  for (const raw of addons) {
    const row = known.find((k) => String(k.id) === String(raw?.id))
      || known.find((k) => k.name && raw?.name && k.name === raw.name);
    if (!row) continue;
    if (out.some((x) => x.id === row.id)) continue;               // satu addon cukup sekali
    out.push({
      id: row.id, name: row.name, price_delta: Number(row.price_delta) || 0,
      raw_item_id: row.raw_item_id || null, raw_qty: Number(row.raw_qty) || 0,
      qty: Math.max(1, Math.floor(Number(raw?.qty ?? 1) || 1)),
    });
  }
  return out;
}

export function activeRules(storeId) {
  const taxes = allRows(`SELECT * FROM taxes WHERE store_id = ? AND is_active = 1 ORDER BY sort_order ASC`, storeId);
  const discounts = allRows(
    `SELECT * FROM discounts WHERE store_id = ? AND is_active = 1
       AND (valid_from IS NULL OR valid_from <= date('now'))
       AND (valid_to IS NULL OR valid_to >= date('now'))`,
    storeId
  ).map((d) => ({ ...d, ref_ids: safeJson(d.ref_ids, []) }));
  const methods = allRows(`SELECT * FROM payment_methods WHERE store_id = ? ORDER BY sort_order ASC`, storeId);
  return { taxes, discounts, methods };
}

const safeJson = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };

/// Flag untuk seeder/script backoffice: jangan bangkitkan alert saat menjalankan createSale massal.
export let QUIET_ALERTS = false;
export const setQuietAlerts = (v) => { QUIET_ALERTS = !!v; };

export function nextInvoiceNo(storeId, prefix = 'INV') {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const base = `${prefix}${day}-`;
  // mulai dari nomor terbesar hari ini (bukan 20 percobaan dari 1000) supaya nomor tetap rapi
  // walau data historis/seed sudah memakai ribuan nomor pertama.
  const maxRow = firstRow(
    `SELECT MAX(CAST(substr(invoice_no, ?) AS INTEGER)) AS m FROM transactions
     WHERE store_id = ? AND invoice_no LIKE ?`, base.length + 1, storeId, `${base}%`);
  let next = Math.max(1000, (Number(maxRow?.m) || 0) + 1);
  for (let i = 0; i < 2000; i += 1, next += 1) {
    const used = firstRow(`SELECT id FROM transactions WHERE store_id = ? AND invoice_no = ?`, storeId, `${base}${next}`);
    if (!used) return `${base}${next}`;
  }
  return `${base}${Date.now()}`;
}

/**
 * Buat transaksi + potong stok.
 * @param {object} p { storeId, branchId, userId, lines, paymentMethodId, paidAmount, selectedDiscountIds,
 *                     customerName, customerPhone, orderType, note, externalRef, cashierDiscount }
 */
export function createSale(p) {
  if (!Array.isArray(p.lines) || !p.lines.length) throw new AppError(400, 'Keranjang masih kosong');
  // idempoten: external_ref yang sama -> kembalikan transaksi sebelumnya (tanpa potongan stok lagi)
  if (p.externalRef) {
    const dup = firstRow(`SELECT id FROM transactions WHERE store_id = ? AND external_ref = ?`, p.storeId, p.externalRef);
    if (dup) return { ...serializeExisting(p.storeId, dup.id), duplicated: true };
  }
  const catalog = catalogFor(p.storeId);
  const recipes = recipesFor(p.lines.map((l) => l.item_id));
  const taxCfg = loadSetting(p.storeId, 'tax', DEFAULTS.tax);
  const { taxes, discounts, methods } = activeRules(p.storeId);
  const payment = methods.find((m) => m.id === p.paymentMethodId) || methods.find((m) => m.is_default) || null;
  if (payment && payment.is_enabled === 0) throw new AppError(400, `Metode pembayaran ${payment.name} sedang dinonaktifkan`);

  const pricing = calculatePrice({
    lines: p.lines, catalog, taxConfig: taxCfg, taxes, discounts,
    selectedDiscountIds: p.selectedDiscountIds || [], paymentMethod: payment,
    date: new Date(), paidAmount: p.paidAmount ?? null,
  });

  // HPP: untuk barang jadi dengan BOM, pakai biaya bahan (lebih akurat dari cost_price statis)
  for (const line of pricing.lines) {
    const item = catalog[line.item_id];
    const bomRows = recipes[line.item_id] || [];
    if (item && bomRows.length) {
      const rawCat = Object.fromEntries(bomRows.map((r) => [r.raw_item_id, { cost_price: catalog[r.raw_item_id]?.cost_price ?? rawCost(r.raw_item_id) }]));
      line.cost_snapshot = round2(bomUnitCost(bomRows, rawCat) || line.cost_snapshot);
      line.cost_total = round2(line.cost_snapshot * line.qty);
      pricing.cost_total = round2(pricing.lines.reduce((s, l) => s + l.cost_total, 0));
      pricing.profit = round2(pricing.grand_total - pricing.cost_total - pricing.tax_total);
    }
  }

  const plan = planStockImpact({
    lines: p.lines, catalog, recipes,
    forceConsumeRaw: p.forceConsumeRaw === true,
  });
  if (plan.shortages.length && !taxCfg.allow_negative_stock) {
    const s = plan.shortages[0];
    throw new AppError(409, `Bahan baku untuk ${s.name} tidak cukup — maksimal ${s.max_by_raw} porsi tersisa`, { shortages: plan.shortages });
  }

  const txId = uid('txn');
  const invoiceNo = p.invoiceNo || nextInvoiceNo(p.storeId, storePrefix(p.storeId));
  const allowNeg = taxCfg.allow_negative_stock === true;
  const movements = [];

  for (const f of plan.finished) {
    const m = postMovement({
      storeId: p.storeId, branchId: p.branchId, itemId: f.item_id, type: 'sale_out',
      qty: -f.deduct_qty, unitCost: catalog[f.item_id]?.cost_price, refType: 'transaction',
      refId: txId, reason: invoiceNo, userId: p.userId, allowNegative: allowNeg,
    });
    if (!m.skipped) movements.push({ item_id: f.item_id, name: m.item.name, type: 'sale_out', qty: -f.deduct_qty, balance_after: m.balance_after });
  }
  for (const r of plan.raw) {
    const m = postMovement({
      storeId: p.storeId, branchId: p.branchId, itemId: r.item_id, type: 'bom_consume',
      qty: -r.qty, unitCost: catalog[r.item_id]?.cost_price, refType: 'transaction',
      refId: txId, reason: `BOM: ${r.lines.map((l) => l.parent).join(', ')}`, userId: p.userId, allowNegative: allowNeg,
    });
    if (!m.skipped) movements.push({ item_id: r.item_id, name: m.item.name, type: 'bom_consume', qty: -r.qty, balance_after: m.balance_after });
  }

  const receiptCfg = loadSetting(p.storeId, 'receipt', DEFAULTS.receipt);
  const storeCfg = loadSetting(p.storeId, 'store', DEFAULTS.store);
  const snapshot = {
    store: { name: storeCfg.name, address: storeCfg.address, phone: storeCfg.phone, logo: storeCfg.logo_data_url, npwp: storeCfg.npwp },
    receipt: receiptCfg,
    pricing: {
      subtotal: pricing.subtotal, discount_total: pricing.discount_total, tax_total: pricing.tax_total,
      service_total: pricing.service_total, rounding_total: pricing.rounding_total, grand_total: pricing.grand_total,
      fee_total: pricing.fee_total, total_due: pricing.total_due, paid_amount: pricing.paid_amount,
      change_amount: pricing.change_amount, discount_lines: pricing.discount_lines,
    },
    cashier_name: p.cashierName || null,
    printed_at: nowIso(),
  };

  exec(
    `INSERT INTO transactions
      (id, store_id, branch_id, invoice_no, external_ref, cashier_id, status, customer_name, customer_phone,
       order_type, note, subtotal, discount_total, tax_total, service_total, rounding_total, grand_total,
       cost_total, payment_method_id, paid_amount, change_amount, fee_total, applied_discounts, receipt_snapshot, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    txId, p.storeId, p.branchId || null, invoiceNo, p.externalRef || null, p.userId || null, 'completed',
    p.customerName || null, p.customerPhone || null, p.orderType || 'dine_in', p.note || null,
    pricing.subtotal, pricing.discount_total, pricing.tax_total, pricing.service_total, pricing.rounding_total,
    pricing.grand_total, pricing.cost_total, payment?.id || null, pricing.paid_amount ?? pricing.grand_total,
    pricing.change_amount, pricing.fee_total, JSON.stringify(pricing.discount_lines), JSON.stringify(snapshot), nowIso()
  );

  for (const line of pricing.lines) {
    exec(
      `INSERT INTO transaction_items
        (id, transaction_id, item_id, name_snapshot, item_type, qty, unit_price, line_discount, line_total,
         cost_snapshot, addons_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      uid('txi'), txId, line.item_id, line.name_snapshot, line.item_type, line.qty, line.unit_price,
      line.line_discount, line.line_total, line.cost_snapshot, JSON.stringify(line.addons || [])
    );
  }
  if (payment) {
    exec(
      `INSERT INTO transaction_payments (id, transaction_id, payment_method_id, amount, reference) VALUES (?,?,?,?,?)`,
      uid('pay'), txId, payment.id, pricing.total_due, p.paymentReference || null
    );
  }

  if (!QUIET_ALERTS && p.skipAlerts !== true) {
    try { generateAlerts(p.storeId, { days: taxCfg.consumption_window_days, lookaheadDays: taxCfg.alert_lookahead_days }); } catch { /* alert tidak boleh gagalkan penjualan */ }
  }

  return {
    id: txId, invoice_no: invoiceNo, ...pricing, payment, movements,
    stock_preview: plan, receipt: snapshot,
  };
}

/* Ambil transaksi tersimpan lalu bentuk ulang respons agar setara hasil createSale.
 */
function serializeExisting(storeId, txId) {
  const row = firstRow(`SELECT * FROM transactions WHERE id = ? AND store_id = ?`, txId, storeId);
  const snapshot = safeJson(row.receipt_snapshot, {});
  const pricing = snapshot.pricing || {};
  return {
    id: row.id, invoice_no: row.invoice_no, ...pricing,
    grand_total: row.grand_total, subtotal: row.subtotal, discount_total: row.discount_total,
    tax_total: row.tax_total, service_total: row.service_total, cost_total: row.cost_total,
    movements: [], receipt: snapshot,
  };
}

function rawCost(itemId) {
  return Number(firstRow(`SELECT cost_price FROM items WHERE id = ?`, itemId)?.cost_price || 0);
}
function storePrefix(storeId) {
  return loadSetting(storeId, 'store', DEFAULTS.store).invoice_prefix || 'INV';
}

/** Batalkan transaksi -> semua potongan stok dikembalikan otomatis. */
export function voidSale({ storeId, txId, userId, reason }) {
  const tx = firstRow(`SELECT * FROM transactions WHERE id = ? AND store_id = ?`, txId, storeId);
  if (!tx) throw new AppError(404, 'Transaksi tidak ditemukan');
  if (tx.status !== 'completed') throw new AppError(409, `Transaksi sudah ${tx.status}`);
  const reversed = reverseMovements({ storeId, refType: 'transaction', refId: txId, reason: reason || 'Pembatalan transaksi', userId });
  exec(`UPDATE transactions SET status='voided', voided_at=?, void_reason=?, voided_by=? WHERE id=?`, nowIso(), reason || null, userId, txId);
  return { id: txId, invoice_no: tx.invoice_no, status: 'voided', movements_reversed: reversed };
}

/** Retur sebagian: kembalikan qty tertentu per baris (stok finished + bahan baku proporsional). */
export function refundLine({ storeId, txId, itemId, qty, userId, reason }) {
  const tx = firstRow(`SELECT * FROM transactions WHERE id = ? AND store_id = ?`, txId, storeId);
  if (!tx) throw new AppError(404, 'Transaksi tidak ditemukan');
  const line = firstRow(`SELECT * FROM transaction_items WHERE transaction_id = ? AND item_id = ?`, txId, itemId);
  if (!line) throw new AppError(404, 'Barang tidak ada di transaksi ini');
  const refundQty = Math.min(Number(qty) || 0, line.qty);
  if (refundQty <= 0) throw new AppError(400, 'Jumlah retur tidak valid');

  const catalog = catalogFor(storeId);
  const recipes = recipesFor([itemId]);
  const plan = planStockImpact({ lines: [{ item_id: itemId, qty: refundQty, addons: safeJson(line.addons_json, []) }], catalog, recipes, forceConsumeRaw: true });
  const allowNeg = true;
  const moved = [];
  for (const f of plan.finished) {
    const m = postMovement({ storeId, itemId: f.item_id, type: 'return_in', qty: f.deduct_qty, unitCost: catalog[f.item_id]?.cost_price, refType: 'refund', refId: txId, reason: reason || 'Retur pelanggan', userId, allowNegative: allowNeg });
    if (!m.skipped) moved.push({ item_id: f.item_id, qty: f.deduct_qty });
  }
  for (const r of plan.raw) {
    const m = postMovement({ storeId, itemId: r.item_id, type: 'return_in', qty: r.qty, unitCost: catalog[r.item_id]?.cost_price, refType: 'refund', refId: txId, reason: `Retur BOM ${line.name_snapshot}`, userId, allowNegative: allowNeg });
    if (!m.skipped) moved.push({ item_id: r.item_id, qty: r.qty });
  }
  return { id: txId, item: line.name_snapshot, refund_qty: refundQty, movements: moved };
}

export function listSales(storeId, { from, to, limit = 100, offset = 0, status, cashierId } = {}) {
  const where = ['t.store_id = ?'];
  const params = [storeId];
  if (from) { where.push('t.created_at >= ?'); params.push(from); }
  if (to) { where.push('t.created_at <= ?'); params.push(to + ' 23:59:59'); }
  if (status) { where.push('t.status = ?'); params.push(status); }
  if (cashierId) { where.push('t.cashier_id = ?'); params.push(cashierId); }
  const rows = allRows(
    `SELECT t.*, u.display_name AS cashier_name, pm.name AS payment_name,
            (SELECT COUNT(*) FROM transaction_items ti WHERE ti.transaction_id = t.id) AS line_count,
            (SELECT COALESCE(SUM(ti.qty),0) FROM transaction_items ti WHERE ti.transaction_id = t.id) AS item_count
     FROM transactions t
     LEFT JOIN users u ON u.id = t.cashier_id
     LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
     WHERE ${where.join(' AND ')}
     ORDER BY date(t.created_at) DESC, t.created_at DESC, t.rowid DESC LIMIT ? OFFSET ?`,
    ...params, Math.min(200, Number(limit) || 100), Number(offset) || 0
  );
  return rows.map((r) => ({ ...r, receipt_snapshot: undefined }));
}

export function getSale(storeId, txId) {
  const tx = firstRow(
    `SELECT t.*, u.display_name AS cashier_name, pm.name AS payment_name, pm.kind AS payment_kind
     FROM transactions t
     LEFT JOIN users u ON u.id = t.cashier_id
     LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
     WHERE t.id = ? AND t.store_id = ?`, txId, storeId);
  if (!tx) throw new AppError(404, 'Transaksi tidak ditemukan');
  const items = allRows(`SELECT * FROM transaction_items WHERE transaction_id = ? ORDER BY rowid ASC`, txId);
  const payments = allRows(
    `SELECT p.*, pm.name FROM transaction_payments p LEFT JOIN payment_methods pm ON pm.id = p.payment_method_id WHERE p.transaction_id = ?`, txId);
  const movements = allRows(`SELECT * FROM stock_movements WHERE ref_id = ? AND ref_type IN ('transaction','refund') ORDER BY created_at ASC`, txId);
  return { ...tx, items, payments, movements, snapshot: safeJson(tx.receipt_snapshot, null) };
}
