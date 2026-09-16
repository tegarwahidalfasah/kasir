#!/usr/bin/env node
// ===========================================================================
//  Cadangan pangkalan data (Fase 4 — pemeliharaan).
//    node server/scripts/backup.js [--to=DIR] [--keep=14] [--verify] [--name=LABEL]
//
//  - Memakai `VACUUM INTO` (SQLite) -> salinan konsisten satu file, aman dijalankan
//    ketika server aktif (tidak mengunci DB produksi lama-lama).
//  - --verify  : buka hasil salinan read-only, jalankan PRAGMA integrity_check,
//                lalu bandingkan jumlah baris kunci dengan sumber.
//  - --keep=N  : hapus cadangan lama bila jumlahnya melebihi N.
//  Direktori tujuan: --to > env KASIR_BACKUP_DIR > <KASIR_DATA_DIR>/backups
// ===========================================================================
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, DATA_DIR, db } from '../src/db/index.js';

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const flag = (name) => argv.includes(`--${name}`);

const outDir = path.resolve(arg('to', process.env.KASIR_BACKUP_DIR || path.join(DATA_DIR, 'backups')));
const keep = Number(arg('keep', 14));
const verify = flag('verify');
const label = arg('name', '');

const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13); // YYYYMMDDHHMM
const fileName = `kasir-${stamp}${label ? `-${label}` : ''}.sqlite`;
const target = path.join(outDir, fileName);

const COUNT_TABLES = ['items', 'stock_movements', 'transactions', 'transaction_items', 'users', 'settings', 'audit_logs'];
const counts = (handle) => Object.fromEntries(COUNT_TABLES.map((t) => [t, handle.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));

function main() {
  if (!fs.existsSync(DB_FILE)) {
    console.error(`❌ Berkas DB tidak ditemukan: ${DB_FILE}\n   Pastikan KASIR_DATA_DIR benar atau jalankan "npm run seed" lebih dulu.`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  if (fs.existsSync(target)) fs.rmSync(target);

  const t0 = Date.now();
  // VACUUM INTO menulis salinan beku; nama file dikutip agar aman dari spasi.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const size = fs.statSync(target).size;

  // WAL: pastikan perubahan terakhir ikut terbawa salinan.
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* tidak fatal */ }

  let sourceCounts = {};
  try { sourceCounts = counts(db); } catch { /* diisi ulang saat verify */ }

  if (verify) {
    const copy = new DatabaseSync(target, { readOnly: true });
    const check = copy.prepare('PRAGMA integrity_check').get().integrity_check;
    const copyCounts = counts(copy);
    const drift = Object.entries(copyCounts).filter(([t, n]) => (sourceCounts[t] ?? n) !== n).map(([t]) => t);
    const fk = copy.prepare('PRAGMA foreign_key_check').all();
    copy.close();
    if (check !== 'ok') { console.error(`❌ integrity_check gagal pada ${fileName}: ${check}`); process.exit(1); }
    if (drift.length) { console.error(`❌ Jumlah baris berbeda setelah salinan: ${drift.join(', ')} (mungkin ada transaksi aktif saat backup — jalankan ulang)`); process.exit(1); }
    if (fk.length) { console.error(`❌ foreign_key_check menemukan ${fk.length} baris menggantung`); process.exit(1); }
    console.log(`✅ verifikasi: integrity_check=ok · foreign_key_check=bersih · baris ${Object.values(copyCounts).reduce((a, b) => a + b, 0).toLocaleString('id-ID')} cocok`);
  }

  // rotasi
  let removed = 0;
  if (keep > 0) {
    const files = fs.readdirSync(outDir).filter((f) => /^kasir-.*\.sqlite$/.test(f)).sort();
    while (files.length > keep) {
      const old = files.shift();
      fs.rmSync(path.join(outDir, old));
      removed += 1;
      console.log(`   · cadangan lama dihapus: ${old}`);
    }
  }

  console.log(`✅ Cadangan → ${target}`);
  console.log(`   ukuran ${(size / 1024 / 1024).toFixed(2)} MB · ${((Date.now() - t0) / 1000).toFixed(2)} s · rotasi ${keep > 0 ? `maks ${keep} berkas (${removed} dihapus)` : 'tanpa rotasi'}`);
  console.log(`   sumber: ${DB_FILE}`);
  console.log(`   pulihkan dengan: npm run maintenance -- restore ${target}`);
}

main();
