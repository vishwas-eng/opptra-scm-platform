import { motion } from 'framer-motion';
import { useState } from 'react';

/** Human-readable tool name: `unicommerce_sale_order_summary` → "Unicommerce · sale order summary". */
function prettyName(name) {
  const raw = String(name || '');
  const [head, ...rest] = raw.split('_');
  if (!rest.length) return raw;
  const connector = head.replace(/^\w/, (c) => c.toUpperCase());
  return `${connector} · ${rest.join(' ')}`;
}

/** One-line summary of what came back, so the common case needs no expanding. */
function summarize(result) {
  if (!result || typeof result !== 'object') return null;
  const rows = ['rows', 'orders', 'items', 'files', 'results', 'threads', 'shipments']
    .map((k) => (Array.isArray(result[k]) ? { k, n: result[k].length } : null))
    .find(Boolean);
  if (rows) return `${rows.n} ${rows.k}`;
  if (result.count != null) return `${result.count} results`;
  if (result.alive != null) return result.alive ? 'session alive' : 'session down';
  if (result.status) return String(result.status);
  return null;
}

export default function ToolCall({ call, live = false }) {
  const [open, setOpen] = useState(false);
  const running = live && call.status === 'running';
  const failed = call.status === 'error';
  const payload = failed ? (call.error ?? call.result) : call.result;
  const summary = failed ? call.error : summarize(call.result);

  return (
    <motion.div
      className={`tool-call${failed ? ' tool-failed' : ''}${running ? ' tool-running' : ''}`}
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      layout
    >
      <button type="button" className="tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`tool-dot${running ? ' spin' : ''}`} aria-hidden="true" />
        <span className="tool-name">{prettyName(call.name)}</span>
        {summary && <span className="tool-summary">{String(summary).slice(0, 70)}</span>}
        <span className="tool-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <motion.div
          className="tool-body"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          {!!call.args && Object.keys(call.args).length > 0 && (
            <pre className="output tool-args">{JSON.stringify(call.args, null, 2)}</pre>
          )}
          <pre className="output">{
            typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}, null, 2)
          }</pre>
        </motion.div>
      )}
    </motion.div>
  );
}
