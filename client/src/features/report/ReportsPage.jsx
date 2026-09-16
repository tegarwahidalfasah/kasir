// ===========================================================================
//  Laporan & ekspor (Fase 3) — penjualan, bahan baku, pergerakan stok, nilai persediaan
// ===========================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { get, downloadCsv } from '../../api.js';
import { useApp } from '../../store.jsx';
import { BarChart, Badge, Button, Card, LineChart, Loading, RowBars, Select, Stat, StockBadge, Table, Tabs } from '../../ui.jsx';
import { money, qty as fmtQty, pct, dateRange, dateTime, dateOnly } from '../../lib/format.js';

const PRESETS = [['hariini', 'Hari ini'], ['tujuh', '7 hari'], ['tiga_puluh', '30 hari'], ['sembilan_puluh', '90 hari'], ['setahun', '12 bulan']];

export default function ReportsPage() {
  const app = useApp();
  const [tab, setTab] = useState('penjualan');
  const [preset, setPreset] = useState('tiga_puluh');
  const [range, setRange] = useState(() => dateRange('tiga_puluh'));
  const [data, setData] = useState(null);
  const [extra, setExtra] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setRange(preset === 'kustom' ? range : dateRange(preset)); /* eslint-disable-next-line */ }, [preset]);

  const load = useCallback(async () => {
    setBusy(true); setErr('');
    const qs = `from=${range.from}&to=${range.to}`;
    try {
      if (tab === 'penjualan') {
        setData(await get(`/reports/summary?${qs}`));
        setExtra(null);
      } else if (tab === 'bahan') {
        setData(await get(`/reports/raw-usage?${qs}`));
        setExtra(null);
      } else if (tab === 'stok') {
        setData(await get(`/reports/stock-movement?${qs}`));
        setExtra(null);
      } else {
        setData(await get('/reports/inventory-valuation'));
        setExtra(await get('/stock/health').catch(() => null));
      }
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }, [tab, range]);
  useEffect(() => { load(); }, [load]);

  const exportCsv = async (kind) => {
    try { await downloadCsv(`/reports/export/${kind}?from=${range.from}&to=${range.to}`, `${kind}-${range.from}_${range.to}.csv`); app.toast('Berkas CSV diunduh', 'success'); }
    catch (e) { app.toast(e.message, 'error'); }
  };

  return (
    <Card
      title="Analitik & laporan"
      subtitle={`Semua angka dihitung dari tabel transaksi + buku stok, periode ${range.from} → ${range.to}`}
      actions={<>
        <Select value={preset} onChange={setPreset} options={[...PRESETS, ['kustom', 'Kustom…']].map(([value, label]) => ({ value, label }))} style={{ width: 130 }} />
        {preset === 'kustom' && <>
          <input type="date" className="input" style={{ width: 145 }} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          <input type="date" className="input" style={{ width: 145 }} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </>}
        {app.can('report.export') && <Button size="sm" onClick={() => exportCsv(tab === 'penjualan' ? 'sales' : tab === 'stok' ? 'movements' : 'stock')}>⬇ CSV</Button>}
      </>}>
      <Tabs items={[{ key: 'penjualan', label: 'Penjualan' }, { key: 'bahan', label: 'Bahan Baku' }, { key: 'stok', label: 'Pergerakan Stok' }, { key: 'nilai', label: 'Nilai Persediaan' }]} value={tab} onChange={setTab} />
      {err && <div className="hint-box" style={{ borderColor: 'var(--danger)', marginTop: 10 }}>⚠️ {err}</div>}
      {busy && <Loading label="Menghitung laporan…" />}

      {!busy && tab === 'penjualan' && data && <SalesReport data={data} />}
      {!busy && tab === 'bahan' && data && <RawReport data={data} />}
      {!busy && tab === 'stok' && data && <MovementReport data={data} />}
      {!busy && tab === 'nilai' && data && <ValuationReport data={data} health={extra} />}
    </Card>
  );
}

