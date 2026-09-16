// ===========================================================================
//  Rute Pengguna & Hak Akses (RBAC, Fase 2)
// ===========================================================================
import express from 'express';
import { allRows, firstRow, exec, uid, loadSetting, saveSetting } from '../db/index.js';
import { authenticate, requirePerm } from '../middleware/index.js';
import { hashPassword, hashPin, audit } from '../auth.js';
import { ROLE_PRESETS, ROLE_KEYS, PERMISSIONS } from '../rbac.js';
import { http, AppError } from '../lib/http.js';

export const router = express.Router();
const MOUNT = ''; // path sudah memuat prefiks; mount di index.js memakai '/api'
const auth = (...p) => [authenticate, ...p.map((x) => requirePerm(x))].flat();


// ------------------------------------------------------------------- users
router.get(MOUNT + '/users', auth(['user.manage', 'role.manage']), http((req, res) => {
  res.json(allRows(
    `SELECT id, username, display_name, role, is_active, last_login_at, created_at, branch_id
     FROM users WHERE store_id = ? OR store_id IS NULL ORDER BY role, username`,
    req.storeId
  ));
}));

router.post(MOUNT + '/users', auth('user.manage'), http((req, res) => {
  const b = req.body || {};
  if (!b.username || !b.password || !b.display_name) throw new AppError(400, 'username, password, display_name wajib diisi');
  if (String(b.password).length < 6) throw new AppError(400, 'Password minimal 6 karakter');
  if (!ROLE_KEYS.includes(b.role)) throw new AppError(400, `Role tidak dikenal: ${b.role}`);
  if (firstRow(`SELECT id FROM users WHERE lower(username) = lower(?)`, b.username)) throw new AppError(409, 'Username sudah dipakai');
  const id = uid('usr');
  exec(
    `INSERT INTO users (id, store_id, branch_id, username, password_hash, display_name, pin, role, is_active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,1,datetime('now'),datetime('now'))`,
    id, req.storeId, b.branch_id || null, b.username, hashPassword(b.password), b.display_name, hashPin(b.pin), b.role
  );
  audit({ userId: req.user.id, role: req.user.role, action: 'user.create', entity: 'user', entityId: id, storeId: req.storeId, after: { username: b.username, role: b.role } });
  res.status(201).json({ id, username: b.username, role: b.role });
}));

router.put(MOUNT + '/users/:id', auth('user.manage'), http((req, res) => {
  // scoping toko: admin toko lain tidak boleh mengubah/reset password user di luar tokonya
  const u = firstRow(`SELECT * FROM users WHERE id = ? AND (store_id = ? OR store_id IS NULL)`, req.params.id, req.storeId);
  if (!u) throw new AppError(404, 'User tidak ditemukan');
  const b = req.body || {};
  if (b.role && !ROLE_KEYS.includes(b.role)) throw new AppError(400, 'Role tidak dikenal');
  if (u.id === req.user.id && b.is_active === 0) throw new AppError(400, 'Tidak bisa menonaktifkan akun sendiri');
  exec(`UPDATE users SET display_name = ?, role = ?, is_active = ?, branch_id = ?, updated_at = datetime('now') WHERE id = ?`,
    b.display_name ?? u.display_name, b.role ?? u.role, b.is_active === 0 ? 0 : 1, b.branch_id ?? u.branch_id, u.id);
  if (b.password) {
    if (String(b.password).length < 6) throw new AppError(400, 'Password minimal 6 karakter');
    exec(`UPDATE users SET password_hash = ? WHERE id = ?`, hashPassword(b.password), u.id);
  }
  if (b.pin !== undefined) exec(`UPDATE users SET pin = ? WHERE id = ?`, hashPin(b.pin), u.id);
  audit({ userId: req.user.id, role: req.user.role, action: 'user.update', entity: 'user', entityId: u.id, storeId: req.storeId, before: { role: u.role, is_active: u.is_active }, after: { role: b.role ?? u.role, is_active: b.is_active ?? 1, password: !!b.password } });
  res.json({ ok: true });
}));

