// ===========================================================================
//  Rute POS / Transaksi (Fase 2) + pratinjau potongan bahan baku
// ===========================================================================
import express from 'express';
import { tx, allRows, firstRow, exec, loadSetting, uid } from '../db/index.js';
import { authenticate, requirePerm } from '../middleware/index.js';
import { createSale, listSales, getSale, voidSale, refundLine, catalogFor, activeRules, resolveAddons } from '../sales.js';
import { recipesFor, bomPreview, rawCapacity, planStockImpact } from '../bom.js';
import { calculatePrice } from '../pricing.js';
import { DEFAULTS } from '../config.js';
import { http, AppError } from '../lib/http.js';
import { audit } from '../auth.js';

export const router = express.Router();
const MOUNT = ''; // path sudah memuat prefiks; mount di index.js memakai '/api'
const auth = (...p) => [authenticate, ...p.map((x) => requirePerm(x))].flat();


/** Katalog kasir: barang jadi + stok + kapasitas bahan + bahan baku (untuk manajemen). */
router.get(MOUNT + '/pos/catalog', auth(['item.view', 'sale.create', 'stock.view']), http((req, res) => {
  const storeId = req.storeId;
  const catalog = catalogFor(storeId);
  const recipes = recipesFor(Object.keys(catalog));
  const addons = {};
  for (const a of allRows(`SELECT a.* FROM item_addons a JOIN items i ON i.id = a.item_id WHERE i.store_id = ? ORDER BY a.sort_order`, storeId)) {
    (addons[a.item_id] ||= []).push(a);
  }
  const items = Object.values(catalog).map((it) => ({
    ...it,
    recipe: recipes[it.id] || [],
    addons: addons[it.id] || [],
    capacity: rawCapacity(it.id, catalog, recipes),
    bom_preview: bomPreview(it.id, 1, recipes, catalog),
  }));
  res.json({ items, finished: items.filter((i) => i.item_type === 'finished'), raw: items.filter((i) => i.item_type === 'raw') });
}));

/** Pratinjau harga + potongan bahan baku (tanpa menyimpan apa pun). */
router.post(MOUNT + '/pos/preview', auth('sale.create'), http((req, res) => {
  const storeId = req.storeId;
  const catalog = catalogFor(storeId);
  const lines = normalizeLines(req.body?.lines, catalog);
  const recipes = recipesFor(lines.map((l) => l.item_id));
  const taxCfg = loadSetting(storeId, 'tax', DEFAULTS.tax);
  const { taxes, discounts, methods } = activeRules(storeId);
  const payment = methods.find((m) => m.id === req.body?.payment_method_id) || null;
  const pricing = calculatePrice({
    lines, catalog, taxConfig: taxCfg, taxes, discounts,
    selectedDiscountIds: req.body?.selected_discount_ids || [], paymentMethod: payment,
    date: new Date(), paidAmount: req.body?.paid_amount ?? null,
  });
  const impact = planStockImpact({ lines, catalog, recipes });
  res.json({
    pricing,
    stock_impact: impact,
    bom_by_line: Object.fromEntries(lines.map((l) => [l.item_id, bomPreview(l.item_id, l.qty, recipes, catalog)])),
    tax_config: taxCfg,
  });
}));

/** Simpan transaksi + potong stok atomik. Mendukung idempotency key. */
router.post(MOUNT + '/sales', auth('sale.create'), http((req, res) => {
  const storeId = req.storeId;
  const externalRef = req.body?.external_ref || null;
  if (externalRef) {
    const dup = firstRow(`SELECT id, invoice_no, status FROM transactions WHERE store_id = ? AND external_ref = ?`, storeId, externalRef);
    if (dup) return res.status(200).json({ ...getSale(storeId, dup.id), duplicated: true });
  }
  const lines = normalizeLines(req.body?.lines, catalogFor(storeId));
  const result = tx(() => createSale({
    storeId,
    branchId: req.branchId,
    userId: req.user.id,
    cashierName: req.user.display_name,
    lines,
    paymentMethodId: req.body?.payment_method_id,
    paidAmount: req.body?.paid_amount,
    selectedDiscountIds: req.body?.selected_discount_ids || [],
    customerName: req.body?.customer_name,
    customerPhone: req.body?.customer_phone,
    orderType: req.body?.order_type,
    note: req.body?.note,
    externalRef,
    skipAlerts: req.body?.skip_alerts === true, // import/transaksi massal: alert dihitung sekali di akhir
  }));
  audit({ userId: req.user.id, role: req.user.role, action: 'sale.create', entity: 'transaction', entityId: result.id, storeId, after: { grand_total: result.grand_total, lines: lines.length } });
  res.status(201).json(result);
}));

