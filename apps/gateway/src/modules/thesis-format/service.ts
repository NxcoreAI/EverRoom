/**
 * thesis-format 编排：模版解析（归一化 → 子代理 parse_template → 校验入库）
 * 与论文装订（桌面 describe → 子代理 bind_thesis → 桌面 build 渲染入库）。
 * 块区间的事实源是桌面 describe 的 Block 序号，bind 只做映射不重算索引。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import { extname, join } from "node:path";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import type { FilesService } from "../files/service.js";
import type { SubagentOrchestrator } from "../subagents/orchestrator.js";
import type { OfficeBridgeClient } from "../documents/capabilities/office-bridge-client.js";
import { ThesisFormatCardStore } from "./card-store.js";
import { buildTemplateFacts, normalizeMembersToDocx, unpackTemplateInput } from "./normalize.js";
import { validateThesisFormatCard } from "./validate.js";
import { buildTemplateProfile } from "./template-profile.js";
import { mergeTemplateImages } from "./template-images.js";
import { buildCardFromFacts } from "./card-from-facts.js";
import { buildContentProfile } from "./content-profile.js";
import { ThesisJobRegistry, type ThesisJobSnapshot } from "./jobs.js";
import { buildMappingPlan, sanitizeMappingDecisions, type SemanticDecision } from "./mapping-plan.js";
import { planToBindingSpec } from "./plan-to-spec.js";
import type { ThesisBindingSpec, ThesisFormatCard, ThesisHfImage, ThesisReformatOptions, ThesisTemplateFacts } from "./types.js";

const THESIS_FORMATTER_AGENT_ID = "thesis-formatter";

export interface ThesisParseResult {
  cardId: string;
  sourceName: string;
  card: ThesisFormatCard;
  /** 解析代理申报的「模版事实缺口」：未能确定的版式信息（图片抽不出、条文冲突等）。
   *  空数组 = 模版完整可读。UI 据此提示，杜绝静默降级到默认样式。 */
  factGaps: string[];
}

export interface ThesisReformatResult {
  fileEntryId: string;
  originalName: string;
  /** v2 映射报告（守恒核对、规则、未匹配块、待复核章节）；老卡片路径没有。 */
  report?: Record<string, unknown>;
}


/**
 * 从模版块大纲里挑出「渲染时会出现灰字提示」的小节标题。
 *
 * 判据与引擎侧的目标识别保持一致：标题块（≤3 级），或「短、无句读」的编号列表项
 * （实验目的/实验仪器与工具/实验步骤这类自动编号小节在模版里就是列表项）。
 * 目录、封面、守则、评分说明、图表题注这些不是章节，全部排掉。
 */
export function pickFillSectionTitles(
  outline: Array<{ kind: string; level?: number; text: string }>,
  options?: { withContext?: boolean },
): Array<{ title: string }> {
  const chapterish = /^(第[一二三四五六七八九十百0-9]{1,4}[章篇节]|[一二三四五六七八九十]{1,3}\s*[、.．]|\d{1,2}(\.\d{1,2}){1,2}\s*[、.．]?\s*\S)/;
  const skip = /^(目录|目次|contents|摘要|abstract|参考文献|参考资料|附录|致谢|封面|守则|说明|评分|汇总|声明|承诺)/i;
  // 需要本人填写/主观打分的字段，AI 不能代写：个人信息、签名、评审与成绩
  const manualOnly = /(姓名|学号|班级|专业|学院|年级|指导教师|指导老师|联系方式|电话|邮箱|签名|签字|日期|评语|评分|成绩|考核|评价|等级|分数|意见|打钩|勾选)/;
  const seen = new Set<string>();
  const out: Array<{ title: string }> = [];
  let chapter = "";
  for (const block of outline) {
    const title = (block.text ?? "").trim();
    if (!title || title.length > 40) continue;
    const isTop = block.kind === "heading" && (block.level ?? 9) === 1;
    if (isTop) chapter = title;
    const flat = title.replace(/\s+/g, "");
    if (skip.test(flat)) continue;
    if (manualOnly.test(flat)) continue;
    // 封面/守则/评分说明/年份行/图表题注都不是要补写的章节
    if (/守则|评分|汇总|说明/.test(flat)) continue;
    if (/^\d{4}/.test(flat)) continue;
    if (/^《/.test(flat) || /^实验报告$/.test(flat)) continue;
    if (/^[图表]\d/.test(flat)) continue;
    if (/(图|表)$/.test(flat) && !chapterish.test(title)) continue;
    // 「五、在实验室内不准喧哗…」这类整句不是章节标题
    if (chapterish.test(title) && (flat.length > 24 || /[。；]/.test(flat))) continue;
    const isHeading = block.kind === "heading" && (block.level ?? 9) <= 3;
    const plainShort = !/[。，；：？！]/.test(flat) && flat.length <= 16;
    const isNumbered = (block.kind === "list" || block.kind === "paragraph") && (chapterish.test(title) || plainShort);
    if (!isHeading && !isNumbered) continue;
    // 「章｜小节」带上上下文：8 个实验都有「实验步骤」，不带上下文模型只能写一份，
    // 排版时会被复制到所有同名小节。带上后每节各写各的，引擎按整串匹配。
    const combined = chapter && chapter !== title ? `${chapter}｜${title}` : title;
    const contextual = options?.withContext && !isTop && combined.length <= 70 ? combined : title;
    const key = contextual.replace(/\s+/g, "").slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: contextual });
  }
  return out.slice(0, 60);
}

export class ThesisFormatService {
  private readonly store: ThesisFormatCardStore;

  constructor(private readonly deps: {
    db: GatewayDatabase;
    files: FilesService;
    orchestrator: SubagentOrchestrator;
    officeBridge: OfficeBridgeClient | null;
    /** 结构化日志（create-server 注入 app.log）；缺省不记，测试无需桩。 */
    logger?: { info: (obj: Record<string, unknown>, msg: string) => void; warn: (obj: Record<string, unknown>, msg: string) => void };
  }) {
    this.store = new ThesisFormatCardStore(deps.db);
  }

  cardStore(): ThesisFormatCardStore {
    return this.store;
  }

  async parseFromLibrary(workspaceId: string, fileEntryId: string): Promise<ThesisParseResult> {
    const entry = this.deps.files.catalogEntry(fileEntryId);
    if (!entry) throw new Error("thesis_template_file_not_found");
    // 工作区隔离：只能把本工作区资料库里的文件设为模版，避免跨空间把别人的
    // 文件（或同名的另一份模版）挂到当前空间。
    if (entry.workspaceId !== workspaceId) throw new Error("thesis_template_not_in_workspace");
    const storagePath = this.deps.files.catalogStoragePathOf(fileEntryId);
    if (!storagePath) throw new Error("thesis_template_file_not_readable");
    const bytes = await readFile(storagePath);
    const result = await this.parseBytes(bytes, entry.originalName);
    const row = this.store.upsert({ workspaceId, card: result.card, sourceFileEntryId: fileEntryId, sourceName: entry.originalName });
    if (result.templateDocx) await this.writeTemplateCache(row.id, result.templateDocx);
    return { cardId: row.id, sourceName: result.sourceName, card: result.card, factGaps: result.factGaps };
  }

