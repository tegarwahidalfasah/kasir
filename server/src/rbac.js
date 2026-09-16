// ===========================================================================
//  RBAC — Role-Based Access Control (Fase 2)
//  Model: PERMISSION (atomik) <- ROLE (kumpulan permission, bisa disunting)
//  Peta role -> permission disimpan di tabel `settings` (key: rbac) sehingga
//  pemilik toko bisa mengubah hak akses dari UI tanpa migrasi kode.
// ===========================================================================

export const PERMISSIONS = [
  { key: 'sale.create',        label: 'Buat transaksi',       group: 'Kasir' },
  { key: 'sale.void',          label: 'Batalkan / refund',    group: 'Kasir' },
  { key: 'sale.hold',          label: 'Tahan & sambung order', group: 'Kasir' },
  { key: 'item.view',          label: 'Lihat katalog',        group: 'Inventaris' },
  { key: 'item.manage',        label: 'Kelola barang & bahan', group: 'Inventaris' },
  { key: 'recipe.manage',      label: 'Kelola resep (BOM)',   group: 'Inventaris' },
  { key: 'stock.view',         label: 'Lihat stok & health',  group: 'Inventaris' },
  { key: 'stock.adjust',       label: 'Stock opname / adjusment', group: 'Inventaris' },
  { key: 'stock.purchase',     label: 'Pembelian bahan baku', group: 'Inventaris' },
  { key: 'stock.produce',      label: 'Produksi (stock in)',  group: 'Inventaris' },
  { key: 'report.view',        label: 'Lihat laporan',       group: 'Laporan' },
  { key: 'report.export',      label: 'Ekspor laporan',      group: 'Laporan' },
  { key: 'setting.store',      label: 'Profil toko',          group: 'Pengaturan' },
  { key: 'setting.tax',        label: 'Pajak & diskon',       group: 'Pengaturan' },
  { key: 'setting.payment',    label: 'Metode pembayaran',    group: 'Pengaturan' },
  { key: 'setting.receipt',    label: 'Tata letak struk',     group: 'Pengaturan' },
  { key: 'setting.theme',      label: 'Tema & logo & menu',   group: 'Pengaturan' },
  { key: 'user.manage',        label: 'Kelola user',          group: 'Admin' },
  { key: 'role.manage',        label: 'Kelola role & hak akses', group: 'Admin' },
  { key: 'system.maintenance', label: 'Backup / maintenance', group: 'Admin' },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
const ALL = ['*', ...PERMISSION_KEYS];

export const ROLE_PRESETS = {
  owner:    { label: 'Pemilik',      description: 'Akses penuh termasuk pengaturan & user', permissions: ALL },
  admin:    { label: 'Administrator', description: 'Semua kecuali transfer kepemilikan toko', permissions: ALL },
  manager:  { label: 'Manajer',      description: 'Inventaris, laporan, pengaturan non-user', permissions: [
    'sale.create', 'sale.void', 'sale.hold', 'item.view', 'item.manage', 'recipe.manage', 'stock.view',
    'stock.adjust', 'stock.purchase', 'stock.produce', 'report.view', 'report.export', 'setting.store',
    'setting.tax', 'setting.payment', 'setting.receipt', 'setting.theme',
  ] },
  inventory:{ label: 'Manajer Inventaris', description: 'Fokus bahan baku, PO, stok opname', permissions: [
    'item.view', 'item.manage', 'recipe.manage', 'stock.view', 'stock.adjust', 'stock.purchase', 'stock.produce', 'report.view',
  ] },
  cashier:  { label: 'Kasir',        description: 'Transaksi & lihat stok untuk melayani', permissions: [
    'sale.create', 'sale.hold', 'item.view', 'stock.view',
  ] },
};

export const ROLE_KEYS = Object.keys(ROLE_PRESETS);

const FALLBACK = Object.fromEntries(
  ROLE_KEYS.map((r) => [r, ROLE_PRESETS[r].permissions])
);

export function loadRoleMatrix(loadSetting, storeId) {
  return loadSetting(storeId, 'rbac', { roles: FALLBACK });
}

/** Permissin list untuk user; role tidak dikenal -> minimal (hanya sale.create bila ada). */
export function permissionsFor(role, matrix) {
  const list = matrix?.roles?.[role] ?? ROLE_PRESETS[role]?.permissions ?? [];
  return list;
}

export function can(perms, required) {
  if (!perms || !required) return true;
  if (perms.includes('*')) return true;
  const need = Array.isArray(required) ? required : [required];
  return need.every((n) => perms.includes(n));
}
