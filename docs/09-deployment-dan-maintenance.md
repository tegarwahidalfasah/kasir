# 09 — Deployment & jadwal pemeliharaan (Fase 4)

> **Status v0.1.0:** dokumen ini adalah *rencana* rilis beta — belum ada server produksi yang dipasang.
> Semua perintah di bawah sudah diuji di lingkungan pengembangan (Node 22.22, Linux) kecuali yang ditandai ✔️ di catatan QA.

## 1. Bentuk pemasangan yang disarankan

Satu mesin di toko (mini-PC / laptop lama / VPS kecil) sebagai **server kasir**, beberapa perangkat hanya membuka browser.

```
[tabelt/HP kasir] ──┐
[PC manajer] ───────┼── WiFi LAN ──► Node.js :4000 ──► /var/lib/kasir/kasir.db (SQLite, WAL)
[printer termal USB|jaringan] ─────┘        │
                                            └─► /api/branding/logo (data URL di DB)
```

Kenapa bukan DB server terpisah: muatan kasir UMKM (ratusan transaksi/hari, ±256 struk/detik tercapai saat QA) jauh di
bawah kemampuan SQLite, dan satu berkas DB = pencadangan & pemulihan yang sangat sederhana. Bila nanti ada >6 kasir
aktif serentak atau laporan berat, pindahkan ke PostgreSQL (lihat [01-arsitektur.md §7](01-arsitektur.md)).

| Spesifikasi | Minimum | Nyaman |
|---|---|---|
| OS | Linux (Ubuntu 22.04+/Debian 12), Windows 11 juga jalan | Linux + systemd |
| Node.js | **22.5+** (modul `node:sqlite`) | LTS 22.x terbaru |
| CPU / RAM | 1 core / 512 MB | 2 core / 2 GB |
| Disk | 1 GB + 2× ukuran DB untuk cadangan | SSD, 10 GB |
| Jaringan | IP statis/LAN tetap; port 4000 terbuka di LAN | + domain & TLS untuk akses luar |

## 2. Pemasangan pertama

```bash
# 1) kode
sudo mkdir -p /opt/kasir && sudo chown $USER /opt/kasir
git clone <repo> /opt/kasir && cd /opt/kasir && git checkout main && git pull

# 2) dependensi & build (hanya dependency runtime; tanpa native build)
npm ci --omit=dev --workspaces --include-workspace-root
npm run build                      # client/dist siap diserve oleh API

# 3) layanan & data
sudo useradd -r -s /usr/sbin/nologin kasir
sudo mkdir -p /var/lib/kasir /etc/kasir && sudo chown kasir:kasir /var/lib/kasir
sudo tee /etc/kasir/kasir.env >/dev/null <<'ENV'
PORT=4000
KASIR_DATA_DIR=/var/lib/kasir
KASIR_JWT_SECRET=<hasil: openssl rand -hex 32>
KASIR_TOKEN_TTL=43200              # 12 jam
NODE_ENV=production
ENV
sudo chmod 600 /etc/kasir/kasir.env

# 4) DB pertama. JANGAN jalankan "npm run seed" di produksi:
#    seed hanya mengisi contoh (akun budi/rina/sari/dewi + 328 transaksi).
#    Skema dibuat otomatis saat proses pertama start (initDb di server/src/index.js).
sudo -u kasir mkdir -p /var/lib/kasir

# 5) systemd
sudo cp ops/kasir.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now kasir
curl -s localhost:4000/api/health
```

Bila `ops/kasir.service` tidak dipakai, jalankan minimal dengan:
`PORT=4000 KASIR_DATA_DIR=/var/lib/kasir node server/src/index.js`.

## 3. Membuka ke banyak perangkat / ke luar jaringan

* **Hanya di LAN** (paling aman untuk v0.1): perangkat menunjuk `http://192.168.x.x:4000`. Belum ada TLS di aplikasi,
  jadi jangan expose port ini ke internet.
* **Akses luar**: pasang proxy TLS di depan :4000. Let's Encrypt tidak menerbitkan sertifikat untuk nama host
  `.local`/IP LAN, jadi butuh domain publik (mis. `kasir.tokoanda.com`). Contoh terpasang:
  [`ops/Caddyfile.example`](../ops/Caddyfile.example) (paling singkat — HTTPS otomatis) dan
  [`ops/nginx.example.conf`](../ops/nginx.example.conf) (bila nginx sudah ada). Aplikasi sudah mengirim
  `X-Forwarded-*` dengan benar (`app.set('trust proxy', true)`), dan pembatasan laju login per IP ikut bekerja lewat header itu.
