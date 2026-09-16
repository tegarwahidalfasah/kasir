// ===========================================================================
//  Lapisan akses database: node:sqlite (bawaan Node >= 22.5, tanpa native build)
//  - WAL + foreign_keys ON + busy_timeout  -> aman untuk 1 toko multi-kasir
//  - tx() dipakai SEMUA operasi yang menyentuh stok (ledger atomik)
//  - Skema di schema.sql, dijalankan idempoten saat boot
// ===========================================================================
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.KASIR_DATA_DIR || (process.env.VERCEL ? '/tmp' : path.join(__dirname, '..', 'data'));
const DB_PATH = process.env.KASIR_DB_PATH || path.join(DATA_DIR, 'kasir.db');

let schema = '';
const candidateSchemaPaths = [
  path.join(__dirname, 'schema.sql'),
  path.join(process.cwd(), 'server', 'src', 'db', 'schema.sql'),
  path.join(process.cwd(), 'src', 'db', 'schema.sql'),
];

for (const p of candidateSchemaPaths) {
  try {
    if (fs.existsSync(p)) {
      schema = fs.readFileSync(p, 'utf8');
      break;
    }
  } catch { /* continue */ }
}

try {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
} catch { /* noop */ }

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');
if (schema) {
  db.exec(schema);
}

export const DB_FILE = DB_PATH;

/** Jalankan `fn()` di dalam transaksi SQLite (atomic + rollback saat error). */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(db);
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

// node:sqlite mengembalikan baris "null prototype" -> plain object (ramah JSON/React)
const normalizeRow = (row) => Object.assign(Object.create(null), row);

/** Semua baris hasil query. */
export const allRows = (sql, ...params) => db.prepare(sql).all(...params).map(normalizeRow);
/** Baris pertama hasil query (atau undefined). */
export const firstRow = (sql, ...params) => {
  const row = db.prepare(sql).get(...params);
  return row ? normalizeRow(row) : undefined;
};
/** INSERT / UPDATE / DELETE -> { changes, lastInsertRowid } */
export const exec = (sql, ...params) => db.prepare(sql).run(...params);

export const uid = (prefix = '') => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
export const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
export const round2 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/** Simpan satu blok konfigurasi (JSON) per toko. */
export function saveSetting(storeId, key, value, userId = null) {
  exec(
    `INSERT INTO settings (store_id, key, value_json, updated_at, updated_by)
     VALUES (?, ?, ?, datetime('now'), ?)
     ON CONFLICT(store_id, key) DO UPDATE SET
       value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    storeId, key, JSON.stringify(value), userId
  );
}

/** Baca blok konfigurasi dengan merge ke default (deep-ish untuk objek bersarang 1 level). */
export function loadSetting(storeId, key, fallback) {
  const row = firstRow(`SELECT value_json FROM settings WHERE store_id = ? AND key = ?`, storeId, key);
  const base = structuredClone(fallback);
  if (!row) return base;
  try {
    return mergeDeep(base, JSON.parse(row.value_json));
  } catch {
    return base;
  }
}

export function mergeDeep(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const [k, v] of Object.entries(source)) {
    if (v === null) continue; // null = "biarkan default", jangan hapus struktur
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      target[k] = mergeDeep(structuredClone(target[k]), v);
    } else {
      target[k] = structuredClone(v);
    }
  }
  return target;
}
