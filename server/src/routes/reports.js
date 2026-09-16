// ===========================================================================
//  Rute Analitik & Laporan (Fase 3) — semua angka diambil dari tabel
//  transaksi (uang) + stock_movements (barang) supaya konsisten & auditable.
// ===========================================================================
import express from 'express';
import { allRows, firstRow, round2 } from '../db/index.js';
import { authenticate, requirePerm } from '../middleware/index.js';
import { stockHealth } from '../stockhealth.js';
import { http, AppError } from '../lib/http.js';

export const router = express.Router();
const MOUNT = ''; // path sudah memuat prefiks; mount di index.js memakai '/api'
const auth = (...p) => [authenticate, ...p.map((x) => requirePerm(x))].flat();


const range = (req) => {
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  return { from, to };
};

router.get(MOUNT + '/reports/summary', auth(), http((req, res) => {
  const { from, to } = range(req);
  const storeId = req.storeId;
  const head = firstRow(
    `SELECT COUNT(*) AS tx_count, COALESCE(SUM(grand_total),0) AS gross, COALESCE(SUM(cost_total),0) AS cost,
            COALESCE(SUM(discount_total),0) AS discount, COALESCE(SUM(tax_total),0) AS tax,
            COALESCE(SUM(service_total),0) AS service
     FROM transactions WHERE store_id = ? AND status = 'completed' AND date(created_at) BETWEEN ? AND ?`,
    storeId, from, to
  );
  const voidedCount = firstRow(
    `SELECT COUNT(*) AS n FROM transactions WHERE store_id = ? AND status = 'voided' AND date(created_at) BETWEEN ? AND ?`,
    storeId, from, to
  ).n;
  const byDay = allRows(
    `SELECT date(created_at) AS day, COUNT(*) AS tx_count, SUM(grand_total) AS revenue, SUM(grand_total - cost_total - tax_total) AS profit
     FROM transactions WHERE store_id = ? AND status = 'completed' AND date(created_at) BETWEEN ? AND ?
     GROUP BY day ORDER BY day`,
    storeId, from, to
  ).map((r) => ({ ...r, revenue: round2(r.revenue), profit: round2(r.profit) }));

  const byHour = allRows(
    `SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS hour, COUNT(*) AS tx_count, SUM(grand_total) AS revenue
     FROM transactions WHERE store_id = ? AND status = 'completed' AND date(created_at) BETWEEN ? AND ?
     GROUP BY hour ORDER BY hour`,
    storeId, from, to
  ).map((r) => ({ ...r, revenue: round2(r.revenue) }));

  const byItem = allRows(
    `SELECT ti.item_id, ti.name_snapshot AS name, SUM(ti.qty) AS qty, SUM(ti.line_total) AS revenue,
            SUM(ti.cost_snapshot * ti.qty) AS cost, SUM(ti.line_discount) AS discount
     FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
     WHERE t.store_id = ? AND t.status = 'completed' AND date(t.created_at) BETWEEN ? AND ?
     GROUP BY ti.item_id, ti.name_snapshot ORDER BY revenue DESC LIMIT 25`,
    storeId, from, to
  ).map((r) => ({
    ...r, revenue: round2(r.revenue), cost: round2(r.cost), discount: round2(r.discount),
    profit: round2(r.revenue - r.cost), margin_pct: r.revenue > 0 ? round2(((r.revenue - r.cost) / r.revenue) * 100) : 0,
  }));

  const byPayment = allRows(
    `SELECT COALESCE(pm.name,'Lainnya') AS name, pm.kind, COUNT(p.id) AS count, SUM(p.amount) AS amount
     FROM transaction_payments p
     JOIN transactions t ON t.id = p.transaction_id
     LEFT JOIN payment_methods pm ON pm.id = p.payment_method_id
     WHERE t.store_id = ? AND t.status = 'completed' AND date(t.created_at) BETWEEN ? AND ?
     GROUP BY p.payment_method_id ORDER BY amount DESC`,
    storeId, from, to
  ).map((r) => ({ ...r, amount: round2(r.amount) }));

  const byCashier = allRows(
    `SELECT u.display_name AS name, COUNT(t.id) AS tx_count, SUM(t.grand_total) AS revenue, SUM(t.grand_total - t.cost_total) AS gross_profit
     FROM transactions t LEFT JOIN users u ON u.id = t.cashier_id
     WHERE t.store_id = ? AND t.status = 'completed' AND date(t.created_at) BETWEEN ? AND ?
     GROUP BY t.cashier_id ORDER BY revenue DESC`,
    storeId, from, to
  ).map((r) => ({ ...r, revenue: round2(r.revenue), gross_profit: round2(r.gross_profit) }));

  const revenue = round2(head.gross);
  res.json({
    period: { from, to },
    totals: {
      tx_count: head.tx_count,
      gross_revenue: revenue,
      net_revenue: round2(revenue - head.tax),
      cost: round2(head.cost),
      gross_profit: round2(revenue - head.cost - head.tax),
      margin_pct: revenue > 0 ? round2(((revenue - head.cost - head.tax) / revenue) * 100) : 0,
      avg_ticket: head.tx_count ? round2(revenue / head.tx_count) : 0,
      discount: round2(head.discount), tax: round2(head.tax), service: round2(head.service),
      voided: voidedCount,
    },
    by_day: byDay, by_hour: byHour, by_item: byItem, by_payment: byPayment, by_cashier: byCashier,
  });
}));

