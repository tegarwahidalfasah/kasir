# 08 — QA: simulasi transaksi massal, akurasi stok & kebocoran data (Fase 4)

Tiga lapisan pengujian, semuanya jalan tanpa dependency tambahan dan **tanpa menyentuh DB pengembangan**
(masing-masing membuat `KASIR_DATA_DIR` sementara sendiri).

```bash
npm test          # unit + integrasi: 49 tes (pricing 16 · stok/BOM 14 · API 19) · ±3 s
npm run test:ui   # smoke UI (jsdom + React nyata) 28 pemeriksaan · ±26 s
npm run test:qa   # QA transaksi massal: 20 pemeriksaan · ±10 s (400 struk)
npm run check     # npm test + test:ui + build client
```

Perintah yang lebih lengkap:

```bash
node --disable-warning=ExperimentalWarning server/scripts/qa-simulasi.js --n=800 --port=4330 [--keep] [--api=http://127.0.0.1:4100]
npm test -- api                                   # satu file saja (filter nama)
npm run test:ui -- --api=http://127.0.0.1:4100    # smoke UI memakai server yang sudah hidup
TEST_KEEP=1 npm test                              # simpan DB sementara untuk diinspeksi
```

## 1. QA transaksi massal — hasil 16 Sep 2026 (Node 22.22, Linux, DB sementara, `--n=400`)

**20/20 pemeriksaan lolos dalam 6,4 detik.**

| # | Pemeriksaan (kutipan dari keluaran) |
|---|---|
| 1.1 | ✅ transaksi massal diproses (400/400 berhasil) — 1.56 detik · **256 struk/detik** · 0 ditolak karena kapasitas bahan (benar: stok tidak boleh minus) |
| 1.2 | ✅ potongan bahan baku = perhitungan BOM (`qty × (1+susut) ÷ yield`) — **selisih maks 0.0000 satuan** pada 5 bahan |
| 1.3 | ✅ Δstok setiap item sama dengan total potongan yang dilaporkan struk (tidak ada stok hilang/tercopot) — 6 item diperiksa |
| 1.4 | ✅ rekonsiliasi ledger → stok: 0 item perlu disetel ulang — 0 item disetel, 18 diperiksa |
| 1.5 | ✅ integritas ledger global (rantai `balance_after`) — 18 item · 0 selisih |
| 1.6 | ✅ permintaan di atas kapasitas bahan ditolak — HTTP 409 · “Bahan baku untuk Americano tidak cukup — maksimal 229 porsi tersisa” |
| 1.7 | ✅ penolakan tidak mengubah stok sama sekali — 5 bahan dicek ulang |
| 1.8 | ✅ 12 struk terbaru seluruhnya punya jejak di log audit — 300 entri `sale.create` · 12/12 struk terlacak |
| 1.9 | ✅ `external_ref` ganda dilayani idempoten (tidak memotong stok lagi) |
| 1.10 | ✅ struk tersimpan memakai snapshot (harga & layout tidak berubah setelah setting diedit) — `grand_total` 20000 tetap |
| 1.11 | ✅ pembatalan 400 transaksi **mengembalikan seluruh stok bahan** — 400 void sukses · 1.20 detik |
| 1.12 | ✅ balapan 120 kasir pada bahan “Cup Plastik 16oz + Lid” — 120 sukses, 0 ditolak · stok 1600.00 → 1480.00 (dipakai 120.00) |
| 4.1 | ✅ kasir boleh melihat katalog (200) · tidak boleh mengubah pengaturan toko (403 `setting.store`) |
| 4.2 | ✅ kasir tidak boleh membaca daftar user (403 `user.manage`) · tidak boleh mengunduh backup DB (403 `system.maintenance`) |
| 4.3 | ✅ tanpa token semua rute data tertutup (401) · token palsu ditolak (401) |
| 4.4 | ✅ nama toko tidak berubah setelah percobaan ubah oleh kasir — “Kopi Senja” utuh |
| 4.5 | ✅ **tidak ada kolom rahasia** (`password_hash`, PIN) di seluruh respons API — bersih |

