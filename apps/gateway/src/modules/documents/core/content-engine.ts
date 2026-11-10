import { WORKSPACE_DOCUMENT_CHANNEL, type TiptapJsonContent } from "@nxcore/agent-contract";
import { hasEmbeddedDocumentImages, migrateDocumentContent } from "@nxcore/document-model";
import {
  normalizeDocumentContent,
  normalizeDocumentFragment,
} from "../content-model.js";
import { DocumentServiceError } from "../errors.js";

export type NormalizedGatewayDocument = ReturnType<typeof normalizeDocumentContent>;

/**
 * 文档正文归一化。Phase 2i 之后文档库只剩工作区级文稿，块作用域恒为
 * WORKSPACE_DOCUMENT_CHANNEL（不再有 Room 分区）。
 */
export class DocumentContentEngine {
  normalizeDocument(
    content: TiptapJsonContent,
    documentId: string,
    indexedVersion = 0,
  ): NormalizedGatewayDocument {
    const scope: string = WORKSPACE_DOCUMENT_CHANNEL;
    if (hasEmbeddedDocumentImages(content)) {
      throw new DocumentServiceError(
        "EMBEDDED_IMAGE_NOT_ALLOWED",
        "Document images must be stored as local assets",
        400,
      );
    }
    return normalizeDocumentContent(content, documentId, scope, { indexedVersion });
  }

  normalizeFragment(
    content: TiptapJsonContent,
    documentId: string,
  ): NormalizedGatewayDocument {
    const scope: string = WORKSPACE_DOCUMENT_CHANNEL;
    return normalizeDocumentFragment(content, documentId, scope);
  }

  normalizeStoredDocument(
    content: TiptapJsonContent,
    documentId: string,
    fromSchemaVersion: number,
    indexedVersion = 0,
  ): NormalizedGatewayDocument {
    let migrated: ReturnType<typeof migrateDocumentContent>;
    try {
      migrated = migrateDocumentContent(content, fromSchemaVersion);
    } catch (error) {
      throw new DocumentServiceError(
        "UNSUPPORTED_DOCUMENT_SCHEMA",
        error instanceof Error ? error.message : "Document content schema cannot be migrated",
        409,
      );
    }
    const scope: string = WORKSPACE_DOCUMENT_CHANNEL;
    return normalizeDocumentContent(
      migrated.content,
      documentId,
      scope,
      { indexedVersion },
    );
  }
}
