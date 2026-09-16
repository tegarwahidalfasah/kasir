// ===========================================================================
//  Dasbor: penjualan, laba, stok & peringatan dalam satu layar (Fase 3)
// ===========================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { get } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Badge, BarChart, Button, Card, EmptyState, LineChart, Loading, RowBars, Stat, StockBadge, Table } from '../../ui.jsx';
import { money, qty as fmtQty, pct, relTime, dateRange, dayName } from '../../lib/format.js';

export default function Dashboard({ navigate }) {
  const app = useApp();
  const [range, setRange] = useState('tujuh');
  const [summary, setSummary] = useState(null);
  const [health, setHealth] = useState(null);
  const [alerts, setAlerts] = useState(null);
  const [err, setErr] = useState('');
  const { from, to } = useMemo(() => dateRange(range), [range]);

  const load = useCallback(async () => {
    setErr('');
    try {
      const [s, h, a] = await Promise.all([
        get(`/reports/summary?from=${from}&to=${to}`),
        get('/stock/health').catch(() => null),
        get('/alerts?limit=6').catch(() => null),
      ]);
      setSummary(s); setHealth(h); setAlerts(a);
    } catch (e) { setErr(e.message); }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const totals = summary?.totals;
  const byDay = summary?.by_day || [];
  const risky = (health?.items || []).filter((i) => i.status !== 'ok').slice(0, 8);
  const hourPeak = [...(summary?.by_hour || [])].sort((a, b) => b.revenue - a.revenue)[0];

  return (
    <>
      <div className="row between" style={{ marginBottom: 10 }}>
        <div className="tabs">
          {[['hariini', 'Hari ini'], ['tujuh', '7 hari'], ['tiga_puluh', '30 hari'], ['sembilan_puluh', '90 hari']].map(([k, l]) => (
            <button key={k} className={`tab ${range === k ? 'active' : ''}`} onClick={() => setRange(k)}>{l}</button>
          ))}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <Button size="sm" variant="ghost" onClick={load}>↻ Segarkan</Button>
          {app.can('report.export') && <Button size="sm" variant="ghost" onClick={() => { location.hash = '#/reports'; }}>Laporan lengkap →</Button>}
        </div>
      </div>

      {err && <div className="card" style={{ marginBottom: 12 }}><div className="card-body">⚠️ {err} <Button size="sm" onClick={load}>Coba lagi</Button></div></div>}
      {!summary && !err && <Loading label="Menyusun dasbor…" />}

      {summary && <>
        <div className="grid grid-4">
          <Stat label="Omzet" value={money(totals.gross_revenue)} sub={`${totals.tx_count} transaksi · ${from} → ${to}`} icon="🧾" />
          <Stat label="Laba kotor" value={money(totals.gross_profit)} sub={`margin ${pct(totals.margin_pct)} setelah pajak & HPP`} tone="success" icon="💰" />
          <Stat label="Rata-rata struk" value={money(totals.avg_ticket)} sub={`diskon diberikan ${money(totals.discount)}`} icon="🎯" />
          <Stat label="Batal" value={totals.voided} sub={hourPeak ? `jam ramai: ${hourPeak.hour}.00 (${money(hourPeak.revenue)})` : '—'} tone={totals.voided ? 'warn' : 'default'} icon="↩️" />
        </div>

        <div className="grid grid-3">
          <Card className="span-2" title="Tren penjualan harian" subtitle="batang = omzet, garis = laba kotor">
            <LineChart data={byDay.map((d) => ({ ...d, day: d.day?.slice(5), revenue: d.revenue, profit: d.profit }))} x="day" y="revenue" height={200}
              format={(v) => money(v)} />
            <div className="row between" style={{ marginTop: 6 }}>
              <span className="muted" style={{ fontSize: 12 }}>{byDay[0]?.day} → {byDay[byDay.length - 1]?.day}</span>
              <span className="row" style={{ gap: 10, fontSize: 12 }}>
                <Legend color="var(--accent)" label="Omzet" />
                <Legend color="var(--success)" label="Laba" />
              </span>
            </div>
          </Card>
          <Card title="Stok & peringatan" subtitle={`nilai persediaan ${money(health?.summary?.stock_value)}`}>
            {app.alertsUnread > 0 ? (
              <button className="alert-cta" onClick={() => navigate?.('/alerts')}>
                <b>🔔 {app.alertsUnread} peringatan belum dibaca</b>
                <span className="muted">Buka pusat peringatan →</span>
              </button>
            ) : <div className="empty" style={{ background: 'transparent' }}>Tidak ada peringatan baru. 👌</div>}
            <Table dense rows={risky} empty="Semua stok aman" columns={[
              { key: 'name', label: 'Item', render: (r) => <span title={TYPE(r)}>{r.name}</span> },
              { key: 'stock', label: 'Stok', align: 'right', render: (r) => <span className="num">{fmtQty(r.stock_qty, 1)} {r.unit}</span> },
              { key: 'days', label: 'Sisa', align: 'right', render: (r) => (r.days_to_stockout == null ? <span className="muted">—</span> : <span className={r.days_to_stockout <= 3 ? 'strong' : ''} style={{ color: r.days_to_stockout <= 3 ? 'var(--danger)' : undefined }}>{fmtQty(r.days_to_stockout, 1)}h</span>) },
              { key: 'status', label: '', align: 'right', render: (r) => <StockBadge status={r.status} /> },
            ]} />
          </Card>
        </div>

        <div className="grid grid-3">
          <Card title="Jam ramai" subtitle="revenue per jam pada rentang terpilih">
            <BarChart data={(summary.by_hour || []).map((h) => ({ label: `${h.hour}.00`, value: h.revenue }))} format={(v) => money(v)} height={170} />
          </Card>
          <Card title="Produk terlaris" subtitle="berdasarkan omzet">
            <RowBars data={(summary.by_item || []).slice(0, 8)} labelKey="name" valueKey="revenue" format={(v) => money(v)} />
            {!(summary.by_item || []).length && <EmptyState icon="📉" title="Belum ada penjualan" hint="Mulai transaksi di layar Kasir." />}
          </Card>
          <Card title="Metode pembayaran">
            <RowBars data={(summary.by_payment || []).map((p) => ({ name: `${p.name}`, revenue: p.amount }))} labelKey="name" valueKey="revenue" format={(v) => money(v)} />
            <div className="row between" style={{ marginTop: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>Pajak dipungut {money(totals.tax)} · service {money(totals.service)}</span>
            </div>
          </Card>
        </div>

        <div className="grid grid-2">
          <Card title="Performa kasir">
            <Table dense rows={summary.by_cashier || []} empty="Belum ada data" columns={[
              { key: 'name', label: 'Kasir', render: (r) => r.name || <span className="muted">sistem</span> },
              { key: 'tx_count', label: 'Transaksi', align: 'right', render: (r) => <span className="num">{r.tx_count}</span> },
              { key: 'revenue', label: 'Omzet', align: 'right', render: (r) => <span className="num strong">{money(r.revenue)}</span> },
              { key: 'avg', label: 'Rata-rata', align: 'right', render: (r) => <span className="num muted">{money(r.tx_count ? r.revenue / r.tx_count : 0)}</span> },
            ]} />
          </Card>
          <Card title="Peringatan terakhir" actions={<Button size="sm" variant="ghost" onClick={() => navigate?.('/alerts')}>Semua →</Button>}>
            <Table dense rows={alerts?.items || []} empty="Tidak ada" columns={[
              { key: 'message', label: 'Pesan', render: (r) => (
                <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                  <Badge tone={r.severity === 'critical' ? 'danger' : r.severity === 'warning' ? 'warn' : 'neutral'}>{r.severity}</Badge>
                  <span className={r.is_read ? 'muted' : 'strong'} style={{ fontSize: 12.5 }}>{r.message}</span>
                </div>) },
              { key: 'created_at', label: '', align: 'right', render: (r) => <span className="muted" style={{ fontSize: 11.5 }}>{relTime(r.created_at)}</span> },
            ]} />
          </Card>
        </div>
      </>}
    </>
  );
}

const Legend = ({ color, label }) => (
  <span className="row" style={{ gap: 4, fontSize: 12 }}>
    <i style={{ width: 10, height: 3, background: color, display: 'inline-block', borderRadius: 2 }} />{label}
  </span>
);
const TYPE = (r) => (r.item_type === 'raw' ? 'bahan baku' : 'barang jadi');
void dayName;
