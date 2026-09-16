// ===========================================================================
//  Panel Kustomisasi Toko (Fase 3): profil, pajak dinamis, diskon, metode bayar,
//  layar kasir, tata letak & teks struk, tema + urutan menu, cabang, sistem.
// ===========================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, post, put, del, api, readFileAsDataUrl } from '../../api.js';
import { useApp, previewTheme, applyTheme } from '../../store.jsx';
import { Badge, Button, Card, Field, IconButton, Input, Modal, NumberInput, Select, Table, Tabs, Textarea, Toggle } from '../../ui.jsx';
import { money, dateOnly, dateTime } from '../../lib/format.js';
import { Receipt, buildReceiptLines } from '../receipt/receipt.jsx';

const TABS = [
  { key: 'store', label: 'Profil toko', perm: 'setting.store' },
  { key: 'tax', label: 'Pajak & pembulatan', perm: 'setting.tax' },
  { key: 'discount', label: 'Diskon', perm: 'setting.tax' },
  { key: 'payment', label: 'Pembayaran', perm: 'setting.payment' },
  { key: 'pos', label: 'Layar kasir', perm: 'setting.store' },
  { key: 'receipt', label: 'Struk', perm: 'setting.receipt' },
  { key: 'theme', label: 'Tema & menu', perm: 'setting.theme' },
  { key: 'branches', label: 'Cabang', perm: 'setting.store' },
  { key: 'system', label: 'Sistem', perm: 'system.maintenance' },
];

export default function SettingsPage() {
  const app = useApp();
  const [tab, setTab] = useState('store');
  const allowed = TABS.filter((t) => app.can(t.perm));
  const current = allowed.find((t) => t.key === tab) ? tab : (allowed[0]?.key || 'store');

  return (
    <Card
      title="Pengaturan toko"
      subtitle="Perubahan langsung dipakai oleh layar kasir, struk, dan perhitungan stok — tanpa deploy ulang."
      pad={false}>
      <div style={{ padding: '10px 14px 0' }}>
        <Tabs items={allowed.map((t) => ({ key: t.key, label: t.label }))} value={current} onChange={setTab} />
      </div>
      <div className="card-body">
        {current === 'store' && <StoreTab />}
        {current === 'tax' && <TaxTab />}
        {current === 'discount' && <DiscountTab />}
        {current === 'payment' && <PaymentTab />}
        {current === 'pos' && <PosTab />}
        {current === 'receipt' && <ReceiptTab />}
        {current === 'theme' && <ThemeTab />}
        {current === 'branches' && <BranchTab />}
        {current === 'system' && <SystemTab />}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ util blok
function useBlock(key) {
  const app = useApp();
  const [val, setVal] = useState(() => structuredClone(app.settings[key] || {}));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setVal(structuredClone(app.settings[key] || {})); setDirty(false); }, [app.settings[key], key]);
  const set = useCallback((patch) => { setVal((v) => ({ ...v, ...patch })); setDirty(true); }, []);
  const save = useCallback(async (patch) => {
    const body = patch ? { ...val, ...patch } : val;
    setBusy(true);
    try {
      const out = await put(`/settings/${key}`, body);
      setVal(out.value);
      setDirty(false);
      await app.refresh();
      app.toast('Pengaturan disimpan', 'success');
      return out.value;
    } catch (e) { app.toast(e.message, 'error'); throw e; } finally { setBusy(false); }
  }, [key, val, app]);
  return { val, set, save, dirty, busy, reset: () => { setVal(structuredClone(app.settings[key] || {})); setDirty(false); } };
}

function SaveBar({ dirty, busy, onSave, onReset, note }) {
  return (
    <div className="row between" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <span className="muted" style={{ fontSize: 12 }}>{note || (dirty ? 'Perubahan belum disimpan.' : 'Tersimpan.')}</span>
      <span className="row" style={{ gap: 6 }}>
        {dirty && <Button size="sm" variant="ghost" onClick={onReset}>Batalkan</Button>}
        <Button size="sm" variant="primary" loading={busy} disabled={!dirty} onClick={onSave}>Simpan</Button>
      </span>
    </div>
  );
}

const toList = (s) => String(s ?? '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

// ------------------------------------------------------------------ profil toko
function StoreTab() {
  const { val, set, save, dirty, busy, reset } = useBlock('store');
  const app = useApp();
  const fileRef = useRef();
  const upload = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 900_000) { app.toast('Logo terlalu besar (maks ± 900 KB)', 'error'); return; }
    const data_url = await readFileAsDataUrl(f);
    try { await post('/branding/logo', { data_url }); app.toast('Logo diperbarui', 'success'); app.refresh(); }
    catch (err) { app.toast(err.message, 'error'); }
  };
  return (
    <div className="col">
      <div className="grid grid-2">
        <Field label="Nama toko" required><Input value={val.name || ''} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Nama badan usaha" hint="untuk faktur/pajak"><Input value={val.legal_name || ''} onChange={(e) => set({ legal_name: e.target.value })} /></Field>
        <Field label="Alamat" span={2}><Textarea rows={2} value={val.address || ''} onChange={(e) => set({ address: e.target.value })} /></Field>
        <Field label="Telepon"><Input value={val.phone || ''} onChange={(e) => set({ phone: e.target.value })} /></Field>
        <Field label="Email"><Input value={val.email || ''} onChange={(e) => set({ email: e.target.value })} /></Field>
        <Field label="NPWP"><Input value={val.npwp || ''} onChange={(e) => set({ npwp: e.target.value })} placeholder="00.000.000.0-000.000" /></Field>
        <Field label="Prefiks nomor struk" hint="mis. INV → INV20260916-1001"><Input value={val.invoice_prefix || ''} onChange={(e) => set({ invoice_prefix: e.target.value.toUpperCase() })} /></Field>
        <Field label="Zona waktu"><Input value={val.timezone || ''} onChange={(e) => set({ timezone: e.target.value })} placeholder="Asia/Jakarta" /></Field>
        <Field label="Mata uang"><Select value={val.currency || 'IDR'} onChange={(v) => set({ currency: v })} options={['IDR', 'SGD', 'MYR', 'USD'].map((c) => ({ value: c, label: c }))} /></Field>
      </div>
      <div className="card" style={{ boxShadow: 'none', background: 'var(--canvas)' }}>
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          <div className="login-logo" style={{ width: 56, height: 56, margin: 0, borderRadius: 'var(--radius)' }}>
            {val.logo_data_url ? <img src={val.logo_data_url} alt="logo" /> : '🏪'}
          </div>
          <div style={{ flex: 1 }}>
            <b>Logo toko</b>
            <p className="muted" style={{ fontSize: 12, margin: '2px 0 0' }}>Dipakai di sidebar, layar login, dan struk (PNG/JPG/SVG/WEBP, maks ± 1 MB).</p>
          </div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={upload} />
          <Button size="sm" onClick={() => fileRef.current?.click()}>Unggah</Button>
          {!!val.logo_data_url && <Button size="sm" variant="ghost" onClick={async () => { await del('/branding/logo'); app.refresh(); }}>Hapus</Button>}
        </div>
      </div>
      <SaveBar dirty={dirty} busy={busy} onReset={reset} onSave={() => save()} />
    </div>
  );
}

