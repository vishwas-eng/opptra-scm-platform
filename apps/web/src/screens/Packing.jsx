import { useEffect, useMemo, useState } from 'react';
import { RawDetails, ResultHead, RunSurface } from '../components/RunResult.jsx';
import {
  Badge, Button, Checkbox, EmptyState, Field, PageTransition, Panel, Textarea,
} from '../components/ui.jsx';
import { api, runJob } from '../lib/api.js';
import { parseSoList } from '../lib/format.js';
import { useToast } from '../lib/toast.jsx';
import { useRun } from '../lib/useRun.js';
import { validateSaleOrderList } from '../lib/validate.js';
import './packing.css';

const ROLES = [
  { role: 'to', label: 'To' },
  { role: 'cc', label: 'CC' },
  { role: 'finance', label: 'Finance' },
];

const toggle = (list, value) => (
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
);

function GmailPanel({ status, onDisconnect, busy }) {
  if (!status) {
    return (
      <Panel title="Gmail">
        <p className="meta">Checking your Gmail connection…</p>
      </Panel>
    );
  }

  const connected = status.connected;
  const missing = status.scopes?.missing || [];

  return (
    <Panel title="Gmail">
      <div className="pk-gmail">
        <Badge tone={connected ? 'ok' : status.needsReconnect ? 'warn' : 'neutral'}>
          {connected ? 'Connected' : status.needsReconnect ? 'Needs reconnect' : 'Not connected'}
        </Badge>
        <span className="pk-gmail-account">
          {status.googleEmail || 'Drafts are created in your own mailbox.'}
        </span>
        {connected ? (
          <Button variant="secondary" loading={busy} onClick={onDisconnect}>Disconnect</Button>
        ) : (
          <a className="btn btn-primary" href="/auth/google/connect?return=packing">Connect Gmail</a>
        )}
      </div>

      {status.accountMismatch && (
        <p className="field-error">
          Gmail is connected as {status.googleEmail}, which is not the account you signed in
          with — drafts will land in that mailbox.
        </p>
      )}
      {status.needsReconnect && missing.length > 0 && (
        <p className="meta">Missing permissions: {missing.join(', ')}</p>
      )}
      {status.lastError && <p className="meta">Last error: {status.lastError}</p>}
    </Panel>
  );
}

