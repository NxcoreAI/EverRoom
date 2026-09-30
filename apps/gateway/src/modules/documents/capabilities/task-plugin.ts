import { randomUUID } from "node:crypto";
import type { TaskFolderService } from "../task-folders.js";
import { agentDocumentMarkdown } from "../agent-markdown.js";
import { success, type DocumentCapabilityPlugin, type DocumentCapabilityTool } from "./types.js";
import { annotations, manifest } from "./shared.js";
import type { CapabilityBackend } from "./shared.js";

export type WorkplanStage =
  | "draft"    // ② 根据素材写草稿
  | "reorder"  // ③ 按受众重排
  | "profile"  // ④ 确定布局与风格（澄清表单）
  | "density"  // ⑤ 按页面顺序与预设布局编排信息密度
  | "produce"  // ⑥ 开干（逐页生成）
  | "done";

export interface WorkplanPage {
  index: number;
  title: string;
  layout: string;
  density: string;
  status: string;
  note: string;
}

export interface WorkplanStructure {
  taskKind: "slides" | "docx";
  stage: WorkplanStage;
  goal: string;
  folderId: string;
  profile: Record<string, unknown> | null;
  pages: WorkplanPage[];
  notes: string[];
}

const WORKPLAN_TABLE_HEADER = "| # | 主题 | 版式 | 信息密度 | 状态 | 备注 |";

function escCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

export function composeWorkplanMarkdown(input: {
  title: string;
  structure: WorkplanStructure;
}): string {
  const { structure } = input;
  const yaml = [
    "```yaml",
    "task:",
    `  kind: ${structure.taskKind}`,
    `  stage: ${structure.stage}`,
    `  goal: ${escCell(structure.goal) || "-"}`,
    `  folderId: ${structure.folderId}`,
    "```",
  ].join("\n");
  const pageRows = structure.pages.map((page) =>
    `| ${page.index} | ${escCell(page.title)} | ${escCell(page.layout)} | ${escCell(page.density)} | ${escCell(page.status)} | ${escCell(page.note)} |`);
  const pages = [
    "",
    "## 页面计划",
    "",
    WORKPLAN_TABLE_HEADER,
    "|---|------|------|------|------|------|",
    ...pageRows,
    "",
  ].join("\n");
  const profileBlock = structure.profile
    ? "\n## 风格与布局画像\n\n```json\n" + JSON.stringify(structure.profile, null, 2) + "\n```\n"
    : "";
  const notes = structure.notes.length > 0
    ? "\n## 备注\n\n" + structure.notes.map((note) => `- ${escCell(note)}`).join("\n") + "\n"
    : "";
  return `# 工作计划：${input.title}\n\n${yaml}\n${pages}${profileBlock}${notes}`;
}

function parseYamlTaskBlock(markdown: string): {
  taskKind: WorkplanStructure["taskKind"];
  stage: WorkplanStage;
  goal: string;
  folderId: string;
} {
  const match = markdown.match(/```yaml\s*\n([\s\S]*?)```/);
  const block = match?.[1] ?? "";
  const values = new Map<string, string>();
  let inTask = false;
  for (const line of block.split("\n")) {
    if (/^task:\s*$/.test(line.trim())) { inTask = true; continue; }
    if (!inTask) continue;
    const kv = line.match(/^\s{2}([a-zA-Z]+):\s*(.*)$/);
    if (kv?.[1] !== undefined && kv[2] !== undefined) values.set(kv[1], kv[2].trim());
    else if (line.trim() && !/^\s/.test(line)) inTask = false;
  }
  const stageRaw = values.get("stage") ?? "draft";
  const stages: WorkplanStage[] = ["draft", "reorder", "profile", "density", "produce", "done"];
  return {
    taskKind: values.get("kind") === "docx" ? "docx" : "slides",
    stage: (stages as string[]).includes(stageRaw) ? stageRaw as WorkplanStage : "draft",
    goal: values.get("goal") === "-" ? "" : values.get("goal") ?? "",
    folderId: values.get("folderId") ?? "",
  };
}

