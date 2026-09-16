# 03 — Aturan stok & Bill of Materials (Fase 1–2)

Ini **spesifikasi resmi** bagaimana satu transaksi mengubah persediaan. Implementasi:
`server/src/bom.js` (perhitungan), `server/src/sales.js` (transaksi & pembatalan),
`server/src/inventory.js` (`postMovement`, opname, rekonsiliasi, HPP rata-rata bergerak),
`server/src/routes/stock.js` (produksi, PO), `server/src/stockhealth.js` (kapasitas & peringatan).

## 1. Jenis item & mode produksi

| `items.item_type` | Arti | Punya `item_recipes` | Dipotong saat dijual? |
|---|---|---|---|
| `raw` | Bahan baku / kemasan / bahan umum | Tidak | Tidak langsung; berkurang karena produk yang memakai atau `POST /api/stock/produce` |
| `finished` | Barang jadi | Ya (opsional) | Lihat `production_mode` |

| `items.production_mode` (untuk `finished`) | Arti | Perilaku kasir (`planStockImpact`) |
|---|---|---|
| `make_to_stock` (MTS, default) | Sudah dibuat sebelum dijual (roti di rak, minuman botolan) | `deduct_qty = qty` pada stok barang jadi (`sale_out`). **Tidak** menyentuh bahan. Bahan dipotong ketika produksi dicatat |
| `make_to_order` (MTO) | Dibuat saat dipesan (kopi, mie, croissant panggang) | Stok jadi yang ada dipakai lebih dulu (`sale_out` sejumlah itu); sisanya `madeNow` memotong bahan lewat `bom_consume` |
| `finished` tanpa resep | Barang dagangan (air kemasan, kerupuk) | Sama seperti MTS: hanya stok yang berkurang |
| `is_non_stock = 1` | Jasa/biaya (pelayanan, parkir) | Tidak ada gerakan stok sama sekali |

## 2. Rumus potongan bahan

Untuk baris keranjang produk `p` dengan qty `Q`, dan tiap baris resep `r` milik `p`:

```
konsumsi(bahan r) = madeNow × r.qty × (1 + r.waste_pct / 100) ÷ (p.yield_pct / 100)
madeNow          = Q − min(Q, stok_persediaan_barang_jadi)          // untuk MTO
```

* `r.qty` — jumlah bahan **per 1 unit produk**, dalam satuan bahan (`items.unit` bahan; label `r.unit` disalin saat resep disimpan).
* `r.waste_pct` — susut per baris resep (kulit, sisa potongan, tumpahan).
* `p.yield_pct` — faktor yield proses pada **produk** (mis. 95 ⇒ bahan yang harus disiapkan 5,26% lebih banyak).
  Ditempatkan di induk karena susut proses milik produk, bukan per bahan.
* `r.is_optional = 1` — hanya dipotong bila pelanggan memilih addon/topping yang memakai bahan itu
  (`line.addons[].raw_item_id == r.raw_item_id`) atau kasir mencentangnya lewat `line.selected_optional_raws`.
* Hasil dibulatkan 6 desimal (`round6`) supaya `gr`/`ml` tidak meledak karena floating point; QA memeriksa selisih ≤ 1e-4.

Contoh **Croissant ×2** (MTO, `yield_pct = 98`, tepung 150 g dengan susut 2 %, stok jadi = 0):

```
madeNow = 2
tepung  = 2 × 150 × 1,02 ÷ 0,98 = 312,245 gr
```

**Addon.** `item_addons` melekat pada satu barang (`name`, `price_delta`, `raw_item_id`, `raw_qty`, `is_required`).
Saat checkout, `price_delta` dijumlahkan ke harga satuan baris (bukan baris terpisah), dan bahannya **selalu** dipotong:

```
konsumsi(bahan addon) = raw_qty × (addon.qty ?? 1) × Q          // "Es Kopi + Extra Shot": biji kopi +18 g
```

Saat retur sebagian, `addons_json` baris dipakai ulang agar potongan bahan ikut kembali secara proporsional.

## 3. Kapasitas: berapa porsi masih bisa dilayani

```js
// server/src/bom.js
rawCapacity(itemId) = min over r ∈ resep(i):  floor( stok(r.raw) ÷ [ r.qty × (1+r.waste_pct/100) ÷ (i.yield_pct/100) ] )
  // item tanpa bahan  → stoknya sendiri (untuk MTS) atau tak terbatas (non-stock)
```

Pakai di: `GET /api/pos/catalog` → `capacity` per barang (kartu produk di POS menampilkan "maks N porsi"),
`stockHealth().serve_capacity`, dan rencana dampak (`planStockImpact().shortages`).
Karena pembaginya **sama** dengan rumus potongan (§2), angka di layar tidak pernah lebih optimis daripada yang boleh dijual.
`maxServable()` juga tersedia per item lewat `POST /api/items/:id/simulate`.

