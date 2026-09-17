# Kasir — POS web dengan potongan stok bahan baku otomatis

Sistem kasir (Point of Sale) berbasis website untuk UMKM F&B / retail yang menjual **barang jadi hasil produksi sendiri**.
Ciri utamanya: satu produk dapat memotong **banyak bahan baku sekaligus** dalam satu transaksi (Bill of Materials / resep),
stok real-time, hak akses per peran, dan tampilan yang bisa dikustomisasi sendiri oleh pemilik toko tanpa menyentuh kode.

Status: **v0.1.0 — internal beta** (Fase 1–3 terimplementasi, Fase 4 = rangkaian uji + dokumen).

---

## Kenapa sistem ini berbeda

Pada kebanyakan aplikasi kasir, menjual *Croissant* hanya mengurangi stok *Croissant*.
Di sini satu transaksi penjualan croissant otomatis:

```
Croissant (barang jadi, made-to-order)  ×2
  ├─ tepung terigu  −0,300 kg   (2 × 150 g × (1 + 2% susut) ÷ 98% yield)
  ├─ mentega        −0,051 kg
  ├─ ragi           −0,003 kg
  └─ gas LPG        −0,004 kg   (bahan umum, dibagi per porsi)
```

Semua potongan tercatat di **ledger stok** (`stock_movements`) sebagai jejak audit, dan stok barang jadi
dipakai lebih dulu sebelum bahan baku dipotong. Pembatalan transaksi **mengembalikan** seluruh potongan tersebut.

## Fitur per fase (roadmap)

| Fase | Isi | Status |
|---|---|---|
| **1. Fondasi** | Skema DB relasional yang memisahkan **barang jadi (`finished`)** vs **bahan baku (`raw`)** + tabel resep; desain UI/UX modular (warna, logo, tata letak menu dapat diubah user); pemilihan stack & infrastruktur | ✅ |
| **2. MVP Kasir** | Modul transaksi: keranjang, total, pembayaran; stok real-time terpotong otomatis per transaksi; RBAC (kasir / manajer inventaris / admin + manajer & pemilik) | ✅ |
| **3. Operasional toko** | Panel kustomisasi (pajak dinamis, diskon khusus, metode pembayaran, tata letak & teks struk); peringatan stok menipis otomatis ke dasbor; analitik & laporan (tren penjualan, pergerakan stok harian, estimasi kehabisan bahan) | ✅ |
| **4. QA & rilis** | Simulasi transaksi massal + uji akurasi potongan BOM + uji kebocoran data; uji smoke UI; rencana rilis beta, deployment & jadwal pemeliharaan | ✅ (uji + dokumen, belum deploy ke produksi) |

Detail tiap fase ada di folder [`docs/`](docs/).

## Teknologi

| Lapisan | Pilihan | Alasan |
|---|---|---|
| Runtime & API | **Node.js ≥ 22.5** + Express 4 | Satu bahasa (JS) di seluruh stack; LTS aktif |
| Database | **SQLite** lewat modul bawaan `node:sqlite` | Nol dependensi native / nol servis tambahan → deployment cukup 1 proses Node + 1 berkas DB; transaksi ACID + `BEGIN IMMEDIATE` |
| Migrasi skema | `schema.sql` idempoten (`CREATE … IF NOT EXISTS`) di `server/src/db/` | Skema adalah sumber kebenaran; mudah direplikasi ke produksi |
| Web frontend | **React 18 + Vite** (SPA) | Build cepat, dev server dengan proxy `/api`, cocok untuk UI interaktif seperti POS |
| State & data client | Context store buatan sendiri (`client/src/store.jsx`) + helper `api` (`useApi`) | Kebutuhan state aplikasi kecil; menghindari dependensi tambahan |
| Styling | CSS vanilla + token (design tokens) di `:root` | Tema/logo/menu bisa diganti user lewat `settings.theme` tanpa rebuild |
| Autentikasi | Token bersandar HMAC-SHA256 (SHA-256 HMAC, base64url) + matriks hak akses per toko di tabel `settings` | Ringan, tanpa dependensi eksternal; mudah diaudit |
| Cetak struk | Garis teks monospace (58/72/80 mm) + `window.print()` lewat iframe tersembunyi | Struk termal tidak butuh driver/vendor SDK |
| Uji | Harness tes bawaan `node:test`/assert (unit backend), smoke UI jsdom, skrip simulasi HTTP (QA) | Tidak perlu framework UI berat |

