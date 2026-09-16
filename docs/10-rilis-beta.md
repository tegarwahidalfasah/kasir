# 10 — Rencana rilis beta ke pengguna awal (Fase 4)

Target: **5–8 toko** (UMKM F&B yang punya produksi sendiri: ked kopi, bakery, kantin, catu) memakai aplikasi
selama **4 minggu**, dengan 1 pendampingan per toko. Keluaran yang diharapkan: keputusan go untuk v0.2 + daftar perbaikan.

## 1. Yang dibuka untuk beta vs yang ditahan

| Termasuk beta | Belum (v0.2+) |
|---|---|
| Kasir, keranjang, addon/topping, pembayaran (tunai/QRIS/kartu), struk 58/72/80 mm & cetak ulang | Mode luring (offline-first) & antrean tulis ulang |
| Stok real-time + BOM (bahan baku), kapasitas porsi, produksi MTS | Multi-gudang / stok terpisah per rak |
| RBAC 5 peran + sunting permission, PIN kasir, log audit | SSO/SCIM, 2FA, kebijakan sandi per perusahaan |
| Peringatan stok menipis + rekomendasi pembelian, PO & terima barang, opname | Integrasi e-Faktur/POS pajak resmi, integrasi marketplace |
| Laporan: penjualan harian, per jam, produk, kasir, metode bayar; pergerakan stok; pemakaian bahan & estimasi habis; valuasi persediaan; ekspor CSV | Laporan berjadwal (email), BI/kustom query builder |
| Kustomisasi tema, logo, urutan menu, blok teks struk, pajak & diskon dinamis, metode pembayaran | Desainer struk visual drag-and-drop, lebih dari 1 layout per toko |
| Cadangan harian `VACUUM INTO` + verifikasi + restore (CLI & endpoint) | enkripsi DB at-rest, point-in-time recovery (WAL replay) |

## 2. Kriteria penerimaan beta (harus terpenuhi sebelum toko pertama masuk)

Sudah terpenuhi per 16 Sep 2026 (lihat [08-qa-simulasi.md](08-qa-simulasi.md)):

- [x] 49 unit/integrasi backend hijau (`npm test`), termasuk uji isolasi antar toko & race 120 request.
- [x] 20/20 QA transaksi massal hijau — 400/400 struk, selisih BOM 0.0000, void mengembalikan seluruh stok, idempoten, tidak ada kebocoran kolom rahasia.
- [x] 28 smoke UI hijau — 11 tampilan, alur bayar ↔ ledger ↔ stok, tema tersimpan, struk tidak meluber di 4 lebar kertas.
- [x] Alat cadangan/pemulihan tersedia (`npm run backup`, `npm run maintenance -- status|verify|restore|prune|vacuum|health`).

Belum (harus selesai sebelum undangan dikirim):

- [ ] Pemasangan nyata di 1 mesin produksi (bukan kontainer) + catatan langkahnya (dok 09 §2) → penanggung jawab: installer.
- [ ] Latihan pemulihan dari cadangan penuh sekali, durasi tercatat.
- [ ] Uji cetak pada 3 printer termal nyata (58 mm) + 1 printer A4; pastikan tidak meluber.
- [ ] Kata sandi akun seed diganti/dinonaktifkan untuk pengguna beta (dok 09 §9).
- [ ] `KASIR_JWT_SECRET` produksi + `NODE_ENV=production` + proxy TLS (bila akses keluar LAN).
- [ ] Formulir umpan balik & kanal darurat (nomor WA penanggap) disepakati, SLA tanggapan ≤ 4 jam kerja.

## 3. Gelombang & jadwal

| Minggu | Peserta | Fokus | Keluaran |
|---|---|---|---|
| **0** | internal (1 kasir + 1 manajer di 1 toko percontohan) | alur penuh sehari: buka–produksi–transaksi–tutup–opname | daftar kejangalan UI, log `journalctl`, angka stok akhir hari |
| **1–2** | 3 toko (kopi & roti) | kasir + stok BOM + peringatan | jumlah transaksi/hari, keluhan utama, akurasi stok pasca-opname |
| **3–4** | 5 toko (tambah kantin/catu) | laporan + kustomisasi (pajak, diskon, struk, tema) + PO | pemakaian fitur per layar, 1 laporan yang dipakai owner |
| **5** | — | evaluasi & triase | keputusan: go v0.2 / perpanjang beta / hentikan |

Batas peserta per gelombang: 8 toko. Kapasitas diuji QA: 256 struk/detik pada satu proses (jauh di atas kebutuhan UMKM),
sehingga penahannya adalah dukungan manusia, bukan teknis.