* **Printer termal**: browser perangkat yang mencetak. Untuk printer jaringan 58 mm, driver ESC/POS tidak diperlukan
  karena struk dirender sebagai teks monospace + `window.print()`; atur `receipt.paper_width` = 58 dan matikan
  margin di dialog cetak. Alternatif: `cups-driver` + `lp -o raw` dari server (uji manual dulu).

## 4. Variabel lingkungan (semua opsional kecuali tertulis)

| Variabel | Default | Fungsi |
|---|---|---|
| `PORT` | `4000` | API + SPA |
| `KASIR_DATA_DIR` | `server/src/data` | **produksi: `/var/lib/kasir`** |
| `KASIR_DB_PATH` | `<KASIR_DATA_DIR>/kasir.db` | menimpa jalur DB sepenuhnya |
| `KASIR_JWT_SECRET` | dibuat otomatis (berkas `.jwt-secret`, mode 0600) | **produksi: wajib diisi** |
| `KASIR_TOKEN_TTL` | `43200` (12 jam) | umur sesi; layar kasir memanggil `POST /api/auth/refresh` |
| `KASIR_BACKUP_DIR` | `<KASIR_DATA_DIR>/backups` | tujuan cadangan `npm run backup` |
| `NODE_ENV` | — | `production` → pesan 5xx tidak dikirim ke klien |

## 5. Jadwal pemeliharaan yang disarankan

| Frekuensi | Kegiatan | Perintah / otomatis |
|---|---|---|
| **Setiap 5 menit** | cek layanan hidup | cron `*/5` → `ops/maintenance.sh health` (menulis ke log; pasang alert dari situ) |
| **Harian 02:15** | cadangan + verifikasi salinan | `npm run backup -- --verify --keep=14` (VACUUM INTO → `integrity_check` → rotasi) |
| **Harian (saat backup)** | salin ke penyimpanan luar | `rsync`/`rclone` `/var/lib/kasir/backups/…` (jangan simpan hanya di mesin yang sama) |
| **Mingguan Sab 03:00** | kompres + sinkron ledger | `npm run maintenance -- vacuum` lalu `POST /api/stock/reconcile` dari akun pemilik |
| **Mingguan** | tinjau peringatan & HPP | layar Peringatan + Laporan; `GET /api/stock/integrity` → `mismatches: []` |
| **Bulanan 1-nya 04:00** | **latih pemulihan** ke pangkalan sementara | lihat §6 langkah 4 |
| **Bulanan** | cek kapasitas disk & ukuran DB | `ops/maintenance.sh status` (menampilkan “ledger vs stok” + cadangan terakhir) |
| **Triwulanan** | audit hak akses | `GET /api/users`, `GET /api/roles`; cabut yang tidak dipakai; ganti kata sandi |
| **Sebelum rilis** | `npm run check && npm run test:qa` | 49 unit/integrasi + 28 smoke UI + 20 QA harus hijau |

`ops/maintenance.sh` adalah pembungkus tipis (kunci `flock` + log + notifikasi) di atas skrip
`server/scripts/{backup,maintenance}.js`; contoh cron ada di [`ops/crontab.example`](../ops/crontab.example).

## 6. Pemulihan (restore) & latihan pemulihan

1. **Hentikan layanan** (wajib — jangan menimpa DB yang sedang dipakai): `systemctl stop kasir`.
2. Buat salinan DB saat ini untuk jaga-jaga: skrip `restore` sudah melakukannya (`<db>.pre-restore-<waktu>`).
3. `npm run maintenance -- restore /var/lib/kasir/backups/kasir-<stamp>.sqlite --yes`
   — cadangan diverifikasi (`integrity_check` + `foreign_key_check`) **sebelum** menimpa; bila gagal, perintah berhenti.
4. **Latihan rutin** (bulanan): pulihkan cadangan terbaru ke DB sementara lalu uji
   `npm run seed` **tidak** diperlukan — cukup `npm run test:qa -- --api=http://127.0.0.1:<port>` terhadap server yang memakai DB hasil
   pemulihan, dan buka 1 struk lama untuk memastikan `receipt_snapshot` terbaca.
5. Nyalakan kembali, cek `GET /api/health` (jumlah `sales`/`movements` harus sama seperti sebelum mati) dan login 1x.

Kegagalan yang mungkin & tindak lanjut: “`integrity_check` gagal” → ambil cadangan sehari sebelumnya;
“baris tidak cocok saat verifikasi” → transaksi masih berjalan saat backup, jalankan ulang di luar jam sibuk;
“lupa `KASIR_JWT_SECRET`” → tidak masalah untuk data, hanya semua sesi login ulang (ganti secret baru).

