import { createHash } from "node:crypto";

import { annotations, manifest } from "./shared.js";
import { stringArg, success, type DocumentCapabilityPlugin, type DocumentCapabilityTool } from "./types.js";
import type { OfficeBridgeClient } from "./office-bridge-client.js";

/**
 * Agent 写 Word（第一期）：向 Room 暴露 context_room_office_create，经桌面
 * office-bridge 驱动隐藏 GenOffice docs view 生成 .docx 并走 file-imports
 * 入库，Room 资料页由路由决策自动投影展示。HTML 子集与 GenOffice docs
 * 渲染端协议（vendored apps/docs/src/renderer/ai/protocol.ts 的 HTML_RULES）
 * 保持一致；Excel/PPT 与编辑已有文档留待后续迭代。
 */

const MAX_HTML_LENGTH = 400_000;

const HTML_GUIDE = "内容用受限 HTML 片段表达，只允许这些标签："
  + "h1 h2 h3 h4 h5 h6 p ul ol li strong em u s a br table thead tbody tr th td pre code blockquote。"
  + "表格首行用 th，单元格只放纯文本（可用 br 分行），不支持嵌套表格和合并单元格；"
  + "代码示例用 pre，引用用 blockquote；长内容用 h2/h3 分节组织。"
  + "不要包含 html/body 标签、markdown 代码围栏或任何解释性文字。";

export function officePlugin(bridge: OfficeBridgeClient): DocumentCapabilityPlugin {
  const officeCreate: DocumentCapabilityTool = {
    name: "context_room_office_create",
    title: "生成 Word 文档入 Room",
    description: "用本地 Word 引擎生成一份新的 .docx 文档并加入当前 Room 的资料页（Office 文件夹），"
      + "生成的是真实 Word 排版（表格、列表、代码块、引用），适合正式报告、交付文档、需要 Word 排版的内容。"
      + "普通速记、笔记、随手总结仍用文档创建工具（markdown），不要用本工具。"
      + `title 用作文档标题与默认文件名（<title>.docx，可用 fileName 覆盖）。${HTML_GUIDE}`
      + "生成完成后在回复中告知文件名，并说明可在 Room 资料页打开查看。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120, description: "文档标题（同时是默认文件名）" },
        html: { type: "string", minLength: 1, maxLength: MAX_HTML_LENGTH, description: "文档正文（受限 HTML 片段）" },
        fileName: { type: "string", minLength: 5, maxLength: 120, description: "可选文件名，必须以 .docx 结尾" },
        format: { type: "string", enum: ["docx"], description: "文档格式，当前仅支持 docx" },
      },
      required: ["title", "html"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      if (!context.roomId) throw new Error("ROOM_SELECTION_REQUIRED: Select a Context Room first");
      const title = stringArg(args, "title").trim().slice(0, 120);
      const html = stringArg(args, "html");
      if (html.length > MAX_HTML_LENGTH) {
        throw new Error(`INVALID_REQUEST: html 超过长度上限（${MAX_HTML_LENGTH} 字符），请拆分内容`);
      }
      const format = args.format === undefined ? "docx" : args.format;
      if (format !== "docx") throw new Error("INVALID_REQUEST: 目前仅支持 docx 格式");
      let fileName: string | null = null;
      if (typeof args.fileName === "string" && args.fileName.trim()) {
        fileName = args.fileName.trim().slice(0, 120);
        if (!/\.docx$/i.test(fileName)) throw new Error("INVALID_REQUEST: fileName 必须以 .docx 结尾");
      }
      // 同 run 同标题幂等：桌面侧以 sourceKey=agent:word:<key> 去重/续版本链。
      const idempotencyKey = `agent-word:${createHash("sha256")
        .update(JSON.stringify([context.runId, title]), "utf8")
        .digest("hex")}`;
      const result = await bridge.generate({
        title,
        html,
        roomId: context.roomId,
        fileName,
        idempotencyKey,
      });
      if (!result.fileEntryId) throw new Error("OFFICE_GENERATION_FAILED: 桌面端未返回文件条目");
      return success({
        fileEntryId: result.fileEntryId,
        fileVersionId: result.fileVersionId,
        jobId: result.jobId,
        contentHash: result.contentHash,
        originalName: result.originalName,
        format: "docx",
        roomId: context.roomId,
        deduped: result.versionDeduped || result.blobDeduped,
        // Room 资料页投影由路由决策异步完成（知识路由关闭时会降级为仅入库）。
        roomRoutingRequested: result.roomRequested,
        nextAction: "report_result",
      });
    },
  };

  return {
    manifest: manifest("office.create", "mutation", null, null, true, false),
    promptGuidelines: [
      "用户需要正式 Word 文档（.docx 报告、交付物、含表格/公式的排版文档）时才调用 context_room_office_create；"
      + "普通笔记、速记、随手总结用文档创建工具（markdown），不要用 Word 工具。",
      "html 入参必须是受限 HTML 子集（仅标题/段落/列表/表格/链接/强调/pre/code/blockquote 标签）；"
      + "长文用 h2/h3 分节；表格首行用 th、单元格纯文本；不要输出 markdown 或解释性文字。",
      "生成成功后在回复中告知文件名，并说明文档已加入 Room 资料页（Office 文件文件夹）、可点击打开。",
    ],
    tools: [officeCreate],
  };
}
