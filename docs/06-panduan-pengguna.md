# 06 — Panduan pengguna & SOP per peran (Fase 2–3)

Istilah di bawah sama dengan label tombol di layar. Menu bisa disembunyikan/diurutkan (doc 05 §3): bila sebuah entri
tidak muncul, peran Anda tidak punya permission-nya atau entri itu sedang disembunyikan di panel tampilan.

## 0. Menyiapkan toko (sekali, oleh pemilik/admin)

1. **Pengaturan → Toko**: nama, alamat, telepon, NPWP, prefiks nomor struk (`KS` → struk `KS20260916-1042`), unggah logo.
2. **Pengaturan → Pajak & diskon**: aktif/nonaktif pajak, tarif baku, harga sudah termasuk pajak atau belum, biaya layanan,
   aturan pembulatan; lalu buat aturan diskon (happy hour, minimal belanja, hari tertentu).
3. **Pengaturan → Metode pembayaran**: Tunai/QRIS/kartu + biaya layanan per metode; tentukan metode default.
4. **Pengaturan → Struk**: lebar kertas (58/65/72/80 mm atau A4), baris pembuka/penutup, baris kustom (`{{invoice}}`),
   bagian yang ditampilkan; gunakan panel **Pratinjau** — setelah **Simpan**, semua perangkat toko ikut berubah.
5. **Pengaturan → Tampilan**: palet, logo, nama aplikasi, kerapatan, lebar sidebar, susun menu.
6. **Barang**: buat bahan baku (satuan, harga pokok, titik pesan ulang, lead time, pemasok), lalu barang jadi + **resep**
   (rumus di [03-stok-dan-bom.md](03-stok-dan-bom.md) §2) + addon/topping bila ada.
7. **Stok awal**: catat lewat **Stok → Opname** (bukan mengedit angka di form barang) supaya ada jejak di ledger.
8. **User & role**: buat akun kasir + **PIN** 4 digit untuk oper shift; sesuaikan matriks permission bila perlu.

## 1. Kasir — transaksi harian (`sale.create`, `sale.hold`)

Layar **Kasir**:

1. Cari lewat kolom `Cari barang / scan barcode…` (pemindai barcode bekerja karena input ini menerima ketikan cepat),
   atau ketuk kartu barang. Kartu produk menampilkan kapasitas yang masih bisa dilayani, mis. `maks 229`.
2. **⚙ Pilihan** pada baris keranjang: addon/topping + diskon baris. **👤** untuk nama pelanggan & tipe pesanan.
3. Panel keranjang menampilkan **proyeksi potongan bahan** (mis. `2 pcs Dough Croissant Beku · 25.2 gr Mentega Tawar`).
   Bila bahan tidak cukup, tombol **Bayar** otomatis tidak aktif.
4. **Bayar** → pilih metode → untuk tunai, **Uang diterima** terisi total (tombol cepat 10rb/20rb/50rb/100rb), kembalian dihitung.
5. Struk tampil: simpan/cetak lewat dialog cetak peramban, atau kirim tautan struk. Layout mengikuti snapshot saat transaksi dibuat.
6. **⏸ Tahan** menyimpan order (mis. pelanggan lupa dompet); daftar order tertahan ada di layar yang sama, dan bisa
   dilanjutkan atau dihapus (**✕**).
7. Oper shift: kasir lain masuk dengan **PIN**-nya sendiri — jangan bagikan kata sandi.

Koreksi:
* Sebelum bayar → hapus baris di keranjang, atau **Kosongkan** (dengan konfirmasi).
* Sudah terbayar → **Riwayat** → buka struk → **Cetak ulang**, **Batalkan** (semua stok & bahan kembali, status jadi `voided`),
  atau **Retur** sebagian per baris (jumlah proporsional). Kasir biasa tidak punya `sale.void` → tombol tidak muncul,
  dan percobaan lewat API ditolak **403**.

## 2. Manajer inventaris (`stock.*`, `item.manage`, `recipe.manage`)

Layar **Stok**: daftar bahan & barang jadi dengan status (aman / menipis / kritis / habis), sisa hari perkiraan habis,
kapasitas porsi, dan nilai stok. Aksi per baris:

| Aksi | Kegunaan |
|---|---|
| **Opname** | isi jumlah hasil hitung fisik → selisih tercatat sebagai `adjustment`; sistem langsung memindai ulang peringatan |
| **Produksi** | catat barang jadi yang baru dibuat → `production_in`; bahan terpotong sesuai resep × yield |
| **Terima** | penerimaan barang kilat untuk bahan yang menipis (bisa juga lewat PO) |
| **Pergerakan** | ledger item: masuk/keluar, siapa, kapan, keterangan — jawaban untuk “kok berkurang?” |
| **⋯ → Integritas ledger** | periksa `stok vs Σ ledger`; jalankan **Rekonsiliasi ledger** bila ada selisih (butuh `system.maintenance`) |

Layar **Barang**: tambah/sunting item, kategori, HPP, pajak per item, satuan, **resep**, addon, dan **Simulasi**
("kalau 1 porsi terjual, bahan apa yang terpotong?"). Menghapus barang yang sudah pernah terjual = **dinonaktifkan**
(`soft_deleted: true`) supaya riwayat & resep tetap utuh. Bahan yang masih dipakai produk (kolom *dipakai di*) tidak
sebaiknya dihapus nonaktifkan dulu.

