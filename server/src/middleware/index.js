// ===========================================================================
//  Middleware: autentikasi (bearer token) + otorisasi (permission RBAC)
// ===========================================================================
import { verifyToken, tooManyAttempts, tooManyUserAttempts } from '../auth.js';
import { firstRow, loadSetting } from '../db/index.js';
import { permissionsFor, loadRoleMatrix } from '../rbac.js';
import { DEFAULTS } from '../config.js';
import { AppError } from '../lib/http.js';

// Rute yang boleh diakses tanpa token (login, branding publik, health check).
export const PUBLIC_PATHS = ['/auth/login', '/public/brand', '/health', '/openapi.json'];
const isPublic = (url = '') => PUBLIC_PATHS.some((p) => url.startsWith('/api' + p) || url === p);

/**
 * Autentikasi global. Dipasang pada SEMUA router, jadi rute publik harus dilewati
 * di sini (bukan dengan mengatur urutan router) — lebih aman untuk aplikasi kasir:
 * tidak ada satu pun rute baru yang lupa diproteksi.
 */
export function authenticate(req, res, next) {
  if (isPublic(req.originalUrl || req.url)) return next();
  if (req.user) return next(); // sudah diproses guard sebelumnya
  const header = req.get('authorization') || '';
  // hanya header Authorization: token di query string bisa tertinggal di log proxy/peramban
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) return next(new AppError(401, token ? 'Token tidak valid atau sesi berakhir' : 'Token tidak ditemukan, silakan masuk dulu'));
  const user = firstRow(
    `SELECT id, username, display_name, role, store_id, branch_id, is_active FROM users WHERE id = ?`, payload.uid);
  if (!user || !user.is_active) return next(new AppError(401, 'Akun tidak aktif'));
  req.user = user;
  req.storeId = user.store_id || firstRow(`SELECT id FROM stores WHERE is_active = 1 LIMIT 1`)?.id;
  req.branchId = user.branch_id;
  req.roleMatrix = loadRoleMatrix(loadSetting, req.storeId);
  req.permissions = permissionsFor(user.role, req.roleMatrix);
  next();
}

/** Guard permission: `router.post('/x', requirePerm('item.manage'), handler)` */
export const requirePerm = (perm) => (req, _res, next) => {
  const perms = req.permissions || [];
  const ok = Array.isArray(perm)
    ? perm.some((p) => perms.includes('*') || perms.includes(p))
    : perms.includes('*') || perms.includes(perm);
  if (!ok) return next(new AppError(403, `Butuh hak akses: ${Array.isArray(perm) ? perm.join(' atau ') : perm}`));
  next();
};

/**
 * Pembatas percobaan login. Selain per-IP, juga per-username: header
 * X-Forwarded-For yang dipalsukan tidak lagi memberi jatah tak terbatas.
 */
export const loginGuard = (req, _res, next) => {
  if (tooManyAttempts(req.ip)) return next(new AppError(429, 'Terlalu banyak percobaan login dari jaringan ini, tunggu 60 detik'));
  const username = typeof req.body?.username === 'string' ? req.body.username : '';
  if (username && tooManyUserAttempts(username)) {
    return next(new AppError(429, 'Terlalu banyak percobaan untuk akun ini, tunggu 60 detik'));
  }
  next();
};

/** Pengaturan toko (dipakai banyak route). */
export function setting(key) {
  return (storeId) => loadSetting(storeId, key, DEFAULTS[key]);
}
