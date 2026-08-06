import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { RawDetails, ResultHead, RunSurface } from '../components/RunResult.jsx';
import {
  Badge, Button, Checkbox, DataTable, EmptyState, PageTransition, Panel,
} from '../components/ui.jsx';
import { useToast } from '../lib/toast.jsx';
import { useObjectUrl, useRun } from '../lib/useRun.js';
import { validateEwayRows } from '../lib/validate.js';
import './eway.css';

const COLUMNS = [
  { key: 'so', label: 'Sale Order', placeholder: 'SO01562', aliases: ['so', 'saleorder', 'order'] },
  { key: 'gstin', label: 'GSTIN', placeholder: '22AAAAA0000A1Z5', aliases: ['gstin', 'gst'] },
  { key: 'transporterName', label: 'Transporter Name', placeholder: 'Transporter name', aliases: ['transportername', 'transporter'] },
  { key: 'transMode', label: 'Transport Mode', placeholder: 'ROAD', aliases: ['transmode', 'transportmode', 'mode'] },
  { key: 'vehicleNo', label: 'Vehicle No', placeholder: 'GJ01AB1234', aliases: ['vehicleno', 'vehiclenumber', 'vehicle'] },
  { key: 'distance', label: 'Distance (km)', placeholder: '12', aliases: ['distance', 'km'] },
  { key: 'docNo', label: 'Document No', placeholder: 'DOC123', aliases: ['docno', 'documentno'] },
  { key: 'docDate', label: 'Document Date', placeholder: '23/06/2026', aliases: ['docdate', 'documentdate', 'date'] },
  { key: 'vehicleType', label: 'Vehicle Type', placeholder: 'REGULAR', aliases: ['vehicletype', 'type'] },
];

const TEMPLATE_HEADERS = COLUMNS.map((c) => c.label);
const TEMPLATE_SAMPLE = [
  'SO01562', '22AAAAA0000A1Z5', 'Opptra Logistics', 'ROAD', 'GJ01AB1234', '12', 'DOC123', '23/06/2026', 'REGULAR',
];

