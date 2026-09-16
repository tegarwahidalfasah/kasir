// ===========================================================================
//  Riwayat transaksi: cetak ulang struk (dari snapshot), pembatalan & retur
// ===========================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { get, post } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Badge, Button, Card, Field, Input, Loading, Modal, NumberInput, Select, Stat, Table } from '../../ui.jsx';
import { money, qty as fmtQty, dateTime, relTime, dateRange } from '../../lib/format.js';
import { Receipt, printReceipt, buildReceiptLines } from '../receipt/receipt.jsx';

const STATUS = { completed: ['Selesai', 'success'], voided: ['Dibatalkan', 'danger'], refunded: ['Refund', 'warn'], open: ['Tertahan', 'neutral'] };

export default function SalesHistory() {
  const app = useApp();
  const [rows, setRows] = useState(null);
  const [from, setFrom] = useState(dateRange('tujuh').from);
  const [to, setTo] = useState(dateRange('tujuh').to);
  const [status, setStatus] = useState('');
  const [cashier, setCashier] = useState('');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState(null);
  const [voiding, setVoiding] = useState(null);
  const [refund, setRefund] = useState(null);

  const load = useCallback(async () => {
    const p = new URLSearchParams({ from, to, limit: '200' });
    if (status) p.set('status', status);
    if (cashier) p.set('cashier_id', cashier);
    try { setRows(await get(`/sales?${p}`)); } catch (e) { app.toast(e.message, 'error'); }
  }, [from, to, status, cashier, app]);
  useEffect(() => { load(); }, [load]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows || []).filter((r) => !needle || (r.invoice_no || '').toLowerCase().includes(needle) || (r.customer_name || '').toLowerCase().includes(needle));
  }, [rows, q]);

  const revenue = (rows || []).filter((r) => r.status === 'completed').reduce((s, r) => s + r.grand_total, 0);
  const cost = (rows || []).filter((r) => r.status === 'completed').reduce((s, r) => s + (r.cost_total || 0), 0);
  const voided = (rows || []).filter((r) => r.status !== 'completed').length;

  return (
    <>
      <div className="grid grid-4">
        <Stat label="Omzet (rentang ini)" value={money(revenue)} sub={`${(rows || []).length} struk`} icon="🧾" />
        <Stat label="Laba kotor" value={money(revenue - cost)} sub={revenue ? `${Math.round(((revenue - cost) / revenue) * 100)}% margin` : '—'} icon="💰" tone="success" />
        <Stat label="Batal / refund" value={voided} sub="stok otomatis dikembalikan" tone={voided ? 'warn' : 'default'} icon="↩️" />
        <Stat label="Rentang" value={`${from.slice(5)} → ${to.slice(5)}`} sub="filter di bawah" icon="📅" />
      </div>

      <Card title="Riwayat transaksi" actions={<Button size="sm" onClick={load}>↻ Muat ulang</Button>}>
        <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} />
          <span className="muted">–</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} />
          <Select value={status} onChange={setStatus} style={{ width: 150 }} options={[{ value: '', label: 'semua status' }, { value: 'completed', label: 'Selesai' }, { value: 'voided', label: 'Dibatalkan' }, { value: 'refunded', label: 'Refund' }, { value: 'open', label: 'Tertahan' }]} />
          <Select value={cashier} onChange={setCashier} style={{ width: 170 }} options={[{ value: '', label: 'semua kasir' }, ...uniq((rows || []).map((r) => [r.cashier_name, r.cashier_id]))]} />
          <Input placeholder="cari no. struk / pelanggan…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
        </div>
        {!rows ? <Loading label="Memuat transaksi…" /> : (
          <Table rows={list} onRow={(r) => setDetail(r.id)} columns={[
            { key: 'invoice_no', label: 'No. struk', render: (r) => (
              <div><div className="strong">{r.invoice_no}</div><div className="muted" style={{ fontSize: 11.5 }}>{dateTime(r.created_at)} · {r.cashier_name || '—'}</div></div>) },
            { key: 'status', label: 'Status', render: (r) => <Badge tone={(STATUS[r.status] || ['', 'neutral'])[1]}>{(STATUS[r.status] || [r.status])[0]}</Badge> },
            { key: 'item_count', label: 'Item', align: 'right', render: (r) => <span className="num">{fmtQty(r.item_count, 0)} <span className="muted">({r.line_count} baris)</span></span> },
            { key: 'customer_name', label: 'Pelanggan', render: (r) => r.customer_name || <span className="muted">—</span> },
            { key: 'order_type', label: 'Tipe', render: (r) => <span className="muted">{ORDER[r.order_type] || r.order_type}</span> },
            { key: 'payment_name', label: 'Bayar', render: (r) => r.payment_name || <span className="muted">—</span> },
            { key: 'discount_total', label: 'Diskon', align: 'right', render: (r) => (r.discount_total ? <span style={{ color: 'var(--danger)' }} className="num">-{money(r.discount_total)}</span> : <span className="muted">—</span>) },
            { key: 'grand_total', label: 'Total', align: 'right', render: (r) => <b className="num">{money(r.grand_total)}</b> },
            { key: 'act', label: '', align: 'right', render: (r) => (
              <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setDetail(r.id); }}>Struk</Button>
                {app.can('sale.void') && r.status === 'completed' && <>
                  <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setRefund(r); }}>Retur</Button>
                  <Button size="sm" variant="danger" onClick={(e) => { e.stopPropagation(); setVoiding(r); }}>Batalkan</Button>
                </>}
              </div>) },
          ]} empty="Tidak ada transaksi pada rentang ini" />
        )}
      </Card>

      <ReceiptModal id={detail} onClose={() => setDetail(null)} />
      <VoidModal row={voiding} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); load(); app.refresh(); }} />
      <RefundModal row={refund} onClose={() => setRefund(null)} onDone={() => { setRefund(null); load(); app.refresh(); }} />
    </>
  );
}