// ------------------------------------------------------------------ pajak
function TaxTab() {
  const { val, set, save, dirty, busy, reset } = useBlock('tax');
  const [rows, setRows] = useState([]);
  const app = useApp();
  const loadTaxes = () => get('/taxes').then(setRows).catch(() => setRows([]));
  useEffect(() => { loadTaxes(); }, []);
  const patchTax = async (id, body) => { try { await put(`/taxes/${id}`, body); loadTaxes(); } catch (e) { app.toast(e.message, 'error'); } };
  return (
    <div className="col">
      <div className="grid grid-2">
        <Toggle checked={!!val.enabled} onChange={(v) => set({ enabled: v })} label="Hitung pajak pada transaksi" />
        <Toggle checked={!!val.inclusive} onChange={(v) => set({ inclusive: v })} label="Harga sudah termasuk pajak" />
        <Field label="Tarif pajak (%)" hint="bisa dioverride per barang di katalog"><NumberInput value={val.default_rate_pct} onChange={(v) => set({ default_rate_pct: v })} step={0.5} min={0} max={100} className="input input-money" /></Field>
        <Field label="Service charge (%)" hint="mis. untuk restoran"><NumberInput value={val.service_charge_pct} onChange={(v) => set({ service_charge_pct: v })} step={0.5} min={0} max={50} className="input input-money" /></Field>
        <Field label="Pembulatan total">
          <Select value={val.rounding_mode || 'nearest'} onChange={(v) => set({ rounding_mode: v })}
            options={[{ value: 'none', label: 'Tidak dibulatkan' }, { value: 'nearest', label: 'Ke kelipatan terdekat' }, { value: 'up', label: 'Selalu ke atas' }, { value: 'down', label: 'Selalu ke bawah' }]} />
        </Field>
        <Field label="Langkah pembulatan (Rp)" hint="mis. 500 → Rp 12.300 jadi Rp 12.500"><NumberInput value={val.rounding_step} onChange={(v) => set({ rounding_step: v })} step={100} min={1} className="input input-money" /></Field>
        <Toggle checked={!!val.allow_negative_stock} onChange={(v) => set({ allow_negative_stock: v })} label="Boleh stok minus (bahan seret, jangan untuk kasir)" />
        <div />
        <Field label="Jendela perhitungan pemakaian (hari)" hint="dipakai untuk rata-rata konsumsi & peringatan"><NumberInput value={val.consumption_window_days} onChange={(v) => set({ consumption_window_days: v })} step={1} min={1} max={180} /></Field>
        <Field label="Proyeksi kehabisan (hari)"><NumberInput value={val.alert_lookahead_days} onChange={(v) => set({ alert_lookahead_days: v })} step={1} min={1} max={90} /></Field>
      </div>

      <div className="row between" style={{ marginTop: 8 }}>
        <b>Daftar pajak berlaku</b>
        {app.can('setting.tax') && <Button size="sm" onClick={async () => { try { await post('/taxes', { name: 'PPN', rate_pct: val.default_rate_pct || 11, is_default: !rows.length }); loadTaxes(); } catch (e) { app.toast(e.message, 'error'); } }}>+ Tambah pajak</Button>}
      </div>
      <Table dense rows={rows} empty="Belum ada daftar pajak" columns={[
        { key: 'name', label: 'Nama', render: (r) => <span className="strong">{r.name} {r.is_default ? <Badge tone="accent">default</Badge> : null}</span> },
        { key: 'rate_pct', label: 'Tarif', render: (r) => (
          <span className="row" style={{ gap: 6 }}>
            <NumberInput value={r.rate_pct} step={0.5} min={0} max={100} className="input num" style={{ width: 86 }} disabled={!app.can('setting.tax')} onChange={(v) => patchTax(r.id, { name: r.name, rate_pct: v, is_inclusive: r.is_inclusive, is_active: r.is_active, is_default: r.is_default, sort_order: r.sort_order })} />
            <span className="muted">%</span>
          </span>) },
        { key: 'is_inclusive', label: 'Sifat', render: (r) => <Toggle checked={!!r.is_inclusive} label="termasuk harga" onChange={(v) => patchTax(r.id, { name: r.name, rate_pct: r.rate_pct, is_inclusive: v ? 1 : 0, is_active: r.is_active, is_default: r.is_default, sort_order: r.sort_order })} /> },
        { key: 'is_active', label: 'Aktif', render: (r) => <Toggle checked={!!r.is_active} onChange={(v) => patchTax(r.id, { name: r.name, rate_pct: r.rate_pct, is_inclusive: r.is_inclusive, is_active: v ? 1 : 0, is_default: r.is_default, sort_order: r.sort_order })} /> },
        ...(app.can('setting.tax') ? [{ key: 'd', label: '', align: 'right', render: (r) => (
          <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
            {!r.is_default && <Button size="sm" variant="ghost" onClick={() => patchTax(r.id, { name: r.name, rate_pct: r.rate_pct, is_inclusive: r.is_inclusive, is_active: r.is_active, is_default: 1, sort_order: r.sort_order })}>jadikan default</Button>}
            <IconButton label="Hapus" onClick={async () => { await del(`/taxes/${r.id}`).catch((e) => app.toast(e.message, 'error')); loadTaxes(); }}>✕</IconButton>
          </div>) }] : []),
      ]} />
      <div className="hint-box">Contoh: harga Rp 25.000 × 2, service 5%, PPN 11% → subtotal 50.000 · service 2.500 · pajak 5.775 · total {money(58275)} (dibulatkan ke Rp terdekat).</div>
      <SaveBar dirty={dirty} busy={busy} onReset={reset} onSave={() => save()} />
    </div>
  );
}

