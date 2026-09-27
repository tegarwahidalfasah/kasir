// Test-only Hrana v2 HTTPS endpoint. Real SDK + worker + SQL, no Turso account.
// This fixture is not a production libSQL server and is excluded from Vercel.
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const streams = new Map();
const decode = value => value.type === 'null' ? null : value.type === 'integer' ? Number(value.value) : value.type === 'blob' ? Buffer.from(value.base64, 'base64') : value.value;
const encode = value => value == null ? { type: 'null' } : typeof value === 'string' ? { type: 'text', value } : typeof value === 'number' ? { type: Number.isInteger(value) ? 'integer' : 'float', value: Number.isInteger(value) ? String(value) : value } : { type: 'blob', base64: Buffer.from(value).toString('base64') };
const failure = err => ({ message: err.message, code: /constraint/i.test(err.message) ? 'SQLITE_CONSTRAINT' : 'SQLITE_ERROR' });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function execute(stream, input) {
  const sql = input.sql ?? stream.sql.get(input.sql_id);
  const params = (input.args || []).map(decode);
  for (let attempt = 0; ; attempt++) {
    try {
      const stmt = stream.db.prepare(sql);
      const columns = stmt.columns();
      let rows = [], info = {};
      if (columns.length) rows = stmt.all(...params);
      else info = stmt.run(...params);
      return {
        cols: columns.map(c => ({ name: c.name, decltype: c.type })),
        rows: rows.map(row => columns.map(c => encode(row[c.name]))),
        affected_row_count: Number(info.changes || 0), last_insert_rowid: String(info.lastInsertRowid || 0),
      };
    } catch (err) {
      if (/locked/.test(err.message) && attempt < 300) { await wait(10); continue; }
      throw err;
    }
  }
}

function condition(c, results, errors) {
  if (!c) return true;
  if (c.type === 'ok') return !!results[c.step];
  if (c.type === 'error') return !!errors[c.step];
  if (c.type === 'not') return !condition(c.cond, results, errors);
  if (c.type === 'and') return c.conds.every(x => condition(x, results, errors));
  if (c.type === 'or') return c.conds.some(x => condition(x, results, errors));
  throw new Error('Unsupported batch condition');
}

async function handle(stream, request) {
  const type = request.type;
  if (type === 'execute') return { type, result: await execute(stream, request.stmt) };
  if (type === 'batch') {
    const step_results = [], step_errors = [];
    for (const step of request.batch.steps) {
      let result = null, error = null;
      if (condition(step.condition, step_results, step_errors)) {
        try { result = await execute(stream, step.stmt); } catch (err) { error = failure(err); }
      }
      step_results.push(result); step_errors.push(error);
    }
    return { type, result: { step_results, step_errors } };
  }
  if (type === 'sequence') stream.db.exec(request.sql ?? stream.sql.get(request.sql_id));
  else if (type === 'store_sql') stream.sql.set(request.sql_id, request.sql);
  else if (type === 'close_sql') stream.sql.delete(request.sql_id);
  else if (type === 'close') { stream.db.close(); stream.closed = true; }
  else throw new Error('Unsupported request ' + type);
  return { type };
}

const server = https.createServer({ key: fs.readFileSync(process.env.TEST_KEY), cert: fs.readFileSync(process.env.TEST_CERT) }, async (req, res) => {
  if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401).end('Unauthorized'); return; }
  if (req.url !== '/v2/pipeline') { res.writeHead(404).end(); return; }
  try {
    let text = '';
    for await (const chunk of req) text += chunk;
    const input = JSON.parse(text);
    const baton = input.baton || crypto.randomUUID();
    let stream = streams.get(baton);
    if (!stream) {
      if (input.baton) throw new Error('Invalid stream baton');
      const db = new DatabaseSync(process.env.TEST_DB);
      db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;');
      stream = { db, sql: new Map() };
      streams.set(baton, stream);
    }
    const results = [];
    for (const request of input.requests) {
      try { results.push({ type: 'ok', response: await handle(stream, request) }); }
      catch (err) { results.push({ type: 'error', error: failure(err) }); }
    }
    if (stream.closed) streams.delete(baton);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ baton: stream.closed ? null : baton, base_url: null, results }));
  } catch (err) {
    res.writeHead(500).end(err.message);
  }
});
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
process.on('disconnect', () => process.exit(0));