## 4. Alur `POST /api/sales` (satu transaksi DB, `BEGIN IMMEDIATE`)

1. **Idempotensi** (`transactions.external_ref` UNIQUE, periksa sebelum INSERT):
   `external_ref` yang sudah pernah dipakai → struk lama dikembalikan (`idempotent_replay: true`, HTTP **200**), tanpa potongan baru.
2. **Nomor struk** `nextInvoiceNo()`: `{settings.store.invoice_prefix}{YYYYMMDD}-{1000…}`; fallback `-<timestamp>` bila 20 nomor pertama terpakai (kasus DB hasil seed).
3. **Harga** dihitung server dengan `priceCart(...)` (pajak, diskon, service, pembulatan, biaya metode bayar). Angka yang ditampilkan POS hanya proyeksi layar; nilai tersimpan selalu hasil perhitungan server sehingga dua kasir dengan harga manual berbeda tetap konsisten.
4. **Validasi stok** — agregat per item lintas baris (`Map`), stok jadi & bahan. Kekurangan → **409**
   `details.shortages = [{ item_id, name, requested, max_by_raw }]`. Tidak ada satu pun stok berubah saat penolakan (QA §1.4).
   Penolakan karena stok hanya bisa dilewati oleh flag `settings.tax.allow_negative_stock` (jalur internal opname/produksi memang mengizinkan minus).
5. **Tulis** kepala + baris + pembayaran, lalu catat ledger per item:
   `sale_out` untuk pemakaian stok barang jadi, `bom_consume` untuk setiap bahan (termasuk bahan addon), masing-masing `ref_type='transaction'`, `ref_id=txId`, `reason=invoice_no`, dengan `unit_cost` = `cost_price` item saat itu dan `balance_after` dari hasil UPDATE.
   Baris item menyimpan `name_snapshot`, `unit_price`, `line_total`, `cost_snapshot`, `addons_json` — jadi struk & HPP tidak berubah walaupun master barang disunting kemudian.
6. **Snapshot struk** (`receipt_snapshot`): toko, layout/lebar kertas, blok pajak & metode bayar, baris, total, pembayaran, kembalian.
7. **Hitung HPP & margin** (`cost_total`) lalu **audit** `sale.create`.
8. Setelah commit, **bangkitkan peringatan stok** (`generateAlerts(storeId, {days: tax.consumption_window_days, lookaheadDays: tax.alert_lookahead_days})`) — dibungkus `try/catch` supaya alert tidak pernah menggagalkan penjualan.

Respons: `{ id, invoice_no, …pricing, payment, movements[], receipt_snapshot }`.

## 5. Aksi lain yang menyentuh stok

| Aksi | Endpoint | Efek pada ledger |
|---|---|---|
| Batalkan struk | `POST /api/sales/:id/void` | `reverseMovements({refType:'transaction', refId})`: gerakan keluar (`sale_out`, `bom_consume`) → baris **`return_in`** qty positif penuh; gerakan masuk (`purchase_in`, `production_in`) → **`adjustment`** negatif; baris lama ditandai `voided=1`. Stok kembali persisi (QA §1.6: 400/400). Hanya status `completed`; tanpa `sale.void` → `403` |
| Retur sebagian | `POST /api/sales/:id/refund` `{item_id, qty, reason}` | Proporsional `f = qty_retur / qty_baris`: `return_in` barang jadi `deduct_qty×f` dan tiap bahan `r.qty×f`, dihitung ulang dengan `planStockImpact` (+`addons_json`) |
| Opname / koreksi | `POST /api/stock/adjust` `{counted_qty}` atau `{items:[{item_id, counted_qty, reason}]}` | Selisih terhadap stok saat ini ditulis sebagai `adjustment` (`ref_type='manual'`, `allowNegative:true`); baris yang tidak berubah di-*skip*; respons menyertakan `alerts` hasil pindai ulang |
| Produksi terjadwal (MTS) | `POST /api/stock/produce` `{item_id, qty, reason?}` | Per bahan: `bom_consume` = `qty × r.qty × (1+waste) ÷ (yield/100)` (`ref_type='production'`); barang jadi: `production_in` = `qty × yield/100` dengan `unit_cost` = `cost_price` item. HPP roll-up dijaga lewat `syncCost()` saat resep disimpan |
| Terima PO | `POST /api/purchase-orders/:id/receive` `{items?:{[poi_id]:{qty_received}}}` | `purchase_in` per baris (`ref_type='purchase_order'`), `qty_received` ditambah, status → `partial`/`received`; **HPP rata-rata bergerak** dihitung ulang di `inventory.js` |
| Buat barang/jasa | `POST /api/items` · `PUT /api/items/:id` | Tidak menyentuh stok; menyimpan ulang resep memicu `syncCost()` → HPP barang jadi = Σ `r.qty × harga pokok bahan × (1+susut)` |
| Nonaktifkan/hapus barang | `DELETE /api/items/:id` | Bila masih dipakai transaksi/resep → `is_active=0` (`{ok, soft_deleted:true}`); ledger & struk lama tetap utuh |

