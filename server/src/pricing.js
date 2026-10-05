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

/** Parse date/time at the store's business timezone, not the host's timezone. */
function datePartsAt(date, timeZone) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  if (!Number.isFinite(d.getTime())) return null;

  const formatInZone = (zone) => {
    const fields = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((part) => [part.type, part.value]));
    const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[fields.weekday];
    return {
      day: `${fields.year}-${fields.month}-${fields.day}`,
      weekday,
      hhmm: `${fields.hour}:${fields.minute}`,
    };
  };

  if (timeZone) {
    try { return formatInZone(timeZone); } catch { /* invalid store zone -> WIB fallback */ }
    try { return formatInZone('Asia/Jakarta'); } catch { /* Intl unavailable -> local fallback */ }
  }
  return {
    day: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    weekday: d.getDay(),
    hhmm: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  };
}

function ruleDays(value) {
  let days = value;
  if (typeof days === 'string') {
    try { days = JSON.parse(days); } catch { return []; }
  }
  return Array.isArray(days)
    ? days.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    : [];
}

/** Apakah aturan diskon berlaku pada waktu bisnis toko saat transaksi dibuat? */
export function ruleMatches(rule, ctx = {}) {
  if (!rule || !rule.is_active) return false;
  const d = ctx.date instanceof Date ? ctx.date : new Date(ctx.date || Date.now());
  const local = datePartsAt(d, ctx.timeZone);
  if (!local) return false;
  const validFrom = rule.valid_from ? String(rule.valid_from).slice(0, 10) : null;
  const validTo = rule.valid_to ? String(rule.valid_to).slice(0, 10) : null;
  if (validFrom && local.day < validFrom) return false;
  if (validTo && local.day > validTo) return false;
  switch (rule.trigger) {
    case 'auto_weekday':
      return ruleDays(rule.days).includes(local.weekday);
    case 'auto_time': {
      const start = rule.start_time || '00:00';
      const end = rule.end_time || '23:59';
      return start <= end ? (local.hhmm >= start && local.hhmm <= end) : (local.hhmm >= start || local.hhmm <= end);
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
  selectedDiscountIds = [], paymentMethod = null, date = new Date(), timeZone = null, paidAmount = null,
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
      category_id: item.category_id ?? null,
      addons: raw.addons || [],
    });
  }

  // ---- diskon otomatis + manual, dengan cakupan item/kategori -------------
  const baseForGlobal = round0(subtotalList - lineDiscountTotal);
  const active = (discounts || []).filter((r) => r.is_active);
  const autoRules = active.filter((r) => r.trigger !== 'manual' && ruleMatches(r, { date, timeZone, base: baseForGlobal }));
  // Hanya rule berpemicu manual yang boleh dipilih dari payload; klien tidak dapat
  // memaksa promo otomatis aktif di luar jadwalnya dengan mengirim ID rule.
  const manualRules = active.filter((r) => r.trigger === 'manual'
    && (selectedDiscountIds || []).includes(r.id)
    && ruleMatches(r, { date, timeZone, base: baseForGlobal, allowManual: true }));
  const chosen = [];

  for (const rule of [...autoRules, ...manualRules]) {
    if (chosen.some((c) => c.id === rule.id)) continue;
    if (rule.kind !== 'fixed' && rule.kind !== 'percent') continue;
    const indexes = scopeLineIndexes(rule, outLines);
    const scoped = scopeBase(rule, outLines);
    const amount = discountValue(rule, scoped);
    if (amount > 0) chosen.push({ id: rule.id, name: rule.name, kind: rule.kind, value: rule.value, amount, scope: rule.applies_to || 'global', targetIndexes: indexes });
  }

  let selected = chosen;
  if (chosen.length > 1 && !chosen.every((c) => (active.find((r) => r.id === c.id) || {}).stackable)) {
    selected = [chosen.reduce((a, b) => (b.amount > a.amount ? b : a))];
  }

  // Alokasikan diskon ke baris yang memang masuk cakupan. Ini menjaga diskon item/kategori
  // agar tidak menurunkan dasar pajak barang lain, dan mencegah diskon bertumpuk melebihi
  // nilai baris yang memenuhi syarat.
  const remainingByLine = outLines.map((line) => Math.max(0, round0(line.line_total)));
  const globalDiscountByLine = outLines.map(() => 0);
  const applied = [];
  for (const rule of selected) {
    const indexes = rule.targetIndexes || scopeLineIndexes(rule, outLines);
    const available = round0(indexes.reduce((sum, i) => sum + remainingByLine[i], 0));
    let remainingAmount = Math.min(rule.amount, available);
    if (remainingAmount <= 0 || available <= 0) continue;
    const amountBeforeAllocation = remainingAmount;
    const eligible = indexes.filter((i) => remainingByLine[i] > 0);

    eligible.forEach((index, position) => {
      if (remainingAmount <= 0) return;
      const proposed = position === eligible.length - 1
        ? remainingAmount
        : round0(amountBeforeAllocation * remainingByLine[index] / available);
      const part = Math.min(remainingByLine[index], proposed, remainingAmount);
      globalDiscountByLine[index] = round0(globalDiscountByLine[index] + part);
      remainingByLine[index] = round0(remainingByLine[index] - part);
      remainingAmount = round0(remainingAmount - part);
    });

    // Serap residu pembulatan pada baris mana pun yang masih punya sisa dasar.
    for (const index of eligible) {
      if (remainingAmount <= 0) break;
      const part = Math.min(remainingByLine[index], remainingAmount);
      globalDiscountByLine[index] = round0(globalDiscountByLine[index] + part);
      remainingByLine[index] = round0(remainingByLine[index] - part);
      remainingAmount = round0(remainingAmount - part);
    }
    const appliedAmount = round0(amountBeforeAllocation - remainingAmount);
    if (appliedAmount > 0) applied.push({
      id: rule.id, name: rule.name, kind: rule.kind, value: rule.value,
      amount: appliedAmount, scope: rule.scope,
    });
  }
  const globalDiscount = round0(applied.reduce((sum, rule) => sum + rule.amount, 0));
  const net = round0(baseForGlobal - globalDiscount);

  // ---- service charge ----------------------------------------------------
  const serviceTotal = round0(net * (Number(cfg.service_charge_pct) || 0) / 100);
  const taxableBase = round0(net + serviceTotal);

  // ---- pajak -------------------------------------------------------------
  let taxTotal = 0;
  if (cfg.enabled && net > 0) {
    const serviceFactor = taxableBase / net; // biaya layanan dialokasikan proporsional per baris
    taxTotal = round0(outLines.reduce((sum, line, index) => {
      const netLine = Math.max(0, round0(line.tax_base - globalDiscountByLine[index]));
      const grossLine = netLine * serviceFactor;
      const rate = Number(line.tax_rate) || 0;
      if (cfg.inclusive) return sum + (rate ? grossLine - grossLine / (1 + rate / 100) : 0);
      return sum + grossLine * rate / 100;
    }, 0));
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

/** ID cakupan dapat datang sebagai array API maupun JSON dari tabel SQLite. */
function referenceIds(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

/** Baris yang masuk cakupan diskon. Cakupan kosong/invalid ditolak tertutup (tidak global). */
function scopeLineIndexes(rule, lines) {
  const scope = rule.applies_to || 'global';
  if (scope === 'global') return lines.map((_line, index) => index);
  if (scope !== 'item' && scope !== 'category') return [];
  const ids = referenceIds(rule.ref_ids);
  if (!ids.length) return [];
  const set = new Set(ids);
  return lines.reduce((indexes, line, index) => {
    const id = scope === 'item' ? line.item_id : line.category_id;
    if (id != null && set.has(String(id))) indexes.push(index);
    return indexes;
  }, []);
}

/** Dasar pengenaan diskon global/category/item. */
function scopeBase(rule, lines) {
  const indexes = scopeLineIndexes(rule, lines);
  return round0(indexes.reduce((sum, index) => {
    const line = lines[index];
    return sum + Math.max(0, Number(line.line_base) - Number(line.line_discount));
  }, 0));
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
