# Using the platform from Claude Code / Cursor (MCP)

Every connector the platform exposes is also available as MCP tools in any MCP-capable
editor. The editor runs a thin stdio bridge (`packages/mcp-server`); **all execution
happens on the deployed platform** — same session vault, same worker queue, same
sanitization, same per-user audit trail as the web app's Agent chat. A revoked token or
deactivated user loses MCP access instantly.

```
Claude Code / Cursor ──stdio──▶ opptra-mcp (bridge) ──HTTPS──▶ /api/mcp/* ──▶ connector registry
                                                                    │             worker queue (UC)
                                                                    └── runs / audit / sanitize
```

## 1. Get a personal access token

Admin tab → **Access tokens** (`POST /api/admin/ingest-tokens`) → copy the token
(shown once). Tokens are hashed at rest and revocable per user; every MCP call is
audited as the token's owner.

## 2. Claude Code

```bash
claude mcp add opptra -- node <repo>/packages/mcp-server/bin/opptra-mcp.js \
  --url https://<your-platform-host> --token <personal-access-token>
```

Or with env vars instead of flags (keeps the token out of shell history):

```bash
OPPTRA_URL=https://<host> OPPTRA_TOKEN=<token> claude mcp add opptra -- node <repo>/packages/mcp-server/bin/opptra-mcp.js
```

## 3. Cursor

`.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` globally):

```json
{
  "mcpServers": {
    "opptra": {
      "command": "node",
      "args": ["<repo>/packages/mcp-server/bin/opptra-mcp.js"],
      "env": {
        "OPPTRA_URL": "https://<your-platform-host>",
        "OPPTRA_TOKEN": "<personal-access-token>"
      }
    }
  }
}
```

## What you get

`tools/list` returns exactly the tools the token's owner is connected to on the
Connectors page — Unicommerce (orders, inventory, shipments, invoices), Google
Sheets/Drive, Waypoint, Home Centre, and every channel that goes live later. No
per-editor work is ever needed when a new connector ships: connect it once on the
Connectors page and it appears in `tools/list` everywhere.

Mutating tools carry `annotations.destructiveHint: true` so editors can ask before
running them.

## Endpoints (server side)

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/mcp/tools` | Bearer PAT | Tool specs for the token's owner (connected live connectors only) |
| `POST /api/mcp/call` | Bearer PAT | Execute one tool; result is `sanitizeResult`-scrubbed; audited `mcp-tool-call` |

## Troubleshooting

- `invalid or revoked access token` — regenerate in Admin → Access tokens.
- `token owner is not an active user` — the user row was deactivated.
- Empty tool list — that user has nothing connected on the Connectors page.
- The bridge logs to **stderr** only; if an editor shows protocol errors, check that
  nothing else on the machine wraps `node` with stdout noise (nvm echo, etc.).
