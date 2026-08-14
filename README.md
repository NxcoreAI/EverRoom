# Everroom

Local-first personal context workspace for macOS.

## Runtime architecture

The Electron main process supervises a standalone NxCore Gateway from
`apps/gateway`. On startup Electron generates an ephemeral bearer token, starts
the gateway on a random loopback port, validates its runtime manifest and ready
endpoint, and only then creates the desktop window. Closing the application
also stops the gateway and removes its runtime manifest.

The gateway owns the standard HTTP backend boundary and will host Agent
services. Existing Connector and Evidence code remains in the Electron main
process until those modules are migrated deliberately.

## Current scope

The desktop app includes the first local data-source workflow:

- Connect a local folder through the macOS folder picker.
- Scan PDF, DOCX, PPTX, XLSX, Markdown, text, and common image files.
- Track additions, content updates, moves, missing files, and file versions.
- Watch connected folders and periodically verify them so changes are discovered automatically.
- Expand a source in the desktop UI to inspect its files, change state, original path, and location in Finder.
- Store metadata in SQLite (WAL mode) and deduplicated file copies by SHA-256.
- Pause, resume, rescan, disconnect, or disconnect and remove local copies.

Data ingestion uses a shared Connector contract. The local-folder implementation
only discovers items and reports changes; the Core Service owns hashing, object
storage, source versions, sync runs, and lifecycle state. Future web page,
GitHub, and Feishu connectors use the same boundary.

Markdown and plain-text versions are parsed locally into Evidence blocks with
heading ancestry, line and character positions, content hashes, and parent-child
relationships. Parsing status is tracked per source version, and SQLite FTS5
search returns current-version evidence that can be opened at its source lines.

Application data is stored under `~/Library/Application Support/NxCore/`.
The renderer never receives direct filesystem or database access. File parsing,
OCR, embeddings, memory extraction, and Context Room aggregation are outside
this connector milestone.

## Development

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts Electron, which supervises the gateway in `tsx watch` mode.
Changes to gateway TypeScript restart the backend automatically on the stable
development port `3210`. Gateway logs are prefixed with `[gateway]` in the
development terminal and persisted to
`~/Library/Application Support/NxCore/logs/gateway.YYYY-MM-DD.N.log`. Logs roll
at midnight and 30 historical files are retained.

## Build

```bash
pnpm build
pnpm package:mac
```