/** Konsumsi bahan baku vs pembelian — inti dari "estimasi kehabisan bahan". */
router.get(MOUNT + '/reports/raw-usage', auth(), http((req, res) => {
  const { from, to } = range(req);
  const storeId = req.storeId;
  const cfg = { consumption_window_days: Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1) };
  const health = stockHealth({ storeId, days: cfg.consumption_window_days, lookaheadDays: 14 });
  const movements = allRows(
    `SELECT i.id AS item_id, i.name, i.unit, i.stock_qty, i.supplier_name, i.cost_price,
            COALESCE(SUM(CASE WHEN m.movement_type IN ('sale_out','bom_consume') THEN ABS(m.qty) END),0) AS consumed,
            COALESCE(SUM(CASE WHEN m.movement_type = 'purchase_in' THEN m.qty END),0) AS purchased,
            COALESCE(SUM(CASE WHEN m.movement_type = 'purchase_in' THEN m.qty * m.unit_cost END),0) AS purchase_cost,
            COALESCE(SUM(CASE WHEN m.movement_type = 'adjustment' AND m.qty < 0 THEN ABS(m.qty) END),0) AS waste
     FROM stock_movements m JOIN items i ON i.id = m.item_id
     WHERE i.store_id = ? AND i.item_type = 'raw' AND date(m.created_at) BETWEEN ? AND ?
     GROUP BY i.id ORDER BY consumed DESC`,
    storeId, from, to
  ).map((r) => {
    const perDay = round2(r.consumed / cfg.consumption_window_days);
    const daysLeft = perDay > 0 ? round2(r.stock_qty / perDay) : null;
    return {
      ...r, consumed: round2(r.consumed), purchased: round2(r.purchased), waste: round2(r.waste),
      purchase_cost: round2(r.purchase_cost),
      avg_daily_use: perDay, days_to_stockout: daysLeft,
      stockout_date: daysLeft != null ? new Date(Date.now() + daysLeft * 86400000).toISOString().slice(0, 10) : null,
      coverage_days: daysLeft, status: health.find((h) => h.id === r.item_id)?.status || 'ok',
    };
  });
  res.json({ period: { from, to }, window_days: cfg.consumption_window_days, items: movements });
}));