  async parseFromUpload(
    workspaceId: string,
    bytes: Buffer,
    name: string,
    fileEntryId?: string | null,
  ): Promise<ThesisParseResult> {
    // 先校验归属再解析：解析可能要跑几十秒到几分钟，跨空间请求不该先烧掉解析。
    if (fileEntryId) {
      const linked = this.deps.files.catalogEntry(fileEntryId);
      if (linked && linked.workspaceId !== workspaceId) throw new Error("thesis_template_not_in_workspace");
    }
    const result = await this.parseBytes(bytes, name);
    // fileEntryId：桌面端上传前已把模版导入资料区，卡片直接关联该文件。
    // 关联后：预览能打开真实原文件、删除能级联清文件、也能重新从资料区解析。
    const row = this.store.upsert({ workspaceId, card: result.card, sourceFileEntryId: fileEntryId ?? null, sourceName: name });
    if (result.templateDocx) await this.writeTemplateCache(row.id, result.templateDocx);
    return { cardId: row.id, sourceName: result.sourceName, card: result.card, factGaps: result.factGaps };
  }

  removeCard(workspaceId: string, cardId: string): boolean {
    const removed = this.store.remove(workspaceId, cardId);
    // 卡没了，骨架缓存也没意义；失败不阻断（下次解析会覆盖同名文件）
    if (removed) void this.dropTemplateCache(cardId);
    return removed;
  }

  private async parseBytes(bytes: Buffer, name: string): Promise<{
    sourceName: string;
    card: ThesisFormatCard;
    factGaps: string[];
    /** 模版 docx 字节（装订骨架用）；拿不到（如 PDF 模版）时为 null，排版回落 v2。 */
    templateDocx: Buffer | null;
  }> {
    // 全链路显性失败：解包/归一化/事实抽取任一步失败都直接抛错（带阶段名），
    // 由 routes 层回 400 与 UI toast——绝不静默降级用默认样式出卡。
    const members = await unpackTemplateInput(bytes, name).catch((error: unknown) => {
      throw new Error(`thesis_template_unpack_failed:${error instanceof Error ? error.message : String(error)}`);
    });
    const normalized = await normalizeMembersToDocx(members).catch((error: unknown) => {
      throw new Error(`thesis_template_normalize_failed:${error instanceof Error ? error.message : String(error)}`);
    });
    // 装订骨架要的是「和用户看到的模版一模一样」的那份 docx：输入本来就是 docx 时
    // 保留原始字节（归一化会重新打包，封面/浮动图片/复杂表格有丢失风险）；
    // .doc/.dotx/.zip 本来就不是 docx，用归一化后承载版式的那个成员。
    const skeletonMember = normalized.find((member) => member.ext === ".docx");
    // 骨架必须是真 docx：老版 .doc（含「改名的 .docx」）喂给渲染器只会在装订阶段炸，
    // 然后静默回落到「照内容重建」——用户看到的就是目录/结构全变。
    const templateDocx = isDocxInput(bytes, name) && looksLikeDocx(bytes)
      ? bytes
      : (skeletonMember && looksLikeDocx(skeletonMember.bytes) ? skeletonMember.bytes : null);
    const facts = await buildTemplateFacts(normalized).catch((error: unknown) => {
      throw new Error(`thesis_template_facts_failed:${error instanceof Error ? error.message : String(error)}`);
    });
    // ---- 本地快速路径：版式事实齐全时直接确定性地出卡（20ms 级），不调解析代理 ----
    // 原来每次上传都要等 LLM 往返（30s–数分钟），而决定排版的版式信息全部在
    // OOXML 事实里。只有本地拿不到章节骨架/样式（扫描件、老格式、怪模板）才升级代理。
    const forceAgent = process.env.THESIS_PARSE_ENGINE === "agent";
    const ooxmlFacts = (facts.ooxml ?? [])[0];
    if (!forceAgent && ooxmlFacts) {
      const local = buildCardFromFacts(ooxmlFacts as never, name);
      if (local.confident) {
        const profile = buildTemplateProfile({
          facts: {
            styles: ooxmlFacts.styles ?? [],
            sections: (ooxmlFacts.sections ?? []) as never,
            headers: (ooxmlFacts.headers ?? []) as never,
            footers: (ooxmlFacts.footers ?? []) as never,
            coverImages: (ooxmlFacts.coverImages ?? []) as never,
            coverText: ooxmlFacts.coverText ?? [],
            outline: ooxmlFacts.outline ?? [],
            numbering: ooxmlFacts.numbering ?? { scheme: "none", levels: [] },
            fixedBlocks: (ooxmlFacts.fixedBlocks ?? []) as never,
          },
          card: local.card,
          sourceName: name,
        });
        local.card.profile = profile;
        return { sourceName: name, card: local.card, factGaps: local.gaps, templateDocx };
      }
    }

    const task = `解析论文格式模版并产出格式卡：${name}`;
    const input = {
      task: "parse_template" as const,
      sourceName: name.slice(0, 300),
      // 图片字节不进模型（网关确定性写入卡片）：一份校徽 base64 就有 4 万 token。
      facts: factsForAgent(facts),
    };
    const structured = await this.dispatchAgent(task, input);
    const rawCard = structured?.formatCard;
    if (!rawCard || typeof rawCard !== "object") throw new Error("thesis_format_card_missing");
    // 图片字节一律由网关从模版事实确定性写入卡片，**不经过解析代理**：
    // 让模型回显 base64 既烧输出预算（一份 logo 动辄上万 token），又容易抄错。
    const card = mergeTemplateImages(validateThesisFormatCard(rawCard, name), facts);
    // v2 模板剖面：取承载版式的 docx 成员（第一个有正文大纲的），挂到卡片上供
    // reformat 用。剖面里不含图片字节（卡片已有），只有角色与尺寸。
    const layoutMember = (facts.ooxml ?? []).find((member) => (member.outline ?? []).length > 0) ?? facts.ooxml?.[0];
    if (layoutMember) {
      card.profile = buildTemplateProfile({
        facts: {
          styles: layoutMember.styles ?? [],
          sections: (layoutMember.sections ?? []) as never,
          headers: (layoutMember.headers ?? []) as never,
          footers: (layoutMember.footers ?? []) as never,
          coverImages: (layoutMember.coverImages ?? []) as never,
          coverText: layoutMember.coverText ?? [],
          outline: layoutMember.outline ?? [],
          numbering: layoutMember.numbering ?? { scheme: "none", levels: [] },
          fixedBlocks: (layoutMember.fixedBlocks ?? []) as never,
        },
        card,
        sourceName: name,
      } satisfies Parameters<typeof buildTemplateProfile>[0]);
    }
    const rawGaps = structured?.templateFactsGaps;
    const factGaps = Array.isArray(rawGaps)
      ? rawGaps.filter((g): g is string => typeof g === "string" && g.trim().length > 0).slice(0, 20)
      : [];
    // 模版不是真 docx（老版 .doc / 改了扩展名）时，骨架排版用不了。
    // 必须在这里说清楚，否则用户只会看到「排版结果和模版不一样」。
    if (!templateDocx) {
      factGaps.unshift(
        "模版文件不是标准 .docx（常见于老版 .doc，或 .doc 改了扩展名）：本次只能按论文内容重建排版，"
        + "模版的封面/表格/目录无法原样保留。请用 Word/WPS 打开模版「另存为 .docx」后重新导入。",
      );
    }
    return { sourceName: name, card, factGaps, templateDocx };
  }

