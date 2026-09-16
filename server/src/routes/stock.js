// ===========================================================================
//  Rute Stok: health, ledger, opname, produksi, pembelian bahan baku
// ===========================================================================
import express from 'express';
import { tx, allRows, firstRow, exec, uid, nowIso, round2, loadSetting } from '../db/index.js';
import { authenticate, requirePerm } from '../middleware/index.js';
import { postMovement, listMovements, ledgerIntegrity, reconcileStock } from '../inventory.js';
import { stockHealth, generateAlerts, consumption } from '../stockhealth.js';
import { recipesFor } from '../bom.js';
import { DEFAULTS } from '../config.js';
import { http, AppError } from '../lib/http.js';
import { audit } from '../auth.js';

export const router = express.Router();
const MOUNT = ''; // path sudah memuat prefiks; mount di index.js memakai '/api'
const auth = (...p) => [authenticate, ...p.map((x) => requirePerm(x))].flat();


// ------------------------------------------------------------- pantau stok
router.get(MOUNT + '/stock/health', auth(['stock.view', 'item.view']), http((req, res) => {
  const cfg = loadSetting(req.storeId, 'tax', DEFAULTS.tax);
  const rows = stockHealth({
    storeId: req.storeId,
    days: Number(req.query.days) || cfg.consumption_window_days,
    lookaheadDays: Number(req.query.lookahead) || cfg.alert_lookahead_days,
  });
  res.json({
    generated_at: nowIso(),
    window_days: Number(req.query.days) || cfg.consumption_window_days,
    items: rows,
    summary: {
      total: rows.length,
      at_risk: rows.filter((r) => r.status === 'warning' || r.status === 'critical' || r.status === 'out').length,
      out: rows.filter((r) => r.status === 'out').length,
      stock_value: round2(rows.reduce((s, r) => s + (r.est_value || 0), 0)),
      will_run_out_soon: rows.filter((r) => r.days_to_stockout != null && r.days_to_stockout <= (Number(req.query.lookahead) || cfg.alert_lookahead_days)).length,
    },
  });
}));

router.get(MOUNT + '/stock/movements', auth('stock.view'), http((req, res) => res.json(listMovements({
  storeId: req.storeId, itemId: req.query.item_id, limit: Number(req.query.limit) || 100,
  from: req.query.from, to: req.query.to, movementTypes: req.query.types ? String(req.query.types).split(',') : null,
}))));

router.get(MOUNT + '/stock/consumption', auth('stock.view'), http((req, res) => res.json(
  consumption({ storeId: req.storeId, days: Number(req.query.days) || 14, groupBy: req.query.group || 'item' })
)));

router.get(MOUNT + '/stock/integrity', auth('system.maintenance'), http((req, res) => res.json(ledgerIntegrity(req.storeId))));

router.post(MOUNT + '/stock/reconcile', auth('system.maintenance'), http((req, res) => res.json(reconcileStock(req.storeId))));

/** Stock opname: selisih dihitung otomatis & dicatat sebagai adjustment. */
router.post(MOUNT + '/stock/adjust', auth('stock.adjust'), http((req, res) => {
  const body = req.body || {};
  const ids = Array.isArray(body.items) ? body.items : [body];
  const out = tx(() => ids.map((it) => {
    const item = firstRow(`SELECT * FROM items WHERE id = ? AND store_id = ?`, it.item_id, req.storeId);
    if (!item) throw new AppError(404, `Item ${it.item_id} tidak ditemukan`);
    const target = Number(it.counted_qty ?? it.stock_qty);
    if (Number.isNaN(target)) throw new AppError(400, 'Jumlah hasil hitung fisik tidak valid');
    const delta = round2(target - item.stock_qty);
    if (!delta) return { item_id: item.id, name: item.name, delta: 0, skipped: true };
    postMovement({
      storeId: req.storeId, branchId: req.branchId, itemId: item.id, type: 'adjustment', qty: delta,
      unitCost: item.cost_price, refType: 'manual', refId: body.ref || uid('adj'),
      reason: it.reason || body.reason || 'Stock opname', userId: req.user.id, allowNegative: true,
    });
    return { item_id: item.id, name: item.name, before: item.stock_qty, after: target, delta };
  }));
  audit({ userId: req.user.id, role: req.user.role, action: 'stock.adjust', entity: 'items', storeId: req.storeId, after: out });
  res.json({ ok: true, results: out, alerts: generateAlerts(req.storeId) });
}));

