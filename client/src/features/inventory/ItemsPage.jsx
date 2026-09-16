// ===========================================================================
//  Master barang jadi & bahan baku + editor resep (BOM) — Fase 1
// ===========================================================================
import React, { useEffect, useMemo, useState } from 'react';
import { get, post, put, del } from '../../api.js';
import { useApp, hasPerm } from '../../store.jsx';
import { Badge, Button, Card, Field, Input, Modal, NumberInput, Select, StockBadge, Table, Tabs, Textarea, Toggle, Loading } from '../../ui.jsx';
import { money, qty as fmtQty, TYPE_LABEL } from '../../lib/format.js';

const UNITS = ['pcs', 'gr', 'kg', 'ml', 'l', 'cup', 'slice', 'sachet', 'box', 'porsi', 'jam'];

export default function ItemsPage() {
  const app = useApp();
  const can = app.can('item.manage');
  const [tab, setTab] = useState('finished');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);
  const [simulating, setSimulating] = useState(null);
  const [catsOpen, setCatsOpen] = useState(false);

  const rows = app.catalog;
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => r.item_type === (tab === 'raw' ? 'raw' : 'finished')
      && (!needle || r.name.toLowerCase().includes(needle) || (r.sku || '').toLowerCase().includes(needle) || (r.barcode || '') === needle));
  }, [rows, tab, q]);

  const reload = () => app.refresh();
  const remove = async (row) => {
    const ok = await app.confirm({ title: `Hapus ${row.name}?`, message: 'Item yang sudah pernah ditransaksikan hanya dinonaktifkan supaya riwayat & resep tetap utuh.', danger: true, okText: 'Hapus' });
    if (!ok) return;
    try {
      const out = await del(`/items/${row.id}`);
      app.toast(out.soft_deleted ? 'Item dinonaktifkan (riwayat tetap utuh)' : 'Item dihapus', 'success');
      reload();
    } catch (e) { app.toast(e.message, 'error'); }
  };

  const columns = [
    { key: 'name', label: 'Nama', render: (r) => (
      <div>
        <div className="strong">{r.name}</div>
        <div className="muted" style={{ fontSize: 11.5 }}>{r.sku || '—'} · {r.category_name || 'tanpa kategori'} · {r.unit}</div>
      </div>) },
    tab === 'finished'
      ? { key: 'price', label: 'Harga jual', align: 'right', render: (r) => <span className="num strong">{money(r.selling_price)}</span> }
      : { key: 'price', label: 'Hanya pokok', align: 'right', render: (r) => <span className="num">{money(r.cost_price)} <span className="muted" style={{ fontSize: 11 }}>/ {r.unit}</span></span> },
    { key: 'mode', label: 'Mode', render: (r) => (r.is_non_stock
      ? <Badge tone="neutral">non-stok</Badge>
      : r.item_type === 'raw'
        ? <Badge tone="accent">bahan</Badge>
        : <Badge tone={r.production_mode === 'make_to_order' ? 'warn' : 'success'} title={r.production_mode === 'make_to_order' ? 'jualan memotong bahan baku via BOM' : 'jualan memotong stok jadi'}>
            {r.production_mode === 'make_to_order' ? 'MTO' : 'MTS'}
          </Badge>) },
    { key: 'stock', label: 'Stok', align: 'right', render: (r) => r.is_non_stock ? <span className="muted">—</span>
      : <div style={{ textAlign: 'right' }}><div className="num">{fmtQty(r.stock_qty, 2)} {r.unit}</div><StockBadge status={r.status} /></div> },
    ...(tab === 'finished' ? [
      { key: 'cost', label: 'HPP', align: 'right', render: (r) => (
        <div style={{ textAlign: 'right' }}>
          <div className="num">{money(r.cost_price)}</div>
          <div className="muted" style={{ fontSize: 11 }}>margin {r.selling_price > 0 ? `${Math.round((1 - r.cost_price / r.selling_price) * 100)}%` : '—'}</div>
        </div>) },
      { key: 'bom', label: 'Resep', render: (r) => r.recipe_lines
        ? <button className="btn ghost btn-sm" onClick={() => setEditing({ id: r.id })}>🧩 {r.recipe_lines} bahan</button>
        : <span className="muted">tanpa BOM</span> },
    ] : [
      { key: 'usedin', label: 'Dipakai di resep', render: (r) => (r.used_in_count
        ? <Badge tone="neutral">{r.used_in_count} produk</Badge>
        : <span className="muted">—</span>) },
    ]),
    { key: 'act', label: '', align: 'right', render: (r) => (
      <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
        <Button size="sm" variant="outline" onClick={() => setSimulating(r)}>Simulasi</Button>
        {can && <Button size="sm" onClick={() => setEditing({ id: r.id })}>Sunting</Button>}
        {can && <Button size="sm" variant="ghost" onClick={() => remove(r)}>Hapus</Button>}
      </div>) },
  ];

  return (
    <>
      <Card
        title="Katalog barang & bahan"
        subtitle="Barang jadi dan bahan baku ada di satu tabel tetapi berperan berbeda: bahan dipotong otomatis lewat resep (BOM)."
        actions={<>
          <Button size="sm" onClick={() => setCatsOpen(true)}>Kategori</Button>
          {can && <Button size="sm" variant="primary" onClick={() => setEditing({ item_type: tab === 'raw' ? 'raw' : 'finished' })}>+ Tambah {tab === 'raw' ? 'bahan' : 'barang'}</Button>}
        </>}>
        <div className="row between" style={{ marginBottom: 10 }}>
          <Tabs items={[
            { key: 'finished', label: 'Barang Jadi', badge: rows.filter((r) => r.item_type === 'finished').length },
            { key: 'raw', label: 'Bahan Baku', badge: rows.filter((r) => r.item_type === 'raw').length },
          ]} value={tab} onChange={setTab} />
          <Input placeholder="cari nama / SKU / barcode…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        </div>
        <Table columns={columns} rows={list} empty="Belum ada item di grup ini" />
        {!can && <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Peran Anda hanya bisa melihat katalog. Hubungi manajer untuk mengubah.</p>}
      </Card>

      <ItemEditor rowId={editing?.id} blankType={editing?.item_type} onClose={() => setEditing(null)} onSaved={reload} />
      <SimulateModal row={simulating} onClose={() => setSimulating(null)} />
      <CategoriesModal open={catsOpen} onClose={() => setCatsOpen(false)} onSaved={reload} />
    </>
  );
}

