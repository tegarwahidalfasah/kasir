// ===========================================================================
//  Rute Autentikasi + Bootstrap (user, permission, setting, tema, menu)
// ===========================================================================
import express from 'express';
import { allRows, firstRow, exec, loadSetting } from '../db/index.js';
import { authenticate, loginGuard } from '../middleware/index.js';
import { authenticate as login, audit, signToken, verifyPassword, hashPassword, bumpAttempt, clearAttempts } from '../auth.js';
import { DEFAULTS } from '../config.js';
import { ROLE_PRESETS, PERMISSIONS } from '../rbac.js';
import { http, AppError } from '../lib/http.js';

export const router = express.Router();
const MOUNT = ''; // path sudah memuat prefiks; mount di index.js memakai '/api'
const auth = (...p) => [authenticate, ...p.map((x) => requirePerm(x))].flat();


// login dulu, SEBELUM middleware authenticate (rute ini publik)
router.post(MOUNT + '/auth/login', loginGuard, http((req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) throw new AppError(400, 'Username & password wajib diisi');
  const out = login(username, password);
  if (out.error) { bumpAttempt(req.ip); throw new AppError(401, 'Username atau password salah'); }
  clearAttempts(req.ip);                 // sukses -> kembalikan jatah percobaan per IP
  audit({ userId: out.user.id, role: out.user.role, action: 'auth.login', entity: 'user', entityId: out.user.id, storeId: out.user.store_id, ip: req.ip });
  res.json({ token: out.token, user: publicUser(out.user) });
}));

router.use(authenticate); // semua rute di bawah ini butuh token

router.get(MOUNT + '/bootstrap', auth(), http((req, res) => {
  const storeId = req.storeId;
  const store = firstRow(`SELECT * FROM stores WHERE id = ?`, storeId) || {};
  const settings = {};
  for (const key of Object.keys(DEFAULTS)) settings[key] = loadSetting(storeId, key, DEFAULTS[key]);

  const catalog = allRows(
    `SELECT i.id, i.name, i.item_type, i.category_id, i.unit, i.selling_price, i.cost_price, i.stock_qty,
            i.is_non_stock, i.production_mode, i.image, i.barcode, i.sku, i.tax_mode, i.tax_rate, i.min_stock,
            i.reorder_point, i.safety_stock, i.lead_time_days, i.supplier_name, i.yield_pct, i.is_active, i.notes,
            c.name AS category_name,
            (SELECT COUNT(*) FROM item_recipes r WHERE r.parent_id = i.id) AS recipe_lines,
            (SELECT COUNT(*) FROM item_recipes r WHERE r.raw_item_id = i.id) AS used_in_count
     FROM items i LEFT JOIN categories c ON c.id = i.category_id
     WHERE i.store_id = ? AND i.is_active = 1
     ORDER BY i.item_type DESC, c.sort_order ASC, i.name ASC`,
    storeId
  );
  // opsi tambahan per barang jadi -> layar kasir & editor item tidak perlu request tambahan
  const addonRows = allRows(
    `SELECT a.* FROM item_addons a JOIN items i ON i.id = a.item_id
     WHERE i.store_id = ? ORDER BY a.sort_order`, storeId
  );
  const byId = Object.fromEntries(catalog.map((r) => [r.id, r]));
  for (const a of addonRows) { const it = byId[a.item_id]; if (it) (it.addons ||= []).push(a); }
  for (const it of catalog) if (it.item_type === 'finished' && !it.addons) it.addons = [];
  const recipes = allRows(
    `SELECT r.parent_id, r.raw_item_id, r.qty, r.unit, r.waste_pct, r.is_optional, i.name AS raw_name, i.unit AS raw_unit
     FROM item_recipes r JOIN items i ON i.id = r.raw_item_id WHERE r.parent_id IN (SELECT id FROM items WHERE store_id = ?)`,
    storeId
  );
  const bom = {};
  for (const r of recipes) (bom[r.parent_id] ||= []).push(r);

  const taxes = allRows(`SELECT * FROM taxes WHERE store_id = ? AND is_active = 1 ORDER BY sort_order`, storeId);
  const discountRules = allRows(`SELECT * FROM discounts WHERE store_id = ? AND is_active = 1`, storeId)
    .map((d) => ({ ...d, ref_ids: parseJson(d.ref_ids, []) }));
  const methods = allRows(`SELECT * FROM payment_methods WHERE store_id = ? AND is_enabled = 1 ORDER BY sort_order`, storeId);
  const categories = allRows(`SELECT * FROM categories WHERE store_id = ? AND is_active = 1 ORDER BY sort_order`, storeId);
  const alertCount = firstRow(
    `SELECT COUNT(*) AS n FROM alerts a
     WHERE a.store_id = ? AND a.created_at >= datetime('now','-7 days')
       AND NOT EXISTS (SELECT 1 FROM alert_reads r WHERE r.alert_id = a.id AND r.user_id = ?)`,
    storeId, req.user.id
  )?.n || 0;

  res.json({
    user: publicUser({ ...req.user, store_name: store.name }),
    permissions: req.permissions,
    // baris `stores` = identitas resmi; blok settings hanya melengkapi (toko baru tanpa setting tetap memakai nama aslinya)
    store: { ...DEFAULTS.store, ...store, name: store.name || settings.store.name },
    settings,
    catalog, bom, taxes, discount_rules: discountRules, payment_methods: methods, categories,
    roles: Object.entries(ROLE_PRESETS).map(([key, v]) => ({ key, ...v, permissions: req.roleMatrix?.roles?.[key] || v.permissions })),
    permission_list: PERMISSIONS,
    alerts_unread: alertCount,
    server_time: new Date().toISOString(),
  });
}));

router.get(MOUNT + '/auth/me', auth(), http((req, res) => res.json({ user: publicUser(req.user), permissions: req.permissions })));

/** Ganti password sendiri */
router.post(MOUNT + '/auth/password', auth(), http((req, res) => {
  const { current, next } = req.body || {};
  if (!current || !next || String(next).length < 6) throw new AppError(400, 'Password baru minimal 6 karakter');
  const u = firstRow(`SELECT * FROM users WHERE id = ?`, req.user.id);
  if (!verifyPassword(current, u.password_hash)) throw new AppError(400, 'Password lama tidak cocok');
  exec(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`, hashPassword(next), u.id);
  audit({ userId: u.id, role: u.role, action: 'auth.password_change', storeId: req.storeId });
  res.json({ ok: true });
}));

/** Perpanjang sesi tanpa login ulang */
router.post(MOUNT + '/auth/refresh', auth(), http((req, res) => res.json({ token: signToken({ uid: req.user.id, role: req.user.role, sid: req.storeId }) })));

function publicUser(u) {
  return { id: u.id, username: u.username, display_name: u.display_name, role: u.role, store_id: u.store_id, branch_id: u.branch_id, store_name: u.store_name };
}
function parseJson(s, fb) { try { return s ? JSON.parse(s) : fb; } catch { return fb; } }