// ------------------------------------------------------------------ diskon
const TRIGGER = { manual: 'Kasir pilih manual', auto_weekday: 'Otomatis: hari tertentu', auto_time: 'Otomatis: jam tertentu', auto_min_subtotal: 'Otomatis: min. belanja' };
function DiscountTab() {
  const app = useApp();
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null);
  const load = () => get('/discounts').then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  const toggleActive = async (r) => { try { await put(`/discounts/${r.id}`, { is_active: r.is_active ? 0 : 1 }); load(); app.refresh(); } catch (e) { app.toast(e.message, 'error'); } };
  return (
    <div className="col">
      <div className="row between">
        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Aturan diskon dievaluasi mesin harga (kode yang sama dipakai server & aplikasi) — otomatis maupun manual.</p>
        {app.can('setting.tax') && <Button size="sm" variant="primary" onClick={() => setEditing({ kind: 'percent', value: 10, applies_to: 'global', trigger: 'manual', stackable: 0, is_active: 1 })}>+ Aturan diskon</Button>}
      </div>
      <Table rows={rows} empty="Belum ada aturan diskon" columns={[
        { key: 'name', label: 'Nama', render: (r) => <div><div className="strong">{r.name}</div><div className="muted" style={{ fontSize: 11.5 }}>{TRIGGER[r.trigger] || r.trigger} · {r.applies_to === 'global' ? 'semua barang' : r.applies_to === 'category' ? 'kategori' : 'barang tertentu'}</div></div> },
        { key: 'value', label: 'Nilai', align: 'right', render: (r) => <b className="num">{r.kind === 'percent' ? `${r.value}%` : money(r.value)}</b> },
        { key: 'cond', label: 'Syarat', render: (r) => <span className="muted" style={{ fontSize: 12 }}>
          {r.min_subtotal ? `min. belanja ${money(r.min_subtotal)}` : 'tanpa minimum'}
          {r.start_time ? ` · ${r.start_time}–${r.end_time || '23:59'}` : ''}
          {r.days ? ` · ${toList(r.days).length ? toList(r.days).map((d) => DAY_SHORT[d] ?? d).join(', ') : 'setiap hari'}` : ''}
          {r.valid_from || r.valid_to ? ` · ${dateOnly(r.valid_from || '—')} → ${dateOnly(r.valid_to || '—')}` : ''}
        </span> },
        { key: 'max_discount', label: 'Plafon', align: 'right', render: (r) => (r.max_discount ? money(r.max_discount) : <span className="muted">—</span>) },
        { key: 'stackable', label: 'Tumpuk', render: (r) => (r.stackable ? <Badge tone="success">boleh</Badge> : <Badge tone="neutral">tunggal</Badge>) },
        { key: 'is_active', label: 'Aktif', render: (r) => <Toggle checked={!!r.is_active} onChange={() => toggleActive(r)} /> },
        ...(app.can('setting.tax') ? [{ key: 'act', label: '', align: 'right', render: (r) => (
          <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
            <Button size="sm" onClick={() => setEditing({ ...r, ref_ids: r.ref_ids || [], days: toList(r.days) })}>Ubah</Button>
            <IconButton label="Hapus" onClick={async () => {
              const ok = await app.confirm({ title: `Hapus ${r.name}?`, message: 'Aturan yang sedang dipakai kasir akan hilang dari layar pembayaran.', danger: true, okText: 'Hapus' });
              if (!ok) return; await del(`/discounts/${r.id}`).catch((e) => app.toast(e.message, 'error')); load(); app.refresh();
            }}>🗑</IconButton>
          </div>) }] : []),
      ]} />
      <DiscountEditor row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); app.refresh(); }} />
    </div>
  );
}
const DAY_SHORT = { 0: 'Min', 1: 'Sen', 2: 'Sel', 3: 'Rab', 4: 'Kam', 5: 'Jum', 6: 'Sab', Mon: 'Sen' };
const DAYS = [{ v: 1, l: 'Senin' }, { v: 2, l: 'Selasa' }, { v: 3, l: 'Rabu' }, { v: 4, l: 'Kamis' }, { v: 5, l: 'Jumat' }, { v: 6, l: 'Sabtu' }, { v: 0, l: 'Minggu' }];

