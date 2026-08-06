import { motion } from 'framer-motion';
import { lazy, Suspense, useCallback, useState } from 'react';
import { DataTable, EmptyState, Panel, PageTransition, StatusPill } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { automationLabel, fmtRelative, shortInput, STATUS_LABEL } from '../lib/format.js';
import { usePolling } from '../lib/useRun.js';
import './dashboard.css';

// Chart.js is ~170 kB and only admins ever see it. Splitting it here keeps that weight
// off every operator's first paint.
const KpiCharts = lazy(() => import('./dashboard/KpiCharts.jsx'));

function StatCard({ label, value, sub, tone, index }) {
  return (
    <motion.div
      className={`stat-card${tone ? ` stat-${tone}` : ''}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
    >
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </motion.div>
  );
}

export default function Dashboard() {
  const { isAdmin } = useAuth();
  const [dash, setDash] = useState(null);
  const [runs, setRuns] = useState([]);
  const [days, setDays] = useState(7);

  const refresh = useCallback(() => {
    // Failures here are silent on purpose: a blip in one poll must never blank a
    // dashboard the operator is reading. The next tick recovers it.
    api('/api/dashboard').then(setDash).catch(() => {});
    api('/api/runs?limit=30').then((r) => setRuns(r.runs || [])).catch(() => {});
  }, []);

  usePolling(refresh, 10_000);

  const week = dash?.week || {};
  const successRate = week.total ? Math.round((week.succeeded / week.total) * 100) : null;

  const columns = [
    { key: 'when', label: 'When', render: (r) => fmtRelative(r.created_at) },
    ...(isAdmin ? [{ key: 'user', label: 'User', render: (r) => r.user_email?.split('@')[0] || '-' }] : []),
    { key: 'automation', label: 'Automation', render: (r) => automationLabel(r.automation) },
    { key: 'action', label: 'Action', render: (r) => r.action || '-' },
    { key: 'input', label: 'Order', render: (r) => shortInput(r.input) || '-' },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <StatusPill status={r.status}>{STATUS_LABEL[r.status] || r.status}</StatusPill>,
    },
  ];

  return (
    <PageTransition>
      <div className="stat-grid">
        <StatCard index={0} label="Running now" value={dash?.inflight ?? '-'} sub="live jobs" tone={dash?.inflight ? 'live' : null} />
        <StatCard index={1} label="Runs this week" value={week.total ?? '-'} sub={week.total ? `${week.succeeded || 0} ok · ${week.failed || 0} failed` : null} />
        {isAdmin && <StatCard index={2} label="Success rate" value={successRate == null ? '-' : `${successRate}%`} sub="last 7 days" tone={successRate != null && successRate < 90 ? 'warn' : 'ok'} />}
        {isAdmin && <StatCard index={3} label="Failures" value={week.failed ?? '-'} sub="need a human" tone={week.failed ? 'bad' : null} />}
      </div>

      {isAdmin && (
        <Suspense fallback={null}>
          <KpiCharts days={days} onDaysChange={setDays} />
        </Suspense>
      )}

      <Panel
        title="Recent activity"
        actions={<span className="meta">{isAdmin ? 'Everyone' : 'Your runs'}</span>}
      >
        {runs.length === 0 ? (
          <EmptyState icon="◷" title="Nothing has run yet">
            Start an automation from the sidebar, or ask the Agent to do it for you.
          </EmptyState>
        ) : (
          <DataTable columns={columns} rows={runs} rowKey={(r) => r.run_uid} />
        )}
      </Panel>
    </PageTransition>
  );
}
