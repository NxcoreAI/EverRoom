import type { DocumentEvent } from "@nxcore/agent-contract";
import type { DocumentCommentService } from "../comments.js";
import type { DocumentOperationService } from "../operations/service.js";
import { commentPlugin } from "./comment-plugin.js";
import { createPlugin } from "./create-plugin.js";
import { deletePlugin } from "./delete-plugin.js";
import type { OfficeBridgeClient } from "./office-bridge-client.js";
import type { DocumentIllustrationPorts, OfficeFileAccess } from "./office-plugin.js";
import { officePlugin } from "./office-plugin.js";
import { queryPlugins } from "./query-plugin.js";
import { DocumentCapabilityRegistry } from "./registry.js";
import { DocumentReadAuthority } from "./read-authority.js";
import { reviewPlugins } from "./review-plugins.js";
import { selectionRewritePlugin } from "./selection-rewrite-plugin.js";
import type { CapabilityBackend } from "./shared.js";
import type { DocumentRoomRegistry, SlidesPageProgressReporter } from "./types.js";
import type { SlidesVisualReviewer } from "../../slides-visual-review/review.js";

export function createBuiltinDocumentCapabilityRegistry(
  backend: CapabilityBackend,
  rooms?: DocumentRoomRegistry,
  operations?: DocumentOperationService,
  /** 共享读凭证权威（doc-writer-subagent-plan §5.3）：传入则复用（document_draft 代发
   *  的 receipt 与 patch_begin 的 requireLatest 必须查同一个实例），缺省自建（测试兼容）。 */
  sharedReads?: DocumentReadAuthority,
  /** 文档评论服务（AI 审阅）：传入则启用 document_comment_add 工具。 */
  comments?: DocumentCommentService,
  /** 文档事件广播：评论落库后发 document.comments.changed，桌面评论面板实时刷新。 */
  publishDocumentEvent?: (event: DocumentEvent) => void,
  /** Office 生成桥（agent 写 Word）：传入则启用 office_create 等工具。 */
  officeBridge?: OfficeBridgeClient | null,
  /** PPT 逐页进度上报器（只报不定）：传入则 slides 落页即广播进度快照。 */
  slidesProgress?: SlidesPageProgressReporter | null,
  /** 落页视觉复检器：传入则 preset 落页后截图送 VLM 判定（未配置 VLM 时内部跳过）。 */
  visualReviewer?: SlidesVisualReviewer | null,
  /** 文件库访问（惰性）：传入则启用改当前打开 Word/Excel 的 office_edit / sheets_read / sheets_edit。 */
  fileAccess?: () => OfficeFileAccess | null,
  /** 宿主生图端口：传入则启用 word_agent_illustration（Word 配图一步到位）。 */
  illustration?: DocumentIllustrationPorts | null,
): DocumentCapabilityRegistry {
  const registry = new DocumentCapabilityRegistry(operations);
  const reads = sharedReads ?? new DocumentReadAuthority((documentId) => backend.get(documentId));
  for (const plugin of queryPlugins(backend, rooms, reads)) registry.register(plugin);
  for (const plugin of reviewPlugins(backend, operations, reads)) registry.register(plugin);
  registry.register(createPlugin(backend, operations));
  registry.register(selectionRewritePlugin(backend));
  registry.register(commentPlugin(backend, comments, publishDocumentEvent));
  // #242：agent 文档删除（trash，带 confirm 防误删闸门）。
  registry.register(deletePlugin(backend));
  // agent 写 Word：桌面 office-bridge 未注入（如测试环境）时工具不暴露。
  if (officeBridge) {
    registry.register(officePlugin(officeBridge, slidesProgress, visualReviewer ?? null, fileAccess, illustration ?? null));
  }
  return registry;
}
