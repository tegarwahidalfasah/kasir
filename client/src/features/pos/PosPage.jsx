// ===========================================================================
//  Modul Transaksi Kasir (Fase 2) — keranjang, kalkulasi (mesin shared dengan
//  server), pratinjau potongan bahan baku, pembayaran, struk.
// ===========================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, post, del } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Badge, Button, Field, IconButton, Input, Loading, Modal, NumberInput, Select, StockBadge } from '../../ui.jsx';
import { money, qty as fmtQty } from '../../lib/format.js';
import { Receipt, printReceipt, buildReceiptLines } from '../receipt/receipt.jsx';

export default function PosPage() {
  const app = useApp();
  // katalog lengkap (termasuk bahan baku + kapasitas) diambil dari /pos/catalog:
  // bootstrap hanya berisi barang jadi, sedangkan proyeksi stok butuh angka bahan.
  const [live, setLive] = useState(null);
  useEffect(() => {
    let alive = true;
    const pull = () => get('/pos/catalog').then((c) => { if (alive) setLive(c); }).catch(() => {});
    pull();
    const id = setInterval(pull, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  const catalogAll = useMemo(() => (live?.items ? live.items : app.catalog), [live, app.catalog]);
  const catalog = catalogAll.filter((i) => i.item_type === 'finished');
  const categories = app.categories;
  const bom = app.bom || {};
  const posCfg = app.settings.pos || {};

  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('');
  const [cart, setCart] = useState([]);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [selectedDiscounts, setSelectedDiscounts] = useState([]);
  const [customer, setCustomer] = useState({ name: '', phone: '', order_type: posCfg.default_order_type || 'dine_in', note: '' });
  const [cartOpenMobile, setCartOpenMobile] = useState(false);
  const [held, setHeld] = useState([]);
  const [lineEditor, setLineEditor] = useState(null);
  const previewSeq = useRef(0);

  // --- isi keranjang -------------------------------------------------------
  const addItem = useCallback((item) => {
    setCart((c) => {
      const at = c.findIndex((l) => l.item_id === item.id && !l.addons?.length);
      if (at >= 0) {
        const next = [...c];
        next[at] = { ...next[at], qty: round2(next[at].qty + 1) };
        return next;
      }
      return [...c, { item_id: item.id, name: item.name, qty: 1, unit_price: item.selling_price, addons: [], discount: 0 }];
    });
    setCartOpenMobile(true);
  }, []);
  const setQty = (i, value) => setCart((c) => c.map((l, idx) => (idx === i ? { ...l, qty: Math.max(0.001, round2(Number(value) || 0)) } : l)));
  const removeLine = (i) => setCart((c) => c.filter((_, idx) => idx !== i));

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter((i) => (!cat || i.category_id === cat)
      && (!q || i.name.toLowerCase().includes(q) || (i.sku || '').toLowerCase().includes(q) || (i.barcode || '') === q));
  }, [catalog, query, cat]);

  // --- kalkulasi: selalu minta server supaya sama persis dengan struk -----
  useEffect(() => {
    if (!cart.length) { setPreview(null); return undefined; }
    const id = ++previewSeq.current;
    const t = setTimeout(async () => {
      try {
        const out = await post('/pos/preview', {
          lines: cart.map(({ item_id, qty, addons, discount }) => ({ item_id, qty, addons, discount })),
          selected_discount_ids: selectedDiscounts,
        });
        if (id === previewSeq.current) setPreview(out);
      } catch { /* biarkan angka terakhir tampil */ }
    }, 220);
    return () => clearTimeout(t);
  }, [cart, selectedDiscounts]);

  const pricing = preview?.pricing;
  const serverShortages = preview?.stock_impact?.shortages || [];
  // kekurangan dihitung per bahan: total kebutuhan vs stok di gudang
  const shortages = useMemo(() => {
    const need = {};
    Object.values(preview?.bom_by_line || {}).forEach((rows) => rows.forEach((r) => {
      need[r.raw_item_id] = (need[r.raw_item_id] || 0) + r.need;
    }));
    return Object.entries(need).map(([id, n]) => {
      const it = catalogAll.find((c) => c.id === id) || {};
      return { raw_item_id: id, name: it.name || 'Bahan', unit: it.unit || '', need: n, stock: Number(it.stock_qty) || 0 };
    }).filter((x) => x.need > x.stock + 1e-6);
  }, [preview, catalogAll]);
  const total = pricing?.grand_total || 0;

  // order tertahan
  const loadHeld = useCallback(() => {
    if (!app.can('sale.hold')) { setHeld([]); return Promise.resolve(); }
    return get('/pos/held').then(setHeld).catch(() => setHeld([]));
  }, [app]);
  useEffect(() => { loadHeld(); }, [loadHeld]);

  const holdOrder = async () => {
    try {
      await post('/pos/hold', { lines: cart.map(({ item_id, qty, addons }) => ({ item_id, qty, addons })), customer_name: customer.name || undefined });
      toastAndReset();
      app.toast('Order ditahan', 'success');
      loadHeld();
    } catch (e) { app.toast(e.message, 'error'); }
  };
  const resumeHeld = async (row) => {
    try {
      const data = await get(`/pos/hold/${row.id}`);
      setCart((data.lines || []).map((l) => {
        const it = catalogAll.find((c) => c.id === l.item_id) || {};
        return { item_id: l.item_id, name: it.name || 'Item', qty: l.qty, unit_price: it.selling_price, addons: l.addons || [], discount: l.discount || 0 };
      }));
      setSelectedDiscounts(data.selected || []);
      setCustomer((c) => ({ ...c, name: data.customer_name || '' }));
      await del(`/pos/hold/${row.id}`);
      loadHeld();
    } catch (e) { app.toast(e.message, 'error'); }
  };

  const toastAndReset = () => { setCart([]); setPreview(null); setSelectedDiscounts([]); setCustomer({ name: '', phone: '', order_type: customer.order_type, note: '' }); };

  const checkout = async (paidAmount, paymentMethodId, reference) => {
    setBusy(true);
    try {
      const out = await post('/sales', {
        lines: cart.map(({ item_id, qty, addons, discount }) => ({ item_id, qty, addons, discount })),
        selected_discount_ids: selectedDiscounts,
        payment_method_id: paymentMethodId,
        paid_amount: paidAmount,
        payment_reference: reference,
        customer_name: customer.name || undefined,
        customer_phone: customer.phone || undefined,
        order_type: customer.order_type,
        note: customer.note || undefined,
        external_ref: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      setPayOpen(false);
      setReceipt(out);
      toastAndReset();
      app.refresh();
    } finally {
      setBusy(false);
    }
  };

  const isMto = (id) => catalogAll.find((c) => c.id === id)?.production_mode === 'make_to_order';

  return (
    <div className="pos">
      {/* -------------------------------------------------------- katalog */}
      <div className="card pos-side">
        <div className="pos-search">
          <Input autoFocus placeholder="Cari barang / scan barcode…" value={query} onChange={(e) => setQuery(e.target.value)} className="input input-lg" />
        </div>
        <div className="pos-cats">
          <button className={`chip ${!cat ? 'active' : ''}`} onClick={() => setCat('')}>Semua</button>
          {categories.map((c) => (
            <button key={c.id} className={`chip ${cat === c.id ? 'active' : ''}`} onClick={() => setCat(c.id)}>
              {c.color ? <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 9, background: c.color, marginRight: 5 }} /> : null}{c.name}
            </button>
          ))}
          {app.can('sale.hold') && held.length > 0 && (
            <span className="chip" title="Order tertahan di bawah">⏸ {held.length} tertahan</span>
          )}
        </div>
        {held.length > 0 && (
          <div style={{ padding: '0 14px' }}>
            <div className="pill-list">
              {held.map((h) => (
                <span key={h.id} className="chip" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button className="btn ghost btn-sm" style={{ padding: '0 4px' }} onClick={() => resumeHeld(h)}>▶ {h.invoice_no}</button>
                  <IconButton label="Hapus" onClick={() => del(`/pos/hold/${h.id}`).then(loadHeld).catch((e) => app.toast(e.message, 'error'))}>✕</IconButton>
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="item-grid">
          {visible.map((item) => {
            const cap = item.capacity ?? item.stock_qty;
            const disabled = !item.is_non_stock && isMto(item.id) ? (cap || 0) <= 0 : (!item.is_non_stock && (item.stock_qty || 0) <= 0);
            const b = bom[item.id] || [];
            return (
              <button key={item.id} className={`item-tile ${disabled ? 'off' : ''}`} onClick={() => addItem(item)} disabled={disabled}
                title={disabled ? 'Stok/bahan tidak cukup' : 'Tambah ke keranjang'}>
                <div className="item-name">{item.name}</div>
                <div className="item-price">{money(item.selling_price)}</div>
                <div className="item-meta">
                  {item.is_non_stock ? <Badge tone="accent">jasa</Badge>
                    : disabled ? <Badge tone="danger">habis</Badge>
                    : isMto(item.id) ? <span title="kapasitas dari bahan baku">≈{fmtQty(cap, 0)} porsi</span>
                    : <span>stok {fmtQty(item.stock_qty, 0)}</span>}
                  {b.length > 0 && <span title={`${b.length} bahan baku`}>🧩{b.length}</span>}
                </div>
              </button>
            );
          })}
          {!visible.length && <div className="empty-state"><div className="empty-icon">🔍</div><h3>Tidak ada barang</h3><p>Ubah kata kunci atau tambahkan barang di menu Barang.</p></div>}
        </div>
      </div>

      {/* -------------------------------------------------------- keranjang */}
      <div className={`card cart ${cartOpenMobile ? '' : 'hidden-mobile'}`}>
        <div className="card-head" style={{ padding: '10px 12px' }}>
          <div style={{ flex: 1 }}>
            <h2>Pesanan {cart.length ? `(${cart.length})` : ''}</h2>
          </div>
          <IconButton label="Tutup" className="mobile-only" onClick={() => setCartOpenMobile(false)}>✕</IconButton>
          {cart.length > 0 && <IconButton label="Kosongkan" onClick={() => { setCart([]); setSelectedDiscounts([]); }}>🗑</IconButton>}
        </div>

        <div className="cart-lines">
          {!cart.length && <div className="empty-state" style={{ padding: '26px 8px' }}><div className="empty-icon">🧺</div><h3>Keranjang kosong</h3><p>Pilih barang di sebelah kiri.</p></div>}
          {cart.map((line, i) => {
            const item = catalogAll.find((c) => c.id === line.item_id) || {};
            // kebutuhan aktual keranjang dijawab server (bom_by_line) agar konsisten dgn stok terbaru
            const bomLines = ((preview?.bom_by_line || {})[line.item_id] || []).map((r) => ({ ...r, raw_name: r.name, raw_unit: r.unit }));
            const addons = line.addons || [];
            const linePrev = (preview?.pricing?.lines || [])[i];
            return (
              <div key={`${line.item_id}-${i}`} className="cart-line">
                <div style={{ minWidth: 0 }}>
                  <div className="cart-line-name">{line.name}</div>
                  <div className="cart-line-sub">
                    {money(item.selling_price || 0)}{addons.length ? ` + ${addons.map((a) => a.name).join(', ')}` : ''}
                    {line.discount ? <span style={{ color: 'var(--danger)' }}> · diskon {money(line.discount)}</span> : null}
                  </div>
                  {posCfg.show_raw_preview && bomLines.length > 0 && (
                    <div className="cart-line-sub" style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px', marginTop: 3 }}>
                      {bomLines.map((r) => {
                        const low = r.need > (r.stock ?? 0) + 1e-6;
                        return <span key={r.raw_item_id} className={`raw-chip ${low ? 'low' : ''}`}>{low ? '⚠ ' : ''}{fmtQty(r.need, 2)} {r.unit} {r.name}</span>;
                      })}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                  <div className="cart-line-total">{money(linePrev?.line_total ?? (item.selling_price || 0) * line.qty)}</div>
                  <div className="qty-ctl">
                    <button onClick={() => (line.qty <= 1 ? removeLine(i) : setQty(i, line.qty - 1))}>−</button>
                    <span>{fmtQty(line.qty, 1)}</span>
                    <button onClick={() => setQty(i, line.qty + 1)}>+</button>
                  </div>
                  <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                    {(bom[item.id] || []).length > 0 || addons.length ? <IconButton label="Pilihan" onClick={() => setLineEditor({ i, line })}>⚙</IconButton> : null}
                    <IconButton label="Diskon baris" onClick={() => setLineEditor({ i, line, tab: 'disc' })}>%</IconButton>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="cart-totals">
          <Field label="Pelanggan / tipe pesanan" className="row" >
            <div className="row" style={{ width: '100%', gap: 6 }}>
              <Input placeholder="Nama (opsional)" value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} style={{ flex: 2 }} />
              <Select value={customer.order_type} onChange={(v) => setCustomer({ ...customer, order_type: v })}
                options={[{ value: 'dine_in', label: 'Di tempat' }, { value: 'take_away', label: 'Bawa pulang' }, { value: 'delivery', label: 'Kirim' }]} style={{ flex: 1 }} />
            </div>
          </Field>
          {app.discountRules.filter((d) => d.trigger === 'manual' && d.is_active).map((d) => (
            <label key={d.id} className="toggle" style={{ fontSize: 12.5, marginTop: 2 }}>
              <input type="checkbox" checked={selectedDiscounts.includes(d.id)} onChange={(e) => setSelectedDiscounts((s) => (e.target.checked ? [...s, d.id] : s.filter((x) => x !== d.id)))} />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
              {d.name} <span className="muted">({d.kind === 'percent' ? `${d.value}%` : money(d.value)})</span>
            </label>
          ))}
          {(preview?.pricing?.discount_lines || []).filter((d) => !selectedDiscounts.includes(d.id)).map((d) => (
            <div key={d.id} className="row between" style={{ fontSize: 12 }}>
              <span className="muted">Otomatis: {d.name}</span><span style={{ color: 'var(--success)' }}>-{money(d.amount)}</span>
            </div>
          ))}
          {(shortages.length > 0 || serverShortages.length > 0) && (
            <div className="hint-box" style={{ borderColor: 'var(--danger)' }}>
              ⚠️ Bahan kurang: {shortages.map((s) => `${s.name} (butuh ${fmtQty(s.need, 2)} ${s.unit}, sisa ${fmtQty(s.stock, 2)})`).join('; ')} — selesaikan pembelian/opname bahan dulu
              {serverShortages.map((s) => ` · ${s.name} maks ${s.max_by_raw} porsi`).join('')}
            </div>
          )}
          <div className="line"><span>Subtotal</span><span>{money(preview?.pricing?.subtotal ?? 0)}</span></div>
          {!!(preview?.pricing?.discount_total) && <div className="line"><span>Diskon</span><span style={{ color: 'var(--danger)' }}>-{money(preview.pricing.discount_total)}</span></div>}
          {!!(preview?.pricing?.service_total) && <div className="line"><span>Service</span><span>{money(preview.pricing.service_total)}</span></div>}
          {!!(preview?.pricing?.tax_total) && <div className="line"><span>Pajak</span><span>{money(preview.pricing.tax_total)}</span></div>}
          {!!(preview?.pricing?.rounding_total) && <div className="line"><span>Pembulatan</span><span>{money(preview.pricing.rounding_total)}</span></div>}
          <div className="line grand"><span>TOTAL</span><span>{money(total)}</span></div>
        </div>

        <div style={{ padding: 12, display: 'flex', gap: 8, borderTop: '1px solid var(--border)' }}>
          {app.can('sale.hold') && <Button onClick={holdOrder} disabled={!cart.length}>⏸ Tahan</Button>}
          <Button className="btn-block" variant="primary" size="lg" disabled={!cart.length || shortages.length > 0} title={shortages.length ? 'Bahan baku belum cukup' : ''} onClick={() => setPayOpen(true)}>
            Bayar {money(total)}
          </Button>
        </div>
      </div>

      {/* -------------------------------------------------------- editor baris */}
      <LineEditor
        state={lineEditor}
        catalog={catalogAll}
        onClose={() => setLineEditor(null)}
        onSave={(i, patch) => {
          setCart((c) => c.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
          setLineEditor(null);
        }}
      />

      {/* -------------------------------------------------------- pembayaran */}
      <PaymentModal
        open={payOpen}
        total={total}
        feeHint={preview?.pricing?.fee_total}
        quickAmounts={posCfg.quick_amounts || []}
        methods={app.paymentMethods}
        busy={busy}
        onClose={() => setPayOpen(false)}
        onConfirm={checkout}
      />

      {/* -------------------------------------------------------- struk */}
      <Modal open={!!receipt} title={`Struk ${receipt?.invoice_no || ''}`} onClose={() => setReceipt(null)} width="420px">
        {receipt && (
          <>
            <Receipt snapshot={receipt.receipt} tx={receiptTx(receipt)} items={receiptLines(receipt)} receipt={receipt.receipt?.receipt} store={app.settings.store} />
            <div className="row" style={{ marginTop: 10 }}>
              <Button variant="primary" onClick={() => printReceipt({
                title: `Struk ${receipt.invoice_no}`,
                lines: buildReceiptLines({ snapshot: receipt.receipt, tx: receiptTx(receipt), items: receiptLines(receipt), receipt: receipt.receipt?.receipt, store: app.settings.store }),
                width: Number(receipt.receipt?.receipt?.paper_width) || 58,
                fontScale: Number(receipt.receipt?.receipt?.font_scale) || 1,
              })}>🖨 Cetak struk</Button>
              <Button onClick={() => setReceipt(null)}>Transaksi baru</Button>
            </div>
            {(receipt.movements || []).length > 0 && (
              <details style={{ marginTop: 10 }}>
                <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>Stok yang terpotong ({receipt.movements.length})</summary>
                <ul className="muted" style={{ fontSize: 12, paddingLeft: 18, margin: '6px 0' }}>
                  {receipt.movements.map((m, i) => <li key={i}>{m.name}: <b>{fmtQty(m.qty, 3)}</b> (sisa {fmtQty(m.balance_after, 3)})</li>)}
                </ul>
              </details>
            )}
          </>
        )}
      </Modal>

      {app.can('stock.view') && <StockWatcher onAlert={(msg) => app.toast(msg, 'warn')} />}
    </div>
  );
}

// ------------------------------------------------------------------ sub-komponen
function LineEditor({ state, catalog, onClose, onSave }) {
  const [tab, setTab] = useState('addon');
  const [line, setLine] = useState(null);
  useEffect(() => { if (state) { setLine(state.line); setTab(state.tab || 'addon'); } }, [state]);
  if (!state || !line) return null;
  const item = catalog.find((c) => c.id === line.item_id) || {};
  const allAddons = item.addons || [];
  return (
    <Modal open onClose={onClose} title={item.name} width="440px" footer={<>
      <Button onClick={onClose}>Batal</Button>
      <Button variant="primary" onClick={() => onSave(state.i, { addons: line.addons, discount: Number(line.discount) || 0 })}>Simpan</Button>
    </>}>
      <div className="tabs" style={{ marginBottom: 10 }}>
        <button className={`tab ${tab === 'addon' ? 'active' : ''}`} onClick={() => setTab('addon')}>Tambahan</button>
        <button className={`tab ${tab === 'disc' ? 'active' : ''}`} onClick={() => setTab('disc')}>Diskon baris</button>
      </div>
      {tab === 'addon' && (allAddons.length ? (
        <div className="col">
          {allAddons.map((a) => {
            const picked = (line.addons || []).find((x) => x.name === a.name);
            return (
              <div key={a.id} className="row between">
                <span>{a.name} <span className="muted">{a.price_delta ? `+${money(a.price_delta)}` : ''}</span></span>
                <div className="qty-ctl">
                  <button onClick={() => setLine({ ...line, addons: dec(line.addons, a, picked) })}>−</button>
                  <span>{picked?.qty ?? 0}</span>
                  <button onClick={() => setLine({ ...line, addons: inc(line.addons, a) })}>+</button>
                </div>
              </div>
            );
          })}
          <small className="muted">Tambahan yang memakai bahan baku ikut memotong stok gudang.</small>
        </div>
      ) : <p className="muted">Item ini tidak punya opsi tambahan.</p>)}
      {tab === 'disc' && (
        <Field label="Potongan nominal untuk baris ini (Rp)">
          <NumberInput value={line.discount || 0} step={500} min={0} onChange={(v) => setLine({ ...line, discount: Number(v) || 0 })} className="input input-money" />
        </Field>
      )}
    </Modal>
  );
}
const inc = (addons, a) => {
  const list = [...(addons || [])];
  const i = list.findIndex((x) => x.name === a.name);
  if (i < 0) list.push({ name: a.name, price_delta: a.price_delta, raw_item_id: a.raw_item_id, raw_qty: a.raw_qty, qty: 1 });
  else list[i] = { ...list[i], qty: list[i].qty + 1 };
  return list;
};
const dec = (addons, a, picked) => {
  const list = [...(addons || [])];
  const i = list.findIndex((x) => x.name === a.name);
  if (i < 0) return list;
  const q = (picked?.qty ?? list[i].qty) - 1;
  if (q <= 0) list.splice(i, 1); else list[i] = { ...list[i], qty: q };
  return list;
};

function PaymentModal({ open, total, methods, quickAmounts, busy, onClose, onConfirm }) {
  const [method, setMethod] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const cash = (methods.find((m) => m.kind === 'cash') || {});
  useEffect(() => {
    if (!open) return;
    const m0 = methods.find((m) => m.is_default) || methods[0] || {};
    setMethod(m0.id || '');
    // tunai: uang diterima otomatis terisi total supaya kasir cukup tekan satu tombol
    setAmount(m0.kind === 'cash' ? String(total) : '');
    setReference('');
  }, [open, methods, total]);
  const isCash = (methods.find((m) => m.id === method) || {}).kind === 'cash';
  const paid = Number(amount) || 0;
  const change = paid - total;
  const ok = !isCash || paid >= total - 0.001;
  return (
    <Modal open={open} onClose={onClose} title="Pembayaran" width="460px"
      footer={<>
        <Button onClick={onClose}>Batal</Button>
        <Button variant="success" loading={busy} disabled={!ok} onClick={() => onConfirm(isCash ? (paid || total) : total, method, reference || undefined)}>
          Proses {money(total)}
        </Button>
      </>}>
      <div className="row between" style={{ marginBottom: 10 }}><span className="muted">Total tagihan</span><b style={{ fontSize: 22 }}>{money(total)}</b></div>
      <div className="pill-list" style={{ marginBottom: 12 }}>
        {methods.map((m) => (
          <button key={m.id} className={`chip ${method === m.id ? 'active' : ''}`} onClick={() => setMethod(m.id)}>
            {m.icon} {m.name}{Number(m.service_fee_pct) > 0 ? <span className="muted"> {m.service_fee_pct}%</span> : null}
          </button>
        ))}
      </div>
      {isCash && (
        <>
          <div className="pill-list" style={{ marginBottom: 10 }}>
            {[total, ...quickAmounts.map((a) => Number(a)).filter((a) => a > total)].map((a, i) => (
              <button key={`${a}-${i}`} className="chip" onClick={() => setAmount(String(a))}>{money(a)}</button>
            ))}
          </div>
          <Field label="Uang diterima">
            <NumberInput className="input input-money" value={amount} onChange={setAmount} step={1000} min={0} placeholder="0" />
          </Field>
          <div className="row between" style={{ marginTop: 8, fontWeight: 700 }}>
            <span className="muted">Kembalian</span>
            <span style={{ color: change < 0 ? 'var(--danger)' : 'var(--success)' }}>{money(Math.abs(change))}{change < 0 ? ' kurang' : ''}</span>
          </div>
        </>
      )}
      {!isCash && (
        <Field label="No. referensi / ID transaksi (opsional)">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="mis. 8829103" />
        </Field>
      )}
      {cash.name === undefined && <p className="muted" style={{ fontSize: 12 }}>Metode pembayaran dapat dikelola di Pengaturan → Pembayaran.</p>}
    </Modal>
  );
}

/** Pemantau stok real-time di layar kasir: menandai bahan yang tinggal sedikit. */
function StockWatcher({ onAlert }) {
  const app = useApp();
  const seen = useRef(new Set());
  useEffect(() => {
    const tick = async () => {
      try {
        const out = await get('/stock/health?lookahead=2');
        const risky = (out.items || []).filter((i) => (i.status === 'critical' || i.status === 'out') && i.item_type === 'raw');
        risky.forEach((i) => {
          if (!seen.current.has(i.id)) { seen.current.add(i.id); onAlert(`Stok ${i.name} ${i.status === 'out' ? 'habis' : 'kritis'} — pesanan berikutnya bisa terblokir`); }
        });
      } catch { /* offline */ }
    };
    tick();
    const id = setInterval(tick, 60000);
    return () => clearInterval(id);
  }, [onAlert]);
  return null;
}

const round2 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
const receiptTx = (r) => ({
  invoice_no: r.invoice_no, created_at: new Date().toISOString(), grand_total: r.grand_total,
  subtotal: r.subtotal, discount_total: r.discount_total, tax_total: r.tax_total, service_total: r.service_total,
  payment_name: r.payment?.name || r.payment_name, paid_amount: r.paid_amount ?? r.receipt?.pricing?.paid_amount,
  change_amount: r.change_amount ?? r.receipt?.pricing?.change_amount, note: r.note,
});
const receiptLines = (r) => (r.items || r.lines || []).map((l) => ({
  name_snapshot: l.name_snapshot || l.name, qty: l.qty, unit_price: l.unit_price,
  line_total: l.line_total, line_discount: l.line_discount, addons_json: l.addons_json ?? l.addons,
}));
