# Changelog

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/), nomor versi mengikuti
[Semantic Versioning](https://semver.org/lang/id/). Tanggal memakai zona waktu toko (Asia/Jakarta).

## [Unreleased]

Belum dirilis. Bagian ini menggabungkan tiga rangkaian pekerjaan:

1. **Higienis repositori** — CI, lisensi, konfigurasi lingkungan, dan sinkronisasi dokumen yang
   menyimpang dari kode.
2. **Sprint 0 hasil analisis putaran 2** — perbaikan cepat dari
   [`docs/11-analisis-2026-09-17.md`](docs/11-analisis-2026-09-17.md) (15 temuan yang diverifikasi
   dengan menjalankan aplikasi). Temuan integritas data (retur berulang, snapshot retur,
   `forceConsumeRaw`, zona waktu sisi laporan) dijadwalkan di Sprint 1.
3. **Perbaikan tombol "Masuk"** pada layar login.

### Ditambahkan

- **CI GitHub Actions** (`.github/workflows/ci.yml`): dua job pada setiap push & pull request —
  `check` (uji unit backend + smoke UI jsdom + build SPA, artefak `client/dist` diunggah) dan
  `qa` (simulasi 400 transaksi, uji RBAC & pemindaian kolom rahasia). Memakai `npm ci` dengan cache
  npm dan versi Node dari `.nvmrc`. Sebelumnya dokumen menyebut "dipakai di CI" padahal tidak ada
  workflow sama sekali. (docs/11 §12)
- **6 tes regresi API** (`server/tests/api.test.js`, 51 → 57 tes): alur order tertahan
  (tahan → daftar → lanjutkan → hapus + 404), nomor hold unik, RBAC `sale.hold`, header CSP,
  brute force dengan XFF palsu (ember per-username), dan `KASIR_TRUST_PROXY=false` membuat XFF
  diabaikan (ember per-IP). Tes-tes inilah yang membuat bug `storeId is not defined` tidak bisa lolos lagi.
- Variabel lingkungan baru: **`KASIR_TRUST_PROXY`**, **`KASIR_LOGIN_LIMIT_IP`**, dan
  **`KASIR_LOGIN_LIMIT_USER`** — didokumentasikan di `.env.example`, `docs/04` §2, dan `docs/09` §4.
- **`LICENSE`**: lisensi source-available (seluruh hak dilindungi) yang menyatakan secara eksplisit
  apa yang boleh (membaca, mempelajari, menjalankan untuk operasional toko sendiri) dan apa yang
  memerlukan izin tertulis (menyalin, memodifikasi, menyebarkan, memakai sebagai layanan pihak ketiga),
  beserta penyangkalan jaminan. README bagian Lisensi diperbarui agar mengarah ke berkas ini.
- **`.env.example`**: seluruh variabel lingkungan yang benar-benar dibaca kode (runtime, keamanan,
  pengembangan/uji, platform) dengan nilai produksi yang disarankan — termasuk catatan bahwa aplikasi
  sengaja tidak memuat `.env` otomatis (tanpa `dotenv`), jadi harus lewat `--env-file`, ekspor shell,
  atau `EnvironmentFile` systemd.
- **`.nvmrc`** (`22`) dan **`.editorconfig`** (UTF-8, LF, 2 spasi, baris maksimum 140) sebagai
  kesepakatan versi & format dasar antar editor.

### Diperbaiki

- **Retur bisa diulang tanpa batas → stok bahan baku digandakan** (temuan P0 #1 di
  [`docs/11`](docs/11-analisis-2026-09-17.md), analisis Sprint 1). `refundLine()` hanya membatasi `qty`
  terhadap qty baris asli, jadi memanggil retur berulang-ulang mengembalikan stok yang sama setiap kali
  dan uang yang dikembalikan tidak pernah tercatat. **Bukti sebelum perbaikan** (struk `KS20260926-1330`,
  baris qty 2): tiga retur berturut-turut semuanya `HTTP 200`, stok naik fiktif (Biji Kopi House Blend
  +110,16 gr padahal hanya 36,72 gr yang terpakai; Cup +6 pcs; Es Batu +777,6 gr), status struk tetap
  `completed`, dan laporan tetap menghitung struk itu penuh.
  - Skema: `transaction_items.refunded_qty` (pagar per baris) + `transactions.refund_total` & `refund_cost`
    (uang & HPP yang dikembalikan). Ketiganya **aditif** dan otomatis ditambahkan ke DB lama lewat
    `migrateSchema()` di `server/src/db/index.js` — diuji dengan DB berskema lama: kolom muncul, data lama utuh.
  - `refundLine()` menolak `409` bila qty melebihi sisa (`qty − refunded_qty`) atau baris sudah diretur penuh;
    permintaan yang ditolak tidak menyentuh stok sama sekali. Retur mencatat `refund_amount` (proporsional
    terhadap tagihan, ikut bagian pajak/biaya/pembulatan, tidak pernah melebihi `grand_total`) dan
    `refund_cost`; bila **semua** baris sudah penuh, status struk menjadi `refunded`.
  - `voidSale()` **menolak** membatalkan struk yang sudah punya retur (`409`) — pembatalan membalikkan seluruh
    potongan asli, sehingga stok yang sudah kembali akan dikembalikan dua kali.
  - Laporan `GET /api/reports/summary`: omzet/HPP/laba kotor dihitung neto setelah retur (harian, per jam,
    per barang, per kasir), `by_item` menampilkan qty & omzet neto, CSV penjualan memuat `refund_total`, dan
    `totals.refund_total` + `totals.refunded` tersedia untuk dasbor.
  - UI Riwayat: modal retur menampilkan **sisa yang masih bisa diretur** per baris, menyembunyikan pilihan yang
    sudah penuh, dan mentokkan input pada sisa; detail struk menampilkan nilai retur.
  - Tes: **+4 tes regresi** (57 → 61) — tiga di `server/tests/stock.test.js` (domain: retur berulang ditolak &
    stok tidak berubah, retur sebagian mencatat uang/HPP proporsional, void setelah retur ditolak) dan satu di
    `server/tests/api.test.js` (HTTP: `409` saat melebihi sisa, `refund_amount`, omzet laporan neto,
    `status='refunded'`, void ditolak). Ketiga tes domain **gagal pada kode lama** (diverifikasi), jadi bug ini
    tidak bisa lolos lagi.
  - Sisa yang belum dikerjakan (docs/03 §5): status tersendiri untuk retur sebagian (butuh membangun ulang
    CHECK `transactions.status`), tabel `refunds`, dan baris uang keluar di `transaction_payments`.
- **`POST /api/pos/hold` selalu 500** (`storeId is not defined` di `server/src/routes/pos.js`) → fitur
  *order tertahan* hidup kembali: keranjang kosong ditolak 400, nomor hold dijamin unik terhadap
  `uq_tx_invoice` (dua kasir menahan pada detik yang sama tidak lagi bertabrakan), aksi dicatat ke
  `audit_logs` (`sale.hold`), dan `GET /api/pos/held` mengembalikan `customer_name` alih-alih JSON mentah
  di kolom `note`. (docs/11 §5)
- **Pembatas login bisa dilewati `X-Forwarded-For` palsu** — `app.set('trust proxy', true)` mempercayai
  header kiriman klien sehingga brute force tak terbatas (PIN 4 digit!). Kini `trust proxy` default
  `'loopback'` dan dapat disetel lewat `KASIR_TRUST_PROXY` (`false|1|2|loopback|uniquelocal|CIDR`),
  ditambah **ember per-username** (`KASIR_LOGIN_LIMIT_USER`, default 8/60 detik) yang tidak bisa diakali
  dengan mengganti IP. Peta bucket dibatasi (`MAX_BUCKETS` + penyapuan berkala) agar XFF acak tidak
  menjadi DoS memori. (docs/11 §6)
- **CSP `frame-ancestors *` → `'self'`** + `object-src 'none'`: aplikasi kasir tidak bisa lagi dibingkai
  situs lain (clickjacking pada tombol bayar/void). (docs/11 §9)
- **Riwayat seed bertanggal "masa depan"** — `server/scripts/seed.js` menulis stempel dari komponen waktu
  lokal sementara runtime menulis UTC, sehingga 67 baris seed menggeser `ORDER BY created_at DESC` dan
  menyembunyikan gerakan stok terbaru dari `GET /api/stock/movements?limit=60`. Seed kini menulis UTC
  (jam bisnis 08:00–20:00 WIB) dan menarik mundur apa pun yang melewati waktu seed; urutan ledger memakai
  `rowid` sebagai pemecah seri (stempel hanya presisi 1 detik, `id` acak). (docs/11 §4 bagian seed/urutan)
- **Smoke UI membocorkan proses server** — `client/tests/ui-smoke.entry.jsx` memanggil `process.exit()`
  sendiri sehingga runner mati sebelum `cleanup()`: server anak jadi orphan di port 4399 dan run berikutnya
  diam-diam menguji DB kotor. Entry kini mengekspor `smokeFails`; runner membersihkan (`SIGTERM`+`SIGKILL`
  dan `process.on('exit')`) lalu keluar dengan kode yang benar. (docs/11 §13)
- **Tombol "Masuk" di layar login tidak berfungsi** (ditemukan saat penelusuran kode). Komponen
  `Button` mengunci `type="button"`, sehingga `<button>` di dalam `<form onSubmit={submit}>` tidak
  pernah men-submit apa pun: mengklik "Masuk" tidak melakukan apa-apa — tanpa request dan tanpa pesan
  error — dan hanya tombol Enter yang bisa masuk. Ini bug di layar pertama aplikasi yang dilihat kasir.
  Perbaikan: `Button` menerima prop `type` (default `'button'`, pemakai lain tidak berubah) dan tombol
  "Masuk" memakai `type="submit"`. Ditambah tes regresi di smoke UI (isi username/kata sandi → klik
  "Masuk" → pastikan shell muncul) yang sudah diverifikasi **gagal tanpa perbaikan** (2 assertion merah)
  dan lulus setelahnya.

### Diperbaiki (dokumentasi)

- README & `docs/01`: **Express 4 → Express 5** (yang terpasang 5.2.1; komentar di `server/src/index.js`
  sejak awal sudah menulis Express 5).
- `docs/01` §2: daftar middleware menyebut `cors` dan `multer` yang **tidak pernah terpasang**.
  Diganti dengan keadaan sebenarnya: satu-satunya dependensi produksi adalah `express`; `react`, `vite`,
  `concurrently`, `esbuild`, `jsdom` hanya dipakai saat build/uji.
- `docs/01` §3: deskripsi `server/src/index.js` menyebut `express.json({limit:'8mb'})` (aslinya `12mb`),
  `cors`, dan fungsi `initDb()` yang tidak ada. Kini mencantumkan header keamanan, `/api/health`,
  `/api/openapi.json`, fallback SPA, dan penegasan tidak ada `cors`/`initDb()`.
- `docs/01` §2: isi token diklaim `userId, storeId, branchId, role, pin, exp`; aslinya hanya
  `{ uid, role, sid, iat, exp }` — `branchId` dan permission dibaca ulang dari DB tiap permintaan.
- `docs/01` §5: default `KASIR_DATA_DIR` ditulis `server/data` (aslinya `server/src/data`),
  `KASIR_JWT_SECRET` diklaim "rahasia dev tetap di kode" (aslinya dibangkitkan & disimpan ke
  `.jwt-secret` mode 0600), dan `KASIR_TOKEN_TTL` ditulis `12h` (aslinya detik: `43200`).
- `docs/01` §6: klaim "uang selalu integer Rupiah" diperjelas — nilainya dibulatkan, tetapi kolomnya
  bertipe `REAL` di SQLite.
- `docs/01` §7: klaim **"`POST /api/stock/transfer` sudah tersedia"** dihapus — endpoint itu tidak ada.
  Diganti dengan keadaan sebenarnya (stok belum dipisah per cabang, laporan belum bisa difilter cabang,
  `transfer` masih nilai CHECK yang belum pernah ditulis) beserta arah perbaikannya.
- `docs/02`: nilai `movement_type` `transfer` ditandai sebagai cadangan yang belum diimplementasikan.
- README baris "Migrasi skema": ditambahkan peringatan bahwa belum ada migrasi bertahap
  (`PRAGMA user_version` tidak dipakai), sehingga menambah kolom pada rilis berikutnya tidak mengubah
  DB lama yang sudah berisi data.
- `docs/10` §1: baris "belum (v0.2+)" dilengkapi dengan celah yang belum tercatat — alur pindai barcode,
  split payment, cetak ESC/POS langsung, master pelanggan/poin, dan shift kas.
- `docs/10` §2: ditambahkan **"Risiko teknis yang diketahui (per 26 Sep 2026)"** — zona waktu toko yang
  belum diterapkan pada perhitungan tanggal (laporan harian, nomor struk, filter `from`/`to`),
  ketiadaan migrasi skema bertahap, kolom uang `REAL`, status multi-cabang, dan dua advisory dependensi
  dev (`esbuild`/`vite`).

### Diubah

- `docs/09` §10 dan README: **Vercel ditandai sebagai jalur demo/pratinjau**, produksi = VPS/systemd
  (SQLite di `/tmp` sementara & per-instance, rahasia JWT hilang tiap cold start, auto-seed menaruh
  kredensial demo publik). Perubahan kode untuk menutup auto-seed dijadwalkan di Sprint 2. (docs/11 §10)
- Dokumentasi disinkronkan untuk bagian yang tersentuh putaran ini: jumlah tes (docs/08, docs/09, docs/10),
  CSP & pembatas login (docs/04), hasil putaran verifikasi ketiga (docs/08 §3).
- **Migrasi skema aditif**: kolom baru sekarang didaftarkan di `ADDITIVE_COLUMNS` (`server/src/db/index.js`)
  dan ditambahkan otomatis ke DB lama saat boot (`ALTER TABLE … ADD COLUMN`, idempoten). Ini menutup sebagian
  celah "belum ada migrasi" — perubahan yang membangun ulang tabel (ubah CHECK/hapus kolom/backfill) tetap
  perlu langkah rilis bernomor versi. Dokumen disinkronkan: README, `docs/01` §3/§7, `docs/02` §5, `docs/09` §8.

### Diketahui / belum

- Perbaikan **zona waktu** (memakai `stores.timezone` untuk `created_at`, laporan harian, nomor struk,
  dan filter tanggal) belum dikerjakan — lihat `docs/10` §2 untuk dampak & contohnya.
- **Migrasi skema bernomor versi** (rollback/backfill/rebuild tabel) dan **shift kas** belum ada; urutan prioritasnya ada di `docs/10` §2.
- **Sprint 1/2 (rencana, tercantum di `docs/11`)**: ~~retur berulang tanpa batas~~ (sudah diperbaiki), retur berbasis snapshot,
  `forceConsumeRaw` yang diabaikan mesin BOM, zona waktu sisi laporan, permission per blok setting,
  CSV formula injection, dan gating auto-seed Vercel.

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
- Harness tes: `server/tests/{api,pricing,stock}.test.js` + `harness.js` (51 tes) dengan DB sementara **per file**;
  smoke UI `client/tests/` (28 pemeriksaan, render + alur bayar + tema + lebar struk).
- Alat pemeliharaan: `server/scripts/backup.js` (`VACUUM INTO` + `integrity_check` + `foreign_key_check` + rotasi `--keep`),
  `server/scripts/maintenance.js` (`status|verify|backup|restore|vacuum|prune|health`), pembungkus cron `ops/maintenance.sh`,
  `ops/{crontab.example,kasir.service,Caddyfile.example,nginx.example.conf}`; endpoint `GET /api/admin/backup` (audit `backup.download`).
- Dokumen: `README.md` + `docs/01…10` (arsitektur, skema, aturan stok/BOM, keamanan/RBAC, kustomisasi, panduan pengguna/SOP,
  referensi API, hasil QA, deployment & maintenance, rencana rilis beta).

### Diperbaiki (lahir dari hasil QA)- `GET /api/admin/backup` selalu 500 (`req is not defined` di handler yang parameternya `_req`) → diperbaiki + tes regresi
  yang memverifikasi magic header `SQLite` pada berkas unduhan dan entri audit `backup.download`.
- Addon transaksi divalidasi ke DB: `price_delta`, `raw_item_id`, `raw_qty` kini selalu diambil dari baris `item_addons`
  (via `resolveAddons()` di `server/src/sales.js` yang dipanggil `normalizeLines()` untuk pratinjau, order tertahan, dan
  penjualan). Sebelumnya nilai dari payload klien dipercaya, sehingga harga bisa direkayasa dan bahan barang lain dipotong.
- `server/scripts/seed.js`: urutan nilai INSERT bahan baku bergeser (`stock_qty` terisi `min_stock`, `min_stock` jadi 0,
  `lead_time_days` terisi nama pemasok) sehingga ada bahan ber-stok negatif setelah seed → diperbaiki; seed sekarang
  menghasilkan 0 stok negatif dan 0 selisih ledger.
- `nextInvoiceNo()` hanya mencoba 20 nomor pertama sehingga di DB berisi riwayat nomor struk jatuh ke `-<timestamp>`
  (13 digit di struk) → sekarang meneruskan nomor terbesar hari itu (`KS20260916-1328`).
- Pesan peringatan stok memakai angka mentah (`habis 5.779816 hari lagi`) → dibulatkan (`± 6 hari lagi`),
  dan daftar `variables` di `POST /api/receipt/preview` disamakan dengan placeholder yang benar-benar diisi perender struk
  (`{{store_name}} {{invoice}} {{date}} {{cashier}} {{customer}} {{subtotal}} {{tax}} {{grand_total}} {{payment}} …`).
- `server/scripts/qa-simulasi.js`: pemeriksaan balapan kasir kini memilih bahan yang dipakai produk **make_to_order** dan
  mengosongkan stok jadi produk itu lebih dulu (sebelumnya bisa lolos kebetulan karena produk make_to_stock tidak memotong bahan).

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