  private readonly jobs = new ThesisJobRegistry();
  /** 同一文档 + 同一模版 + 同一选项的进行中作业（点击防重；完成即释放）。 */
  private readonly activeJobs = new Map<string, string>();
  /**
   * 章节裁决结果缓存：同一份文档用同一张卡重排时，待定章节/候选槽位完全一致，
   * 没必要再付一次 10s 级的模型往返。内容或卡片变了 key 就变，不会串用。
   */
  private readonly adjudicationCache = new Map<string, SemanticDecision[]>();
  private static readonly ADJUDICATION_CACHE_LIMIT = 200;

  /**
   * 任务化排版：立刻返回作业快照，重活扔到后台跑。
   *
   * 关键收益：客户端不再挂着 5–10 分钟的长请求（那会在中间层被掐断，用户误以为
   * 模型不可用/超时），而是短轮询；服务端该跑多久跑多久。
   */
  startReformatJob(
    workspaceId: string,
    fileEntryId: string,
    cardId?: string,
    options?: ThesisReformatOptions,
  ): ThesisJobSnapshot {
    // 点击防重：面板在长任务期间重复点击曾经会并发多个作业——互相抢
    // thesis-formatter 的 2 个并发槽，越点越慢，还会产出重复文件。
    // 同一「文档 + 模版 + 选项」直接复用进行中的作业。
    const dedupeKey = JSON.stringify([workspaceId, fileEntryId, cardId ?? null, options ?? null]);
    const runningId = this.activeJobs.get(dedupeKey);
    if (runningId) {
      const running = this.jobs.get(runningId);
      if (running && running.status === "running") {
        this.deps.logger?.info({ jobId: running.id, workspaceId, fileEntryId, ...(cardId ? { cardId } : {}) }, "thesis job reused");
        return running;
      }
      this.activeJobs.delete(dedupeKey);
    }
    const job = this.jobs.create(workspaceId);
    this.activeJobs.set(dedupeKey, job.id);
    // 排版是分钟级长任务：没有这组日志就只能看到「转圈」，无法回答卡在解析、
    // 模型裁决还是渲染入库（2026-10-30 排查一次实际耗时全靠反推）。
    const startedAt = Date.now();
    const context = { jobId: job.id, workspaceId, fileEntryId, ...(cardId ? { cardId } : {}) };
    this.deps.logger?.info(context, "thesis job started");
    let phaseStartedAt = startedAt;
    void (async () => {
      try {
        const result = await this.reformat(workspaceId, fileEntryId, cardId, options, (phase) => {
          const now = Date.now();
          this.deps.logger?.info(
            { ...context, phase, phaseMs: now - phaseStartedAt, elapsedMs: now - startedAt },
            "thesis job phase",
          );
          phaseStartedAt = now;
          this.jobs.phase(job.id, phase);
        });
        this.jobs.complete(job.id, result);
        if (this.activeJobs.get(dedupeKey) === job.id) this.activeJobs.delete(dedupeKey);
        this.deps.logger?.info(
          { ...context, status: "completed", elapsedMs: Date.now() - startedAt, outputFileEntryId: result.fileEntryId },
          "thesis job finished",
        );
      } catch (error) {
        this.jobs.fail(job.id, error);
        if (this.activeJobs.get(dedupeKey) === job.id) this.activeJobs.delete(dedupeKey);
        this.deps.logger?.warn(
          {
            ...context,
            status: "failed",
            elapsedMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          },
          "thesis job failed",
        );
      }
    })();
    return job;
  }

  /** 作业快照（前端轮询用）；未知作业返回 undefined。 */
  reformatJob(jobId: string): ThesisJobSnapshot | undefined {
    return this.jobs.get(jobId);
  }

