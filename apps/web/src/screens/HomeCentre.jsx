import { useCallback, useEffect, useRef, useState } from 'react';
import { RawDetails, ResultHead, RunSurface } from '../components/RunResult.jsx';
import {
  Badge, Button, Checkbox, DataTable, EmptyState, KeyValues, PageTransition, Panel, Skeleton, StatusPill,
} from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { fmtDate } from '../lib/format.js';
import { useToast } from '../lib/toast.jsx';
import { useRun } from '../lib/useRun.js';
import './homecentre.css';

const ENVIRONMENTS = [
  { key: 'staging', label: 'Staging' },
  { key: 'uae', label: 'UAE' },
  { key: 'ksa', label: 'KSA' },
];

const ACTION_LABEL = {
  sync: 'Sync orders',
  scheduled: 'Scheduled',
  inventory: 'Push inventory',
  fulfill: 'Fulfil',
};

function EnvCard({ label, env }) {
  if (!env) return null;
  return (
    <div className="hc-env">
      <header className="hc-env-head">
        <h4>{label}</h4>
        <Badge tone={env.configured ? 'ok' : 'neutral'}>
          {env.configured ? 'Credentials set' : 'Not configured'}
        </Badge>
      </header>
      <KeyValues
        pairs={[
          ['Base URL', env.baseUrl],
          ['Facility', env.facility],
          ['Channel', env.channel],
          ['Customer', env.customer],
        ]}
      />
    </div>
  );
}

export default function HomeCentre() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [archive, setArchive] = useState(false);
  const { bad } = useToast();
  const { busy, progress, result, error, start } = useRun();
  const seededDryRun = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api('/api/automations/homecentre/status');
      setStatus(next);
      // Only on first load: after that the checkbox is the operator's choice, not the server's.
      if (!seededDryRun.current) {
        seededDryRun.current = true;
        setDryRun(next.dryRunDefault !== false);
      }
    } catch (err) {
      bad(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [bad]);

  useEffect(() => { load(); }, [load]);

  const writesToProduction = !dryRun && !!status?.live;

  const syncOrders = () => start('/api/automations/homecentre/sync', {
    dryRun,
    limit: dryRun ? 50 : 1,
    source: archive ? 'archive' : 'active',
  });

  const pushInventory = () => start('/api/automations/homecentre/inventory', { dryRun });

  const fulfil = () => start('/api/automations/homecentre/fulfill', { dryRun: true, limit: 20 });

  return (
    <PageTransition>
      <Panel
        title="Home Centre"
        actions={<Button variant="secondary" loading={loading} onClick={load}>Refresh</Button>}
      >
        {!status ? (
          <div className="hc-skeleton">
            <Skeleton w="180px" h={18} />
            <Skeleton w="100%" h={54} />
          </div>
        ) : (
          <>
            <div className="hc-mode">
              <Badge tone={status.live ? 'brand' : 'neutral'}>
                {status.live ? 'Live' : 'Staging'}
              </Badge>
              <span className="hc-mode-label">{status.modeLabel}</span>
              <Badge tone={status.vinculumConfigured ? 'ok' : 'bad'}>
                {status.vinculumConfigured ? 'Vinculum connected' : 'Vinculum not configured'}
              </Badge>
            </div>

            <KeyValues
              pairs={[
                ['Owner', status.ownerEmail],
                ['Orders target', status.ordersTarget],
                ['Sync cadence', status.syncMinutes ? `every ${status.syncMinutes} min` : 'manual'],
                ['Seller codes', [status.sellerCodes?.uae, status.sellerCodes?.other].filter(Boolean).join(' · ')],
              ]}
            />

            <div className="hc-envs">
              {ENVIRONMENTS.map(({ key, label }) => (
                <EnvCard key={key} label={label} env={status[key]} />
              ))}
            </div>
          </>
        )}
      </Panel>

      <Panel title="Run">
        <div className="hc-actions">
          <Checkbox label="Dry run" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          <Checkbox label="Use archive orders" checked={archive} onChange={(e) => setArchive(e.target.checked)} />
          <span className="meta">
            {writesToProduction
              ? 'Live run — this writes real orders into the Home Centre marketplace.'
              : 'Dry run reads the marketplace and reports what it would do.'}
          </span>
        </div>

        <div className="hc-buttons">
          <Button variant={writesToProduction ? 'danger' : 'primary'} loading={busy} onClick={syncOrders}>
            {writesToProduction ? 'Sync orders (live)' : 'Sync orders'}
          </Button>
          <Button variant="secondary" loading={busy} onClick={pushInventory}>Push inventory</Button>
          <Button variant="secondary" loading={busy} onClick={fulfil}>Fulfil</Button>
        </div>
      </Panel>

      <RunSurface
        busy={busy}
        progress={progress}
        error={error}
        result={result}
        idle={<EmptyState icon="⇄" title="No run yet">Start with a dry run to see what the marketplace holds.</EmptyState>}
      >
        <ResultHead
          ok={result?.ok}
          title={result?.message || (result?.empty ? 'Nothing to do' : 'Run finished')}
          extra={result?.dryRun ? 'Dry run' : result?.mode}
        />
        <KeyValues
          pairs={[
            ['Mode', result?.mode],
            ['UC target', result?.ucTarget],
            ['UC base URL', result?.ucBaseUrl],
            ['Fetched', result?.fetched],
            ['Processed', result?.processed],
            ['SKUs', result?.skuCount],
            ['Succeeded', result?.okCount],
            ['Failed', result?.failed],
            ['Created', Array.isArray(result?.created) ? result.created.join(', ') : result?.created],
            ['Configured', result?.configured === undefined ? undefined : String(result.configured)],
          ]}
        />
        <RawDetails data={result} />
      </RunSurface>

      <Panel title="Recent runs">
        <DataTable
          rowKey={(r) => r.run_uid}
          empty="No Home Centre runs yet"
          columns={[
            { key: 'created_at', label: 'When', render: (r) => fmtDate(r.created_at) },
            { key: 'action', label: 'Action', render: (r) => ACTION_LABEL[r.action] || r.action },
            { key: 'mode', label: 'Mode', render: (r) => (r.dryRun ? 'Dry run' : r.mode || '—') },
            { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status}>{r.status}</StatusPill> },
            {
              key: 'counts',
              label: 'Counts',
              render: (r) => (
                r.okCount === undefined && r.failed === undefined
                  ? (r.error || r.summary || '—')
                  : `${r.okCount ?? 0} ok · ${r.failed ?? 0} failed`
              ),
            },
          ]}
          rows={status?.recentRuns || []}
        />
      </Panel>
    </PageTransition>
  );
}
