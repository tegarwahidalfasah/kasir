// ===========================================================================
//  BOM / Recipe Engine (Fase 1) — satu penjualan bisa memotong N bahan baku.
//  Konsumsi efektif  = qty x qty_per_unit x (1 + waste% ) / (yield% )
// ===========================================================================
import { allRows, firstRow } from './db/index.js';

/** Ambil seluruh baris resep untuk banyak item sekaligus (1 query). */
export function recipesFor(parentIds) {
  if (!parentIds.length) return {};
  const ph = parentIds.map(() => '?').join(',');
  const rows = allRows(
    `SELECT r.parent_id, r.raw_item_id, r.qty, r.unit, r.waste_pct, r.is_optional, r.sort_order,
            i.name AS raw_name, i.unit AS raw_unit, i.stock_qty AS raw_stock, i.item_type AS raw_type,
            i.cost_price AS raw_cost, i.min_stock AS raw_min_stock, i.reorder_point AS raw_reorder_point
     FROM item_recipes r
     JOIN items i ON i.id = r.raw_item_id
     WHERE r.parent_id IN (${ph})
     ORDER BY r.sort_order ASC`,
    ...parentIds
  );
  const map = {};
  for (const r of rows) (map[r.parent_id] ||= []).push(r);
  return map;
}

/**
 * Terjemahkan keranjang penjualan -> daftar potongan stok.
 * @returns {{finished: Array, raw: Array, bom_by_parent: Object, shortages: Array}}
 */
export function planStockImpact({ lines, catalog, recipes }) {
  const finished = [];
  const rawMap = new Map();
  const shortages = [];

  const addRaw = (id, qty, meta) => {
    if (!qty) return;
    const cur = rawMap.get(id) || { item_id: id, qty: 0, lines: [] };
    cur.qty = Math.round((cur.qty + qty) * 1e6) / 1e6;
    cur.lines.push(meta);
    rawMap.set(id, cur);
  };

  for (const line of lines) {
    const item = catalog[line.item_id];
    if (!item || item.is_non_stock) continue;
    const qty = Math.max(0, Number(line.qty) || 0);
    if (!qty) continue;
    const rows = recipes[line.item_id] || [];
    const yieldFactor = Math.max(1, Number(item.yield_pct) || 100) / 100;
    const hasBom = rows.length > 0;

    // --- Aturan tunggal (dokumentasi: docs/arsitektur-teknis.md#aturan-stok) ---
    // 1. item tanpa BOM              -> potong stok item itu sendiri
    // 2. finished + make_to_stock    -> potong stok jadi saja (bahan sudah dipotong saat /stock/produce)
    // 3. finished + make_to_order    -> potong bahan baku sesuai BOM; stok jadi dipakai bila tersedia
    if (!hasBom) {
      finished.push({ item_id: item.id, name: item.name, requested: qty, deduct_qty: round6(qty), capped_by_raw: false, raw_capacity: null });
    } else if (item.production_mode === 'make_to_stock') {
      finished.push({ item_id: item.id, name: item.name, requested: qty, deduct_qty: round6(qty), capped_by_raw: false, raw_capacity: null });
    } else {
      const fromStock = Math.min(qty, Math.max(0, round6(Number(item.stock_qty) || 0)));
      const madeNow = round6(qty - fromStock);
      if (fromStock > 0) {
        finished.push({ item_id: item.id, name: item.name, requested: qty, deduct_qty: fromStock, capped_by_raw: false, raw_capacity: null });
      }
      for (const r of rows) {
        if (r.is_optional && !isAddonChosen(line, r.raw_item_id)) continue;
        const need = round6((madeNow * (Number(r.qty) || 0) * (1 + (Number(r.waste_pct) || 0) / 100)) / yieldFactor);
        if (need > 0) addRaw(r.raw_item_id, need, { parent: item.name, qty, recipe: r });
      }
      // bahan baku dari addon selalu dipotong (addon dibuat saat pesanan masuk)
      for (const a of line.addons || []) {
        if (a.raw_item_id && a.raw_qty) addRaw(a.raw_item_id, round6(Number(a.raw_qty) * (a.qty ?? 1) * qty), { parent: `${item.name} + ${a.name}`, qty, recipe: null });
      }
      // cek kapasitas: stok jadi + bahan yang tersisa harus menutupi qty
      if (madeNow > 0) {
        const capacity = rows.reduce((min, r) => {
          const per = (Number(r.qty) || 0) * (1 + (Number(r.waste_pct) || 0) / 100) / yieldFactor;
          if (!per) return min;
          const stock = Number(r.raw_stock) || 0;
          return Math.min(min, Math.floor(stock / per + 1e-9));
        }, Infinity);
        if (capacity < madeNow) {
          shortages.push({
            item_id: item.id, name: item.name, requested: qty,
            max_by_raw: Number.isFinite(capacity) ? capacity + fromStock : fromStock,
          });
        }
      }
    }
  }

  return { finished, raw: [...rawMap.values()], shortages };
}

const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

function isAddonChosen(line, rawItemId) {
  return (line.addons || []).some((a) => a.raw_item_id === rawItemId) || (line.selected_optional_raws || []).includes(rawItemId);
}

/** Kapasitas produksi (porsi) berdasarkan stok bahan baku — dipakai POS & "estimasi kehabisan".
 *  Pakai rumus yang sama dengan planStockImpact: susut DIKALI, yield DIPAKI sebagai pembagi,
 *  supaya angka "≈ N porsi" di layar kasir tidak pernah lebih optimis dari mesin stok. */
export function rawCapacity(itemId, catalog, recipes) {
  const rows = recipes[itemId] || [];
  const item = catalog[itemId];
  if (!item || !rows.length) return null;
  const yieldFactor = Math.max(1, Number(item.yield_pct) || 100) / 100;
  if (item.production_mode !== 'make_to_order' && item.stock_qty > 0) return Math.floor(item.stock_qty);
  let cap = Infinity;
  for (const r of rows) {
    const per = ((Number(r.qty) || 0) * (1 + (Number(r.waste_pct) || 0) / 100)) / yieldFactor;
    if (!per) continue;
    cap = Math.min(cap, Math.floor((Number(r.raw_stock) || 0) / per + 1e-9));
  }
  return Number.isFinite(cap) ? cap : 0;
}

/** Bahan baku yang dibutuhkan untuk satu item (untuk pratinjau di keranjang). */
export function bomPreview(parentId, qty, recipes, catalog) {
  const rows = recipes[parentId] || [];
  const parent = catalog[parentId];
  const yieldFactor = Math.max(1, Number(parent?.yield_pct) || 100) / 100;
  return rows.map((r) => ({
    raw_item_id: r.raw_item_id,
    name: r.raw_name,
    unit: r.raw_unit,
    need: round6((Number(qty) * (Number(r.qty) || 0) * (1 + (Number(r.waste_pct) || 0) / 100)) / yieldFactor),
    stock: round6(Number(r.raw_stock) || 0),
    waste_pct: Number(r.waste_pct) || 0,
  }));
}

export function findItemByName(name, type = null) {
  return firstRow(
    `SELECT * FROM items WHERE lower(name) = lower(?) ${type ? 'AND item_type = ?' : ''} LIMIT 1`,
    ...(type ? [name, type] : [name])
  );
}
