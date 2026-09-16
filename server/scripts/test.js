// ===========================================================================
//  Runner tes (Fase 4 QA) — tanpa dependency. Setiap server/tests/*.test.js
//  dijalankan di PROSES TERSENDIRI (isolasi DB & port), urut berdasarkan nama.
//  Pemakaian: npm test   |   npm test -- pricing   (filter nama file)
// ===========================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(__dirname, '..', 'tests');
const filter = process.argv[2];

const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js'))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (!files.length) {
  console.error('Tidak ada file tes yang cocok.');
  process.exit(1);
}

// --- pemeriksaan otomatis: jumlah kolom INSERT == jumlah placeholder ---
function checkSqlPlaceholders(files) {
  const bad = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else if (fp.endsWith('.js')) {
        const src = fs.readFileSync(fp, 'utf8');
        for (const m of src.matchAll(/INSERT INTO (\w+) \(([\s\S]*?)\)\s*\n?\s*VALUES \(([\s\S]*?)\)`/g)) {
          const cols = m[2].split(',').filter((x) => x.trim()).length;
          const parts = m[3].split(',').map((x) => x.trim()).filter(Boolean);
          const marks = parts.filter((x) => x === '?').length;
          const lits = parts.length - marks;
          if (marks + lits !== cols) {
            bad.push(`${path.relative(process.cwd(), fp)}: ${m[1]} -> ${cols} kolom vs ${parts.length} nilai (${marks} ? + ${lits} literal)`);
          }
        }
      }
    }
  };
  void files;
  walk(path.join(__dirname, '..', 'src'));
  walk(TEST_DIR);
  return bad;
}
const sqlIssues = checkSqlPlaceholders(files);
if (sqlIssues.length) {
  console.error('❌ SQL tidak seimbang (kolom vs nilai):');
  for (const s of sqlIssues) console.error('   ' + s);
  process.exit(1);
}

// --- isolasi: tiap file tes dijalankan di proses anak sendiri -------------
import { spawn } from 'node:child_process';

// DB sementara per proses tes: setiap file dapat menulis baris uji tanpa saling mengotori,
// dan pangkalan data pengembangan tidak pernah tersentuh. Set TEST_KEEP=1 untuk menyimpannya.
const keep = process.env.TEST_KEEP === '1';
const makeDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-test-'));
const dirs = [];
const cleanup = () => { if (keep) return; for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } } };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const runFile = (f) => new Promise((resolve) => {
  const dataDir = makeDir();
  dirs.push(dataDir);
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(TEST_DIR, f), '--standalone'], {
    cwd: ROOT, env: { ...process.env, KASIR_DATA_DIR: dataDir, NODE_NO_WARNINGS: '1' }, stdio: 'inherit',
  });
  proc.on('exit', (code) => { if (!keep) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { } } resolve(code || 0); });
});

const t0 = Date.now();
let failed = 0;
for (const f of files) {
  process.stdout.write(`\n▶ ${f}\n`);
  failed += await runFile(f);
}
console.log(`\n${failed === 0 ? '✅' : '❌'} ${files.length} file tes selesai dalam ${((Date.now() - t0) / 1000).toFixed(2)}s`);
process.exit(failed ? 1 : 0);