function DiscountEditor({ row, onClose, onSaved }) {
  const app = useApp();
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (row) setF({ ref_ids: [], days: [], ...row }); }, [row]);
  if (!row || !f) return null;
  const items = app.catalog.filter((c) => c.item_type === 'finished');
  const save = async () => {
    setBusy(true); setErr('');
    const body = { ...f, days: f.days?.length ? f.days : null, start_time: f.start_time || null, end_time: f.end_time || null, valid_from: f.valid_from || null, valid_to: f.valid_to || null };
    try {
      if (f.id) await put(`/discounts/${f.id}`, body); else await post('/discounts', body);
      app.toast('Aturan diskon disimpan', 'success');
      onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} width="560px" title={f.id ? 'Ubah aturan diskon' : 'Aturan diskon baru'}
      footer={<><Button onClick={onClose}>Batal</Button><Button variant="primary" loading={busy} onClick={save} disabled={!f.name?.trim()}>Simpan</Button></>}>
      <div className="grid grid-2">
        <Field label="Nama" required><Input value={f.name || ''} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Diskon_member" /></Field>
        <Field label="Jenis potongan">
          <div className="row" style={{ gap: 6 }}>
            <Select value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={[{ value: 'percent', label: 'Persen' }, { value: 'fixed', label: 'Nominal' }]} />
            <NumberInput className="input input-money" value={f.value} step={f.kind === 'percent' ? 1 : 500} min={0} onChange={(v) => setF({ ...f, value: v })} />
          </div>
        </Field>
        <Field label="Berlaku untuk"><Select value={f.applies_to} onChange={(v) => setF({ ...f, applies_to: v, ref_ids: [] })} options={[{ value: 'global', label: 'Semua barang' }, { value: 'category', label: 'Kategori tertentu' }, { value: 'item', label: 'Barang tertentu' }]} /></Field>
        <Field label="Pemicu"><Select value={f.trigger} onChange={(v) => setF({ ...f, trigger: v })} options={Object.entries(TRIGGER).map(([value, label]) => ({ value, label }))} /></Field>
        {f.applies_to !== 'global' && (
          <Field label={f.applies_to === 'category' ? 'Kategori' : 'Barang'} span={2}>
            <div className="pill-list">
              {(f.applies_to === 'category' ? app.categories.map((c) => ({ id: c.id, name: c.name })) : items.map((i) => ({ id: i.id, name: i.name }))).map((o) => (
                <button key={o.id} className={`chip ${(f.ref_ids || []).includes(o.id) ? 'active' : ''}`}
                  onClick={() => setF({ ...f, ref_ids: (f.ref_ids || []).includes(o.id) ? (f.ref_ids || []).filter((x) => x !== o.id) : [...(f.ref_ids || []), o.id] })}>{o.name}</button>
              ))}
            </div>
          </Field>
        )}
        {f.trigger === 'auto_min_subtotal' && <Field label="Minimum belanja (Rp)"><NumberInput className="input input-money" value={f.min_subtotal || 0} step={1000} min={0} onChange={(v) => setF({ ...f, min_subtotal: v })} /></Field>}
        {f.trigger === 'auto_time' && (
          <div className="row" style={{ gap: 6 }}>
            <Field label="Jam mulai"><Input type="time" value={f.start_time || ''} onChange={(e) => setF({ ...f, start_time: e.target.value })} /></Field>
            <Field label="Jam selesai"><Input type="time" value={f.end_time || ''} onChange={(e) => setF({ ...f, end_time: e.target.value })} /></Field>
          </div>
        )}
        {f.trigger === 'auto_weekday' && (
          <Field label="Hari" span={2}>
            <div className="pill-list">
              {DAYS.map((d) => (
                <button key={d.v} className={`chip ${(f.days || []).map(Number).includes(d.v) ? 'active' : ''}`}
                  onClick={() => setF({ ...f, days: (f.days || []).map(Number).includes(d.v) ? (f.days || []).map(Number).filter((x) => x !== d.v) : [...(f.days || []).map(Number), d.v] })}>{d.l}</button>
              ))}
            </div>
          </Field>
        )}
        <Field label="Plafon potongan (Rp, 0 = tanpa batas)"><NumberInput className="input input-money" value={f.max_discount || 0} step={1000} min={0} onChange={(v) => setF({ ...f, max_discount: v || null })} /></Field>
        <Field label="Periode"><div className="row" style={{ gap: 6 }}>
          <Input type="date" value={f.valid_from || ''} onChange={(e) => setF({ ...f, valid_from: e.target.value })} />
          <Input type="date" value={f.valid_to || ''} onChange={(e) => setF({ ...f, valid_to: e.target.value })} />
        </div></Field>
        <Toggle checked={!!f.stackable} onChange={(v) => setF({ ...f, stackable: v ? 1 : 0 })} label="Boleh ditumpuk dengan diskon lain" />
        <Toggle checked={f.is_active === undefined ? true : !!f.is_active} onChange={(v) => setF({ ...f, is_active: v ? 1 : 0 })} label="Aktif" />
      </div>
      {err && <div className="hint-box" style={{ borderColor: 'var(--danger)' }}>⚠️ {err}</div>}
    </Modal>
  );
}

// ------------------------------------------------------------------ pembayaran
function PaymentTab() {
  const app = useApp();
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null);
  const load = () => get('/payment-methods').then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  const can = app.can('setting.payment');
  const patch = async (r, body) => { try { await put(`/payment-methods/${r.id}`, body); load(); app.refresh(); } catch (e) { app.toast(e.message, 'error'); } };
  return (
    <div className="col">
      <div className="row between">
        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Metode pembayaran menambah biaya layanan (mis. QRIS 0,7%) yang otomatis masuk hitungan & struk.</p>
        {can && <Button size="sm" variant="primary" onClick={() => setEditing({ name: '', kind: 'cash', icon: '💵', service_fee_pct: 0, is_enabled: 1, sort_order: rows.length })}>+ Metode</Button>}
      </div>
      <Table rows={rows} empty="Belum ada metode pembayaran" columns={[
        { key: 'icon', label: '', width: 40, render: (r) => <span style={{ fontSize: 20 }}>{r.icon || '💳'}</span> },
        { key: 'name', label: 'Nama', render: (r) => <span className="strong">{r.name} {r.is_default ? <Badge tone="accent">default</Badge> : null}</span> },
        { key: 'kind', label: 'Jenis', render: (r) => <Badge tone="neutral">{KIND[r.kind] || r.kind}</Badge> },
        { key: 'service_fee_pct', label: 'Biaya layanan', align: 'right', render: (r) => (r.service_fee_pct ? `${r.service_fee_pct}%` : <span className="muted">—</span>) },
        { key: 'is_enabled', label: 'Aktif', render: (r) => <Toggle checked={!!r.is_enabled} onChange={(v) => patch(r, { is_enabled: v ? 1 : 0 })} /> },
        ...(can ? [{ key: 'act', label: '', align: 'right', render: (r) => (
          <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
            {!r.is_default && <Button size="sm" variant="ghost" onClick={() => patch(r, { is_default: 1 })}>default</Button>}
            <Button size="sm" onClick={() => setEditing(r)}>Ubah</Button>
            <IconButton label="Hapus" onClick={async () => { await del(`/payment-methods/${r.id}`).catch((e) => app.toast(e.message, 'error')); load(); app.refresh(); }}>🗑</IconButton>
          </div>) }] : []),
      ]} />
      <PaymentEditor row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); app.refresh(); }} />
    </div>
  );
}
const KIND = { cash: 'Tunai', debit: 'Kartu debit', credit: 'Kartu kredit', qris: 'QRIS', transfer: 'Transfer', wallet: 'E-wallet', voucher: 'Voucher', poin: 'Poin' };

