// ===========================================================================
//  Komponen UI dasar. Semua warna/ukuran diambil dari CSS custom properties
//  (dihasilkan panel Tema) -> komponen tidak tahu-menahu soal warna toko.
// ===========================================================================
import React, { useEffect, useId, useRef, useState } from 'react';
import { get as apiGet } from './api.js';

export function Button({ children, variant = 'default', size, icon, loading, className = '', ...rest }) {
  return (
    <button type="button" className={`btn ${variant} ${size ? `btn-${size}` : ''} ${className}`} disabled={loading || rest.disabled} {...rest}>
      {loading ? <span className="spinner" /> : icon ? <span className="btn-icon">{icon}</span> : null}
      {children}
    </button>
  );
}

export function IconButton({ label, children, ...rest }) {
  return <button type="button" className="icon-btn" aria-label={label} title={label} {...rest}>{children}</button>;
}

export function Field({ label, hint, error, children, required, className = '' }) {
  return (
    <label className={`field ${className}`}>
      {label && <span className="field-label">{label}{required && <em> *</em>}</span>}
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function Input(props) { return <input className="input" {...props} />; }
export function NumberInput({ value, onChange, step = 1, min, max, ...rest }) {
  return (
    <input
      className="input" type="number" value={value ?? ''} step={step} min={min} max={max}
      onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      {...rest}
    />
  );
}
export function Select({ options = [], value, onChange, ...rest }) {
  return (
    <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest}>
      {options.map((o) => (typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>))}
    </select>
  );
}
export function Textarea(props) { return <textarea className="input" rows={3} {...props} />; }
export function Toggle({ checked, onChange, label }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track"><span className="toggle-thumb" /></span>
      {label && <span className="toggle-label">{label}</span>}
    </label>
  );
}

export function Modal({ open, title, children, onClose, footer, width = '560px', bare }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={`modal ${bare ? 'bare' : ''}`} style={{ maxWidth: width }} role="dialog" aria-modal="true" aria-label={title}>
        {title && <div className="modal-head"><h3>{title}</h3><IconButton label="Tutup" onClick={onClose}>✕</IconButton></div>}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Badge({ children, tone = 'neutral', title }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}

export const StockBadge = ({ status, title }) => (
  <Badge tone={{ ok: 'success', warning: 'warn', critical: 'danger', out: 'danger' }[status] || 'neutral'} title={title}>
    {{ ok: 'Aman', warning: 'Menipis', critical: 'Kritis', out: 'Habis' }[status] || status}
  </Badge>
);

export function Card({ title, subtitle, actions, children, className = '', pad = true }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="card-sub">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={`card-body ${pad ? '' : 'no-pad'}`}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone, icon }) {
  return (
    <div className={`stat stat-${tone || 'default'}`}>
      {icon && <div className="stat-icon">{icon}</div>}
      <div>
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
        {sub && <div className="stat-sub">{sub}</div>}
      </div>
    </div>
  );
}

