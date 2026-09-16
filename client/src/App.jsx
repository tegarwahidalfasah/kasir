// ===========================================================================
//  Shell aplikasi: sidebar modular (dari settings.theme.menu, difilter per
//  permission), topbar, dan router hash. Menambah/mengubah menu tidak perlu
//  menyentuh kode — cukup lewat Panel Tema di Pengaturan.
// ===========================================================================
import React, { Suspense, lazy, useEffect, useState } from 'react';
import { AppProvider, hasPerm, useApp, useHashRoute } from './store.jsx';
import { get } from './api.js';
import { Badge, Button, IconButton, Loading } from './ui.jsx';
import { roleLabel } from './lib/roles.js';

const ROUTES = {
  '/pos': [lazy(() => import('./features/pos/PosPage.jsx')), 'sale.create'],
  '/dashboard': [lazy(() => import('./features/report/Dashboard.jsx')), 'report.view'],
  '/stock': [lazy(() => import('./features/inventory/StockPage.jsx')), 'stock.view'],
  '/items': [lazy(() => import('./features/inventory/ItemsPage.jsx')), 'item.view'],
  '/purchase': [lazy(() => import('./features/inventory/PurchasePage.jsx')), 'stock.purchase'],
  '/reports': [lazy(() => import('./features/report/ReportsPage.jsx')), 'report.view'],
  '/sales': [lazy(() => import('./features/pos/SalesHistory.jsx')), 'sale.create'],
  '/alerts': [lazy(() => import('./features/alerts/AlertsPage.jsx')), 'stock.view'],
  '/users': [lazy(() => import('./features/admin/UsersPage.jsx')), 'user.manage'],
  '/settings': [lazy(() => import('./features/settings/SettingsPage.jsx')), 'setting.store'],
};
const KEY_PATH = {
  pos: '/pos', dashboard: '/dashboard', stock: '/stock', items: '/items', purchase: '/purchase',
  reports: '/reports', sales: '/sales', alerts: '/alerts', users: '/users', settings: '/settings',
};

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

function Shell() {
  const { status } = useApp();
  if (status === 'anon') return <Suspense fallback={<Loading />}><LoginPage /></Suspense>;
  if (status === 'loading') return <div className="loading" style={{ height: '100vh' }}><span className="spinner" /> Memuat toko…</div>;
  return <Workspace />;
}

function LoginPage() {
  const { login } = useApp();
  const [brand, setBrand] = useState(null);
  useEffect(() => { get('/public/brand').then(setBrand).catch(() => setBrand({})); }, []);
  return <AuthPage onLogin={login} brand={brand} />;
}

