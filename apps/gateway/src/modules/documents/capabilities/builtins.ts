import type { OfficeBridgeClient } from "./office-bridge-client.js";
import type { DocumentIllustrationPorts, OfficeFileAccess } from "./office-plugin.js";
import { officePlugin } from "./office-plugin.js";
import { DocumentCapabilityRegistry } from "./registry.js";
import type { SlidesPageProgressReporter } from "./types.js";
import type { SlidesVisualReviewer } from "../../slides-visual-review/review.js";

/**
 * 内建文档工具面（2026-11 下线 Markdown 文稿工具链后只剩 Office 一组）。
 *
 * 曾经注册的 document_list / document_read / document_write_* / document_patch_* /
 * document_delete / document_comment_add 与 document_draft（doc-writer 调度）随
 * 「文稿库」概念一并摘除：新 workbench 只有「资料库 / 产物」两个文件入口，Markdown
 * 文稿没有列表与编辑 UI，这些工具的产出用户不可达。DocumentService 内核、HTTP
 * 路由与 slides 草稿落库（createSlidesDraftDocument）不受影响。
 */
export function createBuiltinDocumentCapabilityRegistry(
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
  const registry = new DocumentCapabilityRegistry();
  // agent 写 Office 文件：桌面 office-bridge 未注入（如测试环境）时工具不暴露。
  if (officeBridge) {
    registry.register(officePlugin(officeBridge, slidesProgress, visualReviewer ?? null, fileAccess, illustration ?? null));
  }
  return registry;
}