/** Produksi: buat stok barang jadi dari bahan baku (mode make_to_stock). */
router.post(MOUNT + '/stock/produce', auth('stock.produce'), http((req, res) => {
  const body = req.body || {};
  const qty = Number(body.qty);
  if (!qty || qty <= 0) throw new AppError(400, 'Jumlah produksi harus > 0');
  const out = tx(() => {
    const item = firstRow(`SELECT * FROM items WHERE id = ? AND store_id = ?`, body.item_id, req.storeId);
    if (!item) throw new AppError(404, 'Barang tidak ditemukan');
    if (item.item_type !== 'finished') throw new AppError(400, 'Hanya barang jadi yang bisa diproduksi');
    const recipes = recipesFor([item.id])[item.id] || [];
    const yieldF = Math.max(1, Number(item.yield_pct) || 100) / 100;
    const rawList = [];
    for (const r of recipes) {
      const need = round2((qty * (Number(r.qty) || 0) * (1 + (Number(r.waste_pct) || 0) / 100)) / yieldF);
      if (!need) continue;
      postMovement({
        storeId: req.storeId, branchId: req.branchId, itemId: r.raw_item_id, type: 'bom_consume', qty: -need,
        unitCost: r.cost_price, refType: 'production', refId: uid('prd'),
        reason: `Produksi ${item.name} x ${qty}`, userId: req.user.id,
      });
      rawList.push({ item_id: r.raw_item_id, name: r.raw_name, qty: -need });
    }
    postMovement({
      storeId: req.storeId, branchId: req.branchId, itemId: item.id, type: 'production_in',
      qty: Math.round((qty * yieldF) * 1e6) / 1e6, unitCost: item.cost_price, refType: 'production',
      refId: uid('prd'), reason: body.reason || 'Produksi terjadwal', userId: req.user.id, allowNegative: true,
    });
    return { item_id: item.id, name: item.name, produced: qty, consumed: rawList };
  });
  audit({ userId: req.user.id, role: req.user.role, action: 'stock.produce', entity: 'item', entityId: body.item_id, storeId: req.storeId, after: out });
  res.json({ ok: true, ...out, alerts: generateAlerts(req.storeId) });
}));

// ------------------------------------------------------------------- PO bahan
router.get(MOUNT + '/purchase-orders', auth('stock.purchase'), http((req, res) => {
  const rows = allRows(
    `SELECT p.*, s.name AS supplier_name, u.display_name AS created_by_name,
            (SELECT COUNT(*) FROM purchase_order_items pi WHERE pi.po_id = p.id) AS line_count
     FROM purchase_orders p
     LEFT JOIN suppliers s ON s.id = p.supplier_id
     LEFT JOIN users u ON u.id = p.created_by
     WHERE p.store_id = ? ORDER BY p.created_at DESC LIMIT 100`,
    req.storeId
  );
  res.json(rows);
}));

router.get(MOUNT + '/purchase-orders/:id', auth('stock.purchase'), http((req, res) => {
  const po = firstRow(`SELECT * FROM purchase_orders WHERE id = ? AND store_id = ?`, req.params.id, req.storeId);
  if (!po) throw new AppError(404, 'PO tidak ditemukan');
  po.items = allRows(
    `SELECT pi.*, i.name, i.unit, i.stock_qty FROM purchase_order_items pi JOIN items i ON i.id = pi.raw_item_id WHERE pi.po_id = ?`, po.id);
  res.json(po);
}));

router.post(MOUNT + '/purchase-orders', auth('stock.purchase'), http((req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items.filter((i) => i.raw_item_id && Number(i.qty_ordered) > 0) : [];
  if (!items.length) throw new AppError(400, 'Minimal satu bahan baku dengan jumlah > 0');
  const poId = uid('po');
  const poNo = body.po_number || `PO${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(Date.now()).slice(-4)}`;
  const total = round2(items.reduce((s, i) => s + Number(i.qty_ordered) * (Number(i.unit_cost) || 0), 0));
  exec(
    `INSERT INTO purchase_orders (id, store_id, po_number, supplier_id, branch_id, status, order_date, expected_date, total_amount, note, created_by, created_at)
     VALUES (?,?,?,?,?, ?, datetime('now'), ?, ?, ?, ?, datetime('now'))`,
    poId, req.storeId, poNo, body.supplier_id || null, req.branchId || null, body.status === 'ordered' ? 'ordered' : 'draft',
    body.expected_date || null, total, body.note || null, req.user.id
  );
  for (const i of items) {
    exec(
      `INSERT INTO purchase_order_items (id, po_id, raw_item_id, qty_ordered, qty_received, unit_cost, note) VALUES (?,?,?,?,0,?,?)`,
      uid('poi'), poId, i.raw_item_id, Number(i.qty_ordered), Number(i.unit_cost) || 0, i.note || null
    );
  }
  audit({ userId: req.user.id, role: req.user.role, action: 'po.create', entity: 'purchase_order', entityId: poId, storeId: req.storeId, after: { total, items: items.length } });
  res.status(201).json({ id: poId, po_number: poNo, total_amount: total });
}));

