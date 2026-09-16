// ===========================================================================
//  Rute Katalog: barang jadi, bahan baku, kategori, resep/BOM, addon
//  → pemisahan finished vs raw ada di kolom items.item_type (Fase 1)
// ===========================================================================
import express from 'express';
import { tx, allRows, firstRow, exec, uid, round2 } from '../db/index.js';
import { authenticate, requirePerm } from '../middleware/index.js';
import { recipesFor, planStockImpact } from '../bom.js';
import { postMovement } from '../inventory.js';
import { catalogFor } from '../sales.js';
import { http, AppError } from '../lib/http.js';
import { audit } from '../auth.js';

export const router = express.Router();
const MOUNT = ''; // path sudah memuat prefiks; mount di index.js memakai '/api'
const auth = (...p) => [authenticate, ...p.map((x) => requirePerm(x))].flat();


const ITEM_FIELDS = [
  'name', 'item_type', 'category_id', 'sku', 'barcode', 'unit', 'cost_price', 'selling_price',
  'tax_mode', 'tax_rate', 'min_stock', 'reorder_point', 'safety_stock', 'lead_time_days',
  'supplier_name', 'production_mode', 'yield_pct', 'is_non_stock', 'is_active', 'image', 'notes',
];

router.get(MOUNT + '/items', auth(), http((req, res) => {
  const where = ['i.store_id = ?'];
  const params = [req.storeId];
  if (req.query.type) { where.push('i.item_type = ?'); params.push(req.query.type); }
  if (req.query.q) { where.push('(i.name LIKE ? OR i.sku LIKE ? OR i.barcode LIKE ?)'); const q = `%${req.query.q}%`; params.push(q, q, q); }
  if (req.query.category_id) { where.push('i.category_id = ?'); params.push(req.query.category_id); }
  if (req.query.active) { where.push('i.is_active = ?'); params.push(Number(req.query.active)); }
  const rows = allRows(
    `SELECT i.*, c.name AS category_name,
            (SELECT COUNT(*) FROM item_recipes r WHERE r.parent_id = i.id) AS recipe_lines
     FROM items i LEFT JOIN categories c ON c.id = i.category_id
     WHERE ${where.join(' AND ')} ORDER BY i.item_type DESC, i.name ASC`,
    ...params
  );
  res.json(rows);
}));

router.get(MOUNT + '/items/:id', auth(), http((req, res) => {
  const item = firstRow(`SELECT * FROM items WHERE id = ? AND store_id = ?`, req.params.id, req.storeId);
  if (!item) throw new AppError(404, 'Item tidak ditemukan');
  item.recipe = recipesFor([item.id])[item.id] || [];
  item.addons = allRows(`SELECT * FROM item_addons WHERE item_id = ? ORDER BY sort_order`, item.id);
  item.used_in = allRows(
    `SELECT i.id, i.name FROM item_recipes r JOIN items i ON i.id = r.parent_id WHERE r.raw_item_id = ?`, item.id);
  res.json(item);
}));

router.post(MOUNT + '/items', auth('item.manage'), http((req, res) => {
  const b = pick(req.body || {});
  if (!b.name) throw new AppError(400, 'Nama barang wajib diisi');
  b.item_type = b.item_type === 'raw' ? 'raw' : 'finished';
  const id = uid('itm');
  if (b.sku) {
    const dup = firstRow(`SELECT id FROM items WHERE store_id = ? AND sku = ?`, req.storeId, b.sku);
    if (dup) throw new AppError(409, `SKU ${b.sku} sudah dipakai item lain`);
  }
  // stock_qty sengaja 0: stok selalu lahir dari ledger (opening_stock di bawah)
  exec(
    `INSERT INTO items (id, store_id, name, item_type, category_id, sku, barcode, unit, cost_price, selling_price,
       stock_qty, tax_mode, tax_rate, min_stock, reorder_point, safety_stock, lead_time_days, supplier_name,
       production_mode, yield_pct, is_non_stock, is_active, image, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, req.storeId, b.name, b.item_type, b.category_id || null, b.sku || null, b.barcode || null, b.unit || 'pcs',
    round2(b.cost_price) || 0, round2(b.selling_price) || 0,
    b.tax_mode || 'inherit', b.tax_rate != null ? Number(b.tax_rate) : null, Number(b.min_stock) || 0,
    b.reorder_point != null ? Number(b.reorder_point) : null, Number(b.safety_stock) || 0,
    Number(b.lead_time_days) || 3, b.supplier_name || null,
    b.production_mode === 'make_to_order' ? 'make_to_order' : 'make_to_stock',
    Number(b.yield_pct) || 100, bool(b.is_non_stock), b.is_active === 0 ? 0 : 1, b.image || null, b.notes || null
  ); // <- urutan argumen sama persis dengan urutan kolom
  // stok awal barang/bahan langsung lewat ledger (bukan UPDATE mentah)
  const start = Number(req.body?.opening_stock) || 0;
  if (start !== 0) {
    tx(() => postMovement({
      storeId: req.storeId, itemId: id, type: 'adjustment', qty: start, unitCost: round2(b.cost_price) || 0,
      refType: 'manual', refId: uid('opn'), reason: 'Stok awal', userId: req.user.id, allowNegative: true,
    }));
  }
  syncCost(id);
  audit({ userId: req.user.id, role: req.user.role, action: 'item.create', entity: 'item', entityId: id, storeId: req.storeId, after: b });
  res.status(201).json(firstRow(`SELECT * FROM items WHERE id = ?`, id));
}));

router.put(MOUNT + '/items/:id', auth('item.manage'), http((req, res) => {
  const item = firstRow(`SELECT * FROM items WHERE id = ? AND store_id = ?`, req.params.id, req.storeId);
  if (!item) throw new AppError(404, 'Item tidak ditemukan');
  const b = pick(req.body || {});
  const sets = [], params = [];
  for (const f of ITEM_FIELDS) {
    if (b[f] === undefined) continue;
    sets.push(`${f} = ?`);
    params.push(typeof b[f] === 'number' ? round2(b[f]) : b[f]);
  }
  if (!sets.length) return res.json(item);
  sets.push(`updated_at = datetime('now')`);
  exec(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`, ...params, item.id);
  syncCost(item.id);
  audit({ userId: req.user.id, role: req.user.role, action: 'item.update', entity: 'item', entityId: item.id, storeId: req.storeId, before: item, after: b });
  res.json(firstRow(`SELECT * FROM items WHERE id = ?`, item.id));
}));