function GroupCard({ group, picked, onToggle }) {
  const options = group.options || {};
  return (
    <article className="pk-group">
      <header className="pk-group-head">
        <h4>{group.warehouse}</h4>
        <span className="meta">{group.sos.length} order{group.sos.length === 1 ? '' : 's'}</span>
      </header>

      <div className="pk-sos">
        {group.sos.map((so) => <code key={so}>{so}</code>)}
      </div>

      <div className="pk-roles">
        {ROLES.map(({ role, label }) => {
          const addresses = options[role] || [];
          if (!addresses.length) return null;
          return (
            <div key={role} className="pk-role">
              <span className="field-label">{label}</span>
              {addresses.map((address) => (
                <Checkbox
                  key={`${role}:${address}`}
                  label={address}
                  checked={picked[role].includes(address)}
                  onChange={() => onToggle(group.warehouse, role, address)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </article>
  );
}

function DraftCard({ draft, state, onSend }) {
  const sent = state === 'sent';
  return (
    <article className="pk-draft">
      <header className="pk-group-head">
        <h4>{draft.warehouse}</h4>
        <span className="meta">
          {draft.sos?.length || 0} order{draft.sos?.length === 1 ? '' : 's'} · {draft.attachmentCount || 0} attachment{draft.attachmentCount === 1 ? '' : 's'}
        </span>
      </header>
      <p className="meta">To: {(draft.to || []).join(', ') || '—'}</p>
      {draft.cc?.length > 0 && <p className="meta">CC: {draft.cc.join(', ')}</p>}
      <div className="pk-draft-actions">
        {draft.viewUrl && (
          <a className="btn btn-secondary btn-sm" href={draft.viewUrl} target="_blank" rel="noreferrer">
            Open in Gmail
          </a>
        )}
        <Button
          variant={sent ? 'ghost' : 'primary'}
          className="btn-sm"
          disabled={sent || state === 'sending'}
          loading={state === 'sending'}
          onClick={() => onSend(draft.draftId)}
        >
          {sent ? 'Sent' : state === 'sending' ? 'Sending…' : 'Send now'}
        </Button>
      </div>
    </article>
  );
}

function Unresolved({ items }) {
  if (!items?.length) return null;
  return (
    <div className="pk-unresolved">
      <strong>{items.length} order{items.length === 1 ? '' : 's'} could not be resolved</strong>
      <ul>
        {items.map((u, i) => <li key={`${u.so}-${i}`}><code>{u.so}</code> {u.reason}</li>)}
      </ul>
    </div>
  );
}

export default function Packing() {
  const [gmail, setGmail] = useState(null);
  const [gmailBusy, setGmailBusy] = useState(false);
  const [text, setText] = useState('');
  const [formError, setFormError] = useState('');
  const [picked, setPicked] = useState({});
  const [sendState, setSendState] = useState({});
  const { ok, bad } = useToast();

  const preview = useRun();
  const drafts = useRun();

  useEffect(() => {
    api('/api/me/google/status')
      .then(setGmail)
      .catch(() => setGmail({ connected: false }));
  }, []);

  const groups = preview.result?.groups || [];

  // Pre-tick what the server suggests; finance stays off until somebody asks for it.
  useEffect(() => {
    const next = {};
    for (const g of groups) {
      next[g.warehouse] = {
        to: [...(g.selectedTo || [])],
        cc: [...(g.selectedCc || [])],
        finance: [],
      };
    }
    setPicked(next);
  }, [preview.result]); // eslint-disable-line react-hooks/exhaustive-deps

  const saleOrders = useMemo(() => parseSoList(text), [text]);

  const disconnectGmail = async () => {
    setGmailBusy(true);
    try {
      await api('/api/me/google/disconnect', { body: {} });
      const next = await api('/api/me/google/status').catch(() => ({ connected: false }));
      setGmail(next);
      ok('Gmail disconnected.');
    } catch (err) {
      bad(err.message || String(err));
    } finally {
      setGmailBusy(false);
    }
  };

  const checkOrders = () => {
    const check = validateSaleOrderList(saleOrders);
    if (!check.ok) { setFormError(check.message); return false; }
    setFormError('');
    return true;
  };

  const runPreview = () => {
    if (!checkOrders()) return;
    setSendState({});
    drafts.reset();
    preview.start('/api/automations/packing/preview', { saleOrders });
  };

  /** Finance is an extra CC, not a field of its own — the API only knows to/cc. */
  const buildRecipients = () => {
    const recipients = {};
    for (const [warehouse, pick] of Object.entries(picked)) {
      recipients[warehouse] = {
        to: pick.to,
        cc: [...new Set([...pick.cc, ...pick.finance])],
      };
    }
    return recipients;
  };

  const runDrafts = (path) => {
    if (!checkOrders()) return;
    setSendState({});
    drafts.start(path, { saleOrders, recipients: buildRecipients() });
  };

  const onToggle = (warehouse, role, address) => {
    setPicked((prev) => ({
      ...prev,
      [warehouse]: { ...prev[warehouse], [role]: toggle(prev[warehouse][role], address) },
    }));
  };

  const sendDraft = async (draftId) => {
    setSendState((s) => ({ ...s, [draftId]: 'sending' }));
    try {
      const run = await runJob('/api/automations/packing/send-draft', { draftId });
      if (run.status === 'failed') throw new Error(run.error || 'The send failed.');
      setSendState((s) => ({ ...s, [draftId]: 'sent' }));
      ok('Mail sent.');
    } catch (err) {
      setSendState((s) => ({ ...s, [draftId]: 'idle' }));
      bad(err.message || String(err));
    }
  };

  const hasPreview = groups.length > 0;
  const draftList = drafts.result?.drafts || [];

  return (
    <PageTransition>
      <GmailPanel status={gmail} busy={gmailBusy} onDisconnect={disconnectGmail} />

      <Panel title="Sale orders">
        <Field
          label="Sale orders"
          wide
          hint={saleOrders.length ? `${saleOrders.length} order(s)` : 'One per line, or separated by commas'}
          error={formError || undefined}
        >
          <Textarea
            value={text}
            placeholder={'SO01562\nSO01563'}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>

        <div className="pk-steps">
          <Button variant="primary" loading={preview.busy} onClick={runPreview}>
            1 · Preview recipients
          </Button>
          <Button
            variant="secondary"
            disabled={!hasPreview}
            loading={drafts.busy}
            onClick={() => runDrafts('/api/automations/packing/drafts')}
          >
            2 · Create drafts
          </Button>
          <Button
            variant="secondary"
            disabled={!hasPreview}
            loading={drafts.busy}
            onClick={() => runDrafts('/api/automations/packing/invoice-eway')}
          >
            3 · Invoice + E-way drafts
          </Button>
          {!hasPreview && <span className="meta">Preview first — the drafts go out to whoever is ticked below.</span>}
        </div>
      </Panel>

      <RunSurface
        busy={preview.busy}
        progress={preview.progress}
        error={preview.error}
        result={preview.result}
        idle={<EmptyState icon="✉" title="Nothing previewed yet">Paste the sale orders and preview who gets the mail.</EmptyState>}
      >
        <ResultHead
          ok={preview.result?.unresolved?.length === 0}
          title={`${groups.length} warehouse${groups.length === 1 ? '' : 's'}`}
          extra={preview.result?.directoryCount ? `${preview.result.directoryCount} in the directory` : undefined}
        />
        <div className="pk-groups">
          {groups.map((g) => (
            picked[g.warehouse] ? (
              <GroupCard key={g.warehouse} group={g} picked={picked[g.warehouse]} onToggle={onToggle} />
            ) : null
          ))}
        </div>
        <Unresolved items={preview.result?.unresolved} />
        <RawDetails data={preview.result} />
      </RunSurface>

      <RunSurface
        busy={drafts.busy}
        progress={drafts.progress}
        error={drafts.error}
        result={drafts.result}
      >
        <ResultHead
          ok={drafts.result?.ok}
          title={`${drafts.result?.draftCount ?? draftList.length} draft${(drafts.result?.draftCount ?? draftList.length) === 1 ? '' : 's'} created`}
          extra="Review in Gmail before sending"
        />
        <div className="pk-groups">
          {draftList.map((d) => (
            <DraftCard
              key={d.draftId || d.warehouse}
              draft={d}
              state={sendState[d.draftId] || 'idle'}
              onSend={sendDraft}
            />
          ))}
        </div>
        <Unresolved items={drafts.result?.unresolved} />
        <RawDetails data={drafts.result} />
      </RunSurface>
    </PageTransition>
  );
}
