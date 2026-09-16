// ===========================================================================
//  Pemantauan Stok Real-Time (Fase 2) + estimasi kehabisan bahan (Fase 3)
// ===========================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { get, post, downloadCsv } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Button, Card, Field, Input, Modal, NumberInput, RowBars, Select, StockBadge, Stat, Table, Tabs, Toggle, StockBar, Loading } from '../../ui.jsx';
import { money, qty as fmtQty, pct, TYPE_LABEL, MOVE_LABEL, dateTime } from '../../lib/format.js';

const FILTERS = [
  { key: 'all', label: 'Semua' }, { key: 'raw', label: 'Bahan Baku' }, { key: 'finished', label: 'Barang Jadi' },
  { key: 'at_risk', label: 'Perlu Tindakan' }, { key: 'out', label: 'Habis' },
];

export default function StockPage() {
  const app = useApp();
  const [tab, setTab] = useState('health');
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [days, setDays] = useState(14);
  const [lookahead, setLookahead] = useState(7);
  const [data, setData] = useState(null);
  const [moves, setMoves] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adjustFor, setAdjustFor] = useState(null);
  const [produceOpen, setProduceOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(true);

  const load = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    try {
      const [h, m] = await Promise.all([
        get(`/stock/health?days=${days}&lookahead=${lookahead}`),
        get('/stock/movements?limit=120'),
      ]);
      setData(h); setMoves(m);
    } catch (e) { app.toast(e.message, 'error'); } finally { setLoading(false); }
  }, [days, lookahead, app]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return undefined;
    const id = setInterval(() => load(true), 25000);
    return () => clearInterval(id);
  }, [auto, load]);

  const items = useMemo(() => {
    let list = data?.items || [];
    if (filter === 'raw') list = list.filter((i) => i.item_type === 'raw');
    if (filter === 'finished') list = list.filter((i) => i.item_type === 'finished');
    if (filter === 'at_risk') list = list.filter((i) => i.status !== 'ok');
    if (filter === 'out') list = list.filter((i) => i.status === 'out');
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter((i) => i.name.toLowerCase().includes(needle));
    return list;
  }, [data, filter, q]);

  const s = data?.summary;
  const columns = [
    { key: 'name', label: 'Item', render: (r) => (
      <div>
        <div className="strong">{r.name}</div>
        <div className="muted" style={{ fontSize: 11.5 }}>
          {TYPE_LABEL[r.item_type]}{r.recipe_lines ? ` · ${r.recipe_lines} bahan` : ''}{r.supplier_name ? ` · ${r.supplier_name}` : ''}
        </div>
      </div>
    ) },
    { key: 'stock', label: 'Stok', align: 'right', render: (r) => (
      <div>
        <div className="num strong">{fmtQty(r.stock_qty, 3)} <span className="muted" style={{ fontWeight: 400 }}>{r.unit}</span></div>
        <StockBar value={r.stock_qty} target={r.reorder_point_effective || r.min_stock} status={r.status} />
      </div>
    ) },
    { key: 'avg', label: `Pakai/${days}h`, align: 'right', render: (r) => <span className="num">{fmtQty(r.avg_daily, 2)} {r.unit}/hari</span> },
    { key: 'rp', label: 'Batas Pesan', align: 'right', render: (r) => <span className="num muted">{fmtQty(r.reorder_point_effective, 1)}</span> },
    { key: 'days', label: 'Estimasi Habis', align: 'right', render: (r) => (r.days_to_stockout == null
      ? <span className="muted">—</span>
      : <span className={r.days_to_stockout <= lookahead ? 'strong' : ''} style={{ color: r.days_to_stockout <= lookahead ? 'var(--danger)' : undefined }}>
          {fmtQty(r.days_to_stockout, 1)} hari{r.stockout_date ? ` · ${r.stockout_date.slice(5)}` : ''}
        </span>) },
    { key: 'value', label: 'Nilai', align: 'right', render: (r) => <span className="num">{money(r.est_value)}</span> },
    { key: 'status', label: 'Status', render: (r) => <StockBadge status={r.status} title={`Reorder point ${fmtQty(r.reorder_point_effective, 1)} ${r.unit}`} /> },
    { key: 'act', label: '', align: 'right', render: (r) => (
      <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
        {app.can('stock.adjust') && <Button size="sm" onClick={() => setAdjustFor(r)}>Opname</Button>}
        {app.can('stock.produce') && r.item_type === 'finished' && <Button size="sm" variant="outline" onClick={() => { setProduceOpen(r.id); }}>Produksi</Button>}
      </div>
    ) },
  ];

  return (
    <>
      <div className="grid grid-4">
        <Stat label="Nilai persediaan" value={money(s?.stock_value)} sub={`${s?.total || 0} item dilacak`} icon="📦" />
        <Stat label="Perlu perhatian" value={s?.at_risk ?? 0} sub={`${s?.will_run_out_soon || 0} item habis ≤ ${lookahead} hari`} tone={s?.at_risk ? 'warn' : 'default'} icon="⚠️" />
        <Stat label="Stok habis" value={s?.out ?? 0} sub="butuh pembelian / opname" tone={s?.out ? 'danger' : 'default'} icon="🚫" />
        <Stat label="Pembaruan" value={data?.generated_at?.slice(11, 16) || '—'} sub="otomatis tiap 25 detik" icon="🔄" />
      </div>

      <Card
        title="Kesehatan stok"
        subtitle={`Dasar perhitungan: pemakaian ${days} hari terakhir, ambang peringatan ${lookahead} hari ke depan`}
        actions={<>
          <Toggle checked={auto} onChange={setAuto} label="auto" />
          <Button size="sm" onClick={() => load()}>↻ Muat</Button>
          {app.can('report.export') && <Button size="sm" onClick={() => downloadCsv('/reports/export/stock', 'stok.csv')}>⬇ CSV</Button>}
        </>}>
        <div className="row between" style={{ marginBottom: 10 }}>
          <Tabs items={FILTERS} value={filter} onChange={setFilter} />
          <div className="row" style={{ gap: 6 }}>
            <Select value={String(days)} onChange={setDays} options={[7, 14, 30, 60, 90].map((d) => ({ value: String(d), label: `${d} hari` }))} style={{ width: 104 }} />
            <Select value={String(lookahead)} onChange={setLookahead} options={[3, 7, 14, 30].map((d) => ({ value: String(d), label: `≤ ${d} hari` }))} style={{ width: 104 }} />
            <Input placeholder="cari…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 150 }} />
          </div>
        </div>
        {loading ? <Loading label="Menghitung kesehatan stok…" /> : (
          <Tabs items={[{ key: 'health', label: 'Barang & Bahan' }, { key: 'ledger', label: 'Buku Stok (ledger)' }]} value={tab} onChange={setTab} />
        )}
        {tab === 'health' && <Table columns={columns} rows={items} empty="Tidak ada item yang cocok" />}
        {tab === 'ledger' && <LedgerTable rows={moves} />}
      </Card>

      <AdjustModal item={adjustFor} onClose={() => setAdjustFor(null)} onSaved={() => { setAdjustFor(null); load(true); app.refresh(); }} />
      {produceOpen && (
        <ProduceModal
          itemId={produceOpen}
          items={(data?.items || []).filter((i) => i.item_type === 'finished')}
          bom={app.bom}
          catalog={app.catalog}
          onClose={() => setProduceOpen(false)}
          onSaved={() => { setProduceOpen(false); load(true); app.refresh(); }}
        />
      )}
      <div className="grid grid-2">
        <Card title="Bahan yang paling cepat habis" subtitle="estimasi dari laju pemakaian">
          <RowBars format={(v) => `${fmtQty(v, 1)} hari`} labelKey="name" valueKey="days"
            data={(data?.items || []).filter((i) => i.item_type === 'raw' && i.days_to_stockout != null).sort((a, b) => a.days_to_stockout - b.days_to_stockout).slice(0, 8).map((i) => ({ name: i.name, days: i.days_to_stockout }))} />
          {!(data?.items || []).filter((i) => i.days_to_stockout != null).length && <p className="muted">Belum ada data pemakaian.</p>}
        </Card>
        <Card title="Cara angka ini dihitung">
          <ul className="muted" style={{ fontSize: 12.5, paddingLeft: 18, margin: 0, lineHeight: 1.7 }}>
            <li><b>Pakai/hari</b> = total stok keluar (penjualan + potongan BOM) ÷ {days} hari.</li>
            <li><b>Batas pesan</b> = maks dari <i>reorder point</i> manual, <i>min_stock</i>, dan pemakaian/hari × lead time + safety stock.</li>
            <li><b>Estimasi habis</b> = stok ÷ pakai per hari.</li>
            <li>Barang jadi <i>made-to-order</i> diukur dari kapasitas bahan baku, bukan rak.</li>
            <li>Semua pergerakan tercatat di buku stok sehingga bisa diaudit 1 per 1.</li>
          </ul>
        </Card>
      </div>
      <p className="muted" style={{ fontSize: 11.5 }}>
        Tidak menemukan selisih? Stok selalu dihitung ulang dari buku stok — gunakan <code>POST /api/stock/reconcile</code> (menu Pengaturan → Sistem) bila perlu.
      </p>
    </>
  );
}