export function Tabs({ items, value, onChange }) {
  const id = useId();
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => {
        const key = it.key ?? it;
        const label = it.label ?? it;
        const badge = it.badge;
        return (
          <button key={`${id}-${key}`} role="tab" aria-selected={value === key} className={`tab ${value === key ? 'active' : ''}`} onClick={() => onChange(key)}>
            {label}
            {badge ? <span className="tab-badge">{badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function Table({ columns, rows, rowKey = (r, i) => r.id ?? i, onRow, empty = 'Belum ada data', dense }) {
  if (!rows.length) return <div className="empty">{empty}</div>;
  return (
    <div className={`table-wrap ${dense ? 'dense' : ''}`}>
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c.key} style={{ width: c.width, textAlign: c.align }} className={c.align ? `align-${c.align}` : ''}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey(r, i)} className={onRow ? 'clickable' : ''} onClick={onRow ? () => onRow(r) : undefined}>
              {columns.map((c) => <td key={c.key} className={c.align ? `align-${c.align}` : ''}>{c.render ? c.render(r, i) : r[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const Loading = ({ label = 'Memuat…' }) => (
  <div className="loading"><span className="spinner" /> {label}</div>
);

export const EmptyState = ({ icon = '📭', title, hint, action }) => (
  <div className="empty-state">
    <div className="empty-icon">{icon}</div>
    <h3>{title}</h3>
    {hint && <p>{hint}</p>}
    {action}
  </div>
);

export const Spinner = () => <span className="spinner" />;

// ---------------------------------------------------------------- grafik SVG
export function LineChart({ data = [], x = 'day', y = 'revenue', height = 180, format = (v) => v, color = 'var(--accent)' }) {
  const w = 720;
  const max = Math.max(1, ...data.map((d) => Number(d[y]) || 0));
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const pts = data.map((d, i) => [i * step, height - ((Number(d[y]) || 0) / max) * (height - 24) - 12]);
  const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ');
  const area = pts.length ? `${line} L${pts[pts.length - 1][0].toFixed(1)} ${height} L0 ${height} Z` : '';
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" role="img" aria-label="Grafik tren">
      {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={w} y1={height * f} y2={height * f} className="chart-grid" />)}
      {area && <path d={area} className="chart-area" fill={color} opacity="0.12" />}
      {line && <path d={line} fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round" />}
      {pts.map(([px, py], i) => <circle key={i} cx={px} cy={py} r={data.length > 40 ? 0 : 2.6} fill={color} />)}
      {data.length > 0 && (
        <text x="6" y="14" className="chart-label">{format(max)}</text>
      )}
    </svg>
  );
}

export function BarChart({ data = [], labelKey = 'label', valueKey = 'value', height = 170, format = (v) => v, color = 'var(--accent)' }) {
  const max = Math.max(1, ...data.map((d) => Number(d[valueKey]) || 0));
  return (
    <div className="barchart" style={{ height }}>
      {data.map((d, i) => (
        <div key={`${d[labelKey]}-${i}`} className="bar-col" title={`${d[labelKey]}: ${format(d[valueKey])}`}>
          <div className="bar-value">{d[valueKey] ? format(d[valueKey]) : ''}</div>
          <div className="bar-track">
            <div className="bar-fill" style={{ height: `${Math.max(2, (Number(d[valueKey]) || 0) / max * 100)}%`, background: color }} />
          </div>
          <div className="bar-label">{d[labelKey]}</div>
        </div>
      ))}
    </div>
  );
}

export function RowBars({ data = [], labelKey = 'name', valueKey = 'revenue', format = (v) => v, max }) {
  const top = max ?? Math.max(1, ...data.map((d) => Number(d[valueKey]) || 0));
  return (
    <div className="rowbars">
      {data.map((d, i) => (
        <div key={`${d[labelKey]}-${i}`} className="rowbar">
          <div className="rowbar-top">
            <span className="rowbar-name">{d[labelKey]}</span>
            <span className="rowbar-val">{format(d[valueKey])}{d.qty ? ` · ${d.qty} unit` : ''}</span>
          </div>
          <div className="rowbar-track"><div className="rowbar-fill" style={{ width: `${Math.max(2, (Number(d[valueKey]) || 0) / top * 100)}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

/** Bar proges stok (dipakai di tabel stok & kartu bahan baku). */
export function StockBar({ value, target, status }) {
  const pctVal = target > 0 ? Math.min(120, Math.max(0, (value / target) * 100)) : 0;
  return (
    <div className={`stockbar stockbar-${status}`}>
      <div className="stockbar-fill" style={{ width: `${Math.max(3, pctVal)}%` }} />
      {target > 0 && <div className="stockbar-mark" style={{ left: '50%' }} title={`Batas aman: ${target}`} />}
    </div>
  );
}

// ------------------------------------------------------------------- hook api
export function useApi(path, deps = [], { immediate = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(immediate);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = async () => {
    setLoading(true);
    try {
      const res = await apiGet(path);
      if (alive.current) { setData(res); setError(null); }
      return res;
    } catch (err) {
      if (alive.current) setError(err);
      return null;
    } finally {
      if (alive.current) setLoading(false);
    }
  };
  useEffect(() => { if (immediate) run(); /* eslint-disable-next-line */ }, [path, ...deps]);
  return { data, error, loading, reload: run, setData };
}

export const uid = () => Math.random().toString(36).slice(2, 10);
