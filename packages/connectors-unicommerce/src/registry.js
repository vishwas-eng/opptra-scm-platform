// Action registry: HAR-discovered endpoints become one register() call.
// Capability ids stay stable when an official-API handler later replaces the RE one.

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
  actions.set(def.id, {
    id: def.id,
    title: def.title || def.id,
    mutates: !!def.mutates,
    backend: def.backend || 're',
    description: def.description || '',
    inputSchema: def.inputSchema || { type: 'object' },
    handler: def.handler,
  });
}

export function getAction(id) {
  return actions.get(id) || null;
}

export function listRegisteredActions() {
  return [...actions.values()].map(({ handler, ...meta }) => meta);
}

/** Test helper — clear registry between suites if needed. */
export function _resetRegistryForTests() {
  actions.clear();
}