router.delete(MOUNT + '/items/:id', auth('item.manage'), http((req, res) => {
  const used = firstRow(
    `SELECT (SELECT COUNT(*) FROM transaction_items WHERE item_id = ?)
          + (SELECT COUNT(*) FROM item_recipes WHERE raw_item_id = ? OR parent_id = ?) AS n`,
    req.params.id, req.params.id, req.params.id).n;
  if (used > 0) {
    exec(`UPDATE items SET is_active = 0 WHERE id = ? AND store_id = ?`, req.params.id, req.storeId);
    return res.json({ ok: true, soft_deleted: true, reason: 'Item masih dipakai transaksi/resep -> dinonaktifkan (bukan dihapus) agar riwayat & BOM utuh' });
  }
  exec(`DELETE FROM items WHERE id = ? AND store_id = ?`, req.params.id, req.storeId);
  audit({ userId: req.user.id, role: req.user.role, action: 'item.delete', entity: 'item', entityId: req.params.id, storeId: req.storeId });
  res.json({ ok: true });
}));

// ------------------------------------------------------------------- resep/BOM
router.get(MOUNT + '/items/:id/recipe', auth(), http((req, res) => res.json(recipesFor([req.params.id])[req.params.id] || [])));

router.put(MOUNT + '/items/:id/recipe', auth('recipe.manage'), http((req, res) => {
  const parent = firstRow(`SELECT * FROM items WHERE id = ? AND store_id = ?`, req.params.id, req.storeId);
  if (!parent) throw new AppError(404, 'Barang tidak ditemukan');
  if (parent.item_type !== 'finished') throw new AppError(400, 'Resep hanya bisa dipasang ke barang jadi');
  const rows = Array.isArray(req.body?.recipe) ? req.body.recipe : [];
  tx(() => {
    exec(`DELETE FROM item_recipes WHERE parent_id = ?`, parent.id);
    rows.forEach((r, idx) => {
      const raw = firstRow(`SELECT * FROM items WHERE id = ? AND store_id = ? AND item_type = 'raw'`, r.raw_item_id, req.storeId);
      if (!raw) throw new AppError(400, `Bahan baku ${r.raw_item_id} tidak ditemukan`);
      const qty = Number(r.qty);
      if (!(qty > 0)) throw new AppError(400, `Jumlah ${raw.name} harus > 0`);
      exec(
        `INSERT OR REPLACE INTO item_recipes (id, parent_id, raw_item_id, qty, unit, waste_pct, is_optional, sort_order)
         VALUES (?,?,?,?,?,?,?,?)`,
        uid('rcp'), parent.id, raw.id, round2(qty), r.unit || raw.unit, Number(r.waste_pct) || 0, r.is_optional ? 1 : 0, idx
      );
    });
    syncCost(parent.id);
  });
  audit({ userId: req.user.id, role: req.user.role, action: 'recipe.update', entity: 'item', entityId: parent.id, storeId: req.storeId, after: rows });
  res.json({ ok: true, recipe: recipesFor([parent.id])[parent.id] || [], cost_price: firstRow(`SELECT cost_price FROM items WHERE id = ?`, parent.id).cost_price });
}));

/** Simulasi: jika 1 porsi terjual, bahan apa saja yang terpotong? */
router.post(MOUNT + '/items/:id/simulate', auth(), http((req, res) => {
  const catalog = catalogFor(req.storeId);
  const recipes = recipesFor([req.params.id]);
  const qty = Number(req.body?.qty) || 1;
  const plan = planStockImpact({ lines: [{ item_id: req.params.id, qty, addons: req.body?.addons || [] }], catalog, recipes, forceConsumeRaw: true });
  res.json({
    input_qty: qty,
    deduct_finished: plan.finished,
    deduct_raw: plan.raw.map((r) => ({ ...r, stock_after: round2((catalog[r.item_id]?.stock_qty || 0) - r.qty) })),
    shortages: plan.shortages,
    max_servable: maxServable(req.params.id, catalog, recipes),
  });
}));

