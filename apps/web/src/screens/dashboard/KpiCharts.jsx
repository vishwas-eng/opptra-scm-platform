import {
  BarController, BarElement, CategoryScale, Chart, Filler, Legend, LinearScale,
  LineController, LineElement, PointElement, Tooltip,
} from 'chart.js';
import { useEffect, useRef, useState } from 'react';
import { DataTable, Panel, Skeleton } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { fmtRelative } from '../../lib/format.js';

Chart.register(
  LineController, BarController, LineElement, PointElement, BarElement,
  CategoryScale, LinearScale, Filler, Legend, Tooltip,
);

// Success is never green here: the palette is brand-orange for volume and a muted grey
// for "succeeded", so the eye is drawn to failures (the only colour that means "act").
const C = {
  orange: '#FF5800',
  soft: 'rgba(255,88,0,.16)',
  ok: 'rgba(20,20,20,.48)',
  okLine: '#5c5c5c',
  failed: 'rgba(196,90,70,.72)',
  failedLine: '#C45A46',
  grid: 'rgba(20,20,20,.06)',
  muted: '#5c5c5c',
};

const BASE = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { labels: { boxWidth: 12, font: { family: 'Raleway', size: 11 }, color: C.muted } },
    tooltip: { backgroundColor: '#141414', padding: 10, cornerRadius: 8, titleFont: { family: 'Raleway' }, bodyFont: { family: 'Raleway' } },
  },
};

/** Chart.js owns a canvas imperatively; React must destroy it or the next render leaks. */
function useChart(config, deps) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !config) return undefined;
    const chart = new Chart(ref.current, config);
    return () => chart.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

export default function KpiCharts({ days, onDaysChange }) {
  const [kpi, setKpi] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api(`/api/admin/kpi?days=${days}`)
      .then((d) => { if (alive) setKpi(d); })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [days]);

  const byDay = kpi?.byDay || [];
  const features = (kpi?.features || []).slice(0, 8);

  const dailyRef = useChart(byDay.length ? {
    type: 'line',
    data: {
      labels: byDay.map((d) => String(d.day).slice(0, 10)),
      datasets: [
        { label: 'Total', data: byDay.map((d) => d.total), borderColor: C.orange, backgroundColor: C.soft, fill: true, tension: 0.3, borderWidth: 2, pointRadius: 0 },
        { label: 'Succeeded', data: byDay.map((d) => d.ok), borderColor: C.okLine, backgroundColor: 'transparent', tension: 0.3, borderWidth: 1.5, pointRadius: 0 },
        { label: 'Failed', data: byDay.map((d) => d.failed), borderColor: C.failedLine, backgroundColor: 'transparent', tension: 0.3, borderWidth: 1.5, pointRadius: 0 },
      ],
    },
    options: {
      ...BASE,
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, color: C.muted, font: { size: 10 } } },
        y: { beginAtZero: true, grid: { color: C.grid }, ticks: { precision: 0, color: C.muted, font: { size: 10 } } },
      },
    },
  } : null, [byDay]);

  const automRef = useChart(features.length ? {
    type: 'bar',
    data: {
      labels: features.map((f) => f.label || f.key),
      datasets: [
        { label: 'OK', data: features.map((f) => f.ok), backgroundColor: C.ok, borderRadius: 3 },
        { label: 'Failed', data: features.map((f) => f.failed), backgroundColor: C.failed, borderRadius: 3 },
      ],
    },
    options: {
      ...BASE,
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: C.muted, font: { size: 10 } } },
        y: { stacked: true, beginAtZero: true, grid: { color: C.grid }, ticks: { precision: 0, color: C.muted, font: { size: 10 } } },
      },
    },
  } : null, [features]);

  const userColumns = [
    { key: 'user', label: 'User', render: (r) => r.user_email?.split('@')[0] || '—' },
    { key: 'total', label: 'Runs' },
    { key: 'ok', label: 'OK' },
    { key: 'failed', label: 'Failed' },
    { key: 'last', label: 'Last run', render: (r) => fmtRelative(r.last_run_at) },
  ];

  return (
    <>
      <div className="kpi-head">
        <h3>Operations</h3>
        <div className="seg" role="group" aria-label="Time window">
          {[7, 30].map((d) => (
            <button key={d} type="button" className={days === d ? 'active' : ''} onClick={() => onDaysChange(d)}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className="charts-grid">
        <Panel title="Runs per day">
          <div className="chart-box">
            {loading && !byDay.length ? <Skeleton h={200} /> : <canvas ref={dailyRef} height={220} />}
          </div>
        </Panel>
        <Panel title="By automation">
          <div className="chart-box">
            {loading && !features.length ? <Skeleton h={200} /> : <canvas ref={automRef} height={220} />}
          </div>
        </Panel>
      </div>

      {!!kpi?.byUser?.length && (
        <Panel title="Usage by person">
          <DataTable columns={userColumns} rows={kpi.byUser} rowKey={(r) => r.user_email} />
        </Panel>
      )}
    </>
  );
}
