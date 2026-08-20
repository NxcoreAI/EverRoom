# Connector implementation boundaries

EverRoom has two independent connector implementations. Do not share routes,
configuration namespaces, authorization state, or runtime clients between them.

## Nango connector

- HTTP namespace: `/v1/nango-connectors/*`
- EverRoom environment namespace: `NXCORE_NANGO_CONNECTOR_*`
- Desktop IPC namespace: `nango-connector:*`
- Desktop preload API: `window.nxcore.nangoConnector`
- Route entry point: `nangoConnectorRoutes`
- Main implementation: `manager.ts`, `repository.ts`, `nango-*.ts`,
  `providers/*`, `connector-memory.ts`, and `document-store.ts`
- Persistence: the isolated `connectors.sqlite` database

The embedded Nango source under `../connector/` uses native `NANGO_*`
variables. Those variables belong to the Nango child process and are not
EverRoom configuration inputs.

## CLI connector (OpenConnector)

- HTTP namespace: `/v1/cli-connectors/*`
- EverRoom environment namespace: `NXCORE_CLI_CONNECTOR_*`
- Desktop IPC namespaces: `cli-connector:*` and `cli-connector-sync:*`
- Desktop preload APIs: `window.nxcore.cliConnector` and
  `window.nxcore.cliConnectorSync`
- Route entry point: `cliConnectorRoutes`
- Main implementation: `service.ts`, `agent-tools.ts`, `pi-tools.ts`,
  `gmail-sync.ts`, `document-sync.ts`, and `markdown-service.ts`
- Persistence: the CLI connector domain tables in `gateway.sqlite`

Only the process-launch boundary may translate `NXCORE_CLI_CONNECTOR_*` into
the `OO_*` variables required by the `oo` CLI. Gateway configuration must not
read `OO_*` directly.