function parsePagesTable(markdown: string): WorkplanPage[] {
  const pages: WorkplanPage[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("| ")) continue;
    const cells = line.slice(2, -2).split(" | ").map((cell) => cell.trim());
    const [indexCell, titleCell, layoutCell, densityCell, statusCell, noteCell] = cells;
    if (cells.length !== 6 || titleCell === undefined || titleCell === "主题") continue;
    const index = Number.parseInt(indexCell ?? "", 10);
    if (!Number.isInteger(index) || index < 1) continue;
    pages.push({
      index,
      title: titleCell.replace(/\\\|/g, "|"),
      layout: layoutCell ?? "",
      density: densityCell ?? "",
      status: statusCell ?? "",
      note: (noteCell ?? "").replace(/\\\|/g, "|"),
    });
  }
  return pages.sort((a, b) => a.index - b.index);
}

function parseProfileBlock(markdown: string): Record<string, unknown> | null {
  const match = markdown.match(/```json\s*\n([\s\S]*?)```/);
  if (!match) return null;
  try {
    const raw = match[1];
    if (raw === undefined) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseNotes(markdown: string): string[] {
  const section = markdown.split(/^## 备注\s*$/m)[1];
  if (!section) return [];
  return section.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}

/** workplan.md → 结构。页面计划表是人工可编辑的事实源：人改的行优先于模型记忆。 */
export function parseWorkplanMarkdown(markdown: string): WorkplanStructure {
  return {
    ...parseYamlTaskBlock(markdown),
    profile: parseProfileBlock(markdown),
    pages: parsePagesTable(markdown),
    notes: parseNotes(markdown),
  };
}

/** workplan 文档 → markdown 文本；文档不存在或不是任务计划时返回 null。 */
function workplanMarkdownFrom(
  backend: CapabilityBackend,
  workplanDocId: string,
  roomId: string,
): { markdown: string; title: string } | null {
  const doc = backend.get(workplanDocId);
  if (!doc) return null;
  if (doc.roomId !== roomId) throw new Error("WORKPLAN_ROOM_MISMATCH: 工作计划文档属于另一个 Room");
  const content = doc.contentJson as { type: string; content?: unknown[] };
  return {
    markdown: agentDocumentMarkdown.serialize({ type: "doc", content: (content.content ?? []) as never }),
    title: doc.title,
  };
}

export interface TaskClarifyQuestion {
  id: string;
  label: string;
  type: "single" | "multi" | "text";
  options?: string[];
  required?: boolean;
  placeholder?: string;
}

export interface TaskClarifyIssuerInput {
  sessionId: string;
  runId: string;
  roomId: string;
  workplanDocId?: string;
  folderId?: string;
  questions: TaskClarifyQuestion[];
}

/** 澄清意图签发器（由 AgentService 注入；工具执行时惰性取用）。 */
export type TaskClarifyIssuer = (input: TaskClarifyIssuerInput) => { pendingIntentId: string; status: string } | null;

const STAGE_GUIDE = "阶段流转：draft（写草稿）→ reorder（按受众重排）→ profile（定布局风格，弹澄清表单）"
  + "→ density（按页编排信息密度，填页面计划表）→ produce（开干：PPT 逐页 / 文档逐章生成）→ done。";

function stringArrayArg(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`INVALID_REQUEST: ${name} 必须是字符串数组`);
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`INVALID_REQUEST: ${name} 每项必须是非空字符串`);
    }
    return item.trim();
  });
}

function buildTaskStart(
  backend: CapabilityBackend,
  folders: TaskFolderService,
): DocumentCapabilityTool {
  return {
    name: "context_room_task_start",
    title: "开启内容生产任务",
    description: "开启一次内容生产任务（PPT 或长文档）：创建任务夹 + 工作计划 workplan.md。"
      + "这是生产管线的起点，先积累素材再开工：把 Room 里选定的素材消化成草稿（draft），"
      + `逐步推进到 done。${STAGE_GUIDE}`
      + "workplan.md 是任务的事实源（阶段、目标、页面计划表、风格画像、备注），"
      + "用户可以直接编辑它的表格；每次读写都应通过任务工具而不是直接改文件。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["slides", "docx"], description: "产物类型：slides=演示文稿，docx=长文档" },
        title: { type: "string", minLength: 1, maxLength: 120, description: "任务标题（任务夹与产物命名依据）" },
        goal: { type: "string", maxLength: 600, description: "可选：一句话目标（受众、场合、要达成什么）" },
      },
      required: ["kind", "title"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      if (!context.roomId) throw new Error("ROOM_SELECTION_REQUIRED: Select a Context Room first");
      const kind = args.kind === "docx" ? "docx" : "slides";
      const title = String(args.title ?? "").trim().slice(0, 120);
      if (!title) throw new Error("INVALID_REQUEST: title 不能为空");
      const goal = typeof args.goal === "string" ? args.goal.trim().slice(0, 600) : "";
      const folder = folders.create(context.roomId, {
        title,
        data: { taskKind: kind, stage: "draft", goal },
      });
      const workplanDocId = randomUUID();
      const structure: WorkplanStructure = {
        taskKind: kind, stage: "draft", goal, folderId: folder.id,
        profile: null, pages: [], notes: [],
      };
      const document = await backend.syncExternalMarkdown({
        documentId: workplanDocId,
        roomId: context.roomId,
        title: `${title} · 工作计划`,
        markdown: composeWorkplanMarkdown({ title, structure }),
        origin: "native",
      });
      folders.update(folder.id, { data: { workplanDocId: document.id } });
      folders.attachDocument(folder.id, document.id);
      return success({
        ok: true,
        folderId: folder.id,
        workplanDocId: document.id,
        stage: "draft",
        nextAction: "gather_material_and_draft",
      });
    },
  };
}

