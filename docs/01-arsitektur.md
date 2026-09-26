# 01 — Arsitektur & keputusan teknis (Fase 1)

## 1. Ringkasan

Aplikasi berupa **SPA React** yang dilayani oleh **satu proses Node.js/Express** beserta REST API-nya.
Data disimpan di **SQLite** (berkas tunggal) melalui modul bawaan `node:sqlite`. Tidak ada dependensi native,
tidak ada servis eksternal (Redis/Postgres/nginx wajib) — sehingga pemasangan di VPS kecil maupun laptop UMKM sama-sama mudah.

```
Peramban (kasir/manajer/admin)
   │  fetch('/api/…') + token di header Authorization
   ▼
Express 5  ── middleware: authenticate → authorize(permission) → handler → JSON
   │                                   ↘ audit({action, entity, before, after})
   ▼
Modul domain (pure-ish, menerima storeId/branchId)
   pricing.js  →  harga: subtotal, diskon, pajak, service, pembulatan
   bom.js      →  resep (BOM) + konsumsi bahan + kapasitas mentah
   sales.js    →  POST /sales: validasi → ledger stok → snapshot struk + snapshot konsumsi BOM per baris
   lib/tz.js   →  hari bisnis toko (zona dari settings.store.timezone) untuk laporan, nomor struk, filter tanggal
   inventory.js→  adjustment, produksi, terima PO, rekonsiliasi, valuasi
   stockhealth.js → kecepatan pemakaian, hari-tersisa, alert stok menipis
   rbac.js     →  20 permission & preset 5 role (dapat disunting per toko)
   │
   ▼
node:sqlite (WAL) — tx() = BEGIN IMMEDIATE / COMMIT / ROLLBACK
```

## 2. Pemilihan stack (dan alternatif yang dipertimbangkan)

Roadmap menyebut stack "misalnya React/Vue, Node.js/PHP". Pertimbangan yang dipakai:

| Kebutuhan | Keputusan | Alasan |
|---|---|---|
| Tidak boleh menambah dependensi native (di lingkungan dev tidak ada `psql`/`sqlite3`/toolchain) | **SQLite via `node:sqlite`** (built-in Node 22.5+) | Driver JS murni (`sql.js`, `better-sqlite3` butuh native build atau memori besar) dihindari. `node:sqlite` memberi API sinkron `DatabaseSync` yang justru tepat untuk beban kasir. |
| UI kasir yang sangat interaktif (keranjang, pintasan, modal) | **React 18 + Vite** | Build cepat; `@vitejs/plugin-react`; proxy `/api` saat dev. Vue juga mungkin, tetapi komponen yang sudah ada dan pola `useApp()` mengikuti React. |
| Backend | **Node.js + Express 5** | Runtime sama dengan frontend, satu tim satu bahasa, dependensi runtime sengaja sangat sedikit: satu-satunya dependensi produksi adalah `express`; `react`, `vite`, `concurrently`, `esbuild`, dan `jsdom` hanya dipakai saat build/uji. |
| Autentikasi | Token HMAC-SHA256 bentukan sendiri (`signToken`/`verifyToken` di `server/src/auth.js`) | Tidak butuh `jsonwebtoken` (mengurangi dependensi); isi token hanya `{ uid, role, sid (= store_id), iat, exp }` — `branchId` dan permission **tidak** ikut di token, melainkan dibaca ulang dari DB pada setiap permintaan (lihat `authenticate`). Rahasia dari `KASIR_JWT_SECRET`, TTL dari `KASIR_TOKEN_TTL` (default 12 jam). |
| Cetak struk | Teks monospace + `window.print()` pada iframe tersembunyi | Printer termal USB/Bluetooth apa pun bekerja tanpa driver khusus; lebar 58/72/80 mm dihitung dalam kolom karakter. |
| Laporan/ekspor | CSV dibuat server (`/api/reports/export/:kind`) | Excel/Sheets langsung terbuka; `downloadCsv` di client punya fallback `data:` URL untuk peramban tanpa `URL.createObjectURL`. |

**Alternatif yang ditolak:** PHP + MySQL (tidak ada Composer/`psql` di lingkungan; skema relasional tetap bisa dibuat di MySQL — lihat catatan portabilitas di §7). SPA berat dengan Next.js (SSR tidak memberi nilai untuk kasir lokal). Prisma/Drizzle/ORM lain (lapisan tambahan; SQL eksplisit di `schema.sql` + query tangan lebih mudah diaudit untuk ledger stok).

