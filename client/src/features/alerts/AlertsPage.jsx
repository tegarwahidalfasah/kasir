// ===========================================================================
//  Low stock alerts (Fase 3) — peringatan otomatis di dasbor admin + rencana beli.
// ===========================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { get, post } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Badge, Button, Card, EmptyState, Loading, Select, Stat, Table } from '../../ui.jsx';
import { money, qty as fmtQty, relTime, dateTime } from '../../lib/format.js';

const SEV = { critical: ['Kritis', 'danger'], warning: ['Menipis', 'warn'], info: ['Info', 'neutral'] };

export default function AlertsPage() {
  const app = useApp();
  const [data, setData] = useState(null);
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState('');
  const [lookahead, setLookahead] = useState(7);
  const [showRead, setShowRead] = useState(true);

  const load = useCallback(async () => {
    try {
      const [a, p] = await Promise.all([get(`/alerts?limit=120`), get('/alerts/replenish').catch(() => ({ items: [] }))]);
      setData(a); setPlan(p);
    } catch (e) { app.toast(e.message, 'error'); }
  }, [app]);
  useEffect(() => { load(); }, [load]);

  const act = async (fn, key) => {
    setBusy(key);
    try { await fn(); await load(); await app.refresh(); }
    catch (e) { app.toast(e.message, 'error'); } finally { setBusy(''); }
  };

  const items = (data?.items || []).filter((a) => showRead || !a.is_read);

  return (
    <>
      <div className="grid grid-4">
        <Stat label="Belum dibaca" value={data?.unread ?? 0} sub="untuk akun Anda" tone={data?.unread ? 'warn' : 'default'} icon="🔔" />
        <Stat label="Item perlu perhatian" value={data?.at_risk ?? 0} sub="stok di bawah batas" tone={data?.at_risk ? 'warn' : 'default'} icon="📦" />
        <Stat label="Kritis / habis" value={data?.critical ?? 0} sub="bisa memblokir penjualan" tone={data?.critical ? 'danger' : 'default'} icon="🚫" />
        <Stat label="Estimasi belanja" value={money(plan?.total_est_cost || 0)} sub={`${plan?.items?.length || 0} bahan disarankan`} icon="🧾" />
      </div>

      <Card
        title="Pusat peringatan"
        subtitle={`Ambang: pakai rata-rata ${data?.config?.consumption_window_days || 14} hari, proyeksi ${data?.config?.alert_lookahead_days || 7} hari ke depan`}
        actions={<>
          <Select value={String(lookahead)} onChange={setLookahead} options={[3, 7, 14, 30].map((d) => ({ value: String(d), label: `proyeksi ${d}h` }))} style={{ width: 130 }} />
          <Button size="sm" loading={busy === 'scan'} onClick={() => act(() => post(`/alerts/scan?days=14&lookahead=${lookahead}`), 'scan')}>↻ Cek ulang stok</Button>
          <Button size="sm" onClick={() => act(() => post('/alerts/read/all'), 'read')}>Tandai terbaca</Button>
        </>}>
        <div className="row between" style={{ marginBottom: 8 }}>
          <span className="muted" style={{ fontSize: 12.5 }}>Peringatan baru dibuat otomatis tiap transaksi & penerimaan barang (dedup 6 jam per item).</span>
          <Button size="sm" variant="ghost" onClick={() => setShowRead(!showRead)}>{showRead ? 'Sembunyikan yang terbaca' : 'Tampilkan semua'}</Button>
        </div>
        {loading0(data) ? <Loading label="Memuat peringatan…" /> : (
          <Table rows={items} rowKey={(r) => r.id} columns={[
            { key: 'severity', label: '', width: 78, render: (r) => <Badge tone={(SEV[r.severity] || ['', 'neutral'])[1]}>{(SEV[r.severity] || [r.severity])[0]}</Badge> },
            { key: 'message', label: 'Peringatan', render: (r) => (
              <div>
                <div className={r.is_read ? 'muted' : 'strong'}>{r.message}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {r.item_name || 'sistem'} · {relTime(r.created_at)}{r.item_type === 'raw' ? ' · bahan baku' : ''}
                  {data_json(r).stockout_date ? ` · perkiraan habis ${dateOnly(data_json(r).stockout_date)}` : ''}
                </div>
              </div>) },
            { key: 'stock_qty', label: 'Stok', align: 'right', render: (r) => <span className="num">{fmtQty(r.stock_qty, 2)} {r.unit}</span> },
            { key: 'days', label: 'Sisa hari', align: 'right', render: (r) => {
              const d = data_json(r).days_to_stockout;
              return d == null ? <span className="muted">—</span> : <span className="num" style={{ color: d <= 3 ? 'var(--danger)' : undefined }}>{fmtQty(d, 1)}</span>;
            } },
            { key: 'sug', label: 'Saran beli', align: 'right', render: (r) => {
              const p = (plan?.items || []).find((x) => x.item_id === r.item_id);
              return p ? <span className="num">{fmtQty(p.suggested_qty, 0)} {p.unit} <span className="muted">({money(p.est_cost)})</span></span> : <span className="muted">—</span>;
            } },
            { key: 'read', label: '', align: 'right', render: (r) => (r.is_read
              ? <span className="muted" style={{ fontSize: 12 }}>✓ {dateTime(r.read_at)}</span>
              : <Button size="sm" variant="ghost" onClick={() => act(() => post(`/alerts/read/${r.id}`), r.id)}>Tandai</Button>) },
          ]} empty="Aman! Tidak ada peringatan stok." />
        )}
      </Card>

      <Card title="Rencana pembelian bahan baku" subtitle="Rumus: pakai/hari × (lead time + 3 hari) + safety stock − stok sekarang">
        {plan?.items?.length ? <Table dense rows={plan.items} columns={[
          { key: 'name', label: 'Bahan', render: (r) => <div><div className="strong">{r.name}</div><div className="muted" style={{ fontSize: 11.5 }}>{r.supplier_name || 'tanpa supplier'} · lead {r.lead_time_days}h</div></div> },
          { key: 'status', label: 'Status', render: (r) => <Badge tone={(SEV[r.status === 'ok' ? 'info' : r.status] || ['—', 'neutral'])[1]}>{r.status}</Badge> },
          { key: 'stock_qty', label: 'Stok', align: 'right', render: (r) => `${fmtQty(r.stock_qty, 2)} ${r.unit}` },
          { key: 'avg_daily', label: 'Pakai/hari', align: 'right', render: (r) => fmtQty(r.avg_daily, 2) },
          { key: 'stockout_date', label: 'Perkiraan habis', render: (r) => (r.stockout_date ? dateOnly(r.stockout_date) : '—') },
          { key: 'suggested_qty', label: 'Saran pesan', align: 'right', render: (r) => <b className="num">{fmtQty(r.suggested_qty, 0)} {r.unit}</b> },
          { key: 'est_cost', label: 'Biaya', align: 'right', render: (r) => money(r.est_cost) },
        ]} /> : <EmptyState icon="✅" title="Tidak ada bahan yang mendesak" hint="Semua stok di atas reorder point." />}
        {plan?.items?.length > 0 && app.can('stock.purchase') && (
          <div className="row between" style={{ marginTop: 10 }}>
            <span className="muted" style={{ fontSize: 12.5 }}>Total perkiraan {money(plan.total_est_cost)} untuk {plan.items.length} bahan.</span>
            <Button size="sm" variant="primary" onClick={() => { location.hash = '#/purchase'; }}>Susun PO di menu Pembelian →</Button>
          </div>
        )}
      </Card>
    </>
  );
}
const loading0 = (d) => !d;
const dateOnly = (s) => String(s || '').slice(0, 10);
const data_json = (r) => { try { return JSON.parse(r.data_json || '{}'); } catch { return {}; } };
