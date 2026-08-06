import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef } from 'react';
import './live-log.css';

const MARK = { done: '✓', running: '•', failed: '×' };

/**
 * Live feed of what a job is doing, one line per step as the worker reports it.
 *
 * "Running" then "Completed" tells an operator nothing about a job that takes a
 * minute, and worse, it looks identical whether the job did the work or skipped it.
 * Each step animates in as it arrives so the screen reads as progress rather than a
 * result that appeared from nowhere.
 */
export default function LiveLog({ steps = [], busy = false, outcome = null }) {
  const endRef = useRef(null);

  // Follow the newest line, the way a terminal does.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [steps.length, outcome]);

  if (!steps.length && !busy && !outcome) return null;

  return (
    <div className="live-log">
      <ol className="log-lines">
        <AnimatePresence initial={false}>
          {steps.map((s, i) => (
            <motion.li
              key={`${s.step}-${s.state}-${i}`}
              className={`log-line log-${s.state}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              layout
            >
              <span className="log-mark" aria-hidden="true">{MARK[s.state] || MARK.done}</span>
              <span className="log-text">{s.step}</span>
              {s.detail && <span className="log-detail">{s.detail}</span>}
              {s.at && (
                <span className="log-time">
                  {new Date(s.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              )}
            </motion.li>
          ))}
        </AnimatePresence>

        {busy && (
          <motion.li
            className="log-line log-running log-pending"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <span className="log-mark" aria-hidden="true">{MARK.running}</span>
            <span className="log-text">
              working<i />
              <i />
              <i />
            </span>
          </motion.li>
        )}
        <li ref={endRef} aria-hidden="true" />
      </ol>

      <AnimatePresence>
        {outcome && (
          <motion.div
            className={`log-outcome ${outcome.ok ? 'good' : 'bad'}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <strong>{outcome.title}</strong>
            {outcome.summary && <span>{outcome.summary}</span>}
            {outcome.hint && <span className="log-hint">{outcome.hint}</span>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