let seq = 0;
const blankRow = () => {
  seq += 1;
  const row = { _id: seq };
  for (const c of COLUMNS) row[c.key] = '';
  row.transMode = 'ROAD';
  row.vehicleType = 'REGULAR';
  return row;
};

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function cellValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const dd = String(v.getDate()).padStart(2, '0');
    const mm = String(v.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${v.getFullYear()}`;
  }
  if (typeof v === 'number') return String(v);
  return String(v).trim();
}

/**
 * Resolve one of our column keys out of a spreadsheet row whose headers are whatever
 * the warehouse typed. Exact beats prefix beats substring, and each rule is tried across
 * every alias before the next looser rule gets a turn.
 *
 * The length guard on the substring rule is the load-bearing bit: a short alias like
 * "gst" or "so" would latch onto an unrelated column, and it is what keeps the vehicle
 * lookup from resolving out of a "Vehicle Type" heading.
 */
function pickCell(row, aliases) {
  const headers = Object.keys(row).map((k) => [norm(k), k]);
  const rules = [
    (h, want) => h === want,
    (h, want) => h.startsWith(want),
    (h, want) => want.length >= 4 && h.includes(want),
  ];
  for (const matches of rules) {
    for (const alias of aliases) {
      const want = norm(alias);
      if (!want) continue;
      const hit = headers.find(([h]) => matches(h, want));
      if (hit) {
        const value = cellValue(row[hit[1]]);
        if (value) return value;
      }
    }
  }
  return '';
}

/** One result row's PDF. Its own component so each object URL is created and revoked once. */
function RowFile({ file }) {
  const url = useObjectUrl(file);
  if (!url) return <span className="meta">—</span>;
  return <a href={url} download={file.filename}>↓ PDF</a>;
}

function EwayResults({ data }) {
  const results = data?.results || [];
  return (
    <>
      <ResultHead
        ok={data?.failed === 0}
        title={`${data?.ok ?? 0} generated`}
        extra={data?.failed ? `${data.failed} failed` : `${results.length} row(s)`}
      />
      <DataTable
        rowKey={(r, i) => `${r.so || 'row'}-${i}`}
        empty="No rows came back"
        columns={[
          { key: 'so', label: 'Sale Order' },
          {
            key: 'state',
            label: 'Status',
            render: (r) => (
              <Badge tone={r.ok ? 'ok' : r.skipped ? 'neutral' : 'bad'}>
                {r.ok ? (r.dryRun ? 'Dry run' : 'Generated') : r.skipped ? 'Skipped' : 'Failed'}
              </Badge>
            ),
          },
          { key: 'ewb', label: 'E-way bill', render: (r) => r.ewb || '—' },
          { key: 'invoiceCode', label: 'Invoice', render: (r) => r.invoiceCode || '—' },
          { key: 'note', label: 'Note', render: (r) => r.error || r.pdfError || '—' },
          { key: 'file', label: 'PDF', render: (r) => (r.file ? <RowFile file={r.file} /> : <span className="meta">—</span>) },
        ]}
        rows={results}
      />
    </>
  );
}

export default function EwayBill() {
  const [rows, setRows] = useState(() => [blankRow(), blankRow()]);
  const [dryRun, setDryRun] = useState(true);
  const [formError, setFormError] = useState('');
  const fileRef = useRef(null);
  const { ok, bad } = useToast();
  const { busy, progress, result, error, start } = useRun();

  const setCell = (id, key, value) => {
    setRows((list) => list.map((r) => (r._id === id ? { ...r, [key]: value } : r)));
  };

  const removeRow = (id) => {
    setRows((list) => (list.length > 1 ? list.filter((r) => r._id !== id) : [blankRow()]));
  };

  const downloadTemplate = () => {
    const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, TEMPLATE_SAMPLE]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Eway');
    XLSX.writeFile(wb, 'opptra-eway-template.xlsx');
  };

  const importFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });

      const imported = [];
      for (const raw of json) {
        const row = blankRow();
        for (const col of COLUMNS) {
          const value = pickCell(raw, col.aliases);
          if (value) row[col.key] = value;
        }
        if (row.so) imported.push(row);
      }

      setRows(imported.length ? imported : [blankRow(), blankRow()]);
      setFormError('');
      if (imported.length) ok(`${imported.length} row(s) imported`);
      else bad('No rows with a Sale Order were found in that file.');
    } catch (err) {
      bad(`Could not read that file: ${err.message || err}`);
    } finally {
      // Re-importing the same filename must fire change again.
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const generate = () => {
    const payload = rows.map((row) => {
      const clean = {};
      for (const col of COLUMNS) {
        const value = String(row[col.key] ?? '').trim();
        if (value) clean[col.key] = value;
      }
      return clean;
    });

    const check = validateEwayRows(payload);
    if (!check.ok) { setFormError(check.message); return; }
    setFormError('');
    start('/api/automations/ewaybill/generate', { dryRun, rows: payload });
  };

  const partial = error && result?.results?.length > 0;

  return (
    <PageTransition>
      <Panel
        title="Rows"
        actions={(
          <>
            <Button variant="ghost" onClick={downloadTemplate}>Download template</Button>
            <Button variant="secondary" onClick={() => fileRef.current?.click()}>Import XLSX/CSV</Button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="sr-only"
              aria-label="Import an XLSX or CSV of e-way bill rows"
              onChange={importFile}
            />
          </>
        )}
      >
        <p className="lead eway-lead">
          One row per sale order. Everything except the Sale Order is optional — leave a cell
          blank and Unicommerce keeps whatever it already holds.
        </p>

        <div className="table-wrap eway-wrap">
          <table className="data-table eway-grid">
            <thead>
              <tr>
                {COLUMNS.map((c) => <th key={c.key} scope="col">{c.label}</th>)}
                <th scope="col"><span className="sr-only">Remove row</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row._id}>
                  {COLUMNS.map((c) => (
                    <td key={c.key}>
                      <input
                        className="input eway-cell"
                        value={row[c.key] ?? ''}
                        placeholder={c.placeholder}
                        aria-label={`${c.label}, row ${i + 1}`}
                        onChange={(e) => setCell(row._id, c.key, e.target.value)}
                      />
                    </td>
                  ))}
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm eway-x"
                      onClick={() => removeRow(row._id)}
                      aria-label={`Remove row ${i + 1}`}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="eway-actions">
          <Button variant="secondary" onClick={() => setRows((l) => [...l, blankRow()])}>+ Add row</Button>
          <Checkbox
            label="Dry run"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
          />
          <span className="meta">
            {dryRun
              ? 'Validates and builds the payload without touching the GST portal.'
              : 'Live — this generates real e-way bills.'}
          </span>
          <Button
            variant={dryRun ? 'primary' : 'danger'}
            loading={busy}
            onClick={generate}
            className="eway-go"
          >
            {dryRun ? 'Generate (dry run)' : 'Generate'}
          </Button>
        </div>

        {formError && <p className="field-error" role="alert">{formError}</p>}
      </Panel>

      <RunSurface
        busy={busy}
        progress={progress}
        error={error}
        result={result}
        idle={<EmptyState icon="▤" title="No run yet">Fill the grid or import a sheet, then generate.</EmptyState>}
      >
        <EwayResults data={result} />
        <RawDetails data={result} />
      </RunSurface>

      {/* A batch fails as soon as one row does, but the rows that did work still matter. */}
      {partial && (
        <Panel title="Row results">
          <EwayResults data={result} />
        </Panel>
      )}
    </PageTransition>
  );
}