router.get(MOUNT + '/sales', auth(), http((req, res) => res.json(listSales(req.storeId, {
  from: req.query.from, to: req.query.to, limit: Number(req.query.limit) || 50,
  offset: Number(req.query.offset) || 0, status: req.query.status, cashierId: req.query.cashier_id,
}))));

router.get(MOUNT + '/sales/:id', auth(), http((req, res) => res.json(getSale(req.storeId, req.params.id))));

router.post(MOUNT + '/sales/:id/void', auth('sale.void'), http((req, res) => {
  const out = tx(() => voidSale({ storeId: req.storeId, txId: req.params.id, userId: req.user.id, reason: req.body?.reason }));
  audit({ userId: req.user.id, role: req.user.role, action: 'sale.void', entity: 'transaction', entityId: req.params.id, storeId: req.storeId, after: req.body?.reason });
  res.json(out);
}));

router.post(MOUNT + '/sales/:id/refund', auth('sale.void'), http((req, res) => {
  const out = tx(() => refundLine({
    storeId: req.storeId, txId: req.params.id, itemId: req.body?.item_id,
    qty: req.body?.qty, userId: req.user.id, reason: req.body?.reason,
  }));
  audit({ userId: req.user.id, role: req.user.role, action: 'sale.refund', entity: 'transaction', entityId: req.params.id, storeId: req.storeId, after: req.body });
  res.json(out);
}));

// --------------------------------------------------------------- order tertahan
router.get(MOUNT + '/pos/held', auth('sale.hold'), http((req, res) => res.json(
  allRows(`SELECT id, invoice_no, note, created_at FROM transactions WHERE store_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 50`, req.storeId)
)));

router.post(MOUNT + '/pos/hold', auth('sale.hold'), http((req, res) => {
  const name = `HOLD${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
  const id = uid('hld');
  exec(
    `INSERT INTO transactions (id, store_id, branch_id, invoice_no, cashier_id, status, customer_name, note, grand_total, created_at)
     VALUES (?,?,?,?,?, 'open', ?, ?, 0, datetime('now'))`,
    id, req.storeId, req.branchId, name, req.user.id, req.body?.customer_name || null,
    JSON.stringify({ lines: normalizeLines(req.body?.lines, catalogFor(storeId)), selected: req.body?.selected_discount_ids || [] })
  );
  res.status(201).json({ id, invoice_no: name });
}));

router.get(MOUNT + '/pos/hold/:id', auth('sale.hold'), http((req, res) => {
  const row = firstRow(`SELECT * FROM transactions WHERE id = ? AND store_id = ?`, req.params.id, req.storeId);
  if (!row) throw new AppError(404, 'Order tidak ditemukan');
  let payload = {};
  try { payload = JSON.parse(row.note || '{}'); } catch { payload = {}; }
  res.json({ id: row.id, invoice_no: row.invoice_no, customer_name: row.customer_name, ...payload });
}));

router.delete(MOUNT + '/pos/hold/:id', auth('sale.hold'), http((req, res) => {
  exec(`DELETE FROM transactions WHERE id = ? AND store_id = ? AND status = 'open'`, req.params.id, req.storeId);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------- helper
function normalizeLines(lines, catalog = null) {
  if (!Array.isArray(lines)) throw new AppError(400, 'Format keranjang tidak valid');
  return lines
    .map((l) => ({
      item_id: l.item_id,
      qty: Math.max(0, Number(l.qty) || 0),
      unit_price: l.unit_price != null ? Number(l.unit_price) : null,
      discount: Number(l.discount) || 0,
      // addon diverifikasi terhadap item_addons di DB (price_delta & bahan dari server, bukan klien)
      addons: catalog ? resolveAddons(catalog, l.item_id, l.addons) : [],
      selected_optional_raws: Array.isArray(l.selected_optional_raws) ? l.selected_optional_raws : [],
    }))
    .filter((l) => l.item_id && l.qty > 0);
}
