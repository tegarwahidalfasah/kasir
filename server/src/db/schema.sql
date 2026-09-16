-- ============================================================================
--  KASIR — Skema Database Relasional (Fase 1)
--  Engine  : SQLite (WAL) via node:sqlite. Skema sengaja portable ke Postgres.
--  Prinsip : 1) item = entitas tunggal (finished | raw)
--            2) resep/BOM memotong BANYAK bahan baku sekaligus saat terjual
--            3) SEMUA perubahan stok lewat stock_movements (ledger append-only)
--               -> stok saat ini selalu bisa direkonstruksi & diaudit
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------------- identitas
CREATE TABLE IF NOT EXISTS stores (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  legal_name    TEXT,
  address       TEXT,
  phone         TEXT,
  email         TEXT,
  npwp          TEXT,
  timezone      TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  currency      TEXT NOT NULL DEFAULT 'IDR',
  locale        TEXT NOT NULL DEFAULT 'id-ID',
  logo_path     TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS branches (
  id            TEXT PRIMARY KEY,
  store_id      TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  address       TEXT,
  phone         TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_branches_store ON branches(store_id);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  store_id      TEXT REFERENCES stores(id) ON DELETE SET NULL,
  branch_id     TEXT REFERENCES branches(id) ON DELETE SET NULL,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  pin           TEXT,                      -- PIN cepat untuk kasir (di-hash)
  role          TEXT NOT NULL DEFAULT 'cashier',
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ------------------------------------------------------------------- katalog
CREATE TABLE IF NOT EXISTS categories (
  id         TEXT PRIMARY KEY,
  store_id   TEXT REFERENCES stores(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  color      TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1
);

-- item_type: 'finished' = barang jadi (dijual di kasir)
-- item_type: 'raw'     = bahan baku / HPP (tidak dijual langsung)
CREATE TABLE IF NOT EXISTS items (
  id               TEXT PRIMARY KEY,
  store_id         TEXT REFERENCES stores(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  item_type        TEXT NOT NULL CHECK (item_type IN ('finished','raw')),
  category_id      TEXT REFERENCES categories(id) ON DELETE SET NULL,
  sku              TEXT,
  barcode          TEXT,
  unit             TEXT NOT NULL DEFAULT 'pcs',
  cost_price       REAL NOT NULL DEFAULT 0,       -- rata-rata bergerak (raw) / HPP (finished)
  selling_price    REAL NOT NULL DEFAULT 0,
  tax_mode         TEXT NOT NULL DEFAULT 'inherit' CHECK (tax_mode IN ('inherit','exempt','override')),
  tax_rate         REAL,                          -- % override bila tax_mode='override'
  -- stok fisik (hasil agregasi ledger; kolom redundan untuk performa)
  stock_qty        REAL NOT NULL DEFAULT 0,
  min_stock        REAL NOT NULL DEFAULT 0,       -- barang jadi: batas peringatan
  reorder_point    REAL,                          -- bahan baku: titik pesan ulang (NULL = auto dari konsumsi)
  safety_stock     REAL,
  lead_time_days   INTEGER NOT NULL DEFAULT 3,
  supplier_name    TEXT,
  -- barang jadi dengan BOM:
  --   make_to_stock : jual -> potong stok finished -> produksi consume raw
  --   make_to_order : jual -> langsung potong raw sesuai BOM
  production_mode  TEXT NOT NULL DEFAULT 'make_to_stock' CHECK (production_mode IN ('make_to_stock','make_to_order')),
  yield_pct        REAL NOT NULL DEFAULT 100,     -- susut produksi (%)
  is_non_stock     INTEGER NOT NULL DEFAULT 0,    -- jasa / tidak dilacak stoknya
  is_active        INTEGER NOT NULL DEFAULT 1,
  image            TEXT,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_type ON items(item_type, is_active);
CREATE INDEX IF NOT EXISTS idx_items_cat  ON items(category_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_items_sku ON items(store_id, sku) WHERE sku IS NOT NULL AND sku <> '';

-- Bill of Materials: 1 barang jadi -> N bahan baku (potong bersamaan saat terjual)
CREATE TABLE IF NOT EXISTS item_recipes (
  id           TEXT PRIMARY KEY,
  parent_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  raw_item_id  TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  qty          REAL NOT NULL CHECK (qty > 0),
  unit         TEXT,
  waste_pct    REAL NOT NULL DEFAULT 0,
  is_optional  INTEGER NOT NULL DEFAULT 0,        -- topping/varian: hanya dipotong bila dipilih
  sort_order   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (parent_id, raw_item_id)
);
CREATE INDEX IF NOT EXISTS idx_recipes_parent ON item_recipes(parent_id);
CREATE INDEX IF NOT EXISTS idx_recipes_raw    ON item_recipes(raw_item_id);

CREATE TABLE IF NOT EXISTS item_addons (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  price_delta REAL NOT NULL DEFAULT 0,
  raw_item_id TEXT REFERENCES items(id) ON DELETE SET NULL, -- mis. "extra shot" -> biji kopi +18gr
  raw_qty     REAL NOT NULL DEFAULT 0,
  is_required INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- --------------------------------------------------------- bahan baku / gudang
CREATE TABLE IF NOT EXISTS suppliers (
  id          TEXT PRIMARY KEY,
  store_id    TEXT REFERENCES stores(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  contact     TEXT,
  phone       TEXT,
  email       TEXT,
  lead_time_days INTEGER NOT NULL DEFAULT 3,
  notes       TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id           TEXT PRIMARY KEY,
  store_id     TEXT REFERENCES stores(id) ON DELETE CASCADE,
  po_number    TEXT NOT NULL,
  supplier_id  TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
  branch_id    TEXT REFERENCES branches(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ordered','partial','received','cancelled')),
  order_date   TEXT,
  expected_date TEXT,
  received_at  TEXT,
  total_amount REAL NOT NULL DEFAULT 0,
  note         TEXT,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_po_number ON purchase_orders(store_id, po_number);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id         TEXT PRIMARY KEY,
  po_id      TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  raw_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  qty_ordered REAL NOT NULL,
  qty_received REAL NOT NULL DEFAULT 0,
  unit_cost  REAL NOT NULL DEFAULT 0,
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_poi_po ON purchase_order_items(po_id);

-- ------------------------------------------------------ LEDGER STOK (source of truth)
-- movement_type:
--   sale_out        : potong barang jadi saat transaksi
--   bom_consume     : potong bahan baku karena BOM / produksi
--   purchase_in     : terima barang dari PO (menaikkan stok raw)
--   production_in   : stok masuk barang jadi dari produksi (make_to_stock)
--   return_in       : pembatalan/refund -> stok kembali
--   adjustment      : stock opname manual
--   transfer        : mutasi antar cabang (cadangan)
CREATE TABLE IF NOT EXISTS stock_movements (
  id             TEXT PRIMARY KEY,
  store_id       TEXT REFERENCES stores(id) ON DELETE CASCADE,
  branch_id      TEXT REFERENCES branches(id) ON DELETE SET NULL,
  item_id        TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  movement_type  TEXT NOT NULL CHECK (movement_type IN
                   ('sale_out','bom_consume','purchase_in','production_in','return_in','adjustment','transfer')),
  qty            REAL NOT NULL,                  -- positif = masuk, negatif = keluar
  unit_cost      REAL NOT NULL DEFAULT 0,
  balance_after  REAL,                           -- stok item setelah baris ini (untuk audit)
  ref_type       TEXT,                           -- 'transaction' | 'purchase_order' | 'manual'
  ref_id         TEXT,
  reason         TEXT,
  voided         INTEGER NOT NULL DEFAULT 0,     -- 1 bila sudah dibatalkan (stok dikembalikan)
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mov_item  ON stock_movements(item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mov_ref   ON stock_movements(ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_mov_store ON stock_movements(store_id, created_at);

-- ------------------------------------------------------------------- konfigurasi toko
CREATE TABLE IF NOT EXISTS settings (
  store_id     TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  value_json   TEXT NOT NULL,                    -- JSON; dibaca dengan default di app layer
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by   TEXT,
  PRIMARY KEY (store_id, key)
);

CREATE TABLE IF NOT EXISTS taxes (
  id           TEXT PRIMARY KEY,
  store_id     TEXT REFERENCES stores(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,                    -- mis. PPn
  rate_pct     REAL NOT NULL DEFAULT 0,
  is_inclusive INTEGER NOT NULL DEFAULT 0,       -- 1 = harga sudah termasuk pajak
  is_active    INTEGER NOT NULL DEFAULT 1,
  is_default   INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS discounts (
  id             TEXT PRIMARY KEY,
  store_id       TEXT REFERENCES stores(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'percent' CHECK (kind IN ('percent','fixed')),
  value          REAL NOT NULL DEFAULT 0,
  applies_to     TEXT NOT NULL DEFAULT 'global' CHECK (applies_to IN ('global','category','item')),
  ref_ids        TEXT,                           -- JSON array id category/item
  trigger        TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','auto_weekday','auto_time','auto_min_subtotal')),
  days           TEXT,                           -- JSON array 0..6 (Minggu..Sabtu)
  start_time     TEXT,
  end_time       TEXT,
  min_subtotal   REAL NOT NULL DEFAULT 0,
  max_discount   REAL,
  stackable      INTEGER NOT NULL DEFAULT 0,
  is_active      INTEGER NOT NULL DEFAULT 1,
  valid_from     TEXT,
  valid_to       TEXT
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id           TEXT PRIMARY KEY,
  store_id     TEXT REFERENCES stores(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'wallet' CHECK (kind IN ('cash','wallet','qris','debit','credit','transfer')),
  icon         TEXT,
  service_fee_pct REAL NOT NULL DEFAULT 0,
  is_enabled   INTEGER NOT NULL DEFAULT 1,
  is_default   INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------------- transaksi
CREATE TABLE IF NOT EXISTS transactions (
  id              TEXT PRIMARY KEY,
  store_id        TEXT REFERENCES stores(id) ON DELETE CASCADE,
  branch_id       TEXT REFERENCES branches(id) ON DELETE SET NULL,
  invoice_no      TEXT NOT NULL,
  external_ref    TEXT UNIQUE,                   -- idempotency key dari client
  cashier_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided','refunded','open')),
  customer_name   TEXT,
  customer_phone  TEXT,
  order_type      TEXT NOT NULL DEFAULT 'dine_in',
  note            TEXT,
  subtotal        REAL NOT NULL DEFAULT 0,
  discount_total  REAL NOT NULL DEFAULT 0,
  tax_total       REAL NOT NULL DEFAULT 0,
  service_total   REAL NOT NULL DEFAULT 0,
  rounding_total  REAL NOT NULL DEFAULT 0,
  grand_total     REAL NOT NULL DEFAULT 0,
  cost_total      REAL NOT NULL DEFAULT 0,       -- HPP untuk menghitung margin
  payment_method_id TEXT REFERENCES payment_methods(id) ON DELETE SET NULL,
  paid_amount     REAL NOT NULL DEFAULT 0,
  change_amount   REAL NOT NULL DEFAULT 0,
  fee_total       REAL NOT NULL DEFAULT 0,
  applied_discounts TEXT,                        -- JSON snapshot aturan yang terpakai
  receipt_snapshot  TEXT,                        -- JSON data cetak (kebal dari perubahan setting)
  voided_at       TEXT,
  void_reason     TEXT,
  voided_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tx_invoice ON transactions(store_id, invoice_no);
CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_tx_cashier ON transactions(cashier_id, created_at);

CREATE TABLE IF NOT EXISTS transaction_items (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  item_id        TEXT REFERENCES items(id) ON DELETE SET NULL,
  name_snapshot  TEXT NOT NULL,
  item_type      TEXT NOT NULL DEFAULT 'finished',
  qty            REAL NOT NULL,
  unit_price     REAL NOT NULL,
  line_discount  REAL NOT NULL DEFAULT 0,
  line_total     REAL NOT NULL,
  cost_snapshot  REAL NOT NULL DEFAULT 0,
  addons_json    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_txitem_tx   ON transaction_items(transaction_id);
CREATE INDEX IF NOT EXISTS idx_txitem_item ON transaction_items(item_id);

CREATE TABLE IF NOT EXISTS transaction_payments (
  id               TEXT PRIMARY KEY,
  transaction_id   TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  payment_method_id TEXT REFERENCES payment_methods(id) ON DELETE SET NULL,
  amount           REAL NOT NULL,
  reference        TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------------- notifikasi
CREATE TABLE IF NOT EXISTS alerts (
  id           TEXT PRIMARY KEY,
  store_id     TEXT REFERENCES stores(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'low_stock',
  severity     TEXT NOT NULL DEFAULT 'warning',  -- info | warning | critical
  item_id      TEXT REFERENCES items(id) ON DELETE CASCADE,
  message      TEXT NOT NULL,
  data_json    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);

CREATE TABLE IF NOT EXISTS alert_reads (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_id   TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  read_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, alert_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         TEXT PRIMARY KEY,
  store_id   TEXT,
  user_id    TEXT,
  actor_role TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  before_json TEXT,
  after_json  TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

-- View ringkas untuk dasbor stok (stok + konsumsi 14 hari terakhir)
CREATE VIEW IF NOT EXISTS v_stock_health AS
SELECT i.id, i.name, i.item_type, i.unit, i.stock_qty, i.min_stock, i.reorder_point,
       i.lead_time_days, i.cost_price, i.selling_price, i.is_active,
       COALESCE(c.qty_out_14d, 0) AS qty_out_14d,
       COALESCE(c.qty_out_14d, 0) / 14.0 AS avg_daily_use
FROM items i
LEFT JOIN (
  SELECT item_id, SUM(ABS(qty)) AS qty_out_14d
  FROM stock_movements
  WHERE qty < 0 AND voided = 0
    AND movement_type IN ('sale_out','bom_consume','adjustment')
    AND created_at >= datetime('now','-14 days')
  GROUP BY item_id
) c ON c.item_id = i.id
WHERE i.is_non_stock = 0;
