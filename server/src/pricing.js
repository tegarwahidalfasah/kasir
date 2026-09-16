// ===========================================================================
//  Mesin Kalkulasi Harga (Fase 2) — MURNI / PURE, tanpa dependency & tanpa DB.
//  File ini dipakai DUA kali:
//    • server  -> sumber kebenaran saat transaksi disimpan
//    • client  -> pratinjau keranjang real-time (via alias '@shared')
//  Supaya angka di layar kasir 100% sama dengan angka di struk & laporan.
// ===========================================================================

const round0 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

export function applyRounding(amount, mode = 'nearest', step = 1) {
  const s = Math.max(0.000001, Number(step) || 1);
  if (mode === 'none') return round0(amount);
  if (mode === 'up') return Math.ceil(amount / s) * s;
  if (mode === 'down') return Math.floor(amount / s) * s;
  return Math.round(amount / s) * s;
}

export function discountValue(rule, base) {
  const raw = rule.kind === 'fixed' ? Number(rule.value) : base * (Number(rule.value) || 0) / 100;
  const capped = rule.max_discount != null ? Math.min(raw, Number(rule.max_discount)) : raw;
  return Math.max(0, Math.min(round0(capped), round0(base)));
}

/** Apakah rule diskon "auto" layak dipakai pada saat transaksi ini terjadi? */
export function ruleMatches(rule, ctx) {
  if (!rule || !rule.is_active) return false;
  const d = ctx.date instanceof Date ? ctx.date : new Date(ctx.date || Date.now());
  if (rule.valid_from && d < new Date(rule.valid_from)) return false;
  if (rule.valid_to && d > new Date(rule.valid_to + 'T23:59:59')) return false;
  switch (rule.trigger) {
    case 'auto_weekday':
      return Array.isArray(rule.days) && rule.days.length > 0 && rule.days.includes(d.getDay());
    case 'auto_time': {
      const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const start = rule.start_time || '00:00';
      const end = rule.end_time || '23:59';
      return start <= end ? (hhmm >= start && hhmm <= end) : (hhmm >= start || hhmm <= end);
    }
    case 'auto_min_subtotal':
      return (ctx.base || 0) >= (Number(rule.min_subtotal) || 0);
    case 'manual':
      return ctx.allowManual === true;
    default:
      return false;
  }
}

/**
 * Hitung seluruh komposisi harga sebuah transaksi.
 * @param {Object} input
 * @param {Array}  input.lines        [{ item_id, qty, unit_price?, discount?, addons? }]
 * @param {Object} input.catalog      Map(id -> item) berisi selling_price, tax_mode, tax_rate, is_non_stock
 * @param {Object} input.taxConfig    blok settings.tax
 * @param {Array}  input.taxes        tabel taxes aktif
 * @param {Array}  input.discounts    tabel discounts aktif
 * @param {Array}  input.selectedDiscountIds  diskon manual yang dipilih kasir
 * @param {Object} input.paymentMethod        metode pembayaran (service_fee_pct)
 * @param {Date}   input.date
 * @param {number} input.paidAmount
 */
