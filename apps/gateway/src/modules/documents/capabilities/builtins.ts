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
): DocumentCapabilityRegistry {
  const registry = new DocumentCapabilityRegistry(operations);
  const reads = new DocumentReadAuthority((documentId) => backend.get(documentId));
  for (const plugin of queryPlugins(backend, rooms, reads)) registry.register(plugin);
  for (const plugin of reviewPlugins(backend, operations, reads)) registry.register(plugin);
  registry.register(createPlugin(backend, operations));
  registry.register(selectionRewritePlugin(backend));
  return registry;
}
