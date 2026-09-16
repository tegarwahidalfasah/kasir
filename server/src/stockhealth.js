// ===========================================================================
//  Kesehatan stok: peringatan stok minimum + estimasi kehabisan (Fase 3)
//  - Reorder point  = pemakaian harian rata-rata x lead time + safety stock
//  - Days to stockout = stok tersedia / pemakaian harian rata-rata
// ===========================================================================
import { allRows, firstRow, exec, uid, round2 } from './db/index.js';

// sama dengan v_stock_health: pemakaian = penjualan + konsumsi BOM + koreksi turun (susut opname)
const OUT_TYPES = `'sale_out','bom_consume','adjustment'`;

/** Konsumsi bahan baku per item dalam rentang N hari (dipakai untuk proyeksi). */
export function consumption({ storeId, days = 14, groupBy = 'day' }) {
  const window = Math.max(1, Number(days) || 14);
  if (groupBy === 'item') {
    return allRows(
      `SELECT m.item_id, i.name, i.unit, i.item_type,
              SUM(ABS(m.qty)) AS total_out,
              COUNT(DISTINCT date(m.created_at)) AS active_days
       FROM stock_movements m JOIN items i ON i.id = m.item_id
       WHERE m.qty < 0 AND m.voided = 0 AND m.movement_type IN (${OUT_TYPES})
         AND m.created_at >= datetime('now', ?) ${storeId ? 'AND m.store_id = ?' : ''}
       GROUP BY m.item_id`,
      `-${window} days`, ...(storeId ? [storeId] : [])
    ).map((r) => ({ ...r, avg_daily: round2(r.total_out / window), active_days: r.active_days || 0 }));
  }
  return allRows(
    `SELECT date(m.created_at) AS day, i.item_id, i.name, i.unit, SUM(ABS(m.qty)) AS qty
     FROM stock_movements m JOIN items i ON i.id = m.item_id
     WHERE m.qty < 0 AND m.voided = 0 AND m.movement_type IN (${OUT_TYPES})
       AND m.created_at >= datetime('now', ?) ${storeId ? 'AND m.store_id = ?' : ''}
     GROUP BY day, m.item_id ORDER BY day ASC`,
    `-${window} days`, ...(storeId ? [storeId] : [])
  );
}

/**
 * Kesehatan seluruh item (finished + raw): stok, batas, penggunaan harian,
 * status (ok/warning/critical/out), estimasi hari habis & tanggal proyeksi habis.
 */
const finiteCap = (n) => (Number.isFinite(n) ? Math.max(0, n) : null);

/** Kapasitas produksi (porsi) dari stok bahan baku milik sebuah barang jadi. */
function rawCapacity(itemId) {
  const rows = allRows(
    `SELECT r.qty, r.waste_pct, i.stock_qty FROM item_recipes r JOIN items i ON i.id = r.raw_item_id WHERE r.parent_id = ?`,
    itemId);
  if (!rows.length) return Infinity;
  let cap = Infinity;
  for (const r of rows) {
    const per = (Number(r.qty) || 0) * (1 + (Number(r.waste_pct) || 0) / 100);
    if (!per) continue;
    cap = Math.min(cap, Math.floor((Number(r.stock_qty) || 0) / per + 1e-9));
  }
  return Number.isFinite(cap) ? cap : 0;
}

