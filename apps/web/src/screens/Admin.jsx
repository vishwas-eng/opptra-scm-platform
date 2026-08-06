import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Button, DataTable, Field, Input, Panel, PageTransition, Select,
} from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { fmtDate, fmtRelative } from '../lib/format.js';
import { useToast } from '../lib/toast.jsx';

function AccessTokens() {
  const { ok, bad } = useToast();
  const [tokens, setTokens] = useState([]);
  const [fresh, setFresh] = useState(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api('/api/admin/ingest-tokens').then((r) => setTokens(r.tokens || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api('/api/admin/ingest-tokens', { body: { label: label.trim() || 'helper' } });
      setFresh(r.token);
      setLabel('');
      load();
    } catch (err) { bad(err.message); } finally { setBusy(false); }
  };

  const revoke = async (id) => {
    try {
      await api(`/api/admin/ingest-tokens/${id}`, { method: 'DELETE' });
      ok('Revoked.');
      load();
    } catch (err) { bad(err.message); }
  };

  return (
    <Panel title="Access tokens">
      <p className="lead">
        One token per machine. These authenticate the Capture extension and any MCP
        client (Claude Code, Cursor) as their owner — every call they make is audited
        under that person&apos;s name.
      </p>

      <div className="row">
        <Field label="Label">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="my laptop" maxLength={64} />
        </Field>
        <Button variant="primary" loading={busy} onClick={create}>Create token</Button>
      </div>

      {fresh && (
        <div className="token-reveal">
          <p className="meta">Copy this now — it is never shown again.</p>
          <pre className="output">{fresh}</pre>
        </div>
      )}

      <DataTable
        columns={[
          { key: 'label', label: 'Label' },
          { key: 'owner', label: 'Owner', render: (t) => t.owner_email?.split('@')[0] },
          { key: 'created', label: 'Created', render: (t) => fmtDate(t.created_at) },
          { key: 'used', label: 'Last used', render: (t) => (t.last_used ? fmtRelative(t.last_used) : 'never') },
          {
            key: 'act',
            label: '',
            render: (t) => (t.revoked
              ? <Badge tone="neutral">revoked</Badge>
              : <Button variant="ghost" className="btn-sm" onClick={() => revoke(t.id)}>Revoke</Button>),
          },
        ]}
        rows={tokens}
        rowKey={(t) => t.id}
        empty="No tokens yet"
      />
    </Panel>
  );
}

function Users() {
  const { ok, bad } = useToast();
  const [users, setUsers] = useState([]);

  const load = useCallback(() => {
    api('/api/admin/users').then((r) => setUsers(r.users || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const setRole = async (email, role) => {
    try {
      await api(`/api/admin/users/${encodeURIComponent(email)}`, { body: { role } });
      ok(`${email.split('@')[0]} is now ${role}.`);
      load();
    } catch (err) {
      // The server refuses self-demotion and removing the last admin; both messages
      // are worth showing verbatim.
      bad(err.message);
      load();
    }
  };

  return (
    <Panel title="People">
      <DataTable
        columns={[
          { key: 'email', label: 'Email' },
          { key: 'name', label: 'Name', render: (u) => u.name || '—' },
          {
            key: 'role',
            label: 'Role',
            render: (u) => (
              <Select value={u.role} onChange={(e) => setRole(u.email, e.target.value)} aria-label={`Role for ${u.email}`}>
                <option value="admin">admin</option>
                <option value="ops">ops</option>
                <option value="viewer">viewer</option>
              </Select>
            ),
          },
          { key: 'active', label: 'Active', render: (u) => (u.is_active ? <Badge tone="ok">yes</Badge> : <Badge tone="bad">no</Badge>) },
          { key: 'login', label: 'Last login', render: (u) => (u.last_login ? fmtRelative(u.last_login) : 'never') },
        ]}
        rows={users}
        rowKey={(u) => u.email}
        empty="No users yet"
      />
    </Panel>
  );
}

function SharedGoogle() {
  const [status, setStatus] = useState(null);
  useEffect(() => { api('/api/admin/google/status').then(setStatus).catch(() => {}); }, []);
  return (
    <Panel title="Shared Google grant">
      <p className="lead">
        Powers platform automations (Sheet Update). Per-person Gmail for Packing Mail is
        separate and lives on the Connectors page.
      </p>
      <div className="row">
        {status?.connected
          ? <Badge tone="ok">Connected as {status.grantedBy}</Badge>
          : <Badge tone="neutral">Not connected</Badge>}
        <a className="btn btn-secondary" href="/auth/google/connect-shared">
          {status?.connected ? 'Re-authorize' : 'Connect'}
        </a>
      </div>
    </Panel>
  );
}

function Audit() {
  const [rows, setRows] = useState([]);
  useEffect(() => { api('/api/admin/audit').then((r) => setRows(r.audit || [])).catch(() => {}); }, []);
  return (
    <Panel title="Audit log">
      <DataTable
        columns={[
          { key: 'at', label: 'When', render: (r) => fmtDate(r.at) },
          { key: 'actor', label: 'Actor' },
          { key: 'event', label: 'Event' },
          {
            key: 'detail',
            label: 'Detail',
            render: (r) => <span className="audit-detail">{typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}</span>,
          },
        ]}
        rows={rows}
        rowKey={(r, i) => `${r.at}-${i}`}
        empty="Nothing recorded yet"
      />
    </Panel>
  );
}

export default function Admin() {
  return (
    <PageTransition>
      <AccessTokens />
      <SharedGoogle />
      <Users />
      <Audit />
    </PageTransition>
  );
}
