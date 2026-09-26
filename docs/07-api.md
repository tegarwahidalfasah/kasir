# 07 — Referensi REST API

Semua rute berada di bawah `/api`. Selain 4 jalur publik (`/api/auth/login`, `/api/public/brand`, `/api/health`,
`/api/openapi.json`), **setiap** rute butuh `Authorization: Bearer <token>` — guard dipasang global di
`server/src/routes/index.js`. Permission minimum tiap rute ditulis di kolom terakhir (`—` = cukup login).

Format error seragam: `{ "error": "pesan untuk pengguna", "details": … }` dengan status 400/401/403/404/409/429/500.
Batas body JSON 12 MB. Nomor versi & jumlah baris tersedia di `GET /api/health`.

## Autentikasi & sesi — `routes/auth.js`

| Metode | Jalur | Permission | Catatan |
|---|---|---|---|
| POST | `/auth/login` | publik | `{username, password}` **atau** `{username, pin}` → `{token, user}`. Dibatasi 5 percobaan/60 s/IP (`loginGuard`) |
| GET | `/bootstrap` | — | satu muatan untuk seluruh layar: `user, permissions, store, settings, catalog, bom, taxes, discount_rules, payment_methods, categories, roles, permission_list, alerts_unread, server_time` |
| GET | `/auth/me` | — | user publik + permission |
| POST | `/auth/password` | — | `{current, next}`; minimal 6 karakter |
| POST | `/auth/refresh` | — | token baru (TTL diulang) |

## Katalog kasir — `routes/pos.js`

| Metode | Jalur | Permission | Catatan |
|---|---|---|---|
| GET | `/pos/catalog` | `item.view` \| `sale.create` \| `stock.view` | barang aktif + `addons[]`, `recipe[]`, `capacity`, `bom_preview`, kategori, harga, stok |
| POST | `/pos/preview` | `sale.create` | body `{lines:[{item_id, qty, unit_price?, addons?, discount?}], customer?, order_type?}` → harga + dampak bahan |
| POST | `/sales` | `sale.create` | buat transaksi (body di §contoh); `external_ref` ganda → struk lama + `duplicated: true` (HTTP 200); `skip_alerts: true` menunda pindai peringatan |
| GET | `/sales` | — | `?page=&limit=&from=&to=&status=&cashier_id=` · limit ≤ 200 · tanpa `receipt_snapshot`. `from`/`to` polos (`YYYY-MM-DD`) = **hari bisnis toko** |
| GET | `/sales/:id` | — | detail + `items[]` (tiap baris memuat `bom`: snapshot konsumsi saat jual, `null` untuk data lama), `movements[], payments[], snapshot` |
| POST | `/sales/:id/void` | `sale.void` | `{reason}` → semua stok kembali. `409` bila status bukan `completed` **atau** transaksi sudah punya retur (stok akan kembali dua kali) |
| POST | `/sales/:id/refund` | `sale.void` | `{item_id, qty, reason}` retur sebagian proporsional — membalikkan **snapshot** `bom_json` baris itu (resep yang berubah setelah jual tidak berpengaruh; baris lama tanpa snapshot dihitung ulang dengan resep saat ini). Berpagar per baris: `409` bila qty melebihi sisa (`qty − refunded_qty`) atau baris sudah diretur penuh. Respons: `{id, item, refund_qty, refund_amount, remaining_qty, fully_refunded, status, movements[]}` |
| GET | `/pos/held` | `sale.hold` | order `status='open'` (maks 50) |
| POST | `/pos/hold` | `sale.hold` | `{lines, customer_name}` → `{id, invoice_no:'HHMMSS'}` |
| GET / DELETE | `/pos/hold/:id` | `sale.hold` | baca / buang order tertahan |

## Barang, bahan, resep — `routes/items.js`

| Metode | Jalur | Permission |
|---|---|---|
| GET | `/items` (`?type=&q=&category_id=&active=`) | — |
| GET | `/items/:id` | — (sudah disaring per toko) |
| POST · PUT · DELETE | `/items` · `/items/:id` · `/items/:id` | `item.manage` (DELETE jadi nonaktif bila sudah terpakai) |
| GET · PUT | `/items/:id/recipe` | — · `recipe.manage` |
| POST | `/items/:id/simulate` `{qty, addons}` | — → `{input_qty, deduct_finished, deduct_raw[{…,stock_after}], shortages, max_servable}`. Memakai `forceConsumeRaw`: bahan baku selalu dihitung, stok barang jadi diabaikan; `max_servable` memakai `rawCapacity()` yang sama dengan `/pos/catalog` & `/stock/health` |
| GET · POST · PUT · DELETE | `/categories`… | — · `item.manage` |
| GET · PUT | `/items/:id/addons` | — · `item.manage` (parent wajib milik toko) |

Body `PUT /items/:id/recipe`: `{recipe:[{raw_item_id, qty, unit?, waste_pct?, is_optional?}]}` — **seluruh daftar ditulis ulang**.
Respons: `{ok, recipe[], cost_price}` (HPP roll-up otomatis).

