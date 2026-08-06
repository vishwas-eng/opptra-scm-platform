import { useState } from 'react';
import { Button, Field, Input } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { useToast } from '../../lib/toast.jsx';

const RESOURCE_CONNECTORS = new Set(['google-sheets', 'google-drive']);
const GOOGLE_OAUTH = '/auth/google/connect?return=connectors';

/**
 * Layer-B scoping: the agent can only touch spreadsheets and Drive folders that have
 * been explicitly bound here. Connecting Google grants access to the account; binding
 * is what decides which documents inside it are in play.
 */
export default function ResourceBindings({ connector: c, onChanged }) {
  const { ok, bad } = useToast();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  if (!RESOURCE_CONNECTORS.has(c.id)) return null;

  if (!c.systemReady) {
    return (
      <div className="bindings">
        <p className="meta">Connect your Google account first, then bind the documents the agent may use.</p>
      </div>
    );
  }

  const isSheets = c.id === 'google-sheets';

  const add = async (e) => {
    e.preventDefault();
    if (!url.trim()) return bad('Paste a link or ID first.');
    setBusy(true);
    try {
      await api(`/api/agent/connectors/${c.id}/resources`, {
        body: { url: url.trim(), ...(name.trim() ? { name: name.trim() } : {}) },
      });
      ok('Bound.');
      setUrl(''); setName('');
      onChanged();
    } catch (err) {
      if (/oauth|connect google|reconnect/i.test(err.message)) {
        window.location.href = GOOGLE_OAUTH;
        return;
      }
      bad(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (resourceUid) => {
    try {
      await api(`/api/agent/connectors/${c.id}/resources/${resourceUid}`, { method: 'DELETE' });
      ok('Unbound.');
      onChanged();
    } catch (err) {
      bad(err.message);
    }
  };

  return (
    <div className="bindings">
      <h4>{isSheets ? 'Spreadsheets' : 'Drive folders & files'} the agent may use</h4>

      {c.resources?.length > 0 ? (
        <ul className="binding-list">
          {c.resources.map((r) => (
            <li key={r.resourceUid}>
              <div className="binding-info">
                <strong>{r.name || r.externalId}</strong>
                <span className="meta">{r.kind} · {String(r.externalId).slice(0, 18)}…</span>
              </div>
              <Button variant="ghost" className="btn-sm" onClick={() => remove(r.resourceUid)}>Remove</Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="meta">Nothing bound yet — the agent cannot read anything until you add one.</p>
      )}

      <form className="binding-form" onSubmit={add}>
        <Field label="Link or ID">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            maxLength={500}
            placeholder={isSheets ? 'Paste spreadsheet URL or ID' : 'Paste Drive folder/file URL or ID'}
            required
          />
        </Field>
        <Field label="Name (optional)">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder="What is it?" />
        </Field>
        <Button variant="secondary" type="submit" loading={busy}>
          {isSheets ? 'Add spreadsheet' : 'Add folder / file'}
        </Button>
      </form>
    </div>
  );
}
