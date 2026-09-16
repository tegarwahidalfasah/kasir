// ===========================================================================
//  State global: sesi (token + bootstrap), tema, routing hash, toast, confirm.
// ===========================================================================
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, get, getToken, setToken } from './api.js';

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

// --------------------------------------------------------------- routing hash
export function useHashRoute() {
  const [route, setRoute] = useState(() => (location.hash || '#/pos').slice(1));
  useEffect(() => {
    const on = () => setRoute(location.hash.slice(1) || '/pos');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const navigate = useCallback((to) => { location.hash = to; }, []);
  return [route, navigate];
}

// ------------------------------------------------------------------ provider
export function AppProvider({ children }) {
  const [session, setSession] = useState(null);     // { token, user }
  const [boot, setBoot] = useState(null);          // respons /bootstrap
  const [status, setStatus] = useState(getToken() ? 'loading' : 'anon');
  const [toasts, setToasts] = useState([]);
  const [confirmReq, setConfirmReq] = useState(null);
  const seq = useRef(0);

  const toast = useCallback((message, kind = 'info', ms = 4200) => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);

  const confirm = useCallback((opts) => new Promise((resolve) => setConfirmReq({ ...opts, resolve })), []);

  const loadBootstrap = useCallback(async () => {
    const data = await get('/bootstrap');
    setBoot(data);
    applyTheme(data.settings?.theme, data.settings?.store);
    return data;
  }, []);

  const login = useCallback(async (username, password) => {
    const out = await api('/auth/login', { method: 'POST', body: { username, password } });
    setToken(out.token);
    setSession(out);
    await loadBootstrap();
    setStatus('ready');
    return out;
  }, [loadBootstrap]);

  const logout = useCallback(() => {
    setToken('');
    setSession(null);
    setBoot(null);
    setStatus('anon');
    location.hash = '#/login';
  }, []);

  const refresh = useCallback(() => loadBootstrap().catch((e) => toast(e.message, 'error')), [loadBootstrap, toast]);

  useEffect(() => {
    const onUnauth = () => { setStatus('anon'); setSession(null); setBoot(null); };
    window.addEventListener('kasir:unauthorized', onUnauth);
    return () => window.removeEventListener('kasir:unauthorized', onUnauth);
  }, []);

  useEffect(() => {
    if (!getToken()) { setStatus('anon'); return; }
    loadBootstrap().then(() => setStatus('ready')).catch(() => { setToken(''); setStatus('anon'); });
  }, [loadBootstrap]);

  // refresh otomatis: stok real-time & penghitung peringatan
  useEffect(() => {
    if (status !== 'ready') return undefined;
    const id = setInterval(() => { loadBootstrap().catch(() => {}); }, 45000);
    return () => clearInterval(id);
  }, [status, loadBootstrap]);

  const value = useMemo(() => ({
    status, session, boot, setBoot, login, logout, refresh, toast, confirm,
    perms: boot?.permissions || [],
    can: (p) => hasPerm(boot?.permissions, p),
    settings: boot?.settings || {},
    store: boot?.store || {},
    theme: boot?.settings?.theme || {},
    catalog: boot?.catalog || [],
    bom: boot?.bom || {},
    categories: boot?.categories || [],
    paymentMethods: boot?.payment_methods || [],
    taxes: boot?.taxes || [],
    discountRules: boot?.discount_rules || [],
    alertsUnread: boot?.alerts_unread || 0,
  }), [status, session, boot, login, logout, refresh, toast, confirm]);

  return (
    <AppCtx.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} />
      <ConfirmDialog req={confirmReq} onClose={() => setConfirmReq(null)} />
    </AppCtx.Provider>
  );
}

export function hasPerm(perms, need) {
  const list = perms || [];
  if (list.includes('*')) return true;
  if (!need) return true;
  return (Array.isArray(need) ? need : [need]).some((p) => list.includes(p));
}

// ------------------------------------------------------------------ tema CSS
export const FONT_STACKS = {
  system: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`,
  mono: `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
  serif: `Georgia, "Times New Roman", serif`,
  rounded: `"Nunito", "Quicksand", -apple-system, "Segoe UI", sans-serif`,
};

export function applyTheme(theme = {}, store = {}) {
  const root = document.documentElement;
  const t = { ...theme };
  const dark = t.mode === 'dark' || (t.mode === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const vars = {
    '--accent': t.accent || '#f97316',
    '--accent-text': t.accent_text || '#fff',
    '--success': t.success || '#16a34a',
    '--danger': t.danger || '#dc2626',
    '--warning': t.warning || '#d97706',
    '--surface': t.surface || (dark ? '#1e2937' : '#ffffff'),
    '--canvas': t.canvas || (dark ? '#0f172a' : '#f6f7f9'),
    '--text': t.text || (dark ? '#e5e7eb' : '#111827'),
    '--muted': t.muted || (dark ? '#94a3b8' : '#6b7280'),
    '--border': t.border || (dark ? '#2a3646' : '#e5e7eb'),
    '--radius': `${t.radius ?? 12}px`,
    '--sidebar-w': `${t.sidebar_width || 236}px`,
    '--font': FONT_STACKS[t.font] || FONT_STACKS.system,
    '--pad': t.density === 'compact' ? '6px' : '12px',
    '--row-h': t.density === 'compact' ? '32px' : '42px',
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.mode = dark ? 'dark' : 'light';
  root.dataset.density = t.density || 'comfortable';
  root.dataset.pattern = t.bg_pattern || 'none';
  document.title = `${t.app_name || store.name || 'Kasir'} — Kasir & Stok`;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', vars['--accent']);
}

/** Pratinjau tema seketika (dipakai editor tema) tanpa menyimpan. */
export const previewTheme = applyTheme;

// ------------------------------------------------------------------- toasts
function ToastStack({ toasts }) {
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>{t.message}</div>
      ))}
    </div>
  );
}

function ConfirmDialog({ req, onClose }) {
  if (!req) return null;
  const close = (val) => { req.resolve(val); onClose(); };
  return (
    <div className="modal-backdrop" onMouseDown={() => close(false)}>
      <div className="modal confirm" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{req.title || 'Konfirmasi'}</h3>
        <p>{req.message}</p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => close(false)}>{req.cancelText || 'Batal'}</button>
          <button className={`btn ${req.danger ? 'danger' : 'primary'}`} onClick={() => close(true)}>{req.okText || 'Ya, lanjutkan'}</button>
        </div>
      </div>
    </div>
  );
}