  async reformat(
    workspaceId: string,
    fileEntryId: string,
    cardId?: string,
    options?: ThesisReformatOptions,
    /** 阶段回调（任务化进度用）：parsing → mapping → rendering。 */
    onPhase?: (phase: "parsing" | "mapping" | "rendering") => void,
  ): Promise<ThesisReformatResult> {
    onPhase?.("parsing");
    const row = cardId ? this.store.byId(workspaceId, cardId) : this.store.latest(workspaceId);
    if (!row) throw new Error("thesis_format_card_not_found");
    let card = row.card;
    // 老卡片自愈：剖面版本比当前规则旧（导入时还没有「模版优先」模式）时，
    // 用模版原文件重建一次剖面。重建失败不阻断——仍然按老逻辑排版。
    const profileVersion = Number((card.profile as { version?: number } | undefined)?.version ?? 0);
    if (profileVersion < 3) {
      const staleProfileBytes = await this.readTemplateDocx(row.id, row.sourceFileEntryId, row.sourceName, workspaceId);
      if (staleProfileBytes) {
        const rebuilt = await this.rebuildTemplateProfile(card, staleProfileBytes, row.sourceName).catch((error: unknown) => {
          console.warn("[thesis] 剖面重建失败，按旧剖面排版：", error instanceof Error ? error.message : String(error));
          return null;
        });
        if (rebuilt) {
          card = { ...card, profile: rebuilt };
          // 落库：下次排版直接用新剖面，不必每次重算
          try {
            this.store.upsert({
              workspaceId,
              card,
              sourceFileEntryId: row.sourceFileEntryId,
              sourceName: row.sourceName,
            });
          } catch (error) {
            console.warn("[thesis] 新剖面落库失败（不影响本次排版）：", error instanceof Error ? error.message : String(error));
          }
        }
      }
    }
    // 「AI 补写空白小节」开关必须在映射之前落到卡片上：映射阶段就要判断要不要补写，
    // 渲染阶段再由引擎据此决定空节是写提示还是写补写内容。
    if (options?.aiFill === true && card.profile) {
      card = { ...card, profile: { ...card.profile, aiFill: true } };
      console.info("[thesis] AI 补写空白小节：本次已开启");
    } else if (options?.aiFill === true) {
      console.info("[thesis] AI 补写空白小节：已开启，但卡片没有模版剖面，跳过");
    }
    const bridge = this.deps.officeBridge;
    if (!bridge) throw new Error("thesis_bridge_unavailable");
    const entry = this.deps.files.catalogEntry(fileEntryId);
    if (!entry) throw new Error("thesis_source_file_not_found");
    if (extname(entry.originalName).toLowerCase() !== ".docx") throw new Error("thesis_source_not_docx");
    const storagePath = this.deps.files.catalogStoragePathOf(fileEntryId);
    if (!storagePath) throw new Error("thesis_source_not_readable");
    const bytes = await readFile(storagePath);

    const described = await bridge.describeThesisDocx({ docxBase64: bytes.toString("base64") });
    if (described.outline.length === 0) throw new Error("thesis_source_outline_empty");

    const titleHint = entry.originalName.replace(/\.[^.]+$/, "").slice(0, 300);
    onPhase?.("mapping");
    // AI 补写需要知道「模版正文里哪些小节会出现灰字提示」——先读模版字节
    const templateForFill = options?.aiFill === true
      ? await this.readTemplateDocx(row.id, row.sourceFileEntryId, row.sourceName, workspaceId).catch(() => null)
      : null;
    const v2 = await this.mapWithProfile(workspaceId, card, described.outline, titleHint, options, templateForFill);
    let spec: ThesisBindingSpec;
    let report: Record<string, unknown> | undefined;
    if (v2) {
      // v2：模板剖面 + 规则映射（确定性），不再让代理编区间
      spec = v2.spec;
      report = v2.report;
    } else {
      const task = `映射论文块大纲到装订规格（${entry.originalName}）`;
      const input = {
        task: "bind_thesis" as const,
        formatCard: cardForAgent(card),
        sourceOutline: described.outline,
        titleHint,
      };
      const structured = await this.dispatchAgent(task, input);
      spec = this.validateBindingSpec(structured?.bindingSpec, described.blockCount);
    }

    // 渲染卡片：带上 v2 模板编号方案（渲染器据此重算标题编号）；老卡片没有剖面，
    // 渲染器自动回落 headings[].numbering 的老语义。
    const withNumbering = card.profile
      ? { ...card, numbering: card.profile.fixed.numbering }
      : card;
    // 规则面板：关掉页眉页脚即在卡片层面禁用（渲染器据此不生成页眉页脚部件）
    const renderCard = options?.keepHeaderFooter === false
      ? {
          ...withNumbering,
          header: { ...withNumbering.header, enabled: false },
          footer: { ...withNumbering.footer, enabled: false },
        }
      : withNumbering;
    onPhase?.("rendering");
    // v3 模板骨架装订：把模版原文件一起下发，渲染器以模版为底、只替换内容槽位，
    // 封面/核心信息区/表格/教师评价表/目录按模版原位置原样保留。
    // 模版读不出来（老卡片、非 docx）就不带——渲染器回落 v2 重建路径。
    const templateBytes = await this.readTemplateDocx(row.id, row.sourceFileEntryId, row.sourceName, workspaceId);
    // 卡片有剖面说明用户是按「模版排版」导入的；此时拿不到模版字节，成品必然和模版不一致。
    // 必须显性告知，否则用户只会看到「表格又跑位了」却不知道是模版文件丢了。
    const missingTemplateNote = !templateBytes && card.profile
      ? ["模板原文件不可用（可能已删除/移动，或是老版 .doc、改了扩展名的 .doc）——本次按论文内容重建排版；"
        + "用 Word/WPS 把模版另存为 .docx 后重新导入，即可恢复「以模版为底」的排版"]
      : [];
    const built = await bridge.reformatThesisDocx({
      docxBase64: bytes.toString("base64"),
      ...(templateBytes ? { templateBase64: templateBytes.toString("base64") } : {}),
      formatCard: renderCard,
      bindingSpec: spec,
      // 产物是新建条目（sourceKey=agent:docx-thesis:*）：归属跟源文件走（同一工作区）。
      workspaceId,
      sourceFileName: entry.originalName,
      sourceFileEntryId: fileEntryId,
      keepLogo: options?.keepLogo !== false,
      ...(options?.aiFill === true ? { aiFill: true } : {}),
      idempotencyKey: `thesis-reformat:${fileEntryId}:${row.id}:${card.cardMeta.parsedAt}:${optionsFingerprint(options)}`,
    });
    // 出稿提示（模版骨架回落、自检软伤）并进报告：面板必须能看到「为什么这次排版不对」，
    // 否则用户只能看到成品、猜不到原因——这是「表格跑位」反复反馈却查不出所以然的根因。
    // AI 补写的结果必须让用户看见：补了几处、还是没补上（面板只显示 warnings）
    const aiFillWarnings: string[] = [];
    if (options?.aiFill === true) {
      const generated = spec.generatedSections ?? [];
      aiFillWarnings.push(generated.length > 0
        ? `AI 补写 ${generated.length} 处空白小节：${generated.map((entry) => entry.title).join("、")}（请核对后提交）`
        : "AI 补写未返回内容（模型不可用或素材不足），空白小节已退回灰字提示");
    }
    const warnings = [...missingTemplateNote, ...aiFillWarnings, ...(built.warnings ?? [])];
    const finalReport = report || warnings.length > 0
      ? { ...(report ?? {}), ...(warnings.length > 0 ? { warnings } : {}) }
      : undefined;
    return { fileEntryId: built.fileEntryId, originalName: built.originalName, ...(finalReport ? { report: finalReport } : {}) };
  }

  /**
   * 读模版原文件字节（仅 docx）。读不到返回 null：调用方回落 v2 重建路径，
   * 而不是让整个排版失败——老格式卡没有可用的模版文件是历史事实。
   */
  /** 模版 docx 缓存目录（与对象库同盘，不进 catalog）。 */
  private templateCachePath(cardId: string): string {
    return join(this.deps.files.dataDirectory(), "thesis-templates", `${cardId}.docx`);
  }

  /**
   * 解析时落一份 docx 骨架：排版因此不依赖资料区文件是否还在、fileEntryId 是否还有效
   * （上传通道可能拿不到 fileEntryId，老卡片也可能是 null——那样 v3 永远拿不到模版）。
   */
  private async writeTemplateCache(cardId: string, bytes: Buffer): Promise<void> {
    try {
      await mkdir(join(this.deps.files.dataDirectory(), "thesis-templates"), { recursive: true });
      await writeFile(this.templateCachePath(cardId), bytes);
    } catch (error) {
      // 缓存写不进去不影响解析：排版时还有资料区文件这条回退路径
      console.warn("[thesis] 模版 docx 缓存写入失败：", error instanceof Error ? error.message : String(error));
    }
  }

