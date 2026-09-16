// ===========================================================================
//  User & Hak Akses (Fase 2 RBAC) + log audit
// ===========================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { get, post, put, del } from '../../api.js';
import { useApp, hasPerm } from '../../store.jsx';
import { Badge, Button, Card, Field, IconButton, Input, Modal, Select, Stat, Table, Tabs, Toggle } from '../../ui.jsx';
import { dateTime, relTime } from '../../lib/format.js';
import { roleLabel } from '../../lib/roles.js';

export default function UsersPage() {
  const app = useApp();
  const [tab, setTab] = useState('team');
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState(null);
  const [editing, setEditing] = useState(null);
  const [pwdOpen, setPwdOpen] = useState(false);
  const canUser = app.can('user.manage');
  const canRole = app.can('role.manage');

  const load = useCallback(async () => {
    try {
      const [u, r] = await Promise.all([
        canUser || canRole ? get('/users').catch(() => []) : Promise.resolve([]),
        get('/roles').catch(() => null),
      ]);
      setUsers(u); setRoles(r);
    } catch (e) { app.toast(e.message, 'error'); }
  }, [canUser, canRole, app]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div className="grid grid-4">
        <Stat label="Anggota tim" value={users.length} sub={`${users.filter((u) => u.is_active).length} aktif`} icon="👥" />
        <Stat label="Peran" value={roles?.roles?.length || 0} sub="kasir · inventaris · admin" icon="🎭" />
        <Stat label="Hak akses" value={roles?.permissions?.length || 0} sub="butir permission" icon="🔑" />
        <Stat label="Akun Anda" value={app.boot?.user?.display_name || '—'} sub={roleLabel(app.boot?.user?.role)} icon="🙋" />
      </div>

      <Card
        title="Tim & hak akses"
        subtitle="Role menentukan menu yang terlihat dan aksi yang boleh dilakukan. Perubahan langsung berlaku saat user login berikutnya."
        actions={<>
          <Button size="sm" onClick={() => setPwdOpen(true)}>Password saya</Button>
          {canUser && <Button size="sm" variant="primary" onClick={() => setEditing({ role: 'cashier', is_active: 1 })}>+ Tambah user</Button>}
        </>}>
        <div className="row between" style={{ marginBottom: 10 }}>
          <Tabs items={[
            { key: 'team', label: 'Anggota', badge: users.length },
            { key: 'roles', label: 'Matriks Role', badge: roles?.permissions?.length },
            { key: 'audit', label: 'Log Audit' },
          ]} value={tab} onChange={setTab} />
          {!canUser && <span className="muted" style={{ fontSize: 12 }}>Peran Anda hanya bisa melihat; ubah hak akses lewat pemilik toko.</span>}
        </div>

        {tab === 'team' && (
          <Table rows={users} columns={[
            { key: 'display_name', label: 'Nama', render: (r) => (
              <div className="row" style={{ gap: 8 }}>
                <span className="avatar" style={{ width: 28, height: 28, fontSize: 13 }}>{(r.display_name || '?').slice(0, 1).toUpperCase()}</span>
                <div><div className="strong">{r.display_name}</div><div className="muted" style={{ fontSize: 11.5 }}>@{r.username}</div></div>
              </div>) },
            { key: 'role', label: 'Role', render: (r) => <Badge tone={r.role === 'owner' ? 'accent' : r.role === 'admin' || r.role === 'manager' ? 'success' : 'neutral'}>{roleLabel(r.role)}</Badge> },
            { key: 'perms', label: 'Cakupan', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{(roles?.roles?.find((x) => x.key === r.role)?.permissions || []).length} permission</span> },
            { key: 'last_login_at', label: 'Aktivitas', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.last_login_at ? relTime(r.last_login_at) : 'belum pernah masuk'}</span> },
            { key: 'is_active', label: 'Status', render: (r) => (r.is_active ? <Badge tone="success">aktif</Badge> : <Badge tone="danger">nonaktif</Badge>) },
            ...(canUser ? [{ key: 'act', label: '', align: 'right', render: (r) => (
              <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                <Button size="sm" onClick={() => setEditing(r)}>Ubah</Button>
                <IconButton label={r.is_active ? 'Nonaktifkan' : 'Aktifkan'} onClick={async () => {
                  try { await put(`/users/${r.id}`, { display_name: r.display_name, role: r.role, is_active: r.is_active ? 0 : 1 }); load(); }
                  catch (e) { app.toast(e.message, 'error'); }
                }}>{r.is_active ? '⏻' : '✓'}</IconButton>
                <IconButton label="Hapus" onClick={async () => {
                  const ok = await app.confirm({ title: `Hapus @${r.username}?`, message: 'Transaksi miliknya tetap tercatat di riwayat.', danger: true, okText: 'Hapus' });
                  if (!ok) return;
                  try { await del(`/users/${r.id}`); load(); } catch (e) { app.toast(e.message, 'error'); }
                }}>🗑</IconButton>
              </div>) }] : []),
          ]} empty="Belum ada anggota tim" />
        )}

        {tab === 'roles' && roles && <RoleMatrix roles={roles} canEdit={canRole} onChanged={load} />}
        {tab === 'roles' && !roles && <div className="empty">Tidak bisa memuat role.</div>}
        {tab === 'audit' && <AuditTable />}
      </Card>

      <UserEditor row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); app.refresh(); }} />
      <MyPasswordModal open={pwdOpen} onClose={() => setPwdOpen(false)} />
    </>
  );
}

