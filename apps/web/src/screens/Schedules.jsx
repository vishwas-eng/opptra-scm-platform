import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Button, DataTable, Dot, Field, Input, PageTransition, Panel, Select, Skeleton, StatusPill,
} from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { fmtDate, fmtRelative } from '../lib/format.js';
import { useToast } from '../lib/toast.jsx';
import './schedules.css';

const INSTANCES = [
  { id: 'india', label: 'india · oppdoor', host: 'https://oppdoor.unicommerce.co.in' },
  { id: 'staging', label: 'staging · oppdoorstg', host: 'https://oppdoorstg.unicommerce.com' },
  { id: 'uae', label: 'uae · opptrauae', host: 'https://opptrauae.unicommerce.com' },
  { id: 'ksa', label: 'ksa · opptraksa', host: 'https://opptraksa.unicommerce.com' },
];

const hostFor = (id) => INSTANCES.find((i) => i.id === id)?.host || INSTANCES[0].host;

const statusTone = (status) => (status === 'alive' ? 'ok' : status === 'dead' ? 'bad' : 'idle');

function JobCard({ job }) {
  const last = job.lastRun;
  return (
    <article className="sch-job">
      <header className="sch-job-head">
        <div>
          <h4>{job.name}</h4>
          <p className="meta">{job.description}</p>
        </div>
        <div className="sch-job-badges">
          <Badge tone={job.enabled ? 'ok' : 'neutral'}>{job.enabled ? 'Enabled' : 'Off'}</Badge>
          <Badge tone={job.live ? 'brand' : 'neutral'}>{job.live ? 'Live' : 'Staging'}</Badge>
          {job.awaitingHar && <Badge tone="warn">Awaiting capture</Badge>}
        </div>
      </header>

      <div className="sch-job-meta">
        <span>{job.everyMinutes > 0 ? `every ${job.everyMinutes} min` : 'manual'}</span>
        {job.ownerEmail && <span>· {job.ownerEmail}</span>}
        {job.dryRunDefault && <span>· dry run by default</span>}
      </div>

      <div className="steps-flow">
        {(job.steps || []).map((step) => (
          <span key={step} className="step-chip"><span className="step-name">{step}</span></span>
        ))}
      </div>

      <div className="sch-last">
        {last ? (
          <>
            <StatusPill status={last.status}>{last.status}</StatusPill>
            <span className="meta">
              {fmtRelative(last.finished_at || last.created_at)} · {last.error || last.summary || last.action}
            </span>
          </>
        ) : (
          <span className="meta">Never run</span>
        )}
      </div>
    </article>
  );
}

