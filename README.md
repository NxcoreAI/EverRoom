<div align="center">

<img src="./everroom_logo/everroom_full.png" width="320" alt="EverRoom">

**A local-first workspace for producing Office documents with a governed AI Agent.**

Draft with an Agent · Review every change · Export real Office files

[English](./README.md) | [简体中文](./README.zh-CN.md) | [Website](https://r.nxcore.ai/)

[![Star History Rank](https://api.star-history.com/badge?repo=NxcoreAI/EverRoom&type=rank)](https://www.star-history.com/nxcoreai/everroom)
<a href="https://trendshift.io/repositories/178463?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-178463" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/178463/daily?language=TypeScript" alt="NxcoreAI%2FEverRoom | Trendshift" width="250" height="50"/></a>

![Stars](https://img.shields.io/github/stars/NxcoreAI/EverRoom?style=flat&label=stars)
![Version](https://img.shields.io/github/package-json/v/NxcoreAI/EverRoom?filename=apps%2Fdesktop%2Fpackage.json&label=version)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)

</div>

> [!IMPORTANT]
> Everroom is under active development. macOS is the current development target. APIs, storage schemas, and agent contracts may change while the first complete local workflow is being finished.

## What is Everroom?

Everroom is a local-first desktop workspace for producing real Office documents with an AI Agent. Bring in the local files, repositories, and connected services that matter, then create and edit Word documents, spreadsheets, and slide decks — yourself in the built-in Office editor, or through Agent sessions that draft, rewrite, and fill them in.

The Agent is not a chat box bolted onto a file store. It works inside explicit sessions and runs, receives only the tools and documents needed for the current request, and proposes document changes as reviewable operations. You decide what lands in the file.

> **Let the Agent do the drafting; keep the final say.**

### The product loop

1. **Bring in your material** from local files and folders, repositories, and connected services such as Feishu, Slack, Notion, or Gmail.
2. **Produce Office artifacts.** Create Word documents, spreadsheets, and slide decks in the built-in Office editor, or let an Agent draft them.
3. **Review every change.** Agent writes and edits arrive as patches and document operations you can inspect before they become part of the document.
4. **Keep work moving.** Scoped Agent sessions, scheduled runs, dispatch-only subagents, and notifications carry recurring and long-running work.

## Why Everroom exists

AI agents are good at producing a useful next step when they have the right material and a real place to put it. The hard part is everything around that moment: getting source material in, producing a file colleagues can actually open, and keeping automated edits reviewable instead of letting them silently rewrite your document.

Everroom is built around that gap. It is a local workspace for documents, files, and connected services, with an Agent that works on real Office artifacts. It is not another chat client, a thin RAG screen, or an automation that quietly accumulates unreviewed output.

The product thesis is simple:

> **Agent work should land in real documents, stay scoped to the task, and remain reviewable by the person who owns the file.**

Four principles follow from it:

- **Local-first.** Data, documents, indexes, and credentials stay on the user's device by default.
- **Review before it lands.** Agent edits are proposed as operations and patches, not silent overwrites.
- **Automated, but governable.** Agents receive explicit, temporary, and revocable tool permissions.
- **Replaceable foundations.** Models, connectors, and agent runtimes all plug in through Everroom's own interfaces.

A generated draft is useful only when a person can inspect what changed, correct it, and let the correction flow into the next task.

## Product model

| Concept | Product role | What it protects |
| --- | --- | --- |
| **Documents** | Word documents, spreadsheets, and slide decks with versioned, block-aware editing | Human ownership of the final artifact |
| **Agent** | A scoped worker with explicit tools, sessions, runs, and cancellation | Automation that can be inspected, stopped, and replaced |
| **Sources** | Local files, folders, and repositories brought into one library; connectors are queried live by the Agent | A single place for the material an Agent may read |
| **Connectors** | On-demand external retrieval through OpenConnector MCP; no periodic sync or local content copies | External data reached with the user's credentials, never stored by Everroom |
| **Schedules** | Recurring Agent runs and dispatch-only subagents | Long-running work that stays visible and interruptible |

Original files and parsed Markdown have one storage owner: documents and Agent runs keep stable references, hashes, and provenance instead of copying the same source into several places.

### How an Agent session works

An Agent does not edit documents by remote control. It works through the same commit path a person does:

1. A session is scoped to a workspace, a tool set, and the documents in play.
2. Document writes and edits are opened as explicit operations or patches against the versioned document.
3. Proposed hunks appear in the editor for review, and you accept or reject them.
4. Accepted changes commit through the document kernel, producing a new version with its operation history.
5. Focused jobs can be dispatched to subagents, which report their own invocation timeline and can be cancelled.

### Product boundaries

Everroom is deliberately narrow: no autonomous multi-agent swarm, no enterprise administration, and no mandatory cloud synchronization. The focus is trustworthy local document work with an Agent you can review.

## Current state

The main branch now contains the Office + Agent surface. Some features require optional local services or model credentials; the desktop can still start with the isolated development runtime.

| Area | Status | Available today |
| --- | --- | --- |
| Desktop workspace | Available | Electron + React workspace with Home, Documents, Sources, Files, Office, Schedules, Agent connections, and Settings |
| Local Gateway | Available | Fastify 5 service supervised by Electron, REST/WebSocket/OpenAPI boundary, health and readiness checks |
| Office documents | Available, evolving | Word documents, spreadsheets, and slide decks with a built-in editor, versioned commits, reviewable Agent patches, and PDF export |
| Files and import | Available, evolving | Local file browser, folder and Obsidian import, Markdown/text and Office/web normalization, content hashes, provenance, and Finder "Open With" for Word/Excel/PowerPoint files |
| Agent sessions | Available | Persistent sessions, runs, streaming events, cancellation, and scoped document and file tools |
| Agent work management | Available, evolving | Agent Office presence, scheduled runs, dispatch-only subagents, notifications, and explicit run-now controls |
| Connectors | Foundation available | Agent just-in-time retrieval through the OpenConnector MCP bridge (Gmail, Notion, Drive, Calendar, Outlook, Slack); no background sync |

### Open Word, Excel, and PowerPoint files from Finder

The desktop build registers EverRoom as an alternate handler for `.docx`, `.doc`, `.xlsx`, `.xls`, `.pptx`, and `.ppt`. Right-click a document in Finder and pick **Open With → EverRoom** (or make it the default opener for that type). EverRoom imports the file into the local library and opens it in the embedded Office editor — `.docx`, `.xlsx`, `.xlsm`, and `.pptx` are editable. Saving writes the edited bytes back to the original file on disk (so Word, WPS, or Keynote see the change too) and records a new version of that library entry. The file also shows up in the Files page from then on.

> Dev builds register themselves the first time `pnpm dev` starts the branded Electron app. If Finder still does not list EverRoom, restart the dev app once more so LaunchServices picks up the updated bundle.

## Quick start

### Prerequisites

- macOS (current development target)
- Node.js 22 or newer
- pnpm 11.15.1 or a compatible pnpm 11 release

### Run the desktop app

```bash
git clone https://github.com/NxcoreAI/Everroom.git
cd Everroom
pnpm install
pnpm dev
```

`pnpm dev` starts Electron and the renderer. Electron supervises the Gateway in watch mode on a loopback port and restarts it when Gateway TypeScript changes. The sidebar displays the current Gateway state and process ID.

### Run with a real Agent model

The default runtime is `fake`, so the app can open without model credentials. To use the built-in Pi runtime, add the following to the development environment:

```dotenv
NXCORE_AGENT_RUNTIME=pi
NXCORE_AI_PROVIDER=openai
NXCORE_AI_MODEL=gpt-5.2
NXCORE_AI_BASE_URL=https://api.openai.com/v1
NXCORE_AI_API_KEY=
NXCORE_AI_API=openai-responses
```

The same boundary can target compatible OpenAI-style providers. Keep credentials in the Gateway environment; they are never sent to the renderer.

Generative model calls in the Gateway are resolved through `AgentResolver` using stable Agent IDs. Primary chat, connector retrieval, Cursor Completion, document subagents, and Web Search each use independent runtime and workspace directories. Business modules do not call model APIs directly.

NxCore Gateway also exposes the bearer-protected `/v1/mcp/documents/:sessionId` Streamable HTTP MCP endpoint for authenticated clients.

<details>
<summary><b>File-driven subagents</b></summary>

Subagents can be dispatched only by the primary Agent or internal Gateway workflows. They do not expose independent chat entry points. Gateway scans the repository-root `agents` directory by default; builds copy it into `dist/agents` for Desktop packaging. Development and tests can override the location:

```dotenv
NXCORE_SUBAGENTS_ENABLED=true
NXCORE_SUBAGENTS_DIR=/absolute/path/to/everroom-agents
```

Each first-level directory represents one Agent and contains an `agent.yaml`, its system prompt, and optional skills. MCP servers reference names already configured in Settings, and `includeTools` must explicitly limit the tools visible to that Agent. Gateway creates an immutable revision when definitions change, so running invocations continue on their original revision.

Every `SKILL.md` requires `name` and `description` YAML frontmatter. Subagents can read only their own skill snapshot through the restricted `read` tool, not arbitrary workspace or device files. See [`docs/subagent-framework-design.zh-CN.md`](./docs/subagent-framework-design.zh-CN.md) for the full schema and policy model.

</details>

### Useful commands

```bash
pnpm dev          # Start the desktop app and Gateway
pnpm typecheck    # Type-check every workspace package
pnpm test         # Run Agent runtime and Gateway tests
pnpm build        # Build Gateway and Electron
pnpm package:mac  # Create macOS DMG and ZIP artifacts
pnpm package:win  # Create the Windows x64 NSIS installer
```

<details>
<summary><b>Building the Windows installer</b></summary>

`pnpm package:win` runs the same chain as the macOS build — Gateway, OpenConnector, oo CLI, GenOffice runtimes (including the Rust `xlsx-sidecar.exe`), packaged environment, then `electron-builder --win nsis --x64`. Prerequisites:

- Node 22 and the pnpm version pinned in `packageManager` (`corepack enable`)
- The Rust toolchain (`cargo`) for the GenOffice xlsx sidecar
- `git submodule update --init --recursive` (GenOffice)
- The packaged-environment variables listed in `apps/desktop/scripts/generate-packaged-env.mjs`; for local test builds use placeholder values, never production secrets

The unsigned installer is written to `release/EverRoom-<version>-windows-x64.exe`. Verify it without installing by running `pnpm --filter @nxcore/desktop exec node scripts/verify-windows-package.mjs`. For scripted installs, run the NSIS installer with `/S` (silent) and `/D=<dir>` to pick the target directory. Because the build is unsigned, Microsoft Defender SmartScreen may show a warning before the first launch.

</details>

## Architecture

Everroom keeps the product boundary stable while allowing the underlying engines to change. The desktop owns lifecycle and trust boundaries; the Gateway owns local orchestration and persistence; connectors and Agent runtimes sit behind their own contracts.

### The implementation strategy

- **One asset, many references.** Original files and parsed Markdown have one storage owner. Documents and Agent runs keep stable references, hashes, and provenance instead of duplicating the source.
- **Scoped context.** An Agent receives only the documents, files, and tools needed for the current request, not a global unbounded corpus.
- **Commit before side effects.** Document edits go through a transactional commit core and outbox, so an external service failure cannot corrupt the document.
- **Deterministic external actions.** Connector retrieval is prepared against real action schemas and real connections before execution. Tokens remain in trusted processes; this version only allows read-only actions, and mutations will require explicit approval.
- **Graceful degradation.** The fake Agent runtime, unavailable connectors, and model failures have explicit fallback states. A missing optional service should not make local documents inaccessible.

### Technology stack

| Layer | Technology |
| --- | --- |
| Desktop | Electron 39, React, TypeScript, electron-vite |
| Gateway | Node.js 22+, Fastify 5, TypeBox, REST, WebSocket, OpenAPI |
| Storage | SQLite WAL, better-sqlite3, Drizzle ORM, FTS5, content-addressed objects |
| Documents | Tiptap document model, versioned commits, block references, operation kernel |
| Office output | Bundled GenOffice runtimes for docx, xlsx, and pptx generation |
| Agent boundary | Shared Agent contracts, Pi runtime adapter, MCP document endpoint |
| Connectors | OpenConnector MCP bridge, `oo` HTTP client, per-provider query profiles |
| Observability | Pino structured logs, readable console output, rotating daily JSON files |
| Verification | Vitest, strict TypeScript checks, Gateway and runtime integration tests |

## Gateway and local data

During desktop development, Electron discovers the Gateway through its runtime manifest. The port is dynamic by default so multiple local instances do not collide. Set `NXCORE_GATEWAY_DEV_PORT` only when you need a stable development port:

- API base URL: `http://127.0.0.1:<discovered-port>`
- OpenAPI UI: `http://127.0.0.1:<discovered-port>/docs`
- Liveness: `GET /v1/health/live`
- Readiness: `GET /v1/health/ready`

Health and API documentation routes are public on the loopback listener. Other routes require the ephemeral bearer token generated by Electron. Gateway can also run independently:

```bash
pnpm --dir apps/gateway dev -- \
  --data-dir .data \
  --port 4100 \
  --token local-development-token
```

For a fixed desktop development port, use `NXCORE_GATEWAY_DEV_PORT=4100 pnpm dev`.

On macOS, runtime data is stored under:

```text
~/Library/Application Support/NxCore/
├── database/   # Gateway and document databases
├── logs/       # Daily Gateway JSON logs
├── objects/    # Content-addressed source and parsed objects
├── runtime/    # Ephemeral Gateway discovery manifest
└── open-connector/  # Managed connector runtime and CLI data
```

On Windows, the same layout lives under `%APPDATA%\EverRoom\` (that is `C:\Users\<user>\AppData\Roaming\EverRoom\`). Set `NXCORE_DATA_DIR` to relocate it.

See [`apps/gateway/README.md`](./apps/gateway/README.md) for standalone Gateway details. The OpenConnector lifecycle and security boundary are documented in [`docs/open-connector-desktop-integration.zh-CN.md`](./docs/open-connector-desktop-integration.zh-CN.md).

## Security and privacy model

- Data, documents, indexes, and credentials stay on the user's device by default.
- The Gateway listens on loopback and uses a fresh high-entropy token for each desktop session.
- The renderer receives typed preload APIs only; filesystem, database, provider tokens, and connector credentials stay in trusted processes.
- Original sources are versioned and content-addressed, and document history records every accepted operation.
- Cloud providers, remote models, and external Agents are opt-in. Everroom should send only the approved document or task scope.
- Credentials and sensitive headers are redacted from logs. Managed connector configuration files use restricted permissions.
- External side effects are separated from read-only context gathering and are intended to pass through explicit preparation and approval boundaries.

## Repository layout

```text
Everroom/
├── apps/
│   ├── desktop/          # Electron main, preload, and React renderer
│   └── gateway/          # Standalone local backend service and modules
├── packages/
│   ├── agent-contract/   # Shared Agent protocol and event types
│   ├── agent-runtime/    # Runtime interface and development adapter
│   ├── agent-runtime-pi/ # Pi runtime adapter and Agent tools
│   ├── document-model/   # Pure document normalization and block references
│   └── reality-contract/ # Shared protocol and event types
├── submodules/
│   └── everroom-connectors/  # Connector contract, gateway module, and desktop host
└── docs/                 # Product, architecture, and implementation notes
```

## Roadmap

The next milestones are about making the loop more dependable and portable, rather than adding more surfaces:

1. Deepen Office production: richer Word, spreadsheet, and slide generation, template fidelity, and reliable export.
2. Improve review: clearer patch review, conflict handling, and operation recovery for Agent edits.
3. Expand the file and import experience across local folders, GitHub, Feishu, web content, and connector records.
4. Make Agent sessions more dependable: long-running runs, subagent handoffs, schedules, and notifications.
5. Expand replaceable Agent adapters beyond Pi, including Codex, Claude Code, and OpenCode integrations where their contracts permit.
6. Expand bidirectional desktop/mobile sync and remote Agent control while keeping local permission boundaries explicit.
7. Improve Windows support, privacy exclusions, installation, and release reliability.

Autonomous multi-agent swarms, enterprise administration, and mandatory cloud synchronization remain outside the first release scope.

## Acknowledgements

Everroom builds on a number of open-source projects and ideas:

- [Electron](https://www.electronjs.org/) and [React](https://react.dev/) for the desktop application foundation.
- [Fastify](https://fastify.dev/), [TypeBox](https://github.com/sinclairzx81/typebox), [Drizzle ORM](https://orm.drizzle.team/), and [SQLite](https://www.sqlite.org/) for the local service and storage layer.
- [Pi](https://github.com/earendil-works/pi) and the surrounding Model Context Protocol ecosystem for the replaceable Agent runtime direction.
- [OpenConnector](https://github.com/oomol-lab/open-connector) and [`oo-cli`](https://github.com/oomol-lab/oo-cli) from OOMOL for the local connector bridge.
- [Liminon](https://liminon.ai/) for inspiration around AI workflows and context products.

Everroom is released under the [Apache License 2.0](./LICENSE). Upstream licenses remain applicable to their respective components; see their individual notices and license files where applicable.

## License and contributing

The intended community edition includes the desktop client, the Office document experience, the Agent boundary, local connectors, and extension SDKs. Hosted synchronization, team administration, enterprise controls, and managed connector infrastructure may be delivered separately.

Interfaces are still moving. Useful contribution areas include connectors, Agent adapters, Office document and export quality, document operations, tests, documentation, and privacy reviews. Please open an issue before starting a large architectural change so it can align with the current contracts and roadmap.
