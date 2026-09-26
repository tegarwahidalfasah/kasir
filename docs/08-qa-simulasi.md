# 08 — QA: simulasi transaksi massal, akurasi stok & kebocoran data (Fase 4)

Tiga lapisan pengujian, semuanya jalan tanpa dependency tambahan dan **tanpa menyentuh DB pengembangan**
(masing-masing membuat `KASIR_DATA_DIR` sementara sendiri).

```bash
npm test          # unit + integrasi: 77 tes (API 34 · zona waktu 6 · pricing 16 · stok/BOM 21) · ±8 s
npm run test:ui   # smoke UI (jsdom + React nyata) 32 pemeriksaan · ±27 s
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
| 1.9 | ✅ `external_ref` ganda dilayani idempoten (`duplicated: true`, tidak memotong stok lagi) |
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
* **1.9** — `POST /api/sales` dengan `external_ref` yang sama 3× beruntun → 200 (`duplicated: true`) dan 1 invoice yang sama.
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
| `stockHealth()` memakai `OUT_TYPES` berbeda dari `v_stock_health` (opname turun tidak dihitung di satu sisi) | disamakan: `('sale_out','bom_consume','adjustment')` — 51 tes tetap hijau |
| Toggle struk `barcode` & `points` ada di default tetapi tidak dirender | dikeluarkan dari `DEFAULTS.receipt.show` dan daftar label UI (dok 05 §7 mencatatnya “belum didukung”) |
| 5xx di produksi mengirim pesan mentah (mis. detail SQL) ke klien | `errorHandler` menyembunyikan pesan 5xx saat `NODE_ENV=production` (tetap di log) |
| `db.backup()` tidak tersedia di `node:sqlite` Node 22.22 | cadangan memakai `VACUUM INTO` (`GET /api/admin/backup` + `server/scripts/backup.js`) |

### Putaran verifikasi kedua (smoke API 60 pemeriksaan manual)

Selain tiga lapisan di atas, `docs/08` versi ini dihasilkan setelah menjalankan smoke API tambahan
(60 pemeriksaan, DB seed baru) yang memeriksa setiap rute + permission + format respons. Lima temuan nyata:

| Temuan | Perbaikan |
|---|---|
| `GET /api/admin/backup` selalu **500** (`req is not defined` — handler memakai `_req`) | parameter diperbaiki; tes regresi “unduh backup menghasilkan berkas SQLite + tercatat di audit” (memeriksa magic header `SQLite` & panjang > 100 KB) |
| payload transaksi boleh membawa `price_delta` / `raw_item_id` / `raw_qty` addon sendiri → harga bisa dipalsukan & bahan toko lain bisa dipotong | `resolveAddons()` (di `server/src/sales.js`) memetakan addon ke baris `item_addons` DB lewat `normalizeLines()` untuk `/pos/preview`, `/pos/hold`, dan `POST /sales`; tes regresi “addon dari klien divalidasi ke `item_addons`” |
| seed menulis kolom bahan bergeser (`stock_qty` diisi `min`, `min_stock` jadi 0, `lead_time_days` diisi teks pemasok) → 1 bahan stoknya **negatif** & `reconcileStock` harus “menyelamatkan” 9 item | urutan nilai `INSERT` bahan diperbaiki; seed kini menghasilkan **0 stok negatif, 0 selisih ledger** |
| `nextInvoiceNo()` hanya mencoba 20 nomor pertama → di DB yang sudah berisi riwayat, nomor struk baru jatuh ke `-<timestamp>` (13 digit, jelek di struk) | diambil dari `MAX(CAST(substr(...)))` nomor hari itu (fallback tetap ada); tes format `KS20260916-1328` |
| pesan alert memakai angka mentah (`perkiraan habis 5.779816 hari lagi`) | dibulatkan (`± 6 hari lagi`, `< 1` → “kurang dari 1 hari”), dan daftar `variables` di `POST /receipt/preview` disamakan dengan placeholder yang benar-benar diisi perender (`headVars`/`tailVars` di `client/src/features/receipt/receipt.jsx`) |
| pemeriksaan “balapan kasir” di QA bisa lolos karena kebetulan: ia memilih bahan termurah lalu menjual produk apa pun yang memakainya — produk `make_to_stock` tidak memotong bahan sama sekali | QA kini memilih di antara produk **make_to_order** saja dan mengosongkan stok jadi produk itu lewat opname, sehingga setiap penjualan pasti memotong bahan |

## 3. Smoke UI (render, alur, tema, struk)

Harness: `client/tests/ui-smoke.mjs` (menyalakan seed + API sementara, membundel dengan esbuild) →
`client/tests/ui-smoke.entry.jsx` (assertion di jsdom) → `client/tests/env.js` (jsdom + stub). 32 pemeriksaan
(28 pada putaran pertama–ketiga, **+4 pada putaran keempat**: form login – klik "Masuk" harus submit):

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
  Sejak 17 Sep 2026 entry tidak lagi memanggil `process.exit()` sendiri: jumlah kegagalan diekspor
  (`smokeFails`) dan **runner** yang membersihkan server anak lalu keluar. Sebelumnya proses API
  sementara jadi orphan di port 4399 setiap kali ada assertion gagal, sehingga run berikutnya
  diam-diam menguji DB kotor run sebelumnya (`docs/11-analisis-2026-09-17.md` §13).

### Putaran verifikasi ketiga (17 Sep 2026) — analisis `docs/11`

`npm run test:ui` kedapatan **merah** di `main` (27/28): assertion "ledger menyimpan gerakan untuk
`KS…`" gagal. Penyebabnya bukan UI, melainkan stempel waktu: `seed.js` menulis riwayat memakai
komponen waktu **lokal** sedangkan runtime menulis **UTC** (`nowIso()`), sehingga 67 baris seed
bertanggal "masa depan" mendorong gerakan struk baru ke peringkat 68 di `ORDER BY created_at DESC`
— di luar jendela `limit=60`. Perbaikan pada putaran ini:

| Perubahan | Berkas | Efek |
|---|---|---|
| Riwayat seed ditulis dalam UTC (jam bisnis 08:00–20:00 WIB = 01:00–13:00 UTC) dan **tidak pernah melewati waktu seed** | `server/scripts/seed.js` | 0 baris masa depan; gerakan terbaru kembali tampil di Ledger |
| Pemecah seri urutan ledger: `created_at DESC, rowid DESC` (bukan `id` acak) | `server/src/inventory.js` | urutan deterministik untuk gerakan dalam detik yang sama |
| Entry smoke UI mengekspor `smokeFails`; runner membersihkan server anak (`SIGTERM`+`SIGKILL`, `process.on('exit')`) | `client/tests/ui-smoke.{mjs,entry.jsx}` | tidak ada orphan/port terbawa; hasil CI reproduktif |
| 6 tes API baru: alur order tertahan (tahan→daftar→lanjut→hapus), nomor hold unik, RBAC `sale.hold`, header CSP, brute force dengan XFF palsu, `KASIR_TRUST_PROXY=false` | `server/tests/api.test.js` | 51 → **57 tes**; menutup celah yang membuat bug `storeId is not defined` lolos |
| CI GitHub Actions: `npm ci` → `npm test` → `test:ui` → `test:qa` → `build` (Node 22) | `.github/workflows/ci.yml` | "hijau sebelum rilis" kini ditegakkan mesin, bukan klaim dokumen |

Hasil setelah perbaikan: `npm test` **57/57**, `npm run test:ui` **28/28** (exit 0),
`npm run test:qa` **20/20**, `npm run build` sukses → `npm run check` hijau.

## 4. Putaran keempat — pagar retur (26 Sep 2026)

Temuan P0 #1 [`docs/11`](11-analisis-2026-09-17.md) diperbaiki: retur tidak lagi bisa diulang untuk
menggandakan stok. Diverifikasi dua lapis:

| Lapisan | Bukti |
|---|---|
| Tes regresi (**+4**, 57 → **61**) | 3 di `stock.test.js`: `retur berulang DITOLAK: sisa qty dijaga` · `retur sebagian mencatat uang proporsional` · `transaksi yang sudah diretur tidak boleh DIBATALKAN`; 1 di `api.test.js`: `retur lewat API berpagar` (409, uang, laporan neto, void ditolak). Tiga tes domain dijalankan terhadap kode `sales.js` versi lama → **3 failing** (14 passing); dengan perbaikan → 17 passing |
| Verifikasi HTTP di server nyata | Struk `KS20260926-1330` (qty 2): retur ke-1 `200` (uang 38.850, status → `refunded`), retur ke-2 & ke-3 `409 "… sudah diretur penuh"`; delta stok setelah penolakan = **0** untuk keenam bahan; omzet laporan turun tepat 38.850; `void` setelah retur → `409`, stok tidak berubah |
| Retur sebagian | Struk `KS20260926-1319` (baris qty 2): retur 1 → `refund_amount` 22.193, status tetap `completed`, `refunded_qty=1`; omzet laporan Δ −22.193 (persis uang retur), qty barang −1, HPP ikut turun |
| Migrasi DB lama | DB berskema lama (tanpa kolom baru) dibuka aplikasi → `[db] migrasi aditif diterapkan: transaction_items.refunded_qty, transactions.refund_total, transactions.refund_cost`; `refund_total=0` pada data lama, transaksi lama utuh |

## 5. Putaran kelima — retur berbasis snapshot & `forceConsumeRaw` (26 Sep 2026)

Temuan P0 #2 dan #3 [`docs/11`](11-analisis-2026-09-17.md) diperbaiki. Intinya: retur kini membalikkan **apa yang
benar-benar terpotong saat jual**, bukan resep/harga hari ini; dan mesin BOM akhirnya menghormati `forceConsumeRaw`.

| Lapisan | Bukti |
|---|---|
| Tes regresi (**+6**, 61 → **67**) | 4 di `stock.test.js`: mesin BOM memotong bahan walau stok jadi tersedia (`forceConsumeRaw`), retur memakai snapshot walau resep diubah, retur `make_to_order` mengembalikan bahan bukan barang jadi, data lama tanpa snapshot tetap bisa diretur; 2 di `api.test.js`: jejak audit `items[].bom` + retur pasca-perubahan resep, serta `simulate`/retur menghormati `forceConsumeRaw`. Tiga tes domain dijalankan terhadap `sales.js` versi lama → **3 failing** (17 passing) |
| Verifikasi HTTP #2 (satu server nyata) | Jual 2 porsi resep **30 gr** → bahan 5.000 → **4.940 gr** (terpakai 60 gr); `bom_json` tersimpan `{"finished":[],"raw":[{"item_id":"…","qty":60}]}`; resep diubah jadi **90 gr**/porsi; retur penuh → bahan kembali ke **5.000 gr** (60 gr, bukan 180 gr); alasan gerakan `Retur BOM …` |
| Verifikasi HTTP #3 (stok jadi > 0) | Jual 1 porsi saat stok jadi 0 → bahan −100 ml; produksi 5 porsi → barang jadi 5, bahan −500 ml; retur → **bahan +100 ml**, **barang jadi Δ 0** (cara lama: barang jadi +1, bahan 0). Simulasi `POST /items/:id/simulate` kini `deduct_finished: []`, `deduct_raw: [{qty:120}]` |
| Migrasi & data lama | Kolom `bom_json` di-`DROP` dari salinan DB 331 struk → boot aplikasi: `[db] migrasi aditif diterapkan: transaction_items.bom_json`, 331 struk/445 baris utuh; retur pada struk lama (`bom_json` NULL) → `200`, enam gerakan `return_in` bertanda `Retur BOM (tanpa snapshot) …` |

## 6. Putaran keenam — zona waktu, permission blok setting, CSV & kapasitas (26 Sep 2026)

Empat temuan sisa Sprint 1/2 [`docs/11`](11-analisis-2026-09-17.md) diperbaiki sekaligus: **#4 zona waktu**,
**#7 permission per blok setting**, **#8 CSV formula injection**, **#11 rumus kapasitas `yield_pct`**.

| Temuan | Perubahan | Bukti |
|---|---|---|
| #4 zona waktu | modul baru `server/src/lib/tz.js` (`businessDay`, `businessHour`, `tzOffsetSql`, `dayBoundsUtc`, `storeTimezone` + cache) dipakai laporan, nomor struk/PO, filter tanggal, proyeksi kehabisan | 6 tes `datetime.test.js` (5 gagal di kode lama: `KS20260926-` vs `KS20260927-`) + tes API: struk 01:00 WIB masuk hari WIB (`by_hour = [1]`, bukan `[18]`), 0 struk di tanggal UTC-nya, muncul di `GET /sales` & `/stock/movements` untuk tanggal WIB |
| #7 permission blok | gerbang rute → `auth([4 perm])`, `\|\| setting.store` dihapus | API: manager ber-`setting.store` saja → `PUT /settings/tax` **403**, theme **403**, receipt **403**, store **200**, PPN tetap 11% |
| #8 CSV | `csvCell()` menetralkan awalan `=+-@`/TAB/CR; angka tetap numerik | API: nama pelanggan `=HYPERLINK(...)` → `"'=HYPERLINK(...)"`, `grand_total` tetap `11000` |
| #11 kapasitas | hapus 2 salinan rumus; `items.js` & `stockhealth.js` memakai `bom.js#rawCapacity()`; `yield_pct` > 100 / ≤ 0 → **400** | API + runtime: resep 10 gr, yield 50%, stok 1.000 gr → katalog **50**, simulate **50**, stock/health **50** (dulu 50/100/100) |
| Regresi | — | 67 → **77 tes**; 4 tes API baru dijalankan terhadap kode lama → **4 failing** (30 passing) |