Layar **Pembelian**: buat PO (pemasok → baris barang → qty → harga satuan), status `draft`/`ordered`,
lalu **Terima** (bisa sebagian → `partial`; lengkap → `received`) atau **Batalkan**. Menerima PO menaikkan stok bahan
**dan** menghitung HPP rata-rata bergerak.

Layar **Peringatan**: daftar risiko habis + rekomendasi pembelian (`GET /api/alerts/replenish`) lengkap dengan
jumlah yang disarankan. Tombol **Tandai terbaca** menutup semua; tiap baris punya **Tandai** sendiri.
Sistem mencatat: peringatan baru dibuat otomatis tiap transaksi & penerimaan barang, dideduplikasi 6 jam per item.

## 3. Manajer / pemilik — pengawasan (`report.view`, `setting.*`)

* **Dasbor**: penjualan hari ini, tren, bahan menipis, transaksi terakhir, pintasan `Laporan lengkap →` dan `Buka pusat peringatan →`.
* **Laporan**: tab Penjualan / Pergerakan stok / Pemakaian bahan / Valuasi persediaan; rentang tanggal (default 30 hari);
  unduh **⬇ CSV** memakai hak `report.export`. Perkiraan kehabisan memakai jendela pemakaian 14 hari
  (`tax.consumption_window_days`) — minggu pertama datanya masih tipis, jangan buru-buru menyalah angkanya.
* **Riwayat transaksi** (`/sales`): filter status/tanggal/kasir, pencarian, detail struk, cetak ulang, batalkan, retur.
* **User & role**: buat/nonaktifkan user, reset kata sandi, atur PIN, sunting **matriks permission** per peran
  (berlaku seketika, tanpa restart), dan **Log audit** (`aksi · entitas · sebelum/sesudah · IP`, maks 300 baris per permintaan).

## 4. Rutinitas harian (SOP)

| Waktu | Siapa | Kegiatan |
|---|---|---|
| Buka toko | Kasir | Masuk dengan PIN → cek **Peringatan** → opname cepat bahan pokok → lihat kapasitas produksi hari ini (kartu produk) |
| Shift berjalan | Kasir | Transaksi; setiap penolakan stok dilaporkan ke manajer, jangan mematikan validasi |
| Tutup shift | Kasir | Selesaikan/clear order tertahan, rekap penjualan sendiri (Riwayat → filter kasir), setor uang |
| Tutup toko | Manajer inventaris | Opname bahan pokok (kopi, susu, gula) → sinkronkan selisih; buat PO untuk yang di bawah reorder point; catat **Produksi** untuk besok |
| Mingguan | Manajer/pemilik | Laporan 7 hari + valuasi persediaan; tinjau aturan diskon yang tak pernah terpakai; pastikan integritas ledger = 0 selisih |
| Bulanan | Pemilik | Latihan pemulihan dari cadangan (doc 09), tinjau matriks permission, ganti kata sandi |

## 5. Pertanyaan yang paling mungkin muncul

* **“Stok barang jadi tidak berkurang, kenapa?”** Produk itu `make_to_order`: yang berkurang **bahannya**
  (buka **Pergerakan** barang jadi untuk melihat `sale_out`/`bom_consume`). Stok jadi hanya dipakai bila tersedia lebih dulu.
* **“Kenapa transaksi ditolak 409 padahal stok kelihatan ada?”** Validasi memakai agregat seluruh baris keranjang +
  kapasitas bahan. Cek proyeksi di keranjang, atau jalankan **Barang → Simulasi** untuk angka persisnya.
* **“Saya ubah tarif pajak, struk kemarin ikut berubah?”** Tidak. Struk memakai `receipt_snapshot` milik saat transaksi.
* **“Kasir bisa melihat harga pokok?”** Katalog mengirim `selling_price` dan `cost_price`; untuk menyembunyikan HPP dari layar
  kasir, keluarkan field dari daftar kolom SELECT di `server/src/routes/auth.js` (jalur bootstrap) — jangan lewat role.
* **“Salah ketik HPP bahan, efeknya ke mana?”** Ke valuasi persediaan dan HPP transaksi berikutnya; struk lama tidak berubah
  (sudah tersimpan sebagai `cost_snapshot`).
* **“Printer tidak mengeluarkan struk”** Pastikan lebar kertas di **Pengaturan → Struk** sama dengan printer (umumnya 58 mm),
  pilih printer termal di dialog cetak, jangan “Save as PDF”, dan matikan margin di dialog peramban.
* **“Internet mati, bisa terus melayani?”** Yang dibutuhkan hanya koneksi ke **server aplikasi di toko** (API + DB lokal).
  Gangguan internet luar tidak menghentikan transaksi; hanya kirim struk PDF/WhatsApp dan pemantauan jarak jauh yang terganggu.
* **“Perubahan stok manual di database, boleh?”** Jangan. Ledger adalah sumber kebenaran — gunakan **Opname**
  (atau `POST /api/stock/adjust`) supaya perubahannya tercatat, teraudit, dan tidak membuat integritas gagal.
