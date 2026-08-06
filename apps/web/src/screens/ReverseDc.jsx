import { useCallback, useEffect, useRef, useState } from 'react';
import { FileResult, RawDetails, ResultHead, RunSurface } from '../components/RunResult.jsx';
import {
  Button, EmptyState, Field, Input, KeyValues, PageTransition, Panel, Select, Spinner,
} from '../components/ui.jsx';
import { api, runJob } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { useRun } from '../lib/useRun.js';
import { validateBulkReturnId } from '../lib/validate.js';

const MODE_LABEL = {
  rebuild: 'Rebuilt from the credit-note data',
  'edit-fallback': 'Edited the original PDF (data rebuild unavailable)',
};

/**
 * Facilities are a background lookup, not the operator's action, so they get their own
 * state, routing them through useRun would blank the result they are looking at.
 */
function useFacilities() {
  const [facilities, setFacilities] = useState([]);
  const [current, setCurrent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const loaded = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const run = await runJob('/api/automations/uc/facilities', {});
      const payload = run.result ?? run;
      setFacilities(payload?.all || []);
      setCurrent(payload?.current || '');
      return payload;
    } catch (err) {
      setError(err.message || String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    load();
  }, [load]);

  return { facilities, current, loading, error, reload: load };
}

export default function ReverseDc() {
  const { facilities, current, loading, error: facilityError, reload } = useFacilities();
  const [facility, setFacility] = useState('');
  const [bulkReturnId, setBulkReturnId] = useState('');
  const [formError, setFormError] = useState('');
  const { busy, progress, result, error, start } = useRun();

  const [upload, setUpload] = useState({ busy: false, result: null, error: '' });
  const uploadRef = useRef(null);
  const { bad } = useToast();

  // The operator's own facility is the right default; they only change it for another site.
  useEffect(() => { if (current) setFacility((f) => f || current); }, [current]);

  const build = () => {
    const check = validateBulkReturnId(bulkReturnId);
    if (!check.ok) { setFormError(check.message); return; }
    if (!facility) { setFormError('Pick a warehouse first'); return; }
    setFormError('');
    start('/api/automations/reversedc/from-bulk-return', {
      facility,
      bulkReturnId: bulkReturnId.trim(),
    });
  };

  const uploadPdf = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUpload({ busy: true, result: null, error: '' });
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await api('/api/automations/reversedc/build', { body });
      setUpload({ busy: false, result: res, error: '' });
    } catch (err) {
      const message = err.message || String(err);
      setUpload({ busy: false, result: null, error: message });
      bad(message);
    } finally {
      if (uploadRef.current) uploadRef.current.value = '';
    }
  };

  return (
    <PageTransition>
      <Panel
        title="Build from a bulk return"
        actions={(
          <Button variant="secondary" loading={loading} onClick={reload}>
            Refresh facilities
          </Button>
        )}
      >
        <div className="row">
          <Field
            label="Warehouse"
            hint={facilityError || (current ? `Yours: ${current}` : 'Loaded from Unicommerce')}
            error={facilityError ? 'Could not load facilities, refresh to retry.' : undefined}
          >
            <Select
              value={facility}
              disabled={loading && !facilities.length}
              onChange={(e) => setFacility(e.target.value)}
            >
              <option value="">{loading ? 'Loading…' : 'Select a warehouse'}</option>
              {facilities.map((code) => <option key={code} value={code}>{code}</option>)}
            </Select>
          </Field>

          <Field label="Bulk Return ID" hint="One ID, like BR0160">
            <Input
              value={bulkReturnId}
              placeholder="BR0160"
              onChange={(e) => setBulkReturnId(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') build(); }}
            />
          </Field>

          <Button variant="primary" loading={busy} onClick={build}>Build reverse DC</Button>
        </div>

        {formError && <p className="field-error" role="alert">{formError}</p>}
      </Panel>

      <RunSurface
        busy={busy}
        progress={progress}
        error={error}
        result={result}
        idle={<EmptyState icon="⤺" title="No challan yet">Pick a warehouse and enter the Bulk Return ID.</EmptyState>}
      >
        <ResultHead
          ok={result?.ok !== false}
          title={result?.creditNoteNo ? `Credit note ${result.creditNoteNo}` : 'Delivery Challan ready'}
          extra={MODE_LABEL[result?.mode] || result?.mode}
        />
        <KeyValues
          pairs={[
            ['Bulk Return', result?.bulkReturnId],
            ['Warehouse', result?.facility],
            ['Credit note', result?.creditNoteNo],
            ['Lines', result?.lineCount],
          ]}
        />
        <FileResult file={result?.file} label="Download Delivery Challan" />
        <RawDetails data={result} />
      </RunSurface>

      <Panel title="Upload a credit note PDF instead">
        <p className="lead">
          When Unicommerce will not hand over the credit note, a dead session, a return
          raised outside the platform, download the PDF yourself and drop it here.
        </p>
        <div className="row" style={{ marginTop: 'var(--s-5)', marginBottom: 0 }}>
          <Field label="Credit note PDF">
            <input
              ref={uploadRef}
              className="input"
              type="file"
              accept="application/pdf,.pdf"
              disabled={upload.busy}
              onChange={uploadPdf}
            />
          </Field>
          {upload.busy && <Spinner label="Building Delivery Challan" />}
        </div>

        {upload.error && <p className="field-error" role="alert">{upload.error}</p>}

        {upload.result && (
          <div className="run-surface">
            <ResultHead
              ok={upload.result.ok !== false}
              title={upload.result.creditNoteNo ? `Credit note ${upload.result.creditNoteNo}` : 'Delivery Challan ready'}
              extra={MODE_LABEL[upload.result.mode] || upload.result.mode}
            />
            <KeyValues
              pairs={[
                ['Credit note', upload.result.creditNoteNo],
                ['Lines', upload.result.lineCount],
              ]}
            />
            <FileResult file={upload.result.file} label="Download Delivery Challan" />
            <RawDetails data={upload.result} />
          </div>
        )}
      </Panel>
    </PageTransition>
  );
}