// ------------------------------------------------------------------ editor
const BLANK = {
  name: '', sku: '', barcode: '', item_type: 'finished', category_id: '', unit: 'pcs',
  cost_price: 0, selling_price: 0, tax_mode: 'inherit', tax_rate: '', min_stock: 0, reorder_point: '',
  safety_stock: '', lead_time_days: 3, supplier_name: '', production_mode: 'make_to_stock', yield_pct: 100,
  is_non_stock: 0, is_active: 1, image: '', notes: '', opening_stock: '',
};

function ItemEditor({ rowId, blankType, onClose, onSaved }) {
  const app = useApp();
  const [f, setF] = useState(blankType ? { ...BLANK, item_type: blankType } : null);
  const [usedIn, setUsedIn] = useState([]);
  const [tab, setTab] = useState('umum');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const isNew = !rowId;
  const rawItems = app.catalog.filter((c) => c.item_type === 'raw');

  useEffect(() => {
    if (!rowId) { setF(blankType ? { ...BLANK, item_type: blankType } : null); return; }
    setF(null);
    get(`/items/${rowId}`).then((it) => {
      setF({
        ...BLANK,
        ...Object.fromEntries(Object.keys(BLANK).map((k) => [k, it[k] ?? BLANK[k]])),
        recipe: (it.recipe || []).map((r) => ({ raw_item_id: r.raw_item_id, qty: r.qty, unit: r.unit, waste_pct: r.waste_pct ?? 0, is_optional: !!r.is_optional })),
        addons: (it.addons || []).map((a) => ({ name: a.name, price_delta: a.price_delta ?? 0, raw_item_id: a.raw_item_id || '', raw_qty: a.raw_qty ?? 0, is_required: !!a.is_required })),
      });
      setUsedIn(it.used_in || []);
    }).catch((e) => setErr(e.message));
  }, [rowId, blankType]);

  if (!f) return <Modal open onClose={onClose} title="Memuat…"><Loading /></Modal>;
  const set = (patch) => setF((s) => ({ ...s, ...patch }));
  const isFinished = f.item_type === 'finished';
  const recipe = f.recipe || [];
  const addons = f.addons || [];
  const yieldF = Math.max(1, Number(f.yield_pct) || 100) / 100;
  const bomCost = useMemo(() => recipe.reduce((sum, r) => {
    const raw = rawItems.find((x) => x.id === r.raw_item_id);
    return sum + ((Number(r.qty) || 0) * (1 + (Number(r.waste_pct) || 0) / 100) / yieldF) * (Number(raw?.cost_price) || 0);
  }, 0), [recipe, rawItems, yieldF]);

  const save = async () => {
    setBusy(true); setErr('');
    const body = {
      name: String(f.name || '').trim(), sku: f.sku || null, barcode: f.barcode || null,
      item_type: f.item_type, category_id: f.category_id || null, unit: f.unit || 'pcs',
      cost_price: Number(f.cost_price) || 0, selling_price: Number(f.selling_price) || 0,
      tax_mode: f.tax_mode, tax_rate: f.tax_mode === 'override' ? Number(f.tax_rate) || 0 : null,
      min_stock: Number(f.min_stock) || 0,
      reorder_point: f.reorder_point === '' || f.reorder_point == null ? null : Number(f.reorder_point),
      safety_stock: f.safety_stock === '' || f.safety_stock == null ? null : Number(f.safety_stock),
      lead_time_days: Number(f.lead_time_days) || 0, supplier_name: f.supplier_name || null,
      production_mode: f.production_mode, yield_pct: Number(f.yield_pct) || 100,
      is_non_stock: f.is_non_stock ? 1 : 0, is_active: f.is_active ? 1 : 0,
      image: f.image || null, notes: f.notes || null,
    };
    try {
      let id = rowId;
      if (isNew) {
        if (Number(f.opening_stock)) body.opening_stock = Number(f.opening_stock);
        const out = await post('/items', body);
        id = out.id;
      } else {
        await put(`/items/${rowId}`, body);
      }
      if (isFinished) {
        if (app.can('recipe.manage')) await put(`/items/${id}/recipe`, { recipe: recipe.filter((r) => r.raw_item_id && Number(r.qty) > 0) });
        if (app.can('item.manage')) await put(`/items/${id}/addons`, { addons: addons.filter((a) => a.name) });
      }
      app.toast(isNew ? 'Item ditambahkan' : 'Perubahan disimpan', 'success');
      onSaved();
      onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} width="720px"
      title={isNew ? `Item baru — ${isFinished ? 'barang jadi' : 'bahan baku'}` : f.name}
      footer={<>
        <span className="muted" style={{ marginRight: 'auto', fontSize: 12 }}>{err ? `⚠️ ${err}` : isFinished ? 'HPP dihitung otomatis dari resep' : 'Hanya pokok diperbarui otomatis saat barang diterima'}</span>
        <Button onClick={onClose}>Batal</Button>
        <Button variant="primary" loading={busy} disabled={!String(f.name || '').trim()} onClick={save}>Simpan</Button>
      </>}>
      <div className="tabs" style={{ marginBottom: 12 }}>
        {[['umum', 'Umum'], ['stok', 'Stok & supplier'], ...(isFinished ? [['resep', `Resep (${recipe.length})`], ['addon', `Tambahan (${addons.length})`]] : [])].map(([k, l]) => (
          <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'umum' && <div className="grid grid-2">
        <Field label="Nama item" required><Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="mis. Matcha Latte" /></Field>
        <Field label="Jenis item" hint="bahan baku hanya dipotong lewat resep / produksi">
          <Select value={f.item_type} onChange={(v) => set({ item_type: v })} options={[{ value: 'finished', label: 'Barang jadi — dijual ke pelanggan' }, { value: 'raw', label: 'Bahan baku — dipakai produksi' }]} />
        </Field>
        <Field label="Kategori"><Select value={f.category_id} onChange={(v) => set({ category_id: v })} options={[{ value: '', label: '— tanpa kategori —' }, ...app.categories.map((c) => ({ value: c.id, label: c.name }))]} /></Field>
        <Field label="Satuan" hint="gr, ml, pcs, slice, cup…"><Input list="unit-hints" value={f.unit} onChange={(e) => set({ unit: e.target.value })} /></Field>
        <datalist id="unit-hints">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
        <Field label="Kode / SKU"><Input value={f.sku} onChange={(e) => set({ sku: e.target.value })} placeholder="MTC-01" /></Field>
        <Field label="Barcode (untuk scanner)"><Input value={f.barcode} onChange={(e) => set({ barcode: e.target.value })} /></Field>
        <Field label={isFinished ? 'Harga jual (Rp)' : 'Harga beli per satuan (Rp)'} hint={isFinished ? 'HPP dihitung dari bahan' : 'dipakai untuk nilai persediaan'}>
          <NumberInput className="input input-money" value={isFinished ? f.selling_price : f.cost_price} step={500} min={0}
            onChange={(v) => set(isFinished ? { selling_price: v } : { cost_price: v })} />
        </Field>
        {!isFinished && <Field label="Hanya pokok untuk penjualan langsung (Rp)" hint="opsional, mis. bahan dijual eceran"><NumberInput className="input input-money" value={f.selling_price} step={500} min={0} onChange={(v) => set({ selling_price: v })} /></Field>}
        {isFinished && <Field label="Pajak item">
          <div className="row" style={{ gap: 6 }}>
            <Select value={f.tax_mode} onChange={(v) => set({ tax_mode: v })} options={[{ value: 'inherit', label: 'Ikut pengaturan toko' }, { value: 'exempt', label: 'Bebas pajak' }, { value: 'override', label: 'Tarif khusus' }]} />
            {f.tax_mode === 'override' && <NumberInput value={f.tax_rate} onChange={(v) => set({ tax_rate: v })} step={0.5} min={0} max={100} className="input" style={{ width: 90 }} />}
          </div>
        </Field>}
        <Field label="Catatan internal" span={2}><Textarea rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="mis. ukuran cup 16oz, hanya untuk menu sore" /></Field>
      </div>}

      {tab === 'stok' && <div className="grid grid-2">
        <Toggle checked={!!f.is_non_stock} onChange={(v) => set({ is_non_stock: v ? 1 : 0 })} label="Tidak dilacak stok (jasa/layanan)" />
        <Toggle checked={!!f.is_active} onChange={(v) => set({ is_active: v ? 1 : 0 })} label="Aktif — tampil di layar kasir" />
        {!f.is_non_stock && <>
          <Field label="Stok minimum" hint="di bawah ini → peringatan di dasbor"><NumberInput value={f.min_stock} onChange={(v) => set({ min_stock: v })} step="any" min={0} /></Field>
          <Field label="Reorder point" hint="kosong = otomatis dari pemakaian × lead time"><NumberInput value={f.reorder_point} onChange={(v) => set({ reorder_point: v })} step="any" min={0} /></Field>
          <Field label="Safety stock"><NumberInput value={f.safety_stock} onChange={(v) => set({ safety_stock: v })} step="any" min={0} /></Field>
          <Field label="Lead time supplier (hari)"><NumberInput value={f.lead_time_days} onChange={(v) => set({ lead_time_days: v })} step={1} min={0} /></Field>
          <Field label="Supplier"><Input value={f.supplier_name} onChange={(e) => set({ supplier_name: e.target.value })} placeholder="mis. CV Mitra Kopi" /></Field>
          {isNew && <Field label="Stok awal" hint="dicatat sebagai penyesuaian di buku stok"><NumberInput value={f.opening_stock} onChange={(v) => set({ opening_stock: v })} step="any" /></Field>}
        </>}
        {isFinished && !f.is_non_stock && (
          <Field label="Mode produksi" hint={f.production_mode === 'make_to_order' ? 'penjualan langsung memotong bahan' : 'jualan memotong stok jadi; bahan dipotong saat produksi'}>
            <Select value={f.production_mode} onChange={(v) => set({ production_mode: v })} options={[{ value: 'make_to_stock', label: 'Made to stock (MTS)' }, { value: 'make_to_order', label: 'Made to order (MTO)' }]} />
          </Field>
        )}
        {isFinished && recipe.length > 0 && (
          <Field label="Yield produksi (%)" hint="bagian yang benar-benar jadi; sisanya susut"><NumberInput value={f.yield_pct} onChange={(v) => set({ yield_pct: v })} step={1} min={1} max={100} /></Field>
        )}
      </div>}

      {tab === 'resep' && isFinished && <RecipeEditor recipe={recipe} set={(r) => set({ recipe: r })} rawItems={rawItems} yieldF={yieldF} bomCost={bomCost} selling={Number(f.selling_price) || 0} />}
      {tab === 'addon' && isFinished && <AddonEditor addons={addons} set={(a) => set({ addons: a })} rawItems={rawItems} />}

      {tab === 'umum' && usedIn.length > 0 && (
        <div className="hint-box" style={{ marginTop: 10 }}>
          Bahan ini dipakai di resep: {usedIn.map((u) => u.name).join(', ')}. Mengubah jumlahnya akan memengaruhi HPP produk-produk tersebut.
        </div>
      )}
      {err && <div className="hint-box" style={{ marginTop: 10, borderColor: 'var(--danger)' }}>⚠️ {err}</div>}
    </Modal>
  );
}

function RecipeEditor({ recipe, set, rawItems, yieldF, bomCost, selling }) {
  const setRow = (i, patch) => set(recipe.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const add = () => set([...recipe, { raw_item_id: rawItems[0]?.id || '', qty: 1, unit: rawItems[0]?.unit || 'pcs', waste_pct: 0, is_optional: false }]);
  return (
    <div className="col">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <p className="strong" style={{ margin: 0 }}>Bill of Materials — {recipe.length} bahan</p>
          <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>Jumlah untuk 1 unit jual, sudah termasuk susut (waste) dan dibagi yield {Math.round(yieldF * 100)}%.</p>
        </div>
        <Button size="sm" onClick={add} disabled={!rawItems.length}>+ Bahan</Button>
      </div>
      {!rawItems.length && <div className="empty">Belum ada bahan baku. Tambahkan dulu di tab “Bahan Baku”.</div>}
      {!recipe.length && rawItems.length > 0 && <div className="empty">Tanpa resep, penjualan hanya memotong stok barang jadi ini.</div>}
      {recipe.length > 0 && <div className="table-wrap">
        <table className="table-plain">
          <thead><tr><th>Bahan</th><th className="num">Jumlah / porsi</th><th className="num">Susut %</th><th className="num">Butuh efektif</th><th className="num">Estimasi biaya</th><th /></tr></thead>
          <tbody>
            {recipe.map((r, i) => {
              const raw = rawItems.find((x) => x.id === r.raw_item_id) || {};
              const need = ((Number(r.qty) || 0) * (1 + (Number(r.waste_pct) || 0) / 100)) / yieldF;
              const low = need > (Number(raw.stock_qty) || 0);
              return (
                <tr key={i}>
                  <td><Select value={r.raw_item_id} onChange={(v) => setRow(i, { raw_item_id: v, unit: rawItems.find((x) => x.id === v)?.unit })} options={rawItems.map((x) => ({ value: x.id, label: `${x.name} (${x.unit})` }))} /></td>
                  <td className="num"><NumberInput value={r.qty} onChange={(v) => setRow(i, { qty: v })} step="any" min={0} className="input num" style={{ width: 96, textAlign: 'right' }} /></td>
                  <td className="num"><NumberInput value={r.waste_pct} onChange={(v) => setRow(i, { waste_pct: v })} step={1} min={0} max={100} className="input num" style={{ width: 76, textAlign: 'right' }} /></td>
                  <td className="num" style={{ color: low ? 'var(--danger)' : undefined }}>{fmtQty(need, 3)} {raw.unit}</td>
                  <td className="num">{money(need * (Number(raw.cost_price) || 0))}</td>
                  <td><Button size="sm" variant="ghost" onClick={() => set(recipe.filter((_, idx) => idx !== i))}>✕</Button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>}
      <div className="card" style={{ boxShadow: 'none', background: 'var(--canvas)' }}>
        <div className="row between"><span className="muted">HPP dari resep</span><b className="num">{money(bomCost)}</b></div>
        <div className="row between"><span className="muted">Margin pada harga {money(selling)}</span>
          <b className="num" style={{ color: selling && bomCost / selling > 0.7 ? 'var(--danger)' : 'var(--success)' }}>
            {selling > 0 ? `${Math.round((1 - bomCost / selling) * 100)}%` : '—'}
          </b></div>
      </div>
      <small className="muted">Disimpan sebagai BOM resmi saat tombol Simpan ditekan (perlu hak akses “Kelola resep”).</small>
    </div>
  );
}

function AddonEditor({ addons, set, rawItems }) {
  const setRow = (i, patch) => set(addons.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  return (
    <div className="col">
      <div className="row between">
        <div>
          <p className="strong" style={{ margin: 0 }}>Tambahan / varian berbayar</p>
          <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>Ditampilkan di layar kasir. Kaitkan bahan agar stoknya ikut terpotong (mis. extra shot → biji kopi +18 gr).</p>
        </div>
        <Button size="sm" onClick={() => set([...addons, { name: '', price_delta: 0, raw_item_id: '', raw_qty: 0, is_required: false }])}>+ Tambahan</Button>
      </div>
      {!addons.length && <div className="empty">Belum ada tambahan untuk item ini.</div>}
      {addons.map((a, i) => (
        <div key={i} className="row" style={{ gap: 6, alignItems: 'flex-end' }}>
          <Field label="Nama" className="grow"><Input value={a.name} onChange={(e) => setRow(i, { name: e.target.value })} placeholder="Extra shot" /></Field>
          <Field label="Selisih harga" style={{ width: 120 }}><NumberInput value={a.price_delta} onChange={(v) => setRow(i, { price_delta: v })} step={500} className="input" /></Field>
          <Field label="Bahan" style={{ width: 190 }}><Select value={a.raw_item_id || ''} onChange={(v) => setRow(i, { raw_item_id: v })} options={[{ value: '', label: '— tidak memotong —' }, ...rawItems.map((x) => ({ value: x.id, label: x.name }))]} /></Field>
          <Field label="Jumlah" style={{ width: 96 }}><NumberInput value={a.raw_qty ?? 0} onChange={(v) => setRow(i, { raw_qty: v })} step="any" min={0} className="input" /></Field>
          <Button size="sm" variant="ghost" onClick={() => set(addons.filter((_, idx) => idx !== i))}>✕</Button>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ simulasi
function SimulateModal({ row, onClose }) {
  const [qty, setQty] = useState(10);
  const [out, setOut] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!row) { setOut(null); return undefined; }
    let alive = true;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const o = await post(`/items/${row.id}/simulate`, { qty: Number(qty) || 1 });
        if (alive) { setOut(o); setErr(''); }
      } catch (e) { if (alive) setErr(e.message); } finally { if (alive) setBusy(false); }
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [row, qty]);

  return (
    <Modal open={!!row} onClose={onClose} width="520px" title={`Simulasi stok — ${row?.name || ''}`}>
      <Field label="Berapa porsi terjual?"><NumberInput value={qty} onChange={setQty} min={1} step={1} className="input input-money" /></Field>
      {err && <div className="hint-box" style={{ borderColor: 'var(--danger)' }}>⚠️ {err}</div>}
      {busy && <Loading label="Menghitung potongan bahan…" />}
      {!busy && out && (
        <div className="col" style={{ marginTop: 8 }}>
          <div className="row between"><span className="muted">Maksimum mampu dilayani sekarang</span><b>{out.max_servable ?? '—'} porsi</b></div>
          {(out.deduct_finished || []).length > 0 && <>
            <p className="strong" style={{ margin: '8px 0 4px' }}>Stok barang jadi</p>
            {out.deduct_finished.map((f, i) => (
              <div key={i} className="row between" style={{ fontSize: 13 }}>
                <span>{f.name}</span>
                <span className="num">-{fmtQty(f.deduct_qty, 2)} <span className="muted">(diminta {fmtQty(f.requested, 2)})</span></span>
              </div>
            ))}
          </>}
          {(out.deduct_raw || []).length > 0 && <>
            <p className="strong" style={{ margin: '8px 0 4px' }}>Bahan baku terpotong</p>
            {out.deduct_raw.map((r, i) => (
              <div key={i} className="row between" style={{ fontSize: 13 }}>
                <span>{r.item?.name || r.name || r.item_id} <span className="muted">({fmtQty(r.qty, 3)})</span></span>
                <span className="num" style={{ color: Number(r.stock_after) < 0 ? 'var(--danger)' : undefined }}>sisa {fmtQty(r.stock_after, 3)}</span>
              </div>
            ))}
          </>}
          {(out.shortages || []).length > 0 && (
            <div className="hint-box" style={{ borderColor: 'var(--danger)' }}>
              ⚠️ {out.shortages.map((s) => `${s.name}: maksimal ${s.max_by_raw} porsi`).join('; ')}
            </div>
          )}
          {!(out.deduct_raw || []).length && !(out.deduct_finished || []).length && <p className="muted">Item ini tidak memotong stok (jasa atau tanpa resep).</p>}
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ kategori
function CategoriesModal({ open, onClose, onSaved }) {
  const app = useApp();
  const [rows, setRows] = useState([]);
  const [name, setName] = useState('');
  const can = hasPerm(app.perms, 'item.manage');
  const load = () => get('/categories').then(setRows).catch(() => setRows([]));
  useEffect(() => { if (open) load(); }, [open]);
  return (
    <Modal open={open} onClose={onClose} width="480px" title="Kategori menu" footer={<Button onClick={onClose}>Tutup</Button>}>
      <div className="col">
        {rows.map((c) => (
          <div key={c.id} className="row between">
            <CatRow c={c} can={can} onSaved={() => { load(); onSaved(); }} />
          </div>
        ))}
        {!rows.length && <div className="empty">Belum ada kategori.</div>}
        {can && <div className="row" style={{ gap: 6, marginTop: 8 }}>
          <Input placeholder="Kategori baru…" value={name} onChange={(e) => setName(e.target.value)} />
          <Button variant="primary" onClick={async () => { if (!name.trim()) return; try { await post('/categories', { name: name.trim() }); setName(''); load(); onSaved(); } catch (e) { app.toast(e.message, 'error'); } }}>Tambah</Button>
        </div>}
      </div>
    </Modal>
  );
}
function CatRow({ c, can, onSaved }) {
  const app = useApp();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(c.name);
  const [color, setColor] = useState(c.color || '#f97316');
  if (!editing) {
    return (
      <div className="row between" style={{ width: '100%' }}>
        <span className="row" style={{ gap: 7 }}>
          <i style={{ width: 10, height: 10, borderRadius: 9, background: c.color || 'var(--border)', display: 'inline-block' }} />
          <b>{c.name}</b> <span className="muted" style={{ fontSize: 12 }}>{c.item_count ?? 0} item</span>
        </span>
        {can && <span className="row" style={{ gap: 2 }}>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Ubah</Button>
          <Button size="sm" variant="ghost" onClick={async () => {
            const ok = await app.confirm({ title: `Hapus ${c.name}?`, message: 'Item di dalamnya tidak dihapus, hanya kehilangan kategori.', danger: true, okText: 'Hapus' });
            if (!ok) return;
            try { await del(`/categories/${c.id}`); onSaved(); } catch (e) { app.toast(e.message, 'error'); }
          }}>✕</Button>
        </span>}
      </div>
    );
  }
  return (
    <div className="row" style={{ gap: 6, width: '100%' }}>
      <Input value={name} onChange={(e) => setName(e.target.value)} />
      <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 34, height: 32, border: 'none', background: 'transparent', cursor: 'pointer' }} />
      <Button size="sm" variant="primary" onClick={async () => {
        try { await put(`/categories/${c.id}`, { name: name.trim() || c.name, color }); setEditing(false); onSaved(); }
        catch (e) { app.toast(e.message, 'error'); }
      }}>OK</Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Batal</Button>
    </div>
  );
}

void TYPE_LABEL; void Badge;
