#!/usr/bin/env node
// ===========================================================================
//  Alat pemeliharaan (Fase 4). Semua perintah memakai node:sqlite — tidak butuh
//  CLI `sqlite3` di server, sehingga bisa jalan di VPS minimal.
//
//    npm run maintenance -- status                 Ringkasan DB & cadangan terakhir
//    npm run maintenance -- verify [berkas]         integrity_check + foreign_key_check
//    npm run maintenance -- backup                  Panggil scripts/backup.js --verify
//    npm run maintenance -- restore <berkas> --yes  Kembalikan cadangan (server harus mati)
//    npm run maintenance -- vacuum                  Perkecil berkas DB + checkpoint WAL
//    npm run maintenance -- prune [--audit-days=180] [--alert-days=90] [--backup-days=45]
//    npm run maintenance -- health [--api=URL]      Cek /api/health + ambang disk
// ===========================================================================
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { DB_FILE, DATA_DIR, db } from '../src/db/index.js';

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'status';
const arg = (name, def = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const flag = (name) => argv.includes(`--${name}`);
const posArgs = argv.filter((a) => !a.startsWith('--'));

const BACKUP_DIR = path.resolve(arg('backups', process.env.KASIR_BACKUP_DIR || path.join(DATA_DIR, 'backups')));
const TABLES = ['stores', 'users', 'items', 'item_recipes', 'stock_movements', 'transactions', 'transaction_items', 'alerts', 'audit_logs', 'settings'];
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
const die = (msg) => { console.error('❌ ' + msg); process.exit(1); };

function counts(handle) {
  const out = {};
  for (const t of TABLES) {
    try { out[t] = handle.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { out[t] = null; }
  }
  return out;
}

function inspect(file, { deep = true } = {}) {
  if (!fs.existsSync(file)) die(`berkas tidak ditemukan: ${file}`);
  const h = new DatabaseSync(file, { readOnly: true });
  const res = { file, size: fs.statSync(file).size, counts: counts(h), integrity: 'ok', fk: 0 };
  try {
    if (deep) {
      res.integrity = h.prepare('PRAGMA integrity_check').get().integrity_check;
      res.fk = h.prepare('PRAGMA foreign_key_check').all().length;
    }
    const journal = h.prepare('PRAGMA journal_mode').get().journal_mode;
    res.journal = journal;
    res.pages = h.prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get().bytes;
  } finally { h.close(); }
  return res;
}

const listBackups = () => {
  try {
    return fs.readdirSync(BACKUP_DIR).filter((f) => /^kasir-.*\.sqlite$/.test(f)).sort().reverse()
      .map((f) => ({ name: f, file: path.join(BACKUP_DIR, f), mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime, size: fs.statSync(path.join(BACKUP_DIR, f)).size }));
  } catch { return []; }
};

function cmdStatus() {
  const info = inspect(DB_FILE);
  console.log(`\n📦 Kasir — status pemeliharaan\n`);
  console.log(`  DB              : ${info.file}`);
  console.log(`  ukuran          : ${mb(info.size)} (perkiraan halaman aktif ${mb(info.pages || 0)}) · journal ${info.journal}`);
  const wal = DB_FILE + '-wal';
  if (fs.existsSync(wal)) console.log(`  WAL menunggu     : ${mb(fs.statSync(wal).size)}`);
  console.log(`  integrity_check : ${info.integrity}${info.fk ? ` · foreign_key_check ${info.fk} baris menggantung ⚠️` : ' · foreign_key_check bersih'}`);
  console.log(`  baris           : ${Object.entries(info.counts).map(([k, v]) => `${k}=${v ?? '—'}`).join(' · ')}`);
  const backups = listBackups();
  if (backups.length) {
    const last = backups[0];
    const ageH = (Date.now() - last.mtime.getTime()) / 3600000;
    console.log(`  cadangan        : ${backups.length} berkas · terbaru ${last.name} (${mb(last.size)}, ${ageH.toFixed(1)} jam lalu)`);
    if (ageH > 26) console.log(`  ⚠️ cadangan terakhir lebih dari 26 jam — periksa cron "kasir backup"`);
  } else {
    console.log(`  cadangan        : BELUM ADA di ${BACKUP_DIR}`);
  }
  const stat = fs.statfsSync(path.dirname(DB_FILE));
  const freeGb = stat.bavail * stat.bsize / 1024 ** 3;
  console.log(`  ruang disk      : sisa ${freeGb.toFixed(1)} GB di partisi data${freeGb < 1 ? ' ⚠️ hampir penuh' : ''}`);
  // aturan yang sama dengan GET /api/stock/integrity: stok = Σ SELURUH baris ledger
  // (baris voided=1 tetap dihitung karena pembatalan diimbangi baris balik, bukan dihapus)
  const ledger = db.prepare(
    `SELECT i.name, ROUND(i.stock_qty - COALESCE((SELECT SUM(m.qty) FROM stock_movements m WHERE m.item_id = i.id), 0), 6) AS selisih
     FROM items i
     WHERE i.is_non_stock = 0 AND i.is_active = 1
       AND ABS(i.stock_qty - COALESCE((SELECT SUM(m.qty) FROM stock_movements m WHERE m.item_id = i.id), 0)) > 0.001
     ORDER BY ABS(selisih) DESC LIMIT 5`
  ).all();
  console.log(`  ledger vs stok  : ${ledger.length ? `⚠️ ${ledger.length} item berbeda dari Σ ledger (${ledger.map((x) => `${x.name}: ${x.selisih}`).join(', ')}) — jalankan POST /api/stock/reconcile lalu cek lagi` : 'cocok (Σ ledger = stok)'}`);
  console.log();
}

function cmdVerify() {
  const target = posArgs[1] || listBackups()[0]?.file;
  if (!target) die('tidak ada berkas untuk diverifikasi — pakai: verify <berkas>');
  const info = inspect(target);
  console.log(`\n🔍 Verifikasi ${info.file}\n   ukuran ${mb(info.size)} · integrity_check ${info.integrity} · foreign_key_check ${info.fk} baris`);
  console.log(`   ${Object.entries(info.counts).map(([k, v]) => `${k}=${v ?? '—'}`).join(' · ')}\n`);
  if (info.integrity !== 'ok' || info.fk) die('berkas rusak / tidak konsisten — jangan dipakai untuk pemulihan');
  console.log('✅ Berkas sehat dan siap dipakai memulihkan data.\n');
}

function cmdRestore() {
  const target = posArgs[1];
  if (!target) die('pakai: restore <berkas-cadangan> --yes');
  const info = inspect(target);
  if (info.integrity !== 'ok' || info.fk) die('cadangan gagal verifikasi — hentikan (jangan menimpa DB yang ada dengan berkas rusak)');
  if (!flag('yes')) die('tambahkan --yes untuk konfirmasi. Langkah aman: hentikan layanan (`systemctl stop kasir`), jalankan backup dulu, lalu ulangi perintah ini.');
  if (fs.existsSync(DB_FILE)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
    const keep = `${DB_FILE}.pre-restore-${stamp}`;
    fs.copyFileSync(DB_FILE, keep);
    console.log(`   salinan pengaman DB lama → ${keep}`);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_FILE + suffix); } catch { }
  }
  fs.copyFileSync(target, DB_FILE);
  const after = inspect(DB_FILE, { deep: false });
  console.log(`✅ Dipulihkan ${mb(after.size)} → ${DB_FILE} (${Object.values(after.counts).reduce((a, b) => a + (b || 0), 0)} baris)`);
  console.log('   nyalakan layanan lalu cek: curl -s localhost:4000/api/health');
}