## 3. Modul & berkas kunci

**Server**

| Berkas | Tanggung jawab |
|---|---|
| `server/src/index.js` | Pembuatan aplikasi Express: header keamanan (`X-Content-Type-Options`, `Referrer-Policy`, CSP), `express.json({ limit: '12mb' })`, `/api/health` + `/api/openapi.json` (skema OpenAPI dirakit dari daftar rute), mount `/api`, JSON 404 untuk `/api/*`, `express.static(dist)` + fallback SPA bila `client/dist` ada, dan error handler (`AppError` → JSON; pesan 5xx disenyapkan saat `NODE_ENV=production`). Berjalan sebagai API murni bila `client/dist` tidak ada. Tidak ada `cors` (aplikasi same-origin) dan tidak ada fungsi `initDb()` — skema dijalankan saat `db/index.js` diimpor. |
| `server/src/db/schema.sql` | Skema idempoten (21 tabel, 1 view `v_stock_health`, 19 indeks — 16 `CREATE INDEX` + 3 `CREATE UNIQUE INDEX`) + *seed* matriks hak akses ke `settings` key `rbac`. Kolom `updated_at` diisi `DEFAULT (datetime('now'))` dan disentuh ulang saat menyimpan. Dijalankan setiap startup. Karena `CREATE … IF NOT EXISTS` **tidak** mengubah tabel yang sudah ada, kolom baru didaftarkan di `ADDITIVE_COLUMNS` (`db/index.js`) dan ditambahkan otomatis lewat `migrateSchema()` saat boot — lihat §7. |
| `server/src/db/index.js` | `DATA_DIR` (env `KASIR_DATA_DIR`, default `server/src/data`; `/tmp` bila `VERCEL`), pragma WAL/`busy_timeout=5000`/`foreign_keys=ON`, eksekusi `schema.sql` saat modul diimpor, `tx()`, `allRows/firstRow/exec`, `uid(prefix)`, `saveSetting/loadSetting` (JSON di tabel `settings`), `mergeDeep`. |
| `server/src/config.js` | `DEFAULTS` untuk 5 blok setting: `store`, `tax`, `receipt`, `theme`, `pos`. `loadSetting` selalu menimpa default dengan yang tersimpan → menambah kolom/blok baru tidak perlu migrasi. |
| `server/src/middleware/index.js` | `PUBLIC_PATHS` (4 jalur bebas token), `authenticate` (verifikasi token → `req.user/storeId/branchId/permissions`; idempoten), `requirePerm(perm|perm[])`, `loginGuard` (batas percobaan login), `setting(key)`. Error handler ada di `index.js`: `AppError` → JSON `{error, details}`; 5xx disenyapkan di produksi. |
| `server/src/routes/*.js` | 8 router. Konvensi: `MOUNT` kosong, path lengkap sudah memuat prefiks (`/pos/...`, `/stock/...`), handler dibungkus `http()` agar rejection → 500 JSON. |
| `server/scripts/` | `seed.js` (data demo ±328 transaksi 30 hari; opsi `--n=`, `--quiet`, `--force`), `reset.js`, `test.js` (menjalankan `server/tests/*.test.js` dengan `KASIR_DATA_DIR` sementara; harness `describe/it/assert` ada di `server/tests/harness.js`), `qa-simulasi.js` (QA Fase 4). |

**Client**