export function stockHealth({ storeId, days = 14, lookaheadDays = 7 } = {}) {
  const window = Math.max(1, Number(days) || 14);
  const rows = allRows(
    `SELECT i.id, i.name, i.item_type, i.unit, i.stock_qty, i.min_stock, i.reorder_point, i.safety_stock,
            i.lead_time_days, i.cost_price, i.selling_price, i.production_mode, i.yield_pct, i.supplier_name,
            (SELECT COUNT(*) FROM item_recipes r2 WHERE r2.parent_id = i.id) AS has_bom,
            COALESCE(out.qty_out, 0) AS qty_out,
            (SELECT COUNT(*) FROM item_recipes r WHERE r.parent_id = i.id) AS recipe_lines
     FROM items i
     LEFT JOIN (
       SELECT m.item_id, SUM(ABS(m.qty)) AS qty_out
       FROM stock_movements m
       WHERE m.qty < 0 AND m.voided = 0 AND m.movement_type IN (${OUT_TYPES})
         AND m.created_at >= datetime('now', ?) ${storeId ? 'AND m.store_id = ?' : ''}
       GROUP BY m.item_id
     ) out ON out.item_id = i.id
     WHERE i.is_active = 1 AND i.is_non_stock = 0 ${storeId ? 'AND i.store_id = ?' : ''}
     ORDER BY i.item_type DESC, i.name ASC`,
    `-${window} days`, ...(storeId ? [storeId, storeId] : [])
  );

  return rows.map((r) => {
    const stock = Math.max(0, Number(r.stock_qty) || 0); // stok tak pernah negatif di laporan; selisih ditangani opname
    const avgDaily = round2((r.qty_out || 0) / window);
    const lead = Math.max(0, Number(r.lead_time_days) || 0);
    const safety = Number(r.safety_stock) || 0;
    const rp = round2(Math.max(
      Number(r.reorder_point) || 0,
      Number(r.min_stock) || 0,
      avgDaily * (lead || 3) + safety
    ));
    const daysLeft = avgDaily > 0 ? round2(stock / avgDaily) : null;
    let status = 'ok';
    // barang jadi made-to-order tidak punya stok rak -> ketersediaan diukur dari bahan baku
    const madeToOrder = r.item_type === 'finished' && r.production_mode === 'make_to_order';
    if (r.item_type === 'raw' || madeToOrder) {
      if (madeToOrder) {
        const cap = rawCapacity(r.id);
        if (cap <= 0) status = 'out';
        else if (cap < 3) status = 'critical';
        else if (r.qty_out > 0 && cap <= r.qty_out / window * lookaheadDays) status = 'warning';
      } else if (r.stock_qty <= 0) status = 'out';
      else if (r.stock_qty <= Math.max(safety, 0)) status = 'critical';
      else if (daysLeft != null && daysLeft <= lookaheadDays) status = 'warning';
      else if (r.stock_qty <= rp) status = 'warning';
    } else {
      const floor = Number(r.min_stock) || 0;
      if (stock <= 0) status = 'out';
      else if (floor > 0 && stock <= floor / 2) status = 'critical';
      else if (floor > 0 && stock <= floor) status = 'warning';
    }
    const stockoutDate = daysLeft != null && daysLeft >= 0
      ? new Date(Date.now() + daysLeft * 86400000).toISOString().slice(0, 10)
      : null;
    return {
      ...r,
      avg_daily: avgDaily,
      reorder_point_effective: rp,
      days_to_stockout: daysLeft,
      stockout_date: stockoutDate,
      serve_capacity: finiteCap(madeToOrder ? rawCapacity(r.id) : (r.stock_qty > 0 ? Math.floor(r.stock_qty) : rawCapacity(r.id))),
      status,
      stock_display: stock,
      est_value: round2(stock * r.cost_price),
      margin_pct: r.selling_price > 0 ? round2(((r.selling_price - r.cost_price) / r.selling_price) * 100) : null,
    };
  });
}

/** Bangkitkan alert stok rendah; deduplikasi 24 jam per item agar tidak spam dasbor. */
export function generateAlerts(storeId, opts = {}) {
  const health = stockHealth({ storeId, days: opts.days || 14, lookaheadDays: opts.lookaheadDays || 7 });
  const risky = health.filter((h) => h.status === 'warning' || h.status === 'critical' || h.status === 'out');
  let created = 0;
  for (const h of risky) {
    const dup = firstRow(
      `SELECT id FROM alerts WHERE store_id = ? AND item_id = ? AND kind = 'low_stock' AND created_at >= datetime('now','-6 hours')`,
      storeId, h.id
    );
    if (dup) continue;
    const qtyTxt = Number(h.stock_qty || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });
    const sisa = h.days_to_stockout;
    const hariTxt = sisa == null ? '' : sisa < 1 ? 'kurang dari 1 hari lagi' : `± ${Math.round(sisa)} hari lagi`;
    const msg = h.status === 'out'
      ? `${h.name} HABIS (0 ${h.unit})`
      : `Stok ${h.name} tinggal ${qtyTxt} ${h.unit}${hariTxt ? ` · perkiraan habis ${hariTxt}` : ''}`;
    exec(
      `INSERT INTO alerts (id, store_id, kind, severity, item_id, message, data_json, created_at)
       VALUES (?,?, 'low_stock', ?,?,?,?, datetime('now'))`,
      uid('alr'), storeId,
      h.status === 'out' || h.status === 'critical' ? 'critical' : 'warning',
      h.id, msg,
      JSON.stringify({ unit: h.unit, stock_qty: h.stock_qty, reorder_point: h.reorder_point_effective, avg_daily: h.avg_daily, item_type: h.item_type })
    );
    created += 1;
  }
  return { created, at_risk: risky.length, total: health.length };
}

export function listAlerts(storeId, { limit = 60, unreadBy = null } = {}) {
  const rows = allRows(
    `SELECT a.*, i.name AS item_name, i.unit, i.item_type, i.stock_qty, i.supplier_name,
            (SELECT r.read_at FROM alert_reads r WHERE r.alert_id = a.id AND r.user_id = ?) AS read_at
     FROM alerts a
     LEFT JOIN items i ON i.id = a.item_id
     WHERE a.store_id = ?
     ORDER BY a.created_at DESC
     LIMIT ?`,
    unreadBy || '', storeId, Math.min(200, Number(limit) || 60)
  );
  return rows.map((r) => ({ ...r, is_read: !!r.read_at }));
}

export function markAlertRead(storeId, userId, alertId = null) {
  if (alertId) {
    exec(`INSERT OR IGNORE INTO alert_reads (user_id, alert_id) SELECT ?, id FROM alerts WHERE id = ? AND store_id = ?`, userId, alertId, storeId);
    return;
  }
  exec(
    `INSERT OR IGNORE INTO alert_reads (user_id, alert_id)
     SELECT ?, id FROM alerts WHERE store_id = ? AND created_at >= datetime('now','-7 days')`,
    userId, storeId
  );
}