  private async dropTemplateCache(cardId: string): Promise<void> {
    try {
      await unlink(this.templateCachePath(cardId));
    } catch {
      // 不存在即视为已清理
    }
  }

  /**
   * 读模版 docx 字节（v3 骨架装订的底稿）。四级回退：
   * 1) 解析时落盘的缓存——最可靠，不依赖资料区；
   * 2) 卡片关联的资料区文件；
   * 3) 按模版文件名在资料区找唯一同名 docx（老卡片 sourceFileEntryId 为 null 时自愈）；
   * 4) 都拿不到 → null，渲染器回落 v2 内容重建。
   */
  /** 旧剖面自愈：按模版原文件重建剖面（与导入时同一条本地确定性路径）。 */
  private async rebuildTemplateProfile(
    card: ThesisFormatCard,
    templateBytes: Buffer,
    sourceName?: string,
  ): Promise<ThesisFormatCard["profile"]> {
    const name = sourceName ?? "template.docx";
    const members = await unpackTemplateInput(templateBytes, name);
    const normalized = await normalizeMembersToDocx(members);
    const facts = await buildTemplateFacts(normalized);
    const member = (facts.ooxml ?? []).find((item) => (item.outline ?? []).length > 0) ?? facts.ooxml?.[0];
    if (!member) return undefined;
    return buildTemplateProfile({
      facts: {
        styles: member.styles ?? [],
        sections: (member.sections ?? []) as never,
        headers: (member.headers ?? []) as never,
        footers: (member.footers ?? []) as never,
        coverImages: (member.coverImages ?? []) as never,
        coverText: member.coverText ?? [],
        outline: member.outline ?? [],
        numbering: member.numbering ?? { scheme: "none", levels: [] },
        fixedBlocks: (member.fixedBlocks ?? []) as never,
      },
      card,
      sourceName: name,
    });
  }

  private async readTemplateDocx(
    cardId: string,
    fileEntryId: string | null | undefined,
    sourceName?: string,
    /** 只在同名文件自愈时用于隔离工作区：别的空间的同名模版不参与匹配。 */
    workspaceId?: string,
  ): Promise<Buffer | null> {
    try {
      const cached = await readFile(this.templateCachePath(cardId));
      if (looksLikeDocx(cached)) return cached;
      // 缓存里是「改名的 .doc」这类假 docx：删掉，免得每次排版都在装订阶段炸一次
      await rm(this.templateCachePath(cardId), { force: true }).catch(() => {});
    } catch {
      // 无缓存，继续回退
    }
    const fromCatalog = async (id: string): Promise<Buffer | null> => {
      try {
        const entry = this.deps.files.catalogEntry(id);
        if (!entry || extname(entry.originalName).toLowerCase() !== ".docx") return null;
        const storagePath = this.deps.files.catalogStoragePathOf(id);
        if (!storagePath) return null;
        return await readFile(storagePath);
      } catch {
        return null;
      }
    };
    let bytes = fileEntryId ? await fromCatalog(fileEntryId) : null;
    if (bytes && !looksLikeDocx(bytes)) bytes = null;
    // 老卡片自愈：id 没了但文件还在资料区里。只在同名 docx 唯一时采用，避免张冠李戴。
    if (!bytes && sourceName) {
      const hits = this.deps.files.catalogEntriesByName(sourceName)
        .filter((entry) => extname(entry.originalName).toLowerCase() === ".docx")
        .filter((entry) => !workspaceId || entry.workspaceId === workspaceId);
      if (hits.length === 1) bytes = await fromCatalog(hits[0]!.id);
    }
    // 顺手补缓存：缓存机制上线前解析的老卡片跑一次就自愈了
    if (bytes) await this.writeTemplateCache(cardId, bytes);
    return bytes;
  }

  /**
   * 低置信章节的代理裁决（方案 §6.9）。
   *
   * 只把「引擎算不准的那几行」发给模型：槽位清单 + 待定章节（含候选槽位 id），
   * 模型返回 {chapterTraceId, slotId|null, reason}。模型**不产出正文/样式**。
   *
   * 失败一律回落确定性结果（顺序对齐 + 追加），不阻断排版——裁决是锦上添花，
   * 不是必经路径。
   */
  private async adjudicateMapping(
    workspaceId: string,
    profile: { slots: Array<{ id: string; title: string }> },
    plan: ReturnType<typeof buildMappingPlan>,
  ): Promise<SemanticDecision[]> {
    void workspaceId;
    const pending = plan.pendingForSemantic.slice(0, 20);
    if (pending.length === 0) return [];
    const cacheKey = JSON.stringify([
      profile.slots.map((slot) => [slot.id, slot.title]),
      pending.map((entry) => [entry.chapterTraceId, entry.chapterText, entry.candidates.map((candidate) => candidate.slotId)]),
    ]);
    const cached = this.adjudicationCache.get(cacheKey);
    if (cached) {
      this.deps.logger?.info(
        { pending: pending.length, decisions: cached.length },
        "thesis adjudication cache hit",
      );
      return cached;
    }
    try {
      const structured = await this.dispatchAgent(`裁决论文章节归属（${pending.length} 个待定）`, {
        task: "adjudicate_mapping" as const,
        mappingSlots: profile.slots.map((slot) => ({ id: slot.id, title: slot.title })),
        mappingCandidates: pending.map((entry) => ({
          chapterTraceId: entry.chapterTraceId,
          chapterText: entry.chapterText,
          candidateSlotIds: entry.candidates.map((candidate) => candidate.slotId),
        })),
      });
      const decisions = sanitizeMappingDecisions(structured?.decisions, pending, profile.slots);
      if (decisions.length > 0) {
        this.adjudicationCache.set(cacheKey, decisions);
        // 简单 FIFO 上限：论文排版不是热点路径，200 份文档的裁决量足够。
        if (this.adjudicationCache.size > ThesisFormatService.ADJUDICATION_CACHE_LIMIT) {
          const oldest = this.adjudicationCache.keys().next().value;
          if (oldest) this.adjudicationCache.delete(oldest);
        }
      }
      return decisions;
    } catch (error) {
      console.warn("[thesis] 归属裁决失败，回落顺序对齐：", error instanceof Error ? error.message : String(error));
      return [];
    }
  }