| Berkas | Tanggung jawab |
|---|---|
| `client/src/App.jsx` | Named export `App`. Shell: sidebar + topbar; isi sidebar = `boot.settings.theme.menu` yang disaring per permission; routing berbasis state (`setPage`), halaman tak dikenal → POS. Menerapkan token tema ke `documentElement.style` (mode gelap memakai class `dark` di `<html>`). |
| `client/src/store.jsx` | `AppProvider`/`useApp`: sesi (simpan token, `bootstrap` sekali), `refresh()`, `can(perm)`, `toast()`, polling **ringan** `GET /api/bootstrap/lite` tiap 45 s (user/permission/`alert_count`/`catalog_version` saja), stream `GET /api/events` (SSE, `fetch` + `getReader()` agar token tetap di header) untuk sinyal stok realtime, `catalogVersion`/`stockRev`/`live` untuk konsumen, `useApi()` → `{get, post, put, del}`. |
| `client/src/api.js` | `setToken`, `getToken`, `useApi`, `downloadCsv`. |
| `client/src/ui.jsx` | `Card`, `Button`, `Modal`, `Field`, `Input`, `Select`, `Badge`, `DataTable`, `EmptyState`, `Toolbar`, `IconButton`, `Skeleton`, `ErrorState`, `Money`, `Stat`, `Tabs`. |
| `client/src/features/**` | `pos/` (POS + riwayat transaksi), `inventory/` (stok, barang & resep, pembelian), `report/` (dasbor, laporan), `alerts/`, `settings/`, `receipt/` (render + cetak struk), `admin/` (user & role). |
| `client/src/ui.css` | Design token di `:root`/`html.dark` + seluruh gaya. Nilai tema dibaca sebagai `var(--accent)` dlsb., sehingga penggantian warna lewat panel pengaturan berdampak seketika. |
| `client/tests/` | Smoke UI (jsdom + esbuild) — lihat [08-qa-simulasi.md](08-qa-simulasi.md). |

## 4. Alur permintaan yang layak diketahui

1. **Login** `POST /api/auth/login` (username+password **atau** `pin`) → `{token, user, store, settings}`. Client menyimpan token di `localStorage` dan memanggil `setToken`.
2. **Bootstrap** `GET /api/bootstrap` → satu muatan besar: `user, permissions, store, settings, catalog, bom, taxes, discount_rules, payment_methods, categories, units`, plus `catalog_version` (sha1 12 karakter dari hitungan item/resep/addon/pajak/diskon/metode/kategori — **angka stok sengaja tidak dihitung**, karena stok berubah terus dan punya jalurnya sendiri). Ada versi ringan `GET /api/bootstrap/lite` (user, permissions, store, `settings.theme`, `alerts_unread`, `catalog_version`) yang ≥5× lebih kecil — dipakai polling latar; katalog penuh hanya dimuat ulang bila `catalog_version` berubah.
3. **Realtime stok** `GET /api/events` (Server-Sent Events) → `hello` (memuat `catalog_version`) saat tersambung, lalu event `stock` setiap `postMovement` **setelah transaksi COMMIT** (bukan saat masih di tengah `tx()`, dan tidak dikirim bila transaksi di-*abort*); heartbeat `: ping` tiap 25 s. Klien memakai `fetch` + `getReader()` — **bukan** `EventSource`, agar token tetap dikirim lewat header `Authorization` dan tidak bocor ke query string/URL.
4. **Kasir** menambah baris → `POST /api/pos/preview` untuk proyeksi potongan bahan + total (server `priceCart` + `planStockImpact`), jadi angka di layar dan angka yang disimpan berasal dari rumus yang sama; POS menonaktifkan tombol Bayar selama `shortages.length > 0`.
5. **Bayar** `POST /api/sales` (lihat 03-stok-dan-bom.md §4). Respons memuat `movements` & `receipt_snapshot`.
6. **Peringatan** polling `/api/alerts` → badge sidebar; `POST /api/alerts/read/:id` untuk dismiss.

## 5. Variabel lingkungan

| Variabel | Default | Fungsi |
|---|---|---|
| `PORT` | `4000` | Port API (dan SPA saat `client/dist` ada) |
| `KASIR_DATA_DIR` | `server/src/data` | Direktori berisi `kasir.db`, `.jwt-secret`, dan `backups/` (hasil `VACUUM INTO`). Daftar lengkap + contoh ada di [`.env.example`](../.env.example) |
| `KASIR_DB_PATH` | `<KASIR_DATA_DIR>/kasir.db` | Jalur lengkap berkas DB (menimpa `KASIR_DATA_DIR`) |
| `KASIR_JWT_SECRET` | dibangkitkan otomatis & disimpan ke `<KASIR_DATA_DIR>/.jwt-secret` (mode 0600) | **wajib** diisi eksplisit di produksi |
| `KASIR_TOKEN_TTL` | `43200` | Masa berlaku sesi **dalam detik** (43200 = 12 jam) |
| `KASIR_TRUST_PROXY` | `loopback` (`true` bila `VERCEL`) | Seberapa jauh `X-Forwarded-For` dipercaya. **Wajib disetel benar**: nilai longgar membuat pembatas login per-IP bisa dilewati header palsu. Set `1`/CIDR bila proxy berada di mesin lain |
| `KASIR_LOGIN_LIMIT_IP` · `KASIR_LOGIN_LIMIT_USER` | `5` · `8` | Percobaan login gagal per 60 detik untuk IP dan per username (in-memory, per proses) |
| `NODE_ENV` | — | `production` → pesan error internal disembunyikan dari klien |

