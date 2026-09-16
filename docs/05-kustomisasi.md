# 05 — Kustomisasi oleh pemilik toko (Fase 3)

Semua pengaturan disimpan di tabel `settings` sebagai JSON (satu baris per blok per toko) dan **diedit dari layar
Pengaturan** — tanpa menyentuh kode, tanpa rebuild, tanpa restart. Default tiap blok ada di `server/src/config.js`;
`loadSetting()` selalu menimpa default dengan nilai tersimpan, sehingga menambah opsi baru tidak memerlukan migrasi.

Blok yang tersedia: `store`, `tax`, `receipt`, `theme`, `pos` (dan `rbac` — lihat dokumen 04).
Dibaca lewat `GET /api/bootstrap` (`settings.*`) atau `GET /api/settings`, disimpan lewat `PUT /api/settings/:key`.

## 1. Profil toko (`store`) — permission `setting.store`

| Kunci | Default | Dipakai di |
|---|---|---|
| `name` | `Toko Saya` | header aplikasi, sidebar, baris pertama struk, laporan |
| `legal_name`, `address`, `phone`, `email`, `npwp` | kosong | struk (dapat disentuh per baris lewat `receipt.show`) |
| `timezone` | `Asia/Jakarta` | pelaporan harian (`date(created_at)` dihitung waktu server) |
| `currency` · `locale` | `IDR` · `id-ID` | format Rp di `client/src/lib/format.js` |
| `logo_data_url` | `null` | logo di layar & struk (UNGGAH lewat `POST /api/branding/logo`, hapus `DELETE /api/branding/logo`) |
| `invoice_prefix` | `INV` | nomor struk: `{prefix}{YYYYMMDD}-{nomor}` |

> Nama toko di layar memakai baris tabel `stores` sebagai sumber identitas (`store.name` pada respons
> `GET /api/bootstrap` = `stores.name`, blok settings hanya melengkapi), sehingga toko baru langsung menampilkan
> nama aslinya. Menyimpan blok `store` juga memperbarui tabel `stores` agar kedua tempat tidak berbeda.

**Logo.** `POST /api/branding/logo` menerima `data:image/(png|jpeg|jpg|svg+xml|webp);base64,…` sampai ±1 MB
(batas 1 500 000 karakter base64; body JSON dibatasi 12 MB) dan menyimpannya ke blok `theme` **dan** `store`
(sehingga aplikasi & struk sama-sama memakai gambar yang sama); `DELETE /api/branding/logo` mengosongkan keduanya.
Gunakan PNG persegi 1:1 ≥ 128 px.
Bila belum ada, aplikasi memakai inisial nama toko. SVG yang diunggah dari sumber tak dikenal berisiko XSS —
gunakan raster, atau bersihkan dulu.

## 2. Tema & tampilan (`theme`) — permission `setting.theme`

Panel **Pengaturan → Tampilan** menyimpan token berikut; `client/src/App.jsx` memetakannya ke CSS custom properties
di `document.documentElement` setiap kali setting berubah, jadi **pratinjau langsung terlihat** sebelum disimpan:

| Kunci | Default | Efek |
|---|---|---|
| `accent` · `accent_text` | `#f97316` · `#ffffff` | tombol primer, tautan, garis fokus, badge aktif |
| `success` · `danger` · `warning` | `#16a34a` · `#dc2626` · `#d97706` | status stok, error, peringatan |
| `surface` · `canvas` · `text` · `muted` · `border` | putih/abu netral | kartu, latar, teks, garis |
| `mode` | `light` | `light` \| `dark` \| `system` (dark = kelas `dark` di `<html>` + token `--canvas-*`) |
| `radius` | `12` | kelengkungan kartu/tombol (px) |
| `density` | `comfortable` | `compact` memangkas padding grid/tabel (penting di layar kasir kecil) |
| `font` | `system` | `system` \| `serif` \| `mono` \| `rounded` (tanpa unduhan font → tetap aman di jaringan lokal) |
| `sidebar_width` | `236` | lebar sidebar (px); di bawah 900 px otomatis jadi bilah atas |
| `bg_pattern` | `none` | `none` \| `dots` \| `grid` latar halus |
| `logo_data_url`, `app_name` | `null`, `Kasir` | logo & label aplikasi di header/login |