## 4. Onboarding toko baru (±90 menit)

1. Pasang (dok 09 §2) atau sambungkan ke instance bersama; set `KASIR_DATA_DIR` milik toko.
2. Login pemilik → **Pengaturan → Toko** (nama, alamat, logo, prefiks struk) → **Tampilan** (palet/menu) → **Struk** (58 mm + teks).
3. **Barang**: impor bahan baku + HPP + satuan + titik pesan ulang; lalu barang jadi + harga + **resep** (BOM) — minimal 10 produk dulu.
4. **Stok**: **Opname** semua bahan (stok fisik hari itu). Ini angka awal yang sah; jangan lewat `UPDATE`.
5. **User & role**: buat akun kasir + PIN, nonaktifkan akun demo.
6. **Pembelian**: isi pemasok + lead time (menentukan rekomendasi pembelian otomatis).
7. Uji: 3 transaksi nyata + 1 pembatalan → cek **Riwayat**, **Pergerakan stok**, dan cetak struk.
8. Setel cron cadangan (§5 dok 09) dan tunjukkan 1x cara memulihkan di DB sementara.
9. Sepakati jam tenang: perubahan konfigurasi besar dilakukan setelah tutup.

## 5. Umpan balik & metrik yang dikumpulkan

Metrik diambil dari aplikasi (CSV/`/api/reports/*`) + isian pendamping, **tanpa telemetri keluar** (aplikasi tidak mengirim apa pun
ke luar). Yang dicatat mingguan:

| Metrik | Sumber | Sehat |
|---|---|---|
| Transaksi/hari per toko | `GET /api/reports/summary` → `by_day[].tx_count` | ≥ 20 (kurang dari itu datanya terlalu tipis untuk menilai) |
| Gagal simpan transaksi (409/500) | log `journalctl` + `GET /api/audit` | 409 wajar (stok habis), 500 harus 0 |
| Akurasi stok akhir hari | Δ(stok sistem − opname) per bahan | \|Δ\| ≤ 2 % pemakaian harian |
| Waktu rata-rata 1 transaksi | jam sibuk (`/api/reports/summary` → `by_hour`) + kuesioner | < 45 s per pelanggan di antrean |
| Peringatan terbaca vs tidak | `GET /api/alerts` | rasio baca naik → peringatan berguna |
| Struk dicetak vs batal cetak | kuesioner kasir | tidak ada keluhan meluber/terpotong |
| Keluhan masuk & status | lembar triase (spreadsheet/lms toko) | 100 % terkategorikan tiap Jumat |

Kanal: grup WhatsApp per toko (harian) + formulir 6 pertanyaan (mingguan) + panggilan 30 menit (akhir gelombang).

## 6. Triase & tingkatan

| Level | Contoh | Tanggapan |
|---|---|---|
| **P0** | uang/stok salah tercatat; aplikasi tidak bisa dipakai; kehilangan data | kerja < 30 menit, perbaikan + pemulihan dari cadangan; tulis di `CHANGELOG.md` |
| **P1** | fitur utama berjalan tapi menyebalkan (cetak meluber, modal macet) | perbaikan < 3 hari |
| **P2** | laporan/UX minor, permintaan fitur | masuk backlog v0.2, dievaluasi tiap Jumat |

Setiap P0/P1 wajib diulang di **mesin pengembang** lebih dulu; perbaikan disertai tes (`server/tests/*` atau
`client/tests/ui-smoke.entry.jsx`) agar tidak muncul lagi — pola ini sudah terbukti di QA (§“Temuan QA yang berujung perbaikan kode”).

## 7. Keputusan akhir beta

Rilis **go** bila semuanya terpenuhi: 0 insiden P0 data (stok/uang salah), akurasi stok ≥ 98 %, seluruh toko
menyelesaikan satu hari operasional tanpa bantuan, cadangan terbukti bisa dipulihkan, dan ≥ 70 % peserta memilih “lanjut”.
Bila akurasi stok atau pencetakan belum meyakinkan → perpanjang beta 2 minggu dengan hanya 2 toko, dan tambahkan
tes otomatis untuk kasus yang gagal (bukan memperbaiki manual di DB).

Setelah go: tandai `v0.2.0-beta.N` per rilis, tulis `CHANGELOG.md`, umumkan perubahan yang menyentuh pengaturan/struk
(seperti `PUT /api/settings/:key` yang bersifat replace) karena otomatisasi pengguna bisa terpengaruh.
