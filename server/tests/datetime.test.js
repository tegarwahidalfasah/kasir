// ===========================================================================
//  Test zona waktu toko (docs/11 §4)
//  Aturan yang dikunci di sini: kolom waktu disimpan UTC, tetapi "hari bisnis"
//  (laporan, nomor struk, jam sibuk) selalu diturunkan dari
//  settings.store.timezone — bukan dari zona server/proses (yang di VPS = UTC).
// ===========================================================================
import { describe, it, assert, standalone } from './harness.js';
import { exec, firstRow, uid, saveSetting, loadSetting } from '../src/db/index.js';
import { tzOffsetMinutes, tzOffsetSql, businessDay, businessHour, addDays, storeTimezone, forgetTimezone } from '../src/lib/tz.js';
import { nextInvoiceNo } from '../src/sales.js';
import { DEFAULTS } from '../src/config.js';

const S = { id: uid('sto') };
exec(`INSERT INTO stores (id, name, timezone, currency, locale) VALUES (?, 'Toko TZ', 'Asia/Jakarta', 'IDR', 'id-ID')`, S.id);
saveSetting(S.id, 'store', { ...DEFAULTS.store, timezone: 'Asia/Jakarta' }, null);

// 01:30 WIB tanggal 27 Sep = 18:30 UTC tanggal 26 Sep
const PAGI_BUTA = new Date('2026-09-26T18:30:00Z');

describe('zona waktu toko', () => {
  it('offset & hari bisnis dihitung dari zona toko, bukan UTC', () => {
    assert.equal(tzOffsetMinutes('Asia/Jakarta', PAGI_BUTA), 420, 'WIB = UTC+7');
    assert.equal(tzOffsetSql('Asia/Jakarta', PAGI_BUTA), '+07:00');
    assert.equal(tzOffsetSql('Asia/Makassar', PAGI_BUTA), '+08:00', 'WITA = UTC+8');
    assert.equal(tzOffsetMinutes('America/New_York', PAGI_BUTA), -240, 'zona barat ikut benar');

    assert.equal(businessDay('Asia/Jakarta', PAGI_BUTA), '2026-09-27', 'pukul 01:30 WIB sudah hari berikutnya');
    assert.equal(businessDay('UTC', PAGI_BUTA), '2026-09-26');
    assert.equal(businessHour('Asia/Jakarta', PAGI_BUTA), 1, 'jam 1 pagi WIB, bukan 18 UTC');
    assert.equal(businessHour('America/New_York', PAGI_BUTA), 14);
  });

  it('zona waktu tidak dikenal tidak mematahkan laporan (fallback WIB)', () => {
    assert.equal(businessDay('Mars/Olympus', PAGI_BUTA), '2026-09-27');
    assert.equal(tzOffsetSql('Mars/Olympus', PAGI_BUTA), '+07:00');
    assert.equal(tzOffsetSql('../../etc/passwd', PAGI_BUTA), '+07:00', 'input aneh tidak masuk ke SQL');
  });

  it('addDays: aritmetika tanggal murni (tanpa pergeseran zona)', () => {
    assert.equal(addDays('2026-09-27', -29), '2026-08-29');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  });

  it('zona toko dibaca dari DB & cache-nya bisa dibuang', () => {
    assert.equal(storeTimezone(S.id), 'Asia/Jakarta');
    exec(`UPDATE stores SET timezone = 'Asia/Makassar' WHERE id = ?`, S.id);
    assert.equal(storeTimezone(S.id), 'Asia/Jakarta', 'masih dari cache');
    forgetTimezone(S.id);
    assert.equal(storeTimezone(S.id), 'Asia/Makassar', 'setelah dibuang -> nilai baru');
    assert.equal(storeTimezone('tidak-ada'), 'Asia/Jakarta', 'toko tak dikenal -> default');
    exec(`UPDATE stores SET timezone = 'Asia/Jakarta' WHERE id = ?`, S.id);
    forgetTimezone(S.id);
  });

  it('nomor struk memakai hari bisnis toko (bukan tanggal UTC)', () => {
    const no = nextInvoiceNo(S.id, 'KS', PAGI_BUTA);
    assert.match(no, /^KS20260927-\d+$/, `nomor struk harus bertanggal 27 Sep (WIB), dapat: ${no}`);

    // toko di zona +14 (Kiritimati): 18:30 UTC = 27 Sep 08:30 di sana (bukan 26 Sep seperti UTC)
    exec(`UPDATE stores SET timezone = 'Pacific/Kiritimati' WHERE id = ?`, S.id);
    forgetTimezone(S.id);
    const no2 = nextInvoiceNo(S.id, 'KS', PAGI_BUTA);
    assert.match(no2, /^KS20260927-\d+$/, `zona +14 -> 27 Sep, dapat: ${no2}`);
    assert.match(businessDay('UTC', PAGI_BUTA), /^2026-09-26$/, 'tanggal UTC-nya masih 26 Sep');

    // toko di zona -11: masih 26 Sep
    exec(`UPDATE stores SET timezone = 'Pacific/Midway' WHERE id = ?`, S.id);
    forgetTimezone(S.id);
    const no3 = nextInvoiceNo(S.id, 'KS', PAGI_BUTA);
    assert.match(no3, /^KS20260926-\d+$/, `zona -11 -> 26 Sep, dapat: ${no3}`);

    exec(`UPDATE stores SET timezone = 'Asia/Jakarta' WHERE id = ?`, S.id);
    forgetTimezone(S.id);
    assert.equal(firstRow(`SELECT timezone FROM stores WHERE id = ?`, S.id).timezone, 'Asia/Jakarta');
  });

  it('pengaturan toko menyimpan zona waktu yang dipakai runtime', () => {
    const saved = loadSetting(S.id, 'store', DEFAULTS.store);
    assert.equal(saved.timezone, 'Asia/Jakarta');
  });
});

await standalone(import.meta.url);
