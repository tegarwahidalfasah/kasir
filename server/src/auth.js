// ===========================================================================
//  Autentikasi ringan tanpa dependency eksternal.
//  - Password: scrypt (Node builtin) + salt per user
//  - Token   : JWT HS256 dibuat manual (header.payload.signature)
//  - Rate limit login: in-memory, dua ember/60 detik (per-IP 5x, per-username 8x)
// ===========================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, firstRow, exec, uid, nowIso } from './db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = process.env.KASIR_SECRET_FILE || (process.env.VERCEL ? path.join('/tmp', '.jwt-secret') : path.join(__dirname, 'data', '.jwt-secret'));

function loadSecret() {
  if (process.env.KASIR_JWT_SECRET) return process.env.KASIR_JWT_SECRET;
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    try {
      fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
      fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    } catch {
      // In read-only or serverless environments where writing fails, just use generated secret
    }
    return secret;
  }
}
const SECRET = loadSecret();
const TTL_SECONDS = Number(process.env.KASIR_TOKEN_TTL || 12 * 3600);

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return `s2:${salt}:${hash}`;
}

export function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [tag, salt, hash] = stored.split(':');
  if (tag !== 's2' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(hash, 'hex'));
}

export function signToken(payload, ttl = TTL_SECONDS) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttl }));
  const signature = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- rate limiting
// Dua ember per 60 detik: per-IP (mudah dipalsukan lewat XFF bila proxy salah
// dikonfigurasi) dan per-username (tidak bisa diakali dengan mengganti IP).
// Keduanya in-memory: hilang saat restart dan tidak berbagi antar proses — untuk
// produksi multi-proses/serverless pindahkan ke store bersama (lihat docs/11 §6).
const attempts = new Map();
const WINDOW_MS = 60_000;
const IP_LIMIT = Math.max(1, Number(process.env.KASIR_LOGIN_LIMIT_IP) || 5);
const USER_LIMIT = Math.max(1, Number(process.env.KASIR_LOGIN_LIMIT_USER) || 8);
const MAX_BUCKETS = 20_000;   // XFF palsu tak boleh membuat Map tumbuh tanpa batas

function prune() {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, rec] of attempts) if (rec.first < cutoff) attempts.delete(key);
  if (attempts.size > MAX_BUCKETS) attempts.clear();   // kondisi diserang: buang semua, mulai lagi
}

function hit(key, limit) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) { attempts.delete(key); return false; }
  return rec.count >= limit;
}

function bump(key) {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) attempts.set(key, { first: Date.now(), count: 1 });
  else rec.count += 1;
  if (attempts.size > MAX_BUCKETS / 2) prune();
}

export const userKey = (username) => 'u:' + String(username || '').trim().toLowerCase();

export function tooManyAttempts(ip) { return hit(ip, IP_LIMIT); }
export function tooManyUserAttempts(username) { return hit(userKey(username), USER_LIMIT); }
export function clearAttempts(ip) { attempts.delete(ip); }
export function clearUserAttempts(username) { attempts.delete(userKey(username)); }
export function bumpAttempt(ip) { bump(ip); }
export function bumpUserAttempt(username) { bump(userKey(username)); }

// ------------------------------------------------------------------ login
export function authenticate(username, password) {
  const user = firstRow(`SELECT * FROM users WHERE lower(username) = lower(?)`, username);
  if (!user || !user.is_active) return { error: 'invalid' };
  const ok = verifyPassword(password, user.password_hash) ||
    (user.pin && verifyPassword(password, user.pin));
  if (!ok) return { error: 'invalid' };
  exec(`UPDATE users SET last_login_at = ? WHERE id = ?`, nowIso(), user.id);
  const token = signToken({ uid: user.id, role: user.role, sid: user.store_id });
  return { user, token };
}

export function hashPin(pin) {
  return pin ? hashPassword(pin) : null;
}

// ------------------------------------------------------------------ audit log
export function audit({ userId = null, role = null, action, entity = null, entityId = null, before = null, after = null, storeId = null, ip = null }) {
  try {
    exec(
      `INSERT INTO audit_logs (id, store_id, user_id, actor_role, action, entity, entity_id, before_json, after_json, ip, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      uid('aud'), storeId, userId, role, action, entity, entityId,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, ip, nowIso()
    );
  } catch (err) {
    console.warn('[audit] gagal menulis log:', err.message);
  }
}
