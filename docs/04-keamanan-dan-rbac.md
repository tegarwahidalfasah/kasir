# 04 — Keamanan, sesi & RBAC (Fase 2)

## 1. Model ancaman yang dipatok

Aplikasi kasir dipakai di jaringan toko (WiFi lokal, tablet bersama, printer termal USB) dan kadang dibuka dari luar.
Ancaman yang dijaga di v0.1.0:

| Ancaman | Perlindungan |
|---|---|
| Aksi kasir melewati hak aksesnya | `requirePerm()` di setiap rute tulis; permission per peran tersimpan per toko |
| Transaksi ganda karena tombol ditekan dua kali / koneksi putus | kunci idempotensi `transactions.external_ref` UNIQUE + `POST /api/sales` mengembalikan struk lama |
| Data stok dirusak lewat API langsung | tidak ada endpoint "ubah stok_qty"; semua perubahan lewat ledger + permission `stock.adjust` |
| Rekaman transaksi berubah setelah pengaturan diedit | `receipt_snapshot` per struk; item menyimpan `name_snapshot`, `unit_price`, `cost_snapshot` |
| Percobaan tebak kata sandi | `loginGuard` → `tooManyAttempts(ip)`: 5 percobaan / 60 detik per IP (in-memory), balas 429 |
| Token curian dipakai selamanya | token berumur (default 12 jam) + `POST /api/auth/refresh` untuk perpanjangan sadar-sesi |
| Bocor kolom sensitif ke klien | katalog & `publicUser()` hanya memilih kolom yang diperlukan; tidak ada `password_hash`/`pin` di respons mana pun (diperiksa `server/scripts/qa-simulasi.js` §4) |
| Data toko A terbaca di toko B | `req.storeId` diambil dari user di token, dan **setiap** query menyertakan `store_id = ?` |
| jejak aksi hilang saat sengketa | `audit_logs` (aksi, entitas, sebelum/sesudah, IP) |

## 2. Sesi & token

`server/src/auth.js` (tanpa dependensi eksternal):

* **Kata sandi**: `crypto.scryptSync` + salt acak 16 byte, disimpan `s2:<salt>:<hash>`; perbandingan `timingSafeEqual`.
* **PIN kasir** (kolom `users.pin`) memakai format yang sama — login menerima password **atau** PIN (`authenticate()` mencoba keduanya).
* **Token**: JWT HS256 dibentuk manual (`header.payload.signature`, base64url). Payload `{ uid, role, sid, iat, exp }`.
  Verifikasi: panjang & `timingSafeEqual` pada signature, lalu `exp`. Tidak ada sesi di DB → token tidak dapat dicabut satu per satu;
  untuk memutus akses orang, **nonaktifkan user** (`users.is_active = 0`) karena `authenticate` membaca ulang baris user setiap permintaan.
* **Rahasia**: `KASIR_JWT_SECRET`; bila kosong, dibuat acak 32 byte dan disimpan di `server/src/data/.jwt-secret` (mode `0600`).
  Berkas ini tidak masuk git dan tidak boleh hilang (bila hilang, semua sesi login kembali).
* **Token hanya lewat header** `Authorization: Bearer …`. Fallback `?token=` di query string sudah dihapus
  (token di URL tertinggal di log proxy & riwayat peramban).
* **Header keamanan** dipasang di `server/src/index.js`: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
  dan CSP: `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors *`
  (`data:` perlu untuk logo & struk; `unsafe-inline` untuk gaya yang disuntik tema).

## 3. RBAC

20 permission (`PERMISSIONS` di `server/src/rbac.js`) dikelompokkan per area, dan 5 peran preset:

| permission | grup | owner/admin | manager | inventory (Manajer Inventaris) | cashier (Kasir) |
|---|---|:--:|:--:|:--:|:--:|
| `sale.create` | Kasir | ✔ | ✔ | · | ✔ |
| `sale.void` | Kasir | ✔ | ✔ | · | · |
| `sale.hold` | Kasir | ✔ | ✔ | · | ✔ |
| `item.view` | Inventaris | ✔ | ✔ | ✔ | ✔ |
| `item.manage` | Inventaris | ✔ | ✔ | ✔ | · |
| `recipe.manage` | Inventaris | ✔ | ✔ | ✔ | · |
| `stock.view` | Inventaris | ✔ | ✔ | ✔ | ✔ |
| `stock.adjust` | Inventaris | ✔ | ✔ | ✔ | · |
| `stock.purchase` | Inventaris | ✔ | ✔ | ✔ | · |
| `stock.produce` | Inventaris | ✔ | ✔ | ✔ | · |
| `report.view` | Laporan | ✔ | ✔ | ✔ | · |
| `report.export` | Laporan | ✔ | ✔ | · | · |
| `setting.store` | Pengaturan | ✔ | ✔ | · | · |
| `setting.tax` | Pengaturan | ✔ | ✔ | · | · |
| `setting.payment` | Pengaturan | ✔ | ✔ | · | · |
| `setting.receipt` | Pengaturan | ✔ | ✔ | · | · |
| `setting.theme` | Pengaturan | ✔ | ✔ | · | · |
| `user.manage` | Admin | ✔ | · | · | · |
| `role.manage` | Admin | ✔ | · | · | · |
| `system.maintenance` | Admin | ✔ | · | · | · |

* `manager` juga punya `setting.*` (kecuali `user.manage`/`role.manage`) — sesuai roadmap “manajer inventaris & admin”;
  bila ingin peran manajer tidak menyentuh pengaturan, sunting matriksnya (lihat di bawah).
* Matriks per toko disimpan di `settings` key `rbac` dan di-*seed* dari preset saat DB baru.
  UI: **User & role → matriks peran** (grid permission × peran) → `PUT /api/roles/:role` `{permissions:[…]}`.
  `POST /api/roles/reset` mengembalikan preset. Karena matriks dibaca setiap permintaan, **perubahan berlaku tanpa restart**.
* Rute yang butuh role-level: `PUT /api/roles/:role` dan `POST /api/roles/reset` (`role.manage`), `GET /api/audit` (`role.manage` atau `system.maintenance`).
* Rute dengan pilihan banyak permission memakai OR: `GET /api/users` (`user.manage`|`role.manage`),
  `GET /api/branding/palettes` (`setting.theme`|`setting.store`), `GET /api/alerts/replenish` (`stock.purchase`|`stock.view`).
* **Perluat tambahan (per-rute, bukan per-middleware)** yang sudah dipakai: `setting.*` (blok mana yang boleh diubah menentukan permission),
  `report.export` untuk unduh CSV, `system.maintenance` untuk integritas/rekonsiliasi/cadangan.
* **Larangan lintas toko**: `GET /api/users/:id` dsb. tidak ada; semua lookup memakai `WHERE id = ? AND store_id = ?`
  → 404, bukan 403, supaya tidak membocorkan keberadaan id milik tenant lain.
* **Perubahan peran & password dicatat**: `audit_logs` (`user.create`, `user.update`, `user.password`, `role.update`) dan dapat diunduh (lihat §6).
  `GET /api/audit?user_id=&entity=&limit=` tersedia di router users (limit dibatasi 300 baris per permintaan).
  **`GET /api/users` TIDAK menyaring `?branch_id=`** — daftar user selalu seluruh toko; gunakan filter di layar.

## 4. Detail implementasi otorisasi

```js
// server/src/middleware/index.js
export function authenticate(req, res, next) {
  if (isPublic(req.originalUrl || req.url)) return next();   // '/auth/login', '/public/brand', '/health', '/openapi.json'
  const payload = verifyToken(tokenDariHeader);
  if (!payload) return next(new AppError(401, …));
  const user = firstRow(`SELECT … FROM users WHERE id = ?`, payload.uid);
  if (!user || !user.is_active) return next(new AppError(401, 'Akun tidak aktif'));
  req.user = user; req.storeId = user.store_id || …; req.branchId = user.branch_id;
  req.permissions = permissionsFor(user.role, loadRoleMatrix(loadSetting, req.storeId));
}
export const requirePerm = (perm) => (req, _res, next) => …;   // 403 “Butuh hak akses: x”
```

Yang perlu diketahui siapa pun yang menambah rute:

1. `api.use(authenticate)` dipasang di `server/src/routes/index.js` sebelum semua router → **default-deny**: rute baru otomatis
   ikut terlindungi. `isPublic()` hanya mengenal 4 prefiks (`/api/auth/login`, `/api/public/brand`, `/api/health`, `/api/openapi.json`).
   Guard per-rute `auth([...])` tetap ada (idempoten: `authenticate` langsung `next()` bila `req.user` sudah terisi),
   sehingga permission spesifik tetap dievaluasi di tempatnya.