  /**
   * 模版正文里「会出现在排版结果中的小节标题」。
   *
   * AI 补写的候选必须来自这里，而不是只来自格式卡剖面：
   * 剖面只有一级/二级槽位，像「实验目的 / 实验仪器与工具 / 实验步骤」这种
   * 编号列表小节根本不在剖面里——只在渲染时才被识别成目标、才出灰字提示。
   * 只按剖面发补写任务，就会出现「勾了 AI 补写，提示还在」。
   */
  private async templateSectionTitles(bytes: Buffer | null): Promise<Array<{ title: string }>> {
    if (!bytes) return [];
    // 直接扫模版 OOXML，不走桌面桥：桥那一步在带 WMF 的大模版上会静默失败，
    // 结果就是「模版正文小节一个都没进补写列表」——实验目的/实验步骤永远补不上。
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    if (!documentXml) return [];
    // 表格单元格里的段落不是章节（评分表、成绩汇总表会混进来一堆「序号/得分」）
    const tableRanges: Array<[number, number]> = [];
    for (const tableMatch of documentXml.matchAll(/<w:tbl>/g)) {
      const start = tableMatch.index ?? 0;
      let depth = 0;
      const scanner = /<\/?w:tbl>/g;
      scanner.lastIndex = start;
      for (const tag of documentXml.matchAll(scanner)) {
        depth += tag[0] === "</w:tbl>" ? -1 : 1;
        if (depth === 0) {
          tableRanges.push([start, (tag.index ?? start) + tag[0].length]);
          break;
        }
      }
    }
    const inTable = (position: number): boolean =>
      tableRanges.some(([start, end]) => position >= start && position < end);
    const outline: Array<{ kind: string; level?: number; text: string }> = [];
    for (const match of documentXml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
      const paragraph = match[0];
      if (inTable(match.index ?? 0)) continue;
      const text = [...paragraph.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((item) => item[1]).join("").trim();
      if (!text) continue;
      const styleId = paragraph.match(/<w:pStyle[^>]*\bw:val="([^"]+)"/)?.[1] ?? "";
      const level = /^Heading\s*([1-4])$/i.exec(styleId)?.[1];
      const numbered = /<w:numPr[\s>]/.test(paragraph);
      outline.push({
        kind: level ? "heading" : numbered ? "list" : "paragraph",
        ...(level ? { level: Number(level) } : {}),
        text,
      });
    }
    return pickFillSectionTitles(outline, { withContext: true });
  }

