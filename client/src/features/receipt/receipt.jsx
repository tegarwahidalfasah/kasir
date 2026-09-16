// ===========================================================================
//  Struk / invoice — ditata dari settings.receipt (dikustomisasi pemilik toko).
//  Font monospace + lebar kolom mengikuti kertas (58/72/80mm), tanpa lib cetak.
// ===========================================================================
import React, { useEffect, useMemo, useRef } from 'react';
import { money, dateTime } from '../../lib/format.js';

export const COLS = { 58: 32, 60: 32, 65: 38, 72: 42, 76: 44, 80: 48 };

const cols = (receipt) => COLS[Number(receipt.paper_width)] || 32;
const rule = (ch, n) => ch.repeat(Math.max(3, Math.floor(n)));
const center = (text, width, ch) => {
  const t = String(text).replace(/\s+/g, ' ').trim().slice(0, Math.max(4, width));
  const pad = Math.max(0, Math.floor((width - t.length) / 2));
  return (ch ? ch.repeat(pad) : ' '.repeat(pad)) + t + (ch ? ch.repeat(pad) : ' '.repeat(Math.max(0, width - t.length - pad)));
};
/** Label + angka rata kanan; kalau tidak muat, label dipotong (bukan menumpuk). */
const twoCol = (left, right, width) => {
  const l = String(left).replace(/\s+/g, ' ').trim();
  const r = String(right).replace(/\s+/g, ' ').trim();
  if (l.length + r.length + 1 > width) {
    const keep = Math.max(1, width - r.length - 2);
    const cut = l.length > keep ? `${l.slice(0, Math.max(1, keep - 1))}…` : l;
    if (cut.length + r.length + 1 > width) return `${cut}\n${' '.repeat(Math.max(0, width - r.length))}${r}`;
    return `${cut}${' '.repeat(Math.max(1, width - cut.length - r.length))}${r}`;
  }
  return `${l}${' '.repeat(width - l.length - r.length)}${r}`;
};
const wrap = (text, width) => String(text).split('\n').flatMap((line) => {
  if (line.length <= width) return [line];
  const words = line.split(' ');
  const out = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out;
});
const substitute = (str, map) => String(str ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (map[k] ?? ''));

/** Susun baris teks struk (juga dipakai untuk mode cetak & ekspor). */
export function buildReceiptLines({ snapshot, tx, items = [], receipt, store }) {
  const cfg = receipt || snapshot?.receipt || {};
  const show = { ...(cfg.show || {}) };
  const width = cols(cfg);
  const W = width - 2;
  const p = snapshot?.pricing || {};
  const grand = p.grand_total ?? tx?.grand_total ?? 0;
  const lines = [];
  const push = (...t) => lines.push(...t.flatMap((x) => wrap(x, W)));

  (cfg.custom_lines || []).filter((l) => l.position === 'top' && l.text).forEach((l) => push(substitute(l.text, { store_name: store?.name, invoice: tx?.invoice_no })));
  if (show.logo && (store?.logo_data_url || snapshot?.store?.logo)) lines.push('[[LOGO]]');
  if (show.store_name) push(center(cfg.header || store?.name || snapshot?.store?.name || '', W, cfg.center_char));
  else if (cfg.header) push(center(cfg.header, W, cfg.center_char));
  if (cfg.subheader) push(center(cfg.subheader, W));
  if (show.address && (store?.address || snapshot?.store?.address)) push(center(store?.address || snapshot?.store?.address, W));
  if (show.phone && (store?.phone || snapshot?.store?.phone)) push(center(store?.phone || snapshot?.store?.phone, W));
  if (show.npwp && (store?.npwp || snapshot?.store?.npwp)) push(center(`NPWP ${store?.npwp || snapshot?.store?.npwp}`, W));
  push(rule(cfg.line_char, W));

  const info = [];
  if (show.invoice) info.push(['No', tx?.invoice_no || '—']);
  if (show.date) info.push(['Tgl', dateTime(tx?.created_at)]);
  if (show.cashier) info.push(['Kasir', snapshot?.cashier_name || tx?.cashier_name || '—']);
  if (tx?.customer_name) info.push(['Pelanggan', tx.customer_name]);
  if (tx?.order_type) info.push(['Tipe', tx.order_type === 'dine_in' ? 'Di tempat' : tx.order_type === 'take_away' ? 'Bawa pulang' : tx.order_type]);
  info.forEach(([k, v]) => push(twoCol(k, v, W)));
  if (info.length) push(rule(cfg.line_char, W));

  if (show.items) {
    for (const it of items) {
      const addon = Array.isArray(it.addons_json) ? it.addons_json : safeArr(it.addons_json);
      push(twoCol(`${it.name_snapshot} x${trim(it.qty)}`, money(it.line_total), W));
      if (Number(it.unit_price) * Number(it.qty) !== Number(it.line_total)) {
        push(twoCol(`  ${money(it.unit_price)}/${trim(it.qty)} unit`, Number(it.line_discount) ? `- ${money(it.line_discount)}` : '', W));
      }
      addon.forEach((a) => a && a.name && push(twoCol(`  + ${a.name}`, a.price_delta ? money(a.price_delta * (a.qty ?? 1)) : '', W)));
    }
    push(rule(cfg.line_char, W));
  }

  push(twoCol('Subtotal', money(p.subtotal ?? tx?.subtotal), W));
  if (show.discounts && (p.discount_total ?? tx?.discount_total)) {
    (p.discount_lines || []).forEach((d) => push(twoCol(`Diskon ${d.name}`, `- ${money(d.amount)}`, W)));
    if (!(p.discount_lines || []).length) push(twoCol('Diskon', `- ${money(tx?.discount_total)}`, W));
  }
  if (show.service && (p.service_total ?? tx?.service_total)) push(twoCol('Service', money(p.service_total ?? tx.service_total), W));
  if (show.tax && (p.tax_total ?? tx?.tax_total)) push(twoCol('Pajak', money(p.tax_total ?? tx.tax_total), W));
  if (p.rounding_total) push(twoCol('Pembulatan', money(p.rounding_total), W));
  push(rule(cfg.line_char, W));
  lines.push(center(twoCol('TOTAL', money(grand), W), W).trim());
  push(rule(cfg.line_char, W));

  if (show.payment) {
    if (tx?.payment_name) push(twoCol(`Bayar (${tx.payment_name})`, money(p.paid_amount ?? tx.paid_amount), W));
    if (p.fee_total) push(twoCol('Biaya layanan', money(p.fee_total), W));
    if (show.change && Number(p.change_amount ?? tx?.change_amount ?? 0) > 0) push(twoCol('Kembali', money(p.change_amount ?? tx.change_amount), W));
    push(rule(cfg.line_char, W));
  }
  if (tx?.note) push(`Catatan: ${tx.note}`);
  if (show.social && cfg.social) push(center(cfg.social, W));
  if (show.footer && cfg.footer) push(center(cfg.footer, W));
  if (cfg.thank_you) push(center(cfg.thank_you, W, cfg.center_char));
  (cfg.custom_lines || []).filter((l) => l.position === 'bottom' && l.text).forEach((l) => push(substitute(l.text, { store_name: store?.name, invoice: tx?.invoice_no, grand_total: money(grand) })));
  return lines;
}
const trim = (n) => String(Number(n) % 1 === 0 ? Number(n) : Number(n).toFixed(2));
const safeArr = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : (v || []); } catch { return []; } };

