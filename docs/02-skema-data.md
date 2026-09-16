# 02 — Skema data relasional (Fase 1)

Berkas: `server/src/db/schema.sql` — **21 tabel, 1 view, 16 indeks**, dijalankan setiap startup dengan
`CREATE … IF NOT EXISTS` sehingga instalasi baru & lama identik. Seluruh ID berupa teks berprefiks
(`itm…`, `rcp…`, `mov…`, `txs…`, `alr…`) yang dibangkitkan aplikasi lewat `uid(prefix)` (`server/src/db/index.js`)
supaya tidak bergantung pada sintaks auto-increment DB tertentu. Uang di tabel transaksi berupa angka
(dibulatkan ke Rupiah di lapisan harga); qty & harga satuan bertipe REAL.

## 1. Toko, cabang, pengguna

| Tabel | Kolom |
|---|---|
| `stores` | `id`, `name`, `legal_name`, `address`, `phone`, `email`, `npwp`, `timezone` (default `Asia/Jakarta`), `currency` (`IDR`), `locale` (`id-ID`), `logo_path`, `is_active`, `created_at`, `updated_at` |
| `branches` | `id`, `store_id`→stores (CASCADE), `name`, `address`, `phone`, `is_default`, `is_active`, `created_at` · indeks `idx_branches_store` |
| `users` | `id`, `store_id`→stores (SET NULL), `branch_id`→branches, `username` **UNIQUE**, `password_hash`, `display_name`, `pin` (PIN kasir, di-hash), `role` (default `cashier`), `is_active`, `last_login_at`, `created_at`, `updated_at` · indeks `idx_users_role` |

Lapisan otorisasi tidak punya tabel sesi (token HMAC tak-berstate) dan tidak punya tabel
`role_permissions`: matriks role→permission disimpan sebagai JSON di `settings` key `rbac`
(shema `{roles:{owner:[…],admin:[…],manager:[…],inventory:[…],cashier:[…]}}`) dan di-*seed* dari
`ROLE_PRESETS` (`server/src/rbac.js`) bila belum ada.

## 2. Katalog: barang jadi vs bahan baku

| Tabel | Kolom |
|---|---|
| `categories` | `id`, `store_id`, `name`, `sort_order`, `color`, `is_active` |
| `items` | lihat di bawah |
| `item_recipes` (BOM) | `id`, `parent_id`→items (CASCADE), `raw_item_id`→items (CASCADE), `qty` REAL `CHECK (qty>0)`, `unit` (label, disalin dari satuan bahan), `waste_pct` REAL DEFAULT 0, `is_optional` (topping/varian — hanya dipotong bila dipilih), `sort_order` · **UNIQUE (`parent_id`,`raw_item_id`)** — karena itu `PUT /api/items/:id/recipe` menulis ulang seluruh daftar dalam satu `tx()` · indeks `idx_recipes_parent`, `idx_recipes_raw` |
| `item_addons` | `id`, `item_id`→items (CASCADE), `name`, `price_delta` REAL, `raw_item_id`→items (SET NULL), `raw_qty` REAL, `is_required`, `sort_order` — addon = pilihan berbayar pada satu barang, bukan barang terpisah |

Kolom `items`:

| Grup | Kolom |
|---|---|
| Identitas | `id`, `store_id`, `name`, `sku`, `barcode`, `image`, `notes`, `is_active` |
| Jenis | `item_type` CHECK `('finished','raw')` ← **pemisahan bahan baku vs barang jadi** |
| Satuan & harga | `unit` (default `pcs`), `cost_price` REAL (raw: rata-rata bergerak; finished: HPP dari resep), `selling_price` REAL |
| Pajak per item | `tax_mode` CHECK `('inherit','exempt','override')` + `tax_rate` REAL (pakai saat `override`) |
| Stok | `stock_qty` REAL (agregat ledger; redundan demi kecepatan), `min_stock`, `reorder_point` (NULL = otomatis dari konsumsi), `safety_stock`, `lead_time_days` (default 3), `supplier_name` |
| Produksi | `production_mode` CHECK `('make_to_stock','make_to_order')` (default MTS), `yield_pct` REAL DEFAULT 100 (faktor yield/susut produksi, dipakai sebagai **pembagi** konsumsi) |
| Lainnya | `is_non_stock` (jasa — tidak pernah menghasilkan gerakan stok) |

