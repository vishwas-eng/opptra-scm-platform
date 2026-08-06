import { useEffect, useRef, useState } from 'react';
import { RawDetails, ResultHead, RunSurface } from '../components/RunResult.jsx';
import {
  Button, DataTable, EmptyState, Field, KeyValues, PageTransition, Panel, Textarea,
} from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { parseSoList } from '../lib/format.js';
import { useRun } from '../lib/useRun.js';
import { validateSaleOrderList } from '../lib/validate.js';
import './sheet-update.css';

const ACTIONS = [
  { id: 'first-fill', label: 'First fill', variant: 'primary', takesSos: true },
  { id: 'second-fill', label: 'Second fill', variant: 'secondary', takesSos: true },
  { id: 'push', label: 'Push', variant: 'secondary' },
  { id: 'sync-source', label: 'Sync source', variant: 'secondary' },
];

const DETAIL_COLUMNS = [
  ['so', 'SO'], ['tab', 'Tab'], ['warehouse', 'Warehouse'], ['marketplace', 'Marketplace'],
  ['brand', 'Brand'], ['po', 'PO'], ['qty', 'Qty'], ['destCity', 'Destination'],
  ['invoice', 'Invoice'], ['invoiceQty', 'Inv Qty'], ['tracking', 'Tracking'],
  ['ewayBill', 'E-Way'], ['status', 'Status'],
];

/**
 * The two fills report different fields, the first what UC resolved, the second the
 * invoice join. Showing the union would be a wall of empty cells, so the columns follow
 * whatever the run actually populated.
 */
function usedColumns(details) {
  return DETAIL_COLUMNS
    .filter(([key]) => details.some((d) => String(d?.[key] ?? '').trim() !== ''))
    .map(([key, label]) => ({ key, label, render: (row) => String(row[key] ?? '') }));
}

export default function SheetUpdate() {
  const [integrations, setIntegrations] = useState(null);
  const [sos, setSos] = useState('');
  const [invalid, setInvalid] = useState('');
  const [action, setAction] = useState(null);
  const { busy, progress, result, error, start } = useRun();

  // Config, not data: it never changes while the screen is open, so one fetch for the
  // life of the mount (the ref survives StrictMode's double effect in development).
  const fetched = useRef(false);
  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    api('/api/integrations').then(setIntegrations).catch(() => setIntegrations({}));
  }, []);

  const run = (entry) => {
    const saleOrders = parseSoList(sos);
    if (entry.takesSos && saleOrders.length) {
      const check = validateSaleOrderList(saleOrders, 'SO / GP numbers');
      if (!check.ok) {
        setInvalid(check.message);
        return;
      }
    }
    setInvalid('');
    setAction(entry);
    start(`/api/automations/sheet/${entry.id}`, entry.takesSos ? { saleOrders } : {});
  };

  const r = result || {};
  const details = Array.isArray(r.details) ? r.details : [];
  const columns = usedColumns(details);

  return (
    <PageTransition>
      {integrations?.masterSheetPreviewUrl && (
        <Panel
          title="Master working copy"
          actions={(
            <a className="btn btn-secondary btn-sm sheet-open" href={integrations.masterSheetUrl} target="_blank" rel="noopener noreferrer">
              ↗ Open in Google Sheets
            </a>
          )}
        >
          <iframe
            className="sheet-preview"
            src={integrations.masterSheetPreviewUrl}
            title="Master sheet preview"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        </Panel>
      )}

      <Panel title="Sheet update">
        <p className="lead">
          Leave the order list empty to run over the whole date tab. Enter numbers to add
          orders Waypoint has not published, or to enrich exactly those rows.
        </p>

        <Field
          label="SO / GP numbers"
          wide
          hint="Optional, separated by spaces, commas or new lines"
          error={invalid}
        >
          <Textarea
            rows={5}
            value={sos}
            onChange={(e) => { setSos(e.target.value); if (invalid) setInvalid(''); }}
            placeholder={'SO01562 SO01611\nGP00214'}
            spellCheck="false"
          />
        </Field>

        <div className="row">
          {ACTIONS.map((entry) => (
            <Button
              key={entry.id}
              variant={entry.variant}
              loading={busy && action?.id === entry.id}
              disabled={busy && action?.id !== entry.id}
              onClick={() => run(entry)}
            >
              {entry.label}
            </Button>
          ))}
        </div>

        <RunSurface
          busy={busy}
          progress={progress}
          error={error}
          result={result}
          idle={<EmptyState title="No sheet run yet" icon="▦">Pick a step above, each one is safe to re-run.</EmptyState>}
        >
          <ResultHead
            ok={r.ok}
            title={r.summary || (r.ok === false ? (r.error || 'Failed') : 'Done')}
            extra={action?.label}
          />
          <KeyValues pairs={Object.entries(r.counts || {})} />
          {columns.length > 0 && (
            <div className="sheet-details">
              <DataTable
                columns={columns}
                rows={details}
                rowKey={(row, i) => `${row.so || 'row'}-${i}`}
                empty="Nothing changed"
              />
            </div>
          )}
          <RawDetails data={result} />
        </RunSurface>
      </Panel>
    </PageTransition>
  );
}
