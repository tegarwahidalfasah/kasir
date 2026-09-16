// Utilitas tampilan: uang, tanggal, angka stok.

const locale = () => document.documentElement.lang || 'id-ID';

export function money(n, { sign = false } = {}) {
  const v = Math.round(Number(n) || 0);
  const s = new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(Math.abs(v));
  const neg = v < 0;
  return `${neg ? '-' : sign && v > 0 ? '+' : ''}Rp${s}`;
}

export function qty(n, digits = 2) {
  const v = Number(n) || 0;
  const s = Math.abs(v % 1) < 1e-9 ? String(Math.round(v)) : v.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

export function pct(n, digits = 1) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Number(n).toFixed(digits)}%`;
}

export function dayName(iso) {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' });
}

export function dateOnly(iso) {
  if (!iso) return '—';
  return String(iso).slice(0, 10);
}

export function dateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso.replace(' ', 'T') + (iso.length === 19 ? 'Z' : ''));
  return d.toLocaleString(locale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export const relTime = (iso) => {
  if (!iso) return '—';
  const then = new Date(iso.replace(' ', 'T') + 'Z').getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'baru saja';
  if (mins < 60) return `${mins} menit lalu`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} jam lalu`;
  return `${Math.round(h / 24)} hari lalu`;
};

export const STATUS_LABEL = { ok: 'Aman', warning: 'Menipis', critical: 'Kritis', out: 'Habis' };
export const TYPE_LABEL = { finished: 'Barang Jadi', raw: 'Bahan Baku' };
export const MODE_LABEL = { make_to_order: 'Dibuat saat pesanan (potong bahan otomatis)', make_to_stock: 'Dibuat untuk stok (potong bahan saat produksi)' };
export const MOVE_LABEL = {
  sale_out: 'Jual (barang jadi)', bom_consume: 'Potong bahan baku', purchase_in: 'Pembelian masuk',
  production_in: 'Produksi masuk', return_in: 'Retur/pembatalan', adjustment: 'Penyesuaian', transfer: 'Mutasi',
};

/** Kelompokkan tanggal laporan (7/30/90 hari). */
export function dateRange(preset) {
  const to = new Date();
  const days = { hariini: 0, tujuh: 7, tiga_puluh: 30, sembilan_puluh: 90, setahun: 365 }[preset] ?? 29;
  const from = new Date(to.getTime() - days * 86400000);
  const f = (d) => d.toISOString().slice(0, 10);
  return { from: f(from), to: f(to) };
}

export const groupBy = (rows, key) => rows.reduce((acc, r) => {
  const k = typeof key === 'function' ? key(r) : r[key];
  (acc[k] ||= []).push(r);
  return acc;
}, {});
