// ===========================================================================
//  Unit test mesin kalkulasi harga (Fase 2) — murni, tanpa database.
//  Dijalankan: npm test
// ===========================================================================
import { describe, it, assert, standalone } from './harness.js';
import { calculatePrice, applyRounding, ruleMatches, discountValue } from '../src/pricing.js';

const catalog = {
  a: { name: 'Kopi', item_type: 'finished', selling_price: 18000, cost_price: 4000, tax_mode: 'inherit' },
  b: { name: 'Air', item_type: 'finished', selling_price: 5000, cost_price: 1000, tax_mode: 'exempt' },
  c: { name: 'Kue', item_type: 'finished', selling_price: 12000, cost_price: 7000, tax_mode: 'override', tax_rate: 5 },
};
const TAX = [{ id: 't1', name: 'PPn', rate_pct: 11, is_default: 1, is_inclusive: 0 }];

describe('pricing', () => {
  it('menjumlahkan subtotal, pajak 11% dan total akhir', () => {
    const r = calculatePrice({ lines: [{ item_id: 'a', qty: 2 }], catalog, taxes: TAX, taxConfig: { enabled: true, rounding_mode: 'none' } });
    assert.equal(r.subtotal, 36000);
    assert.equal(r.tax_total, 3960);
    assert.equal(r.grand_total, 39960);
    assert.equal(r.cost_total, 8000);
    assert.equal(r.profit, 39960 - 8000 - 3960);
  });

  it('baris pajak exempt tidak dikenai pajak, override memakai rate item', () => {
    const r = calculatePrice({ lines: [{ item_id: 'b', qty: 1 }, { item_id: 'c', qty: 1 }], catalog, taxes: TAX, taxConfig: { enabled: true, rounding_mode: 'none' } });
    // dasar 17000; air 0%, kue 5% -> pajak tertimbang 5*(12000/17000) atas 17000
    assert.equal(r.subtotal, 17000);
    assert.ok(Math.abs(r.tax_total - 12000 * 0.05) < 1, 'pajak seharusnya ±600, dapat ' + r.tax_total);
    assert.equal(Math.round(r.grand_total), 17600);
  });

  it('diskon per baris mengurangi dasar pengenaan pajak', () => {
    const r = calculatePrice({ lines: [{ item_id: 'a', qty: 1, discount: 3000 }], catalog, taxes: TAX, taxConfig: { enabled: true, rounding_mode: 'none' } });
    assert.equal(r.subtotal, 18000);
    assert.equal(r.discount_total, 3000);
    assert.equal(Math.round(r.tax_total), 1650);
    assert.equal(r.grand_total, 16650);
  });

  it('diskon global persen otomatis (trigger minimum subtotal) dipakai saat layak', () => {
    const rules = [{ id: 'd1', name: 'Hemat', kind: 'percent', value: 10, applies_to: 'global', trigger: 'auto_min_subtotal', min_subtotal: 50000, is_active: 1, stackable: 0 }];
    const ok = calculatePrice({ lines: [{ item_id: 'a', qty: 3 }], catalog, taxes: [], discounts: rules, taxConfig: { enabled: false, rounding_mode: 'none' } });
    assert.equal(ok.discount_lines.length, 1);
    assert.equal(ok.discount_total, 5400);
    assert.equal(ok.grand_total, 54000 - 5400);

    const no = calculatePrice({ lines: [{ item_id: 'a', qty: 1 }], catalog, taxes: [], discounts: rules, taxConfig: { enabled: false, rounding_mode: 'none' } });
    assert.equal(no.discount_lines.length, 0, 'tidak boleh apply di bawah minimum');
  });

  it('diskon manual hanya aktif bila dipilih kasir', () => {
    const rules = [{ id: 'dm', name: 'Manual', kind: 'fixed', value: 2000, applies_to: 'global', trigger: 'manual', is_active: 1 }];
    const a = calculatePrice({ lines: [{ item_id: 'a', qty: 1 }], catalog, taxes: [], discounts: rules, taxConfig: { rounding_mode: 'none' } });
    assert.equal(a.discount_total, 0);
    const b = calculatePrice({ lines: [{ item_id: 'a', qty: 1 }], catalog, taxes: [], discounts: rules, selectedDiscountIds: ['dm'], taxConfig: { rounding_mode: 'none' } });
    assert.equal(b.discount_total, 2000);
    assert.equal(b.grand_total, 16000);
  });

  it('max_discount membatasi diskon persen', () => {
    const r = calculatePrice({
      lines: [{ item_id: 'a', qty: 10 }], catalog, taxes: [],
      discounts: [{ id: 'x', name: 'Besar', kind: 'percent', value: 50, applies_to: 'global', trigger: 'auto_min_subtotal', min_subtotal: 0, max_discount: 4000, is_active: 1 }],
      taxConfig: { rounding_mode: 'none' },
    });
    assert.equal(r.discount_total, 4000);
  });

  it('service charge dihitung setelah diskon, pajak di atasnya', () => {
    const r = calculatePrice({
      lines: [{ item_id: 'a', qty: 1 }], catalog, taxes: TAX,
      discounts: [{ id: 'p', name: '10%', kind: 'percent', value: 10, applies_to: 'global', trigger: 'manual', is_active: 1 }],
      selectedDiscountIds: ['p'],
      taxConfig: { enabled: true, service_charge_pct: 5, rounding_mode: 'none' },
    });
    assert.equal(r.service_total, 810);            // 5% x 16200
    assert.ok(Math.abs(r.tax_total - 1871.1) < 0.5, 'pajak 11% x 17010 = ' + r.tax_total);
    assert.equal(Math.round(r.grand_total), 18881); // 17010 + 1871
  });

  it('pajak inclusive: total tidak bertambah, pajak diurai dari harga', () => {
    const r = calculatePrice({ lines: [{ item_id: 'a', qty: 1 }], catalog, taxes: [{ ...TAX[0], is_inclusive: 1 }], taxConfig: { enabled: true, rounding_mode: 'none' } });
    assert.equal(r.grand_total, 18000);
    assert.ok(Math.abs(r.tax_total - 18000 / 1.11 * 0.11) < 1, 'ppn terkandung: ' + r.tax_total);
  });

  it('pembulatan ke 50 rupiah nearest/up/down', () => {
    assert.equal(applyRounding(1237, 'nearest', 50), 1250);
    assert.equal(applyRounding(1237, 'up', 50), 1250);
    assert.equal(applyRounding(1237, 'down', 50), 1200);
    assert.equal(applyRounding(1237, 'none', 50), 1237);
    const r = calculatePrice({ lines: [{ item_id: 'a', qty: 1 }], catalog, taxes: TAX, taxConfig: { enabled: true, rounding_mode: 'nearest', rounding_step: 50 } });
    assert.equal(r.grand_total % 50, 0, 'grand total harus kelipatan 50: ' + r.grand_total);
  });

  it('uang tunai kurang -> error; cukup -> kembalian', () => {
    assert.throws(() => calculatePrice({ lines: [{ item_id: 'a', qty: 1 }], catalog, taxes: TAX, taxConfig: {}, paidAmount: 1000 }), /kurang/);
    const r = calculatePrice({ lines: [{ item_id: 'a', qty: 1 }], catalog, taxes: TAX, taxConfig: {}, paidAmount: 50000 });
    assert.equal(r.change_amount, 50000 - r.total_due);
  });

  it('biaya layanan metode pembayaran ditambahkan ke total bayar', () => {
    const r = calculatePrice({ lines: [{ item_id: 'a', qty: 1 }], catalog, taxes: TAX, taxConfig: { rounding_mode: 'nearest', rounding_step: 50 }, paymentMethod: { service_fee_pct: 0.7 }, paidAmount: 40000 });
    assert.equal(r.grand_total, 20000);
    assert.equal(Math.round(r.fee_total), 140);          // 0.7% x 20000
    assert.equal(Math.round(r.total_due), 20140);
    assert.equal(r.change_amount, 40000 - r.total_due);
  });

  it('addon menaikkan harga & dihitung per qty', () => {
    const r = calculatePrice({ lines: [{ item_id: 'a', qty: 2, addons: [{ name: 'extra shot', price_delta: 6000 }] }], catalog, taxes: TAX, taxConfig: { enabled: false, rounding_mode: 'none' } });
    assert.equal(r.subtotal, 48000);
  });

  it('diskon non-stackable: hanya rule terbesar yang dipakai', () => {
    const rules = [
      { id: 'r1', name: 'A', kind: 'percent', value: 5, applies_to: 'global', trigger: 'auto_min_subtotal', min_subtotal: 0, is_active: 1, stackable: 0 },
      { id: 'r2', name: 'B', kind: 'percent', value: 12, applies_to: 'global', trigger: 'auto_min_subtotal', min_subtotal: 0, is_active: 1, stackable: 0 },
    ];
    const r = calculatePrice({ lines: [{ item_id: 'a', qty: 1 }], catalog, taxes: [], discounts: rules, taxConfig: { rounding_mode: 'none' } });
    assert.equal(r.discount_lines.length, 1);
    assert.equal(r.discount_lines[0].name, 'B');
  });

  it('ruleMatches: hari, jam, dan tanggal berlaku', () => {
    const tue = new Date(2026, 8, 15, 16, 0); // Selasa 16:00
    assert.equal(ruleMatches({ trigger: 'auto_weekday', days: [2], is_active: 1 }, { date: tue }), true);
    assert.equal(ruleMatches({ trigger: 'auto_weekday', days: [1], is_active: 1 }, { date: tue }), false);
    assert.equal(ruleMatches({ trigger: 'auto_time', start_time: '15:00', end_time: '17:00', is_active: 1 }, { date: tue }), true);
    assert.equal(ruleMatches({ trigger: 'auto_time', start_time: '18:00', end_time: '20:00', is_active: 1 }, { date: tue }), false);
    assert.equal(ruleMatches({ trigger: 'auto_time', start_time: '22:00', end_time: '02:00', is_active: 1 }, { date: tue }), false);
    assert.equal(ruleMatches({ trigger: 'auto_min_subtotal', min_subtotal: 100, is_active: 1 }, { date: tue, base: 50 }), false);
    assert.equal(discountValue({ kind: 'fixed', value: 1500 }, 10000), 1500);
    assert.equal(discountValue({ kind: 'percent', value: 10 }, 10000), 1000);
    assert.equal(discountValue({ kind: 'percent', value: 50 }, 1000), 500); // tidak melebihi dasar
  });

  it('keranjang kosong / qty nol tidak menghasilkan tagihan', () => {
    const r = calculatePrice({ lines: [], catalog, taxes: TAX, taxConfig: {} });
    assert.equal(r.grand_total, 0);
    const r2 = calculatePrice({ lines: [{ item_id: 'a', qty: 0 }], catalog, taxes: TAX, taxConfig: { rounding_mode: 'none' } });
    assert.equal(r2.subtotal, 0);
  });

  it('harga item tidak ada di katalog -> 0, tidak meledak', () => {
    const r = calculatePrice({ lines: [{ item_id: 'zzz', qty: 1 }], catalog, taxes: TAX, taxConfig: { rounding_mode: 'none' } });
    assert.equal(r.grand_total, 0);
  });
});

await standalone(import.meta.url);
