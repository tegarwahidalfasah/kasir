// ===========================================================================
//  Gudang & Stok (Fase 2) — SATU-SATUNYA pintu untuk mengubah stok.
//  Setiap perubahan menulis baris stock_movements (ledger) + memperbarui
//  items.stock_qty di dalam transaksi DB yang sama => tidak ada selisih.
//  Aturan: JANGAN pernah UPDATE items.stock_qty dari file lain.
// ===========================================================================
import { firstRow, allRows, exec, uid, nowIso, round2 } from './db/index.js';

const EPS = 1e-9;

/**
 * Catat satu pergerakan stok (qty positif = masuk, negatif = keluar).
 * @returns {{skipped:boolean, balance_after?:number, item:object}}
 */
export function postMovement(p) {
  const item = firstRow(
    `SELECT id, store_id, name, item_type, unit, stock_qty, cost_price, is_non_stock
     FROM items WHERE id = ?`, p.itemId);
  if (!item) throw Object.assign(new Error(`Item tidak ditemukan: ${p.itemId}`), { status: 400 });
  if (item.is_non_stock) return { skipped: true, item };

  const qty = round2(p.qty);
  if (!qty) return { skipped: true, item };
  const balance = round2((item.stock_qty || 0) + qty);

  if (balance < -EPS && !p.allowNegative) {
    const err = new Error(`Stok "${item.name}" tidak cukup: tersisa ${item.stock_qty} ${item.unit}, dibutuhkan ${Math.abs(qty)}`);
    err.status = 409;
    err.details = { item_id: item.id, name: item.name, unit: item.unit, available: item.stock_qty, needed: Math.abs(qty) };
    throw err;
  }

  exec(
    `INSERT INTO stock_movements
       (id, store_id, branch_id, item_id, movement_type, qty, unit_cost, balance_after,
        ref_type, ref_id, reason, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    uid('mov'), p.storeId || item.store_id || null, p.branchId || null, item.id, p.type, qty,
    round2(p.unitCost) || 0, balance, p.refType || null, p.refId || null, p.reason || null,
    p.userId || null, p.createdAt || nowIso()
  );
  exec(`UPDATE items SET stock_qty = ?, updated_at = datetime('now') WHERE id = ?`, balance, item.id);

  // Moving-average cost: stok masuk bahan baku memperbarui HPP rata-rata
  if (qty > 0 && item.item_type === 'raw' && Number(p.unitCost) > 0) {
    const cur = firstRow(`SELECT stock_qty, cost_price FROM items WHERE id = ?`, item.id);
    const prevQty = round2(cur.stock_qty - qty);
    const newCost = prevQty > 0
      ? (prevQty * (cur.cost_price || 0) + qty * Number(p.unitCost)) / cur.stock_qty
      : Number(p.unitCost);
    exec(`UPDATE items SET cost_price = ? WHERE id = ?`, round2(newCost), item.id);
  }
  return { skipped: false, balance_after: balance, item };
}

/** Kembalikan stok dari seluruh gerakan sebuah referensi (transaksi di-void/refund). */
export function reverseMovements({ storeId, refType, refId, reason, userId }) {
  const storeClause = storeId ? 'AND store_id = ?' : '';
  const params = storeId ? [refType, refId, storeId] : [refType, refId];
  const rows = allRows(
    `SELECT id, store_id, branch_id, item_id, movement_type, qty, unit_cost
     FROM stock_movements
     WHERE ref_type = ? AND ref_id = ? ${storeClause} AND voided = 0
     ORDER BY created_at ASC`,
    ...params
  );
  for (const m of rows) {
    postMovement({
      storeId: m.store_id,
      branchId: m.branch_id,
      itemId: m.item_id,
      type: m.movement_type === 'sale_out' || m.movement_type === 'bom_consume' ? 'return_in' : 'adjustment',
      qty: -m.qty,
      unitCost: m.unit_cost,
      refType, refId,
      reason: reason || `Pembatalan ${refId}`,
      userId,
      allowNegative: true,
    });
    exec(`UPDATE stock_movements SET voided = 1 WHERE id = ?`, m.id);
  }
  return rows.length;
}

/** Peta stok + harga untuk id item tertentu (dipakai validasi & kalkulasi). */
export function stockSnapshot(itemIds = []) {
  if (!itemIds.length) return {};
  const ph = itemIds.map(() => '?').join(',');
  const rows = allRows(
    `SELECT id, name, item_type, unit, stock_qty, cost_price, selling_price, is_non_stock
     FROM items WHERE id IN (${ph})`, ...itemIds);
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

export function listMovements({ storeId, itemId, limit = 100, from, to, movementTypes } = {}) {
  const where = ['1=1'];
  const params = [];
  if (storeId) { where.push('m.store_id = ?'); params.push(storeId); }
  if (itemId) { where.push('m.item_id = ?'); params.push(itemId); }
  if (from) { where.push('m.created_at >= ?'); params.push(from); }
  if (to) { where.push('m.created_at <= ?'); params.push(to + ' 23:59:59'); }
  if (Array.isArray(movementTypes) && movementTypes.length) {
    where.push(`m.movement_type IN (${movementTypes.map(() => '?').join(',')})`);
    params.push(...movementTypes);
  }
  return allRows(
    `SELECT m.*, i.name AS item_name, i.unit, i.item_type, u.display_name AS user_name
     FROM stock_movements m
     JOIN items i ON i.id = m.item_id
     LEFT JOIN users u ON u.id = m.created_by
     WHERE ${where.join(' AND ')}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT ?`,
    ...params, Math.min(500, Number(limit) || 100)
  );
}

/**
 * Rekonsiliasi: hitung ulang items.stock_qty dari ledger (mengurut created_at).
 * Dipakai seeder (stok historis ditulis mundur) & tool "perbaiki stok" admin.
 */
export function reconcileStock(storeId = null) {
  const where = storeId ? 'WHERE i.store_id = ?' : '';
  const params = storeId ? [storeId] : [];
  const items = allRows(`SELECT id, stock_qty FROM items i ${where}`, ...params);
  let fixed = 0;
  for (const it of items) {
    const sum = firstRow(
      `SELECT COALESCE(SUM(qty), 0) AS s FROM stock_movements WHERE item_id = ?`, it.id).s || 0;
    const want = round2(sum);
    if (Math.abs(want - (it.stock_qty || 0)) > 1e-9) {
      exec(`UPDATE items SET stock_qty = ? WHERE id = ?`, want, it.id);
      fixed += 1;
    }
  }
  return { checked: items.length, fixed };
}

/** Integritas ledger: stok fisik harus == akumulasi ledger. Dipakai QA & health check. */
export function ledgerIntegrity(storeId = null) {
  const where = storeId ? 'WHERE i.store_id = ?' : '';
  const params = storeId ? [storeId] : [];
  const rows = allRows(
    `SELECT i.id, i.name, i.unit, i.stock_qty,
            COALESCE((SELECT SUM(m.qty) FROM stock_movements m WHERE m.item_id = i.id), 0) AS ledger_qty
     FROM items i ${where}`,
    ...params
  );
  const mismatches = rows
    .filter((r) => Math.abs(round2((r.stock_qty || 0) - (r.ledger_qty || 0))) > 1e-6)
    .map((r) => ({ id: r.id, name: r.name, unit: r.unit, stock_qty: r.stock_qty, ledger_qty: round2(r.ledger_qty) }));
  return { checked: rows.length, mismatches };
}
