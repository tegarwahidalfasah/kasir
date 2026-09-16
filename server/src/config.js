// ===========================================================================
//  Default konfigurasi toko (Fase 3: panel kustomisasi).
//  Semua blok disimpan sebagai JSON di tabel `settings`; UI mengeditnya.
// ===========================================================================

export const DEFAULTS = {
  store: {
    name: 'Toko Saya',
    legal_name: '',
    address: '',
    phone: '',
    email: '',
    npwp: '',
    timezone: 'Asia/Jakarta',
    currency: 'IDR',
    locale: 'id-ID',
    logo_data_url: null,
    invoice_prefix: 'INV',
  },

  // Aturan harga: pajak, layanan, pembulatan, validasi stok
  tax: {
    enabled: true,
    default_rate_pct: 11,
    inclusive: false,          // true bila harga sudah termasuk pajak
    service_charge_pct: 0,
    rounding_mode: 'nearest',  // 'none' | 'nearest' | 'up' | 'down'  (ke Rupiah terdekat)
    rounding_step: 1,
    allow_negative_stock: false,
    alert_lookahead_days: 7,
    consumption_window_days: 14,
  },

  receipt: {
    header: 'Terima kasih telah berbelanja!',
    subheader: '',
    footer: 'Barang yang sudah dibeli tidak dapat dikembalikan',
    thank_you: 'Ditunggu kunjungan berikutnya 🙏',
    paper_width: 58,           // mm: 58 | 72 | 80 | A4
    font_scale: 1,
    show: {
      logo: true, store_name: true, address: true, phone: true, npwp: true,
      cashier: true, invoice: true, date: true, items: true, discounts: true,
      tax: true, service: true, payment: true, change: true,
      social: false, footer: true,
    },
    line_char: '-',
    center_char: '=',
    social: '@tokosaya',
    custom_lines: [],          // [{position:'top'|'bottom', text:'...'}]
  },

  // Tema & layout (desain modular: token warna, logo, urutan menu)
  theme: {
    accent: '#f97316',
    accent_text: '#ffffff',
    success: '#16a34a',
    danger: '#dc2626',
    warning: '#d97706',
    surface: '#ffffff',
    canvas: '#f6f7f9',
    text: '#111827',
    muted: '#6b7280',
    border: '#e5e7eb',
    mode: 'light',             // light | dark | system
    radius: 12,
    density: 'comfortable',    // comfortable | compact
    font: 'system',            // system | serif | mono | rounded
    sidebar_width: 236,
    logo_data_url: null,
    app_name: 'Kasir',
    bg_pattern: 'none',        // none | dots | grid
    menu: [
      { key: 'pos',        label: 'Kasir',      icon: '🧾', visible: true,  perm: 'sale.create' },
      { key: 'dashboard',  label: 'Dasbor',     icon: '📊', visible: true,  perm: 'report.view' },
      { key: 'stock',      label: 'Stok',       icon: '📦', visible: true,  perm: 'stock.view' },
      { key: 'items',      label: 'Barang',     icon: '🏷️', visible: true,  perm: 'item.view' },
      { key: 'purchase',   label: 'Pembelian',  icon: '🚚', visible: true,  perm: 'stock.purchase' },
      { key: 'sales',      label: 'Riwayat',    icon: '🧾', visible: true,  perm: 'sale.create' },
      { key: 'reports',    label: 'Laporan',    icon: '📈', visible: true,  perm: 'report.view' },
      { key: 'alerts',     label: 'Peringatan', icon: '🔔', visible: true,  perm: 'stock.view' },
      { key: 'users',      label: 'User & Role', icon: '👥', visible: true, perm: 'user.manage' },
      { key: 'settings',   label: 'Pengaturan', icon: '⚙️', visible: true,  perm: 'setting.store' },
    ],
  },

  pos: {
    quick_amounts: [10000, 20000, 50000, 100000],
    fast_keys: [],
    default_order_type: 'dine_in',
    require_customer: false,
    show_raw_preview: true,    // tampilkan proyeksi potongan bahan baku di keranjang
  },
};

export const SETTING_KEYS = Object.keys(DEFAULTS);

/** Ambil satu blok setting (merge dengan default) untuk sebuah toko. */
export function settingFor(loadSetting, storeId, key) {
  return loadSetting(storeId, key, DEFAULTS[key]);
}