Skrip: `server/scripts/qa-simulasi.js` (±305 baris). Ia menjalankan `server/scripts/seed.js` lalu
`server/src/index.js` di port bebas, memakai HTTP sungguhan (bukan memanggil fungsi internal) sehingga middleware,
RBAC, ledger, dan snapshot ikut teruji.

### Metode tiap pemeriksaan

* **1.1–1.2** — 400 `POST /api/sales` (300 via `Promise.all` untuk memancing kontensi), qty acak 1–3,
  `external_ref` unik per struk. Setiap invoice yang berhasil diambil lewat `GET /sales/:id`, `movements` dijumlahkan
  per item, lalu dibandingkan dengan **implementasi reference BOM yang ditulis ulang di skrip** (bukan memanggil `bom.js`)
  dan dengan `stock_after` pada respons `POST /api/items/:id/simulate`. Item `make_to_stock` sengaja dikecualikan dari
  pembanding bahan (potongannya ke stok jadi, bukan ke bahan).
* **1.3–1.4** — Δstok tiap item **dalam jendela uji** dibandingkan dengan total potongan yang dilaporkan struk; lalu
  `POST /api/stock/reconcile` harus `fixed: 0`.
* **1.5** — `GET /api/stock/integrity`: `mismatches = []` (stok = Σ seluruh baris ledger).
* **1.6–1.7** — permintaan `qty = stok bahan + 1000` → 409; stok dibaca ulang, tidak boleh bergerak.
* **1.9** — `POST /api/sales` dengan `external_ref` yang sama 3× beruntun → 200 (`idempotent_replay`) dan 1 invoice yang sama.
* **1.10** — setelah transaksi, `PUT /api/settings/tax` (`enabled:false, default_rate_pct:0`) & `PUT /api/settings/receipt`
  (header/lebar diubah) → `GET /sales/:id` harus tetap menampilkan angka & layout lama; lalu setting dikembalikan.
* **1.11** — 400× `POST /sales/:id/void` → Δstok persisi kembali ke nilai awal.
* **1.12** — bahan “Cup Plastik” dibatasi, 120 permintaan paralel dijanjikan; tidak boleh ada stok negatif atau potongan ganda.
* **4.5** — seluruh respons API yang lewat dikumpulkan, dicari kunci yang mengandung
  `password`/`secret`/`pin_hash`/`token` (kecuali `token` hasil login) → harus 0.

### Jebakan yang sudah dibayar mahal (catatan untuk penulis tes baru)

1. `GET /api/stock/movements?item_id=` mengembalikan **seluruh riwayat** (termasuk 328 transaksi seed) — membandingkan
   Δstok dengan “Σ ledger global” selalu gagal. Bandingkan hanya dalam jendela uji; serahkan konsistensi menyeluruh ke
   `/stock/integrity` + `/stock/reconcile`.
2. `PUT /api/settings/tax` bersifat replace-per-kunci-atas: membaca `tax` dari `receipt_snapshot` memberi `undefined`
   dan **menimpa** konfigurasi. `GET /settings` dulu, lalu kirim blok penuh.
3. Jumlah struk sukses < N itu **benar** bila kapasitas bahan habis — jangan pakai N sebagai assertion; yang diuji
   “0 kegagalan selain penolakan kapasitas”.
4. `/audit` dibatasi 300 baris terbaru dan berisi juga `purchase.*`/`settings.*`/`sale.void`; periksa lewat
   `entity_id` struk terbaru **sebelum** void massal (kalau sesudah, entri `sale.create` tergeser).
5. Runner tes (`server/scripts/test.js`) memberi **satu `KASIR_DATA_DIR` per file tes**, bukan per proses; di
   `server/tests/api.test.js` DB-nya sengaja diletakkan **di luar** DB engine lain supaya tabrakan nama `username`
   (UNIQUE global, bukan per toko) tidak membuat satu file gagal karena file lain sudah mengisi DB.