function buildTaskRead(backend: CapabilityBackend): DocumentCapabilityTool {
  return {
    name: "context_room_task_read",
    title: "读取工作计划",
    description: "读取一份任务工作计划（workplan.md）的当前结构：阶段、目标、风格画像、页面计划表、备注。"
      + "用户可能直接编辑过表格——读到的就是事实源；恢复中断的任务、跨会话续做前先读本工具。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workplanDocId: { type: "string", minLength: 1, description: "工作计划文档 id（task_start 返回的 workplanDocId）" },
      },
      required: ["workplanDocId"],
    },
    annotations: annotations(true, false),
    execute: async (args, context) => {
      if (!context.roomId) throw new Error("ROOM_SELECTION_REQUIRED: Select a Context Room first");
      const workplanDocId = String(args.workplanDocId ?? "").trim();
      const source = workplanMarkdownFrom(backend, workplanDocId, context.roomId);
      if (!source) throw new Error("WORKPLAN_NOT_FOUND: 工作计划不存在");
      const structure = parseWorkplanMarkdown(source.markdown);
      return success({
        ok: true,
        workplanDocId,
        title: source.title,
        ...structure,
        nextAction: structure.stage === "done" ? "summarize" : "continue_stage",
      });
    },
  };
}

function normalizePagesArg(value: unknown): WorkplanPage[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("INVALID_REQUEST: pages 必须是对象数组");
  return value.map((raw, position) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("INVALID_REQUEST: pages 每项必须是 {index, title, layout?, density?, status?, note?}");
    }
    const item = raw as Record<string, unknown>;
    const index = typeof item.index === "number" ? item.index : position + 1;
    if (!Number.isInteger(index) || index < 1 || index > 99) {
      throw new Error(`INVALID_REQUEST: 第 ${position + 1} 项 index 无效（1~99）`);
    }
    const title = String(item.title ?? "").trim();
    if (!title) throw new Error(`INVALID_REQUEST: 第 ${position + 1} 项 title 不能为空`);
    return {
      index,
      title: title.slice(0, 80),
      layout: String(item.layout ?? "auto").slice(0, 40),
      density: String(item.density ?? "medium").slice(0, 40),
      status: String(item.status ?? "pending").slice(0, 20),
      note: String(item.note ?? "").slice(0, 200),
    };
  });
}