Indeks: `idx_items_type (item_type, is_active)`, `idx_items_cat (category_id)`.

> **Kenapa tidak ada tabel `raw_materials` terpisah?** Bahan dan produk butuh hal yang sama (satuan, stok, harga pokok,
> ledger, peringatan, pemasok) dan saling berhubungan banyak-ke-banyak lewat `item_recipes`. Memecah menjadi dua tabel
> mengulang seluruh kolom & query dua kali, dan membuat kasus "satu item bisa jadi bahan sekaligus produk jadi"
> (es batu, kemasan, roti yang dijual utuh & dipotong) jadi sulit. Yang membedakan perilaku cukup dua flag:
> `item_type` dan `production_mode` — keduanya dipakai mesin stok di server, tanpa perlu cabang kode terpisah di UI.
>
> Kolom produksi (`yield_pct`, `production_mode`, `is_non_stock`) sengaja tidak ada di `PUBLIC_ITEM_FIELDS`
> (`server/src/routes/auth.js`), sehingga tidak bisa dibaca/diubah dari API publik; nilainya diatur lewat
> `PUT /api/items/:id` (jalur internal `setting.*`/`item.manage`) dan tetap tidak muncul di respons katalog.

## 3. Pembelian

| Tabel | Kolom |
|---|---|
| `suppliers` | `id`, `store_id`, `name`, `contact`, `phone`, `email`, `lead_time_days` (default 3), `notes`, `is_active` |
| `purchase_orders` | `id`, `store_id`, `po_number` (mis. `PO20260916-4821`), `supplier_id`→suppliers (SET NULL), `branch_id`, `status` CHECK `('draft','ordered','partial','received','cancelled')`, `order_date`, `expected_date`, `received_at`, `total_amount`, `note`, `created_by`, `created_at` |
| `purchase_order_items` | `id`, `po_id`→purchase_orders (CASCADE), `raw_item_id`→items (CASCADE), `qty_ordered`, `qty_received`, `unit_cost`, `note` · indeks `idx_poi_po` |

## 4. Ledger stok — `stock_movements` (hanya-tambah)

| Kolom | Arti |
|---|---|
| `store_id`, `branch_id`, `item_id` | Lokasi & barang yang berubah |
| `movement_type` | CHECK: `sale_out` (potong barang jadi saat transaksi), `bom_consume` (potong bahan: penjualan MTO, produksi, simulasi), `purchase_in` (terima PO), `production_in` (stok masuk hasil produksi), `return_in` (retur/pembatalan), `adjustment` (opname/koreksi), `transfer` (antar cabang) |
| `qty` | REAL; **positif = masuk, negatif = keluar** |
| `unit_cost` | Harga pokok saat gerakan (dipakai HPP struk & valuasi) |
| `balance_after` | Stok item setelah baris ini — dipakai pemeriksaan integritas & rekonsiliasi |
| `ref_type`, `ref_id` | Penelusuran. Nilai yang dipakai kode: `transaction`, `refund`, `purchase_order`, `production`, `manual` |
| `reason` | Keterangan (mis. `Produksi Es Kopi Susu x 2`, `Penerimaan PO…`, `Stock opname`) |
| `voided` | 1 bila gerakan sudah dibatalkan → tidak dihitung di laporan/view |
| `created_by`, `created_at` | Pelaku & waktu |

Indeks: `idx_mov_item (item_id, created_at)`, `idx_mov_ref (ref_type, ref_id)`, `idx_mov_store (store_id, created_at)`.

Baris ledger tidak pernah di-UPDATE kecuali `voided`, dan tidak pernah dihapus; koreksi selalu berupa baris baru.