2. Setiap handler memakai pembungkus `http()` (`server/src/lib/http.js`) supaya `Promise` yang reject berubah menjadi JSON 500, bukan koneksi menggantung.
3. `AppError(status, message, details)` adalah cara satu-satunya mengirim error bermakna; error tak dikenal → 500 dan,
   di `NODE_ENV=production`, pesannya **tidak** dikirim ke klien (hanya `Terjadi kesalahan pada server`), tetap tercatat di log.
4. Batas body `express.json({ limit: '12mb' })` (logo base64 di `POST /api/branding/logo`).
5. Tidak ada `csrf` token: sesi memakai header (bukan cookie) sehingga CSRF lintas-situs tidak berlaku;
   **bila nanti memindahkan sesi ke cookie**, pasang CSRF guard + `SameSite=Strict`.

## 5. Audit trail

`audit({ userId, role, action, entity, entityId, before, after, storeId, ip })` (`server/src/auth.js`) menulis `audit_logs`.
Cara membacanya: layar **User & role → Log audit** (`GET /api/audit?user_id=&entity=&limit=`)
atau `SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50` melalui skrip Node.
Aksi yang benar-benar dicatat (dari `grep action:` di `server/src`):
`auth.login`, `auth.password_change`, `item.create`, `item.update`, `item.delete`, `recipe.update`,
`sale.create`, `sale.void`, `sale.refund`, `stock.adjust`, `stock.produce`, `po.create`, `po.receive`,
`setting.update.<key>`, `branding.logo`, `backup.download`, `user.create`, `user.update`, `user.delete`, `role.update`, `alert.dismiss`.
`before`/`after` disimpan JSON, jadi perubahan pengaturan/tema dapat direkonstruksi (mis. untuk menjawab “siapa mengubah pajak jadi 0%?”).
Menutup peringatan memakai `POST /api/alerts/read/:id`; `:id` = `all` menandai seluruh alert 7 hari terakhir (per user, lewat tabel `alert_reads`).

## 6. Backup = bagian dari keamanan

`GET /api/admin/backup` (permission `system.maintenance`) melakukan `VACUUM INTO` ke berkas sementara lalu mengirimnya sebagai unduhan —
salinan konsisten tanpa menghentikan layanan, dicatat sebagai `backup.download` di log audit.
Versi baris perintah: `npm run backup -- --verify` dan `npm run maintenance -- …` (lihat [09-deployment-dan-maintenance.md](09-deployment-dan-maintenance.md)).
Berkas cadangan = isi penuh DB (kata sandi hash, struk, pelanggan) → simpan terenkripsi di penyimpanan luar, jangan di folder yang disajikan web.

## 7. Daftar periksa produksi

* [ ] `KASIR_JWT_SECRET` diisi nilai acak sendiri (`openssl rand -hex 32`), jangan mengandalkan berkas yang dibuat otomatis.
* [ ] `NODE_ENV=production`; hanya port 4000 disimak `127.0.0.1`, akses luar lewat proxy TLS (domain publik → Let's Encrypt).
* [ ] Ganti semua kata sandi akun hasil seed, dan hapus/`is_active=0` akun demo sebelum pengguna pertama masuk.
* [ ] `KASIR_DATA_DIR` di partisi dengan pencadangan otomatis + `fsync`; jangan di direktori sementara (mis. `/tmp`) — data hilang saat reboot.
* [ ] Cron cadangan harian (`ops/crontab.example`) + **latihan pemulihan** sekali sebulan.
* [ ] Batasi user dengan `system.maintenance` hanya ke pemilik; permission itu bisa mengunduh DB penuh.
* [ ] Batasi jaringan printer/POS ke SSID toko; kunci layar perangkat (auto-lock) karena token sesi disimpan di `localStorage`.
* [ ] `PRAGMA secure_delete` tidak diperlukan; pertimbangkan enkripsi disk (LUKS) untuk perangkat kasir fisik.
* [ ] Pantau `GET /api/health` (uptime, jumlah baris) dan log `journalctl -u kasir`.