## 7. Cara menjalankan & menafsirkan

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

## 8. Rencana pengujian lanjutan (sebelum v1.0)

1. **Uji properti acak untuk `pricing.js`** (diskon non-stackable, batas `max_discount`, pembulatan) — 500 kasus acak
   dibandingkan implementasi reference; saat ini 16 kasus tangan.
2. **Uji ludi (fuzz) payload `/pos/preview` & `/sales`** (qty negatif, string, nested null) untuk memastikan semua
   menjadi 400, bukan 500.
3. **Uji beban multi-kasir sungguhan** (20 koneksi, 30 menit) + pengukuran `p95` `POST /sales`; sekarang hanya 120 permintaan serentak.
4. **Perf SQLite berkala**: `PRAGMA integrity_check` + `page_count` dicatat mingguan dari hasil `npm run maintenance -- status`.
5. **Playwright** di CI untuk alur cetak (butuh peramban nyata), dan uji printer termal fisik 58/80 mm.
6. **Zona ber-DST**: offset saat ini diambil pada satu titik waktu (aman untuk Indonesia yang tanpa DST);
   tambahkan kasus `America/New_York` di sekitar pergantian DST bila toko di zona itu mulai didukung.
7. **Kepadatan UI**: smoke UI masih memakai jsdom — uji visual (lebar struk & tabel) belum otomatis.