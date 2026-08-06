import { motion } from 'framer-motion';
import { forwardRef } from 'react';
import './ui.css';

/* --------------------------------- Button --------------------------------- */

export const Button = forwardRef(function Button(
  { variant = 'secondary', loading = false, disabled, children, className = '', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={`btn btn-${variant}${loading ? ' is-loading' : ''} ${className}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {/* The label stays in the DOM while loading so the button keeps its width, a button that resizes mid-click moves everything next to it. */}
      <span className="btn-label">{children}</span>
      {loading && <span className="btn-spinner" aria-hidden="true" />}
    </button>
  );
});

/* --------------------------------- Panels --------------------------------- */

export function Panel({ title, actions, children, className = '', ...rest }) {
  return (
    <section className={`panel ${className}`.trim()} {...rest}>
      {(title || actions) && (
        <header className="panel-head">
          {title && <h3>{title}</h3>}
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** Page-entry animation. One place, so every screen enters identically. */
export function PageTransition({ children }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

/* --------------------------------- Fields --------------------------------- */

export function Field({ label, hint, error, children, wide = false }) {
  return (
    <label className={`field${wide ? ' field-wide' : ''}`}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export const Input = forwardRef(function Input({ className = '', ...rest }, ref) {
  return <input ref={ref} className={`input ${className}`.trim()} {...rest} />;
});

export const Textarea = forwardRef(function Textarea({ className = '', ...rest }, ref) {
  return <textarea ref={ref} className={`textarea ${className}`.trim()} {...rest} />;
});

export const Select = forwardRef(function Select({ className = '', children, ...rest }, ref) {
  return <select ref={ref} className={`select ${className}`.trim()} {...rest}>{children}</select>;
});

export function Checkbox({ label, className = '', ...rest }) {
  return (
    <label className={`checkbox ${className}`.trim()}>
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
}

/* --------------------------------- Status --------------------------------- */

export function Badge({ tone = 'neutral', children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function StatusPill({ status, children }) {
  return <span className={`status-pill status-${status}`}>{children}</span>;
}

export function Dot({ tone = 'idle' }) {
  return <span className={`dot dot-${tone}`} aria-hidden="true" />;
}

/* --------------------------------- Data --------------------------------- */

export function KeyValues({ pairs }) {
  const rows = (pairs || []).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!rows.length) return null;
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DataTable({ columns, rows, empty = 'Nothing yet', rowKey }) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>{columns.map((c) => <th key={c.key} style={c.width ? { width: c.width } : undefined}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td className="table-empty" colSpan={columns.length}>{empty}</td></tr>
          ) : rows.map((row, i) => (
            <tr key={rowKey ? rowKey(row, i) : i}>
              {columns.map((c) => <td key={c.key}>{c.render ? c.render(row, i) : row[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EmptyState({ icon = '◇', title, children }) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden="true">{icon}</div>
      <h4>{title}</h4>
      {children && <p className="meta">{children}</p>}
    </div>
  );
}

export function Spinner({ label = 'Loading' }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

/** Skeleton row for first paint, better than a spinner because it shows the shape. */
export function Skeleton({ w = '100%', h = 14, style }) {
  return <span className="skeleton" style={{ width: w, height: h, ...style }} aria-hidden="true" />;
}
