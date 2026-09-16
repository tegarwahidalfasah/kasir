# Changelog

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/), nomor versi mengikuti
[Semantic Versioning](https://semver.org/lang/id/). Tanggal memakai zona waktu toko (Asia/Jakarta).

## [0.1.0] — 2026-09-16

Rilis internal: Fase 1–3 terimplementasi sebagai kode berjalan, Fase 4 berupa rangkaian uji + dokumen
(deployment & jadwal pemeliharaan belum dijalankan ke produksi).

### Ditambahkan

**Fase 1 — fondasi**
- Skema SQLite relasional (`server/src/db/schema.sql`): 21 tabel + view `v_stock_health` + 16 indeks;
  pemisahan `items.item_type` (`raw` vs `finished`) + `item_recipes` (BOM banyak-ke-banyak, `waste_pct`, `is_optional`)
  + `item_addons` (topping berbayar yang ikut memotong bahan) + ledger `stock_movements` (`balance_after`, `ref_type/ref_id`, `voided`).
- Desain UI modular berbasis token: `settings.theme` (10 token warna, mode terang/gelap, radius, kerapatan, font, lebar sidebar,
  pola latar, nama aplikasi, logo) + `theme.menu` (urutan, label, ikon, visibilitas, permission per menu) — diubah dari
  layar Pengaturan tanpa rebuild/restart.
- Stack & infrastruktur: Node.js 22 + Express 4 + `node:sqlite` (tanpa dependensi native), React 18 + Vite,
  SPA dilayani satu proses; `client/vite.config.js` mem-proxy `/api` ke port `PORT`.

**Fase 2 — MVP kasir**
- Modul transaksi: katalog + pencarian, keranjang, qty/addon/discount baris, proyeksi potongan bahan,
  pembayaran (tunai dengan uang diterima otomatis, QRIS/debit/kredit dengan `service_fee_pct`), pembulatan,
  struk termal 58/72/80 mm + cetak ulang dari snapshot, order tertahan (`/pos/hold`).
- Stok real-time: 1 penjualan memotong banyak bahan sekaligus (`qty × (1+susut) ÷ yield`), stok barang jadi dipakai
  lebih dulu (MTO), `make_to_stock` hanya memotong stok jadi, void mengembalikan semua, retur proporsional,
  produksi/PO/opname/transfer masuk lewat ledger; idempotensi `external_ref`.
- RBAC: 20 permission × 5 peran (`owner`, `admin`, `manager`, `inventory`, `cashier`), matriks dapat disunting per toko,
  guard default-deny, token HMAC (scrypt untuk kata sandi), audit trail aksi tulis.

**Fase 3 — operasional toko**
- Panel kustomisasi toko: profil (nama/alamat/logo/prefiks invoice), pajak dinamis (`taxes` + `items.tax_mode`),
  diskon khusus (persen/nominal, hari/jam/minimal belanja/`max_discount`/`stackable`), metode pembayaran,
  penata letak & teks struk (16 sakelar bagian, baris kustom dengan `{{placeholder}}`, skala huruf).
- Peringatan stok menipis otomatis ke dasbor: `stockHealth()` (pemakaian harian, `reorder_point_effective`,
  `days_to_stockout`, `serve_capacity` 4 tingkat status), `generateAlerts()` (dedup 6 jam), badge unread di sidebar,
  rekomendasi pembelian + tombol “Buat PO”.
- Dasbor analitik & laporan: ringkasan harian/jam/produk/metode/kasir, pergerakan stok harian, valuasi persediaan,
  pemakaian bahan vs pembelian + estimasi kehabisan, ekspor CSV (`/reports/export/{sales,movements,stock}`).

**Fase 4 — QA, deployment & maintenance**
- `server/scripts/qa-simulasi.js`: 20 pemeriksaan transaksi massal di server nyata (400 struk, 120 permintaan paralel
  pada bahan yang sama, akurasi BOM vs rumus reference, kebocoran stok, idempotensi, snapshot struk kebal perubahan setting,
  pembatalan massal, RBAC, 401/403/404, pemindaian kolom rahasia) — 20/20 hijau.
- Harness tes: `server/tests/{api,pricing,stock}.test.js` + `harness.js` (49 tes) dengan DB sementara **per file**;
  smoke UI `client/tests/` (28 pemeriksaan, render + alur bayar + tema + lebar struk).
- Alat pemeliharaan: `server/scripts/backup.js` (`VACUUM INTO` + `integrity_check` + `foreign_key_check` + rotasi `--keep`),
  `server/scripts/maintenance.js` (`status|verify|backup|restore|vacuum|prune|health`), pembungkus cron `ops/maintenance.sh`,
  `ops/{crontab.example,kasir.service,Caddyfile.example,nginx.example.conf}`; endpoint `GET /api/admin/backup` (audit `backup.download`).
- Dokumen: `README.md` + `docs/01…10` (arsitektur, skema, aturan stok/BOM, keamanan/RBAC, kustomisasi, panduan pengguna/SOP,
  referensi API, hasil QA, deployment & maintenance, rencana rilis beta).

### Diperbaiki (lahir dari hasil QA)

- `rawCapacity()` tidak membagi `yield_pct` → angka “maks N porsi” di POS lebih optimis daripada yang boleh dijual.
- Urutan tidak stabil: `GET /api/audit` dan `GET /api/sales` kini memakai tiebreaker `rowid DESC`.
- `PaymentModal` tidak mengisi uang tunai otomatis (kasir menekan Bayar dengan 0).
- Label struk panjang menumpuk di kertas 58 mm → `twoCol()` memotong + menyambung baris.
- `downloadCsv` membuka tab kosong saat server menolak (CSV error) → cek `res.ok` + pesan error di-toast.
- Menu “Riwayat” tidak pernah muncul di sidebar (tidak ada di `DEFAULT_MENU`) → ditambahkan.
- Cadangan memakai `db.backup()` yang **tidak tersedia** di `node:sqlite` Node 22.22 → `VACUUM INTO`.
- `OUT_TYPES` di `stockHealth()` tidak sama dengan `v_stock_health` (penurunan stok hasil opname tidak dihitung) → disamakan.
- `GET /api/bootstrap` menampilkan `settings.store.name` lebih dulu sehingga toko baru bernama “Toko Saya” → `stores.name` yang menang.
- Isolasi tenant: `PUT/DELETE /api/users/:id`, `PUT /api/{payment-methods,discounts,taxes,categories}/:id`,
  `PUT /api/items/:id/addons`, `DELETE /api/categories/:id` tidak memfilter `store_id` → diperbaiki + tes regresi “isolasi antar toko”.
- Guard auth bergantung urutan router → `api.use(authenticate)` (default-deny); token tak lagi diterima dari query string.
- Pembatas percobaan login sebelumnya tidak pernah menghitung kegagalan → `bumpAttempt` aktif + `clearAttempts` saat sukses.
- Toggle struk `barcode`/`points` ada di default tetapi tidak dirender → dikeluarkan dari default & UI (didokumentasikan).

### Diketahui / belum

- Belum deployment produksi (dokumen 09 berisi rencananya & ceklis pra-rilis).
- Belum ada mode luring di kasir; belum ada enkripsi DB at-rest; sesi tidak dapat dicabut satu-per-satu (token berumur).
- Belum ada uji properti acak untuk aturan diskon, uji beban 20 kasir/30 menit, dan uji cetak di printer termal fisik.
- `PUT /api/settings/:key` menggantikan objek/array bersarang (mis. `receipt.show`) — kirim blok penuh (didokumentasikan).

[0.1.0]: https://github.com/tegarwahidalfasah/kasir/tree/arena/01a0a588-kasir
