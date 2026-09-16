// Hapus seluruh data (file DB + WAL/SHM). Setelah itu jalankan `npm run seed`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.KASIR_DATA_DIR || path.join(__dirname, '..', 'src', 'data');
let removed = 0;
for (const f of ['kasir.db', 'kasir.db-wal', 'kasir.db-shm', 'kasir.db.backup.sqlite']) {
  const p = path.join(DATA_DIR, f);
  if (fs.existsSync(p)) { fs.rmSync(p); removed += 1; }
}
for (const f of fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : []) {
  if (f.endsWith('.sqlite')) { fs.rmSync(path.join(DATA_DIR, f)); removed += 1; }
}
console.log(`🧹 ${removed} file basis data dihapus dari ${DATA_DIR}`);