function LedgerTable({ rows }) {
  if (!rows?.length) return <div className="empty">Belum ada pergerakan stok.</div>;
  return (
    <Table dense rows={rows} columns={[
      { key: 'created_at', label: 'Waktu', render: (r) => <span className="nowrap muted">{dateTime(r.created_at)}</span> },
      { key: 'item', label: 'Item', render: (r) => <span>{r.item_name} <span className="muted">({TYPE_LABEL[r.item_type]})</span></span> },
      { key: 'movement_type', label: 'Jenis', render: (r) => <span className="badge">{MOVE_LABEL[r.movement_type] || r.movement_type}</span> },
      { key: 'qty', label: 'Qty', align: 'right', render: (r) => <span style={{ color: r.qty > 0 ? 'var(--success)' : 'var(--danger)' }} className="num strong">{r.qty > 0 ? '+' : ''}{fmtQty(r.qty, 3)} {r.unit}</span> },
      { key: 'balance_after', label: 'Saldo', align: 'right', render: (r) => <span className="num muted">{fmtQty(r.balance_after, 3)}</span> },
      { key: 'reason', label: 'Keterangan', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.reason || '—'}{r.user_name ? ` · ${r.user_name}` : ''}</span> },
    ]} />
  );
}

function AdjustModal({ item, onClose, onSaved }) {
  const app = useApp();
  const [count, setCount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (item) { setCount(String(item.stock_qty)); setReason(''); } }, [item]);
  if (!item) return null;
  const delta = (Number(count) || 0) - item.stock_qty;
  return (
    <Modal open onClose={onClose} title={`Stock opname — ${item.name}`} width="420px"
      footer={<><Button onClick={onClose}>Batal</Button>
        <Button variant="primary" loading={busy} disabled={!delta} onClick={async () => {
          setBusy(true);
          try { await post('/stock/adjust', { items: [{ item_id: item.id, counted_qty: Number(count) }], reason }); app.toast('Stok disesuikan', 'success'); onSaved(); }
          catch (e) { app.toast(e.message, 'error'); } finally { setBusy(false); }
        }}>Simpan selisih {delta ? `${delta > 0 ? '+' : ''}${fmtQty(delta, 3)}` : ''}</Button></>}>
      <div className="col">
        <Field label={`Hitung fisik (satuan ${item.unit})`}><NumberInput value={count} step="any" min={0} onChange={setCount} className="input input-money" /></Field>
        <div className="row between" style={{ fontSize: 12.5 }}>
          <span className="muted">Sistem saat ini: {fmtQty(item.stock_qty, 3)} {item.unit}</span>
          <b style={{ color: delta ? 'var(--warning)' : undefined }}>Selisih: {delta > 0 ? '+' : ''}{fmtQty(delta, 3)} {item.unit}</b>
        </div>
        <Field label="Alasan (opsional)"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="mis. susut, pecah, koreksi hitung" /></Field>
        <small className="muted">Penyesuaian dicatat sebagai gerakan <code>adjustment</code> di buku stok — tidak menimpa riwayat.</small>
      </div>
    </Modal>
  );
}