const ORDER = { dine_in: 'Di tempat', take_away: 'Bawa pulang', delivery: 'Kirim', online: 'Online' };
const uniq = (pairs) => { const m = new Map(); pairs.forEach(([n, i]) => { if (i) m.set(i, n || i); }); return [...m.entries()].map(([value, label]) => ({ value, label })); };

function ReceiptModal({ id, onClose }) {
  const app = useApp();
  const [sale, setSale] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { if (id) { setSale(null); setErr(''); get(`/sales/${id}`).then(setSale).catch((e) => setErr(e.message)); } }, [id]);
  if (!id) return null;
  const snap = sale?.snapshot || {};
  const cfg = snap.receipt || app.settings.receipt;
  const lines = sale ? buildReceiptLines({ snapshot: snap, tx: { ...sale, payment_name: sale.payment_name }, items: sale.items || [], receipt: cfg, store: app.settings.store }) : [];
  return (
    <Modal open onClose={onClose} width="460px" title={sale ? `${sale.invoice_no} · ${(STATUS[sale.status] || [sale.status])[0]}` : 'Memuat…'}
      footer={<>
        {sale && (
          <Button variant="primary" onClick={() => printReceipt({
            title: `Struk ${sale.invoice_no}`, lines,
            width: Number(snap.receipt?.paper_width) || 58, fontScale: Number(snap.receipt?.font_scale) || 1,
          })}>🖨 Cetak ulang</Button>
        )}
        {sale && sale.status === 'completed' && app.can('sale.void') && (
          <Button variant="danger" onClick={async () => {
            const ok = await app.confirm({ title: `Batalkan ${sale.invoice_no}?`, message: 'Semua stok (barang jadi & bahan baku) dikembalikan lewat buku stok. Nilai transaksi menjadi nol.', danger: true, okText: 'Batalkan transaksi' });
            if (!ok) return;
            try {
              await post(`/sales/${sale.id}/void`, { reason: 'pembatalan dari riwayat' });
              app.toast('Transaksi dibatalkan, stok dikembalikan', 'success');
              setSale(await get(`/sales/${sale.id}`));   // muat ulang status -> riwayat di layar ikut berubah
              app.refresh();
            } catch (e) { app.toast(e.message, 'error'); }
          }}>Batalkan</Button>
        )}
        <Button onClick={onClose}>Tutup</Button>
      </>}>
      {err && <div className="hint-box" style={{ borderColor: 'var(--danger)' }}>⚠️ {err}</div>}
      {!sale && !err && <Loading />}
      {sale && (
        <>
          <Receipt snapshot={snap} tx={sale} items={sale.items || []} receipt={cfg} store={app.settings.store} />
          {(sale.movements || []).length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>Pergerakan stok terkait ({sale.movements.length})</summary>
              <ul className="muted" style={{ fontSize: 12, paddingLeft: 18, margin: '6px 0' }}>
                {sale.movements.map((m, i) => <li key={i}>{m.movement_type}: {fmtQty(m.qty, 3)} {m.unit || ''} → saldo {fmtQty(m.balance_after, 3)}{m.reason ? ` (${m.reason})` : ''}</li>)}
              </ul>
            </details>
          )}
          {sale.voided_at && <div className="hint-box" style={{ marginTop: 8 }}>Dibatalkan {dateTime(sale.voided_at)} — {sale.void_reason || 'tanpa alasan'}</div>}
        </>
      )}
    </Modal>
  );
}