function cmdVacuum() {
  const before = fs.statSync(DB_FILE).size;
  db.exec('VACUUM');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const after = fs.statSync(DB_FILE).size;
  console.log(`✅ VACUUM selesai: ${mb(before)} → ${mb(after)} (hemat ${mb(Math.max(0, before - after))})`);
}

/** Hemat ruang: log audit & alert lama, cadangan kedaluwarsa. Tidak menyentuh transaksi/stok. */
function cmdPrune() {
  const auditDays = Number(arg('audit-days', 180));
  const alertDays = Number(arg('alert-days', 90));
  const backupDays = Number(arg('backup-days', 45));
  const dryRun = flag('dry-run');
  const n = (sql, ...p) => db.prepare(sql).get(...p).n;
  const audit = n(`SELECT COUNT(*) AS n FROM audit_logs WHERE created_at < datetime('now', ?)`, `-${auditDays} days`);
  const alerts = n(`SELECT COUNT(*) AS n FROM alerts WHERE created_at < datetime('now', ?)`, `-${alertDays} days`);
  const reads = n(`SELECT COUNT(*) AS n FROM alert_reads ar WHERE NOT EXISTS (SELECT 1 FROM alerts a WHERE a.id = ar.alert_id)`);
  console.log(`\n🧹 Ringkas: audit_logs ${audit} (> ${auditDays} hari) · alerts ${alerts} (> ${alertDays} hari) · alert_reads yatim ${reads}`);
  const old = listBackups().filter((b) => (Date.now() - b.mtime.getTime()) / 86400000 > backupDays);
  console.log(`   cadangan > ${backupDays} hari: ${old.length ? old.map((b) => b.name).join(', ') : 'tidak ada'}`);
  if (dryRun) { console.log('   (--dry-run: tidak ada yang dihapus)\n'); return; }
  if (!flag('yes')) die('tambahkan --yes untuk benar-benar menghapus, atau pakai --dry-run untuk melihat saja');
  if (audit) db.exec(`DELETE FROM audit_logs WHERE created_at < datetime('now', '-${auditDays} days')`);
  if (alerts) {
    db.exec(`DELETE FROM alert_reads WHERE alert_id IN (SELECT id FROM alerts WHERE created_at < datetime('now', '-${alertDays} days'))`);
    db.exec(`DELETE FROM alerts WHERE created_at < datetime('now', '-${alertDays} days')`);
  }
  if (reads) db.exec(`DELETE FROM alert_reads WHERE NOT EXISTS (SELECT 1 FROM alerts a WHERE a.id = alert_reads.alert_id)`);
  for (const b of old) fs.rmSync(b.file);
  console.log(`✅ Selesai: ${audit + alerts + reads} baris & ${old.length} berkas dibersihkan`);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log();
}

