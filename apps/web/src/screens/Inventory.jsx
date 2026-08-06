import { useState } from 'react';
import { RawDetails, ResultHead, RunSurface } from '../components/RunResult.jsx';
import {
  Button, DataTable, EmptyState, Field, Input, KeyValues, PageTransition, Panel, Textarea,
} from '../components/ui.jsx';
import { parseItems } from '../lib/format.js';
import { useRun } from '../lib/useRun.js';
import './inventory.css';

const OPS = [
  { id: 'inward', label: 'Inward', blurb: 'PO → GRN → put-away, so stock lands in the warehouse.' },
  { id: 'outward', label: 'Outward', blurb: 'Sale order → allocate → invoice, so stock leaves it.' },
  { id: 'fullcycle', label: 'Full cycle', blurb: 'Inward then outward in one go, on the same SKUs.' },
];

const DONE = new Set(['INWARD_DONE', 'OUTWARD_DONE', 'FULLCYCLE_DONE']);

/**
 * Full-cycle answers with `{ inward, outward }` nested; inward and outward answer flat.
 * Flattening here keeps one rendering path, outward's fields win because its inventory
 * snapshot is the later one.
 */
function flatten(result) {
  if (!result) return {};
  if (result.op !== 'FULLCYCLE') return result;
  return {
    ...(result.inward || {}),
    ...(result.outward || {}),
    status: result.status,
    outwardError: result.outwardError,
  };
}

export default function Inventory() {
  const [op, setOp] = useState('inward');
  const [items, setItems] = useState('');
  const [orderCode, setOrderCode] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [invalid, setInvalid] = useState('');
  const { busy, progress, result, error, start } = useRun();

  const submit = (e) => {
    e.preventDefault();
    const parsed = parseItems(items);
    if (!parsed.length) {
      setInvalid('Enter at least one line: SKU, qty, unitPrice[, sellingPrice]');
      return;
    }
    setInvalid('');
    const body = { items: parsed };
    if (op !== 'inward') {
      // The inward route rejects unknown properties, so these must not be sent at all.
      if (orderCode.trim()) body.orderCode = orderCode.trim();
      if (customerName.trim()) body.customerName = customerName.trim();
    }
    start(`/api/automations/${op}`, body);
  };

  const r = flatten(result);
  const inventoryRows = Object.entries(r.inventory || {}).map(([sku, qty]) => ({ sku, qty }));
  const opLabel = OPS.find((o) => o.id === op)?.label || op;

  return (
    <PageTransition>
      <Panel title="Inward / outward / full cycle">
        <form onSubmit={submit}>
          <fieldset className="seg-field">
            <legend className="field-label">Operation</legend>
            <div className="seg">
              {OPS.map((o) => (
                <label key={o.id} className={`seg-opt${op === o.id ? ' is-active' : ''}`}>
                  <input
                    type="radio"
                    name="inventory-op"
                    value={o.id}
                    checked={op === o.id}
                    onChange={() => setOp(o.id)}
                  />
                  <span>{o.label}</span>
                </label>
              ))}
            </div>
            <p className="meta seg-blurb">{OPS.find((o) => o.id === op)?.blurb}</p>
          </fieldset>

          <Field
            label="Items"
            wide
            hint="One line per SKU: SKU, qty, unitPrice[, sellingPrice]"
            error={invalid}
          >
            <Textarea
              rows={7}
              value={items}
              onChange={(e) => { setItems(e.target.value); if (invalid) setInvalid(''); }}
              placeholder={'SKU-1001, 10, 250\nSKU-1002, 4, 180, 240'}
              spellCheck="false"
            />
          </Field>

          {op !== 'inward' && (
            <div className="row">
              <Field label="Order code" hint="Optional, generated when left blank">
                <Input
                  value={orderCode}
                  onChange={(e) => setOrderCode(e.target.value)}
                  placeholder="TEST-ORDER-01"
                  autoComplete="off"
                />
              </Field>
              <Field label="Customer name" hint="Optional">
                <Input
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Internal QC"
                  autoComplete="off"
                />
              </Field>
            </div>
          )}

          <div className="row">
            <Button type="submit" variant="primary" loading={busy}>{`Run ${opLabel.toLowerCase()}`}</Button>
          </div>
        </form>

        <RunSurface
          busy={busy}
          progress={progress}
          error={error}
          result={result}
          idle={<EmptyState title="Nothing run yet" icon="⇅">Paste the SKU lines and run the operation.</EmptyState>}
        >
          <ResultHead
            ok={DONE.has(r.status)}
            title={DONE.has(r.status) ? `${opLabel} complete` : (r.outwardError || r.status || 'Incomplete')}
          />
          <KeyValues
            pairs={[
              ['Mode', r.mode],
              ['PO', r.poCode],
              ['GRN', r.grnCode],
              ['Put-away', r.putawayCode],
              ['Sale order', r.soCode],
              ['Packages', (r.shippingPackages || []).join(', ')],
              ['Invoices', (r.invoices || []).map((i) => i.invoiceCode).filter(Boolean).join(', ')],
              ['Outward error', r.outwardError],
            ]}
          />
          {inventoryRows.length > 0 && (
            <div className="inv-table">
              <p className="meta">Inventory now</p>
              <DataTable
                columns={[
                  { key: 'sku', label: 'SKU' },
                  { key: 'qty', label: 'Quantity' },
                ]}
                rows={inventoryRows}
                rowKey={(row) => row.sku}
                empty="No inventory reported"
              />
            </div>
          )}
          <RawDetails data={result} />
        </RunSurface>
      </Panel>
    </PageTransition>
  );
}