function ProduceModal({ itemId, items, bom, catalog, onClose, onSaved }) {
  const app = useApp();
  const [id, setId] = useState(itemId);
  const [qty, setQty] = useState(20);
  const [busy, setBusy] = useState(false);
  const item = catalog.find((c) => c.id === id);
  const rows = bom[id] || [];
  const yieldF = Math.max(1, Number(item?.yield_pct) || 100) / 100;
  const need = rows.map((r) => ({ ...r, need: Math.round(((Number(qty) || 0) * r.qty * (1 + (r.waste_pct || 0) / 100)) / yieldF * 1000) / 1000 }));
  const shortage = need.filter((n) => n.need > (catalog.find((c) => c.id === n.raw_item_id)?.stock_qty || 0));
  return (
    <Modal open onClose={onClose} title="Produksi (tambah stok barang jadi)" width="480px"
      footer={<><Button onClick={onClose}>Batal</Button>
        <Button variant="primary" loading={busy} disabled={!qty || shortage.length > 0} onClick={async () => {
          setBusy(true);
          try { await post('/stock/produce', { item_id: id, qty: Number(qty) }); app.toast('Produksi dicatat', 'success'); onSaved(); }
          catch (e) { app.toast(e.message, 'error'); } finally { setBusy(false); }
        }}>Catat produksi</Button></>}>
      <div className="grid grid-2">
        <Field label="Barang jadi"><Select value={id} onChange={setId} options={items.map((i) => ({ value: i.id, label: i.name }))} /></Field>
        <Field label="Jumlah diproduksi"><NumberInput value={qty} min={1} onChange={setQty} className="input input-money" /></Field>
      </div>
      <p className="strong" style={{ margin: '10px 0 6px' }}>Bahan yang akan dipakai</p>
      {need.length ? need.map((n) => (
        <div key={n.raw_item_id} className="row between" style={{ fontSize: 13, padding: '5px 0', borderBottom: '1px dashed var(--border)' }}>
          <span>{n.raw_name} {n.waste_pct ? <span className="muted">(susut {n.waste_pct}%)</span> : null}</span>
          <span className={`num ${n.need > (catalog.find((c) => c.id === n.raw_item_id)?.stock_qty || 0) ? '' : ''}`} style={{ color: n.need > (catalog.find((c) => c.id === n.raw_item_id)?.stock_qty || 0) ? 'var(--danger)' : undefined }}>
            {fmtQty(n.need, 3)} {n.raw_unit} <span className="muted">/ tersedia {fmtQty(catalog.find((c) => c.id === n.raw_item_id)?.stock_qty, 2)}</span>
          </span>
        </div>
      )) : <p className="muted">Item ini tidak punya resep; produksi hanya menambah stok tanpa memotong bahan.</p>}
      {shortage.length > 0 && <div className="hint-box" style={{ marginTop: 8, borderColor: 'var(--danger)' }}>⚠️ Bahan kurang: {shortage.map((x) => x.raw_name).join(', ')}</div>}
    </Modal>
  );
}

void pct;
