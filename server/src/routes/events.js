// ============================================================================
//  Server-Sent Events: GET /api/events (docs/11 §15)
//
//  Satu koneksi per tab (bukan poling 45 detik). Yang dikirim:
//   - `hello`  : versi katalog saat koneksi dibuka
//   - `stock`  : satu gerakan stok yang SUDAH ter-commit (item, qty, balance)
//   - `ping`   : komentar keep-alive tiap 25 detik (melewati proxy/idle timeout)
//
//  Autentikasi memakai header `Authorization: Bearer …` seperti rute lain.
//  `EventSource` bawaan peramban tidak bisa mengirim header — klien karena itu
//  memakai `fetch()` + pembacaan stream (lihat client/src/store.jsx), sehingga
//  token TIDAK pernah muncul di URL/query string (bisa bocor lewat log proxy).
// ============================================================================
import express from 'express';
import { STOCK_TRANSPORT } from '../db/index.js';
import { subscribe, sseFrame } from '../events.js';
import { catalogVersion } from '../catalog.js';

export const router = express.Router();
const MOUNT = ''; // path sudah memuat prefiks; mount di index.js memakai '/api'

const HEARTBEAT_MS = 25000;

router.get(MOUNT + '/events', (req, res) => {
  if (STOCK_TRANSPORT !== 'sse') return res.status(204).end();
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');   // nginx/Caddy: jangan menahan buffer
  res.flushHeaders?.();

  const write = (event) => res.write(sseFrame(event));
  res.write('retry: 5000\n\n');
  write({ type: 'hello', catalog_version: catalogVersion(req.storeId), store_id: req.storeId });

  const unsubscribe = subscribe(req.storeId, write);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ditutup di bawah */ }
  }, HEARTBEAT_MS);

  const done = () => {
    clearInterval(heartbeat);
    unsubscribe();
    try { res.end(); } catch { /* noop */ }
  };
  req.on('close', done);
  res.on('close', done);
  res.on('error', done);
});