Palet siap pakai (8) — Kopi, Senja, Matcha, Navy, Daun, Cabai (terang) serta Malam & Grafit (gelap) — diambil dari
`GET /api/branding/palettes` (server) supaya layar lain bisa memakainya juga; tiap preset = satu set token warna lengkap.
`THEME_PRESETS` di `client/src/features/settings/theme.js` dipakai untuk pratinjau; daftar preset yang ditampilkan
dibaca dari server sehingga tinggal menambah entri `PRESETS` di `server/src/routes/settings.js` bila mau warna baru.

## 3. Susun menu & nama layar (`theme.menu`) — permission `setting.theme`

Menu sidebar adalah data, bukan kode:

```json
{ "key": "pos", "label": "Kasir", "icon": "🧾", "visible": true, "perm": "sale.create" }
```

Entri bawaan (urutan sama dengan `DEFAULTS.theme.menu`): `pos` (Kasir), `dashboard` (Dasbor), `stock` (Stok),
`items` (Barang), `purchase` (Pembelian), `sales` (Riwayat), `reports` (Laporan), `alerts` (Peringatan), `users` (User & Role), `settings` (Pengaturan).
Peran berbeda bisa melihat menu berbeda karena tiap entri membawa permission minimum; entri tanpa permission tidak pernah disembunyikan.

Panel **Pengaturan → Tampilan → susun menu** menyediakan naik/turun + sakelar *tampil*. Untuk membuat kunci baru:
(1) tambah entri di `DEFAULTS.theme.menu`; (2) tambah kasus di peta halaman `client/src/App.jsx`.
Untuk menyembunyikan sementara cukup `visible: false`. Simpan dengan `PUT /api/settings/theme`.
Rute **selalu dapat diakses** selama user punya permission-nya; perubahan urutan/label/ikon langsung berlaku di semua
perangkat (boot mengulang `GET /api/bootstrap`).

## 4. Pajak & layanan (`tax`) — permission `setting.tax`

| Kunci | Default | Arti |
|---|---|---|
| `enabled` | `true` | matikan untuk menghitung tanpa pajak sama sekali |
| `default_rate_pct` | `11` | persentase bila item tidak mengatur sendiri |
| `inclusive` | `false` | `true` = harga sudah termasuk pajak (pajak diurai dari harga) |
| `service_charge_pct` | `0` | biaya layanan, dihitung **setelah** diskon, sebelum pajak |
| `rounding_mode` · `rounding_step` | `nearest` · `1` | `none` \| `nearest` \| `up` \| `down`; mis. `nearest` + `500` untuk pembulatan Rp500 |
| `allow_negative_stock` | `false` | `true` mengizinkan stok minus (penjualan tidak ditolak) — **opname & produksi tetap boleh minus** |
| `consumption_window_days` | `14` | jendela rata-rata pemakaian bahan |
| `alert_lookahead_days` | `7` | horizon peringatan "akan habis" |

**Aturan per item** (bukan blok, tetapi tabel `taxes` + kolom `items.tax_mode`):
`taxes` = daftar pajak (nama, `rate_pct`, `is_inclusive`, `is_active`, `is_default`, `sort_order`), dikelola
**Pengaturan → Pajak & diskon** (`GET/POST/PUT/DELETE /api/taxes`).
Pada tiap barang: `tax_mode = inherit` (mengikuti `tax.default_rate_pct`), `exempt` (tidak dipajaki), atau
`override` + `tax_rate`. Contoh: roti & minuman kena 11 %, air mineral & jasa 0 %, layanan meja 5 % via `service_charge_pct`.
Urutan hitung: `subtotal → diskon per baris → diskon global → service → pajak → pembulatan → biaya metode bayar → total`.

## 5. Diskon khusus (`discounts`) — permission `setting.tax`

Tabel `discounts` = aturan yang bisa dihidupkan/matikan dari layar **Pengaturan → Pajak & diskon**:

| Kolom | Contoh | Arti |
|---|---|---|
| `kind` · `value` | `percent` · `10` | persen dari subtotal, atau `fixed` dengan nominal Rupiah |
| `applies_to` · `ref_ids` | `item` · `["itm…"]` | `global`, per `category`, atau per `item` |
| `trigger` | `auto_min_subtotal` | `manual` (kasir memilih), `auto_weekday`, `auto_time`, `auto_min_subtotal` |
| `days` | `[6,0]` | hari aktif (0 = Minggu … 6 = Sabtu), JSON array |
| `start_time` · `end_time` | `11:00` · `14:00` | jendela jam (pakai waktu server) |
| `min_subtotal` | `50000` | baru aktif bila subtotal ≥ nilai |
| `max_discount` | `20000` | batas nominal diskon |
| `stackable` | `0` | `0` = tidak boleh digabung (yang terbesar dipakai) |
| `valid_from` · `valid_to` | `2026-06-01` · `2026-06-30` | periode promosi |

Pencocokan dilakukan `priceCart` (`ruleMatches()` di `server/src/pricing.js`); transaksi menyimpan
`applied_discounts` (JSON aturan yang terpakai) supaya laporan dapat menjelaskan potongan mana yang bekerja.

## 6. Metode pembayaran (`payment_methods`) — permission `setting.payment`

Tabel `payment_methods` (bukan blok JSON): `name`, `kind` (`cash` \| `wallet` \| `qris` \| `debit` \| `credit` \| `transfer`),
`icon`, `service_fee_pct`, `is_enabled`, `is_default`, `sort_order`. Kelola di **Pengaturan → Metode pembayaran**
(`GET/POST/PUT/DELETE /api/payment-methods`).

* `service_fee_pct` menambah biaya pada total bayar (mis. QRIS 0,7 %) — dicatat di `transactions.fee_total`.
* `is_default` menjadi pilihan awal di modal pembayaran; `cash` otomatis mengisi uang diterima dengan total.
* Pembayaran gabungan: beberapa baris `transaction_payments` (tunai + QRIS) pada satu struk.
* Menghapus metode yang sudah dipakai transaksi lama tidak merusak struk: id di-`SET NULL` dan nama ada di snapshot.

## 7. Struk (`receipt`) — permission `setting.receipt`

| Kunci | Default | Fungsi |
|---|---|---|
| `header` · `subheader` | `Terima kasih telah berbelanja!` · `` | dua baris pembuka (teks bebas, `\\n` tidak didukung — satu baris) |
| `thank_you` · `footer` | `Ditunggu kunjungan berikutnya 🙏` · `Barang yang sudah dibeli tidak dapat dikembalikan` | penutup |
| `paper_width` | `58` | mm — lihat tabel kolom di bawah |
| `font_scale` | `1` | 0,70–1,60 (langkah 0,05) di panel pengaturan; dipetakan ke `font-size` saat cetak |
| `show` | objek boolean | sakelar per bagian yang benar-benar dipakai renderer: `logo, store_name, address, phone, npwp, invoice, date, cashier, items, discounts, tax, service, payment, change, social, footer` (baris pelanggan/tipe order muncul otomatis bila datanya ada) |
| `line_char` · `center_char` | `-` · `=` | pemisah & pemusatan |
| `social` | `@tokosaya` | baris media sosial (aktif bila `show.social`) |
| `custom_lines` | `[]` | `[{position:'top'\|'bottom', text:'…'}]` — baris bebas; placeholder `{{…}}` diisi otomatis (lihat daftar di bawah) |

Placeholder yang dikenal perender struk (`headVars`/`tailVars` di `client/src/features/receipt/receipt.jsx`,
Daftar sama dengan `variables` yang dikirim `POST /api/receipt/preview`):

| Untuk baris `top` | Tambahan untuk baris `bottom` |
|---|---|
| `{{store_name}} {{address}} {{phone}} {{npwp}} {{invoice}} {{date}} {{cashier}} {{customer}} {{footer}} {{thank_you}}` | `{{subtotal}} {{discount}} {{service}} {{tax}} {{rounding}} {{grand_total}} {{payment}} {{paid}} {{change}} {{items}}` |