/** Terima barang -> stok bahan baku naik + HPP rata-rata bergerak diperbarui. */
router.post(MOUNT + '/purchase-orders/:id/receive', auth('stock.purchase'), http((req, res) => {
  const out = tx(() => {
    const po = firstRow(`SELECT * FROM purchase_orders WHERE id = ? AND store_id = ?`, req.params.id, req.storeId);
    if (!po) throw new AppError(404, 'PO tidak ditemukan');
    if (po.status === 'received') throw new AppError(409, 'PO sudah diterima sepenuhnya');
    const lines = allRows(`SELECT * FROM purchase_order_items WHERE po_id = ?`, po.id);
    const received = [];
    for (const l of lines) {
      const qty = Number(req.body?.items?.[l.id]?.qty_received ?? (l.qty_ordered - l.qty_received));
      if (qty <= 0) continue;
      postMovement({
        storeId: po.store_id, branchId: po.branch_id, itemId: l.raw_item_id, type: 'purchase_in', qty,
        unitCost: l.unit_cost, refType: 'purchase_order', refId: po.id, reason: `Penerimaan ${po.po_number}`,
        userId: req.user.id, allowNegative: true,
      });
      exec(`UPDATE purchase_order_items SET qty_received = round(qty_received + ?, 6) WHERE id = ?`, qty, l.id);
      received.push({ item_id: l.raw_item_id, qty, unit_cost: l.unit_cost });
    }
    const open = firstRow(`SELECT COALESCE(SUM(qty_ordered - qty_received),0) AS n FROM purchase_order_items WHERE po_id = ?`, po.id).n;
    exec(`UPDATE purchase_orders SET status = ?, received_at = datetime('now') WHERE id = ?`, open <= 1e-9 ? 'received' : 'partial', po.id);
    return { po_number: po.po_number, status: open <= 1e-9 ? 'received' : 'partial', received, open_qty: open };
  });
  audit({ userId: req.user.id, role: req.user.role, action: 'po.receive', entity: 'purchase_order', entityId: req.params.id, storeId: req.storeId, after: out });
  res.json({ ...out, alerts: generateAlerts(req.storeId) });
}));

router.post(MOUNT + '/purchase-orders/:id/cancel', auth('stock.purchase'), http((req, res) => {
  exec(`UPDATE purchase_orders SET status='cancelled' WHERE id = ? AND store_id = ?`, req.params.id, req.storeId);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ supplier
router.get(MOUNT + '/suppliers', auth(), http((req, res) => res.json(allRows(`SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.supplier_name = s.name) AS item_count FROM suppliers s WHERE s.store_id = ? ORDER BY s.name`, req.storeId))));
router.post(MOUNT + '/suppliers', auth('item.manage'), http((req, res) => {
  const b = req.body || {};
  if (!b.name) throw new AppError(400, 'Nama supplier wajib diisi');
  const id = uid('sup');
  exec(`INSERT INTO suppliers (id, store_id, name, contact, phone, email, lead_time_days, notes) VALUES (?,?,?,?,?,?,?,?)`,
    id, req.storeId, b.name, b.contact || null, b.phone || null, b.email || null, Number(b.lead_time_days) || 3, b.notes || null);
  res.status(201).json(firstRow(`SELECT * FROM suppliers WHERE id = ?`, id));
}));
router.put(MOUNT + '/suppliers/:id', auth('item.manage'), http((req, res) => {
  const b = req.body || {};
  exec(`UPDATE suppliers SET name=?, contact=?, phone=?, email=?, lead_time_days=?, notes=? WHERE id=? AND store_id=?`,
    b.name, b.contact || null, b.phone || null, b.email || null, Number(b.lead_time_days) || 3, b.notes || null, req.params.id, req.storeId);
  res.json(firstRow(`SELECT * FROM suppliers WHERE id = ? AND store_id = ?`, req.params.id, req.storeId));
}));
router.delete(MOUNT + '/suppliers/:id', auth('item.manage'), http((req, res) => {
  exec(`DELETE FROM suppliers WHERE id = ? AND store_id = ?`, req.params.id, req.storeId);
  res.json({ ok: true });
}));

// --------------------------------------------------------------- alert manual
router.post(MOUNT + '/alerts/scan', auth('stock.view'), http((req, res) => res.json(generateAlerts(req.storeId, { days: Number(req.query.days) || 14, lookaheadDays: Number(req.query.lookahead) || 7 }))));
