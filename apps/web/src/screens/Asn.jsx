import { useState } from 'react';
import { FileResult, RawDetails, ResultHead, RunSurface } from '../components/RunResult.jsx';
import { Button, EmptyState, Field, Input, KeyValues, PageTransition, Panel } from '../components/ui.jsx';
import { useRun } from '../lib/useRun.js';
import { validateSaleOrder } from '../lib/validate.js';

export default function Asn() {
  const [saleOrder, setSaleOrder] = useState('');
  const [invalid, setInvalid] = useState('');
  const { busy, progress, result, error, start } = useRun();

  const submit = (e) => {
    e.preventDefault();
    const so = saleOrder.trim();
    const check = validateSaleOrder(so);
    if (!check.ok) {
      setInvalid(check.message);
      return;
    }
    setInvalid('');
    start('/api/automations/asn/compile', { saleOrder: so });
  };

  const r = result || {};

  return (
    <PageTransition>
      <Panel title="ASN / Packaging compile">
        <p className="lead">
          The marketplace is detected from the order&rsquo;s own Unicommerce channel — the sale
          order number is all you need.
        </p>

        <form className="row" onSubmit={submit}>
          <Field label="Sale order" hint="One order per compile, e.g. SO01562" error={invalid}>
            <Input
              value={saleOrder}
              onChange={(e) => { setSaleOrder(e.target.value); if (invalid) setInvalid(''); }}
              placeholder="SO01562"
              autoComplete="off"
              spellCheck="false"
            />
          </Field>
          <Button type="submit" variant="primary" loading={busy}>Compile ASN</Button>
        </form>

        <RunSurface
          busy={busy}
          progress={progress}
          error={error}
          result={result}
          idle={<EmptyState title="No ASN yet" icon="▤">Enter a sale order and compile to get the packaging file.</EmptyState>}
        >
          <ResultHead
            ok={r.ok}
            title={r.ok
              ? `ASN ready — ${r.lineCount ?? 0} line${r.lineCount === 1 ? '' : 's'}`
              : (r.error || 'Compile failed')}
          />
          <KeyValues
            pairs={[
              ['Sale order', r.so],
              ['Channel', r.channel],
              ['Facility', r.facility],
              ['PO', r.po],
              ['Invoice', r.invoice],
              ['Lines', r.lineCount],
            ]}
          />
          <FileResult file={r.file} />
          <RawDetails data={result} />
        </RunSurface>
      </Panel>
    </PageTransition>
  );
}
