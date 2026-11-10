# NxCore Gateway

Local-first backend gateway for the OpenNxCore desktop application. The gateway is a standalone Node.js service supervised by Electron in production.

## Development

```bash
pnpm install
pnpm db:generate
pnpm dev -- --data-dir .data --port 3210 --token local-development-token
```

The API documentation is available at `http://127.0.0.1:3210/docs`. Health endpoints do not require authentication; all other endpoints require `Authorization: Bearer <token>`.

When the gateway is ready it writes `<data-dir>/runtime/gateway.json`. Electron can wait for this file to discover the selected port and authentication token. Consumers must verify the manifest PID and health endpoint because an ungraceful process termination can leave stale runtime state.

Structured JSON logs are written to daily files under `<data-dir>/logs/` using
the name `gateway.YYYY-MM-DD.N.log`. The active file is rolled at midnight and
30 historical files are retained. Console logs use readable local timestamps.

In production Electron should generate a fresh high-entropy token, start the gateway with `--port 0 --token <token>`, and wait for the runtime manifest before loading application data.

## Checks

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Connectors and Agent retrieval

Connectors are agent tools, not a sync pipeline. The gateway does not poll,
persist, normalize or project provider content; the OpenConnector (oo) runtime
holds credentials and executes actions, and the gateway exposes them to the
agent over MCP.

- **MCP relay**: the gateway starts a loopback MCP endpoint
  (`/mcp/connectors/<token>`, token-in-path) and injects it into user-facing
  agent runtimes. It exposes oo's `list_apps`, `list_connections`,
  `search_actions`, `get_action_guide`, `execute_action` plus local
  `connector_query` / `connector_read`.
- **Query layer**: `connector_query` resolves connections from oo, applies each
  provider's query profile, fans out read-only actions and returns hits with a
  coverage report; `connector_read` opens a hit's full content by ref.
- **Read-only guard**: `execute_action` rejects mutation actions in this
  version. Mutations will move behind explicit approval.
- **Connection lifecycle**: connections are listed live from oo. The gateway
  stores only `connector_tombstones` (connections the user disconnected
  locally); there is no `connectors.sqlite` and no connector content tables.
- **Configuration**: `NXCORE_CLI_CONNECTOR_URL`, `NXCORE_CLI_CONNECTOR_RUNTIME_TOKEN`
  and (local mode only) `NXCORE_CLI_CONNECTOR_ADMIN_TOKEN` are pushed by the
  desktop. `PUT /v1/connector-session` hot-applies a session without a restart.
- **Routes**: `/v1/nango-connectors/status|providers|connections` and the
  authorization endpoints are current; sync-era endpoints answer `410 Gone`.