function VoidModal({ row, onClose, onDone }) {
  const app = useApp();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!row) return null;
  return (
    <Modal open onClose={onClose} width="420px" title={`Batalkan ${row.invoice_no}?`}
      footer={<><Button onClick={onClose}>Batal</Button>
        <Button variant="danger" loading={busy} onClick={async () => {
          setBusy(true);
          try { await post(`/sales/${row.id}/void`, { reason: reason || 'pembatalan manual' }); app.toast('Transaksi dibatalkan', 'success'); onDone(); }
          catch (e) { app.toast(e.message, 'error'); } finally { setBusy(false); }
        }}>Batalkan transaksi</Button></>}>
      <div className="col">
        <p className="muted" style={{ fontSize: 13 }}>Stok barang jadi dan seluruh bahan baku dari resep akan dikembalikan secara proporsional lewat ledger (bukan penghapusan data).</p>
        <Field label="Alasan"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="mis. salah input / pelanggan batal" /></Field>
      </div>
    </Modal>
  );
}

function RefundModal({ row, onClose, onDone }) {
  const app = useApp();
  const [items, setItems] = useState(null);
  const [pick, setPick] = useState('');
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!row) { setItems(null); return; }
    get(`/sales/${row.id}`).then((s) => { setItems(s.items || []); setPick((s.items || [])[0]?.item_id || ''); }).catch(() => setItems([]));
  }, [row]);
  if (!row) return null;
  const line = (items || []).find((i) => i.item_id === pick);
  return (
    <Modal open onClose={onClose} width="440px" title={`Retur sebagian — ${row.invoice_no}`}
      footer={<><Button onClick={onClose}>Batal</Button>
        <Button variant="primary" loading={busy} disabled={!pick} onClick={async () => {
          setBusy(true);
          try { await post(`/sales/${row.id}/refund`, { item_id: pick, qty: Number(qty) || 1, reason: reason || 'retur' }); app.toast('Retur dicatat, stok kembali', 'success'); onDone(); }
          catch (e) { app.toast(e.message, 'error'); } finally { setBusy(false); }
        }}>Catat retur</Button></>}>
      {!items ? <Loading /> : (
        <div className="col">
          <Field label="Barang yang diretur"><Select value={pick} onChange={setPick} options={(items || []).map((i) => ({ value: i.item_id, label: `${i.name_snapshot} (${fmtQty(i.qty, 1)} terjual)` }))} /></Field>
          <div className="grid grid-2">
            <Field label={`Jumlah (maks ${line ? fmtQty(line.qty, 1) : 0})`}><NumberInput value={qty} min={0.001} step="any" onChange={setQty} className="input" /></Field>
            <Field label="Alasan"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="rusak / tidak sesuai" /></Field>
          </div>
          <small className="muted">Retur mengembalikan stok sesuai porsi bahan di BOM saat transaksi dibuat (menggunakan snapshot, bukan harga/resep hari ini).</small>
        </div>
      )}
    </Modal>
  );
}

void relTime;