function Workspace() {
  const app = useApp();
  const [route, navigate] = useHashRoute();
  const [navOpen, setNavOpen] = useState(false);
  const theme = app.theme || {};
  const menu = (theme.menu || []).filter((m) => m.visible !== false && hasPerm(app.perms, m.perm));

  useEffect(() => {
    const on = () => setNavOpen(false);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const path = route.split('?')[0];
  const [Comp, needPerm] = ROUTES[path] || [];

  const current = menu.find((m) => (KEY_PATH[m.key] || `/${m.key}`) === path);
  const title = current?.label || ({ '/pos': 'Kasir', '/dashboard': 'Dasbor' }[path]) || 'Kasir';

  return (
    <div className="app">
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}
      <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-logo">
            {theme.logo_data_url ? <img src={theme.logo_data_url} alt="" /> : (theme.app_name || app.store.name || 'K').slice(0, 1).toUpperCase()}
          </div>
          <div className="brand-text">
            <strong>{theme.app_name || app.store.name}</strong>
            <span>{roleLabel(app.session?.user?.role || app.boot?.user?.role)}</span>
          </div>
        </div>
        <nav className="nav">
          {menu.map((m) => {
            const to = KEY_PATH[m.key] || `/${m.key}`;
            return (
              <a key={m.key} href={`#${to}`} className={`nav-item ${path === to ? 'active' : ''}`}>
                <span className="nav-icon">{m.icon}</span>
                <span>{m.label}</span>
                {m.key === 'alerts' && app.alertsUnread > 0 && <span className="nav-badge">{app.alertsUnread}</span>}
              </a>
            );
          })}
        </nav>
        <div className="side-foot">
          <div className="avatar">{(app.boot?.user?.display_name || '?').slice(0, 1).toUpperCase()}</div>
          <div className="who">
            <strong>{app.boot?.user?.display_name}</strong>
            <span>{app.boot?.store?.name}</span>
          </div>
          <IconButton label="Keluar" onClick={app.logout}>⏻</IconButton>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <IconButton className="mobile-only" label="Menu" onClick={() => setNavOpen(true)}>☰</IconButton>
          <h1>{title}</h1>
          <div className="spacer" />
          {hasPerm(app.perms, 'stock.view') && (
            <Button size="sm" variant="ghost" onClick={() => navigate('/alerts')}>
              🔔 {app.alertsUnread > 0 && <Badge tone="danger">{app.alertsUnread}</Badge>}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={app.refresh} title="Muat ulang data">↻</Button>
        </header>

        <main className="page">
          {!Comp && <NotFound path={path} onHome={() => navigate(menu[0] ? (KEY_PATH[menu[0].key] || `/${menu[0].key}`) : '/pos')} />}
          {Comp && needPerm && !hasPerm(app.perms, needPerm) && (
            <div className="card"><div className="card-body">
              <h2>Akses terbatas</h2>
              <p className="muted">Halaman ini butuh hak akses <code>{needPerm}</code>. Hubungi pemilik toko untuk penyesuaian peran.</p>
            </div></div>
          )}
          {Comp && (!needPerm || hasPerm(app.perms, needPerm)) && (
            <Suspense fallback={<Loading />}><Comp navigate={navigate} route={route} /></Suspense>
          )}
        </main>
      </div>
    </div>
  );
}

const NotFound = ({ path, onHome }) => (
  <div className="empty-state">
    <div className="empty-icon">🧭</div>
    <h3>Halaman {path} tidak ada</h3>
    <p>Menu bisa diatur ulang lewat Pengaturan → Tema &amp; Tampilan.</p>
    <Button onClick={onHome}>Kembali</Button>
  </div>
);

export { roleLabel } from './lib/roles.js';

// ------------------------------------------------------------------ halaman
function AuthPage({ onLogin, brand }) {
  const [mode, setMode] = useState('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const theme = brand?.theme || {};
  const store = brand?.store || {};

  const submit = async (e) => {
    e?.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await onLogin(username.trim(), mode === 'pin' ? pin : password);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap" style={theme.accent ? { background: theme.canvas } : undefined}>
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo" style={theme.logo_data_url ? { background: 'transparent' } : undefined}>
          {theme.logo_data_url ? <img src={theme.logo_data_url} alt="logo" /> : '🧾'}
        </div>
        <h1 style={{ textAlign: 'center' }}>{theme.app_name || store.name || 'Kasir'}</h1>
        <p className="muted" style={{ textAlign: 'center', marginTop: 2 }}>{store.address || 'Sistem kasir &amp; stok bahan baku'}</p>

        <div className="tabs" style={{ margin: '16px 0 12px' }}>
          <button type="button" className={`tab ${mode === 'password' ? 'active' : ''}`} onClick={() => setMode('password')}>Password</button>
          <button type="button" className={`tab ${mode === 'pin' ? 'active' : ''}`} onClick={() => setMode('pin')}>PIN Kasir</button>
        </div>

        <label className="field">
          <span className="field-label">Nama pengguna</span>
          <input className="input" autoFocus autoCapitalize="none" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="mis. budi" />
        </label>

        {mode === 'password' ? (
          <label className="field" style={{ marginTop: 10 }}>
            <span className="field-label">Kata sandi</span>
            <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        ) : (
          <div style={{ marginTop: 10 }}>
            <label className="field">
              <span className="field-label">PIN 4 digit</span>
              <input className="input" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
            </label>
            <div className="pin-pad" style={{ marginTop: 8 }}>
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((k) => (
                <button type="button" key={k} onClick={() => setPin(k === 'C' ? '' : k === '⌫' ? pin.slice(0, -1) : pin + k)}>{k}</button>
              ))}
            </div>
          </div>
        )}

        {err && <p style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 0 }}>⚠️ {err}</p>}
        <Button className="btn-block" variant="primary" size="lg" loading={busy} style={{ marginTop: 14 }} disabled={!username || (mode === 'pin' ? pin.length < 4 : !password)}>
          {busy ? 'Memeriksa…' : 'Masuk'}
        </Button>
        <p className="muted" style={{ fontSize: 11.5, textAlign: 'center', marginBottom: 0 }}>
          Demo: <code>budi / rahasia123</code> (pemilik) · <code>dewi / 4444</code> (kasir)
        </p>
      </form>
    </div>
  );
}