## 6. Konvensi yang dijaga di seluruh kode

* Uang selalu **dibulatkan ke Rupiah penuh** sebelum disimpan (total di `Math.round`, `pricing.js`); kolom `*_price`, `*_total`, `amount`, `paid_amount` bertipe `REAL` di SQLite, jadi nilai non-bulat secara teknis masih bisa masuk — API memakai integer dan klien tidak boleh mengirim pecahan. Persentase memakai `_pct` dan boleh desimal. Lihat catatan risiko di [10-rilis-beta.md](10-rilis-beta.md).
* Setiap gerakan stok punya `ref_type` + `ref_id` → dapat ditelusuri ke struk/PO/opname.
* `movement_type` dibatasi CHECK di skema: `sale_out`, `bom_consume`, `purchase_in`, `production_in`, `return_in`, `adjustment`, `transfer` (cadangan, belum ditulis kode mana pun — lihat §7). Pembatalan & retur memakai `return_in` untuk gerakan keluar (`sale_out`/`bom_consume`) dan `adjustment` untuk sisanya.
* Endpoint tulis selalu menyebut permission-nya lewat `auth('…')`; aksi sensitif dicatat dengan `audit({…, before, after})`.
* Field rahasia (`password_hash`, `pin_hash`, `token`, `secret`) tidak pernah ikut dalam respons API — diperiksa oleh `server/scripts/qa-simulasi.js` §4.
* Bahasa UI & dokumen: Indonesia.

## 7. Portabilitas & jalur upgrade

* **Pindah ke PostgreSQL/MySQL**: semua query berada di `server/src/**` dan `schema.sql`; yang perlu disesuaikan hanya `AUTOINCREMENT`/ID teks (dibangkitkan aplikasi, jadi netral), `datetime('now')`, `strftime`, `INSERT OR IGNORE`, dan `VACUUM INTO` (cadangan; `db.backup()` tidak tersedia di `node:sqlite`). Lapisan domain (`pricing.js`, `bom.js`, `stockhealth.js`) tidak menyentuh sintaks SQLite.
* **Multi-kasir**: `stock_movements` + `transactions` sudah menyimpan `store_id`/`branch_id`, jadi jejak per cabang sudah ada. Perlu dicatat: **belum ada pemisahan stok per cabang** (`items.stock_qty` satu nilai per toko), belum ada filter cabang di laporan, dan **belum ada endpoint transfer/mutasi antar cabang** — nilai `transfer` sudah diizinkan di CHECK `movement_type` tetapi belum ada yang menuliskannya. Menuju multi-cabang nyata berarti menambah `item_stock(store_id, branch_id, item_id)` atau kolom `branch_id` pada agregat stok.
* **Kolom baru (migrasi aditif)**: daftarkan `['tabel', 'kolom', 'TIPE NOT NULL DEFAULT …']` di `ADDITIVE_COLUMNS` (`server/src/db/index.js`) → dipastikan ada saat boot, idempoten, dan DB lama yang sudah berisi data ikut ter-upgrade (`ALTER TABLE … ADD COLUMN` dijalankan sekali). Contoh: `transaction_items.refunded_qty` (pagar retur), `transaction_items.bom_json` (snapshot konsumsi per baris), dan `transactions.refund_total`/`refund_cost`.
  Batasnya: hanya penambahan kolom. Mengubah/menghapus kolom, mengubah CHECK constraint (mis. menambah status transaksi baru), atau backfill data **belum** ditangani — itu perlu langkah rilis bernomor versi (`PRAGMA user_version`) dan uji migrasi tersendiri.
* **Menambah laporan**: tambah SQL agregat di `routes/reports.js` + `EXPORTS` untuk CSV; client tinggal memanggil `get('/reports/…')`.
* **Menambah blok pengaturan**: tambah default di `config.js DEFAULTS` → otomatis terbaca `GET /api/settings` dan dapat disimpan `PUT /api/settings/:key` (tanpa migrasi).
