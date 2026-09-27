// Jembatan ke SDK async. Domain POS saat ini sinkron: transaksi tidak boleh
// diselingi request lain atau berpindah koneksi di antara BEGIN dan COMMIT.
import { workerData } from 'node:worker_threads';
import { createClient } from '@libsql/client/http';

const { port, signal, config } = workerData;
const state = new Int32Array(signal);
const client = createClient({ ...config, intMode: 'number' });
let transaction = null;

port.on('message', async ({ operation, sql, args }) => {
  let response;
  try {
    if (operation === 'begin') {
      if (transaction) throw new Error('Transaksi bersarang tidak didukung.');
      transaction = await client.transaction('write'); // BEGIN IMMEDIATE, satu stream/baton
      response = { value: null };
    } else if (operation === 'commit' || operation === 'rollback') {
      if (!transaction) throw new Error('Tidak ada transaksi aktif.');
      const current = transaction;
      try {
        if (operation === 'commit') await current.commit();
        else await current.rollback();
      } finally {
        current.close();
        transaction = null;
      }
      response = { value: null };
    } else if (operation === 'execute') {
      const result = await (transaction || client).execute({ sql, args });
      // Row SDK memiliki accessor/index numerik; kirim objek kolom biasa.
      const rows = result.rows.map(row => Object.fromEntries(result.columns.map(key => [key, row[key]])));
      response = { value: { rows, changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid } };
    } else {
      throw new Error('Operasi database tidak didukung.');
    }
  } catch (err) {
    // Tidak mengirim URL, auth token, atau parameter SQL ke log/API.
    response = { error: { message: err.message, code: err.code } };
  }
  port.postMessage(response);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
});
