// ============================================================================
//  Event bus in-process untuk Server-Sent Events (docs/11 §15).
//
//  Tujuan: mengganti poling berat (`/bootstrap` penuh + `/pos/catalog` tiap
//  45–60 detik per tab) dengan satu koneksi yang menerima notifikasi saat stok
//  benar-benar berubah.
//
//  Dua hal yang dijaga di sini:
//  1. **Hanya setelah commit.** `postMovement()` dipanggil di dalam `tx()`;
//     kalau kita langsung mengirim event lalu transaksinya di-ROLLBACK
//     (mis. stok kurang), klien akan menampilkan angka yang tidak pernah ada.
//     `db.tx()` karena itu memanggil beginBatch/commitBatch/abortBatch.
//  2. **Tidak ada kebocoran memori.** Pelanggan diindeks per toko dan
//     dibersihkan saat koneksi ditutup (atau saat heartbeat gagal).
// ============================================================================

/** @type {Map<string, Set<{write: Function, end: Function}>>} */
const clients = new Map();

let batching = false;
let pending = [];

export function subscriberCount(storeId = null) {
  if (storeId) return clients.get(storeId)?.size || 0;
  let n = 0;
  for (const set of clients.values()) n += set.size;
  return n;
}

/** Kirim satu event ke semua pelanggan toko tersebut. Aman bila tidak ada pelanggan. */
function dispatch(storeId, event) {
  const set = clients.get(storeId);
  if (!set || !set.size) return;
  for (const writer of [...set]) {
    try {
      writer(event);                // `subscribe()` menerima FUNGSI penulis, bukan objek respons
    } catch {
      set.delete(writer);           // koneksi mati -> buang, jangan menahan memori
    }
  }
}

/** Publikasikan event ke klien toko. Di dalam `tx()` ia ditahan sampai commit. */
export function publish(storeId, payload) {
  if (!storeId) return;
  const event = { ...payload, at: new Date().toISOString() };
  if (batching) {
    pending.push([storeId, event]);
    return;
  }
  dispatch(storeId, event);
}

// ------------------------------------------------------------------ batching
export function beginBatch() {
  batching = true;
  pending = [];
}

export function commitBatch() {
  batching = false;
  const out = pending;
  pending = [];
  for (const [storeId, event] of out) dispatch(storeId, event);
}

export function abortBatch() {
  batching = false;
  pending = [];
}

// ----------------------------------------------------------------- subscribe
/**
 * Daftarkan satu koneksi SSE. `writer` menerima objek event dan mengurus
 * serialisasinya (`data: {...}\n\n`). Mengembalikan fungsi pembatalan.
 */
export function subscribe(storeId, writer) {
  const set = clients.get(storeId) || new Set();
  set.add(writer);
  clients.set(storeId, set);
  return () => {
    set.delete(writer);
    if (!set.size) clients.delete(storeId);
  };
}

/** Bentuk satu frame SSE dari objek event. */
export function sseFrame(event, name = 'message') {
  return `event: ${name}\ndata: ${JSON.stringify(event)}\n\n`;
}