## 7. Prosedur rilis (upgrade versi)

```bash
cd /opt/kasir
npm run backup -- --verify --name=pra-upgrade          # (1) cadangan + verifikasi
systemctl stop kasir
git fetch && git log --oneline HEAD..origin/main        # (2) baca yang berubah
git pull --ff-only
npm ci --omit=dev --workspaces --include-workspace-root && npm run build   # (3)
systemctl start kasir                                       # (4) skema dibuat/diperbarui saat start
curl -s localhost:4000/api/health                       # (5) counts naik, tidak 500
```

1. **Selalu** backup sebelum menyentuh produksi.
2. Skema SQLite **tidak** dimigrasikan otomatis selain `CREATE … IF NOT EXISTS`; kolom baru perlu `ALTER TABLE` eksplisit
   (kebijakan: [02-skema-data.md §9](02-skema-data.md)). Karena itu rilis yang mengubah skema mencantumkan langkah `ALTER`
   di CHANGELOG, dan menjalankannya di DB **salinan** lebih dulu (`npm run maintenance -- restore …` ke pangkalan sementara).
3. Jam rilis untuk toko retail: **setelah tutup – sebelum subuh** (mis. 22:30–04:00) + pengumuman H-1.
4. Rollback < 5 menit: `git checkout <tag sebelumnya> && npm ci --omit=dev && npm run build && systemctl restart kasir`;
   kalau DB sudah ikut berubah → pulihkan cadangan `pra-upgrade` (§6 langkah 1–3).
5. Verifikasi pascarilis (kasir nyata, 3 menit): login → 1 transaksi + struk tercetak → cek stok terpotong → 1 pembatalan
   → `GET /api/stock/integrity` → `mismatches: []` → buka laporan hari ini.

## 8. Pemantauan & ambang batas

| Yang dipantau | Cara | Ambang → tindakan |
|---|---|---|
| Proses & jawaban API | `maintenance.sh health` / `curl /api/health` | 2 kegagalan berturut → aktifkan layanan; 5 → panggil penanggung jawab, kasir pakai struk manual |
| Ukuran DB & laju tumbuh | `maintenance.sh status` | tumbuh > 2× rata-rata mingguan → cek `audit_logs`/`stock_movements` (jalankan `prune`) |
| Ruang disk | `status` menampilkan sisa GB | < 1 GB → hapus cadangan lama (`--keep` lebih kecil), `vacuum` |
| Konsistensi stok | `GET /api/stock/integrity` | `mismatches` ≠ 0 → jalankan `POST /api/stock/reconcile`, lalu cocokkan fisik (opname) |
| Stok kritis | layar Peringatan / badge sidebar | item `out` saat jam ramai → PO kilat (`POST /api/purchase-orders` + `…/receive`) |
| Log sistem | `journalctl -u kasir --since "-1h"` | `[error]` berulang → simpan potongannya, laporkan sebagai issue |
| Keamanan | `GET /api/audit?entity=settings` | perubahan `setting.update.*` di luar jam kerja → ganti kata sandi & tinjau siapa login |

Catatan: log aplikasi ke **journald** (`StandardOutput=journal`); jangan `console.log` data transaksi di production.
Tidak ada telemetri keluar — tidak ada panggilan ke layanan pihak ketiga di kode.

## 9. Checklist pra-rilis beta (ringkas, lihat juga [10-rilis-beta.md](10-rilis-beta.md))

* [ ] `npm run check && npm run test:qa` hijau di mesin target (bukan hanya di mesin pengembang).
* [ ] `KASIR_JWT_SECRET` diisi; `.jwt-secret` tidak ikut ke git; `chmod 600 /etc/kasir/kasir.env`.
* [ ] Akun demo (`budi/rina/sari/dewi`) **dihapus atau dinonaktifkan**, kata sandi pemilik diganti.
* [ ] `GET /api/stock/integrity` → 0; cadangan harian berjalan + pernah **dipulihkan sekali**.
* [ ] Pengaturan toko (pajak, struk 58 mm, metode bayar, tema) diisi lewat panel, bukan edit DB.
* [ ] Printer teruji cetak 1 struk 3 baris + 1 struk 20 baris (cek tidak meluber di lebar yang dipakai).
* [ ] Prosedur rollback dibaca & disetujui 1 orang selain installer.
* [ ] Jam rilis disepakati; ada kanal pelaporan bug (WhatsApp/grup) + penanggung jawab.
