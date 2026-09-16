// ===========================================================================
//  Rute Kustomisasi Toko (Fase 3)
//  Setiap blok = JSON di tabel settings -> mudah ditambah tanpa migrasi DB.
//  Tema (warna/logo/layout menu) dibaca UI lewat /api/branding (publik) dan
//  diterapkan sebagai CSS custom properties => UI modular.
// ===========================================================================
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, allRows, firstRow, exec, uid, loadSetting, saveSetting, DB_FILE } from '../db/index.js';
import { authenticate, requirePerm } from '../middleware/index.js';
import { DEFAULTS } from '../config.js';
import { http, AppError } from '../lib/http.js';
import { audit } from '../auth.js';

export const router = express.Router();
const MOUNT = ''; // path sudah memuat prefiks; mount di index.js memakai '/api'
const auth = (...p) => [authenticate, ...p.map((x) => requirePerm(x))].flat();

router.use(express.json({ limit: '12mb' }));

/** Baca/tulis blok setting generik (store | tax | receipt | theme | pos) */
router.get(MOUNT + '/settings', auth(), http((req, res) => {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = loadSetting(req.storeId, key, DEFAULTS[key]);
  out._meta = allRows(`SELECT key, updated_at, updated_by FROM settings WHERE store_id = ?`, req.storeId);
  res.json(out);
}));

router.put(MOUNT + '/settings/:key', auth('setting.store'), http((req, res) => {
  const key = req.params.key;
  if (!DEFAULTS[key]) throw new AppError(400, `Blok setting tidak dikenal: ${key}`);
  const permByBlock = {
    store: 'setting.store', tax: 'setting.tax', receipt: 'setting.receipt', theme: 'setting.theme', pos: 'setting.store',
  };
  const need = permByBlock[key];
  const perms = req.permissions || [];
  if (!perms.includes('*') && !perms.includes(need) && !perms.includes('setting.store')) {
    throw new AppError(403, `Butuh hak akses: ${need}`);
  }
  const before = loadSetting(req.storeId, key, DEFAULTS[key]);
  const patch = { ...(req.body || {}) };
  if (key === 'theme' && Array.isArray(patch.menu)) {
    patch.menu = patch.menu
      .filter((m) => m && m.key)
      .map((m, i) => ({ key: String(m.key), label: String(m.label ?? m.key), icon: m.icon ?? '•', visible: m.visible !== false, perm: m.perm ?? null, order: i }));
  }
  const merged = { ...before, ...patch };
  saveSetting(req.storeId, key, merged, req.user.id);
  if (key === 'store') {
    exec(`UPDATE stores SET name = ?, legal_name = ?, address = ?, phone = ?, email = ?, npwp = ?, timezone = ?, currency = ?, locale = ?, logo_path = ?, updated_at = datetime('now') WHERE id = ?`,
      merged.name, merged.legal_name || null, merged.address || null, merged.phone || null, merged.email || null,
      merged.npwp || null, merged.timezone || 'Asia/Jakarta', merged.currency || 'IDR', merged.locale || 'id-ID',
      merged.logo_data_url ? 'data-url' : null, req.storeId);
  }
  audit({ userId: req.user.id, role: req.user.role, action: `setting.update.${key}`, entity: 'settings', entityId: key, storeId: req.storeId, ip: req.ip, before, after: merged });
  res.json({ ok: true, key, value: merged });
}));

// ------------------------------------------------------------------ logo/theme
/** Unggah logo (base64 data URL) -> dipakai di header app, sidebar, dan struk. */
router.post(MOUNT + '/branding/logo', auth(['setting.theme', 'setting.store']), http((req, res) => {
  const dataUrl = req.body?.data_url;
  if (!/^data:image\/(png|jpeg|jpg|svg\+xml|webp);base64,/.test(dataUrl || '')) throw new AppError(400, 'Format gambar tidak didukung (png/jpg/svg/webp)');
  if (dataUrl.length > 1_500_000) throw new AppError(400, 'Ukuran logo terlalu besar (maks ± 1 MB)');
  const theme = loadSetting(req.storeId, 'theme', DEFAULTS.theme);
  theme.logo_data_url = dataUrl;
  saveSetting(req.storeId, 'theme', theme, req.user.id);
  const store = loadSetting(req.storeId, 'store', DEFAULTS.store);
  store.logo_data_url = dataUrl;
  saveSetting(req.storeId, 'store', store, req.user.id);
  audit({ userId: req.user.id, role: req.user.role, action: 'branding.logo', storeId: req.storeId, ip: req.ip, after: { size_kb: Math.round(String(req.body?.data_url || '').length / 1024) } });
  res.json({ ok: true, size_kb: Math.round(dataUrl.length / 1024) });
}));

