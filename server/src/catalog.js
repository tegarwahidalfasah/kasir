// ============================================================================
//  Versi katalog (docs/11 §15)
//
//  Klien tidak perlu lagi menarik `/bootstrap` penuh setiap 45 detik. Yang
//  dipantau cukup satu tanda tangan murah: "apakah STRUKTUR katalog berubah?"
//  (barang, resep, addon, kategori, pajak/diskon/metode bayar).
//
//  Angka STOK sengaja tidak ikut: stok berubah setiap penjualan dan sudah
//  dikirim sebagai delta lewat SSE (`/api/events`). Kalau stok ikut masuk
//  hitungan versi, tiap struk akan memaksa semua tab menarik katalog penuh —
//  persis poling yang ingin kita hilangkan.
//
//  Versi diturunkan dari data (bukan penghitung di memori), sehingga bertahan
//  saat proses restart dan tetap benar bila ada beberapa proses.
// ============================================================================
import crypto from 'node:crypto';
import { firstRow } from './db/index.js';

/** Ringkasan satu baris yang berubah bila struktur katalog berubah. */
export function catalogSignature(storeId) {
  const row = firstRow(
    `SELECT
       (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at),'') || ':' || COALESCE(ROUND(SUM(selling_price + cost_price), 2), 0)
          FROM items WHERE store_id = ?) AS items,
       (SELECT COUNT(*) || ':' || COALESCE(ROUND(SUM(r.qty + r.waste_pct), 3), 0)
          FROM item_recipes r JOIN items i ON i.id = r.parent_id WHERE i.store_id = ?) AS recipes,
       (SELECT COUNT(*) || ':' || COALESCE(ROUND(SUM(a.price_delta + a.raw_qty), 3), 0)
          FROM item_addons a JOIN items i ON i.id = a.item_id WHERE i.store_id = ?) AS addons,
       (SELECT COUNT(*) || ':' || COALESCE(ROUND(SUM(rate_pct), 3), 0) FROM taxes WHERE store_id = ?) AS taxes,
       (SELECT COUNT(*) || ':' || COALESCE(ROUND(SUM(value), 3), 0) FROM discounts WHERE store_id = ?) AS discounts,
       (SELECT COUNT(*) || ':' || COALESCE(ROUND(SUM(service_fee_pct), 3), 0) FROM payment_methods WHERE store_id = ?) AS methods,
       (SELECT COUNT(*) FROM categories WHERE store_id = ?) AS categories`,
    storeId, storeId, storeId, storeId, storeId, storeId, storeId
  ) || {};
  return [row.items, row.recipes, row.addons, row.taxes, row.discounts, row.methods, row.categories].join('|');
}

/** Versi pendek (12 karakter) yang dikirim ke klien: bukti katalog tidak berubah. */
export function catalogVersion(storeId) {
  if (!storeId) return null;
  return crypto.createHash('sha1').update(catalogSignature(storeId)).digest('base64url').slice(0, 12);
}
