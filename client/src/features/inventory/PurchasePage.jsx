// ===========================================================================
//  Pembelian bahan baku (Purchase Order) + supplier. Menerima barang = stok
//  bahan naik & harga pokok moving-average diperbarui otomatis.
// ===========================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { get, post, put, del } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Badge, Button, Card, Field, Input, Modal, NumberInput, Select, Stat, Table, Tabs, Textarea } from '../../ui.jsx';
import { money, qty as fmtQty, dateTime, dateOnly } from '../../lib/format.js';

const PO_STATUS = { draft: ['Draf', 'neutral'], ordered: ['Dipesan', 'warn'], partial: ['Sebagang', 'accent'], received: ['Diterima', 'success'], cancelled: ['Batal', 'danger'] };

export default function PurchasePage() {
  const app = useApp();
  const can = app.can('stock.purchase');
  const [tab, setTab] = useState('po');
  const [rows, setRows] = useState([]);
  const [suggest, setSuggest] = useState([]);
  const [editing, setEditing] = useState(null);
  const [detail, setDetail] = useState(null);
  const [suppliers, setSuppliers] = useState([]);

  const load = useCallback(async () => {
    try {
      const [po, sp] = await Promise.all([get('/purchase-orders'), get('/suppliers')]);
      setRows(po); setSuppliers(sp);
    } catch (e) { app.toast(e.message, 'error'); }
  }, [app]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    get('/alerts/replenish').then((o) => setSuggest(o.items || [])).catch(() => setSuggest([]));
  }, []);

  const openSuggest = useMemo(() => rows.filter((r) => r.status === 'ordered' || r.status === 'partial' || r.status === 'draft'), [rows]);
  const spend = useMemo(() => rows.filter((r) => r.status === 'received').reduce((s, r) => s + (r.total_amount || 0), 0), [rows]);
  const soon = useMemo(() => suggest.filter((s) => s.days_to_stockout != null && s.days_to_stockout <= 7), [suggest]);

  return (
    <>
      <div className="grid grid-4">
        <Stat label="PO terbuka" value={openSuggest.length} sub="menunggu penerimaan" icon="🚚" tone={openSuggest.length ? 'warn' : 'default'} />
        <Stat label="Nilai PO diterima" value={money(spend)} sub="total pembelian selesai" icon="💰" />
        <Stat label="Bahan perlu dipesan" value={suggest.length} sub={`${soon.length} di antaranya ≤ 7 hari habis`} tone={suggest.length ? 'danger' : 'default'} icon="📋" />
        <Stat label="Supplier terdaftar" value={suppliers.length} sub="kontak & lead time" icon="🏢" />
      </div>

      <Card
        title="Pembelian bahan baku"
        subtitle="Urutan: buat PO → barang datang → terima (stok & HPP otomatis menyesuaikan)."
        actions={<>
          <Button size="sm" onClick={() => setTab(tab === 'po' ? 'supplier' : 'po')}>{tab === 'po' ? 'Supplier' : 'Kembali ke PO'}</Button>
          {can && tab === 'po' && <Button size="sm" variant="primary" onClick={() => setEditing({ items: [] })}>+ Buat PO</Button>}
        </>}>
        <Tabs items={[{ key: 'po', label: 'Purchase Order', badge: rows.length }, { key: 'suggest', label: 'Saran Pembelian', badge: suggest.length }, { key: 'supplier', label: 'Supplier', badge: suppliers.length }]} value={tab} onChange={setTab} />

        {tab === 'po' && <Table rows={rows} columns={[
          { key: 'po_number', label: 'No. PO', render: (r) => <div><div className="strong">{r.po_number}</div><div className="muted" style={{ fontSize: 11.5 }}>{dateTime(r.created_at)} · {r.created_by_name || '—'}</div></div> },
          { key: 'supplier', label: 'Supplier', render: (r) => r.supplier_name || <span className="muted">—</span> },
          { key: 'status', label: 'Status', render: (r) => <Badge tone={(PO_STATUS[r.status] || ['', 'neutral'])[1]}>{(PO_STATUS[r.status] || [r.status])[0]}</Badge> },
          { key: 'line_count', label: 'Baris', align: 'right', render: (r) => <span className="num">{r.line_count}</span> },
          { key: 'total_amount', label: 'Nilai', align: 'right', render: (r) => <span className="num strong">{money(r.total_amount)}</span> },
          { key: 'expected', label: 'Rencana tiba', render: (r) => <span className="muted">{r.expected_date ? dateOnly(r.expected_date) : '—'}</span> },
          { key: 'act', label: '', align: 'right', render: (r) => (
            <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
              <Button size="sm" onClick={() => setDetail(r.id)}>Detail</Button>
              {can && r.status !== 'received' && r.status !== 'cancelled' && <Button size="sm" variant="success" onClick={() => setEditing({ id: r.id, receive: true })}>Terima</Button>}
            </div>) },
        ]} empty="Belum ada purchase order" />}

        {tab === 'suggest' && (
          <Table rows={suggest} columns={[
            { key: 'name', label: 'Bahan', render: (r) => <div><div className="strong">{r.name}</div><div className="muted" style={{ fontSize: 11.5 }}>{r.supplier_name || 'tanpa supplier'} · lead time {r.lead_time_days} hari</div></div> },
            { key: 'stock_qty', label: 'Stok', align: 'right', render: (r) => <span className="num">{fmtQty(r.stock_qty, 2)} {r.unit}</span> },
            { key: 'avg_daily', label: 'Pakai/hari', align: 'right', render: (r) => <span className="num">{fmtQty(r.avg_daily, 2)}</span> },
            { key: 'days_to_stockout', label: 'Sisa hari', align: 'right', render: (r) => <span style={{ color: (r.days_to_stockout ?? 99) <= 7 ? 'var(--danger)' : undefined }} className="num">{r.days_to_stockout == null ? '—' : fmtQty(r.days_to_stockout, 1)}</span> },
            { key: 'suggested_qty', label: 'Saran pesan', align: 'right', render: (r) => <span className="num strong">{fmtQty(r.suggested_qty, 0)} {r.unit}</span> },
            { key: 'est_cost', label: 'Perkiraan', align: 'right', render: (r) => <span className="num">{money(r.est_cost)}</span> },
            { key: 'act', label: '', align: 'right', render: () => (can ? <Button size="sm" onClick={() => setEditing({ items: [], prefill: suggest })}>Buat PO</Button> : null) },
          ]} empty="Semua bahan aman — tidak ada yang perlu dipesan" />
          )}

        {tab === 'supplier' && <SupplierTable rows={suppliers} can={app.can('item.manage')} onChanged={() => { load(); app.refresh(); }} />}
      </Card>

      <PoEditor state={editing} suppliers={suppliers} suggest={suggest} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); app.refresh(); }} />
      <PoDetail id={detail} canReceive={can} onClose={() => setDetail(null)} onChanged={() => { setDetail(null); load(); app.refresh(); }} />
    </>
  );
}