router.delete(MOUNT + '/branding/logo', auth('setting.theme'), http((req, res) => {
  for (const key of ['theme', 'store']) {
    const block = loadSetting(req.storeId, key, DEFAULTS[key]);
    block.logo_data_url = null;
    saveSetting(req.storeId, key, block, req.user.id);
  }
  res.json({ ok: true });
}));

/** Palet preset yang bisa diklik pengguna (kustomisasi warna tanpa angka hex). */
router.get(MOUNT + '/branding/palettes', auth(), http((_req, res) => res.json([
  { name: 'Kopi', accent: '#8b5e34', canvas: '#faf6f1', mode: 'light' },
  { name: 'Senja', accent: '#f97316', canvas: '#fff7ed', mode: 'light' },
  { name: 'Matcha', accent: '#4d7c0f', canvas: '#f7fee7', mode: 'light' },
  { name: 'Navy', accent: '#2563eb', canvas: '#f1f5f9', mode: 'light' },
  { name: 'Daun', accent: '#059669', canvas: '#ecfdf5', mode: 'light' },
  { name: 'Cabai', accent: '#dc2626', canvas: '#fef2f2', mode: 'light' },
  { name: 'Malam', accent: '#a78bfa', canvas: '#0f172a', mode: 'dark' },
  { name: 'Grafit', accent: '#f4f4f5', canvas: '#18181b', mode: 'dark' },
])));

/** Token CSS yang dihasilkan dari setting.theme — dipakai ui.css (:root vars). */
router.get(MOUNT + '/branding/brand', auth(), http((req, res) => {
  res.json({ store: loadSetting(req.storeId, 'store', DEFAULTS.store), theme: loadSetting(req.storeId, 'theme', DEFAULTS.theme) });
}));

/** Publik (tanpa login) — supaya layar login bisa menampilkan logo & nama toko. */
router.get(MOUNT + '/public/brand', (_req, res) => {
  const store = firstRow(`SELECT id, name FROM stores WHERE is_active = 1 LIMIT 1`);
  if (!store) return res.json({ store: DEFAULTS.store, theme: DEFAULTS.theme });
  res.json({ store: loadSetting(store.id, 'store', DEFAULTS.store), theme: loadSetting(store.id, 'theme', DEFAULTS.theme) });
});

// ------------------------------------------------------------ pajak & diskon
router.get(MOUNT + '/taxes', auth(), http((req, res) => res.json(allRows(`SELECT * FROM taxes WHERE store_id = ? ORDER BY sort_order`, req.storeId))));
router.post(MOUNT + '/taxes', auth('setting.tax'), http((req, res) => {
  const b = req.body || {};
  const id = uid('tax');
  if (b.is_default) exec(`UPDATE taxes SET is_default = 0 WHERE store_id = ?`, req.storeId);
  exec(`INSERT INTO taxes (id, store_id, name, rate_pct, is_inclusive, is_active, is_default, sort_order) VALUES (?,?,?,?,?,?,?,?)`,
    id, req.storeId, b.name || 'Pajak', Number(b.rate_pct) || 0, b.is_inclusive ? 1 : 0, b.is_active === 0 ? 0 : 1, b.is_default ? 1 : 0, Number(b.sort_order) || 0);
  res.status(201).json(firstRow(`SELECT * FROM taxes WHERE id = ?`, id));
}));
router.put(MOUNT + '/taxes/:id', auth('setting.tax'), http((req, res) => {
  const b = req.body || {};
  if (b.is_default) exec(`UPDATE taxes SET is_default = 0 WHERE store_id = ?`, req.storeId);
  exec(`UPDATE taxes SET name=?, rate_pct=?, is_inclusive=?, is_active=?, is_default=?, sort_order=? WHERE id=? AND store_id=?`,
    b.name, Number(b.rate_pct) || 0, b.is_inclusive ? 1 : 0, b.is_active === 0 ? 0 : 1, b.is_default ? 1 : 0, Number(b.sort_order) || 0, req.params.id, req.storeId);
  res.json(firstRow(`SELECT * FROM taxes WHERE id = ? AND store_id = ?`, req.params.id, req.storeId));
}));
router.delete(MOUNT + '/taxes/:id', auth('setting.tax'), http((req, res) => {
  exec(`DELETE FROM taxes WHERE id = ? AND store_id = ?`, req.params.id, req.storeId);
  res.json({ ok: true });
}));

