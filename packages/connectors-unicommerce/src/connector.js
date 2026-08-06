import {
  register,
  getAction,
  listRegisteredActions,
  validateActionParams,
} from './registry.js';
import {
  registerAuthActions,
  registerFacilityActions,
  registerOrderActions,
  registerOrderDetailActions,
  registerInventoryActions,
  registerShipmentSearchActions,
  registerChannelActions,
  registerReturnActions,
} from './actions.js';
import { registerReportActions } from './actionsReports.js';
import {
  registerAllocationActions,
  registerInvoiceDispatchActions,
  registerManifestActions,
  registerReturnMutateActions,
  registerInventoryMutateActions,
  registerOrderMutateActions,
} from './actionsMutate.js';

export const CONNECTOR_ID = 'unicommerce';
export const CONNECTOR_NAME = 'Unicommerce';

let builtinsRegistered = false;

function ensureBuiltins() {
  if (builtinsRegistered) return;
  registerAuthActions(register);
  registerFacilityActions(register);
  registerOrderActions(register);
  registerOrderDetailActions(register);
  registerInventoryActions(register);
  registerShipmentSearchActions(register);
  registerChannelActions(register);
  registerReturnActions(register);
  registerReportActions(register);
  registerAllocationActions(register);
  registerInvoiceDispatchActions(register);
  registerManifestActions(register);
  registerReturnMutateActions(register);
  registerInventoryMutateActions(register);
  registerOrderMutateActions(register);
  builtinsRegistered = true;
}

/**
 * RE-native Unicommerce connector. Reuses the shared UcClient session vault —
 * do not construct a parallel cookie store.
 *
 * @param {{ uc: object, logger?: { warn?: Function, error?: Function } }} opts
 */
export function createUnicommerceConnector({ uc, logger } = {}) {
  if (!uc) throw new Error('createUnicommerceConnector requires { uc }');
  ensureBuiltins();

  const log = logger || { warn() {}, error() {} };

  return {
    id: CONNECTOR_ID,
    name: CONNECTOR_NAME,
    auth: {
      kind: 'dual',
      primary: 'session', // Session/RE primary; bearer used where already proven
      officialFutureSwap: false, // public REST already present; not a gate
    },

    listCapabilities() {
      return listRegisteredActions().map((a) => ({
        id: a.id,
        title: a.title,
        mutates: a.mutates,
        backend: a.backend,
        description: a.description,
        inputSchema: a.inputSchema,
      }));
    },

    /** Live dual-layer probe. Must run in the worker (only UC-talking process). */
    async health() {
      try {
        const r = await uc.ping();
        return {
          ok: !!r.alive,
          connector: CONNECTOR_ID,
          session: {
            alive: !!r.alive,
            currentFacility: r.currentFacility || null,
            reason: r.reason || null,
          },
          // Never attach cookie / token material.
        };
      } catch (err) {
        log.error?.({ err: String(err.message || err) }, 'unicommerce health failed');
        return { ok: false, connector: CONNECTOR_ID, error: String(err.message || err) };
      }
    },

    /**
     * @param {string} action
     * @param {object} params
     * @param {{ dryRun?: boolean, runUid?: string }} [ctx]
     */
    async invoke(action, params = {}, ctx = {}) {
      const def = getAction(action);
      if (!def) {
        return { ok: false, code: 'UNKNOWN_ACTION', retryable: false, error: `unknown action: ${action}` };
      }
      // Enforce the declared inputSchema before anything reaches Unicommerce. The HTTP
      // invoke route cannot do this — it does not know which action is being called when
      // its own body schema is compiled.
      const valid = validateActionParams(action, params || {});
      if (!valid.ok) {
        return {
          ok: false,
          code: 'INVALID_INPUT',
          retryable: false,
          action,
          error: `invalid params for ${action}: ${valid.errors.join('; ')}`,
          validationErrors: valid.errors,
        };
      }
      if (def.mutates && ctx.dryRun) {
        return {
          ok: true,
          dryRun: true,
          action,
          preview: { params, note: 'mutating action not executed (dryRun)' },
        };
      }
      return def.handler(uc, params || {}, ctx);
    },
  };
}
