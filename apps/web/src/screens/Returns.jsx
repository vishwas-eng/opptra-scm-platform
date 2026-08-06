import { useState } from 'react';
import { RawDetails, ResultHead, RunSurface, StepChips } from '../components/RunResult.jsx';
import {
  Button, Checkbox, DataTable, EmptyState, Field, Input, KeyValues, PageTransition, Panel, Textarea,
} from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { useRun } from '../lib/useRun.js';
import { validateSaleOrder } from '../lib/validate.js';

// The API caps a batch at 50 pairs; catching it here means the operator sees which
// line to trim instead of a rejected 400 after pasting a hundred rows.
const MAX_PAIRS = 50;

/** `originalSO, correctSO` per line — a single value is the correct SO with nothing to cancel. */
function parsePairs(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [first, second] = line.split(/[,\t]/).map((s) => s.trim());
      return second ? { originalSO: first, correctSO: second } : { correctSO: first };
    });
}

export default function Returns() {
  const { ok, bad } = useToast();

  const [saleOrder, setSaleOrder] = useState('');
  const [cancelSO, setCancelSO] = useState('');
  const [returnIn, setReturnIn] = useState(false);
  const [deliver, setDeliver] = useState(true);
  const [invalid, setInvalid] = useState('');
  // Both single-mode buttons share one result surface, so the renderer needs to know
  // which of the two produced what is on screen.
  const [kind, setKind] = useState(null);
  const single = useRun();

  const [batchText, setBatchText] = useState('');
  const [batchReturnIn, setBatchReturnIn] = useState(false);
  const [batchInvalid, setBatchInvalid] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchResult, setBatchResult] = useState(null);

  const checkSingle = () => {
    const so = saleOrder.trim();
    const check = validateSaleOrder(so);
    if (!check.ok) {
      setInvalid(check.message);
      return null;
    }
    const cancel = cancelSO.trim();
    if (cancel) {
      const cancelCheck = validateSaleOrder(cancel, 'Cancel SO');
      if (!cancelCheck.ok) {
        setInvalid(cancelCheck.message);
        return null;
      }
    }
    setInvalid('');
    return { so, cancel };
  };

  const runStatus = () => {
    const v = checkSingle();
    if (!v) return;
    setKind('status');
    single.start('/api/automations/uc/so-status', { saleOrder: v.so });
  };

  const runProcess = (e) => {
    e.preventDefault();
    const v = checkSingle();
    if (!v) return;
    setKind('process');
    single.start('/api/automations/return/process', {
      saleOrder: v.so,
      cancelSO: v.cancel || null,
      returnIn,
      deliver,
    });
  };

  const runBatch = async () => {
    const pairs = parsePairs(batchText);
    if (!pairs.length) {
      setBatchInvalid('Enter at least one line: originalSO, correctSO');
      return;
    }
    if (pairs.length > MAX_PAIRS) {
      setBatchInvalid(`Too many pairs (${pairs.length}). Maximum is ${MAX_PAIRS} per batch.`);
      return;
    }
    for (let i = 0; i < pairs.length; i += 1) {
      const line = `Line ${i + 1}`;
      const correct = validateSaleOrder(pairs[i].correctSO, `${line}: Sale Order`);
      if (!correct.ok) {
        setBatchInvalid(correct.message);
        return;
      }
      if (pairs[i].originalSO) {
        const original = validateSaleOrder(pairs[i].originalSO, `${line}: Original SO`);
        if (!original.ok) {
          setBatchInvalid(original.message);
          return;
        }
      }
    }
    setBatchInvalid('');
    setBatchBusy(true);
    try {
      // This route answers as soon as the runs are created — there is no single run to
      // poll, so it deliberately does not go through useRun.
      const res = await api('/api/automations/return/batch', { body: { pairs, returnIn: batchReturnIn } });
      setBatchResult(res);
      ok(`Queued ${res.queued} order${res.queued === 1 ? '' : 's'}.`);
    } catch (err) {
      setBatchResult(null);
      bad(err.message || 'Could not queue the batch.');
      setBatchInvalid(err.message || 'Could not queue the batch.');
    } finally {
      setBatchBusy(false);
    }
  };

  const r = single.result || {};

  return (
    <PageTransition>
      <Panel title="Return + re-dispatch">
        <p className="lead">
          Takes a wrongly dispatched order all the way back and out again. Check the status
          first if you are not sure where the order currently sits.
        </p>

        <form onSubmit={runProcess}>
          <div className="row">
            <Field label="Sale order" hint="The correct order to dispatch" error={invalid}>
              <Input
                value={saleOrder}
                onChange={(e) => { setSaleOrder(e.target.value); if (invalid) setInvalid(''); }}
                placeholder="SO01562"
                autoComplete="off"
                spellCheck="false"
              />
            </Field>
            <Field label="Cancel SO" hint="Optional — the wrong order to cancel">
              <Input
                value={cancelSO}
                onChange={(e) => setCancelSO(e.target.value)}
                placeholder="SO01498"
                autoComplete="off"
                spellCheck="false"
              />
            </Field>
          </div>

          <div className="row">
            <Checkbox
              label="Return inward (put stock back)"
              checked={returnIn}
              onChange={(e) => setReturnIn(e.target.checked)}
            />
            <Checkbox
              label="Mark delivered"
              checked={deliver}
              onChange={(e) => setDeliver(e.target.checked)}
            />
          </div>

          <div className="row">
            <Button variant="secondary" loading={single.busy && kind === 'status'} onClick={runStatus}>
              Check status
            </Button>
            <Button type="submit" variant="primary" loading={single.busy && kind === 'process'}>
              Run return flow
            </Button>
          </div>
        </form>

        <RunSurface
          busy={single.busy}
          progress={single.progress}
          error={single.error}
          result={single.result}
          idle={<EmptyState title="Nothing run yet" icon="↺">Check an order&rsquo;s status, or run the full return flow.</EmptyState>}
        >
          {kind === 'status' ? (
            <>
              <ResultHead title={`Status of ${saleOrder.trim()}`} />
              <KeyValues
                pairs={[
                  ['Status', r.status],
                  ['Package', r.pkg],
                  ['Package status', r.pkgStatus],
                  ['Invoice', r.invoice],
                  ['Tracking', r.tracking],
                ]}
              />
            </>
          ) : (
            <>
              <ResultHead
                ok={r.ok === true}
                title={r.ok === true ? `Processed ${r.saleOrder}` : (r.error || 'Did not complete')}
              />
              <StepChips steps={r.steps} />
              <KeyValues
                pairs={[
                  ['Sale order', r.saleOrder],
                  ['Package', r.shippingPackage],
                  ['Invoice', r.invoiceCode],
                  ['Tracking', r.tracking],
                  ['Package status', r.pkgStatus],
                ]}
              />
              {r.pending && (
                <p className="meta">
                  Still working through an async step — this may finish on a later retry.
                </p>
              )}
            </>
          )}
          <RawDetails data={single.result} />
        </RunSurface>
      </Panel>

      <Panel title="Batch queue">
        <p className="lead">
          One pair per line: <code>originalSO, correctSO</code> — or just the correct SO when
          there is nothing to cancel. Each pair is queued as its own run and processed
          sequentially by the worker.
        </p>

        <Field
          label="Pairs"
          wide
          hint={`Up to ${MAX_PAIRS} lines`}
          error={batchInvalid}
        >
          <Textarea
            rows={7}
            value={batchText}
            onChange={(e) => { setBatchText(e.target.value); if (batchInvalid) setBatchInvalid(''); }}
            placeholder={'SO01498, SO01562\nSO01611'}
            spellCheck="false"
          />
        </Field>

        <div className="row">
          <Checkbox
            label="Return inward (put stock back)"
            checked={batchReturnIn}
            onChange={(e) => setBatchReturnIn(e.target.checked)}
          />
          <Button variant="primary" loading={batchBusy} onClick={runBatch}>Queue batch</Button>
        </div>

        {batchResult && (
          <>
            <ResultHead
              ok
              title={`Queued ${batchResult.queued} order${batchResult.queued === 1 ? '' : 's'}`}
              extra="Track progress in Workspace → Recent Activity"
            />
            <DataTable
              columns={[
                { key: 'saleOrder', label: 'Sale order' },
                { key: 'runUid', label: 'Run', render: (row) => <code>{String(row.runUid).slice(0, 8)}</code> },
              ]}
              rows={batchResult.runs || []}
              rowKey={(row) => row.runUid}
              empty="No runs were queued"
            />
          </>
        )}
      </Panel>
    </PageTransition>
  );
}
