// Job handlers, as a dependency-injected factory so the api↔worker payload contract
// is unit-testable (the C1 regression: inventory.run read a shape the API never sent).
//
// The contract every job follows: `job.data = { runUid, input }`. `input` is the
// automation's own payload. return.process additionally carries `retryCount` for
// its self-re-enqueue loop.
import { SessionError } from '@opptra/uc-client';

export const RETURN_MAX_PENDING_RETRIES = 40;   // resumable pipeline: ~40 × 90s ≈ 1h of patience
export const RETURN_PENDING_RETRY_MS = 90_000;

/** Pull a short human error out of soft-fail pipeline results so Admin / KPI show why. */
export function summarizeRunError(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.error) return String(result.error);
  if (result.summary && result.ok === false) return String(result.summary);
  const unresolved = result.unresolved;
  if (Array.isArray(unresolved) && unresolved.length) {
    const bits = unresolved.slice(0, 3).map((u) => {
      if (typeof u === 'string') return u;
      return u.reason ? `${u.so || '?'}: ${u.reason}` : String(u.so || u);
    });
    const more = unresolved.length > 3 ? ` (+${unresolved.length - 3} more)` : '';
    return bits.join('; ') + more;
  }
  if (Array.isArray(result.results)) {
    const fails = result.results.filter((r) => r && r.ok === false);
    if (fails.length) {
      const bits = fails.slice(0, 3).map((r) => `${r.so || '?'}: ${r.error || 'failed'}`);
      const more = fails.length > 3 ? ` (+${fails.length - 3} more)` : '';
      return bits.join('; ') + more;
    }
  }
  if (typeof result.failed === 'number' && result.failed > 0 && typeof result.ok === 'number') {
    return `${result.failed} of ${result.ok + result.failed} failed`;
  }
  return null;
}