// ------------------------------------------------------------------- kategori
router.get(MOUNT + '/categories', auth(), http((req, res) => res.json(allRows(`SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id) AS item_count FROM categories c WHERE c.store_id = ? ORDER BY c.sort_order, c.name`, req.storeId))));
router.post(MOUNT + '/categories', auth('item.manage'), http((req, res) => {
  if (!req.body?.name) throw new AppError(400, 'Nama kategori wajib diisi');
  const id = uid('cat');
  exec(`INSERT INTO categories (id, store_id, name, sort_order, color, is_active) VALUES (?,?,?,?,?,1)`,
    id, req.storeId, req.body.name, Number(req.body.sort_order) || 0, req.body.color || null);
  res.status(201).json(firstRow(`SELECT * FROM categories WHERE id = ?`, id));
}));
router.put(MOUNT + '/categories/:id', auth('item.manage'), http((req, res) => {
  if (!firstRow(`SELECT id FROM categories WHERE id = ? AND store_id = ?`, req.params.id, req.storeId)) throw new AppError(404, 'Kategori tidak ditemukan');
  exec(`UPDATE categories SET name = ?, sort_order = ?, color = ?, is_active = ? WHERE id = ? AND store_id = ?`,
    req.body?.name, Number(req.body?.sort_order) || 0, req.body?.color || null, req.body?.is_active === 0 ? 0 : 1, req.params.id, req.storeId);
  res.json(firstRow(`SELECT * FROM categories WHERE id = ? AND store_id = ?`, req.params.id, req.storeId));
}));
router.delete(MOUNT + '/categories/:id', auth('item.manage'), http((req, res) => {
  if (!firstRow(`SELECT id FROM categories WHERE id = ? AND store_id = ?`, req.params.id, req.storeId)) throw new AppError(404, 'Kategori tidak ditemukan');
  exec(`UPDATE items SET category_id = NULL WHERE category_id = ? AND store_id = ?`, req.params.id, req.storeId);
  exec(`DELETE FROM categories WHERE id = ? AND store_id = ?`, req.params.id, req.storeId);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------- addon
router.get(MOUNT + '/items/:id/addons', auth(), http((req, res) => res.json(allRows(`SELECT * FROM item_addons WHERE item_id = ? ORDER BY sort_order`, req.params.id))));
router.put(MOUNT + '/items/:id/addons', auth('item.manage'), http((req, res) => {
  const parent = firstRow(`SELECT id FROM items WHERE id = ? AND store_id = ?`, req.params.id, req.storeId);
  if (!parent) throw new AppError(404, 'Barang tidak ditemukan');
  const rows = Array.isArray(req.body?.addons) ? req.body.addons : [];
  tx(() => {
    exec(`DELETE FROM item_addons WHERE item_id = ?`, parent.id);
    rows.forEach((a, idx) => {
      if (!a.name) return;
      exec(`INSERT INTO item_addons (id, item_id, name, price_delta, raw_item_id, raw_qty, is_required, sort_order) VALUES (?,?,?,?,?,?,?,?)`,
        uid('adn'), req.params.id, a.name, round2(a.price_delta) || 0, a.raw_item_id || null, round2(a.raw_qty) || 0, a.is_required ? 1 : 0, idx);
    });
  });
  res.json({ ok: true, addons: allRows(`SELECT * FROM item_addons WHERE item_id = ? ORDER BY sort_order`, req.params.id) });
}));

/** HPP barang jadi = biaya bahan bakunya (otomatis, bila punya resep). */
function syncCost(itemId) {
  const item = firstRow(`SELECT item_type FROM items WHERE id = ?`, itemId);
  if (!item || item.item_type !== 'finished') return;
  const rows = recipesFor([itemId])[itemId] || [];
  if (!rows.length) return;
  const cost = round2(rows.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.raw_cost) || 0) * (1 + (Number(r.waste_pct) || 0) / 100), 0));
  if (cost > 0) exec(`UPDATE items SET cost_price = ? WHERE id = ?`, cost, itemId);
}

function maxServable(itemId, catalog, recipes) {
  const rows = recipes[itemId] || [];
  if (!rows.length) return catalog[itemId]?.stock_qty ?? null;
  let cap = Infinity;
  for (const r of rows) {
    const per = (Number(r.qty) || 0) * (1 + (Number(r.waste_pct) || 0) / 100);
    if (!per) continue;
    cap = Math.min(cap, Math.floor((Number(r.raw_stock) || 0) / per + 1e-9));
  }
  return Number.isFinite(cap) ? cap : 0;
}

function pick(body) {
  const out = {};
  for (const f of ITEM_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  return out;
}
function bool(v) { return v === 0 || v === false || v === '0' || v === 'false' ? 0 : v ? 1 : 0; }