router.get(MOUNT + '/discounts', auth(), http((req, res) => res.json(allRows(`SELECT * FROM discounts WHERE store_id = ? ORDER BY rowid`, req.storeId).map(d => ({ ...d, ref_ids: pj(d.ref_ids) })))));
router.post(MOUNT + '/discounts', auth('setting.tax'), http((req, res) => {
  const b = req.body || {};
  if (!b.name) throw new AppError(400, 'Nama diskon wajib diisi');
  const id = uid('dsc');
  exec(
    `INSERT INTO discounts (id, store_id, name, kind, value, applies_to, ref_ids, trigger, days, start_time, end_time,
       min_subtotal, max_discount, stackable, is_active, valid_from, valid_to)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, req.storeId, b.name, b.kind === 'fixed' ? 'fixed' : 'percent', Number(b.value) || 0,
    ['global', 'category', 'item'].includes(b.applies_to) ? b.applies_to : 'global',
    b.ref_ids?.length ? JSON.stringify(b.ref_ids) : null,
    ['manual', 'auto_weekday', 'auto_time', 'auto_min_subtotal'].includes(b.trigger) ? b.trigger : 'manual',
    b.days?.length ? JSON.stringify(b.days) : null, b.start_time || null, b.end_time || null,
    Number(b.min_subtotal) || 0, b.max_discount != null ? Number(b.max_discount) : null,
    b.stackable ? 1 : 0, b.is_active === 0 ? 0 : 1, b.valid_from || null, b.valid_to || null
  );
  const row = firstRow(`SELECT * FROM discounts WHERE id = ?`, id);
  res.status(201).json({ ...row, ref_ids: pj(row.ref_ids) });
}));
router.put(MOUNT + '/discounts/:id', auth('setting.tax'), http((req, res) => {
  const b = req.body || {};
  const cur = firstRow(`SELECT * FROM discounts WHERE id = ? AND store_id = ?`, req.params.id, req.storeId);
  if (!cur) throw new AppError(404, 'Diskon tidak ditemukan');
  exec(
    `UPDATE discounts SET name=?, kind=?, value=?, applies_to=?, ref_ids=?, trigger=?, days=?, start_time=?, end_time=?,
       min_subtotal=?, max_discount=?, stackable=?, is_active=?, valid_from=?, valid_to=? WHERE id=? AND store_id=?`,
    b.name ?? cur.name, b.kind ?? cur.kind, Number(b.value ?? cur.value), b.applies_to ?? cur.applies_to,
    (b.ref_ids ?? (cur.ref_ids ? JSON.parse(cur.ref_ids) : null)) ? JSON.stringify(b.ref_ids ?? JSON.parse(cur.ref_ids)) : null,
    b.trigger ?? cur.trigger, b.days ? JSON.stringify(b.days) : cur.days, b.start_time ?? cur.start_time, b.end_time ?? cur.end_time,
    Number(b.min_subtotal ?? cur.min_subtotal), b.max_discount ?? cur.max_discount, b.stackable === undefined ? cur.stackable : (b.stackable ? 1 : 0),
    b.is_active === undefined ? cur.is_active : (b.is_active ? 1 : 0), b.valid_from ?? cur.valid_from, b.valid_to ?? cur.valid_to, req.params.id, req.storeId
  );
  res.json(firstRow(`SELECT * FROM discounts WHERE id = ? AND store_id = ?`, req.params.id, req.storeId));
}));
router.delete(MOUNT + '/discounts/:id', auth('setting.tax'), http((req, res) => {
  exec(`DELETE FROM discounts WHERE id = ? AND store_id = ?`, req.params.id, req.storeId);
  res.json({ ok: true });
}));

// ------------------------------------------------------------- metode bayar
router.get(MOUNT + '/payment-methods', auth(), http((req, res) => res.json(allRows(`SELECT * FROM payment_methods WHERE store_id = ? ORDER BY sort_order`, req.storeId))));
router.post(MOUNT + '/payment-methods', auth('setting.payment'), http((req, res) => {
  const b = req.body || {};
  if (!b.name) throw new AppError(400, 'Nama metode pembayaran wajib diisi');
  const id = uid('pay');
  if (b.is_default) exec(`UPDATE payment_methods SET is_default = 0 WHERE store_id = ?`, req.storeId);
  exec(`INSERT INTO payment_methods (id, store_id, name, kind, icon, service_fee_pct, is_enabled, is_default, sort_order)
        VALUES (?,?,?,?,?,?,?,?,?)`,
    id, req.storeId, b.name, b.kind || 'wallet', b.icon || null, Number(b.service_fee_pct) || 0,
    b.is_enabled === 0 ? 0 : 1, b.is_default ? 1 : 0, Number(b.sort_order) || 0);
  res.status(201).json(firstRow(`SELECT * FROM payment_methods WHERE id = ?`, id));
}));
router.put(MOUNT + '/payment-methods/:id', auth('setting.payment'), http((req, res) => {
  const b = req.body || {};
  const cur = firstRow(`SELECT * FROM payment_methods WHERE id = ? AND store_id = ?`, req.params.id, req.storeId);
  if (!cur) throw new AppError(404, 'Metode pembayaran tidak ditemukan');
  if (b.is_default) exec(`UPDATE payment_methods SET is_default = 0 WHERE store_id = ?`, req.storeId);
  exec(`UPDATE payment_methods SET name=?, kind=?, icon=?, service_fee_pct=?, is_enabled=?, is_default=?, sort_order=? WHERE id=? AND store_id=?`,
    b.name ?? cur.name, b.kind ?? cur.kind, b.icon ?? cur.icon, Number(b.service_fee_pct ?? cur.service_fee_pct),
    b.is_enabled === undefined ? cur.is_enabled : (b.is_enabled ? 1 : 0), b.is_default === undefined ? cur.is_default : (b.is_default ? 1 : 0),
    Number(b.sort_order ?? cur.sort_order), req.params.id, req.storeId);
  res.json(firstRow(`SELECT * FROM payment_methods WHERE id = ? AND store_id = ?`, req.params.id, req.storeId));
}));
router.delete(MOUNT + '/payment-methods/:id', auth('setting.payment'), http((req, res) => {
  exec(`DELETE FROM payment_methods WHERE id = ? AND store_id = ?`, req.params.id, req.storeId);
  res.json({ ok: true });
}));

/** Pratinjau struk: render layout dengan data transaksi terakhir tanpa login ulang. */
router.post(MOUNT + '/receipt/preview', auth(), http((req, res) => {
  const receipt = { ...loadSetting(req.storeId, 'receipt', DEFAULTS.receipt), ...(req.body?.receipt_overrides || {}) };
  const last = firstRow(`SELECT * FROM transactions WHERE store_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1`, req.storeId);
  const items = last ? allRows(`SELECT * FROM transaction_items WHERE transaction_id = ?`, last.id) : [];
  res.json({
    receipt,
    store: loadSetting(req.storeId, 'store', DEFAULTS.store),
    theme: loadSetting(req.storeId, 'theme', DEFAULTS.theme),
    sample: last ? { ...last, items } : null,
    variables: ['store_name', 'address', 'phone', 'invoice', 'date', 'cashier', 'customer', 'items', 'subtotal',
      'discount', 'service', 'tax', 'rounding', 'grand_total', 'payment', 'paid', 'change', 'footer', 'thank_you', 'npwp'],
  });
}));

// --------------------------------------------------------------------- cabang
router.get(MOUNT + '/branches', auth(), http((req, res) => res.json(allRows(`SELECT * FROM branches WHERE store_id = ? ORDER BY name`, req.storeId))));
router.post(MOUNT + '/branches', auth('setting.store'), http((req, res) => {
  const b = req.body || {};
  if (!b.name) throw new AppError(400, 'Nama cabang wajib diisi');
  const id = uid('brn');
  exec(`INSERT INTO branches (id, store_id, name, address, phone, is_default) VALUES (?,?,?,?,?,?)`,
    id, req.storeId, b.name, b.address || null, b.phone || null, b.is_default ? 1 : 0);
  if (b.is_default) exec(`UPDATE branches SET is_default = 0 WHERE store_id = ? AND id <> ?`, req.storeId, id);
  res.status(201).json(firstRow(`SELECT * FROM branches WHERE id = ?`, id));
}));
router.put(MOUNT + '/branches/:id', auth('setting.store'), http((req, res) => {
  const b = req.body || {};
  exec(`UPDATE branches SET name=?, address=?, phone=?, is_active=? WHERE id=? AND store_id=?`,
    b.name, b.address || null, b.phone || null, b.is_active === 0 ? 0 : 1, req.params.id, req.storeId);
  res.json(firstRow(`SELECT * FROM branches WHERE id = ? AND store_id = ?`, req.params.id, req.storeId));
}));
router.delete(MOUNT + '/branches/:id', auth('setting.store'), http((req, res) => {
  exec(`DELETE FROM branches WHERE id = ? AND store_id = ?`, req.params.id, req.storeId);
  res.json({ ok: true });
}));

/** Snapshot DB untuk backup manual (Fase 4: pemeliharaan). */
router.get(MOUNT + '/admin/backup', auth('system.maintenance'), http((_req, res) => {
  const file = DB_FILE + '.backup.sqlite';
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  } catch (err) {
    return res.status(500).json({ error: 'Backup gagal: ' + err.message });
  }
  audit({ userId: req.user.id, role: req.user.role, action: 'backup.download', entity: 'database', storeId: req.storeId, ip: req.ip, after: { file: path.basename(file) } });
  res.download(file, `kasir-backup-${new Date().toISOString().slice(0, 10)}.sqlite`, (err) => {
    if (err) console.warn('[backup] kirim file gagal:', err.message);
  });
}));

function pj(s) { try { return s ? JSON.parse(s) : []; } catch { return []; } }