export function makeHandlers({ uc, pipelines, runs, alert, logger, reenqueue, packingGoogleFor, runUserEmail, packingPipelineFor, unicommerceConnector }) {
  const { markRunning, markPendingRetry, finishRun } = runs;
  const { returnPipeline, ewaybillPipeline, inventoryPipeline, asnPipeline, packingPipeline, sheetPipeline, reverseDcPipeline, homecentrePipeline } = pipelines;

  async function packingPipe(runUid, userEmailHint) {
    const userEmail = runUserEmail
      ? await runUserEmail(runUid, userEmailHint)
      : String(userEmailHint || '').trim().toLowerCase();
    if (packingGoogleFor && packingPipelineFor) {
      const g = await packingGoogleFor(userEmail);
      return packingPipelineFor(userEmail, g);
    }
    return packingPipeline;
  }

  return {
    // Keep-alive: ping UC, record liveness. Death triggers refresh/alert inside uc-client.
    'system.keepalive': async () => {
      const r = await uc.ping();
      logger.info({ alive: r.alive, facility: r.currentFacility || null }, 'uc keepalive');
      return r;
    },

    // Unicommerce connector invoke — capability layer on top of the shared UcClient.
    // Does not replace automations; packing/sheet/e-way/etc. stay on their own jobs.
    'connector.unicommerce.invoke': async ({ data: { runUid, input = {} } }) => {
      await markRunning(runUid);
      if (!unicommerceConnector) throw new Error('unicommerce connector not configured');
      const action = String(input.action || '').trim();
      try {
        const result = await unicommerceConnector.invoke(action, input.params || {}, {
          dryRun: !!input.dryRun,
          runUid,
        });
        const ok = result?.ok !== false;
        await finishRun(runUid, {
          ok,
          result,
          error: ok ? null : (result?.error || summarizeRunError(result) || 'connector action failed'),
        });
        return result;
      } catch (err) {
        if (err instanceof SessionError) {
          const result = { ok: false, action, error: 'session expired' };
          await finishRun(runUid, { ok: false, result, error: result.error });
          return result;
        }
        throw err;
      }
    },

    // E-way bill: generate for a batch of SO rows. Rows are independent - one bad row
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
      const result = { results, ok, failed };
      await finishRun(runUid, {
        ok: failed === 0,
        result,
        error: failed ? summarizeRunError(result) : null,
      });
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
      await finishRun(runUid, {
        ok,
        result,
        error: ok ? null : (result.outwardError || result.error || result.status || 'inventory did not complete'),
      });
      if (!ok) await alert('inventory-partial', `${input.op} did not fully complete`, { runUid, status: result.status, error: result.outwardError });
      return result;
    },

    // ASN compile: SO + channel → one downloadable file (base64 in the run result).
    'asn.compile': async ({ data: { runUid, input } }) => {
      await markRunning(runUid);
      const result = await asnPipeline.compile(input.saleOrder, input.channel);
      await finishRun(runUid, { ok: result.ok, result, error: result.error || summarizeRunError(result) });
      return result;
    },

    // Reverse DC: Bulk Return ID + facility → CN download → clean Delivery Challan PDF.
    'reversedc.build': async ({ data: { runUid, input } }) => {
      await markRunning(runUid);
      if (!reverseDcPipeline) throw new Error('reverse DC pipeline not configured');
      const result = await reverseDcPipeline.buildFromBulkReturn({
        bulkReturnId: input.bulkReturnId,
        facility: input.facility,
      });
      await finishRun(runUid, { ok: result.ok !== false, result, error: result.error || summarizeRunError(result) });
      return result;
    },

    // Live facility list for the Reverse DC warehouse dropdown.
    'uc.facilities': async ({ data: { runUid } }) => {
      await markRunning(runUid);
      if (!reverseDcPipeline) throw new Error('reverse DC pipeline not configured');
      const result = await reverseDcPipeline.listFacilities();
      await finishRun(runUid, { ok: result.ok !== false, result, error: result.error || summarizeRunError(result) });
      return result;
    },

    // Packing mail: SO list → warehouse groups + To/CC options from the email sheet.
    'packing.preview': async ({ data: { runUid, input, userEmail } }) => {
      await markRunning(runUid);
      const pipe = await packingPipe(runUid, userEmail);
      const result = await pipe.previewGroups(input.saleOrders || []);
      await finishRun(runUid, { ok: result.ok !== false, result, error: result.error || summarizeRunError(result) });
      return result;
    },

    // Packing mail: SO list → per-warehouse Gmail drafts in the operator's mailbox.
    'packing.createDrafts': async ({ data: { runUid, input, userEmail } }) => {
      await markRunning(runUid);
      const pipe = await packingPipe(runUid, userEmail);
      const result = await pipe.createDrafts(input.saleOrders || [], { recipients: input.recipients || {} });
      await finishRun(runUid, { ok: result.ok, result, error: result.error || summarizeRunError(result) });
      return result;
    },

    // Packing mail follow-up: invoice + e-way bill DRAFT into the same thread (not sent).
    'packing.sendInvoiceEway': async ({ data: { runUid, input, userEmail } }) => {
      await markRunning(runUid);
      const pipe = await packingPipe(runUid, userEmail);
      const result = await pipe.sendInvoiceEway(input.saleOrders || [], { recipients: input.recipients || {} });
      await finishRun(runUid, { ok: result.ok, result, error: result.error || summarizeRunError(result) });
      return result;
    },

    // Packing mail: dispatch a draft the operator has already reviewed in Gmail.
    'packing.sendDraft': async ({ data: { runUid, input, userEmail } }) => {
      await markRunning(runUid);
      const pipe = await packingPipe(runUid, userEmail);
      const result = await pipe.sendDraft(input.draftId);
      await finishRun(runUid, { ok: result.ok, result, error: result.error || summarizeRunError(result) });
      return result;
    },

    // Sheet update (A1): first-fill / second-fill / push / sync-source.
    'sheet.run': async ({ data: { runUid, input } }) => {
      await markRunning(runUid);
      const fn = { 'first-fill': sheetPipeline.firstFill, 'second-fill': sheetPipeline.secondFill, push: sheetPipeline.push, 'sync-source': sheetPipeline.syncFromSource }[input.action];
      if (!fn) throw new Error(`unknown sheet action: ${input.action}`);
      const result = await fn(input); // both fills read input.saleOrders; push/sync ignore it
      await finishRun(runUid, { ok: result.ok, result, error: result.error || summarizeRunError(result) });
      return result;
    },

    // Scheduled source sync (no run row - a background cron, logged only). When Master is
    // an IMPORTRANGE mirror it keeps itself current, so there is genuinely nothing to do -
    // that is a healthy state, not an hourly failure to log as one.
    'sheet.syncSource': async () => {
      const result = await sheetPipeline.syncFromSource();
      if (result.mirror) {
        logger.info({ ok: true }, 'scheduled source sync skipped - Master is a self-refreshing IMPORTRANGE mirror');
        return { ok: true, skipped: 'master-is-mirror' };
      }
      logger.info({ ok: result.ok, summary: result.summary || result.error }, 'scheduled source sync');
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
    'return.process': async ({ data: { runUid, input, retryCount = 0, allocated = false } }) => {
      await markRunning(runUid);
      const out = await returnPipeline.processSO(input.saleOrder, {
        cancelSO: input.cancelSO || '',
        awbFromSO: input.awbFromSO || '',
        returnIn: !!input.returnIn,
        deliver: input.deliver !== false,
        allocated, // don't re-fire allocate on a retry (see pipeline C2 guard)
      });

      if (out.pending) {
        if (retryCount >= RETURN_MAX_PENDING_RETRIES) {
          await finishRun(runUid, { ok: false, result: out, error: `still pending after ${retryCount} retries, needs a human look` });
          await alert('return-stuck', `Return pipeline stuck on ${input.saleOrder}`, { runUid, steps: JSON.stringify(out.steps) });
          return out;
        }
        await markPendingRetry(runUid, out);
        // Carry the allocate-fired flag forward so the next attempt never re-allocates.
        await reenqueue('return.process',
          { runUid, input, retryCount: retryCount + 1, allocated: allocated || !!out.allocated },
          { delay: RETURN_PENDING_RETRY_MS });
        logger.info({ so: input.saleOrder, retryCount }, 'return pipeline pending - re-enqueued');
        return out;
      }

      await finishRun(runUid, { ok: out.ok, result: out, error: out.error || null });
      if (!out.ok) await alert('return-failed', `Return pipeline FAILED on ${input.saleOrder}`, { runUid, error: out.error });
      return out;
    },

    // Home Centre: Vinculum orders → UC B2C SO punch (customer + saleOrder only). Manual only.
    'homecentre.sync': async ({ data: { runUid, input = {} } }) => {
      if (runUid) await markRunning(runUid);
      if (!homecentrePipeline) {
        const result = {
          ok: true,
          empty: true,
          configured: false,
          processed: 0,
          message: 'Home Centre ready (manual). Set VINCULUM_USER + VINCULUM_PASS to list/punch orders. No orders expected yet.',
        };
        if (runUid) await finishRun(runUid, { ok: true, result });
        return result;
      }
      const result = await homecentrePipeline.syncOrders({
        dryRun: !!input.dryRun,
        limit: input.limit || 50,
        source: input.source || 'active',
        buyerByOrder: input.buyerByOrder || {},
      });
      if (runUid) await finishRun(runUid, { ok: result.ok !== false, result, error: result.error || null });
      // Never Slack-alert on empty list or dry-run
      if (result.failed && !result.dryRun && result.processed > 0) {
        await alert('homecentre-sync', `Home Centre sync: ${result.failed} of ${result.processed} failed`, { runUid });
      }
      return result;
    },

    // Home Centre: Vinculum confirm / ship / label (needs VINCULUM_FULFILL_ACTIONS_JSON).
    'homecentre.fulfill': async ({ data: { runUid, input = {} } }) => {
      if (runUid) await markRunning(runUid);
      if (!homecentrePipeline) {
        const result = { ok: true, empty: true, configured: false, processed: 0, message: 'Vinculum not configured — fulfill skipped' };
        if (runUid) await finishRun(runUid, { ok: true, result });
        return result;
      }
      const result = await homecentrePipeline.fulfillOrders({
        dryRun: !!input.dryRun,
        limit: input.limit || 20,
        webOrderNos: input.webOrderNos || null,
      });
      if (runUid) await finishRun(runUid, { ok: result.ok !== false, result });
      return result;
    },

    // Agent Beta playbook replay (daily or manual). Runs saved tool steps via the same
    // catalog executor the chat uses — Sheets/Drive/UC/Waypoint/Home Centre only.
    'agent.playbook.run': async ({ data = {} }) => {
      const playbookUid = data.playbookUid;
      if (!playbookUid) return { ok: false, error: 'playbookUid required' };
      const {
        getAgentPlaybook, markPlaybookRun, listConnectorStates, createRun,
      } = await import('@opptra/core');
      const { makeToolExecutor, buildConnectorStatus } = await import('../../api/src/agent/catalog.js');

      const pb = await getAgentPlaybook({ playbookUid });
      if (!pb) return { ok: false, error: 'playbook not found' };
      if (pb.status === 'archived') return { ok: false, error: 'playbook archived' };

      const def = typeof pb.definition === 'string' ? JSON.parse(pb.definition) : (pb.definition || {});
      const steps = Array.isArray(def.steps) ? def.steps.slice(0, 20) : [];
      if (!steps.length) {
        await markPlaybookRun(playbookUid, { ok: false, error: 'no steps' });
        return { ok: false, error: 'playbook has no steps' };
      }

      const prefs = await listConnectorStates(pb.user_email);
      const connectors = await buildConnectorStatus(prefs);
      const connectedIds = connectors.filter((c) => c.connected && c.live).map((c) => c.id);
      const executeTool = makeToolExecutor({ userEmail: pb.user_email, connectedIds });

      const run = await createRun({
        userEmail: pb.user_email || 'system',
        automation: 'agent-playbook',
        action: 'run',
        input: { playbookUid, steps: steps.map((s) => s.tool) },
      });
      await markRunning(run.run_uid);

      const results = [];
      let ok = true;
      for (const step of steps) {
        const tool = String(step.tool || step.name || '').trim();
        if (!tool) continue;
        try {
          const r = await executeTool(tool, step.args || {});
          const stepOk = r?.ok !== false;
          if (!stepOk) ok = false;
          results.push({ tool, ok: stepOk, result: r });
          if (!stepOk && step.stopOnError !== false) break;
        } catch (err) {
          ok = false;
          results.push({ tool, ok: false, error: String(err.message || err) });
          break;
        }
      }

      const error = ok ? null : (results.find((r) => !r.ok)?.error || results.find((r) => !r.ok)?.result?.error || 'playbook step failed');
      await finishRun(run.run_uid, { ok, result: { playbookUid, title: pb.title, results }, error });
      await markPlaybookRun(playbookUid, { ok, error });
      logger.info({ playbookUid, ok, steps: results.length }, 'agent playbook run finished');
      return { ok, playbookUid, results };
    },
  };
}
