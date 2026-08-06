import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, DataTable, Field, Input } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { fmtRelative } from '../../lib/format.js';
import { useToast } from '../../lib/toast.jsx';

/**
 * The connect path for portals with no seller API: the operator logs in once with the
 * Capture extension recording, and the platform derives the blueprint. This panel is
 * the instructions plus the HAR fallback plus the history of what has been captured.
 */
export default function CaptureGuide({ connector }) {
  const { ok, bad } = useToast();
  const [captures, setCaptures] = useState([]);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api(`/api/capture/sessions?connectorId=${connector.id}`)
    .then((r) => setCaptures(r.captures || []))
    .catch(() => {});

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [connector.id]);

  const upload = async (e) => {
    e.preventDefault();
    if (!file) return bad('Choose a .har file first.');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await api(`/api/capture/har?connectorId=${connector.id}`, { body: form });
      const s = r.capture?.analysis?.summary || {};
      ok(`Analyzed ${s.entries || 0} requests → ${s.endpoints || 0} endpoints.`);
      setFile(null);
      load();
    } catch (err) {
      bad(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="capture-guide">
      <ol className="steps">
        <li>
          Install the <Link to="/extensions">Connector Capture extension</Link> and paste
          your access token (Admin → Access tokens).
        </li>
        <li>Pick <strong>{connector.name}</strong> in the extension and press Start.</li>
        <li>Log in to the portal as you normally would — passwords are never recorded.</li>
        <li>Visit Orders, Inventory and one shipment once each. Two minutes is enough.</li>
        <li>Press Stop. The platform seals the session and maps the endpoints.</li>
      </ol>

      <form className="har-upload" onSubmit={upload}>
        <Field label="Or upload a DevTools HAR" hint="Gives response shapes too, which the extension cannot observe.">
          <Input type="file" accept=".har,application/json" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </Field>
        <Button variant="secondary" type="submit" loading={busy} disabled={!file}>Analyze HAR</Button>
      </form>

      {captures.length > 0 && (
        <DataTable
          columns={[
            { key: 'when', label: 'When', render: (r) => fmtRelative(r.created_at) },
            { key: 'entries', label: 'Requests', render: (r) => r.entry_count },
            { key: 'endpoints', label: 'Endpoints', render: (r) => r.summary?.endpoints ?? '—' },
            { key: 'host', label: 'API host', render: (r) => r.summary?.primaryHost || '—' },
            { key: 'session', label: 'Session', render: (r) => (r.session_saved ? 'sealed' : '—') },
            { key: 'status', label: 'Status', render: (r) => r.status },
          ]}
          rows={captures}
          rowKey={(r) => r.capture_uid}
          empty="No captures yet"
        />
      )}
    </div>
  );
}