Contoh: `text: "POIN ANDA: {{customer}}"` di `top`, atau `text: "Pajak {{tax}} dari {{grand_total}}"` di `bottom`.

`header` berperilaku sebagai baris pertama: bila terisi, teks itu yang dicetak (bukan nama toko);
`subheader` menyusul di bawahnya. Pilihan lebar kertas di panel: **58 · 65 · 72 · 80 mm · A4**
(A4 disimpan sebagai `paper_width: 240` untuk invoice).
Encode barcode & poin loyalitas **belum** dirender (kunci `barcode`/`points` sengaja dikeluarkan dari default agar tidak ada sakelar mati).

Lebar kertas → jumlah kolom karakter (didefinisikan `COLS` di `client/src/features/receipt/receipt.jsx`):

| `paper_width` (mm) | 58 | 60 | 65 | 72 | 76 | 80 | lainnya |
|---|---|---|---|---|---|---|---|
| kolom | 32 | 32 | 38 | 42 | 44 | 48 | 32 |

Nama barang panjang tidak membuat struk meluber: `twoCol()` memotong label (menyisakan nilai di kanan) lalu `wrap()`
menempelkan sisanya di baris baru; QA memeriksa baris terlebar tetap ≤ batas untuk 58/72/80/240 mm.
**Pratinjau** di Pengaturan → Struk: panel memanggil `POST /api/receipt/preview` (tidak menyimpan apa pun) yang
mengembalikan `receipt` hasil gabung + `store` + `theme` + `sample` (transaksi selesai terakhir beserta itemnya) +
`variables`; komponennya (`Receipt`) yang merender baris 32 kolom di layar, jadi yang Anda lihat adalah susunan
sebenarnya dengan data nyata, bukan perkiraan. Bila toko belum punya transaksi, `sample` kosong dan pratinjau memakai contoh di klien.
Menyimpan (Simpan) membuat perubahan berlaku untuk semua perangkat yang login ke toko itu.

## 8. Perilaku layar kasir (`pos`) — permission `setting.store`

| Kunci | Default | Arti |
|---|---|---|
| `quick_amounts` | `[10000, 20000, 50000, 100000]` | koin cepat di modal bayar — UI menampilkan total + nilai yang **lebih besar dari total** (nominal di bawah total tidak ditawarkan) |
| `fast_keys` | `[]` | *masih cadangan* — field ada di default tetapi layar kasir belum merender tombol pintasan |
| `default_order_type` | `dine_in` | nilai awal jenis pesanan (dijadikan `order_type` struk; aturan diskon saat ini tidak menyaring kanal) |
| `require_customer` | `false` | `true` = kasir wajib mengisi pelanggan sebelum bayar |
| `show_raw_preview` | `true` | tampilkan proyeksi potongan bahan + kapasitas porsi di keranjang |

## 9. Cara menyimpan & batasnya

* UI memakai `useBlock(key)` (`client/src/store.jsx`) → salinan dalam + `save(patch)`. Layar selalu mengirim blok utuh,
  jadi tidak ada sakelar yang hilang.
* **Otomasi/skrip**: `PUT /api/settings/:key` menggabungkan kunci tingkat atas dengan nilai tersimpan, **tetapi objek/array
  bersarang ditimpa penuh**. Jadi `{"receipt": {"footer": "…"}}` aman, sementara `{"show": {"logo": true}}` menghapus
  semua sakelar `show` lainnya. Bila ragu: `GET /api/settings` → ubah satu kunci → kirim blok lengkap (pola yang dipakai
  `server/scripts/qa-simulasi.js`).
* Audit: setiap penyimpanan menulis `audit_logs` (`setting.update.<key>`, `ip`, `before`, `after`).
* Perubahan berlaku untuk transaksi **berikutnya**; struk lama tetap memakai `receipt_snapshot`.
* Data tidak divalidasi skema JSON — nilai di luar rentang (mis. `rate_pct` 900) akan diproses apa adanya;
  karena itu UI memakai input numerik + batas atas, dan `save()` menolak pengiriman bila tidak ada perubahan.
