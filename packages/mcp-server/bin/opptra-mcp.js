#!/usr/bin/env node
// Opptra SCM MCP server, stdio transport.
//
//   claude mcp add opptra -- node packages/mcp-server/bin/opptra-mcp.js \
//     --url https://scm.opptra.com --token <personal-access-token>
//
// Or via env: OPPTRA_URL / OPPTRA_TOKEN. Tokens come from Admin → Access tokens.
// Messages are newline-delimited JSON-RPC 2.0 (the MCP stdio framing). Logs go to
// stderr only, a single stray stdout write corrupts the protocol stream.
import { createInterface } from 'node:readline';
import { createMcpHandler } from '../src/handler.js';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const baseUrl = argValue('--url') || process.env.OPPTRA_URL || '';
const token = argValue('--token') || process.env.OPPTRA_TOKEN || '';

if (!baseUrl || !token) {
  console.error('opptra-mcp: need --url/--token (or OPPTRA_URL/OPPTRA_TOKEN). Create a token in Admin → Access tokens.');
  process.exit(2);
}

const handler = createMcpHandler({ baseUrl, token });

const rl = createInterface({ input: process.stdin, terminal: false });

// One-at-a-time dispatch keeps response order deterministic; MCP clients pipeline
// rarely and the platform API is the real latency anyway.
let chain = Promise.resolve();

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  chain = chain.then(async () => {
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
      return;
    }
    const res = await handler.handle(msg);
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
  }).catch((err) => {
    console.error('opptra-mcp: unexpected error:', err);
  });
});

rl.on('close', () => process.exit(0));
