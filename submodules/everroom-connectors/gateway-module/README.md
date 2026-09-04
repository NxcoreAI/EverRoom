# Connector implementation boundaries

EverRoom has two independent connector implementations. Do not share routes,
configuration namespaces, authorization state, or runtime clients between them.

Shared domain projection (intentional): both paths normalize records into the
`connector_*` domain tables in `gateway.sqlite` via `domain-projection.ts`
(unique key `ownerId/service/connectionName/sourceRecordId`, idempotent
upsert). Room read paths query only these tables. Sync state (cursors, leases,
fences) stays isolated per path.

## Nango connector

- HTTP namespace: `/v1/nango-connectors/*`
- EverRoom environment namespace: `NXCORE_NANGO_CONNECTOR_*`
- Desktop IPC namespace: `nango-connector:*`
- Desktop preload API: `window.nxcore.nangoConnector`
- Route entry point: `nangoConnectorRoutes`
- Main implementation: `manager.ts`, `repository.ts`, `nango-*.ts`,
  `sync-providers/*` (provider registry — adding a source means one file plus
  one registry line), `format-mapper-port.ts`, `connector-memory.ts`, and
  `document-store.ts`
- Persistence: the isolated `connectors.sqlite` database for sync state and
  raw normalized records (`connector_records`); projected content lives in the
  shared `connector_*` domain tables in `gateway.sqlite`

The embedded Nango source under `../connector/` uses native `NANGO_*`
variables. Those variables belong to the Nango child process and are not
EverRoom configuration inputs.

## Format mapping (归一化映射体系)

Mail/calendar normalization is no longer code-written per provider. The
built-in `providers/gmail.ts` / `providers/outlook.ts` normalizers were
removed; sync providers call `ctx.normalizeMail(raw)` /
`ctx.normalizeCalendar(raw)` (see `sync-providers/*`) and the engine binds
those to the `FormatMapperPort` (`format-mapper-port.ts`), implemented by the
gateway host (`apps/gateway` `FormatMappingService`).

Data flow:

1. canonical schema: `CanonicalMailSchema` / `CanonicalCalendarEventSchema`
   (in `connector-contract`) formalize the `NormalizedMail` /
   `NormalizedCalendarEvent` contracts. Address roles are a closed enum
   (`CANONICAL_ADDRESS_ROLES`, plus `organizer`/`attendee` for calendar) —
   `domain-projection.ts` `recipientsOf` relies on this convention.
2. first sight of an unknown provider format: the raw record is captured as a
   sample, the run fails with `format_mapping_pending:<service>:<kind>` and
   the cursor does not advance (retry on the next sync tick).
3. a background agent (gateway builtin `connector-mapper`) compares the
   samples against the canonical schema and submits a reusable JSONata mapping
   (`{record?: {field: expr}, isTombstone?: expr, tombstoneId?: expr}`) via
   the `submit_format_mapping` tool; the service replays all captured samples
   through the mapping and ajv-validates against the canonical schema before
   activating it (stored in `gateway.sqlite` `connector_format_mappings`).
4. subsequent syncs take the cached fast path: evaluate the mapping per raw
   record, validate, done — no agent call.

Deletion/cancellation records (Gmail trash, Graph `@removed`, calendar
`status=cancelled`) are expressed by `isTombstone`/`tombstoneId` expressions,
not code. If no agent runtime is configured, affected sources stay pending —
the run error message explains this and sync retries each tick.

## CLI connector (OpenConnector)

- HTTP namespace: `/v1/cli-connectors/*`
- EverRoom environment namespace: `NXCORE_CLI_CONNECTOR_*`
- Desktop IPC namespaces: `cli-connector:*` and `cli-connector-sync:*`
- Desktop preload APIs: `window.nxcore.cliConnector` and
  `window.nxcore.cliConnectorSync`
- Route entry point: `cliConnectorRoutes`
- Main implementation: `service.ts`, `agent-tools.ts`, `pi-tools.ts`,
  `gmail-sync.ts`, `document-sync.ts`, and `markdown-service.ts`
- Persistence: the CLI connector domain tables in `gateway.sqlite` (written
  through the same `domain-projection.ts` semantics as the Nango path)

Only the process-launch boundary may translate `NXCORE_CLI_CONNECTOR_*` into
the `OO_*` variables required by the `oo` CLI. Gateway configuration must not
read `OO_*` directly.