export function calculatePrice({
  lines = [], catalog = {}, taxConfig = {}, taxes = [], discounts = [],
  selectedDiscountIds = [], paymentMethod = null, date = new Date(), paidAmount = null,
}) {
  const cfg = {
    enabled: true, default_rate_pct: 0, inclusive: false, service_charge_pct: 0,
    rounding_mode: 'nearest', rounding_step: 1, ...taxConfig,
  };

  const outLines = [];
  let subtotalList = 0;
  let lineDiscountTotal = 0;
  let costTotal = 0;

  // pajak "inclusive" boleh ditetapkan lewat tabel taxes (default tax) maupun settings.tax
  const defaultTax = (taxes || []).find((t) => t.is_default) || (taxes || [])[0] || null;
  if (defaultTax && defaultTax.is_inclusive) cfg.inclusive = true;

  for (const raw of lines) {
    const qty = Math.max(0, Number(raw.qty) || 0);
    const item = catalog[raw.item_id] || {};
    const unitPrice = raw.unit_price != null ? round0(raw.unit_price) : round0(item.selling_price ?? 0);
    const addonDelta = Array.isArray(raw.addons)
      ? raw.addons.reduce((s, a) => s + round0(a.price_delta ?? 0) * (a.qty ?? 1), 0) : 0;
    const base = round0((unitPrice + addonDelta) * qty);
    let disc = round0(raw.discount || 0);
    if (disc > base) disc = base;
    if (disc < 0) disc = 0;
    const total = round0(base - disc);
    const unitCost = round0(item.cost_price ?? 0);
    const lineCost = round0(unitCost * qty);

    // pajak per baris: inherit -> aturan default toko, exempt -> 0, override -> tax_rate item
    const taxable = round0(base - disc);
    let lineRate = 0;
    if (cfg.enabled) {
      if (item.tax_mode === 'exempt') lineRate = 0;
      else if (item.tax_mode === 'override') lineRate = Number(item.tax_rate) || 0;
      else lineRate = defaultTax ? Number(defaultTax.rate_pct) : Number(cfg.default_rate_pct);
      if (item.tax_mode === 'override' && cfg.inclusive) lineRate = Number(item.tax_rate) || 0;
    }

    subtotalList += base;
    lineDiscountTotal += disc;
    costTotal += lineCost;
    outLines.push({
      item_id: raw.item_id, name_snapshot: item.name ?? raw.name ?? 'Item', qty,
      unit_price: unitPrice, addon_delta: addonDelta, line_discount: disc, line_total: total,
      line_base: base, tax_rate: lineRate, tax_base: taxable,
      cost_snapshot: unitCost, cost_total: lineCost,
      item_type: item.item_type || 'finished', is_non_stock: !!item.is_non_stock,
      addons: raw.addons || [],
    });
  }

  // ---- diskon global otomatis + manual ---------------------------------
  const baseForGlobal = round0(subtotalList - lineDiscountTotal);
  const active = (discounts || []).filter((r) => r.is_active);
  const autoRules = active.filter((r) => r.trigger !== 'manual' && ruleMatches(r, { date, base: baseForGlobal }));
  const manualRules = active.filter((r) => (selectedDiscountIds || []).includes(r.id));
  const chosen = [];
  let applied = [];

  for (const rule of [...autoRules, ...manualRules]) {
    if (chosen.some((c) => c.id === rule.id)) continue;
    if (rule.kind !== 'fixed' && rule.kind !== 'percent') continue;
    const scoped = scopeBase(rule, outLines, baseForGlobal);
    const val = discountValue(rule, scoped);
    if (val > 0) { chosen.push({ id: rule.id, name: rule.name, kind: rule.kind, value: rule.value, amount: val, scope: rule.applies_to }); }
  }
  if (chosen.length > 1 && !chosen.every((c) => (active.find((r) => r.id === c.id) || {}).stackable)) {
    applied = [chosen.reduce((a, b) => (b.amount > a.amount ? b : a))];
  } else {
    applied = chosen;
  }
  const globalDiscount = round0(Math.min(baseForGlobal, applied.reduce((s, c) => s + c.amount, 0)));

  const net = round0(baseForGlobal - globalDiscount);

  // ---- service charge ----------------------------------------------------
  const serviceTotal = round0(net * (Number(cfg.service_charge_pct) || 0) / 100);
  const taxableBase = round0(net + serviceTotal);

  // ---- pajak -------------------------------------------------------------
  let taxTotal = 0;
  if (cfg.enabled) {
    const weighted = outLines.reduce((s, l) => s + (taxableBase ? (l.tax_base / (baseForGlobal || 1)) : 0) * l.tax_rate, 0);
    const rate = baseForGlobal > 0 ? weighted : (outLines[0]?.tax_rate ?? 0);
    taxTotal = cfg.inclusive
      ? round0(taxableBase - taxableBase / (1 + (rate || 0) / 100))
      : round0(taxableBase * (rate || 0) / 100);
  }

  const preRound = round0(taxableBase + (cfg.inclusive ? 0 : taxTotal));
  const rounded = applyRounding(preRound, cfg.rounding_mode, cfg.rounding_step);
  const grandTotal = Math.max(0, Math.round(rounded));
  const roundingTotal = round0(grandTotal - preRound);

  const feePct = Number(paymentMethod?.service_fee_pct) || 0;
  const feeTotal = round0(grandTotal * feePct / 100);

  const paid = paidAmount == null ? null : round0(paidAmount);
  const totalDue = round0(grandTotal + feeTotal);
  const change = paid != null ? round0(paid - totalDue) : 0;
  if (paid != null && change < -0.0001) {
    const err = new Error(`Uang tunai kurang ${Math.abs(change).toLocaleString('id-ID')}`);
    err.status = 400;
    throw err;
  }

  return {
    lines: outLines,
    subtotal: round0(subtotalList),
    line_discount_total: round0(lineDiscountTotal),
    discount_total: round0(lineDiscountTotal + globalDiscount),
    discount_lines: applied,
    service_total: serviceTotal,
    tax_total: taxTotal,
    tax_effective_rate: cfg.enabled ? taxTotal / (taxableBase || 1) * 100 : 0,
    rounding_total: roundingTotal,
    grand_total: grandTotal,
    cost_total: costTotal,
    fee_total: feeTotal,
    total_due: totalDue,
    paid_amount: paid,
    change_amount: paid != null ? Math.max(0, change) : 0,
    profit: round0(grandTotal - costTotal - taxTotal),
  };
}

/** Dasar pengenaan diskon global/category/item (sederhana namun bisa dipahami kasir). */
function scopeBase(rule, lines, baseForGlobal) {
  if (rule.applies_to === 'global' || !rule.ref_ids) return baseForGlobal;
  let ids = [];
  try { ids = JSON.parse(rule.ref_ids); } catch { ids = []; }
  if (!Array.isArray(ids) || !ids.length) return baseForGlobal;
  const set = new Set(ids);
  const match = rule.applies_to === 'item'
    ? lines.filter((l) => set.has(l.item_id))
    : lines; // kategori: sudah difilter pemanggil bila perlu
  return round0(match.reduce((s, l) => s + l.line_base - l.line_discount, 0));
}

/** Estimasi HPP dari BOM (dipakai untuk proyeksi laba per item). */
export function bomUnitCost(bomRows = [], rawCatalog = {}) {
  return round0(bomRows.reduce((s, r) => {
    const cost = Number(rawCatalog[r.raw_item_id]?.cost_price ?? 0);
    return s + (Number(r.qty) || 0) * cost * (1 + (Number(r.waste_pct) || 0) / 100);
  }, 0));
}

export const money = (n, locale = 'id-ID', currency = 'IDR') =>
  new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));