## 6. Kesehatan stok & peringatan (Fase 3)

`stockHealth()` (`server/src/stockhealth.js`) mengembalikan per item aktif non-jasa:

| Field | Sumber |
|---|---|
| `avg_daily` | Σ `qty` keluar dengan `movement_type IN ('sale_out','bom_consume','adjustment')`, `qty<0`, `voided=0` (konstanta `OUT_TYPES` di `server/src/stockhealth.js`, **sama** dengan `v_stock_health`) dibagi lebar jendela `days` (default `tax.consumption_window_days` = 14) |
| `reorder_point_effective` | `max(reorder_point, min_stock, avg_daily × (lead_time_days \| 3) + safety_stock)` |
| `days_to_stockout`, `stockout_date` | `stok ÷ avg_daily`; `null` bila tidak ada pemakaian |
| `serve_capacity` | MTO/`raw`: `rawCapacity()`; MTS: stok hari ini |
| `status` | `ok` \| `warning` \| `critical` \| `out`. **Bahan baku**: `out` bila stok ≤ 0, `critical` bila ≤ `safety_stock`, `warning` bila sisa hari ≤ `alert_lookahead_days` atau stok ≤ `reorder_point_effective`. **Barang jadi MTO**: diukur dari kapasitas bahan (`out` 0 porsi, `critical` < 3 porsi, `warning` bila kapasitas ≤ pemakaian × horizon). **Barang jadi MTS**: `out` bila stok ≤ 0, `critical` ≤ ½ `min_stock`, `warning` ≤ `min_stock` |
| `est_value`, `margin_pct` | valuasi & margin untuk laporan |

`generateAlerts()` menulis `alerts` (`kind='low_stock'`, severity `warning`/`critical`) dengan **deduplikasi 6 jam per item**
agar dasbor tidak spam, dan mengembalikan `{created, at_risk, total}`. Dibangkitkan otomatis: setiap transaksi selesai,
setelah opname, setelah produksi, setelah terima PO — serta manual lewat `POST /api/alerts/scan`.
Baca: `GET /api/alerts` (± unread per user via `alert_reads`), tutup: `POST /api/alerts/read/:id`,
belanja bahan: `GET /api/alerts/replenish`.

## 7. Integritas & pemulihan

| Pemeriksaan | Perilaku |
|---|---|
| `GET /api/stock/integrity` | Per item: `stock_qty` dibandingkan **Σ seluruh baris ledger** (baris `voided=1` tetap dihitung karena pembatalan diimbangi baris balik, bukan dihapus) → `{checked, mismatches[]}`; `balance_after` dipakai untuk memeriksa rantai per item |
| `POST /api/stock/reconcile` | Kembalikan `stock_qty` ke saldo ledger terakhir; `{checked, fixed}`. Aman dijalankan berkala (QA §1.5) |
| `GET /api/stock/movements?item_id=&from=&to=&types=&limit=` | Ledger per barang/periode/jenis. Untuk melihat gerakan **per struk** cukup `GET /api/sales/:id` (respons sudah memuat `movements[]`) |
| `GET /api/stock/consumption?days=` | Deret pemakaian harian untuk laporan |

Bila `mismatches > 0`: jalankan rekonsiliasi, lalu cocokkan fisik dengan opname. Jangan menulis DB manual;
ledger tidak pernah dihapus — koreksi selalu berupa baris `adjustment` baru supaya jejak audit utuh.

## 8. Keputusan desain yang disengaja (bukan bug)

1. **Uang = rupiah utuh; qty/satuan = REAL.** Pembulatan dilakukan di lapisan harga, bukan di ledger.
2. **Yield pada induk** (`items.yield_pct`), susut pada baris resep (`item_recipes.waste_pct`). Keduanya di satu tabel membuat
   bahan yang sama menghasilkan angka berbeda di produk berbeda — sulit diaudit.
3. **Stok jadi dipakai lebih dulu** pada MTO: tanpa aturan ini, barang yang sudah ada di rak dihitung dua kali (sekali sebagai stok, sekali sebagai bahan).
4. **Ledger hanya-tambah**: pembatalan tidak menghapus baris, hanya `voided=1` + gerakan balik → laporan bisa direkonstruksi kapan pun.
5. **Bahan tidak minus secara default.** Menjual melebihi kapasitas bahan adalah keputusan manajerial (`allow_negative_stock`).
6. **Konsumsi dihitung dari resep + snapshot transaksi**, bukan dari pengaturan saat ini: mengubah resep hari ini tidak mengubah struk kemarin.
7. **Satu baris item per produk** (addon folded). Struk lebih sederhana & retur tetap akurat karena `addons_json` tersimpan.