/** Pergerakan stok harian (masuk/keluar per jenis) — dipakai grafik "stok harian". */
router.get(MOUNT + '/reports/stock-movement', auth(), http((req, res) => {
  const { from, to } = range(req);
  res.json(allRows(
    `SELECT date(m.created_at) AS day, m.movement_type,
            COALESCE(SUM(CASE WHEN m.qty > 0 THEN m.qty END),0) AS qty_in,
            COALESCE(SUM(CASE WHEN m.qty < 0 THEN ABS(m.qty) END),0) AS qty_out,
            COUNT(*) AS lines
     FROM stock_movements m JOIN items i ON i.id = m.item_id
     WHERE i.store_id = ? AND date(m.created_at) BETWEEN ? AND ?
     GROUP BY day, m.movement_type ORDER BY day`,
    req.storeId, from, to
  ));
}));

router.get(MOUNT + '/reports/inventory-valuation', auth(), http((req, res) => {
  const rows = allRows(
    `SELECT i.id, i.name, i.item_type, i.unit, i.stock_qty, i.cost_price, i.selling_price,
            (i.stock_qty * i.cost_price) AS stock_value,
            (i.stock_qty * i.selling_price) AS retail_value
     FROM items i WHERE i.store_id = ? AND i.is_active = 1 AND i.is_non_stock = 0 ORDER BY stock_value DESC`,
    req.storeId
  ).map((r) => ({ ...r, stock_value: round2(r.stock_value), retail_value: round2(r.retail_value) }));
  res.json({
    items: rows,
    total_cost: round2(rows.reduce((s, r) => s + r.stock_value, 0)),
    total_retail: round2(rows.reduce((s, r) => s + r.retail_value, 0)),
  });
}));

// ------------------------------------------------------------------ ekspor CSV
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows, columns) => [
  columns.map((c) => csvCell(c.label ?? c)).join(','),
  ...rows.map((r) => columns.map((c) => csvCell(r[c.key ?? c])).join(',')),
].join('\n');

router.get(MOUNT + '/reports/export/:kind', auth('report.export'), http((req, res) => {
  const { from, to } = range(req);
  const kind = req.params.kind;
  let csv = '';
  let name = kind;
  if (kind === 'sales') {
    const rows = allRows(
      `SELECT t.invoice_no, t.created_at, u.display_name AS cashier, t.status, t.subtotal, t.discount_total,
              t.tax_total, t.grand_total, t.cost_total, t.customer_name, pm.name AS payment
       FROM transactions t LEFT JOIN users u ON u.id = t.cashier_id
       LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
       WHERE t.store_id = ? AND date(t.created_at) BETWEEN ? AND ? ORDER BY t.created_at DESC`,
      req.storeId, from, to);
    csv = toCsv(rows, ['invoice_no', 'created_at', 'cashier', 'status', 'subtotal', 'discount_total', 'tax_total', 'grand_total', 'cost_total', 'customer_name', 'payment']);
  } else if (kind === 'movements') {
    const rows = allRows(
      `SELECT m.created_at, i.name, i.item_type, m.movement_type, m.qty, i.unit, m.unit_cost, m.balance_after, m.reason
       FROM stock_movements m JOIN items i ON i.id = m.item_id
       WHERE i.store_id = ? AND date(m.created_at) BETWEEN ? AND ? ORDER BY m.created_at DESC`,
      req.storeId, from, to);
    csv = toCsv(rows, ['created_at', 'name', 'item_type', 'movement_type', 'qty', 'unit', 'unit_cost', 'balance_after', 'reason']);
  } else if (kind === 'stock') {
    const rows = stockHealth({ storeId: req.storeId });
    csv = toCsv(rows, [
      { key: 'name', label: 'Nama' }, { key: 'item_type', label: 'Tipe' }, { key: 'stock_qty', label: 'Stok' },
      { key: 'unit', label: 'Satuan' }, { key: 'avg_daily', label: 'Pakai/hari' }, { key: 'reorder_point_effective', label: 'Reorder Point' },
      { key: 'days_to_stockout', label: 'Sisa Hari' }, { key: 'stockout_date', label: 'Est. Habis' }, { key: 'status', label: 'Status' },
      { key: 'est_value', label: 'Nilai Stok' },
    ]);
  } else {
    throw new AppError(400, `Jenis laporan tidak dikenal: ${kind}`);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="kasir-${name}-${from}_${to}.csv"`);
  res.send('\uFEFF' + csv);
}));
