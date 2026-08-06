import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { fmtRelative } from '../../lib/format.js';
import { useToast } from '../../lib/toast.jsx';

function timeLabel(p) {
  if (p.schedule_kind !== 'daily') return p.status;
  const zone = String(p.timezone || '').split('/').pop()?.replace('Kolkata', 'IST') || 'UTC';
  return `${String(p.hour_utc).padStart(2, '0')}:${String(p.schedule_minute || 0).padStart(2, '0')} ${zone}`;
}

export default function Playbooks({ nonce }) {
  const { ok, bad } = useToast();
  const [playbooks, setPlaybooks] = useState([]);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    api('/api/agent/playbooks')
      .then((r) => setPlaybooks(r.playbooks || []))
      .catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load, nonce]);

  const act = async (uid, action) => {
    setBusyId(uid);
    try {
      await api(`/api/agent/playbooks/${encodeURIComponent(uid)}/${action}`, { body: {} });
      ok(action === 'run' ? 'Queued on the worker.' : `Playbook ${action}d.`);
      if (action !== 'run') load();
    } catch (err) {
      bad(err.message);
    } finally {
      setBusyId(null);
    }
  };

  if (!playbooks.length) return null;

  return (
    <div className="playbooks">
      <span className="playbooks-label">Scheduled</span>
      {playbooks.slice(0, 10).map((p) => {
        const active = p.schedule_kind === 'daily' && p.status === 'active';
        return (
          <div key={p.playbook_uid} className={`playbook-chip${active ? ' active' : ''}`}>
            <span className="pb-title">{p.title}</span>
            <span className="pb-time">{timeLabel(p)}</span>
            {p.last_run_status && (
              <span className={`pb-last pb-${p.last_run_status === 'succeeded' ? 'ok' : 'bad'}`}>
                {p.last_run_status === 'succeeded' ? 'ok' : 'failed'} {fmtRelative(p.last_run_at)}
              </span>
            )}
            <Button variant="ghost" className="btn-sm" loading={busyId === p.playbook_uid} onClick={() => act(p.playbook_uid, 'run')}>
              Run
            </Button>
            <Button
              variant="ghost"
              className="btn-sm"
              loading={busyId === p.playbook_uid}
              onClick={() => act(p.playbook_uid, active ? 'pause' : 'activate')}
            >
              {active ? 'Pause' : 'Activate'}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
