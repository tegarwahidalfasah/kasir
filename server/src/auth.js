// ===========================================================================
//  Autentikasi ringan tanpa dependency eksternal.
//  - Password: scrypt (Node builtin) + salt per user
//  - Token   : JWT HS256 dibuat manual (header.payload.signature)
//  - Rate limit login: in-memory (5 percobaan / 60 detik / IP)
// ===========================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, firstRow, exec, uid, nowIso } from './db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = path.join(__dirname, 'data', '.jwt-secret');

function loadSecret() {
  if (process.env.KASIR_JWT_SECRET) return process.env.KASIR_JWT_SECRET;
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
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
const attempts = new Map();
export function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > 60_000) { attempts.delete(ip); return false; }
  return rec.count >= 5;
}
export function clearAttempts(ip) { attempts.delete(ip); }
export function bumpAttempt(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > 60_000) attempts.set(ip, { first: Date.now(), count: 1 });
  else rec.count += 1;
}

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
