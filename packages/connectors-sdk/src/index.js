/** Shared action registry + connector shell used by marketplace packages. */

export function createRegistry() {
  const actions = new Map();
  return {
    register(def) {
      if (!def?.id || typeof def.handler !== 'function') throw new Error('register() requires id and handler');
      if (actions.has(def.id)) throw new Error(`duplicate action id: ${def.id}`);
      actions.set(def.id, {
        id: def.id,
        title: def.title || def.id,
        mutates: !!def.mutates,
        backend: def.backend || 're',
        description: def.description || '',
        inputSchema: def.inputSchema || { type: 'object' },
        awaitingHar: !!def.awaitingHar,
        handler: def.handler,
      });
    },
    getAction(id) { return actions.get(id) || null; },
    listRegisteredActions() {
      return [...actions.values()].map(({ handler, ...meta }) => meta);
    },
    _reset() { actions.clear(); },
  };
}

/**
 * Build a standard connector object.
 * @param {{ id, name, auth, registry, health?, beforeInvoke? }} opts
 */
export function createConnectorShell({ id, name, auth, registry, health, beforeInvoke }) {
  return {
    id,
    name,
    auth,
    listCapabilities() {
      return registry.listRegisteredActions().map((a) => ({
        id: a.id,
        title: a.title,
        mutates: a.mutates,
        backend: a.backend,
        description: a.description,
        inputSchema: a.inputSchema,
        awaitingHar: a.awaitingHar,
      }));
    },
    async health() {
      if (typeof health === 'function') return health();
      return { ok: false, connector: id, error: 'health not implemented' };
    },
    async invoke(action, params = {}, ctx = {}) {
      if (beforeInvoke) await beforeInvoke(action, params, ctx);
      const def = registry.getAction(action);
      if (!def) return { ok: false, error: `unknown action: ${action}` };
      if (def.awaitingHar && !ctx.allowStub) {
        return {
          ok: false,
          awaitingHar: true,
          action,
          error: `${name}: action '${action}' needs a sanitized HAR / live session. Paste session in Connectors panel or see docs/connectors/.`,
        };
      }
      if (def.mutates && ctx.dryRun) {
        return { ok: true, dryRun: true, action, preview: { params } };
      }
      return def.handler(params || {}, ctx);
    },
  };
}

/** Truncate for agent tool results — never include cookie/token-looking keys. */
export function sanitizeResult(obj, max = 4000) {
  const scrub = (v) => {
    if (v == null) return v;
    if (Array.isArray(v)) return v.slice(0, 50).map(scrub);
    if (typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (/cookie|jsession|password|secret|token|authorization|refresh/i.test(k)) {
          out[k] = '[redacted]';
        } else out[k] = scrub(val);
      }
      return out;
    }
    return v;
  };
  const cleaned = scrub(obj);
  const s = JSON.stringify(cleaned);
  if (s && s.length > max) return { truncated: true, preview: s.slice(0, max) };
  return cleaned;
}
