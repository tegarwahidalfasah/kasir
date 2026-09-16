// ===========================================================================
//  Lapisan API client: token, auto-logout, error toast.
// ===========================================================================
const TOKEN_KEY = 'kasir.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function api(path, { method = 'GET', body, signal, raw = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Tidak dapat menghubungi server. Periksa koneksi.');
  }

  if (raw) return res;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401) {
      setToken('');
      window.dispatchEvent(new CustomEvent('kasir:unauthorized'));
    }
    throw new ApiError(res.status, (data && data.error) || `Gagal (${res.status})`, data && data.details);
  }
  return data;
}

export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = (p, body) => api(p, { method: 'DELETE', body });

/** Unduh CSV laporan tanpa berpindah halaman. */
export async function downloadCsv(path, filename) {
  const res = await api(path, { raw: true });
  if (!res.ok) throw new ApiError(res.status, 'Ekspor gagal');
  const blob = await res.blob();
  const url = URL.createObjectURL ? URL.createObjectURL(blob) : URL.createObjectURL?.(blob);
  if (!url) { window.open(path, '_blank'); return; }
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL?.(url), 4000);
}

export const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(fr.result);
  fr.onerror = () => reject(new Error('Gagal membaca berkas'));
  fr.readAsDataURL(file);
});