function buildTaskUpdate(
  backend: CapabilityBackend,
  folders: TaskFolderService,
): DocumentCapabilityTool {
  return {
    name: "context_room_task_update",
    title: "更新工作计划",
    description: "更新工作计划的结构化字段：推进 stage、改目标、写风格画像、重写页面计划表、追加备注。"
      + "只传要改的字段（增量合并，未传字段保持原样）；pages 传全量数组（顺序即页序）。"
      + "每完成一个阶段就推进 stage 并落盘，用户随时能在任务夹里看到最新计划。"
      + `${STAGE_GUIDE}禁止手工编辑 markdown——一律走本工具。`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workplanDocId: { type: "string", minLength: 1, description: "工作计划文档 id" },
        stage: { type: "string", enum: ["draft", "reorder", "profile", "density", "produce", "done"], description: "推进到的阶段" },
        goal: { type: "string", maxLength: 600, description: "更新一句话目标" },
        profile: { type: "object", additionalProperties: true, description: "风格与布局画像（整体替换）：受众/语气/版式模式/配色/设计系统等自由结构" },
        pages: {
          type: "array",
          maxItems: 24,
          description: "页面计划表全量重写：每项 {index, title, layout, density, status, note}；status 用 pending/ready/done",
          items: { type: "object", additionalProperties: true },
        },
        appendNotes: { type: "array", items: { type: "string", maxLength: 300 }, description: "追加备注（保留原有）" },
      },
      required: ["workplanDocId"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      if (!context.roomId) throw new Error("ROOM_SELECTION_REQUIRED: Select a Context Room first");
      const workplanDocId = String(args.workplanDocId ?? "").trim();
      const source = workplanMarkdownFrom(backend, workplanDocId, context.roomId);
      if (!source) throw new Error("WORKPLAN_NOT_FOUND: 工作计划不存在");
      const current = parseWorkplanMarkdown(source.markdown);
      const stage = typeof args.stage === "string" ? args.stage as WorkplanStage : current.stage;
      const goal = typeof args.goal === "string" ? args.goal.trim().slice(0, 600) : current.goal;
      const pages = args.pages !== undefined ? normalizePagesArg(args.pages) : current.pages;
      const notes = [...current.notes, ...stringArrayArg(args.appendNotes, "appendNotes").map((n) => n.slice(0, 300))];
      const profile = args.profile !== undefined
        ? (typeof args.profile === "object" && args.profile !== null
          ? args.profile as Record<string, unknown>
          : null)
        : current.profile;
      const structure: WorkplanStructure = { ...current, stage, goal, pages, notes, profile };
      const document = await backend.syncExternalMarkdown({
        documentId: workplanDocId,
        roomId: context.roomId,
        title: source.title,
        markdown: composeWorkplanMarkdown({ title: source.title.replace(/ · 工作计划$/, ""), structure }),
        origin: "native",
      });
      if (structure.folderId && stage !== current.stage) {
        folders.update(structure.folderId, { data: { stage, title: document.title } });
      }
      return success({ ok: true, workplanDocId, ...structure, version: document.version });
    },
  };
}

function buildTaskClarify(issueTaskClarify: () => TaskClarifyIssuer | null): DocumentCapabilityTool {
  return {
    name: "context_room_task_clarify",
    title: "弹出澄清表单",
    description: "向用户弹出一张结构化澄清表单（单选/多选/填空），用于 profile 阶段确认风格与布局等关键决策。"
      + "questions 2~5 个，每项 {id(英文短id), label(问题), type(single|multi|text), options?, required?, placeholder?}；"
      + "single/multi 必须给 options（3~6 个，写成用户能直接看懂的选项）。"
      + "调用后立即结束本轮回复（简短说明在等用户确认即可）——表单提交后会自动开新一轮继续任务。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workplanDocId: { type: "string", minLength: 1, description: "工作计划文档 id" },
        folderId: { type: "string", minLength: 1, description: "任务夹 id" },
        questions: {
          type: "array",
          minItems: 2,
          maxItems: 5,
          description: "澄清问题列表",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["workplanDocId", "folderId", "questions"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      if (!context.roomId) throw new Error("ROOM_SELECTION_REQUIRED: Select a Context Room first");
      const issuer = issueTaskClarify();
      if (!issuer) throw new Error("TASK_CLARIFY_UNAVAILABLE: 澄清通道未就绪");
      const raw = args.questions;
      if (!Array.isArray(raw) || raw.length < 2 || raw.length > 5) {
        throw new Error("INVALID_REQUEST: questions 需要 2~5 项");
      }
      const questions: TaskClarifyQuestion[] = raw.map((item, position) => {
        if (typeof item !== "object" || item === null) {
          throw new Error(`INVALID_REQUEST: 第 ${position + 1} 个问题格式无效`);
        }
        const q = item as Record<string, unknown>;
        const id = String(q.id ?? "").trim();
        const label = String(q.label ?? "").trim();
        const type = q.type === "multi" ? "multi" : q.type === "text" ? "text" : "single";
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(id)) {
          throw new Error(`INVALID_REQUEST: 第 ${position + 1} 个问题 id 无效（英文短 id）`);
        }
        if (!label) throw new Error(`INVALID_REQUEST: 第 ${position + 1} 个问题 label 不能为空`);
        const options = type === "text" ? undefined : stringArrayArg(q.options, `questions[${position}].options`);
        if (type !== "text" && (!options || options.length < 2 || options.length > 6)) {
          throw new Error(`INVALID_REQUEST: 第 ${position + 1} 个问题（${type}）需要 2~6 个选项`);
        }
        return {
          id, label, type,
          ...(options ? { options } : {}),
          required: q.required === true,
          ...(typeof q.placeholder === "string" ? { placeholder: q.placeholder.slice(0, 120) } : {}),
        };
      });
      const intent = issuer({
        sessionId: context.agentSessionId,
        runId: context.runId,
        roomId: context.roomId,
        workplanDocId: String(args.workplanDocId ?? "").trim(),
        folderId: String(args.folderId ?? "").trim(),
        questions,
      });
      if (!intent) throw new Error("TASK_CLARIFY_UNAVAILABLE: 澄清意图创建失败");
      return success({
        ok: true,
        pendingIntentId: intent.pendingIntentId,
        status: intent.status,
        questions,
        nextAction: "end_turn_wait_for_user",
      });
    },
  };
}

