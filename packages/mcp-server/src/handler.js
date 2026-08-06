// MCP (Model Context Protocol) message handler, the editor side of the bridge.
//
// Claude Code / Cursor speak JSON-RPC 2.0 over stdio to this process; every tool is
// fetched from and executed by the deployed platform API (apps/api/src/routes/mcp.js),
// so sessions, rate limits, sanitization and audit all stay server-side. This file is
// transport-free and takes fetch as a dependency, so tests drive it without a server.
//
// Protocol subset implemented: initialize, notifications/initialized, ping, tools/list,
// tools/call. That is the whole surface a tools-only MCP server needs.

const SERVER_INFO = { name: 'opptra-scm', version: '0.1.0' };
// Newest revision we know; if the client asks for something else we echo their version,
// as the spec instructs servers to answer with a version they both support.
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

export function createMcpHandler({ baseUrl, token, fetchImpl = fetch } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('createMcpHandler requires baseUrl');
  if (!token) throw new Error('createMcpHandler requires token');

  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };

  async function api(path, init = {}) {
    const res = await fetchImpl(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 500) }; }
    if (!res.ok) {
      const msg = body?.error || `platform API ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  function rpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
  }

  function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  /**
   * Handle one decoded JSON-RPC message.
   * @returns {Promise<object|null>} response message, or null for notifications
   */
  async function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0') {
      return rpcError(msg?.id ?? null, -32600, 'invalid request');
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    try {
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion;
          return rpcResult(id, {
            protocolVersion: typeof requested === 'string' && requested ? requested : DEFAULT_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: 'Opptra SCM platform tools. Every call runs on the platform under your own user, is audited, and returns sanitized results.',
          });
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          return rpcResult(id, {});
        case 'tools/list': {
          const { tools } = await api('/api/mcp/tools');
          return rpcResult(id, {
            tools: (tools || []).map((t) => ({
              name: t.name,
              description: t.description || '',
              inputSchema: t.parameters || { type: 'object' },
              annotations: {
                readOnlyHint: !t.mutates,
                destructiveHint: !!t.mutates,
              },
            })),
          });
        }
        case 'tools/call': {
          const name = params?.name;
          const args = params?.arguments || {};
          if (!name) return rpcError(id, -32602, 'tools/call requires params.name');
          let body;
          try {
            body = await api('/api/mcp/call', { method: 'POST', body: JSON.stringify({ tool: name, args }) });
          } catch (err) {
            // Tool-level failures travel INSIDE the result (isError) so the model can
            // read them and adjust; only protocol misuse becomes a JSON-RPC error.
            return rpcResult(id, {
              content: [{ type: 'text', text: `Error: ${err.message}` }],
              isError: true,
            });
          }
          return rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(body.result ?? body, null, 2) }],
            isError: body.ok === false,
          });
        }
        default:
          if (isNotification) return null; // unknown notifications are ignored per spec
          return rpcError(id, -32601, `method not found: ${method}`);
      }
    } catch (err) {
      if (isNotification) return null;
      return rpcError(id, -32603, String(err.message || err));
    }
  }

  return { handle };
}