## 2. Temuan QA yang berujung perbaikan kode

| Temuan | Perbaikan |
|---|---|
| `rawCapacity()` tidak membagi `yield_pct`, sehingga kartu POS menampilkan “maks N porsi” **lebih optimis** daripada mesin stok (kasir bisa dapat 409 setelah optimis boleh) | `server/src/bom.js`: `rawCapacity` memakai faktor yield yang sama dengan `planStockImpact` |
| `GET /api/audit` berurutan `created_at DESC` saja → dalam 1 detik bisa ada puluhan baris, hasil “12 struk terakhir” tidak stabil | `ORDER BY a.created_at DESC, a.rowid DESC` (tiebreaker stabil) |
| Daftar riwayat (`GET /api/sales`) berurutan `created_at DESC` → transaksi dalam detik yang sama bisa tertukar di layar | `ORDER BY date(t.created_at) DESC, t.created_at DESC, t.rowid DESC` |
| `PaymentModal` tidak mengisi uang tunai otomatis → kasir menekan Bayar dengan 0 | otomatis isi `amount = grand_total` saat metode tunai |
| Struk 58 mm menumpuk saat nama barang panjang | `twoCol()` memotong label lalu menyisipkan baris lanjutan (dijaga assertion lebar kolom di smoke UI) |
| Skrip QA sempat “gagal” karena penolakan kapasitas mengaburkan hasil | top-up bahan + stok MTS via `POST /api/stock/adjust` sebelum uji volume (bukan menghapus assertion) |
| Modal detail transaksi di Riwayat memanggil endpoint yang tidak ada | memakai `GET /api/sales/:id` (sudah mengembalikan `movements` + `receipt_snapshot`) |
| Isolasi tenant: `PUT`/`DELETE /api/users/:id`, `PUT /api/payment-methods/:id`, `PUT /api/discounts/:id`, `PUT/DELETE /api/categories/:id`, `PUT /api/items/:id/addons` hanya memakai `WHERE id = ?` | semua ditambah `AND store_id = ?` (+ cek keberadaan untuk kategori) → admin toko lain **tidak bisa** mengubah/mereset user/harga di toko lain. Regresi: `it('isolasi antar toko…')` di `server/tests/api.test.js` |
| Guard auth bergantung pada urutan router; `?token=` di query string | guard global `api.use(authenticate)` (default-deny) + token hanya lewat header; tes “endpoint tanpa token → 401” tetap hijau |
| `bootstrap` menampilkan `stores.name` tetapi nama toko dari blok `settings.store` lebih dulu, sehingga toko baru tampil “Toko Saya” | `store: { ...DEFAULTS.store, ...store, name: store.name || settings.store.name }` |
| `stockHealth()` memakai `OUT_TYPES` berbeda dari `v_stock_health` (opname turun tidak dihitung di satu sisi) | disamakan: `('sale_out','bom_consume','adjustment')` — 49 tes tetap hijau |
| Toggle struk `barcode` & `points` ada di default tetapi tidak dirender | dikeluarkan dari `DEFAULTS.receipt.show` dan daftar label UI (dok 05 §7 mencatatnya “belum didukung”) |
| 5xx di produksi mengirim pesan mentah (mis. detail SQL) ke klien | `errorHandler` menyembunyikan pesan 5xx saat `NODE_ENV=production` (tetap di log) |
| `db.backup()` tidak tersedia di `node:sqlite` Node 22.22 | cadangan memakai `VACUUM INTO` (`GET /api/admin/backup` + `server/scripts/backup.js`) |

## 3. Smoke UI (render, alur, tema, struk)

Harness: `client/tests/ui-smoke.mjs` (menyalakan seed + API sementara, membundel dengan esbuild) →
`client/tests/ui-smoke.entry.jsx` (assertion di jsdom) → `client/tests/env.js` (jsdom + stub). 28 pemeriksaan:

* **Render** — 11 tampilan tanpa error JS memakai data asli server (contoh jumlah elemen pada satu kali jalan):
  shell App 159 · Kasir 105 · Stok 578 · Barang & bahan 251 · Pembelian 71 · Dasbor 353 · Laporan 246 ·
  Peringatan 149 · Riwayat 2199 · User & role 153 · Pengaturan 67.
* **Alur kasir** — klik tile → qty 2 → `TOTAL Rp37.750` → proyeksi bahan (`2 pcs Dough Croissant Beku / 25.2 gr Mentega Tawar`)
  → modal bayar (uang tunai terisi otomatis) → **Proses pembayaran** → struk `KS…` tampil →
  stok master `Butter Croissant` berkurang tepat 2 (mis. **132 → 130**) → ledger punya gerakan untuk invoice itu.
* **Kustomisasi** — 8 palet tampil; klik palet mengubah `--accent` di `documentElement` **sebelum** disimpan;
  setelah Simpan, `GET /bootstrap` (dibaca ulang langsung dari server, bukan cache boot) menunjukkan `#8b5e34`;
  editor urutan menu (`.menu-row`) tersedia.
* **Semua lebar struk** — `buildReceiptLines` untuk 58/72/80/240 mm: baris terlebar 30/40/46/30 ≤ batas kolom
  (32/42/48/120) → nama barang panjang tidak membuat struk meluber.
* `ui-smoke.mjs` **berhenti dengan kode ≠ 0** bila ada assertion gagal (dipakai di CI/`npm run check`).

## 4. Cara menjalankan & menafsirkan

```bash
cd /home/user/kasir
npm ci
npm test && npm run test:ui && npm run test:qa     # semua harus hijau
```

Keluaran yang menunjukkan masalah:

| Keluaran | Arti | Tindakan |
|---|---|---|
| `❌ … HTTP 500` di QA | rute/melegasi patah | lihat stack di stdout server anak; jalankan ulang dengan `--keep`; skrip mencetak `pangkalan data uji: /tmp/…` yang bisa dibuka ulang |
| `selisih maks` besar pada 1.2 | rumus konsumsi berubah | bandingkan `bom.js:planStockImpact` dengan pembanding di QA |
| `1 item disetel` pada 1.4 | ada jalur tulis stok tanpa ledger | cari `UPDATE items SET stock_qty` di luar `inventory.js`/`sales.js` |
| `⚠️ ada kunci rahasia: …` pada 4.5 | SELECT baru membocorkan kolom | perkecil daftar kolom rute tersebut |
| smoke UI “Cannot find package 'jsdom'” | devDependency belum terpasang | `npm i` di root (`jsdom` + `esbuild` ada di `devDependencies`) |
| smoke UI “Build failed … Unexpected \"catch\"” | sintaks JSX | perbaiki berkas; runner sengaja tidak membungkam error esbuild |

## 5. Rencana pengujian lanjutan (sebelum v1.0)

1. **Uji properti acak untuk `pricing.js`** (diskon non-stackable, batas `max_discount`, pembulatan) — 500 kasus acak
   dibandingkan implementasi reference; saat ini 16 kasus tangan.
2. **Uji ludi (fuzz) payload `/pos/preview` & `/sales`** (qty negatif, string, nested null) untuk memastikan semua
   menjadi 400, bukan 500.
3. **Uji beban multi-kasir sungguhan** (20 koneksi, 30 menit) + pengukuran `p95` `POST /sales`; sekarang hanya 120 permintaan serentak.
4. **Perf SQLite berkala**: `PRAGMA integrity_check` + `page_count` dicatat mingguan dari hasil `npm run maintenance -- status`.
5. **Playwright** di CI untuk alur cetak (butuh peramban nyata), dan uji printer termal fisik 58/80 mm.