router.delete(MOUNT + '/users/:id', auth('user.manage'), http((req, res) => {
  if (req.params.id === req.user.id) throw new AppError(400, 'Tidak bisa menghapus akun sendiri');
  const target = firstRow(`SELECT id, role FROM users WHERE id = ? AND (store_id = ? OR store_id IS NULL)`, req.params.id, req.storeId);
  if (!target) throw new AppError(404, 'User tidak ditemukan');
  const owners = firstRow(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND is_active = 1 AND store_id = ?`, req.storeId).n;
  if (target.role === 'owner' && owners <= 1) throw new AppError(400, 'Harus ada minimal satu pemilik toko aktif');
  exec(`DELETE FROM users WHERE id = ? AND (store_id = ? OR store_id IS NULL)`, req.params.id, req.storeId);
  audit({ userId: req.user.id, role: req.user.role, action: 'user.delete', entity: 'user', entityId: req.params.id, storeId: req.storeId });
  res.json({ ok: true });
}));

// ------------------------------------------------------------------- roles
router.get(MOUNT + '/roles', auth(), http((req, res) => {
  const matrix = loadSetting(req.storeId, 'rbac', { roles: Object.fromEntries(ROLE_KEYS.map((r) => [r, ROLE_PRESETS[r].permissions])) });
  res.json({
    permissions: PERMISSIONS,
    roles: ROLE_KEYS.map((key) => ({
      key, label: ROLE_PRESETS[key].label, description: ROLE_PRESETS[key].description,
      permissions: matrix.roles?.[key] || ROLE_PRESETS[key].permissions,
      users: firstRow(`SELECT COUNT(*) AS n FROM users WHERE role = ? AND (store_id = ? OR store_id IS NULL)`, key, req.storeId).n,
    })),
  });
}));

router.put(MOUNT + '/roles/:role', auth('role.manage'), http((req, res) => {
  const role = req.params.role;
  if (!ROLE_KEYS.includes(role)) throw new AppError(400, 'Role tidak dikenal');
  const list = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  const valid = list.filter((p) => p === '*' || PERMISSIONS.some((x) => x.key === p));
  if (role === 'owner' && !valid.includes('*')) throw new AppError(400, 'Role pemilik harus tetap punya akses penuh');
  const storeId = req.storeId;
  const matrix = loadSetting(storeId, 'rbac', { roles: Object.fromEntries(ROLE_KEYS.map((r) => [r, ROLE_PRESETS[r].permissions])) });
  matrix.roles = { ...matrix.roles, [role]: valid };
  saveSetting(storeId, 'rbac', matrix, req.user.id);
  audit({ userId: req.user.id, role: req.user.role, action: 'role.update', entity: 'rbac', entityId: role, storeId, after: { permissions: valid } });
  res.json({ ok: true, role, permissions: valid });
}));

/** Matriks lengkap permission x role untuk halaman "Hak Akses". */
router.post(MOUNT + '/roles/reset', auth('role.manage'), http((req, res) => {
  saveSetting(req.storeId, 'rbac', { roles: Object.fromEntries(ROLE_KEYS.map((r) => [r, ROLE_PRESETS[r].permissions])) }, req.user.id);
  res.json({ ok: true, restored: ROLE_KEYS });
}));

// ------------------------------------------------------------------- audit log
/** Log audit per toko. Saring dengan ?user_id=, ?entity=, ?entity_id=, ?action=, ?limit= (maks 300). */
router.get(MOUNT + '/audit', auth(['role.manage', 'system.maintenance']), http((req, res) => {
  const where = ['a.store_id = ?'];
  const params = [req.storeId];
  const q = req.query || {};
  for (const key of ['user_id', 'entity', 'entity_id', 'action']) {
    if (q[key]) { where.push(`a.${key} = ?`); params.push(q[key]); }
  }
  params.push(Math.min(300, Number(q.limit) || 100));
  res.json(allRows(
    `SELECT a.*, u.display_name AS actor FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`,
    ...params
  ));
}));
