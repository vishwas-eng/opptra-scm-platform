// Job handlers, as a dependency-injected factory so the api↔worker payload contract
// is unit-testable (the C1 regression: inventory.run read a shape the API never sent).
//
// The contract every job follows: `job.data = { runUid, input }`. `input` is the
// automation's own payload. return.process additionally carries `retryCount` for
// its self-re-enqueue loop.
import { SessionError } from '@opptra/uc-client';

export const RETURN_MAX_PENDING_RETRIES = 40;   // resumable pipeline: ~40 × 90s ≈ 1h of patience
export const RETURN_PENDING_RETRY_MS = 90_000;

export function makeHandlers({ uc, pipelines, runs, alert, logger, reenqueue }) {
  const { markRunning, markPendingRetry, finishRun } = runs;
  const { returnPipeline, ewaybillPipeline, inventoryPipeline } = pipelines;

  return {
    // Keep-alive: ping UC, record liveness. Death triggers refresh/alert inside uc-client.
    'system.keepalive': async () => {
      const r = await uc.ping();
      logger.info({ alive: r.alive, facility: r.currentFacility || null }, 'uc keepalive');
      return r;
    },

    // E-way bill: generate for a batch of SO rows. Rows are independent — one bad row
    // (bad GSTIN, not invoiced) fails only itself. Session death stops the batch.
    'ewaybill.generate': async ({ data: { runUid, input } }) => {
      await markRunning(runUid);
      const rows = input.rows || [];
      const results = [];
      for (let i = 0; i < rows.length; i++) {
        try {
          results.push(await ewaybillPipeline.generateOne(rows[i], { dryRun: !!input.dryRun }));
        } catch (err) {
          if (err instanceof SessionError) {
            results.push({ so: rows[i].so, ok: false, error: 'session expired' });
            for (const r of rows.slice(i + 1)) results.push({ so: r.so, ok: false, error: 'skipped (session expired)' });
            break;
          }
          results.push({ so: rows[i].so, ok: false, error: String(err.message || err) });
        }
      }
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;
      await finishRun(runUid, { ok: failed === 0, result: { results, ok, failed } });
      if (failed) await alert('ewaybill-failures', `E-way bill: ${failed} of ${results.length} failed`, { runUid });
      return { results, ok, failed };
    },

    // Inward / Outward / Full-cycle. Idempotent per reqId (memoStep) so a retry resumes.
    'inventory.run': async ({ data: { runUid, input } }) => {
      await markRunning(runUid);
      const form = { ...input.form, reqId: input.reqId };
      const run = {
        inward: () => inventoryPipeline.runInward(form),
        outward: () => inventoryPipeline.runOutward(form),
        fullcycle: () => inventoryPipeline.runFullCycle(form),
      }[input.op];
      if (!run) throw new Error(`unknown inventory op: ${input.op}`);
      const result = await run();
      const ok = ['INWARD_DONE', 'OUTWARD_DONE', 'FULLCYCLE_DONE'].includes(result.status);
      await finishRun(runUid, { ok, result });
      if (!ok) await alert('inventory-partial', `${input.op} did not fully complete`, { runUid, status: result.status, error: result.outwardError });
      return result;
    },

    // Read-only SO status probe for the UI.
    'uc.soStatus': async ({ data: { runUid, input } }) => {
      await markRunning(runUid);
      const st = await returnPipeline.state(input.saleOrder);
      await finishRun(runUid, { ok: true, result: st });
      return st;
    },

    // The return + re-dispatch pipeline. Resumable: pending results re-enqueue themselves.
    'return.process': async ({ data: { runUid, input, retryCount = 0 } }) => {
      await markRunning(runUid);
      const out = await returnPipeline.processSO(input.saleOrder, {
        cancelSO: input.cancelSO || '',
        awbFromSO: input.awbFromSO || '',
        returnIn: !!input.returnIn,
        deliver: input.deliver !== false,
      });

      if (out.pending) {
        if (retryCount >= RETURN_MAX_PENDING_RETRIES) {
          await finishRun(runUid, { ok: false, result: out, error: `still pending after ${retryCount} retries — needs a human look` });
          await alert('return-stuck', `Return pipeline stuck on ${input.saleOrder}`, { runUid, steps: JSON.stringify(out.steps) });
          return out;
        }
        await markPendingRetry(runUid, out);
        await reenqueue('return.process', { runUid, input, retryCount: retryCount + 1 }, { delay: RETURN_PENDING_RETRY_MS });
        logger.info({ so: input.saleOrder, retryCount }, 'return pipeline pending — re-enqueued');
        return out;
      }

      await finishRun(runUid, { ok: out.ok, result: out, error: out.error || null });
      if (!out.ok) await alert('return-failed', `Return pipeline FAILED on ${input.saleOrder}`, { runUid, error: out.error });
      return out;
    },
  };
}
