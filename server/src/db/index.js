// ===========================================================================
//  Lapisan akses database: node:sqlite lokal atau Turso/libSQL bersama via HTTP
//  - WAL + foreign_keys ON + busy_timeout  -> aman untuk 1 toko multi-kasir
//  - tx() dipakai SEMUA operasi yang menyentuh stok (ledger atomik)
//  - Lokal: skema/migrasi saat boot. Online: provisioning eksplisit db:setup.
// ===========================================================================
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { beginBatch, commitBatch, abortBatch } from '../events.js';
import { remoteConfig, SCHEMA_VERSION } from './remote-config.js';
import { LibsqlSync } from './libsql-sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.KASIR_DATA_DIR || (process.env.VERCEL ? '/tmp' : path.join(__dirname, '..', 'data'));
const remote = remoteConfig();
export const IS_REMOTE = Boolean(remote);
export const STOCK_TRANSPORT = (IS_REMOTE || process.env.VERCEL) ? 'poll' : 'sse';
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

if (!schema) throw new Error('Skema database tidak ditemukan: server/src/db/schema.sql');
if (!IS_REMOTE) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
export const db = IS_REMOTE ? new LibsqlSync(remote) : new DatabaseSync(DB_PATH);
if (IS_REMOTE) {
  try {
    const version = db.prepare('SELECT version FROM kasir_schema WHERE id = 1').get()?.version;
    if (version !== SCHEMA_VERSION) throw new Error('schema version mismatch');
  } catch (err) {
    db.close();
    throw new Error('Database Turso belum siap. Periksa koneksi/token lalu jalankan npm run db:setup sebelum deploy.', { cause: err });
  }
} else {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(schema);
}

// ---------------------------------------------------------------- migrasi aditif
// Skema di schema.sql bersifat idempoten (CREATE ... IF NOT EXISTS), tetapi itu TIDAK
// mengubah tabel yang sudah ada — menambah kolom baru hanya berpengaruh pada DB baru.
// Kolom baru karena itu didaftarkan di sini: dipastikan ada saat boot, sehingga DB
// produksi yang sudah berisi data ikut ter-upgrade tanpa alat migrasi terpisah.
// Sengaja hanya operasi aditif (ADD COLUMN) yang aman & idempoten; belum ada versi
// bernomor, rollback, atau perubahan yang membangun ulang tabel (mis. mengubah CHECK).
const ADDITIVE_COLUMNS = [
  ['transaction_items', 'refunded_qty', 'REAL NOT NULL DEFAULT 0'],
  ['transaction_items', 'bom_json', 'TEXT'],
  ['transactions', 'refund_total', 'REAL NOT NULL DEFAULT 0'],
  ['transactions', 'refund_cost', 'REAL NOT NULL DEFAULT 0'],
];

/** Tambahkan kolom yang belum ada; mengembalikan daftar "tabel.kolom" yang baru dibuat. */
export function migrateSchema() {
  if (IS_REMOTE) return []; // Migrasi online hanya lewat db:setup, bukan tiap cold start.
  const applied = [];
  for (const [table, column, ddl] of ADDITIVE_COLUMNS) {
    let info = [];
    try { info = db.prepare(`PRAGMA table_info(${table})`).all(); } catch { /* tabel belum ada */ }
    if (!info.length || info.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    applied.push(`${table}.${column}`);
  }
  return applied;
}

const appliedMigrations = migrateSchema();
if (appliedMigrations.length) {
  console.log(`[db] migrasi aditif diterapkan: ${appliedMigrations.join(', ')}`);
}

// Label aman untuk health/log; jangan bocorkan URL/token DB.
export const DB_FILE = IS_REMOTE ? 'turso' : DB_PATH;

/** Jalankan `fn()` di dalam transaksi SQLite (atomic + rollback saat error). */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  // Event SSE (perubahan stok) ditahan selama transaksi: kalau ROLLBACK, klien
  // tidak boleh pernah melihat angka yang tidak jadi tersimpan (docs/11 §15).
  beginBatch();
  try {
    const out = fn(db);
    if (out && typeof out.then === 'function') throw new Error('tx() memerlukan callback sinkron.');
    db.exec('COMMIT');
    commitBatch();
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    abortBatch();
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
export const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
// `round2` adalah nama lama dari fungsi yang sama (dipakai luas untuk uang & qty).
// 1e6 dipakai supaya qty bahan desimal (gram/ml) tidak terpangkas.
export const round2 = round6;

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
