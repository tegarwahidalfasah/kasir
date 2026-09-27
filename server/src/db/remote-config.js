// Tidak pernah fallback diam-diam ke /tmp jika konfigurasi database online salah.
export function remoteConfig(env = process.env) {
  const url = env.TURSO_DATABASE_URL?.trim();
  const authToken = env.TURSO_AUTH_TOKEN?.trim();
  if (!url && !authToken) {
    if (env.VERCEL) throw new Error('Vercel memerlukan TURSO_DATABASE_URL dan TURSO_AUTH_TOKEN. SQLite /tmp tidak mendukung sesi lintas-instance.');
    return null;
  }
  if (!url || !authToken) throw new Error('Isi TURSO_DATABASE_URL dan TURSO_AUTH_TOKEN bersama-sama.');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('TURSO_DATABASE_URL tidak valid.'); }
  if (!['libsql:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('TURSO_DATABASE_URL harus berupa libsql://host atau https://host tanpa kredensial/query.');
  }
  return { url, authToken };
}

export const SCHEMA_VERSION = 1;