> **Catatan stack:** tidak ada PHP/Composer, PostgreSQL, atau CLI SQLite di lingkungan pengembangan, sehingga
> keputusan memakai `node:sqlite` bawaan sekaligus menjadi batasan keras: **tanpa dependensi native**.

## Mulai cepat

```bash
npm install
npm run seed          # contoh data: 328 transaksi 30 hari ke belakang, 9 bahan baku + 9 barang jadi
npm run dev           # API http://127.0.0.1:4000  +  web http://127.0.0.1:5173
```

Login demo (kata sandi sama untuk semua): `rahasia123`

| Username | Peran | PIN kasir |
|---|---|---|
| `budi` | Pemilik (akses penuh) | 1111 |
| `sari` | Manajer Inventaris | 2222 |
| `rina` | Manajer | 3333 |
| `dewi` | Kasir | 4444 |
| `adi` | Kasir | 5555 |

Perintah lain:

```bash
npm start             # produksi sederhana: API + SPA (dist) dalam satu proses
npm run build         # build SPA ke client/dist
npm test              # tes unit backend (API, pricing, stok/BOM)
npm run test:ui       # smoke test UI (jsdom) — menjalankan seed + server sementara sendiri
npm run test:qa       # QA Fase 4: simulasi transaksi massal (buat DB sementara, 400 transaksi)
npm run check         # test + test:ui + build
npm run reset         # hapus DB (lalu jalankan npm run seed bila ingin contoh data lagi)
npm run backup     -- --verify --keep=14   # cadangan VACUUM INTO + verifikasi + rotasi
npm run maintenance -- status              # ukuran DB, cadangan terakhir, stok vs ledger
npm run maintenance -- restore <berkas> --yes
```

## Deployment

**Produksi = VPS / systemd** (dokumen lengkap: [`docs/09-deployment-dan-maintenance.md`](docs/09-deployment-dan-maintenance.md),
berkas siap pakai di [`ops/`](ops/): unit systemd yang di-harden, contoh Caddy/nginx, crontab cadangan).

> ⚠️ **Vercel di bawah ini hanya untuk demo/pratinjau UI, bukan untuk mencatat penjualan sungguhan.**
> Di lingkungan serverless, SQLite berada di `/tmp` yang **sementara dan per-instance** (transaksi hilang
> saat container recycle), rahasia JWT ikut hilang (semua sesi gugur tiap cold start), dan API otomatis
> men-seed **akun demo `budi`/`rahasia123`** yang tercantum di README ini. Rinciannya:
> [`docs/09` §10](docs/09-deployment-dan-maintenance.md) dan [`docs/11` §10](docs/11-analisis-2026-09-17.md).

Repositori ini telah dikonfigurasi untuk deploy langsung ke **Vercel** (Vite SPA + Express Serverless API):

1. **Push ke Git / GitHub**:
   ```bash
   git add .
   git commit -m "Konfigurasi deployment Vercel"
   git push
   ```

