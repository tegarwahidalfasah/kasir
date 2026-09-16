// Kerangka tes super-ringkas: tanpa dependency, output mirip node:test.
// Dipakai oleh server/scripts/test.js (menjalankan semua *.test.js dalam satu proses).
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let passed = 0;
let failed = 0;
const failures = [];
let group = '';
const pending = [];
let chain = Promise.resolve();   // tes dijalankan berurutan (state antar-tes bergantung)

export function describe(name, fn) {
  group = name;
  fn();
  group = '';
}

/** Tunggu seluruh `it()` async selesai — dipanggil runner sebelum laporan. */
export async function flush() {
  while (pending.length) {
    const batch = pending.splice(0, pending.length);
    await Promise.all(batch);
  }
}

export function it(name, fn) {
  const p = chain.then(() => runOne(name, fn));
  chain = p.catch(() => {});          // satu tes gagal tidak menghentikan sisanya
  pending.push(p);
  return p;
}

async function runOne(name, fn) {
  const label = (group ? group + ' › ' : '') + name;
  const t0 = Date.now();
  try {
    await fn();
    const ms = Date.now() - t0;
    if (process.env.KASIR_TEST_TIMING && ms > 1500) process.stdout.write(`      ⏱ ${ms}ms\n`);
    passed += 1;
    process.stdout.write(`  ✓ ${label}\n`);
  } catch (err) {
    failed += 1;
    failures.push({ label, err });
    const msg = String(err.message).split('\n').slice(0, 6).join('\n      ');
    process.stdout.write(`  ✗ ${label}\n      ${msg}\n`);
  }
}

export async function report() {
  process.stdout.write(`\n${passed} passing, ${failed} failing\n`);
  if (failures.length) {
    process.stdout.write('\n--- detail kegagalan ---\n');
    for (const f of failures) {
      process.stdout.write(`\n✗ ${f.label}\n${(f.err.stack || f.err.message).split('\n').slice(0, 6).join('\n')}\n`);
    }
  }
  return failed;
}

export { assert };

/**
 * Panggil di akhir file tes: `await standalone(import.meta.url)`.
 * Hanya file yang benar-benar jadi entry point yang menunggu & keluar,
 * supaya file tes lain yang mengimpor harness tidak ikut exit.
 */
/**
 * Panggil di akhir file tes: `await standalone(import.meta.url)`.
 * Hanya file yang benar-benar jadi entry point yang menunggu lalu keluar,
 * supaya file tes lain yang mengimpor harness tidak ikut keluar.
 */
export async function standalone(metaUrl) {
  const entry = pathToFileURL(process.argv[1] || '').href;
  if (metaUrl !== entry) return;
  await flush();
  const code = await report();
  // paksa keluar: proses anak (server tes) & handle DB tidak boleh menggantung
  process.exit(code || 0);
}