async function cmdHealth() {
  const api = arg('api', process.env.API_URL || `http://127.0.0.1:${process.env.PORT || 4000}`);
  try {
    const res = await fetch(`${api}/api/health`, { signal: AbortSignal.timeout(5000) });
    const j = await res.json();
    const ok = res.ok && j.ok;
    console.log(`${ok ? '✅' : '⚠️'} ${api}/api/health → HTTP ${res.status} · uptime ${j.uptime_s}s · node ${j.node} · items ${j.items} · sales ${j.sales} · movements ${j.movements}`);
  } catch (err) {
    die(`${api}/api/health tidak menjawab: ${err.message}`);
  }
  const stat = fs.statfsSync(path.dirname(DB_FILE));
  const usedPct = 100 * (1 - stat.bavail / stat.blocks);
  console.log(`${usedPct > 85 ? '⚠️' : '✅'} penggunaan disk partisi data: ${usedPct.toFixed(1)}%`);
  const info = inspect(DB_FILE, { deep: false });
  console.log(`${info.integrity === 'ok' ? '✅' : '⚠️'} integrity_check: ${info.integrity}`);
  const backups = listBackups();
  const ageH = backups.length ? (Date.now() - backups[0].mtime.getTime()) / 3600000 : Infinity;
  console.log(`${ageH <= 26 ? '✅' : '⚠️'} cadangan terakhir ${backups.length ? `${ageH.toFixed(1)} jam lalu (${backups[0].name})` : 'belum ada'}`);
}

const KNOWN = ['status', 'verify', 'backup', 'restore', 'vacuum', 'prune', 'health'];
switch (cmd) {
  case 'status': cmdStatus(); break;
  case 'verify': cmdVerify(); break;
  case 'backup': {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'backup.js'), '--verify', ...argv.slice(1).filter((a) => a !== 'backup')], { stdio: 'inherit' });
    process.exit(r.status || 0);
  }
  case 'restore': cmdRestore(); break;
  case 'vacuum': cmdVacuum(); break;
  case 'prune': cmdPrune(); break;
  case 'health': cmdHealth(); break;
  default:
    console.error(`Perintah tidak dikenal: ${cmd}\nPakai salah satu dari: ${KNOWN.join(', ')}`);
    process.exit(2);
}
