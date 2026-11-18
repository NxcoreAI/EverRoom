# BP 赛道模板：配置化接入 slides 生成管线 — 实施方案

> 状态：M1/M2 已实现（2026-11-18，分支 `bp-template`）；M3 事实联动待 FA 迭代工作项二
> 范围：新增 BP 模板配置层与选型入口；`slides-planner` 输入侧轻量扩展；不动 `slides-layouter`、`slides-styler`、semantic v3 契约与渲染引擎
> 输入文档：[BP 赛道分类与模块内容标准（v1.0）](https://vyi-tech.feishu.cn/docx/FXRrdQCydo7vSax4yIRcbKz7nd3)（下称"标准"）、[FA 标准化与 AI 化运行体系 v4.0](https://vyi-tech.feishu.cn/docx/SH5dd3dlDolublxVMN2cmUEynLf)（下称"蓝图"，其 §18.1 BP 质量门与本方案对接）
> 关联：[fa-industry-iteration.zh-CN.md](fa-industry-iteration.zh-CN.md)（FA 行业版迭代总索引）、[slides-storyboard-form-plan.zh-CN.md](slides-storyboard-form-plan.zh-CN.md)（semantic v3 与确认稿 1:1 约束的由来）

## 1. 一句话

BP 模板不做成 18 套提示词，而是做成**一份结构化配置**：赛道决定模块顺序，模块决定内容要求，生成时配置注入现有 `slides-planner` 的输入口，管线其余部分零改动。

## 2. 为什么是配置而不是提示词

标准的三层结构天然是正交的，任何一份 BP = 一个 T 主模板 × 讲述顺序 × 发展阶段档 × 一至两个专项：

| 层 | 内容 | 规模 |
| --- | --- | --- |
| 赛道层 T | 核心判断、建议模块顺序、赛道专项填写要求、优先指标、常见错误 | T01–T18 + X01 资产运营 |
| 模块层 M | 要回答 / 应填内容 / 证据与图表 / 检查重点（四段固定结构） | M01–M13 |
| 调整层 | 四种讲述顺序（按证据特点）、三档发展阶段（早/增长/成熟）、专项叠加（AI 能力、跨境、政府客户、农业生物） | 正交组合 |

18 套提示词意味着 18 处维护点；配置意味着一份代码消费所有模板。标准的"交叉项目选型规则"（AI 眼镜以 T07 为主、医院软件以 T01 为主补医疗数据）也说明：**选型本身可判定——是决策树，不是生成任务**，不该交给模型自由发挥。

## 3. 与现有管线的接口对齐（已核实）

对照 `agents/slides-planner/`（SYSTEM.md、input/output schema）与 `apps/gateway/src/modules/subagents/tools.ts` 的注入链：

| 标准里的概念 | 管线现成机制 | 接线方式 |
| --- | --- | --- |
| T 模板的建议顺序（如 T01：M01→M02→M04→M07→…） | draft 输入 `outline`（≤32 项逐页标题，tools.ts:1710） | 选型结果直接生成 |
| 赛道覆盖要求（核心判断、优先指标） | `referenceOutline`（章节覆盖引导，tools.ts:1714） | 同上 |
| 赛道专项要求（每模块必填内容、常用图表） | `instruction`（≤16000 字符任务说明） | 模板渲染注入 |
| 逐页任务单（核心问题/本页结论/事实证据/假设缺口） | draft 输出 `title/points/data/notes/warnings` | 结构同构，planner 已能产出 |
| 四种讲述顺序 | planner 自主判断的 `narrative` 主线 | 从自由判断变为四选一受约束 |
| 发布前检查（数字一致、口径、无证据表述） | 蓝图 §18.1 质量门 + arrange 后校验 | 检查项由模板带出 |

关键结论：**所有注入点都已存在**，本方案是"往现有入口填内容"，不是"改管线"。

## 4. 数据模型

### 4.1 模板配置（新增 `packages` 级常量或 gateway 配置目录，实现时定）

```ts
/** M 模块定义：四段固定结构，内容转录自标准 */
interface BpModuleDef {
  id: "M01" | ... | "M13";
  title: string;                    // 如 "定位与融资摘要"
  question: string;                 // 要回答：让读者理解什么
  content: string;                  // 应填内容
  evidence: string;                 // 证据与图表（含建议展示）
  pitfalls: string[];               // 检查重点（避免什么）
}

/** T 赛道模板 */
interface BpTrackDef {
  id: "T01" | ... | "T18" | "X01";
  name: string;                     // 如 "企业软件与行业数字化"
  coreQuestion: string;             // 核心判断：客户是否持续付费…
  moduleOrder: ModuleId[];          // 建议顺序（13 个 M 的排列）
  overrides: Partial<Record<ModuleId, {
    required: string;               // 本类必须填充的内容
    evidenceHints: string[];        // 材料与常用图表
  }>>;
  metrics: string[];                // 优先指标（如 NRR、实施周期）
  antiPatterns: string[];           // 常见错误（如把多年合同全额当年收入）
}

/** 讲述顺序 × 发展阶段 × 专项，均为小表 */
interface BpNarrativeOrder { id: string; evidencePattern: string; order: ModuleId[]; }
interface BpStageTuning { stage: "early" | "growth" | "mature"; moduleAdjust: Record<ModuleId, string>; }
interface BpAddon { id: string; name: string; requirements: string; }
```

数据来源就是标准文档本身：18 个 T、13 个 M、顺序表、阶段调整表、专项表，一次性转录。**转录即交付**——不需要发明任何字段，标准里都有。

### 4.2 选型卡（BP 生成的第一步交互）

选型流程按标准的"BP 结构选型流程"六问实现：卖什么 → 怎么赚钱 → 已验证什么 → 本轮要证明什么 → 选模板与专项 → 确认目录和证据。

- 前两问（卖什么/怎么赚钱）映射到 T 类目枚举，可由事实库的项目标签辅助预填；
- 第三问（已验证什么）联动发展阶段档位；
- 第四问（本轮关键判断）是一句话文本，写入 deck 元数据，作为 `narrative` 的种子；
- 输出：`{ trackId, narrativeOrderId, stage, addonIds[] }`，**人选确认后才进入生成**——对应标准"与创始人确认主线"的关口，也符合蓝图"关键判断由人承担"的边界。

### 4.3 注入渲染（选型结果 → planner 输入）

```ts
function buildPlannerInput(sel: BpSelection, facts: FactQuery): PlannerDraftInput {
  const track = TRACKS[sel.trackId];
  const order = merge(track.moduleOrder, NARRATIVE_ORDERS[sel.narrativeOrderId], STAGE_TUNINGS[sel.stage]);
  return {
    outline: order.map(mid => MODULES[mid].title),        // ≤13 项，远低于 32 上限
    referenceOutline: [track.coreQuestion, ...order.map(mid => MODULES[mid].question)],
    instruction: renderInstruction(track, sel),            // 专项要求+优先指标+常见错误+阶段调整，预算内
  };
}
```

`instruction` 渲染预算：T 模板专项约 2~3K 字符 + 阶段调整约 1K + 专项叠加每个约 0.5K，合计 5~7K，在 16K 上限内留足余量给用户附加要求。

## 5. 改动清单

| 位置 | 动作 | 量级 |
| --- | --- | --- |
| `apps/gateway/src/modules/slides/`（或新 `bp-template/`） | 新增模板配置常量 + `buildPlannerInput` + 类型 | 中（主体是转录） |
| `apps/gateway/src/modules/subagents/tools.ts` | 无必改；可选：draft 入口透传 `bpTemplate` 标记用于校验 outline 覆盖 | 小 |
| `agents/slides-planner/SYSTEM.md` | 增补一段：输入含 BP 模板注入时的行为（顺序为骨架、专项为必填、指标优先呈现） | 小 |
| 选型卡 UI（desktop） | 新增 BP 生成入口的第一步交互（六问表单 + 预填） | 中 |
| 测试 | 配置完整性（18+13 全覆盖、moduleOrder 是排列）、注入渲染快照、端到端一次 T01 生成 | 中 |

明确不动：`slides-layouter` / `slides-styler`（视觉与内容正交，视觉差异走既有 reference deck 机制）、semantic v3 契约、确认稿 1:1 约束（draft 确认后 arrange 不变）。

## 6. 与 FA 迭代其他工作项的合流点

| 工作项 | 供给关系 |
| --- | --- |
| 事实分级（工作项二） | M 模块"事实与证据"只从已核事实取数；逐页任务单的"来源/口径/确认人"即事实库字段——**BP 模板是事实库的第一个消费场景** |
| 机构档案（工作项一） | 投资人定制变体：同一确认稿对不同机构只调整模块强调顺序与 materialHints，不改事实（蓝图 §18.1） |
| 会后反馈（工作项四） | 标准第八步"反馈及更新"：投资人问题关联到对应页，进问题台账，驱动 BP 迭代 |

依赖关系：模板配置本身**零依赖**可先行；选型卡预填和事实取数依赖事实库，第一版可纯手填。

## 7. 实施顺序与验证

1. **M1 模板库转录**：13 个 M + 18 个 T + 三个小表落成 TS 配置 + 完整性测试。出口：配置即数据的单测通过。
2. **M2 注入链路**：`buildPlannerInput` + 选型卡（手填版）+ planner SYSTEM.md 增补。出口：选定 T01 + "产品与数据已验证"顺序 + 增长阶段，生成一份 12~20 页 BP 草稿，模块覆盖与顺序符合模板。
3. **M3 事实联动**：draft 取数接已核事实检索，逐页任务单带来源与口径。出口：BP 里的关键数字能回链事实库（对应蓝图"关键结论来源覆盖率 100%"）。

验证口径沿用标准的发布前检查：业务完整（八要素覆盖）、赛道适配（专项已填）、证据清楚（事实/分析/假设分开）、数字一致（跨材料口径相同）、确认可查（版本与批准记录）。

## 8. 风险与边界

| 风险 | 对策 |
| --- | --- |
| planner 忽视注入的顺序/专项约束 | instruction 显式声明"顺序为骨架、专项为必填"；draft 输出的 outline 覆盖做网关侧校验（M2 的可选改动） |
| 模板配置与标准文档漂移 | 配置头部记录标准版本（v1.0，2026-11-01）；标准更新时以 diff 审核转录 |
| 16K instruction 预算不足 | 当前估算 5~7K；真不够时优先压缩专项叠加（按需注入，不全量） |
| 交叉项目选错主模板 | 选型卡按标准的交叉规则给预判（AI 眼镜→T07），最终由人确认 |
| 本方案与蓝图 §18.1 质量门重叠 | 本方案只管"生成侧注入"；发布前的数字一致性/引用完整性检查归质量门，另案 |

## 9. 开放问题

1. 模板配置放 gateway 模块内还是独立 package（倾向前者，避免为纯常量建包）；
2. 选型卡是 BP 生成流程的必经步骤，还是允许跳过直接用默认模板（倾向：可跳过，默认 T01 + 通用顺序，标注"未选型"）；
3. M3 事实联动是否等 FA 迭代工作项二落地后再启动（倾向：不等，M2 先用 Room 内已有资料，M3 是替换取数源）。
