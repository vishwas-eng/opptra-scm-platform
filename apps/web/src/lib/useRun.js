import { useCallback, useEffect, useRef, useState } from 'react';
import { runJob } from './api.js';
import { fileToObjectUrl } from './format.js';

/**
 * Run one automation and track it to completion.
 *
 * Every automation screen has the same lifecycle, validate, submit, poll, render, * so it lives here once. `progress` carries the intermediate run row, which is what
 * lets a screen say "retrying" instead of showing a spinner that looks like a hang.
 */
export function useRun() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const abort = useRef(null);

  // A screen the user navigated away from must not keep polling, and must not call
  // setState after unmount.
  useEffect(() => () => abort.current?.abort(), []);

  const start = useCallback(async (path, body) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setBusy(true);
    setError(null);
    setResult(null);
    setProgress(null);
    try {
      const run = await runJob(path, body, {
        signal: controller.signal,
        onProgress: setProgress,
      });
      if (controller.signal.aborted) return null;
      const payload = run.result ?? run;
      if (run.status === 'failed') {
        setError(run.error || payload?.error || 'The run failed.');
        setResult(payload);
      } else {
        setResult(payload);
      }
      return payload;
    } catch (err) {
      if (!controller.signal.aborted) setError(err.message || String(err));
      return null;
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        setProgress(null);
      }
    }
  }, []);

  const reset = useCallback(() => {
    setResult(null); setError(null); setProgress(null);
  }, []);

  return { busy, progress, result, error, start, reset, setError };
}

/**
 * Turn a `{ filename, contentType, base64 }` payload into an object URL, revoking the
 * previous one whenever the file changes and on unmount. Skipping the revoke leaks the
 * whole blob for the life of the tab, and these are multi-megabyte PDFs.
 */
export function useObjectUrl(file) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!file?.base64) { setUrl(null); return undefined; }
    const next = fileToObjectUrl(file);
    setUrl(next);
    return () => { if (next) URL.revokeObjectURL(next); };
  }, [file]);
  return url;
}

/** Poll an endpoint on an interval, pausing when the tab is hidden. */
export function usePolling(fn, ms, deps = []) {
  const saved = useRef(fn);
  useEffect(() => { saved.current = fn; }, [fn]);
  useEffect(() => {
    let alive = true;
    const tick = () => {
      // Polling a background tab burns the user's battery and our rate limits for
      // updates nobody is looking at.
      if (document.visibilityState === 'visible' && alive) saved.current();
    };
    tick();
    const t = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}
