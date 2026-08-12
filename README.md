# NexCore CE

Local-first personal context workspace for macOS.

## Current scope

The desktop app includes the first local data-source workflow:

- Connect a local folder through the macOS folder picker.
- Scan PDF, DOCX, PPTX, XLSX, Markdown, text, and common image files.
- Track additions, content updates, moves, missing files, and file versions.
- Watch connected folders and periodically verify them so changes are discovered automatically.
- Expand a source in the desktop UI to inspect its files, change state, original path, and location in Finder.
- Store metadata in SQLite (WAL mode) and deduplicated file copies by SHA-256.
- Pause, resume, rescan, disconnect, or disconnect and remove local copies.

Application data is stored under `~/Library/Application Support/JiheCore/`.
The renderer never receives direct filesystem or database access. File parsing,
OCR, embeddings, memory extraction, and Context Room aggregation are outside
this connector milestone.

## Development

```bash
pnpm install
pnpm dev
```

## Build

```bash
pnpm build
pnpm package:mac
```
