import { AnimatePresence, motion } from 'framer-motion';
import { useAuth } from '../lib/auth.jsx';
import { withoutBase64 } from '../lib/format.js';
import { useObjectUrl } from '../lib/useRun.js';
import { Badge, KeyValues } from './ui.jsx';
import './run-result.css';

/** Header line every automation result opens with. */
export function ResultHead({ ok, title, extra }) {
  return (
    <div className="result-head">
      <Badge tone={ok === false ? 'bad' : ok === true ? 'ok' : 'neutral'}>
        {ok === false ? 'Failed' : ok === true ? 'Success' : 'Done'}
      </Badge>
      <span className="result-title">{title}</span>
      {extra && <span className="meta">{extra}</span>}
    </div>
  );
}

/** Pipeline steps as chips: `{ allocate: 'ok', invoice: 'INV-2231' }`. */
export function StepChips({ steps }) {
  const entries = Object.entries(steps || {});
  if (!entries.length) return null;
  return (
    <div className="steps-flow">
      {entries.map(([name, detail], i) => (
        <motion.span
          key={name}
          className="step-chip"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.04, duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
        >
          <span className="step-name">{name}</span>
          {detail && detail !== 'ok' && (
            <span className="step-detail">{String(detail).slice(0, 28)}</span>
          )}
        </motion.span>
      ))}
    </div>
  );
}

/**
 * A generated file: inline preview plus a real download anchor.
 * The anchor is deliberately an <a download>, not a scripted click, so right-click →
 * Save As and open-in-new-tab both behave normally.
 */
export function FileResult({ file, label }) {
  const url = useObjectUrl(file);
  if (!file || !url) return null;
  const type = file.contentType || '';
  return (
    <div className="file-result">
      {type.includes('pdf') && <iframe className="file-preview" src={url} title={file.filename} />}
      {type.startsWith('image/') && <img className="file-preview" src={url} alt={file.filename} />}
      <a className="btn btn-primary btn-sm dl-btn" href={url} download={file.filename}>
        ↓ {label || file.filename}
      </a>
    </div>
  );
}

/** Raw payload, admin-only, operators should never need to read JSON. */
export function RawDetails({ data }) {
  const { isAdmin } = useAuth();
  if (!isAdmin || !data) return null;
  return (
    <details className="raw-details">
      <summary>Technical details</summary>
      <pre className="output">{JSON.stringify(withoutBase64(data), null, 2)}</pre>
    </details>
  );
}

/**
 * Standard result surface for an automation screen: busy state (with the real run
 * status, so a retry reads as a retry), error, then the caller's rendering.
 */
export function RunSurface({ busy, progress, error, result, children, idle }) {
  return (
    <AnimatePresence mode="wait">
      {busy ? (
        <motion.div
          key="busy"
          className="run-surface run-busy"
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
        >
          <span className="spinner" />
          <div>
            <strong>{progress?.status === 'pending_retry' ? 'Retrying automatically' : 'Working…'}</strong>
            <p className="meta">
              {progress?.status === 'pending_retry'
                ? 'This is taking longer than usual, the job is being retried, no action needed.'
                : 'This can take a minute for large orders.'}
            </p>
            {progress?.result?.steps && <StepChips steps={progress.result.steps} />}
          </div>
        </motion.div>
      ) : error ? (
        <motion.div
          key="error"
          className="run-surface run-error"
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
        >
          <ResultHead ok={false} title={error} />
          <RawDetails data={result} />
        </motion.div>
      ) : result ? (
        <motion.div
          key="result"
          className="run-surface"
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
        >
          {children}
        </motion.div>
      ) : idle ? (
        <motion.div key="idle" className="run-surface run-idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          {idle}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export { KeyValues };