/** Komponen struk di layar (pratinjau & cetak). */
export function Receipt({ snapshot, tx, items, receipt, store, className = '' }) {
  const cfg = receipt || snapshot?.receipt || {};
  const lines = useMemo(() => buildReceiptLines({ snapshot, tx, items, receipt: cfg, store }), [snapshot, tx, items, cfg, store]);
  const width = cols(cfg);
  const sizeCls = Number(cfg.paper_width) >= 76 ? 'receipt-80' : Number(cfg.paper_width) >= 200 ? 'receipt-a4' : '';
  const scale = Number(cfg.font_scale) || 1;
  return (
    <div className={`receipt ${sizeCls} ${className}`} style={{ fontSize: `${12 * scale}px`, width: `${width}ch`, maxWidth: '100%' }}>
      {lines.map((l, i) => (l === '[[LOGO]]'
        ? <img key={i} className="receipt-logo" src={(store?.logo_data_url || snapshot?.store?.logo)} alt="logo" />
        : <div key={i} style={{ minHeight: l.trim() ? undefined : '6px', fontWeight: /TOTAL|Subtotal/.test(l) ? 700 : undefined }}>{l}</div>))}
    </div>
  );
}

/** Cetak lewat dokumen terpisah agar tidak membawa CSS aplikasi. */
export function printReceipt({ title = 'Struk', lines, width = 72, fontScale = 1 }) {
  const html = `<style>
    @page { margin: 4mm; size: ${width}mm auto; }
    body { font-family: "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace; font-size: ${12 * fontScale}px; line-height: 1.45; margin: 0; color: #000; }
    .ln { white-space: pre-wrap; word-break: break-word; }
    .b { font-weight: 700; }
    img { max-width: 70%; max-height: 56px; display: block; margin: 0 auto 4px; }
  </style>${lines.map((l) => (l === '[[LOGO]]'
    ? `<img src="${document.querySelector('.receipt-logo')?.src || ''}" alt="" />`
    : `<div class="ln ${/TOTAL/.test(l) ? 'b' : ''}">${escapeHtml(l) || '&nbsp;'}</div>`)).join('')}`;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const doc = frame.contentWindow.document;
  doc.open();
  doc.write(`<!doctype html><html lang="id"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${html}</body></html>`);
  doc.close();
  const go = () => { frame.contentWindow.focus(); frame.contentWindow.print(); setTimeout(() => frame.remove(), 1200); };
  if (doc.readyState === 'complete') setTimeout(go, 120); else frame.onload = () => setTimeout(go, 120);
}
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
