# Vercel + Turso: database bersama, sesi tidak bergantung instance

Panduan ini menggantikan cara lama Vercel + SQLite `/tmp`. Frontend dan API tetap di Vercel; **seluruh query dan transaksi menuju database Turso/libSQL yang sama**. Tidak ada replica lokal, salinan `/tmp`, atau fallback saat koneksi online bermasalah.

**Status:** kode diuji dengan SDK libSQL HTTP asli terhadap fixture HTTPS/Hrana lokal, termasuk login lintas-proses, restart, transaksi paralel, commit/rollback, BOM dan void. Belum diuji pada akun Turso/Vercel pengguna; perlu konfigurasi dan smoke test deployment di bawah. Jangan menganggapnya sudah lolos uji beban produksi.

## 1. Buat database

1. Buat akun / masuk ke [Turso](https://turso.tech/).
2. Buat database **libSQL** baru untuk demo, misalnya `kasir-demo`.
3. Pilih lokasi sedekat mungkin dengan region fungsi Vercel. Setiap query melewati jaringan, sehingga lokasi sangat memengaruhi kecepatan.
4. Salin **Database URL** (`libsql://...turso.io`) dan buat **database auth token dengan izin baca/tulis**. Periksa batas kuota/biaya paket yang dipilih.

Jangan gunakan token organisasi sebagai token database, jangan kirim token ke chat, dan jangan taruh token dalam variabel `VITE_*`. Untuk Preview dan Production gunakan **database dan secret terpisah** agar demo tidak menyentuh data toko.

## 2. Isi skema dan akun satu kali dari komputer sendiri

Gunakan kode terbaru dari branch perubahan ini. Di folder akar repositori, jalankan `npm ci` dengan Node.js 22.x terbaru atau 24.x.

Buat file `.env` lokal berisi **hanya**:

```dotenv
TURSO_DATABASE_URL=libsql://GANTI-DENGAN-URL-DATABASE
TURSO_AUTH_TOKEN=GANTI-DENGAN-TOKEN-DATABASE
```

`.env` sudah diabaikan Git. Jangan commit, screenshot nilainya, atau menyalin contoh konfigurasi filesystem VPS ke Vercel. `npm run db:setup` membaca `.env` otomatis melalui flag Node; `npm start` biasa tidak membaca `.env` otomatis.

### Pilihan A — demo privat

Aktifkan **Deployment Protection / Vercel Authentication** untuk deployment yang akan dipakai sebelum membagikan URL. Bila paket Anda tidak melindungi domain Production, gunakan deployment **Preview privat**. Lalu:

```bash
npm run db:setup -- --demo
```

Perintah ini membuat skema, satu toko, dua akun, metode pembayaran Tunai, produk Americano, dua bahan baku, resep BOM, dan stok awal. Ini demo kecil untuk menguji penjualan, **bukan** 328 transaksi historis milik seed lokal.

| Akun | Username | Password | PIN |
| --- | --- | --- | --- |
| Pemilik | `budi` | `rahasia123` | `1111` |
| Kasir | `dewi` | `rahasia123` | `4444` |

Akun ini punya kredensial publik. Gunakan hanya untuk demo privat, bukan transaksi/data pribadi nyata. Mengubah password saja tidak mengubah PIN; bila ingin akun pribadi gunakan database terpisah dan pilihan B.

### Pilihan B — toko kosong dengan akun pemilik pribadi

Tambahkan pada `.env` lokal:

```dotenv
KASIR_OWNER_USERNAME=nama-pemilik-anda
KASIR_OWNER_PASSWORD=GANTI-DENGAN-PASSWORD-KUAT-MINIMAL-12-KARAKTER
KASIR_STORE_NAME=Toko Saya
```

```bash
npm run db:setup -- --owner
```

Tidak membuat akun `budi`/`dewi` atau PIN publik. Hapus variabel `KASIR_OWNER_*` dari `.env` setelah berhasil; variabel ini **tidak diperlukan di Vercel**. Akun berikutnya dibuat dari menu User & Role.

### Sifat setup

- Tanpa `--demo`/`--owner`: hanya skema dan migrasi (`npm run db:setup`).
- Aman diulang: tidak menghapus data, mengganti ID pengguna, mereset password, atau mengisi akun demo jika sudah ada toko/pengguna.
- Skema dan data awal berada dalam satu transaksi write; kegagalan menyebabkan rollback. Pemeriksaan DB kosong berada di dalam transaksi, bukan check-then-insert lintas-request.
- Tidak ada endpoint web untuk setup/reset/seed. **Jangan tambahkan setup ke Build Command.**
- Tidak memindahkan data dari `/tmp` deployment lama. Peralihan ini membuat DB baru; data demo lama tidak otomatis ikut.

## 3. Atur Vercel

Pastikan perubahan kode ini sudah berada pada branch Git yang dideploy oleh Vercel. Mengubah env tanpa men-deploy kode baru **tidak** memindahkan database.

Pengaturan proyek:

| Pengaturan | Nilai |
| --- | --- |
| Root Directory | Akar repositori, bukan `client` atau `server` |
| Node.js | 22.x terbaru atau 24.x |
| Install Command | `npm ci --include=dev` |
| Build Command | `npm run build` |
| Output Directory | `client/dist` |

Di **Settings → Environment Variables**, isi pada scope deployment yang akan dipakai:

| Nama | Isi |
| --- | --- |
| `TURSO_DATABASE_URL` | URL DB yang sama dengan langkah setup |
| `TURSO_AUTH_TOKEN` | Token DB yang sama dengan langkah setup |
| `KASIR_JWT_SECRET` | Secret acak tetap, minimal 32 karakter; boleh mempertahankan secret deployment sebelumnya |
| `NODE_ENV` | `production` — termasuk untuk demo/Preview |

Buat secret JWT bila belum ada: `openssl rand -hex 32`. Alternatif jika Node tersedia:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

**Hapus pengaturan lama:** `KASIR_AUTOSEED`, `KASIR_ALLOW_SEED`, override `NODE_ENV=development`, `KASIR_DATA_DIR`, `KASIR_DB_PATH`, dan `KASIR_SECRET_FILE`. Auto-seed tidak berlaku pada DB online. Jangan menyalin `KASIR_TRUST_PROXY=loopback` dari contoh VPS; biarkan default Vercel jika belum mengatur proxy sendiri.

Dev dependencies (Vite/esbuild) diperlukan saat build walaupun `NODE_ENV=production`; karena itu Install Command menyertakan `--include=dev`.

Deploy/redeploy **setelah** setup berhasil. `vercel.json` memasukkan skema dan worker SDK yang dibundle oleh `build:api`, serta memberi waktu fungsi maksimum 60 detik. Tetap gunakan Build Command akar, bukan hanya `vite build`, agar file worker tidak tertinggal.

## 4. Verifikasi deployment

1. Buka `/api/health` pada URL deployment baru. Harus ada `"ok": true`, `"database": "turso"`, dan `"db_file": "turso"` (bukan `/tmp/kasir.db`). Demo awal memiliki 3 item; toko kosong memang 0.
2. Login ulang sekali untuk mengganti token akun demo `/tmp` lama, yang ID penggunanya memang berbeda.
3. Buka Kasir, pindah menu, tunggu lebih dari satu menit, dan refresh. Sesi harus tetap berlaku.
4. Pada demo, jual satu Americano; Biji kopi turun 18 g dan Gelas turun 1 pcs. Buka dari tab lain/refresh untuk memeriksa riwayat dan stok yang sama.
5. Redeploy dan cek akun, transaksi, dan stok masih ada. Uji void mengembalikan bahan baku.
6. Pastikan API yang dilindungi tanpa token tetap 401, dan kasir tidak dapat menjalankan fungsi pemilik.

Jika tetap keluar, lihat Network → respons 401: `Akun tidak aktif` berarti ID pengguna tidak ditemukan/nonaktif di DB yang sedang dipakai; `Token tidak valid atau sesi berakhir` berarti periksa secret/TTL. Jangan mengatasi dengan mematikan autentikasi.

## 5. Pemeliharaan dan batas implementasi

- **Backup/restore:** gunakan fasilitas ekspor, backup, atau pemulihan Turso sesuai paket. Uji restore ke DB terpisah sebelum memakai data penting. Tombol download backup SQLite/API mengembalikan 409 dalam mode remote. Skrip backup/reset/maintenance file lokal juga ditolak; jangan mengira `/tmp` merupakan backup DB online.
- **Migrasi:** jalankan `npm run db:setup` dari komputer operator sebelum deployment yang mengubah skema. Runtime memeriksa versi skema dan gagal tertutup bila DB belum siap; tidak menjalankan DDL/seed pada setiap cold start.
- **Stok antar-instance:** API mengirim `stock_transport: "poll"`. Klien tidak membuka SSE yang hanya menjangkau satu proses. POS menarik stok tiap 60 detik; identitas/permission/katalog ringan tiap 45 detik. Validasi stok saat pembayaran tetap dari DB dalam transaksi, bukan angka layar.
- **Adapter sinkron transisional:** domain lama memakai fungsi sinkron. SDK HTTP berjalan dalam worker terpisah; main thread menunggu hasil agar transaksi sinkron tidak disela request lain. Setiap proses menangani query secara serial, tiap query mempunyai round-trip jaringan. Ini **bukan** adapter async ber-throughput tinggi. Perlu profiling pada region nyata, pengurangan query/batching, dan refactor async sebelum beban toko besar. Jangan klaim siap produksi hanya karena login berhasil.
- **Transaksi:** `BEGIN IMMEDIATE` dipetakan ke transaksi write SDK dengan stream yang sama hingga COMMIT/ROLLBACK. Tidak memakai batch terpisah untuk setiap langkah transaksi dan tidak mengunduh ulang file SQLite. Kunci tulis dibagi semua instance oleh database.
- **Pemulihan UI:** kegagalan bootstrap karena jaringan/5xx menampilkan tombol Coba lagi tanpa menghapus token. Respons 401 tetap menghapus sesi yang ditolak.
- **Timeout:** transaksi juga tunduk pada batas durasi/idle penyedia libSQL; menaikkan waktu fungsi Vercel tidak menghapus batas tersebut. Tunggu worker dibatasi 10 detik per operasi; error tidak di-retry otomatis. Timeout COMMIT bisa berarti server sudah menyimpan transaksi tetapi respons hilang. Periksa riwayat dan gunakan `external_ref` yang sama bila retry; jangan menggandakan transaksi manual. Koneksi lama dibuang.
- **Pembatas login:** masih in-memory per-instance. Gunakan Deployment Protection untuk demo; sebelum akses publik/toko sungguhan perlu rate limit bersama/WAF, pemantauan, akun pribadi, dan pengujian beban/keamanan. PIN empat digit tidak layak dibiarkan terbuka tanpa perlindungan tambahan.
- **Lokal/VPS:** bila tidak ada variabel Turso dan bukan Vercel, `node:sqlite` tetap digunakan. `npm run seed` lama tetap untuk lokal; untuk online gunakan setup di atas.

## 6. Diagnosis

| Pesan/gejala | Tindakan |
| --- | --- |
| Vercel memerlukan `TURSO_DATABASE_URL` dan `TURSO_AUTH_TOKEN` | Isi keduanya pada scope yang benar. Tidak ada fallback `/tmp`. |
| `Database Turso belum siap` | Pastikan URL/token benar, token belum kedaluwarsa, DB dapat diakses, dan `npm run db:setup` sudah berhasil. Periksa penyebab di Runtime Logs tanpa membagikan token. |
| `KASIR_JWT_SECRET wajib diisi` | Isi secret tetap di scope deployment dan redeploy. Berlaku juga saat `NODE_ENV` bukan production untuk DB online. |
| Worker file missing/timeout sejak cold start | Gunakan Build Command `npm run build` dan `vercel.json` dari akar repositori, bukan `client` saja. |
| Health sukses tetapi login gagal | Jalankan setup `--demo` atau `--owner` di DB yang sama; schema-only tidak membuat akun. |
| Masih terlihat `/tmp/kasir.db` | Deployment masih memakai kode lama, atau Anda membuka URL deployment lama. |
| Stok tab lain belum berubah | Mode polling, tunggu maksimal sekitar 60 detik atau refresh. |
| API lambat/timeout | Periksa region DB dan fungsi, kuota DB, beban dan jumlah query. Jangan menghapus pemeriksaan stok/transaksi demi kecepatan. |

Uji regresi: `npm run check`. Integrasi online terisolasi: `npm test -- remote` (memerlukan OpenSSL untuk sertifikat HTTPS fixture). Tidak menggunakan kredensial Turso nyata atau database pengguna.