function RoleMatrix({ roles, canEdit, onChanged }) {
  const app = useApp();
  const [sel, setSel] = useState(() => Object.fromEntries(roles.roles.map((r) => [r.key, new Set(r.permissions)])));
  const [busy, setBusy] = useState('');
  const groups = [...new Set(roles.permissions.map((p) => p.group))];
  const toggle = (role, perm) => setSel((s) => {
    const set = new Set(s[role]);
    if (set.has(perm)) set.delete(perm); else set.add(perm);
    if (role === 'owner') { set.add('*'); set.add(perm); }
    return { ...s, [role]: set };
  });
  const save = async (role) => {
    setBusy(role);
    try {
      const list = [...(sel[role] || [])].filter(Boolean);
      await put(`/roles/${role}`, { permissions: role === 'owner' ? ['*', ...roles.permissions.map((p) => p.key)] : list });
      app.toast(`Hak akses ${roleLabel(role)} disimpan`, 'success');
      onChanged();
    } catch (e) { app.toast(e.message, 'error'); } finally { setBusy(''); }
  };
  return (
    <div className="col">
      <div className="table-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th className="perm">Hak akses</th>
              {roles.roles.map((r) => (
                <th key={r.key} title={r.description}>
                  <div className="strong">{r.label}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{r.users} user</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <React.Fragment key={g}>
                <tr className="group-row"><td colSpan={roles.roles.length + 1}>{g}</td></tr>
                {roles.permissions.filter((p) => p.group === g).map((p) => (
                  <tr key={p.key}>
                    <td className="perm"><span title={p.key}>{p.label}</span></td>
                    {roles.roles.map((r) => {
                      const on = r.key === 'owner' ? true : sel[r.key]?.has(p.key);
                      return (
                        <td key={r.key} className="cell">
                          <input type="checkbox" disabled={!canEdit || r.key === 'owner'} checked={!!on} onChange={() => toggle(r.key, p.key)} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="perm muted">Simpan perubahan per kolom</td>
              {roles.roles.map((r) => (
                <td key={r.key} className="cell">
                  {canEdit && r.key !== 'owner'
                    ? <Button size="sm" variant="primary" loading={busy === r.key} onClick={() => save(r.key)}>Simpan</Button>
                    : <span className="muted" style={{ fontSize: 11 }}>{r.key === 'owner' ? 'terkunci' : '—'}</span>}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      {canEdit && (
        <div className="row between">
          <span className="muted" style={{ fontSize: 12 }}>Role pemilik tidak bisa dicabut aksesnya (menjaga agar toko tidak terkunci).</span>
          <Button size="sm" variant="ghost" onClick={async () => {
            const ok = await app.confirm({ title: 'Kembalikan semua role ke bawaan?', message: 'Semua penyesuaian hak akses akan ditimpa.', danger: true, okText: 'Reset' });
            if (!ok) return;
            try { await post('/roles/reset'); onChanged(); app.toast('Matriks dikembalikan ke bawaan', 'success'); }
            catch (e) { app.toast(e.message, 'error'); }
          }}>Reset ke bawaan</Button>
        </div>
      )}
      {!canEdit && <p className="muted" style={{ fontSize: 12 }}>Hanya “Kelola role & hak akses” yang dapat menyimpan perubahan.</p>}
    </div>
  );
}

function AuditTable() {
  const [rows, setRows] = useState(null);
  useEffect(() => { get('/audit?limit=150').then(setRows).catch(() => setRows([])); }, []);
  if (!rows) return <div className="loading"><span className="spinner" /> Memuat log…</div>;
  return (
    <Table dense rows={rows} empty="Belum ada aktivitas tercatat" columns={[
      { key: 'created_at', label: 'Waktu', render: (r) => <span className="nowrap">{dateTime(r.created_at)}</span> },
      { key: 'actor', label: 'Oleh', render: (r) => <span>{r.actor || 'sistem'} <span className="muted" style={{ fontSize: 11 }}>{r.actor_role ? `(${r.actor_role})` : ''}</span></span> },
      { key: 'action', label: 'Aksi', render: (r) => <Badge tone="neutral">{r.action}</Badge> },
      { key: 'entity', label: 'Objek', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.entity}{r.entity_id ? ` · ${String(r.entity_id).slice(0, 10)}…` : ''}</span> },
      { key: 'after_json', label: 'Detail', render: (r) => <span className="muted mono-xs" style={{ fontSize: 11 }}>{short(r.after_json || r.before_json)}</span> },
    ]} />
  );
}
const short = (s) => { if (!s) return '—'; const t = String(s).replace(/[{}"]/g, ''); return t.length > 90 ? `${t.slice(0, 90)}…` : t; };

function UserEditor({ row, onClose, onSaved }) {
  const app = useApp();
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (row) setF({ id: row.id, username: row.username, display_name: row.display_name, role: row.role, is_active: !!row.is_active, password: '', pin: '', branch_id: row.branch_id || '' }); }, [row]);
  if (!row) return null;
  const isNew = !f.id;
  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (isNew) await post('/users', { username: f.username, display_name: f.display_name, role: f.role, password: f.password, pin: f.pin || undefined, branch_id: f.branch_id || null });
      else {
        const body = { display_name: f.display_name, role: f.role, is_active: f.is_active ? 1 : 0, branch_id: f.branch_id || null };
        if (f.password) body.password = f.password;
        if (f.pin) body.pin = f.pin;
        await put(`/users/${f.id}`, body);
      }
      app.toast(isNew ? 'User ditambahkan' : 'Perubahan disimpan', 'success');
      onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} width="480px" title={isNew ? 'Anggota tim baru' : `Ubah @${f.username}`}
      footer={<><Button onClick={onClose}>Batal</Button><Button variant="primary" loading={busy} onClick={save} disabled={!f.display_name || (isNew && (!f.username || f.password.length < 6))}>Simpan</Button></>}>
      <div className="col">
        {!isNew && <Field label="Nama pengguna"><Input value={f.username} readOnly /></Field>}
        {isNew && <div className="grid grid-2">
          <Field label="Nama pengguna" required><Input autoCapitalize="none" value={f.username || ''} onChange={(e) => setF({ ...f, username: e.target.value.trim() })} /></Field>
          <Field label="Password" required hint="min. 6 karakter"><Input type="password" value={f.password || ''} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        </div>}
        <Field label="Nama tampilan" required><Input value={f.display_name || ''} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></Field>
        <div className="grid grid-2">
          <Field label="Role" hint="menentukan menu & hak akses">
            <Select value={f.role} onChange={(v) => setF({ ...f, role: v })} options={['owner', 'admin', 'manager', 'inventory', 'cashier'].map((k) => ({ value: k, label: roleLabel(k) }))} />
          </Field>
          <Field label={isNew ? 'PIN kasir (opsional)' : 'Ganti PIN (kosongkan = tetap)'} hint="4–6 digit untuk login cepat">
            <Input inputMode="numeric" maxLength={6} value={f.pin || ''} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })} />
          </Field>
        </div>
        {!isNew && <Field label="Password baru" hint="kosongkan bila tidak diganti"><Input type="password" value={f.password || ''} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>}
        <Toggle checked={f.is_active} onChange={(v) => setF({ ...f, is_active: v })} label="Akun aktif (boleh login)" />
        {err && <div className="hint-box" style={{ borderColor: 'var(--danger)' }}>⚠️ {err}</div>}
      </div>
    </Modal>
  );
}

function MyPasswordModal({ open, onClose }) {
  const app = useApp();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  return (
    <Modal open onClose={onClose} width="400px" title="Ganti password saya"
      footer={<><Button onClick={onClose}>Batal</Button>
        <Button variant="primary" loading={busy} disabled={!cur || next.length < 6 || next !== again} onClick={async () => {
          setBusy(true); setErr('');
          try { await post('/auth/password', { current: cur, next }); app.toast('Password diperbarui', 'success'); onClose(); }
          catch (e) { setErr(e.message); } finally { setBusy(false); }
        }}>Simpan</Button></>}>
      <div className="col">
        <Field label="Password saat ini"><Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
        <Field label="Password baru" hint="min. 6 karakter"><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Field label="Ulangi password baru" error={again && again !== next ? 'tidak sama' : ''}><Input type="password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
        {err && <div className="hint-box" style={{ borderColor: 'var(--danger)' }}>⚠️ {err}</div>}
      </div>
    </Modal>
  );
}

void hasPerm;
