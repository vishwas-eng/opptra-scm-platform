import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Badge, Button, Checkbox, DataTable, EmptyState, PageTransition, Panel, Select,
} from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { fmtRelative } from '../lib/format.js';
import { useToast } from '../lib/toast.jsx';
import { humanError, humanSummary } from '../lib/humanError.js';
import './channels.css';

const CHANNEL_NAME = { homecentre: 'Home Centre', '6thstreet': '6th Street' };
const REGION_NAME = { uae: 'UAE', ksa: 'KSA', '': 'Default' };
const OPERATION_NAME = { inventory: 'Inventory sync', orders: 'Sale order punch' };

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const MINUTES = [0, 15, 30, 45];
const ZONES = ['Asia/Dubai', 'Asia/Riyadh', 'Asia/Kolkata', 'UTC'];

const pad = (n) => String(n).padStart(2, '0');

/** One operation: run it now, or schedule it. */
function OperationRow({ channelId, region, entry, onChanged }) {
  const { ok, bad } = useToast();
  const s = entry.schedule;

  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    enabled: s?.enabled ?? false,
    hour: s?.hour ?? 9,
    minute: s?.minute ?? 0,
    timezone: s?.timezone || (region === 'ksa' ? 'Asia/Riyadh' : 'Asia/Dubai'),
    dryRun: s?.dry_run ?? true,
  });
  // A run started from here is a deliberate act, so the live/dry choice is explicit.
  const [runDry, setRunDry] = useState(true);

  const runNow = async () => {
    setRunning(true);
    try {
      const r = await api(
        `/api/channels/${channelId}/${region || 'default'}/run/${entry.operation}`,
        { body: { dryRun: runDry } },
      );
      ok(`${OPERATION_NAME[entry.operation]} queued${runDry ? ' (dry run)' : ', LIVE'}. Run ${r.runUid.slice(0, 8)}.`);
      onChanged();
    } catch (err) {
      const h = humanError(err);
      bad(`${h.title}. ${h.fix}`);
    } finally {
      setRunning(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await api(
        `/api/channels/${channelId}/${region || 'default'}/schedule/${entry.operation}`,
        { method: 'PUT', body: form },
      );
      ok(form.enabled
        ? `Scheduled daily at ${pad(form.hour)}:${pad(form.minute)} ${form.timezone}.`
        : 'Schedule turned off.');
      setOpen(false);
      onChanged();
    } catch (err) {
      const h = humanError(err);
      bad(`${h.title}. ${h.fix}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="op-row">
      <div className="op-head">
        <div className="op-name">
          <strong>{OPERATION_NAME[entry.operation]}</strong>
          {s?.enabled ? (
            <Badge tone="ok">daily {pad(s.hour)}:{pad(s.minute)} {String(s.timezone).split('/').pop()}</Badge>
          ) : (
            <Badge tone="neutral">manual</Badge>
          )}
          {s?.last_run_at && (
            <span className="meta">
              last {s.last_status === 'succeeded' ? 'ok' : s.last_status || 'run'} {fmtRelative(s.last_run_at)}
            </span>
          )}
        </div>

        <div className="op-actions">
          <Checkbox
            label="Dry run"
            checked={runDry}
            onChange={(e) => setRunDry(e.target.checked)}
          />
          <Button
            variant={runDry ? 'secondary' : 'danger'}
            className="btn-sm"
            loading={running}
            onClick={runNow}
          >
            {runDry ? 'Run now' : 'Run LIVE'}
          </Button>
          <Button variant="ghost" className="btn-sm" onClick={() => setOpen((o) => !o)}>
            {open ? 'Close' : 'Schedule'}
          </Button>
        </div>
      </div>

      {open && (
        <div className="op-schedule">
          <Checkbox
            label="Run every day"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          <label className="inline-field">
            <span>At</span>
            <Select value={form.hour} onChange={(e) => setForm({ ...form, hour: Number(e.target.value) })}>
              {HOURS.map((h) => <option key={h} value={h}>{pad(h)}</option>)}
            </Select>
            <Select value={form.minute} onChange={(e) => setForm({ ...form, minute: Number(e.target.value) })}>
              {MINUTES.map((m) => <option key={m} value={m}>{pad(m)}</option>)}
            </Select>
            <Select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
            </Select>
          </label>
          <Checkbox
            label="Scheduled runs are dry runs"
            checked={form.dryRun}
            onChange={(e) => setForm({ ...form, dryRun: e.target.checked })}
          />
          <Button variant="primary" className="btn-sm" loading={saving} onClick={save}>Save schedule</Button>
          {!form.dryRun && form.enabled && (
            <p className="op-warn">
              This will write to the live marketplace every day without anyone watching.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function Channels() {
  const { bad } = useToast();
  // /channels/homecentre and /channels/6thstreet deep-link to one channel from the
  // sidebar; /channels shows everything.
  const { focus } = useParams();
  const [channels, setChannels] = useState([]);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([
        api('/api/channels'),
        api('/api/runs?limit=15').catch(() => ({ runs: [] })),
      ]);
      setChannels(c.channels || []);
      setRuns((r.runs || []).filter((x) => ['homecentre', '6thstreet'].includes(x.automation)));
    } catch (err) {
      bad(err.message);
    } finally {
      setLoading(false);
    }
  }, [bad]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <PageTransition><p className="meta">Loading channels…</p></PageTransition>;

  return (
    <PageTransition>
      <p className="lead channels-lead">
        Each marketplace runs two jobs, inventory out, sale orders in, and each region
        is independent, so UAE and KSA can sync on their own schedules.
      </p>

      {channels.filter((ch) => !focus || ch.id === focus).map((ch) => (
        <Panel key={ch.id} title={CHANNEL_NAME[ch.id] || ch.id}>
          {ch.regions.map((r) => (
            <div key={r.region || 'default'} className="region-block">
              <div className="region-head">
                <h4>{REGION_NAME[r.region] ?? r.region.toUpperCase()}</h4>
              </div>
              {r.operations.map((entry) => (
                <OperationRow
                  key={entry.operation}
                  channelId={ch.id}
                  region={r.region}
                  entry={entry}
                  onChanged={load}
                />
              ))}
            </div>
          ))}
        </Panel>
      ))}

      <Panel title="Recent channel runs">
        {runs.length === 0 ? (
          <EmptyState icon="◷" title="No channel runs yet">
            Run an inventory sync or order punch above to see it here.
          </EmptyState>
        ) : (
          <DataTable
            columns={[
              { key: 'when', label: 'When', render: (x) => fmtRelative(x.created_at) },
              { key: 'ch', label: 'Channel', render: (x) => CHANNEL_NAME[x.automation] || x.automation },
              { key: 'action', label: 'Action', render: (x) => x.action },
              { key: 'status', label: 'Status', render: (x) => x.status },
            ]}
            rows={runs}
            rowKey={(x) => x.run_uid}
          />
        )}
      </Panel>
    </PageTransition>
  );
}