2. **Deploy di Vercel Dashboard**:
   - Buka [vercel.com](https://vercel.com) dan pilih **Add New... → Project**.
   - Impor repositori ini.
   - Konfigurasi otomatis terbaca dari `vercel.json` (`npm run build` → `client/dist` dan API di `/api/index.js`).
   - Klik **Deploy**.

3. **Deploy via Vercel CLI (Alternatif)**:
   ```bash
   npx vercel
   ```

> **Catatan Serverless:** Di lingkungan Vercel, API berjalan sebagai Serverless Functions dengan SQLite di `/tmp`. Saat cold-start pertama kali, sistem otomatis menginisialisasi skema dan data demo (*Kopi Senja*, pengguna `budi`, `dewi`, dsb.) sehingga aplikasi langsung siap dicoba.


## Struktur proyek

```
kasir/
├─ server/                        API Node + logika domain
│  ├─ src/index.js                Express: header keamanan, /api, SPA (client/dist), /api/health, error handler
│  ├─ src/db/schema.sql           21 tabel + view v_stock_health + 16 indeks (idempoten)
│  ├─ src/db/index.js             koneksi node:sqlite (WAL), tx(), allRows/firstRow, saveSetting/loadSetting
│  ├─ src/auth.js                 scrypt + PIN, token HMAC (JWT-like), pembatas login, audit()
│  ├─ src/rbac.js                 20 permission & preset 5 role (matriks dapat disunting per toko)
│  ├─ src/config.js               default 5 blok setting (store, tax, receipt, theme, pos)
│  ├─ src/bom.js                  resep/BOM: konsumsi bahan, kapasitas porsi, dampak stok
│  ├─ src/pricing.js              harga: diskon, pajak, service, pembulatan, validasi pembayaran
│  ├─ src/sales.js                POST transaksi: idempotensi → ledger stok → snapshot struk; void & retur
│  ├─ src/inventory.js            postMovement, opname, integritas ledger, rekonsiliasi, HPP rata-rata
│  ├─ src/stockhealth.js          kecepatan pemakaian, estimasi habis, pembangkit & daftar alert
│  ├─ src/middleware/             authenticate (default-deny), requirePerm, loginGuard
│  ├─ src/routes/                 auth · pos · items · stock · users · alerts · reports · settings
│  ├─ tests/                      api.test.js · pricing.test.js · stock.test.js + harness.js
│  └─ scripts/                    seed · reset · test · qa-simulasi · backup · maintenance
├─ client/                        SPA React (Vite)
│  ├─ src/App.jsx                 shell: sidebar dari settings.theme.menu, routing state-based, token tema
│  ├─ src/store.jsx               AppProvider/useApp (sesi, permission, refresh, toast) + useApi/useBlock/useAlerts
│  ├─ src/api.js                  fetch + token, get/post/put/del, downloadCsv
│  ├─ src/ui.jsx · ui.css         komponen dasar + design token (tema dibaca lewat CSS var)
│  ├─ src/features/               pos/ · inventory/ · report/ · alerts/ · admin/ · settings/ · receipt/
│  └─ tests/                      smoke UI: env.js · ui-smoke.entry.jsx · ui-smoke.mjs
├─ docs/                          11 dokumen (arsitektur → deployment → rencana beta → analisis)
├─ ops/                           crontab, systemd, Caddyfile/nginx, pembungkus maintenance
└─ .github/workflows/ci.yml       CI: npm test → test:ui → test:qa → build (Node 22)
```

## Dokumen

| Berkas | Isi |
|---|---|
| [docs/01-arsitektur.md](docs/01-arsitektur.md) | Arsitektur, alur permintaan, keputusan teknis, variabel lingkungan |
| [docs/02-skema-data.md](docs/02-skema-data.md) | Skema DB per tabel, relasi, ledger stok, indeks |
| [docs/03-stok-dan-bom.md](docs/03-stok-dan-bom.md) | Aturan potongan stok/BOM (lengkap, dengan contoh angka) |
| [docs/04-keamanan-dan-rbac.md](docs/04-keamanan-dan-rbac.md) | Sesi, matriks hak akses, audit, proteksi data, penguatan produksi |
| [docs/05-kustomisasi.md](docs/05-kustomisasi.md) | Panduan kustomisasi: tema, logo, menu, pajak, diskon, metode bayar, struk |
| [docs/06-panduan-pengguna.md](docs/06-panduan-pengguna.md) | SOP per peran: kasir, manajer inventaris, admin |
| [docs/07-api.md](docs/07-api.md) | Referensi endpoint REST + contoh cURL |
| [docs/08-qa-simulasi.md](docs/08-qa-simulasi.md) | Hasil QA Fase 4: transaksi massal, akurasi BOM, kebocoran data, smoke UI |
| [docs/09-deployment-dan-maintenance.md](docs/09-deployment-dan-maintenance.md) | Deployment, pencadangan, jadwal & prosedur pemeliharaan, rollback |
| [docs/10-rilis-beta.md](docs/10-rilis-beta.md) | Rencana rilis beta ke pengguna awal |
| [docs/11-analisis-2026-09-17.md](docs/11-analisis-2026-09-17.md) | Analisis repositori putaran 2: 15 temuan terverifikasi runtime + status perbaikan |

## Batasan yang diketahui (v0.1.0)

* Satu proses Node per toko/cabang; **belum** ada replikasi multi-kasir realtime antar mesin (rekomendasi: satu API pusat + beberapa perangkat).
* Belum ada mode luring/offline di kasir; bila koneksi putus, keranjang masih ada di layar tetapi pembayaran perlu jaringan.
* Perpajakan baru mendukung PPN/pajak layanan persentase + harga termasuk/pajak; belum ada faktur elektronik (e-Faktur) atau pemotongan PPh.
* Simpanan struk memakai snapshot JSON per transaksi (bukan tabel struk terpisah) — cukup untuk cetak ulang, belum untuk desain struk multi-cabang yang berbeda.
* Deployment nyata ke VPS/production belum dijalankan (dokumen Fase 4 berisi rencananya).

## Lisensi

Source-available untuk keperluan internal proyek; lihat [CHANGELOG.md](CHANGELOG.md) untuk riwayat perubahan.