Pembatalan struk membalik baris di dalam satu `tx()` (`reverseMovements` di `server/src/inventory.js`):
`sale_out`/`bom_consume` → baris **`return_in`** dengan qty positif, baris masuk (`purchase_in`/`production_in`) →
**`adjustment`** negatif, lalu baris asli ditandai `voided=1`. Karena itu `ledgerIntegrity` menjumlahkan
**semua** baris (termasuk `voided=1`) sedangkan laporan pemakaiann (`v_stock_health`, `stockHealth`) menyaring `voided=0`.

## 5. Transaksi

| Tabel | Kolom |
|---|---|
| `transactions` | `id`, `store_id`, `branch_id`, `invoice_no` (`{prefix}{YYYYMMDD}-{nomor urut 4 digit}`, contoh `KS20260916-1328`), `external_ref` **UNIQUE** (kunci idempotensi dari klien), `cashier_id`, `status` CHECK `('completed','voided','refunded','open')` (`open` = order tertahan), `customer_name`, `customer_phone`, `order_type` (teks bebas; nilai UI: `dine_in`, `take_away`, `delivery`, `online`; awal dari `pos.default_order_type`), `note`, `subtotal`, `discount_total`, `tax_total`, `service_total`, `rounding_total`, `grand_total`, `cost_total` (HPP → margin), `payment_method_id`, `paid_amount`, `change_amount`, `fee_total` (biaya metode bayar), `applied_discounts` (JSON aturan yang terpakai), `receipt_snapshot` (JSON struk terkunci), `voided_at`, `void_reason`, `voided_by`, `created_at` · indeks `idx_tx_created`, `idx_tx_cashier` |
| `transaction_items` | `id`, `transaction_id` (CASCADE), `item_id`→items (SET NULL, agar riwayat selamat bila barang dihapus), `name_snapshot`, `item_type`, `qty`, `unit_price`, `line_discount`, `line_total`, `cost_snapshot`, `addons_json` (rincian addon/ topping untuk struk & retur), `created_at` · indeks `idx_txitem_tx`, `idx_txitem_item` |
| `transaction_payments` | `id`, `transaction_id` (CASCADE), `payment_method_id`, `amount`, `reference`, `created_at` — mendukung pembayaran terbagi (tunai + QRIS) |

Baris item **tidak** menyimpan hasil BOM per baris; potongan bahan dapat direkonstruksi dari `item_id` + `qty` + `addons_json`
(dipakai saat retur: `planStockImpact` dijalankan ulang), dan daftar `stock_movements` dengan `ref_type='transaction'` adalah
bukti finalnya.

## 6. Konfigurasi toko (Fase 3) & pengawasan

| Tabel | Kolom / isi |
|---|---|
| `settings` | PRIMARY KEY (`store_id`,`key`), `value_json`, `updated_at`, `updated_by`. Key: `store`, `tax`, `receipt`, `theme`, `pos`, `rbac` — lihat [05-kustomisasi.md](05-kustomisasi.md) |
| `taxes` | `id`, `store_id`, `name`, `rate_pct`, `is_inclusive`, `is_active`, `is_default`, `sort_order` |
| `discounts` | `id`, `store_id`, `name`, `kind` CHECK `('percent','fixed')`, `value`, `applies_to` CHECK `('global','category','item')` + `ref_ids` (JSON array id), `trigger` CHECK `('manual','auto_weekday','auto_time','auto_min_subtotal')`, `days` (JSON 0=Minggu…6=Sabtu), `start_time`, `end_time`, `min_subtotal`, `max_discount`, `stackable`, `is_active`, `valid_from`, `valid_to` |
| `payment_methods` | `id`, `store_id`, `name`, `kind` CHECK `('cash','wallet','qris','debit','credit','transfer')`, `icon`, `service_fee_pct`, `is_enabled`, `is_default`, `sort_order` |
| `alerts` | `id`, `store_id`, `kind` (default `low_stock`), `severity` (`info`\|`warning`\|`critical`), `item_id`, `message`, `data_json` (unit, stok, reorder point, `avg_daily`, `item_type`), `created_at` · indeks `idx_alerts_created`. **Tidak ada kolom `is_read`** — status baca per user ada di `alert_reads` |
| `alert_reads` | PRIMARY KEY (`user_id`,`alert_id`), `read_at` |
| `audit_logs` | `id`, `store_id`, `user_id`, `actor_role`, `action` (`sale.create`, `sale.void`, `item.create`, `setting.update.store`, `stock.adjust`, `role.update`, `backup.download` …), `entity`, `entity_id`, `before_json`, `after_json`, `ip`, `created_at` · indeks `idx_audit_created` |