// ------------------------------------------------------------------ supplier
function SupplierTable({ rows, can, onChanged }) {
  const app = useApp();
  const [form, setForm] = useState(null);
  const save = async () => {
    try {
      if (form.id) await put(`/suppliers/${form.id}`, form); else await post('/suppliers', form);
      setForm(null); onChanged();
    } catch (e) { app.toast(e.message, 'error'); }
  };
  return (
    <div className="col">
      <Table rows={rows} columns={[
        { key: 'name', label: 'Supplier', render: (r) => <div><div className="strong">{r.name}</div><div className="muted" style={{ fontSize: 11.5 }}>{r.contact || ''}{r.phone ? ` · ${r.phone}` : ''}</div></div> },
        { key: 'email', label: 'Kontak', render: (r) => <span className="muted">{r.email || '—'}</span> },
        { key: 'lead_time_days', label: 'Lead time', align: 'right', render: (r) => <span className="num">{r.lead_time_days} hari</span> },
        { key: 'item_count', label: 'Bahan', align: 'right', render: (r) => <span className="num">{r.item_count}</span> },
        { key: 'notes', label: 'Catatan', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.notes || '—'}</span> },
        ...(can ? [{ key: 'act', label: '', align: 'right', render: (r) => (
          <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
            <Button size="sm" onClick={() => setForm({ ...r })}>Ubah</Button>
            <Button size="sm" variant="ghost" onClick={async () => {
              const ok = await app.confirm({ title: `Hapus ${r.name}?`, message: 'Item yang memakai nama supplier ini tidak ikut terhapus.', danger: true, okText: 'Hapus' });
              if (!ok) return;
              try { await del(`/suppliers/${r.id}`); onChanged(); } catch (e) { app.toast(e.message, 'error'); }
            }}>✕</Button>
          </div>) }] : []),
      ]} empty="Belum ada supplier. Tambahkan agar saran pembelian lebih akurat." />
      {can && <Button size="sm" onClick={() => setForm({ name: '', contact: '', phone: '', email: '', lead_time_days: 3, notes: '' })}>+ Tambah supplier</Button>}

      <Modal open={!!form} onClose={() => setForm(null)} width="520px" title={form?.id ? 'Ubah supplier' : 'Supplier baru'}
        footer={<><Button onClick={() => setForm(null)}>Batal</Button><Button variant="primary" onClick={save} disabled={!form?.name?.trim()}>Simpan</Button></>}>
        {form && <div className="grid grid-2">
          <Field label="Nama" required><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="PIC"><Input value={form.contact || ''} onChange={(e) => setForm({ ...form, contact: e.target.value })} /></Field>
          <Field label="Telepon"><Input value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Email"><Input value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Lead time (hari)" hint="dipakai menghitung reorder point"><NumberInput value={form.lead_time_days} onChange={(v) => setForm({ ...form, lead_time_days: v })} min={0} step={1} /></Field>
          <Field label="Catatan" span={2}><Textarea rows={2} value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  );
}