function buildTaskAttach(folders: TaskFolderService): DocumentCapabilityTool {
  return {
    name: "context_room_task_attach",
    title: "产物归入任务夹",
    description: "把本任务产出的文档或文件归入任务夹（Room 里按任务聚拢展示）。"
      + "documentIds 是 Room 文档 id（workplan、草稿等）；fileEntryIds 是 Office 产物文件 id（PPT 等）。"
      + "生成产物后立即归夹，一个不漏。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        folderId: { type: "string", minLength: 1, description: "任务夹 id" },
        documentIds: { type: "array", items: { type: "string", minLength: 1 }, description: "要归夹的 Room 文档 id 列表" },
        fileEntryIds: { type: "array", items: { type: "string", minLength: 1 }, description: "要归夹的文件条目 id 列表（Office 产物）" },
      },
      required: ["folderId"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      if (!context.roomId) throw new Error("ROOM_SELECTION_REQUIRED: Select a Context Room first");
      const folderId = String(args.folderId ?? "").trim();
      const folder = folders.get(folderId);
      if (!folder || folder.roomId !== context.roomId) {
        throw new Error("FOLDER_NOT_FOUND: 任务夹不存在或不属于当前 Room");
      }
      const documentIds = stringArrayArg(args.documentIds, "documentIds");
      const fileEntryIds = stringArrayArg(args.fileEntryIds, "fileEntryIds");
      if (documentIds.length === 0 && fileEntryIds.length === 0) {
        throw new Error("INVALID_REQUEST: documentIds 与 fileEntryIds 至少传一个");
      }
      const attachedDocuments = documentIds.filter((id) => folders.attachDocument(folderId, id));
      const attachedFiles = fileEntryIds.filter((id) => folders.attachFile(folderId, id));
      return success({
        ok: true,
        folderId,
        attachedDocuments,
        attachedFiles,
        skipped: documentIds.length + fileEntryIds.length - attachedDocuments.length - attachedFiles.length,
      });
    },
  };
}

export function taskPlugin(
  backend: CapabilityBackend,
  folders: TaskFolderService,
  issueTaskClarify: () => TaskClarifyIssuer | null,
): DocumentCapabilityPlugin {
  return {
    manifest: manifest("task.pipeline", "mutation", null, null, true, false),
    promptGuidelines: [
      "内容生产任务（做 PPT、写长文档）一律走任务管线：context_room_task_start 开任务（建任务夹 + workplan.md），"
      + `按阶段推进并用 context_room_task_update 落盘。${STAGE_GUIDE}`,
      "profile 阶段必须用 context_room_task_clarify 弹结构化表单向用户确认风格/布局决策"
      + "（受众语气、版式模式、配色方向、信息密度偏好），收到作答后写入 profile 再推进；"
      + "弹表单后本轮立即收尾。",
      "PPT 产出进入 produce 阶段：先 context_room_task_update 把页面计划表填好（页序 = outline），"
      + "再 context_room_slides_create 建骨架、逐页 set_page；每页生成完把该页 status 标 done。"
      + "所有产物（PPT 文件、草稿文档）用 context_room_task_attach 归入任务夹。",
      "workplan.md 用户可以直接编辑表格——续做时先 context_room_task_read，以读到的内容为准，不要凭记忆改。",
    ],
    tools: [
      buildTaskStart(backend, folders),
      buildTaskRead(backend),
      buildTaskUpdate(backend, folders),
      buildTaskClarify(issueTaskClarify),
      buildTaskAttach(folders),
    ],
  };
}
