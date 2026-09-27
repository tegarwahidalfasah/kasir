import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';

/**
 * Adapter sinkron sementara untuk domain POS yang sudah memakai node:sqlite.
 * HTTP dijalankan worker terpisah agar loop I/O SDK tetap bergerak. Thread API
 * menunggu hasil: tidak ada request yang menyela tx() sinkron dalam satu proses.
 * Bukan embedded replica / salinan lokal: setiap query menuju DB bersama.
 *
 * Trade-off: satu round-trip per query dan satu request aktif per proses. Untuk
 * beban besar, refactor domain ke async + query batching sebelum scale-up.
 * Timeout TIDAK di-retry (COMMIT bisa sudah diterima remote); worker dibuang agar
 * request berikut tidak memakai stream/transaksi yang statusnya tidak diketahui.
 */
export class LibsqlSync {
  constructor(config, { timeoutMs = 10000, workerUrl = new URL(process.env.VERCEL ? './libsql-worker.bundle.cjs' : './libsql-worker.js', import.meta.url) } = {}) {
    this.config = config;
    this.timeoutMs = timeoutMs;
    this.workerUrl = workerUrl;
    this.worker = null;
    this.closed = false;
    this.inTransaction = false;
  }

  start() {
    if (this.closed) throw new Error('Database sudah ditutup.');
    if (this.worker) return;
    const { port1, port2 } = new MessageChannel();
    this.state = new Int32Array(new SharedArrayBuffer(4));
    this.port = port1;
    this.worker = new Worker(this.workerUrl, {
      workerData: { port: port2, signal: this.state.buffer, config: this.config },
      transferList: [port2], execArgv: [],
    });
    // Error startup tidak bisa diproses main thread saat Atomics.wait; timeout
    // membatasi tunggu. Listener mencegah unhandled error sesudah tunggu selesai.
    this.worker.on('error', () => {});
    this.worker.unref();
    this.port.unref();
  }

  discard() {
    this.port?.close();
    this.worker?.terminate();
    this.worker = null;
    this.inTransaction = false;
  }

  call(operation, sql, args = []) {
    this.start();
    Atomics.store(this.state, 0, 0);
    this.port.postMessage({ operation, sql, args });
    const deadline = Date.now() + this.timeoutMs;
    let message;
    while (Date.now() < deadline) {
      Atomics.wait(this.state, 0, 0, Math.max(1, deadline - Date.now()));
      message = receiveMessageOnPort(this.port)?.message;
      if (message) break;
      // Wakeup spurious atau hasil MessagePort belum terlihat.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
    if (!message) {
      this.discard();
      const error = new Error('Database online timeout. Status operasi belum pasti; periksa riwayat sebelum mengulang transaksi.');
      error.code = 'REMOTE_TIMEOUT';
      throw error;
    }
    if (message.error) {
      const error = new Error(message.error.message);
      error.code = message.error.code;
      throw error;
    }
    return message.value;
  }

  prepare(sql) {
    return {
      all: (...args) => this.call('execute', sql, args).rows,
      get: (...args) => this.call('execute', sql, args).rows[0],
      run: (...args) => {
        const { changes, lastInsertRowid } = this.call('execute', sql, args);
        return { changes, lastInsertRowid };
      },
    };
  }

  exec(sql) {
    const statement = sql.trim().replace(/;$/, '').toUpperCase();
    if (statement === 'BEGIN IMMEDIATE') {
      if (this.inTransaction) throw new Error('Transaksi bersarang tidak didukung.');
      this.call('begin');
      this.inTransaction = true;
    } else if (statement === 'COMMIT' || statement === 'ROLLBACK') {
      if (!this.inTransaction) throw new Error('Tidak ada transaksi aktif.');
      try { this.call(statement.toLowerCase()); } finally { this.inTransaction = false; }
    } else {
      throw new Error('db.exec untuk DB online hanya mendukung transaksi. Gunakan npm run db:setup untuk skema dan backup dari penyedia Turso.');
    }
  }

  close() {
    if (this.inTransaction) {
      try { this.exec('ROLLBACK'); } catch { /* stream ditutup di bawah */ }
    }
    this.discard();
    this.closed = true;
  }
}
