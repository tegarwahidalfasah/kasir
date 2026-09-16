// ===========================================================================
//  Kasir API Server — Express 5 + node:sqlite
//  Menjalankan API (/api/*) dan (bila sudah di-build) SPA client dari satu port.
// ===========================================================================
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './routes/index.js';
import { DB_FILE, firstRow } from './db/index.js';
import { AppError } from './lib/http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.join(__dirname, '..', '..', 'client', 'dist');
const PORT = Number(process.env.PORT || 4000);
const started = Date.now();

export function createApp() {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    // struk & logo disimpan sebagai data-URL -> perlu img-src data:
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; base-uri 'self'; frame-ancestors *");
    next();
  });

  app.use(express.json({ limit: '12mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  const healthHandler = (_req, res) => {
    let counts = { items: 0, sales: 0, movements: 0 };
    try {
      counts = firstRow(`SELECT (SELECT COUNT(*) FROM items) AS items, (SELECT COUNT(*) FROM transactions) AS sales, (SELECT COUNT(*) FROM stock_movements) AS movements`) || counts;
    } catch { /* DB might be initializing */ }
    res.json({
      ok: true, service: 'kasir-api', version: '0.1.0',
      uptime_s: Math.round((Date.now() - started) / 1000),
      node: process.version, db_file: path.relative(path.join(__dirname, '..', '..'), DB_FILE), ...counts,
    });
  };

  app.get('/api/health', healthHandler);
  app.get('/health', healthHandler);

  const openApiHandler = (_req, res) => res.json(buildOpenApi());
  app.get('/api/openapi.json', openApiHandler);
  app.get('/openapi.json', openApiHandler);

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan' }));

  if (fs.existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST, { index: false }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
  } else {
    app.get('/', (_req, res) => res
      .status(200)
      .type('html')
      .send(`<h1>Kasir API aktif</h1><p>Frontend belum di-build. Jalankan <code>npm run build</code> atau <code>npm run dev</code>.</p>`));
  }

  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[error]', req.method, req.originalUrl, err);
    // di produksi pesan 5xx tidak dikirim ke klien (hanya ke log) agar tidak membocorskan detail internal
    const hide = status >= 500 && process.env.NODE_ENV === 'production';
    res.status(status).json({
      error: hide ? 'Terjadi kesalahan pada server' : (err.message || 'Terjadi kesalahan'),
      details: hide ? null : (err.details ?? null),
    });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createApp().listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Kasir API   → http://0.0.0.0:${PORT}/api/health`);
    console.log(`   DB         → ${DB_FILE}`);
    console.log(fs.existsSync(CLIENT_DIST) ? `   Web        → http://0.0.0.0:${PORT}/ (build client)` : `   Web        → belum di-build (npm run build)`);
  });
}

// -------------------------------------------------------------- OpenAPI ringkas
function buildOpenApi() {
  const routes = [];
  const walk = (stack, base = '') => {
    for (const layer of stack || []) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) routes.push({ method: m.toUpperCase(), path: base + layer.route.path });
      } else if (layer.name === 'router' && layer.handle?.stack) {
        const p = layer.regexp?.source
          ? layer.regexp.source.replace('^\\/', '/').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/').replace(/\(\?:\[\^\/\]\+\?\)/g, '')
          : '';
        walk(layer.handle.stack, base + (p === '/' ? '' : p));
      }
    }
  };
  walk(api.stack);
  return {
    openapi: '3.0.3',
    info: { title: 'Kasir API', version: '0.1.0', description: 'POS + stok bahan baku (BOM), RBAC, kustomisasi toko' },
    paths: routes.reduce((acc, r) => {
      acc['/api' + r.path] ||= {};
      acc['/api' + r.path][r.method.toLowerCase()] = { tags: ['kasir'], responses: { 200: { description: 'OK' } } };
      return acc;
    }, {}),
  };
}
