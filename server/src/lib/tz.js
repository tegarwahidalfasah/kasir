// ============================================================================
//  Zona waktu toko (docs/11 §4)
//
//  Aturan tunggal: SEMUA kolom waktu disimpan dalam UTC (`nowIso()`,
//  `datetime('now')`), dan "hari bisnis" toko diturunkan dari
//  `settings.store.timezone` — bukan dari zona waktu server/proses.
//
//  Sebelum ini `stores.timezone` disimpan tetapi tidak pernah dibaca: laporan
//  memakai tanggal UTC (transaksi 00:00–06:59 WIB jatuh ke hari sebelumnya),
//  grafik jam sibuk memakai `localtime` (= UTC di VPS/Vercel, geser 7 jam), dan
//  nomor struk berganti hari jam 07:00 WIB.
//
//  Catatan DST: offset diambil dari `Intl` pada satu titik waktu (biasanya
//  "sekarang"). Untuk toko berzona tanpa DST (seluruh Indonesia) hasilnya persis;
//  di zona ber-DST, baris tepat di sekitar pergantian bisa bergeser ≤ 1 jam.
// ============================================================================
import { firstRow, IS_REMOTE } from '../db/index.js';

export const DEFAULT_TZ = 'Asia/Jakarta';

/** Offset zona waktu (menit) terhadap UTC pada saat `at`. WIB = +420. */
export function tzOffsetMinutes(timeZone = DEFAULT_TZ, at = new Date()) {
  try {
    const parts = {};
    for (const p of new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at)) parts[p.type] = p.value;
    const asUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
    );
    return Math.round((asUtc - at.getTime()) / 60000);
  } catch {
    // zona tidak dikenal (mis. salah ketik di Pengaturan) -> jangan patahkan laporan
    return timeZone === DEFAULT_TZ ? 420 : tzOffsetMinutes(DEFAULT_TZ, at);
  }
}

/** Modifier SQLite untuk menggeser UTC -> waktu toko: `date(created_at, '+07:00')`. */
export function tzOffsetSql(timeZone = DEFAULT_TZ, at = new Date()) {
  const minutes = tzOffsetMinutes(timeZone, at);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const out = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  // nilainya selalu dari perhitungan sendiri (bukan input pengguna), tetapi tetap dijaga
  // karena dipakai sebagai literal SQL di dalam string kueri
  return /^[+-]\d{2}:\d{2}$/.test(out) ? out : '+07:00';
}

/** Tanggal bisnis 'YYYY-MM-DD' di zona waktu toko (en-CA memang ISO). */
export function businessDay(timeZone = DEFAULT_TZ, at = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return businessDay(DEFAULT_TZ, at);
  }
}

/** Jam bisnis 0–23 di zona waktu toko (untuk grafik jam sibuk). */
export function businessHour(timeZone = DEFAULT_TZ, at = new Date()) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(at)) % 24;
  } catch {
    return businessHour(DEFAULT_TZ, at);
  }
}

/**
 * Batas UTC untuk satu hari lokal toko.
 * `dayBoundsUtc('2026-09-27', 'Asia/Jakarta')` -> mulai `2026-09-26 17:00:00`,
 * akhir `2026-09-27 16:59:59` (dipakai filter tanggal Riwayat Penjualan & Ledger).
 * Offset dihitung pada tengah hari tanggal itu supaya aman terhadap pergantian DST.
 */
export function dayBoundsUtc(day, timeZone = DEFAULT_TZ, end = false) {
  const offset = tzOffsetMinutes(timeZone, new Date(`${day}T12:00:00Z`));
  const ms = Date.parse(`${day}T${end ? '23:59:59' : '00:00:00'}Z`) - offset * 60000;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** Geser tanggal 'YYYY-MM-DD' sejumlah hari (aritmetika tanggal murni, tanpa zona). */
export function addDays(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ per toko
const cache = new Map();

/** Zona waktu toko. Cache hanya lokal; online membaca DB bersama agar tidak basi antar-instance. */
export function storeTimezone(storeId) {
  if (!storeId) return DEFAULT_TZ;
  if (!IS_REMOTE && cache.has(storeId)) return cache.get(storeId);
  let tz = DEFAULT_TZ;
  try {
    tz = firstRow(`SELECT timezone FROM stores WHERE id = ?`, storeId)?.timezone || DEFAULT_TZ;
  } catch { /* tabel store belum ada (mis. saat boot) */ }
  if (!IS_REMOTE) cache.set(storeId, tz);
  return tz;
}

/** Panggil setiap kali zona waktu toko diubah agar cache tidak basi. */
export function forgetTimezone(storeId) {
  if (storeId) cache.delete(storeId);
  else cache.clear();
}

/** Offset SQL toko — pintasan yang paling sering dipakai rute. */
export function storeOffsetSql(storeId, at = new Date()) {
  return tzOffsetSql(storeTimezone(storeId), at);
}