## 7. View & perhitungan stok

```sql
CREATE VIEW v_stock_health AS
SELECT i.id, i.name, i.item_type, i.unit, i.stock_qty, i.min_stock, i.reorder_point,
       i.lead_time_days, i.cost_price, i.selling_price, i.is_active,
       COALESCE(c.qty_out_14d, 0)        AS qty_out_14d,
       COALESCE(c.qty_out_14d, 0) / 14.0 AS avg_daily_use
FROM items i
LEFT JOIN ( SELECT item_id, SUM(ABS(qty)) AS qty_out_14d
            FROM stock_movements
            WHERE qty < 0 AND voided = 0
              AND movement_type IN ('sale_out','bom_consume','adjustment')
              AND created_at >= datetime('now','-14 days')
            GROUP BY item_id ) c ON c.item_id = i.id
WHERE i.is_non_stock = 0;
```

View = versi SQL yang murah untuk "kecepatan pemakaian 14 hari". Versi aplikasi (`server/src/stockhealth.js`)
memperhalusnya dengan `lead_time_days`, `safety_stock`, kapasitas bahan untuk produk made-to-order, dan status 4 tingkat.

## 8. Invarian yang dijaga

1. **Stok = hasil ledger.** `items.stock_qty` hanya diubah di dalam `tx()` yang sama dengan penulisan `stock_movements`. Diperiksa `GET /api/stock/integrity`.
2. **Saldo berantai.** `balance_after` harus sama dengan stok setelah baris tersebut (urutan: `created_at`, lalu `rowid`).
3. **Tidak ada stok negatif** kecuali `settings.tax.allow_negative_stock = true` (jalur internal: opname/produksi boleh minus, penjualan tidak).
4. **Satu struk = satu nomor.** `invoice_no` dibuat di dalam `BEGIN IMMEDIATE` sehingga tabrakan tidak mungkin.
5. **Idempoten.** `transactions.external_ref` UNIQUE: permintaan ulang dengan ref yang sama mengembalikan struk lama, bukan transaksi kedua.
6. **Struk terkunci.** `receipt_snapshot` = JSON lengkap (toko, layout, pajak, diskon, metode bayar, baris, total). Mengubah pengaturan tidak mengubah struk lama.
7. **Isolasi tenant.** Semua query difilter `store_id` dari token; cabang lewat `X-Branch-Id`/`?branch_id=`.
8. **Riwayat tidak merusak master.** `transaction_items.item_id` ON DELETE SET NULL; menghapus item yang masih terpakai diubah menjadi nonaktif (`soft_deleted`) — lihat `DELETE /api/items/:id`.

## 9. Kebijakan perubahan skema

Ringkas: tidak ada tabel versi migrasi; `schema.sql` hanya **membuat** objek baru (tidak pernah mengubah yang lama),
sehingga penambahan kolom di DB produksi butuh `ALTER TABLE … ADD COLUMN` eksplisit sebagai langkah rilis
(lihat [01-arsitektur.md §7](01-arsitektur.md) dan [09-deployment-dan-maintenance.md §7](09-deployment-dan-maintenance.md)).
Jalankan perubahan skema lebih dulu pada **salinan** hasil cadangan (`npm run maintenance -- restore <cadangan> --yes`
dengan `KASIR_DATA_DIR` sementara), baru pada DB live.