function PaymentEditor({ row, onClose, onSaved }) {
  const app = useApp();
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (row) setF({ ...row }); }, [row]);
  if (!f) return null;
  const save = async () => {
    setBusy(true);
    try {
      if (f.id) await put(`/payment-methods/${f.id}`, f); else await post('/payment-methods', f);
      app.toast('Metode pembayaran disimpan', 'success');
      onSaved();
    } catch (e) { app.toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} width="460px" title={f.id ? `Ubah ${f.name}` : 'Metode pembayaran baru'}
      footer={<><Button onClick={onClose}>Batal</Button><Button variant="primary" loading={busy} onClick={save} disabled={!f.name?.trim()}>Simpan</Button></>}>
      <div className="grid grid-2">
        <Field label="Nama" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="QRIS" /></Field>
        <Field label="Jenis"><Select value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={Object.entries(KIND).map(([value, label]) => ({ value, label }))} /></Field>
        <Field label="Ikon"><div className="pill-list">{['💵', '📱', '💳', '🏦', '🎫', '⭐', '🔷'].map((i) => (
          <button key={i} className={`chip ${f.icon === i ? 'active' : ''}`} onClick={() => setF({ ...f, icon: i })}>{i}</button>))}</div></Field>
        <Field label="Biaya layanan (%)"><NumberInput value={f.service_fee_pct || 0} step={0.1} min={0} max={20} onChange={(v) => setF({ ...f, service_fee_pct: v })} /></Field>
        <Toggle checked={!!f.is_enabled} onChange={(v) => setF({ ...f, is_enabled: v ? 1 : 0 })} label="Dipakai di layar kasir" />
        <Toggle checked={!!f.is_default} onChange={(v) => setF({ ...f, is_default: v ? 1 : 0 })} label="Dipilih otomatis" />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ layar kasir
function PosTab() {
  const { val, set, save, dirty, busy, reset } = useBlock('pos');
  const [quick, setQuick] = useState(toList((val.quick_amounts || []).join(',')));
  useEffect(() => { setQuick((val.quick_amounts || []).join(', ')); }, [val.quick_amounts]);
  return (
    <div className="col">
      <div className="grid grid-2">
        <Field label="Tipe pesanan default"><Select value={val.default_order_type || 'dine_in'} onChange={(v) => set({ default_order_type: v })}
          options={[{ value: 'dine_in', label: 'Makan di tempat' }, { value: 'take_away', label: 'Bawa pulang' }, { value: 'delivery', label: 'Diantar' }, { value: 'online', label: 'Online' }]} /></Field>
        <Toggle checked={!!val.require_customer} onChange={(v) => set({ require_customer: v })} label="Wajib isi nama pelanggan" />
        <Toggle checked={val.show_raw_preview !== false} onChange={(v) => set({ show_raw_preview: v })} label="Tampilkan proyeksi potongan bahan baku di keranjang" />
        <Field label="Jumlah cepat (Rp)" span={2} hint="dipisahkan koma — tombol uang pas di layar pembayaran">
          <Input value={quick} onChange={(e) => setQuick(e.target.value)} onBlur={() => set({ quick_amounts: toList(quick).map(Number).filter((n) => n > 0) })} />
        </Field>
      </div>
      <div className="hint-box">Semua potongan stok mengikuti aturan BOM: barang jadi <i>make_to_order</i> memotong bahan saat penjualan, <i>make_to_stock</i> memotong stok jadi. Detail di dokumentasi.</div>
      <SaveBar dirty={dirty} busy={busy} onReset={reset} onSave={() => save()} />
    </div>
  );
}

// ------------------------------------------------------------------ struk
function ReceiptTab() {
  const { val, set, save, dirty, busy, reset } = useBlock('receipt');
  const app = useApp();
  const [preview, setPreview] = useState(null);
  const can = app.can('setting.receipt');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try { const out = await post('/receipt/preview', { receipt_overrides: val }); if (alive) setPreview(out); } catch { /* biarkan */ }
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [val, tick]);
  const show = val.show || {};
  const toggleShow = (k, v) => set({ show: { ...show, [k]: v } });
  const sample = preview?.sample;
  const lines = useMemo(() => {
    if (!sample) return [];
    return buildReceiptLines({
      snapshot: { store: preview.store, receipt: val, pricing: { subtotal: sample.subtotal, discount_total: sample.discount_total, tax_total: sample.tax_total, service_total: sample.service_total, rounding_total: sample.rounding_total, grand_total: sample.grand_total, paid_amount: sample.paid_amount, change_amount: sample.change_amount } },
      tx: { ...sample, payment_name: 'Tunai' },
      items: sample.items || [], receipt: val, store: preview.store,
    });
  }, [sample, val, preview]);

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1.25fr) minmax(280px,0.75fr)', gap: 18, alignItems: 'start' }}>
      <div className="col">
        <div className="grid grid-2">
          <Field label="Ukuran kertas"><Select value={String(val.paper_width)} onChange={(v) => set({ paper_width: v === 'A4' ? 240 : Number(v) })}
            options={[{ value: '58', label: 'Thermal 58 mm' }, { value: '65', label: 'Thermal 65 mm' }, { value: '72', label: 'Thermal 72 mm' }, { value: '80', label: 'Thermal 80 mm' }, { value: 'A4', label: 'A4 (invoice)' }]} /></Field>
          <Field label="Skala huruf"><NumberInput value={val.font_scale} onChange={(v) => set({ font_scale: v })} step={0.05} min={0.7} max={1.6} /></Field>
          <Field label="Judul atas"><Input value={val.header || ''} onChange={(e) => set({ header: e.target.value })} /></Field>
          <Field label="Sub judul"><Input value={val.subheader || ''} onChange={(e) => set({ subheader: e.target.value })} placeholder="Jl. Merdeka No. 8 · 0812-3456-7890" /></Field>
          <Field label="Pesan penutup" span={2}><Textarea rows={2} value={val.footer || ''} onChange={(e) => set({ footer: e.target.value })} /></Field>
          <Field label="Ucapan terima kasih"><Input value={val.thank_you || ''} onChange={(e) => set({ thank_you: e.target.value })} /></Field>
          <Field label="Akun sosial"><Input value={val.social || ''} onChange={(e) => set({ social: e.target.value })} placeholder="@tokosaya" /></Field>
          <Field label="Karakter garis"><Input value={val.line_char || '-'} maxLength={1} onChange={(e) => set({ line_char: e.target.value })} style={{ width: 60 }} /></Field>
          <Field label="Karakter penjuru"><Input value={val.center_char || '='} maxLength={1} onChange={(e) => set({ center_char: e.target.value })} style={{ width: 60 }} /></Field>
        </div>

        <p className="strong" style={{ marginTop: 10 }}>Baris yang ditampilkan</p>
        <div className="grid grid-3">
          {Object.entries(SHOW_LABEL).map(([k, label]) => (
            <Toggle key={k} checked={show[k] !== false} onChange={(v) => toggleShow(k, v)} label={label} />
          ))}
        </div>

        <div className="row between" style={{ marginTop: 12 }}>
          <b>Baris kustom</b>
          <Button size="sm" onClick={() => set({ custom_lines: [...(val.custom_lines || []), { position: 'bottom', text: '' }] })}>+ Baris</Button>
        </div>
        {(val.custom_lines || []).map((l, i) => (
          <div key={i} className="row" style={{ gap: 6, alignItems: 'center' }}>
            <Select value={l.position} onChange={(v) => set({ custom_lines: val.custom_lines.map((x, idx) => (idx === i ? { ...x, position: v } : x)) })}
              style={{ width: 120 }} options={[{ value: 'top', label: 'Atas' }, { value: 'bottom', label: 'Bawah' }]} />
            <Input value={l.text || ''} placeholder="mis. QR pembayaran: {{store_name}} · no. {{invoice}}"
              onChange={(e) => set({ custom_lines: val.custom_lines.map((x, idx) => (idx === i ? { ...x, text: e.target.value } : x)) })} />
            <IconButton label="Hapus" onClick={() => set({ custom_lines: val.custom_lines.filter((_, idx) => idx !== i) })}>✕</IconButton>
          </div>
        ))}
        <div className="hint-box">
          Variabel yang tersedia: {(preview?.variables || []).map((v) => <code key={v} className="var-chip">{`{{${v}}}`}</code>)}
        </div>
        <SaveBar dirty={dirty} busy={busy} onReset={reset} note={can ? (dirty ? 'Perubahan belum disimpan.' : 'Tersimpan.') : 'Perlu hak akses “Tata letak struk” untuk menyimpan.'} onSave={() => save()} />
      </div>

      <div className="receipt-preview-col">
        <div className="row between" style={{ marginBottom: 6 }}>
          <b>Pratinjau {sample ? `(${sample.invoice_no})` : 'struk'}</b>
          <Button size="sm" variant="ghost" onClick={() => setTick((t) => t + 1)}>↻</Button>
        </div>
        <div className="receipt-frame">
          {lines.length
            ? <Receipt snapshot={{ pricing: {} }} tx={{}} items={[]} receipt={val} store={preview?.store} className="receipt-print" />
            : <div className="empty">Belum ada transaksi untuk contoh. Simpan struk demo lewat transaksi pertama.</div>}
          {lines.length > 0 && <pre className="receipt-text">{lines.filter((l) => l !== '[[LOGO]]').join('\n')}</pre>}
        </div>
        <p className="muted" style={{ fontSize: 11.5 }}>Teks di kanan adalah hasil render sebenarnya; setiap struk yang tersimpan memakai snapshot layout saat transaksi dibuat.</p>
      </div>
    </div>
  );
}
const SHOW_LABEL = {
  logo: 'Logo', store_name: 'Nama toko', address: 'Alamat', phone: 'Telepon', npwp: 'NPWP',
  cashier: 'Kasir', invoice: 'No. struk', date: 'Tanggal', items: 'Daftar barang', discounts: 'Diskon',
  tax: 'Pajak', service: 'Service', payment: 'Pembayaran', change: 'Kembalian',
  social: 'Sosial media', footer: 'Pesan penutup',
};

