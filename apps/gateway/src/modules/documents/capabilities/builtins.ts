import type { DocumentOperationService } from "../operations/service.js";
import { createPlugin } from "./create-plugin.js";
import { queryPlugins } from "./query-plugin.js";
import { DocumentCapabilityRegistry } from "./registry.js";
import { DocumentReadAuthority } from "./read-authority.js";
import { reviewPlugins } from "./review-plugins.js";
import { selectionRewritePlugin } from "./selection-rewrite-plugin.js";
import type { CapabilityBackend } from "./shared.js";
import type { DocumentRoomRegistry } from "./types.js";

export function createBuiltinDocumentCapabilityRegistry(
  backend: CapabilityBackend,
  rooms?: DocumentRoomRegistry,
  operations?: DocumentOperationService,
  /** 共享读凭证权威（doc-writer-subagent-plan §5.3）：传入则复用（document_draft 代发
   *  的 receipt 与 patch_begin 的 requireLatest 必须查同一个实例），缺省自建（测试兼容）。 */
  sharedReads?: DocumentReadAuthority,
  /** 块索引标记（blockIndexMark）：Room 归属记忆权威清单；patch_begin 注入
   *  memoryIndex，供直写模式挂记忆标记时照抄 memoryId。 */
  resolveRoomMemoryItems?: (roomId: string) => Array<{ id: string; content: string; type: string }>,
): DocumentCapabilityRegistry {
  const registry = new DocumentCapabilityRegistry(operations);
  const reads = sharedReads ?? new DocumentReadAuthority((documentId) => backend.get(documentId));
  for (const plugin of queryPlugins(backend, rooms, reads)) registry.register(plugin);
  for (const plugin of reviewPlugins(backend, operations, reads, resolveRoomMemoryItems)) registry.register(plugin);
  registry.register(createPlugin(backend, operations));
  registry.register(selectionRewritePlugin(backend));
  return registry;
}
