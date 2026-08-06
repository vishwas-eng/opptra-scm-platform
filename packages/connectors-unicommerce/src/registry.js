// Action registry: HAR-discovered endpoints become one register() call.
// Capability ids stay stable when an official-API handler later replaces the RE one.
//
// `inputSchema` is ENFORCED, not documentation. It used to be read only by
// listCapabilities() for display, which meant the HTTP invoke route — whose body schema
// is just `params: { type: 'object' }` — accepted anything: a 50 000-entry `skus` array
// went straight to UC's public REST on the tenant's bearer, and an arbitrary `facility`
// string could re-pin the shared, session-global facility for every job that followed.
import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, coerceTypes: false, strict: false });

const actions = new Map();

/**
 * @param {{
 *   id: string,
 *   title: string,
 *   mutates?: boolean,
 *   backend?: 're' | 'official',
 *   description?: string,
 *   inputSchema?: object,
 *   handler: (uc: object, params: object, ctx: object) => Promise<object>,
 * }} def
 */
export function register(def) {
  if (!def?.id || typeof def.handler !== 'function') {
    throw new Error('register() requires id and handler');
  }
  if (actions.has(def.id)) {
    throw new Error(`duplicate action id: ${def.id}`);
  }
  const inputSchema = def.inputSchema || { type: 'object' };
  actions.set(def.id, {
    id: def.id,
    title: def.title || def.id,
    mutates: !!def.mutates,
    backend: def.backend || 're',
    description: def.description || '',
    inputSchema,
    // Compile once at registration: a schema that cannot compile is a developer error
    // and should blow up at boot, not silently skip validation on a live call.
    validate: ajv.compile(inputSchema),
    handler: def.handler,
  });
}

/**
 * Validate params against an action's inputSchema.
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function validateActionParams(id, params) {
  const def = actions.get(id);
  if (!def) return { ok: false, errors: [`unknown action: ${id}`] };
  if (def.validate(params ?? {})) return { ok: true };
  const errors = (def.validate.errors || [])
    .slice(0, 8)
    .map((e) => `params${e.instancePath || ''} ${e.message}`);
  return { ok: false, errors };
}

export function getAction(id) {
  return actions.get(id) || null;
}

export function listRegisteredActions() {
  return [...actions.values()].map(({ handler, validate, ...meta }) => meta);
}

/** Test helper — clear registry between suites if needed. */
export function _resetRegistryForTests() {
  actions.clear();
}