// ------------------------------------------------------------------ editor PO
function PoEditor({ state, suppliers, suggest, onClose, onSaved }) {
  const app = useApp();
  const raws = app.catalog.filter((c) => c.item_type === 'raw');
  const [po, setPo] = useState({ supplier_id: '', expected_date: '', note: '', status: 'ordered', items: [] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [partial, setPartial] = useState({});

  useEffect(() => {
    if (!state) return;
    if (state.receive && state.id) {
      get(`/purchase-orders/${state.id}`).then((p) => {
        setPo({ supplier_id: p.supplier_id || '', expected_date: p.expected_date || '', note: p.note || '', status: p.status, items: p.items || [] });
        setPartial(Object.fromEntries((p.items || []).map((i) => [i.id, Math.max(0, i.qty_ordered - i.qty_received)])));
      }).catch((e) => setErr(e.message));
    } else {
      const pre = (state.prefill || []).filter((s) => s.days_to_stockout != null && s.days_to_stockout <= 7);
      setPo({
        supplier_id: '', expected_date: '', note: '', status: 'ordered',
        items: (pre.length ? pre : []).map((s) => ({ raw_item_id: s.item_id, qty_ordered: s.suggested_qty, unit_cost: Math.round(s.est_cost / Math.max(1, s.suggested_qty)) || 0 })),
      });
      setPartial({});
    }
    setErr('');
  }, [state]);

  if (!state) return null;
  const isReceive = !!state.receive;
  const setRow = (i, patch) => setPo((p) => ({ ...p, items: p.items.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) }));
  const total = isReceive
    ? po.items.reduce((s, l) => s + (Number(partial[l.id]) || 0) * (Number(l.unit_cost) || 0), 0)
    : po.items.reduce((s, l) => s + (Number(l.qty_ordered) || 0) * (Number(l.unit_cost) || 0), 0);

  const submit = async () => {
    setBusy(true); setErr('');
    try {
      if (isReceive) {
        const items = Object.fromEntries(Object.entries(partial).map(([k, v]) => [k, { qty_received: Number(v) || 0 }]));
        await post(`/purchase-orders/${state.id}/receive`, { items });
        app.toast('Barang diterima — stok bahan & HPP diperbarui', 'success');
      } else {
        await post('/purchase-orders', { ...po, items: po.items.filter((i) => i.raw_item_id && Number(i.qty_ordered) > 0) });
        app.toast('PO dibuat', 'success');
      }
      onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} width="680px" title={isReceive ? `Terima barang — ${po.items.length} baris` : 'Purchase order baru'}
      footer={<>
        <span className="muted" style={{ marginRight: 'auto', fontSize: 12 }}>{err ? `⚠️ ${err}` : `Total ${money(total)}`}</span>
        <Button onClick={onClose}>Batal</Button>
        <Button variant={isReceive ? 'success' : 'primary'} loading={busy} onClick={submit}>{isReceive ? 'Catat penerimaan' : 'Simpan PO'}</Button>
      </>}>
      {isReceive ? (
        <div className="col">
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Isi jumlah yang benar-benar datang. Selisih di bawah pesanan boleh (mis. bahan rusak) — stok bertambah sesuai angka ini.</p>
          {po.items.map((l, i) => (
            <div key={l.id} className="row between" style={{ borderBottom: '1px dashed var(--border)', paddingBottom: 6 }}>
              <div>
                <div className="strong">{l.name}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>dipesan {fmtQty(l.qty_ordered, 2)} {l.unit} · sudah diterima {fmtQty(l.qty_received, 2)} · {money(l.unit_cost)}/{l.unit}</div>
              </div>
              <NumberInput className="input num" style={{ width: 120, textAlign: 'right' }} value={partial[l.id] ?? 0} min={0} step="any" onChange={(v) => setPartial({ ...partial, [l.id]: v })} />
            </div>
          ))}
          <Button size="sm" onClick={() => setPartial(Object.fromEntries(po.items.map((l) => [l.id, Math.max(0, l.qty_ordered - l.qty_received)])))}>Isi penuh semua baris</Button>
        </div>
      ) : (
        <div className="col">
          <div className="grid grid-3">
            <Field label="Supplier"><Select value={po.supplier_id} onChange={(v) => setPo({ ...po, supplier_id: v })} options={[{ value: '', label: '— langsung / tanpa PO supplier —' }, ...suppliers.map((s) => ({ value: s.id, label: `${s.name} (${s.lead_time_days}h)` }))]} /></Field>
            <Field label="Rencana tiba"><Input type="date" value={po.expected_date || ''} onChange={(e) => setPo({ ...po, expected_date: e.target.value })} /></Field>
            <Field label="Status"><Select value={po.status} onChange={(v) => setPo({ ...po, status: v })} options={[{ value: 'draft', label: 'Draf' }, { value: 'ordered', label: 'Dipesan' }]} /></Field>
          </div>
          <div className="row between" style={{ marginTop: 6 }}>
            <b>Daftar bahan</b>
            <span className="row" style={{ gap: 6 }}>
              {suggest.length > 0 && <Button size="sm" variant="outline" onClick={() => setPo((p) => ({ ...p, items: [...p.items, ...suggest.filter((s) => !p.items.some((x) => x.raw_item_id === s.item_id)).map((s) => ({ raw_item_id: s.item_id, qty_ordered: s.suggested_qty, unit_cost: Math.round(s.est_cost / Math.max(1, s.suggested_qty)) || 0 }))] }))}>+ Isi dari saran</Button>}
              <Button size="sm" onClick={() => setPo((p) => ({ ...p, items: [...p.items, { raw_item_id: raws[0]?.id || '', qty_ordered: 1, unit_cost: 0, note: '' }] }))}>+ Baris</Button>
            </span>
          </div>
          {!po.items.length && <div className="empty">Belum ada baris. Tambahkan bahan yang mau dibeli.</div>}
          {po.items.map((l, i) => {
            const raw = raws.find((r) => r.id === l.raw_item_id) || {};
            return (
              <div key={i} className="row" style={{ gap: 6, alignItems: 'flex-end' }}>
                <Field label="Bahan" className="grow"><Select value={l.raw_item_id} onChange={(v) => setRow(i, { raw_item_id: v, unit_cost: Number(raws.find((r) => r.id === v)?.cost_price) || l.unit_cost })} options={raws.map((r) => ({ value: r.id, label: `${r.name} (${r.unit})` }))} /></Field>
                <Field label={`Jumlah ${raw.unit ? `(${raw.unit})` : ''}`} style={{ width: 120 }}><NumberInput value={l.qty_ordered} onChange={(v) => setRow(i, { qty_ordered: v })} step="any" min={0} className="input" /></Field>
                <Field label="Harga /satuan" style={{ width: 130 }}><NumberInput value={l.unit_cost} onChange={(v) => setRow(i, { unit_cost: v })} step={50} min={0} className="input" /></Field>
                <span className="num" style={{ width: 96, textAlign: 'right', fontSize: 12.5 }}>{money((Number(l.qty_ordered) || 0) * (Number(l.unit_cost) || 0))}</span>
                <Button size="sm" variant="ghost" onClick={() => setPo((p) => ({ ...p, items: p.items.filter((_, idx) => idx !== i) }))}>✕</Button>
              </div>
            );
          })}
          <Field label="Catatan"><Input value={po.note} onChange={(e) => setPo({ ...po, note: e.target.value })} placeholder="mis. minta faktur pajak" /></Field>
        </div>
      )}
    </Modal>
  );
}

function PoDetail({ id, canReceive, onClose, onChanged }) {
  const [po, setPo] = useState(null);
  const [busy, setBusy] = useState(false);
  const app = useApp();
  useEffect(() => { if (id) get(`/purchase-orders/${id}`).then(setPo).catch(() => setPo(null)); else setPo(null); }, [id]);
  if (!id) return null;
  return (
    <Modal open onClose={onClose} width="600px" title={`PO ${po?.po_number || ''}`}
      footer={<>
        {po && po.status !== 'received' && po.status !== 'cancelled' && canReceive && <>
          <Button variant="ghost" loading={busy} onClick={async () => {
            const ok = await app.confirm({ title: `Batalkan ${po.po_number}?`, message: 'Barang yang belum diterima tidak akan masuk stok.', danger: true, okText: 'Batal PO' });
            if (!ok) return;
            setBusy(true); try { await post(`/purchase-orders/${id}/cancel`); onChanged(); } finally { setBusy(false); }
          }}>Batalkan</Button>
          <Button variant="success" loading={busy} onClick={async () => {
            setBusy(true);
            try { await post(`/purchase-orders/${id}/receive`, {}); app.toast('Seluruh barang dicatat diterima', 'success'); onChanged(); }
            catch (e) { app.toast(e.message, 'error'); } finally { setBusy(false); }
          }}>Terima semua</Button>
        </>}
        <Button onClick={onClose}>Tutup</Button>
      </>}>
      {!po ? <div className="empty">PO tidak ditemukan.</div> : (
        <div className="col">
          <div className="row between">
            <span className="muted">{po.supplier_name || 'tanpa supplier'} · dibuat {dateTime(po.created_at)}</span>
            <Badge tone={(PO_STATUS[po.status] || ['', 'neutral'])[1]}>{(PO_STATUS[po.status] || [po.status])[0]}</Badge>
          </div>
          <Table dense rows={po.items || []} columns={[
            { key: 'name', label: 'Bahan', render: (r) => `${r.name} (${r.unit})` },
            { key: 'qty_ordered', label: 'Pesan', align: 'right', render: (r) => fmtQty(r.qty_ordered, 2) },
            { key: 'qty_received', label: 'Masuk', align: 'right', render: (r) => fmtQty(r.qty_received, 2) },
            { key: 'unit_cost', label: 'Harga', align: 'right', render: (r) => money(r.unit_cost) },
            { key: 'sub', label: 'Subtotal', align: 'right', render: (r) => money(r.qty_ordered * r.unit_cost) },
            { key: 'stok', label: 'Stok kini', align: 'right', render: (r) => <span className="muted">{fmtQty(r.stock_qty, 2)}</span> },
          ]} />
          {po.note && <div className="hint-box">Catatan: {po.note}</div>}
          <div className="row between"><span className="muted">Total</span><b className="num">{money(po.total_amount)}</b></div>
        </div>
      )}
    </Modal>
  );
}

void useMemo;