## Stok & pembelian — `routes/stock.js`

| Metode | Jalur | Permission | Body / catatan |
|---|---|---|---|
| GET | `/stock/health` | `stock.view` \| `item.view` | `?days=&lookahead=` → `[{…, avg_daily, reorder_point_effective, days_to_stockout, stockout_date, serve_capacity, status, est_value, margin_pct}]` |
| GET | `/stock/movements` | `stock.view` | `?item_id=&from=&to=&types=&limit=` — `from`/`to` polos = hari bisnis toko |
| GET | `/stock/consumption` | `stock.view` | `?days=&group=item\|day` |
| GET | `/stock/integrity` | `system.maintenance` | → `{checked, mismatches[]}` |
| POST | `/stock/reconcile` | `system.maintenance` | → `{checked, fixed}` |
| POST | `/stock/adjust` | `stock.adjust` | `{counted_qty}` atau `{items:[{item_id, counted_qty, reason}], reason}` |
| POST | `/stock/produce` | `stock.produce` | `{item_id, qty, reason?}` |
| GET · POST | `/purchase-orders` | `stock.purchase` | body POST: `{supplier_id?, status?, expected_date?, note?, items:[{raw_item_id, qty_ordered, unit_cost, note?}]}` → `201 {id, po_number, total_amount}` |
| GET | `/purchase-orders/:id` | `stock.purchase` | kepala + baris |
| POST | `/purchase-orders/:id/receive` | `stock.purchase` | `{items?:{[poi_id]:{qty_received}}}` (tanpa body = terima penuh) → `{po_number, status, received[], open_qty, alerts}` |
| POST | `/purchase-orders/:id/cancel` | `stock.purchase` | status → `cancelled` |
| GET · POST · PUT · DELETE | `/suppliers`… | — · `item.manage` | |
| POST | `/alerts/scan` | `stock.view` | `?days=&lookahead=` → `{created, at_risk, total}` |

## Peringatan — `routes/alerts.js`

| Metode | Jalur | Permission | Catatan |
|---|---|---|---|
| GET | `/alerts` | — | `?limit=` → `{items[], unread, at_risk, critical, config}` |
| POST | `/alerts/read/:id` | — | `:id` = `all` → seluruh alert 7 hari terakhir (per user); dicatat `alert.dismiss` |
| GET | `/alerts/replenish` | `stock.purchase` \| `stock.view` | bahan yang perlu dibeli + jumlah disarankan |

## Laporan — `routes/reports.js` (semua menerima `?from=&to=`, default 30 hari **bisnis toko**)

`from`/`to` dan `period` memakai hari bisnis `settings.store.timezone` (sejak 26 Sep 2026); grafik `by_hour`
juga memakai jam toko, bukan `localtime` server.

| Jalur | Isi |
|---|---|
| `GET /reports/summary` | `{period, totals, by_day[], by_hour[], by_item[], by_payment[], by_cashier[]}`; `totals`: `tx_count, gross_revenue, net_revenue, cost, gross_profit, margin_pct, avg_ticket, discount, tax, service, voided` |
| `GET /reports/raw-usage` | `{period, window_days, items[]}` — pemakaian, pembelian, susut, `avg_daily_use`, `days_to_stockout`, `stockout_date`, `status` |
| `GET /reports/stock-movement` | `[{day, movement_type, qty_in, qty_out, lines}]` |
| `GET /reports/inventory-valuation` | nilai persediaan per item (`stock_value`, margin) |
| `GET /reports/export/:kind` | **`report.export`** · `kind ∈ sales \| movements \| stock` → CSV `text/csv`. Sel teks berawalan `=`, `+`, `-`, `@`, TAB, atau CR diberi apostrof (formula injection tidak tereksekusi di Excel); kolom angka tetap numerik |

## Kustomisasi — `routes/settings.js`

| Jalur | Permission | Catatan |
|---|---|---|
| `GET /settings` | — | semua blok + `_meta` |
| `PUT /settings/:key` | gerbang: salah satu `setting.store`\|`setting.tax`\|`setting.receipt`\|`setting.theme`; **per blok**: `store`/`pos`→`setting.store`, `tax`→`setting.tax`, `receipt`→`setting.receipt`, `theme`→`setting.theme` | **replace** — kirim blok penuh; menu `theme` dinormalisasi + diaudit; blok di luar hak user → **403** |
| `POST` / `DELETE /branding/logo` | `setting.theme` \| `setting.store` · `setting.theme` | data URL ≤ ±1 MB (png/jpg/svg/webp); disimpan ke blok `theme` + `store` |
| `GET /branding/palettes` | — | 8 preset `{name, accent, canvas, mode}` |
| `GET /branding/brand` · `GET /public/brand` | — · publik | untuk layar login & judul |
| `GET/POST/PUT/DELETE /taxes` | — · `setting.tax` | tarif dapat punya `is_default` per toko |
| `GET/POST/PUT/DELETE /discounts` | — · `setting.tax` | lihat doc 05 §5 untuk kolom aturan |
| `GET/POST/PUT/DELETE /payment-methods` | — · `setting.payment` | `service_fee_pct`, `is_enabled`, `is_default` |
| `POST /receipt/preview` | — | `{receipt_overrides}` → `{receipt, store, theme, sample, variables}`; `sample` = transaksi selesai terakhir + itemnya, `variables` = daftar placeholder `{{…}}` yang tersedia (dirender klien lewat komponen `Receipt`) |
| `GET/POST/PUT/DELETE /branches` | — · `setting.store` | cabang; header `X-Branch-Id` untuk transaksi/PO |
| `GET /admin/backup` | `system.maintenance` | unduhan `kasir-backup-YYYY-MM-DD.sqlite` (`VACUUM INTO`) + audit `backup.download` |

