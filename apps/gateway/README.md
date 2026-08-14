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