// ------------------------------------------------------------------ penjualan
function SalesReport({ data }) {
  const t = data.totals;
  const days = data.by_day || [];
  const growth = useMemo(() => {
    if (days.length < 4) return null;
    const h = Math.floor(days.length / 2);
    const sum = (a) => a.reduce((s, x) => s + x.revenue, 0);
    const prev = sum(days.slice(0, h)), cur = sum(days.slice(h));
    return prev > 0 ? ((cur - prev) / prev) * 100 : null;
  }, [days]);

  return (
    <div className="col">
      <div className="grid grid-4" style={{ marginTop: 10 }}>
        <Stat label="Omzet kotor" value={money(t.gross_revenue)} sub={`net ${money(t.net_revenue)} setelah pajak`} />
        <Stat label="Laba kotor" value={money(t.gross_profit)} sub={`margin ${pct(t.margin_pct)} · HPP ${money(t.cost)}`} tone="success" />
        <Stat label="Transaksi" value={t.tx_count} sub={`rata-rata ${money(t.avg_ticket)} / struk`} />
        <Stat label="Potongan" value={money(t.discount)} sub={`${t.voided} pembatalan · pajak ${money(t.tax)}`} tone="warn" />
      </div>
      {growth != null && (
        <div className="hint-box">Tren: {growth >= 0 ? '📈 naik' : '📉 turun'} {Math.abs(growth).toFixed(1)}% bandingkan separuh awal vs akhir periode.</div>
      )}
      <LineChart data={days.map((d) => ({ ...d, day: dateOnly(d.day), revenue: d.revenue, profit: d.profit }))} x="day" y="revenue" height={220} format={(v) => money(v)} />
      <div className="grid grid-2">
        <div>
          <p className="strong">Produk terlaris</p>
          <Table dense rows={(data.by_item || []).slice(0, 12)} columns={[
            { key: 'name', label: 'Barang' },
            { key: 'qty', label: 'Qty', align: 'right', render: (r) => fmtQty(r.qty, 1) },
            { key: 'revenue', label: 'Omzet', align: 'right', render: (r) => money(r.revenue) },
            { key: 'profit', label: 'Laba', align: 'right', render: (r) => <span style={{ color: r.profit < 0 ? 'var(--danger)' : undefined }}>{money(r.profit)}</span> },
            { key: 'margin_pct', label: 'Margin', align: 'right', render: (r) => <Badge tone={r.margin_pct > 45 ? 'success' : r.margin_pct > 25 ? 'warn' : 'danger'}>{pct(r.margin_pct, 0)}</Badge> },
          ]} />
        </div>
        <div>
          <p className="strong">Distribusi per jam</p>
          <BarChart data={(data.by_hour || []).map((h) => ({ label: `${h.hour}.00`, value: h.revenue }))} format={(v) => money(v)} height={160} />
          <p className="strong" style={{ marginTop: 10 }}>Kasir</p>
          <RowBars data={(data.by_cashier || []).map((c) => ({ name: c.name || 'sistem', revenue: c.revenue }))} labelKey="name" valueKey="revenue" format={(v) => money(v)} />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ bahan baku
function RawReport({ data }) {
  const rows = data.items || [];
  const total = rows.reduce((s, r) => s + (r.purchase_cost || 0), 0);
  return (
    <div className="col">
      <div className="grid grid-4" style={{ marginTop: 10 }}>
        <Stat label="Bahan tercatat" value={rows.length} sub={`jendela ${data.window_days} hari`} />
        <Stat label="Total pembelian" value={money(total)} sub="nilai masuk gudang" />
        <Stat label="Paling cepat habis" value={rows.length ? `${fmtQty(Math.min(...rows.filter((r) => r.days_to_stockout != null).map((r) => r.days_to_stockout)) || 0, 1)} hari` : '—'} tone="danger" sub={rows[0]?.name} />
        <Stat label="Susut (adjustment -)" value={fmtQty(rows.reduce((s, r) => s + (r.waste || 0), 0), 1)} sub="satuan campuran" tone="warn" />
      </div>
      <Table rows={rows} empty="Belum ada pergerakan bahan baku" rowKey={(r) => r.item_id} columns={[
        { key: 'name', label: 'Bahan', render: (r) => <div><div className="strong">{r.name}</div><div className="muted" style={{ fontSize: 11.5 }}>{r.supplier_name || '—'}</div></div> },
        { key: 'consumed', label: 'Dipakai', align: 'right', render: (r) => <span className="num">{fmtQty(r.consumed, 2)} {r.unit}</span> },
        { key: 'avg_daily_use', label: '/hari', align: 'right', render: (r) => <span className="num muted">{fmtQty(r.avg_daily_use, 2)}</span> },
        { key: 'purchased', label: 'Dibeli', align: 'right', render: (r) => <span className="num" style={{ color: 'var(--success)' }}>{fmtQty(r.purchased, 2)}</span> },
        { key: 'waste', label: 'Susut', align: 'right', render: (r) => (r.waste ? <span className="num" style={{ color: 'var(--warning)' }}>{fmtQty(r.waste, 2)}</span> : <span className="muted">—</span>) },
        { key: 'stock_qty', label: 'Stok kini', align: 'right', render: (r) => <span className="num">{fmtQty(r.stock_qty, 2)}</span> },
        { key: 'cover', label: 'Ketahanan', align: 'right', render: (r) => (r.days_to_stockout == null ? <span className="muted">∞</span> : <span className="num" style={{ color: r.days_to_stockout <= 7 ? 'var(--danger)' : undefined }}>{fmtQty(r.days_to_stockout, 1)} hari</span>) },
        { key: 'stockout_date', label: 'Perkiraan habis', render: (r) => (r.stockout_date ? dateOnly(r.stockout_date) : <span className="muted">—</span>) },
        { key: 'status', label: '', render: (r) => <StockBadge status={r.status} /> },
      ]} />
      <p className="muted" style={{ fontSize: 12 }}>“Dipakai” gabungan penjualan langsung dan potongan BOM; “Dibeli” dari penerimaan PO.</p>
    </div>
  );
}

// ------------------------------------------------------------------ pergerakan
const MOVE_LABELS = { sale_out: 'Jual', bom_consume: 'Bahan (BOM)', purchase_in: 'Pembelian', production_in: 'Produksi', return_in: 'Retur', adjustment: 'Penyesuaian', transfer: 'Mutasi' };
function MovementReport({ data }) {
  const byDay = useMemo(() => {
    const map = new Map();
    (data || []).forEach((r) => {
      const d = map.get(r.day) || { day: dateOnly(r.day), masuk: 0, keluar: 0 };
      d.masuk += r.qty_in; d.keluar += r.qty_out;
      map.set(r.day, d);
    });
    return [...map.values()].sort((a, b) => (a.day > b.day ? 1 : -1));
  }, [data]);
  const byType = useMemo(() => {
    const map = new Map();
    (data || []).forEach((r) => map.set(r.movement_type, (map.get(r.movement_type) || 0) + r.qty_out + r.qty_in));
    return [...map.entries()].map(([k, v]) => ({ name: MOVE_LABELS[k] || k, value: v })).sort((a, b) => b.value - a.value);
  }, [data]);

  return (
    <div className="col">
      <div className="grid grid-2" style={{ marginTop: 10 }}>
        <div>
          <p className="strong">Masuk vs keluar (satuan campuran)</p>
          <LineChart data={byDay} x="day" y="keluar" height={200} format={(v) => fmtQty(v, 0)} color="var(--danger)" />
        </div>
        <div>
          <p className="strong">Volume per jenis gerakan</p>
          <RowBars data={byType} labelKey="name" valueKey="value" format={(v) => fmtQty(v, 1)} />
        </div>
      </div>
      <Table dense rows={data || []} empty="Tidak ada pergerakan stok pada rentang ini" rowKey={(r, i) => `${r.day}-${r.movement_type}-${i}`} columns={[
        { key: 'day', label: 'Tanggal', render: (r) => dateOnly(r.day) },
        { key: 'movement_type', label: 'Jenis', render: (r) => <Badge tone={r.movement_type === 'purchase_in' || r.movement_type === 'production_in' || r.movement_type === 'return_in' ? 'success' : 'warn'}>{MOVE_LABELS[r.movement_type] || r.movement_type}</Badge> },
        { key: 'lines', label: 'Baris', align: 'right', render: (r) => r.lines },
        { key: 'qty_in', label: 'Masuk', align: 'right', render: (r) => (r.qty_in ? <span className="num" style={{ color: 'var(--success)' }}>+{fmtQty(r.qty_in, 2)}</span> : <span className="muted">—</span>) },
        { key: 'qty_out', label: 'Keluar', align: 'right', render: (r) => (r.qty_out ? <span className="num" style={{ color: 'var(--danger)' }}>-{fmtQty(r.qty_out, 2)}</span> : <span className="muted">—</span>) },
      ]} />
    </div>
  );
}

// ------------------------------------------------------------------ valuasi
function ValuationReport({ data, health }) {
  const items = data.items || [];
  return (
    <div className="col">
      <div className="grid grid-4" style={{ marginTop: 10 }}>
        <Stat label="Nilai pokok persediaan" value={money(data.total_cost)} sub={`${items.length} item dilacak`} icon="📦" />
        <Stat label="Nilai jual potensial" value={money(data.total_retail)} sub={data.total_cost ? `mark-up ${pct(((data.total_retail - data.total_cost) / data.total_cost) * 100, 0)}` : '—'} tone="success" />
        <Stat label="Bahan baku" value={money(items.filter((i) => i.item_type === 'raw').reduce((s, i) => s + i.stock_value, 0))} sub="di gudang" />
        <Stat label="Barang jadi" value={money(items.filter((i) => i.item_type === 'finished').reduce((s, i) => s + i.stock_value, 0))} sub="di rak / display" />
      </div>
      <Table dense rows={items} empty="Belum ada stok bernilai" columns={[
        { key: 'name', label: 'Item', render: (r) => <span>{r.name} <span className="muted" style={{ fontSize: 11.5 }}>{r.item_type === 'raw' ? '· bahan' : '· barang jadi'}</span></span> },
        { key: 'stock_qty', label: 'Stok', align: 'right', render: (r) => `${fmtQty(r.stock_qty, 2)} ${r.unit}` },
        { key: 'cost_price', label: 'Hanya/satuan', align: 'right', render: (r) => money(r.cost_price) },
        { key: 'stock_value', label: 'Nilai pokok', align: 'right', render: (r) => <b className="num">{money(r.stock_value)}</b> },
        { key: 'retail_value', label: 'Nilai jual', align: 'right', render: (r) => <span className="num muted">{money(r.retail_value)}</span> },
        { key: 'share', label: 'Porsi', render: (r) => <ShareBar value={data.total_cost ? r.stock_value / data.total_cost : 0} /> },
      ]} />
      {health && <p className="muted" style={{ fontSize: 12 }}>Rekonsiliasi ledger: {health.items?.length || 0} item dipantau, {health.summary?.at_risk || 0} perlu perhatian.</p>}
    </div>
  );
}
const ShareBar = ({ value }) => (
  <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 110 }}>
    <span style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 6, overflow: 'hidden', display: 'block' }}>
      <span style={{ display: 'block', height: '100%', width: `${Math.min(100, value * 100)}%`, background: 'var(--accent)' }} />
    </span>
    <span className="muted" style={{ fontSize: 11 }}>{Math.round(value * 100)}%</span>
  </span>
);
void dateTime;