## User, role, audit — `routes/users.js`

| Jalur | Permission | Catatan |
|---|---|---|
| `GET /users` | `user.manage` \| `role.manage` | tanpa `password_hash`/`pin` |
| `POST /users` | `user.manage` | `{username, password, display_name, role, pin?, branch_id?}` |
| `PUT` / `DELETE /users/:id` | `user.manage` | **hanya user di toko yang sama**; tidak bisa menonaktifkan/menghapus diri sendiri; minimal satu `owner` aktif per toko |
| `GET /roles` | — | daftar permission + matriks |
| `PUT /roles/:role` | `role.manage` | `{permissions:[…]}` → `settings.rbac`, berlaku seketika |
| `POST /roles/reset` | `role.manage` | kembali ke preset |
| GET | `/audit` | `role.manage` \| `system.maintenance` | `?user_id=&entity=&entity_id=&action=&limit=` (≤ 300; urutan `created_at, rowid` DESC) |

## 6. Contoh

```bash
B=$(curl -s localhost:4000/api/auth/login -H 'content-type: application/json' \
    -d '{"username":"budi","password":"rahasia123"}' | sed 's/.*"token":"***"]*\)".*/\1/')

# buat transaksi 2 croissant (MTO → potong bahan) + QRIS, dengan kunci idempotensi
curl -s localhost:4000/api/sales -H "authorization: Bearer $B" -H 'content-type: application/json' -d '{
  "lines": [ { "item_id": "itm…", "qty": 2, "addons": [ { "id": "adn…", "qty": 1 } ] } ],   // addon cukup id — harga & bahan dibaca dari item_addons
  "order_type": "takeaway", "customer": { "name": "Rina" },
  "payment": { "method_id": "pay…", "paid_amount": 50000, "reference": "88291" },
  "external_ref": "kasir-1-20260916-0001"
}' | python3 -m json.tool
# → { id, invoice_no, subtotal, discount_total, tax_total, grand_total, cost_total,
#     movements: [{ item_id, name, type, qty, balance_after }], receipt_snapshot }
# Catatan: field addons dari klien yang tidak cocok dengan item_addons barang itu (id/nama) diabaikan.

curl -s "localhost:4000/api/stock/health?days=14&lookahead=7" -H "authorization: Bearer $B" | head -c 400
curl -s "localhost:4000/api/reports/raw-usage?from=2026-09-01&to=2026-09-16" -H "authorization: Bearer $B" | head -c 400
```

## 7. Aturan yang diharapkan dari pemanggil API

1. **Jangan** menyimpan stok dengan mengubah `items.stock_qty` — selalu lewat `/stock/adjust`, `/stock/produce`, atau PO.
2. Sertakan `external_ref` pada setiap percobaan bayar dari perangkat kasir; tanpa itu, koneksi putus + retry = transaksi ganda.
3. Perlakukan `409` sebagai “stok/bahan tidak cukup”, bukan kegagalan jaringan: muat ulang `/pos/catalog` sebelum mencoba lagi.
4. `PUT /api/settings/:key` menggabungkan **kunci tingkat atas** dengan nilai tersimpan
   (`{...sekarang, ...body}`), tetapi objek/array bersarang (mis. `receipt.show`, `theme.menu`) **diganti seluruhnya** —
   kirim objek lengkap bila tidak mau kehilangan sakelar lain. Setelah menyimpan, klien lain perlu `app.refresh()`
   supaya tema/struk baru terbaca.
5. **Retur tidak bisa diulang.** `transaction_items.refunded_qty` adalah sumber kebenaran sisa yang boleh diretur; setelah baris penuh, status struk menjadi `refunded` dan permintaan retur berikutnya dijawab `409`. Retur juga mencatat uang (`refund_total`) dan HPP (`refund_cost`) sehingga laporan tidak lagi menghitung barang yang sudah kembali sebagai penjualan.
6. Semua harga integer Rupiah; qty boleh desimal (gram/ml). Jangan kirim `unit_price` untuk memakai harga master —
   kirim tanpa field itu agar server memakai katalog.
