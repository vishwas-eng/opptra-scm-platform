import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler } from '../src/handler.js';

const TOOLS_PAYLOAD = {
  ok: true,
  user: 'ops@opptra.com',
  connectedIds: ['unicommerce'],
  tools: [
    { name: 'unicommerce_sale_order_summary', description: 'Get sale order summary', parameters: { type: 'object', properties: { saleOrder: { type: 'string' } }, required: ['saleOrder'] }, mutates: false },
    { name: 'sheets_write', description: 'Write values', parameters: { type: 'object' }, mutates: true },
  ],
};

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const route = routes[new URL(url).pathname];
    if (!route) return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
    const { status = 200, body } = typeof route === 'function' ? route(init) : route;
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  impl.calls = calls;
  return impl;
}

function makeHandler(routes) {
  const fetchImpl = fakeFetch(routes);
  const h = createMcpHandler({ baseUrl: 'https://scm.example.com/', token: 'tok123', fetchImpl });
  return { h, fetchImpl };
}

test('constructor refuses to start half-configured', () => {
  assert.throws(() => createMcpHandler({ token: 'x' }), /baseUrl/);
  assert.throws(() => createMcpHandler({ baseUrl: 'https://x' }), /token/);
});

test('initialize echoes the client protocol version and declares tools capability', async () => {
  const { h } = makeHandler({});
  const res = await h.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(res.result.protocolVersion, '2024-11-05');
  assert.deepEqual(res.result.capabilities, { tools: { listChanged: false } });
  assert.equal(res.result.serverInfo.name, 'opptra-scm');
});

test('notifications produce no response', async () => {
  const { h } = makeHandler({});
  assert.equal(await h.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await h.handle({ jsonrpc: '2.0', method: 'notifications/unknown-future-thing' }), null);
});

test('tools/list maps platform specs to MCP shape with read/write annotations', async () => {
  const { h, fetchImpl } = makeHandler({ '/api/mcp/tools': { body: TOOLS_PAYLOAD } });
  const res = await h.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const [so, write] = res.result.tools;
  assert.equal(so.name, 'unicommerce_sale_order_summary');
  assert.deepEqual(so.inputSchema.required, ['saleOrder']);
  assert.equal(so.annotations.readOnlyHint, true);
  assert.equal(write.annotations.destructiveHint, true);
  // Auth header must ride every call, trailing slash on baseUrl must not double up.
  assert.equal(fetchImpl.calls[0].url, 'https://scm.example.com/api/mcp/tools');
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer tok123');
});

test('tools/call posts to the platform and wraps the result as text content', async () => {
  const { h, fetchImpl } = makeHandler({
    '/api/mcp/call': (init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.tool, 'unicommerce_sale_order_summary');
      assert.deepEqual(body.args, { saleOrder: 'SO02696' });
      return { body: { ok: true, tool: body.tool, result: { ok: true, status: 'DISPATCHED' } } };
    },
  });
  const res = await h.handle({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'unicommerce_sale_order_summary', arguments: { saleOrder: 'SO02696' } },
  });
  assert.equal(res.result.isError, false);
  assert.match(res.result.content[0].text, /DISPATCHED/);
  assert.equal(fetchImpl.calls[0].init.method, 'POST');
});

test('a failing tool comes back as isError content the model can read, not a protocol error', async () => {
  const { h } = makeHandler({
    '/api/mcp/call': { status: 404, body: { ok: false, error: 'unknown tool: nope' } },
  });
  const res = await h.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /unknown tool/);
  assert.equal(res.error, undefined);
});

test('platform failure on tools/list is a JSON-RPC error (no tools is not an answer)', async () => {
  const { h } = makeHandler({ '/api/mcp/tools': { status: 401, body: { error: 'invalid or revoked access token' } } });
  const res = await h.handle({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
  assert.equal(res.error.code, -32603);
  assert.match(res.error.message, /revoked/);
});

test('protocol misuse gets the standard JSON-RPC codes', async () => {
  const { h } = makeHandler({});
  assert.equal((await h.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} })).error.code, -32602);
  assert.equal((await h.handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' })).error.code, -32601);
  assert.equal((await h.handle({ jsonrpc: '1.0', id: 8, method: 'ping' })).error.code, -32600);
});

test('ping answers with an empty result', async () => {
  const { h } = makeHandler({});
  assert.deepEqual((await h.handle({ jsonrpc: '2.0', id: 9, method: 'ping' })).result, {});
});
