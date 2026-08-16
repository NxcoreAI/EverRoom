# Agent Document MCP

This note records the source-of-truth behavior used to port Agent-created,
streamed documents from `nexcore-pc` to Everroom CE.

## PC source of truth

The current PC implementation has separate transaction, MCP, and transport
layers:

1. `electron/agentCapabilities/documentMcpTools.ts` owns the document write
   transaction exposed to the Agent.
2. `electron/agentCapabilities/deviceMcpServer.ts` hosts those tools as MCP
   JSON-RPC sessions.
3. `src/services/agentCapabilityTransport.ts` carries MCP request/response
   envelopes over the PC WebRTC DataChannel.
4. The Context Room Cloud Docs host applies each accepted append to the editor
   before returning the tool result.

The write protocol is:

```text
context_room_write_begin
  -> context_room_write_append(sequence=1)
  -> context_room_write_append(sequence=2)
  -> ...
  -> context_room_write_commit(finalSequence=N)
```

`context_room_write_abort` closes a failed or cancelled transaction. Sequence
numbers are strictly consecutive. Duplicate appends are idempotent only when
their content hash and text match the original append.

## CE implementation

CE keeps the same transaction boundary while replacing AFFiNE/BlockSuite with
Tiptap:

- `apps/gateway/src/modules/documents/service.ts`: SQLite persistence,
  sequencing, size limits, versioning, acknowledgement waits, abort, expiry,
  restart recovery, and WebSocket event publication.
- `apps/gateway/src/modules/documents/mcp-host.ts`: the four Agent MCP tools.
- `apps/gateway/src/modules/documents/mcp-routes.ts`: authenticated HTTP MCP at
  `/v1/mcp/documents/:sessionId`.
- `apps/desktop/src/main/gateway/document-gateway-bridge.ts`: REST/WebSocket to
  Electron IPC bridge.
- `apps/desktop/src/renderer/src/components/context-room/ported/hooks/useRoomDocuments.ts`:
  Room document subscription and editor acknowledgement.
- `apps/desktop/src/renderer/src/components/context-room/ported/components/detail-editor/markdownStream.ts`:
  chunk-safe Markdown block buffering and stable block IDs.
- `TiptapDocumentEditor.tsx`: applies completed Markdown blocks to the live
  editor and acknowledges the resulting Tiptap JSON.

An MCP append does not complete merely because the Gateway stored its Markdown.
It completes only after the renderer applies the content and acknowledges the
resulting Tiptap document. Commit similarly waits for the final editor state.

## Runtime integration

The built-in Pi runtime receives the document tools directly through
`createDocumentPiTools`. It does not require a separate chat or device-MCP
transport. Gateway defaults to the `fake` runtime until Pi model credentials
are explicitly configured.

The CE HTTP MCP endpoint remains available to authenticated MCP clients. Its
URL must include the bound context:

```text
/v1/mcp/documents/{mcpSessionId}
  ?agentSessionId={localAgentSessionId}
  &runId={localRunId}
  &roomId={activeRoomId}
```

It is protected by the same Gateway bearer token as other non-health routes.
Do not expose the random Electron Gateway listener or token on an untrusted
network. A production remote registration mechanism must provide authenticated
reachability and bind the URL to the current Room/run.

## Limits and recovery

- Append chunk: 64 KiB UTF-8 maximum.
- Transaction body: 2 MiB maximum.
- Transaction TTL: 10 minutes, refreshed after accepted appends.
- Editor acknowledgement timeout: 180 seconds.
- Gateway restart: open provisional documents are removed as interrupted.
- Agent cancellation/failure: open transactions for that local Agent session
  are aborted and provisional documents are removed.
- User saves use optimistic document versions and fail on stale base versions.

## Verification

Run from the repository root:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Gateway tests include the official MCP Streamable HTTP client performing
initialization and `tools/list`, plus document transaction persistence and
replay.
