import { createRegistry, createConnectorShell, connectorError, CONNECTOR_ERROR_CODES } from '@opptra/connectors-sdk';
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

const REGISTRARS = [
  registerAuthActions,
  registerFacilityActions,
  registerOrderActions,
  registerOrderDetailActions,
  registerInventoryActions,
  registerShipmentSearchActions,
  registerChannelActions,
  registerReturnActions,
  registerReportActions,
  registerAllocationActions,
  registerInvoiceDispatchActions,
  registerManifestActions,
  registerReturnMutateActions,
  registerInventoryMutateActions,
  registerOrderMutateActions,
];

/**
 * Build a registry holding every UC action, bound to one UcClient.
 *
 * Action handlers are authored as `(uc, params, ctx)` because they are transport-shaped;
 * the shared shell calls `(params, ctx)`. The bind happens here, once per connector
 * instance, which is also what lets two instances (india / uae) coexist in one process, * the previous module-level singleton plus `builtinsRegistered` latch made that
 * impossible and silently handed the second tenant the first tenant's client.
 */
export function buildUnicommerceRegistry(uc) {
  const registry = createRegistry();
  const register = (def) => registry.register({
    ...def,
    handler: (params, ctx) => def.handler(uc, params, ctx),
  });
  for (const registrar of REGISTRARS) registrar(register);
  return registry;
}

/** Action metadata with no client attached, for docs, catalogs and MCP tool listings. */
export function listUnicommerceActions() {
  return buildUnicommerceRegistry(null).listRegisteredActions();
}

/**
 * RE-native Unicommerce connector. Reuses the shared UcClient session vault, * do not construct a parallel cookie store.
 *
 * @param {{ uc: object, logger?: { warn?: Function, error?: Function } }} opts
 */
export function createUnicommerceConnector({ uc, logger } = {}) {
  if (!uc) throw new Error('createUnicommerceConnector requires { uc }');

  const log = logger || { warn() {}, error() {} };
  const registry = buildUnicommerceRegistry(uc);

  return createConnectorShell({
    id: CONNECTOR_ID,
    name: CONNECTOR_NAME,
    auth: {
      kind: 'dual',
      primary: 'session', // Session/RE primary; bearer used where already proven
      officialFutureSwap: false, // public REST already present; not a gate
    },
    registry,

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
        return connectorError(CONNECTOR_ERROR_CODES.UPSTREAM_ERROR, String(err.message || err), {
          connector: CONNECTOR_ID,
        });
      }
    },
  });
}