// ------------------------------------------------------------------ tema & menu
function ThemeTab() {
  const { val, set, save, dirty, busy, reset } = useBlock('theme');
  const app = useApp();
  const [palettes, setPalettes] = useState([]);
  const [drag, setDrag] = useState(-1);
  const fileRef = useRef();
  useEffect(() => { get('/branding/palettes').then(setPalettes).catch(() => setPalettes([])); }, []);
  const can = app.can('setting.theme');

  // pratinjau langsung
  useEffect(() => { previewTheme(val, app.settings.store); return () => applyTheme(app.settings.theme, app.settings.store); }, [val]); // eslint-disable-line

  const menu = val.menu || [];
  const move = (from, to) => {
    if (to < 0 || to >= menu.length) return;
    const next = [...menu];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    set({ menu: next });
  };
  const upload = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 900_000) { app.toast('Logo terlalu besar', 'error'); return; }
    try { await post('/branding/logo', { data_url: await readFileAsDataUrl(f) }); app.toast('Logo disimpan ke toko & struk', 'success'); }
    catch (err) { app.toast(err.message, 'error'); }
  };
  const swatches = [['accent', 'Aksen'], ['success', 'Sukses'], ['danger', 'Bahaya'], ['warning', 'Peringatan'], ['canvas', 'Latar'], ['surface', 'Kartu'], ['text', 'Teks'], ['border', 'Garis']];

  return (
    <div className="col">
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="card" style={{ boxShadow: 'none', background: 'var(--canvas)' }}>
          <div className="card-body">
            <b>Palet siap pakai</b>
            <div className="palette-row">
              {palettes.map((p) => (
                <button key={p.name} className={`palette-swatch ${val.accent === p.accent && val.canvas === p.canvas ? 'active' : ''}`}
                  title={`${p.name} (pratinjau & simpan)`}
                  onClick={() => set({ accent: p.accent, canvas: p.canvas, mode: p.mode, surface: p.mode === 'dark' ? '#1e2937' : '#ffffff', text: p.mode === 'dark' ? '#e5e7eb' : '#111827', border: p.mode === 'dark' ? '#2a3646' : '#e5e7eb', muted: p.mode === 'dark' ? '#94a3b8' : '#6b7280' })}>
                  <i style={{ background: p.accent }} /><i style={{ background: p.canvas }} />
                  <span>{p.name}</span>
                </button>
              ))}
            </div>
            <div className="grid grid-2" style={{ marginTop: 10 }}>
              {swatches.map(([k, label]) => (
                <label key={k} className="row" style={{ gap: 8, fontSize: 12.5, alignItems: 'center' }}>
                  <input type="color" value={val[k] || '#888888'} onChange={(e) => set({ [k]: e.target.value })} style={{ width: 30, height: 26, border: 'none', background: 'transparent', cursor: 'pointer' }} />
                  {label}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="col">
          <Field label="Nama aplikasi" hint="muncul di sidebar & judul tab"><Input value={val.app_name || ''} onChange={(e) => set({ app_name: e.target.value })} /></Field>
          <div className="grid grid-2">
            <Field label="Mode"><Select value={val.mode || 'light'} onChange={(v) => set({ mode: v })} options={[{ value: 'light', label: 'Terang' }, { value: 'dark', label: 'Gelap' }, { value: 'system', label: 'Ikut sistem' }]} /></Field>
            <Field label="Kerapatan"><Select value={val.density || 'comfortable'} onChange={(v) => set({ density: v })} options={[{ value: 'comfortable', label: 'Lapang' }, { value: 'compact', label: 'Ringkas' }]} /></Field>
            <Field label="Huruf"><Select value={val.font || 'system'} onChange={(v) => set({ font: v })} options={[{ value: 'system', label: 'Sistem' }, { value: 'rounded', label: 'Membulat' }, { value: 'serif', label: 'Serif' }, { value: 'mono', label: 'Monospace' }]} /></Field>
            <Field label="Sudut membulat (px)"><NumberInput value={val.radius} onChange={(v) => set({ radius: v })} step={1} min={0} max={28} /></Field>
            <Field label="Lebar sidebar (px)"><NumberInput value={val.sidebar_width} onChange={(v) => set({ sidebar_width: v })} step={4} min={180} max={320} /></Field>
            <Field label="Latar halaman"><Select value={val.bg_pattern || 'none'} onChange={(v) => set({ bg_pattern: v })} options={[{ value: 'none', label: 'Polos' }, { value: 'dots', label: 'Titik' }, { value: 'grid', label: 'Kotak' }]} /></Field>
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <div className="login-logo" style={{ width: 44, height: 44, margin: 0, borderRadius: 10 }}>{val.logo_data_url ? <img src={val.logo_data_url} alt="" /> : '🏪'}</div>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={upload} />
            <Button size="sm" onClick={() => fileRef.current?.click()}>Ganti logo</Button>
            {!!val.logo_data_url && <Button size="sm" variant="ghost" onClick={async () => { await del('/branding/logo'); app.refresh(); }}>Hapus logo</Button>}
          </div>
        </div>
      </div>

      <div className="row between" style={{ marginTop: 12 }}>
        <div>
          <b>Tata letak menu</b>
          <p className="muted" style={{ fontSize: 12, margin: '2px 0 0' }}>Geser untuk mengubah urutan, centang untuk menampilkan. Menu yang tidak relevan otomatis tersembunyi sesuai hak akses user.</p>
        </div>
      </div>
      <div className="menu-list">
        {menu.map((m, i) => (
          <div key={m.key} className={`menu-row ${drag === i ? 'dragging' : ''}`}
            draggable={can}
            onDragStart={() => setDrag(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { move(i, drag); setDrag(-1); }}
            onDragEnd={() => setDrag(-1)}>
            <span className="handle" title="geser untuk memindah">⠿</span>
            <input className="menu-icon" value={m.icon || ''} maxLength={2} disabled={!can} onChange={(e) => set({ menu: menu.map((x, idx) => (idx === i ? { ...x, icon: e.target.value } : x)) })} />
            <input className="menu-label" value={m.label || ''} disabled={!can} onChange={(e) => set({ menu: menu.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x)) })} />
            <code className="muted">{m.key}</code>
            <Badge tone="neutral" title="permission yang dibutuhkan">{m.perm || '—'}</Badge>
            <span className="row" style={{ gap: 2 }}>
              <IconButton label="Naik" onClick={() => move(i, i - 1)}>↑</IconButton>
              <IconButton label="Turun" onClick={() => move(i, i + 1)}>↓</IconButton>
            </span>
            <Toggle checked={m.visible !== false} onChange={(v) => set({ menu: menu.map((x, idx) => (idx === i ? { ...x, visible: v } : x)) })} />
          </div>
        ))}
      </div>
      <SaveBar dirty={dirty} busy={busy} onReset={reset}
        note={can ? (dirty ? 'Pratinjau sudah terlihat; tekan Simpan agar semua perangkat toko ikut berubah.' : 'Tersimpan & berlaku untuk semua user.') : 'Anda dapat melihat pratinjau, tetapi menyimpan tema butuh hak “Tema & logo & menu”.'}
        onSave={async () => { await save(); }} />
    </div>
  );
}

// ------------------------------------------------------------------ cabang
function BranchTab() {
  const app = useApp();
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(null);
  const can = app.can('setting.store');
  const load = () => get('/branches').then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  return (
    <div className="col">
      <Table rows={rows} empty="Toko tunggal — belum ada cabang" columns={[
        { key: 'name', label: 'Cabang', render: (r) => <span className="strong">{r.name} {r.is_default ? <Badge tone="accent">utama</Badge> : null}</span> },
        { key: 'address', label: 'Alamat', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.address || '—'}</span> },
        { key: 'phone', label: 'Telepon', render: (r) => r.phone || '—' },
        { key: 'is_active', label: 'Aktif', render: (r) => (r.is_active ? <Badge tone="success">aktif</Badge> : <Badge tone="danger">nonaktif</Badge>) },
        ...(can ? [{ key: 'act', label: '', align: 'right', render: (r) => (
          <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
            <Button size="sm" onClick={() => setForm({ ...r })}>Ubah</Button>
            <IconButton label="Hapus" onClick={async () => { await del(`/branches/${r.id}`).catch((e) => app.toast(e.message, 'error')); load(); }}>🗑</IconButton>
          </div>) }] : []),
      ]} />
      {can && <Button size="sm" onClick={() => setForm({ name: '', address: '', phone: '', is_default: 0, is_active: 1 })}>+ Tambah cabang</Button>}
      <Modal open={!!form} onClose={() => setForm(null)} width="440px" title={form?.id ? 'Ubah cabang' : 'Cabang baru'}
        footer={<><Button onClick={() => setForm(null)}>Batal</Button><Button variant="primary" onClick={async () => {
          try { if (form.id) await put(`/branches/${form.id}`, form); else await post('/branches', form); setForm(null); load(); } catch (e) { app.toast(e.message, 'error'); }
        }}>Simpan</Button></>}>
        {form && <div className="col">
          <Field label="Nama cabang" required><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Alamat"><Textarea rows={2} value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
          <Field label="Telepon"><Input value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Toggle checked={!!form.is_default} onChange={(v) => setForm({ ...form, is_default: v ? 1 : 0 })} label="Jadikan cabang utama" />
        </div>}
      </Modal>
    </div>
  );
}

