// Provisioning eksplisit, TIDAK diimpor API dan TIDAK dijalankan saat cold start.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { SCHEMA_VERSION } from './remote-config.js';
import { DEFAULTS } from '../config.js';
import { hashPassword } from '../passwords.js';

const id = prefix => prefix + crypto.randomUUID().replaceAll('-', '').slice(0, 20);
const insert = (table, values) => ({
  sql: `INSERT INTO ${table} (${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`,
  args: Object.values(values),
});

function initialData({ demo, ownerUsername, ownerPassword, storeName }) {
  if (!demo && (!ownerUsername?.trim() || !ownerPassword || ownerPassword.length < 12)) {
    throw new Error('Mode --owner memerlukan KASIR_OWNER_USERNAME dan KASIR_OWNER_PASSWORD minimal 12 karakter.');
  }
  const store = id('sto');
  const branch = id('brn');
  const name = demo ? 'Kopi Senja — Demo Online' : (storeName || 'Toko Saya');
  const statements = [
    insert('stores', { id: store, name }),
    insert('branches', { id: branch, store_id: store, name: 'Cabang Utama', is_default: 1 }),
  ];
  const accounts = demo
    ? [{ username: 'budi', display_name: 'Budi (Pemilik)', role: 'owner', password: 'rahasia123', pin: '1111' },
       { username: 'dewi', display_name: 'Dewi (Kasir)', role: 'cashier', password: 'rahasia123', pin: '4444' }]
    : [{ username: ownerUsername.trim(), display_name: ownerUsername.trim(), role: 'owner', password: ownerPassword }];
  for (const account of accounts) statements.push(insert('users', {
    id: id('usr'), store_id: store, branch_id: branch, username: account.username,
    display_name: account.display_name, role: account.role,
    password_hash: hashPassword(account.password), pin: account.pin ? hashPassword(account.pin) : null,
  }));
  for (const [key, value] of Object.entries(DEFAULTS)) {
    statements.push(insert('settings', {
      store_id: store, key, value_json: JSON.stringify(key === 'store' ? { ...value, name } : value),
    }));
  }
  statements.push(insert('payment_methods', { id: id('pay'), store_id: store, name: 'Tunai', kind: 'cash', is_default: 1 }));
  if (demo) {
    const category = id('cat');
    const coffee = id('itm');
    const cup = id('itm');
    const drink = id('itm');
    statements.push(insert('categories', { id: category, store_id: store, name: 'Minuman' }));
    for (const [itemId, label, unit, qty, cost] of [[coffee, 'Biji kopi', 'g', 1000, 200], [cup, 'Gelas', 'pcs', 100, 500]]) {
      statements.push(insert('items', { id: itemId, store_id: store, name: label, item_type: 'raw', unit, stock_qty: qty, cost_price: cost }));
      statements.push(insert('stock_movements', {
        id: id('mov'), store_id: store, branch_id: branch, item_id: itemId,
        movement_type: 'adjustment', qty, unit_cost: cost, balance_after: qty,
        ref_type: 'manual', reason: 'Stok awal demo online',
      }));
    }
    statements.push(insert('items', {
      id: drink, store_id: store, category_id: category, name: 'Americano', item_type: 'finished',
      unit: 'cup', selling_price: 15000, cost_price: 4100, production_mode: 'make_to_order',
    }));
    for (const [raw, qty, unit] of [[coffee, 18, 'g'], [cup, 1, 'pcs']]) {
      statements.push(insert('item_recipes', { id: id('bom'), parent_id: drink, raw_item_id: raw, qty, unit }));
    }
  }
  return statements;
}

/** Skema + migrasi + akun awal atomik, dengan write lock sebelum cek kosong.
 * Dua operator menjalankan setup sekaligus tidak membuat toko/akun ganda.
 * Tidak ada --force, DROP, atau overwrite password akun yang sudah ada.
 */
export async function provision(client, options = {}) {
  if (options.demo && options.owner) throw new Error('Pilih --demo ATAU --owner, bukan keduanya.');
  const seed = options.demo || options.owner ? initialData(options) : null;
  const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
    .replace(/^PRAGMA[^\n]*;\s*$/gm, ''); // WAL/file pragma bukan milik DB remote
  const transaction = await client.transaction('write');
  try {
    await transaction.executeMultiple(schema);
    // Upgrade DB lama, bukan hanya CREATE TABLE IF NOT EXISTS.
    for (const [table, columns] of [
      ['transaction_items', [['refunded_qty', 'REAL NOT NULL DEFAULT 0'], ['bom_json', 'TEXT']]],
      ['transactions', [['refund_total', 'REAL NOT NULL DEFAULT 0'], ['refund_cost', 'REAL NOT NULL DEFAULT 0']]],
    ]) {
      const info = await transaction.execute(`PRAGMA table_info(${table})`);
      for (const [column, ddl] of columns) {
        if (!info.rows.some(row => row.name === column)) await transaction.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      }
    }
    await transaction.execute('CREATE TABLE IF NOT EXISTS kasir_schema (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)');
    const version = (await transaction.execute('SELECT version FROM kasir_schema WHERE id = 1')).rows[0]?.version;
    if (version && version > SCHEMA_VERSION) throw new Error('Versi DB lebih baru dari aplikasi ini; setup dibatalkan.');
    let initialized = false;
    if (seed) {
      const counts = (await transaction.execute('SELECT (SELECT COUNT(*) FROM stores) AS stores, (SELECT COUNT(*) FROM users) AS users')).rows[0];
      if (Number(counts.stores) === 0 && Number(counts.users) === 0) {
        await transaction.batch(seed);
        initialized = true;
      }
    }
    await transaction.execute({
      sql: 'INSERT INTO kasir_schema (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version',
      args: [SCHEMA_VERSION],
    });
    await transaction.commit();
    return { initialized, version: SCHEMA_VERSION };
  } catch (err) {
    try { await transaction.rollback(); } catch { /* transaksi mungkin sudah ditutup SDK */ }
    throw err;
  } finally {
    transaction.close();
  }
}