function ConnectPanel() {
  const [instanceId, setInstanceId] = useState('india');
  const [showPaste, setShowPaste] = useState(false);
  const [cookie, setCookie] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const { ok, bad } = useToast();

  const openUc = async () => {
    // The tab is opened on the click itself — a window.open after an await is a popup
    // the browser did not see the user ask for, and gets blocked.
    const tab = window.open('', '_blank', 'noopener');
    let url = hostFor(instanceId);
    try {
      const res = await api(`/api/admin/uc-login-url?instanceId=${encodeURIComponent(instanceId)}`);
      if (res?.url) url = res.url;
    } catch {
      // Non-admins get a 403 here; the public host is the same place they need to log in.
    }
    if (tab) tab.location.replace(url);
    else window.open(url, '_blank', 'noopener');
  };

  const saveCookie = async () => {
    const jsessionid = cookie.trim();
    if (!jsessionid) { setSaveError('Paste the JSESSIONID value first'); return; }
    setSaving(true);
    setSaveError('');
    try {
      // A 400 carries the reason the cookie was rejected, which is the whole point of
      // this form — so read the body instead of letting api() flatten it to a message.
      const res = await api('/api/admin/uc-session', { body: { jsessionid, instanceId }, raw: true });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.ok === false) {
        const message = data?.error || `Could not save the session (${res.status})`;
        setSaveError(message);
        bad(message);
        return;
      }
      setCookie('');
      ok(`Session saved for ${data.instanceId || instanceId}${data.facility ? ` (${data.facility})` : ''}.`);
    } catch (err) {
      const message = err.message || String(err);
      setSaveError(message);
      bad(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title="Connect Unicommerce">
      <div className="row">
        <Field label="Instance">
          <Select value={instanceId} onChange={(e) => setInstanceId(e.target.value)}>
            {INSTANCES.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
          </Select>
        </Field>
        <Button variant="primary" onClick={openUc}>Open Unicommerce</Button>
        <Button
          variant="ghost"
          aria-expanded={showPaste}
          onClick={() => setShowPaste((v) => !v)}
        >
          {showPaste ? '▾ Paste session cookie' : '▸ Paste session cookie'}
        </Button>
      </div>

      {showPaste && (
        <div className="sch-paste">
          <div className="row">
            <Field
              label="JSESSIONID"
              wide
              hint="Log in above, copy the JSESSIONID cookie, paste it here. It is verified against Unicommerce before it is stored."
              error={saveError || undefined}
            >
              <Input
                value={cookie}
                placeholder="A1B2C3D4E5F6…"
                autoComplete="off"
                spellCheck="false"
                onChange={(e) => setCookie(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveCookie(); }}
              />
            </Field>
            <Button variant="primary" loading={saving} onClick={saveCookie}>Save</Button>
          </div>
        </div>
      )}

      <p className="meta sch-helper">
        Copying the cookie by hand is the fallback —{' '}
        <a href="/downloads/opptra-session-helper.zip" download>download the capture extension</a>{' '}
        and it keeps the session fresh on its own.
      </p>
    </Panel>
  );
}

export default function Schedules() {
  const [jobs, setJobs] = useState(null);
  const [sessions, setSessions] = useState(null);
  const [loading, setLoading] = useState(false);
  const { bad } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    const [scheduleRes, sessionRes] = await Promise.all([
      api('/api/schedules').catch((err) => { bad(err.message || String(err)); return null; }),
      api('/api/uc-session?all=1').catch(() => null),
    ]);
    if (scheduleRes) setJobs(scheduleRes.jobs || []);
    setSessions(sessionRes?.sessions || []);
    setLoading(false);
  }, [bad]);

  useEffect(() => { load(); }, [load]);

  return (
    <PageTransition>
      <Panel
        title="Scheduled jobs"
        actions={<Button variant="secondary" loading={loading} onClick={load}>Refresh</Button>}
      >
        {!jobs ? (
          <div className="sch-skeleton">
            <Skeleton w="100%" h={72} />
            <Skeleton w="100%" h={72} />
          </div>
        ) : (
          <div className="sch-jobs">
            {jobs.map((job) => <JobCard key={job.id} job={job} />)}
          </div>
        )}
      </Panel>

      <ConnectPanel />

      <Panel title="Unicommerce sessions">
        <DataTable
          rowKey={(r) => r.instance_id}
          empty="No sessions recorded yet"
          columns={[
            {
              key: 'instance_id',
              label: 'Instance',
              render: (r) => (
                <span className="sch-instance">
                  <Dot tone={statusTone(r.status)} />
                  {r.instance_id}
                </span>
              ),
            },
            { key: 'status', label: 'Status', render: (r) => (r.needs_relogin ? `${r.status} · needs re-login` : r.status || 'unknown') },
            { key: 'facility', label: 'Facility', render: (r) => r.facility || '—' },
            { key: 'source', label: 'Source', render: (r) => r.source || '—' },
            { key: 'updated_by', label: 'Updated by', render: (r) => r.updated_by || '—' },
            { key: 'last_ok_at', label: 'Last OK', render: (r) => fmtDate(r.last_ok_at) },
            { key: 'last_check_at', label: 'Last check', render: (r) => fmtDate(r.last_check_at) },
            { key: 'fail_count', label: 'Fails', render: (r) => r.fail_count ?? 0 },
            { key: 'has_cookie', label: 'Cookie', render: (r) => (r.has_cookie ? 'stored' : 'none') },
          ]}
          rows={sessions || []}
        />
      </Panel>
    </PageTransition>
  );
}