// ------------------------------------------------------------------ sistem
function SystemTab() {
  const app = useApp();
  const [health, setHealth] = useState(null);
  const [integrity, setIntegrity] = useState(null);
  const [meta, setMeta] = useState([]);
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try {
      const [h, i, s] = await Promise.all([
        api('/health', { method: 'GET' }).catch(() => null),
        app.can('system.maintenance') ? get('/stock/integrity').catch(() => null) : Promise.resolve(null),
        get('/settings').then((o) => o._meta || []).catch(() => []),
      ]);
      setHealth(h); setIntegrity(i); setMeta(s);
    } catch (e) { app.toast(e.message, 'error'); }
  }, [app]);
  useEffect(() => { load(); }, [load]);
  const reconcile = async () => {
    setBusy('rec');
    try { const out = await post('/stock/reconcile'); app.toast(`Rekonsiliasi selesai: ${out.adjusted ?? out.fixed ?? out.length ?? 0} item diselaraskan`, 'success'); load(); }
    catch (e) { app.toast(e.message, 'error'); } finally { setBusy(''); }
  };
  return (
    <div className="col">
      <div className="grid grid-3">
        <Stat2 label="Status API" value={health?.ok ? 'sehat' : '—'} sub={health ? `${health.uptime_s}s aktif · Node ${health.node}` : 'tidak dapat menghubungi server'} tone={health?.ok ? 'success' : 'danger'} />
        <Stat2 label="Baris data" value={`${health?.items ?? 0} item · ${health?.sales ?? 0} transaksi`} sub={`${health?.movements ?? 0} pergerakan stok`} />
        <Stat2 label="Integritas ledger" value={integrity ? (integrity.mismatches?.length ? `${integrity.mismatches.length} selisih` : 'cocok 100%') : '—'} sub={integrity?.checked ? `${integrity.checked} item diperiksa` : 'perlu hak maintenance'} tone={integrity?.mismatches?.length ? 'warn' : 'success'} />
      </div>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {app.can('system.maintenance') && <>
          <Button loading={busy === 'rec'} onClick={reconcile}>⇄ Rekonsiliasi stok dari ledger</Button>
          <Button variant="outline" onClick={() => api('/admin/backup', { raw: true }).then(async (res) => {
            if (!res.ok) throw new Error('Backup gagal');
            const blob = await res.blob(); const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = `kasir-backup-${new Date().toISOString().slice(0, 10)}.sqlite`; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
          }).catch((e) => app.toast(e.message, 'error'))}>⬇ Unduh backup DB</Button>
          <Button variant="ghost" onClick={() => post('/alerts/scan?days=14&lookahead=7').then(() => { app.toast('Peringatan dihitung ulang', 'success'); app.refresh(); }).catch((e) => app.toast(e.message, 'error'))}>↻ Hitung ulang peringatan</Button>
        </>}
        <Button variant="ghost" onClick={load}>↻ Muat status</Button>
      </div>

      <p className="strong" style={{ marginTop: 8 }}>Riwayat perubahan pengaturan</p>
      <Table dense rows={meta} empty="Belum ada perubahan tersimpan" rowKey={(r) => r.key} columns={[
        { key: 'key', label: 'Blok', render: (r) => <Badge tone="neutral">{r.key}</Badge> },
        { key: 'updated_at', label: 'Ubah terakhir', render: (r) => dateTime(r.updated_at) },
        { key: 'updated_by', label: 'Oleh', render: (r) => <span className="muted">{r.updated_by || 'sistem'}</span> },
      ]} />
      <div className="hint-box">
        Backup otomatis: salin berkas <code>{health?.db_file || 'server/data/kasir.db'}</code> (disertai <code>-wal</code>/<code>-shm</code>) sebelum pemeliharaan terjadwalkan.
        Lihat <code>docs/deployment-dan-pemeliharaan.md</code> untuk jadwal & prosedur.
      </div>
      {integrity?.mismatches?.length > 0 && (
        <Table dense rows={integrity.mismatches} rowKey={(r) => r.item_id || r.name} columns={[
          { key: 'name', label: 'Item' },
          { key: 'stock_qty', label: 'Kolom', align: 'right', render: (r) => r.stock_qty },
          { key: 'ledger_qty', label: 'Ledger', align: 'right', render: (r) => r.ledger_qty ?? r.expected },
          { key: 'diff', label: 'Selisih', align: 'right', render: (r) => <b style={{ color: 'var(--danger)' }}>{r.diff ?? (r.stock_qty - (r.ledger_qty ?? 0))}</b> },
        ]} />
      )}
    </div>
  );
}
const Stat2 = ({ label, value, sub, tone }) => (
  <div className={`stat stat-${tone || 'default'}`}>
    <div><div className="stat-label">{label}</div><div className="stat-value" style={{ fontSize: 20 }}>{value}</div>{sub && <div className="stat-sub">{sub}</div>}</div>
  </div>
);

void money;