  /**
   * AI 补写空白小节（用户开关，默认关）。
   *
   * 只把「模版有、映射后没有任何内容」的小节发给代理，并要求：
   * 只能改写论文里已有的事实，不许编造数据/人名/单位，拿不准就留空。
   * 返回文本在渲染时带「AI 生成 · 请核对」标记，导出时保留。
   */
  private async fillEmptySectionsWithAgent(
    profile: { slots: Array<{ id: string; title: string }>; subSlots?: Array<{ id: string; title: string }> },
    plan: ReturnType<typeof buildMappingPlan>,
    content: ReturnType<typeof buildContentProfile>,
    templateSections: Array<{ title: string }> = [],
  ): Promise<Array<{ title: string; text: string }>> {
    const used = new Set(plan.assignments.map((assignment) => assignment.slotId));
    const skipTitle = /^(目录|摘要|abstract|参考资料|参考文献|附录|致谢)/i;
    const candidates = [
      ...[...profile.slots, ...(profile.subSlots ?? [])]
        .filter((slot) => !used.has(slot.id))
        .map((slot) => slot.title),
      // 模版正文里的编号小节（实验目的/实验步骤…）——它们不在剖面里，
      // 但渲染时会出「本节待补充」，必须一起交给模型补。
      ...templateSections.map((section) => section.title),
    ];
    const seen = new Set<string>();
    const empty: Array<{ title: string }> = [];
    for (const title of candidates) {
      if (!title || skipTitle.test(title)) continue;
      const key = title.replace(/\s+/g, "");
      if (seen.has(key)) continue;
      seen.add(key);
      empty.push({ title });
    }
    if (empty.length === 0) return [];
    // 素材 = 论文每个章节的标题 + 该节正文摘录。
    // 注意：node.blockStart 指向**标题块本身**，直接取它只会把标题再发一遍——
    // 模型拿到的 snippet 等于标题，判定「没有素材」，于是如实提交空结果，
    // 表现就是「勾了 AI 补写但提示还在」。必须从标题之后的第一个正文块开始取。
    const sourceSummary = content.outline.map((node) => {
      const parts: string[] = [];
      let used = 0;
      for (let index = node.blockStart; index < Math.min(node.blockEnd, content.blocks.length); index += 1) {
        const block = content.blocks[index];
        if (!block) continue;
        if (index === node.blockStart && block.kind === "heading") continue;
        const text = (block.text ?? "").trim();
        if (!text) continue;
        parts.push(text);
        used += text.length;
        if (used >= 240) break;
      }
      return { level: node.level, title: node.text, snippet: parts.join(" ").slice(0, 240) };
    });
    // 全文素材：补写要基于论文整体，不能只看每节首句。
    // 截断上限控制在 12000 字，避免把上下文撑爆；超出时保留开头与结尾。
    const fullText = content.blocks.map((block) => (block.text ?? "").trim()).filter(Boolean).join("\n");
    const sourceText = fullText.length <= 12000
      ? fullText
      : `${fullText.slice(0, 8000)}\n…（中间略）…\n${fullText.slice(-4000)}`;
    // 一次 22 节要跑 6~7 分钟。拆成几批并发送，墙钟时间按批次降下来，
    // 否则加上映射阶段很容易撞到面板 10 分钟上限（用户看到「排版超时」）。
    const BATCH_SIZE = 8;
    const batches: Array<Array<{ title: string }>> = [];
    for (let index = 0; index < empty.length; index += BATCH_SIZE) {
      batches.push(empty.slice(index, index + BATCH_SIZE));
    }
    const settled = await Promise.allSettled(batches.map((batch) => this.dispatchAgent(
      `补写空白小节（${batch.length} 节）`,
      { task: "fill_sections" as const, emptySections: batch, sourceSummary, sourceText },
    )));
    const raw = settled.flatMap((outcome) => {
      if (outcome.status !== "fulfilled") {
        console.warn("[thesis] 某一批空小节补写失败，跳过该批：",
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
        return [];
      }
      const value = outcome.value as { generatedSections?: unknown } | null;
      return Array.isArray(value?.generatedSections) ? (value!.generatedSections as Array<Record<string, unknown>>) : [];
    });
    // 标题比对放宽：模型常把「七、」这类编号省掉，按去编号后的文本对，再换回模版原标题
    const loose = (value: string): string =>
      value.replace(/^\s*[一二三四五六七八九十百]+[、.．]\s*/, "").replace(/^\s*\d+(\.\d+)*[、.．]?\s*/, "").replace(/\s+/g, "");
    const canonical = new Map(empty.map((slot) => [loose(slot.title), slot.title]));
    return raw.flatMap((entry) => {
      const item = entry as Record<string, unknown>;
      const title = typeof item.title === "string" ? canonical.get(loose(item.title)) : undefined;
      const text = typeof item.text === "string" ? item.text.trim() : "";
      if (!title || !text) return [];
      if (text.length < 20 || text.length > 1200) return [];
      return [{ title, text }];
    });
  }

  /**
   * v2 映射：卡片带模板剖面时，用「内容剖面 → 映射计划 → 装订规格」确定性产出，
   * 不再派代理猜区间。返回 null = 老卡片，调用方回落原路径。
   */
  private async mapWithProfile(
    workspaceId: string,
    card: ThesisFormatCard,
    outline: Array<{ index: number; kind: string; level?: number; text: string }>,
    titleHint: string,
    options?: ThesisReformatOptions,
    templateBytes?: Buffer | null,
  ): Promise<{ spec: ThesisBindingSpec; report: Record<string, unknown> } | null> {
    const profile = card.profile;
    if (!profile || profile.slots.length === 0) return null;
    const knownKinds = new Set(["heading", "paragraph", "table", "image", "list"]);
    const blocks = outline.map((block) => ({
      index: block.index,
      kind: (knownKinds.has(block.kind) ? block.kind : "paragraph") as "heading" | "paragraph" | "table" | "image" | "list",
      ...(block.level !== undefined ? { level: block.level } : {}),
      text: block.text,
    }));
    const content = buildContentProfile(blocks);
    let plan = buildMappingPlan({ template: profile, content });
    // 低置信区间派一次代理裁决；失败/为空都回落确定性结果（不阻断排版）
    const decisions = await this.adjudicateMapping(workspaceId, profile, plan);
    const adjudicated = decisions.length > 0 ? buildMappingPlan({ template: profile, content, semantic: decisions }) : plan;
    if (decisions.length > 0) plan = adjudicated;
    // 双屏对比数据（内容结构级，非像素级）：左=源文档章节，右=排版后章节归属
    const diff = {
      left: content.outline.map((node) => ({
        level: node.level,
        text: node.text,
        blocks: node.blockEnd - node.blockStart,
      })),
      right: [] as Array<{ level: number; text: string; slotId: string; rule: string; blocks: number }>,
      appended: plan.unmatched.map((range) => (content.blocks[range.blockRange[0]]?.text ?? "").slice(0, 80)),
    };
    const { spec, notes } = planToBindingSpec({
      plan,
      content,
      titleHint,
      ...(options?.headingMapping ? { headingMapping: options.headingMapping } : {}),
      // 模板自有固定表单（教师评价表等）：解析时存在卡片剖面里，这里原样带回
      ...(card.profile?.fixed?.fixedBlocks?.length ? { templateProfile: card.profile } : {}),
    });
    // AI 补写空小节（默认关）：只对「模版有、论文没有」的小节生成，且只允许改写论文已有信息。
    // 失败一律跳过——补写是锦上添花，不能阻断排版。
    if ((profile as { aiFill?: boolean }).aiFill === true) {
      const templateSections = await this.templateSectionTitles(templateBytes ?? null).catch(() => []);
      const filled = await this.fillEmptySectionsWithAgent(profile, plan, content, templateSections).catch((error: unknown) => {
        console.warn("[thesis] 空小节补写失败，跳过：", error instanceof Error ? error.message : String(error));
        return [];
      });
      if (filled.length > 0) {
        spec.generatedSections = filled;
        notes.push(`AI 补写空小节：${filled.length} 处（请核对）`);
      } else {
        notes.push("AI 补写未返回内容（模型不可用或素材不足），空白小节已退回灰字提示");
      }
    }
    diff.right = spec.chapters.map((chapter) => {
      const assignment = plan.assignments.find((entry) => entry.blockRange[0] === chapter.blockStart);
      return {
        level: chapter.level,
        text: chapter.headingText,
        slotId: assignment?.slotId ?? "-",
        rule: assignment?.rule ?? "-",
        blocks: chapter.blockEnd - chapter.blockStart,
      };
    });
    return {
      spec,
      report: {
        diff,
        version: 2,
        conservation: plan.conservation,
        report: plan.report,
        assignments: plan.assignments.map((entry) => ({
          slotId: entry.slotId,
          headingText: entry.headingText,
          rule: entry.rule,
          confidence: Number(entry.confidence.toFixed(2)),
          blockRange: entry.blockRange,
          notes: entry.notes,
        })),
        unmatched: plan.unmatched,
        // 0.40–0.62 区间：优先由代理裁决（adjudicated=true），裁决不到的仍靠顺序推断，
        // UI 据此提醒用户核对。
        needsReview: plan.pendingForSemantic.map((entry) => ({
          chapterText: entry.chapterText,
          candidates: entry.candidates.map((candidate) => candidate.slotId),
        })),
        adjudicated: decisions.length, 
        gaps: [...profile.gaps, ...content.gaps],
        notes,
      },
    };
  }

  private async dispatchAgent(task: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const registered = this.deps.orchestrator.listDefinitions().some((d) => d.id === THESIS_FORMATTER_AGENT_ID);
    if (!registered) throw new Error("thesis_formatter_agent_not_registered");
    const invocation = await this.deps.orchestrator.dispatch({
      agentId: THESIS_FORMATTER_AGENT_ID,
      task,
      input,
      idempotencyKey: randomUUID(),
      source: "internal_workflow",
    });
    if (invocation.status !== "completed") {
      throw new Error(invocation.errorMessage || `thesis_formatter_failed:${invocation.status}`);
    }
    const structured = (invocation.result?.structuredOutput ?? null) as Record<string, unknown> | null;
    if (!structured) throw new Error("thesis_formatter_no_structured_output");
    return structured;
  }

  /** 区间合法性：夹回 [0, blockCount)；倒序/空区间剔除。 */
  private validateBindingSpec(raw: unknown, blockCount: number): ThesisBindingSpec {
    if (!raw || typeof raw !== "object") throw new Error("thesis_binding_spec_missing");
    const src = raw as Record<string, unknown>;
    const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
    const strArray = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    const clampRange = (start: unknown, end: unknown): { start: number; end: number } | null => {
      const s = Math.max(0, Math.min(blockCount, Number(start)));
      const e = Math.max(0, Math.min(blockCount, Number(end)));
      return Number.isFinite(s) && Number.isFinite(e) && e > s ? { start: s, end: e } : null;
    };
    const chapters = (Array.isArray(src.chapters) ? src.chapters : [])
      .map((c) => {
        const chapter = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
        const range = clampRange(chapter.blockStart, chapter.blockEnd);
        if (!range) return null;
        const level = Number(chapter.level);
        return {
          level: (level >= 1 && level <= 4 ? level : 1) as 1 | 2 | 3 | 4,
          headingText: str(chapter.headingText).slice(0, 200),
          blockStart: range.start,
          blockEnd: range.end,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null && c.headingText.length > 0);
    if (chapters.length === 0) throw new Error("thesis_binding_spec_no_chapters");
    const appendixRaw = (src.appendixBlocks && typeof src.appendixBlocks === "object")
      ? src.appendixBlocks as Record<string, unknown>
      : null;
    return {
      title: str(src.title).slice(0, 300),
      coverFields: (src.coverFields && typeof src.coverFields === "object")
        ? Object.fromEntries(Object.entries(src.coverFields as Record<string, unknown>)
          .filter(([, v]) => typeof v === "string")
          .map(([k, v]) => [k, (v as string).slice(0, 200)]))
        : {},
      abstractZh: str(src.abstractZh),
      keywordsZh: strArray(src.keywordsZh),
      abstractEn: str(src.abstractEn),
      keywordsEn: strArray(src.keywordsEn),
      chapters,
      references: strArray(src.references).map((r) => r.slice(0, 600)),
      appendixBlocks: appendixRaw ? clampRange(appendixRaw.start, appendixRaw.end) : null,
      acknowledgementParagraphs: strArray(src.acknowledgementParagraphs).map((p) => p.slice(0, 2000)),
      achievements: strArray(src.achievements).map((a) => a.slice(0, 600)),
    };
  }
}

/**
 * 送给解析代理的模版事实：**剥掉图片字节**，只留尺寸/版位等元信息。
 *
 * 一份校徽 png 122KB ≈ 4 万 token：塞进输入既挤占窗口（把输出预算挤到截断），
 * 又诱导模型把 base64 抄进卡里。图片字节本来由网关确定性写入格式卡，代理只需
 * 知道「这里有张多大的图、放在哪」。
 */
export function factsForAgent(facts: ThesisTemplateFacts): unknown {
  const strip = (images: ThesisHfImage[] | undefined) => (images ?? []).map((image) => ({
    hasBytes: true,
    ...(image.widthPx !== undefined ? { widthPx: image.widthPx } : {}),
    ...(image.heightPx !== undefined ? { heightPx: image.heightPx } : {}),
    ...(image.floating !== undefined ? { floating: image.floating } : {}),
    ...(image.behind !== undefined ? { behind: image.behind } : {}),
    ...(image.posH !== undefined ? { posH: image.posH } : {}),
    ...(image.posV !== undefined ? { posV: image.posV } : {}),
    ...(image.posHRel !== undefined ? { posHRel: image.posHRel } : {}),
    ...(image.posVRel !== undefined ? { posVRel: image.posVRel } : {}),
    ...(image.posXPx !== undefined ? { posXPx: image.posXPx } : {}),
    ...(image.posYPx !== undefined ? { posYPx: image.posYPx } : {}),
  }));
  return {
    ooxml: (facts.ooxml ?? []).map((member) => ({
      ...member,
      headers: (member.headers ?? []).map((header) => ({ ...header, images: strip(header.images) })),
      footers: (member.footers ?? []).map((footer) => ({ ...footer, images: strip(footer.images) })),
      coverImages: strip(member.coverImages),
    })),
    documentsText: facts.documentsText ?? [],
  };
}

/** 单张图片的元信息（无字节）：代理只需知道「有多大、放哪儿」。 */
function imageMeta(image: ThesisHfImage): Record<string, unknown> {
  return {
    hasBytes: true,
    ...(image.widthPx !== undefined ? { widthPx: image.widthPx } : {}),
    ...(image.heightPx !== undefined ? { heightPx: image.heightPx } : {}),
    ...(image.floating !== undefined ? { floating: image.floating } : {}),
    ...(image.behind !== undefined ? { behind: image.behind } : {}),
    ...(image.posH !== undefined ? { posH: image.posH } : {}),
    ...(image.posV !== undefined ? { posV: image.posV } : {}),
    ...(image.posHRel !== undefined ? { posHRel: image.posHRel } : {}),
    ...(image.posVRel !== undefined ? { posVRel: image.posVRel } : {}),
    ...(image.posXPx !== undefined ? { posXPx: image.posXPx } : {}),
    ...(image.posYPx !== undefined ? { posYPx: image.posYPx } : {}),
  };
}

/**
 * 送给装订代理的格式卡：同样剥掉图片字节。
 *
 * 卡片里的图片（cover.logo 122KB ≈ 4 万 token）如果随 bind_thesis 输入发出去，
 * 会把输出窗口挤到截断——实测排版因此报「模型输出上限」。字节只在网关→桌面桥
 * 那一跳需要，代理判断章节/标题映射时不需要。
 */
export function cardForAgent(card: ThesisFormatCard): unknown {
  return {
    ...card,
    header: { ...card.header, images: (card.header.images ?? []).map(imageMeta) },
    cover: { ...card.cover, ...(card.cover.logo ? { logo: imageMeta(card.cover.logo) } : {}) },
  };
}

/** 排版选项指纹：进幂等键，不同选项产出不同文件而不是复用旧的。 */
function optionsFingerprint(options?: ThesisReformatOptions): string {
  if (!options) return "default";
  return [
    options.keepLogo === false ? "nologo" : "logo",
    options.keepHeaderFooter === false ? "nohf" : "hf",
    options.headingMapping
      ? Object.entries(options.headingMapping).map(([role, level]) => `${role}${level}`).join("-")
      : "nomap",
  ].join("_");
}

/** validate 对 cover.degreeLine 的兜底值：卡里等于它时视为「代理没给」，可被封面文本改写。 */
const DEFAULT_DEGREE_LINE = "本科毕业论文（设计）";

/**
 * 把模版里抽出的图片事实写进格式卡（页眉图 + 封面图）。
 *
 * 确定性合并：只补卡片里缺的字段，不覆盖已解析代理给出的合法值；没有图片事实
 * 时保持字段缺省——绝不编造 logo。
 */

/**
 * 输入是否已经是 docx：扩展名 + zip 魔数双确认。
 * 只看扩展名会把改名的 zip/rar 当成骨架，parseDocx 直接抛错；只看魔数又会把
 * 扩展名为 .zip 的 docx 误判——两者都满足才按「原件即骨架」处理。
 */
/** 真正的 docx：ZIP 容器且含 word/document.xml。改名的 .doc 会在这里被挡掉。 */
function looksLikeDocx(bytes: Buffer): boolean {
  if (bytes.length < 8 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  return bytes.includes(Buffer.from("word/document.xml"));
}

function isDocxInput(bytes: Buffer, name: string): boolean {
  if (extname(name).toLowerCase() !== ".docx") return false;
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}
