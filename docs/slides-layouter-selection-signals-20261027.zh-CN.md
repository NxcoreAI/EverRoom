# slides-layouter 实际收到的「选型信号」实测快照（2026-10-27）

> 本文只记录**实测事实**：模型在一次 slides-layouter 调用里到底看到了什么。
> 不做"设计上应该看到什么"的推断；推断部分单独标注「推断」。
>
> 数据来源：本机 EverRoom 归档
> - 事件/调用：`~/Library/Application Support/EverRoom/database/gateway.sqlite`
> - 历史 run：`~/Library/Application Support/EverRoom/agent-debug/main/`
> - 样本：slides-layouter 共 597 次调用，其中 `completed` 384、`timed_out` 78、`failed` 56、`interrupted` 46、`cancelled` 33；日期 2026-10-23 ~ 2026-10-26；deck 为 20 页《锥光 CYPLORE 商业计划书》。
> - 复现命令见文末。

---

## 0. 一句话

模型实际拿到的"选型信号"只有三样东西：

1. **一段固定系统提示词**（= `agents/slides-layouter/SYSTEM.md` 全文，4473 字符，其中**没有任何组件名**）；
2. **4 个工具**（read / slides_layout_validate / slides_page_preview / subagent_submit_result）；
3. **一段 2.2k~9.9k 字符的 JSON**（语义内容契约 + styleTokens + 素材 + 邻页摘要）。

组件目录 `components.md` **不在上下文里**，要模型自己 `read`；没有任何字段告诉它"这页该用哪个组件"。

---

## 1. 一次调用的上下文拼装（代码可复现）

### 1.1 系统提示词

- 来源：`agents/slides-layouter/agent.yaml` 的 `systemPrompt: ./SYSTEM.md`，经 `apps/gateway/src/modules/subagents/runtime-manager.ts:337` 传给 pi runtime。
- 内容：**只有 SYSTEM.md**。子代理路径没有注入技能清单（`skillPrompts` 只对 builtin bundle 生效，`apps/gateway/src/modules/agent/builtin-bundles.ts:67`），`DefaultResourceLoader` 又关掉了 SDK 的技能发现（`packages/agent-runtime-pi/src/index.ts:874` 的 `noSkills: true`）。
- 实测体积：`context.usage` 事件里 `systemPrompt` 估算 616~1154 tokens（按 `chars/4` 估算，`packages/agent-runtime-pi/src/index.ts:1279`；随 SYSTEM.md 版本从 2464 字符到 4473 字符变化，对应 616→1154）。
- SYSTEM.md 里唯一指向组件库的一句在第 14 行：`开始时读取 skills/layout-tree-skill/SKILL.md`；SKILL.md:224 才写 `使用 component 时，先读 …components.md`。

### 1.2 工具（实测 `tools` 估算 447~611 tokens）

| 工具 | 模型看到的描述（摘录） | 参数 |
|---|---|---|
| `read` | 读取当前子 Agent Revision 中的 Skill 文件。path 用相对本 Skill 根目录的相对路径… | path / offset / limit；根目录=`agents/slides-layouter/`，单文件 ≤256KB |
| `slides_layout_validate` | 校验你设计的布局树：结构归一 → 确定性编译 → 量测。返回结构化缺陷清单（节点路径+缺陷类型+改法）… | token / tree |
| `slides_page_preview` | 把当前页的布局树编译成临时单页渲染图，返回确定性缺陷与设计审阅… | deckToken / pageIndex / tree |
| `subagent_submit_result` | 提交本次子 Agent 调用的正式结构化结果… | **= `output.schema.json` 全文（2193 字符）**：status / tree / notes / designIntent / bindings / reason / attempts / requestedAction |

注意：**输入 Schema（27k 字符）不发给模型**。它只在派发前做校验（`apps/gateway/src/modules/subagents/orchestrator.ts:476`），模型只看到实例 JSON。

### 1.3 用户回合（真实模板，逐字）

`packages/agent-runtime-pi/src/index.ts:1102-1116` + `apps/gateway/src/modules/subagents/orchestrator.ts:504-516`：

```text
当前工作区：Subagent: Slides Layouter
本轮没有可用的 Context Room 文档目标。
当前视口没有已确认的活动文档；若用户明确要求修改已有文档，应调用 document_list 触发选择。
本轮执行 ID：<invocationId>。这是同一对话中的一次全新工具执行。
历史对话只用于理解用户意图；历史 run 的 readReceipt、operationId、patchId、工具结果和工具错误均已失效，不得复用，也不得把历史错误当成本轮结果直接回复用户。
如果用户本轮明确要求创建、续写或修改文档，必须在本轮重新完成所需工具链。文档正文一律先经 document_draft 生成；修改或续写已有文档时不要先调用 document_read……（下略）

用户请求：
<everroom-subagent-task>
任务：单页布局
结构化输入：{"task":"layout","deckToken":"...","pageIndex":16,...}
结果提交：结束前必须调用 subagent_submit_result。只有该工具成功接收的参数会作为正式结果，最终文本不会被解析为结构化结果。
</everroom-subagent-task>
```

- 结构化输入是 **minify 后的 JSON**（`JSON.stringify(row.input)`），实测长度 2166~9895 字符，中位数 4126。
- 实测 `user` 段估算 ≈ 1036 tokens（设计轮）/ ≈ 3144 tokens（自审轮，多 `currentTree`）。
- 模板里的 Context Room / 活动文档 / 文档工具纪律三行与本任务无关，但确实在上下文里。

### 1.4 自审轮额外内容（384 次 completed 中 164 次）

`currentTree` + `previousDesignIntent`（67 次）+ 固定的 `revisionFeedback` 长句 + **本页渲染图（JPEG dataUrl 附件，走 pi images 而不是文本）**。
`revisionFeedback`（语义模式，逐字）：

```text
附件是 currentTree 的真实渲染图。按 SYSTEM.md「视觉自审」先记录图上观察，再逐项核对内容、焦点与关系、空白与容器、对齐与层级、断行与裁切、页脚页码；对照 previousDesignIntent 验收。自审只做一次：最多改 1 个根因、校验 1 次后提交；没有图上证据的问题不改，不要借自审探索新构图。保留全部内容，修正后防止原有表达退化。notes 写观察、修改或保留理由及待确认项；返回完整 tree、designIntent、bindings。无需修改则原样交树；修改版不会再次回投看图。
```

---

## 2. 一次真实调用的完整输入（原样）

数据：`subagent_invocations.id = efee66b4-82f1-4fe3-826a-7c7a8a287840`，2026-10-26，deck 第 17/20 页（pageIndex 16），`status=completed`。原始 minified 4441 字符，下面格式化展示：

```json
{
  "task": "layout",
  "deckToken": "47a51e5f-24f4-4e47-9f93-8ca5ebd8e530:layout",
  "pageIndex": 16,
  "totalPages": 20,
  "layoutVersion": 2,
  "content": {
    "id": "source-c8647b61edb3344039a1",
    "sourceRefs": ["source-c8647b61edb3344039a1:title", "source-c8647b61edb3344039a1:point-1", "source-c8647b61edb3344039a1:point-2", "source-c8647b61edb3344039a1:point-3", "source-c8647b61edb3344039a1:point-4", "source-c8647b61edb3344039a1:data", "source-c8647b61edb3344039a1:notes", "source-c8647b61edb3344039a1:materialHints"],
    "message": "ROADMAP 2026 ⟶ BEYOND：四阶段",
    "role": "flow",
    "blocks": [
      { "id": "p3-title", "sourceRefs": ["source-c8647b61edb3344039a1:title"], "priority": "primary", "mustShow": true, "type": "text", "text": "ROADMAP 2026 ⟶ BEYOND：四阶段" },
      { "id": "p3-point1", "sourceRefs": ["source-c8647b61edb3344039a1:point-1"], "priority": "supporting", "mustShow": true, "type": "text", "text": "阶段一 Performance Cycling｜Road / Gravel：轻量驱动 × 智能控制，商业模式 To C" },
      { "id": "p3-point2", "sourceRefs": ["source-c8647b61edb3344039a1:point-2"], "priority": "supporting", "mustShow": true, "type": "text", "text": "阶段二 More Bikes, More People｜Urban / Folding / Commuting：AI 运动感知，商业模式 To C + To B + 订阅" },
      { "id": "p3-point3", "sourceRefs": ["source-c8647b61edb3344039a1:point-3"], "priority": "supporting", "mustShow": true, "type": "text", "text": "阶段三 Personal Mobility｜Two / Three / Multi-form：自主移动智能，商业模式 To C + To B + 软件服务" },
      { "id": "p3-point4", "sourceRefs": ["source-c8647b61edb3344039a1:point-4"], "priority": "supporting", "mustShow": true, "type": "text", "text": "阶段四 Outdoor Exploration｜For a Wider World：人机环境感知，场景延伸" },
      { "id": "p3-table1", "sourceRefs": ["source-c8647b61edb3344039a1:data"], "priority": "primary", "mustShow": true, "type": "table", "headers": ["阶段", "营收目标"], "rows": [["阶段二", "3–5 亿美金"], ["阶段三", "5–10 亿美金"], ["阶段四", "10 亿美金+"]] },
      { "id": "p3-table2", "sourceRefs": ["source-c8647b61edb3344039a1:data"], "priority": "supporting", "mustShow": true, "type": "table", "headers": ["对标企业", "规模", "口径"], "rows": [["SHIMANO", "23.7 亿美元", "自行车核心部件"], ["GARMIN", "44.1 亿美元", "运动健身 + 户外业务（整体 72 亿美元）"], ["MAHLE SmartBike Systems", "30 万+套/年，约 7.5 亿美元+", "测算"], ["SWYTCH Bike Systems", "7500 万美元+", "测算-线上+欧洲"]] },
      { "id": "p3-source", "sourceRefs": ["source-c8647b61edb3344039a1:data", "source-c8647b61edb3344039a1:notes"], "priority": "detail", "mustShow": true, "type": "text", "text": "数据来源：Room 内《锥光 CYPLORE 商业计划书》素材；MAHLE 与 SWYTCH 为测算口径，各阶段营收目标为规划口径" },
      { "id": "p3-img", "sourceRefs": ["source-c8647b61edb3344039a1:materialHints"], "priority": "detail", "mustShow": false, "type": "image", "assetRef": "everroom-material://77e24d8c4dcec6c075dbd4a24e306f4842bdc2d06f3142b0c11302f22fdbb071", "alt": "黑色公路自行车后部特写", "fit": "cover" }
    ],
    "focusRefs": ["p3-title", "p3-table1"],
    "relations": [
      { "type": "precedes", "refs": ["p3-point1", "p3-point2", "p3-point3", "p3-point4"], "basis": "四阶段按 Performance Cycling → Outdoor Exploration 依次演进" },
      { "type": "supports", "refs": ["p3-table2", "p3-table1"], "basis": "行业对标规模支撑各阶段营收目标的成长空间" }
    ],
    "omissions": [
      { "sourceRef": "source-c8647b61edb3344039a1:materialHints", "reason": "素材提示为可选配图取材建议（四阶段路线图示意，或骑行场景向个人移动、户外探索延展的画面）；页面已用图片 block 呈现配图，不单独展示文字提示", "disposition": "omitted" }
    ],
    "constraints": { "verbatimRefs": [] },
    "notes": ""
  },
  "role": "flow",
  "density": "dense",
  "materials": [
    { "url": "everroom-material://77e24d8c4dcec6c075dbd4a24e306f4842bdc2d06f3142b0c11302f22fdbb071", "desc": "黑色公路自行车后部特写，呼应路线图起点骑行场景" }
  ],
  "neighbors": [
    { "role": "content", "message": "近期商业化路径：完成量产，持续扩大市场覆盖" },
    { "role": "content", "message": "核心团队：80 后 + 00 后，行业经验与创新思维碰撞" }
  ],
  "styleBrief": "强网格、克制留白、对齐严谨；内容页为纯白底、黑色正文，对比清晰，适合路演投影阅读；封面采用全屏图片铺满，图片上叠加浅色文字，与白底内容页形成明暗节奏；品牌色为近黑，图表主系列与标题统一使用黑色，整体克制商务；青灰蓝 #91bbc5 作为唯一强调色，用于关键指标、图表次系列与重点标注；标题加粗、正文常规，层级靠字重与留白区分，不使用装饰性卡片；页面留白充足，边距 64px、栏间距 24px，20 页信息密度下仍保持呼吸感；卡片圆角 6px、无阴影，仅用细分隔线组织信息，装饰语言保持弱化；配图按 cover 裁切铺满容器，保证 Room 内素材与全屏封面视觉完整",
  "styleTokens": {
    "composition": "swiss",
    "darkCover": true,
    "motif": { "kind": "none" },
    "palette": { "background": "#ffffff", "surface": "#f0f0f0", "primary": "#050709", "accent": "#5998a7", "text": "#050709", "textMuted": "#767778", "onDarkText": "#e6e6e6", "chartSeries": ["#050709", "#5998a7", "#767778", "#5c7f88"] },
    "typeScale": { "display": 60, "hero": 54, "h1": 40, "h2": 32, "h3": 26, "lead": 24, "body": 20, "label": 15, "kicker": 14, "caption": 13 },
    "fonts": { "heading": "PingFang SC", "body": "PingFang SC", "headingBold": true },
    "spacing": { "margin": 64, "gutter": 24, "cardPadding": 20, "cornerRadius": 6 },
    "decoration": { "cardStrokeWidthPt": 0.75, "cardShadow": "none", "divider": "line", "imageFit": "cover" },
    "componentDefaults": { "surface": "none", "separator": "line", "align": "start", "density": "tight", "numeral": "serif", "accent": "accent" }
  }
}
```

这页的最终输出（同一 invocation 的 `structuredOutput`）：

- `composition: "swiss"`；
- 节点：1 个 `h1` + 1 个 `caption` + 4 个等宽 `text body`（col 1-3 / 4-6 / 7-9 / 10-12，row 4-7）+ 2 个 `table`（左 4 列营收目标、右 8 列对标表，row 8-10）；
- **没有用 `timeline` / `steps` / `chevron` / `stats`**，虽然 `relations[0].type = "precedes"` 且语义上匹配；
- `designIntent` 原文（截断）：“目标：让「四阶段演进」成为第一眼结构，并让营收目标与行业对标形成可指认的支撑关系。依据：…第4–7行按 12 列均分四等宽文本带…形成 precedes 的横向阅读路径…第8–10行底部左右两块对照…relations.supports 由此可指认…”。

---

## 3. 384 次 completed 调用的字段分布（真实）

| 字段 | 出现次数 | 真实取值 / 规模 | 生产者 |
|---|---|---|---|
| `task` | 384 | 恒为 `"layout"` | `slides-layout-tail.ts:706` |
| `deckToken` | 384 | 不透明 token（`<uuid>:layout`），只给 validate 用 | 网关 |
| `pageIndex` / `totalPages` | 384 | 0 基页序 / 20 | 网关 |
| `layoutVersion` | 384 | 恒 2 | 网关 |
| `content.id` / `sourceRefs` | 384 | 来源页 hash 及其切片 | planner（semantic-v3） |
| `content.role` | 384 | content 191 / data 46 / closing 33 / flow 31 / toc 27 / cover 27 / section 13 / table 13 / quote 3 | planner |
| `content.message` | 384 | 页主标题 | planner |
| `content.blocks` | 384 | 每页 2~14 条，中位 6；类型：text 1771 / metric 242 / image 160 / table 84 / chart 5 | planner |
| `content.relations` | 384 | supports 170 / parallel 135 / precedes 50 / contains 39 / compares 33 / causes 13 / navigates 10，每条带 `basis` 文本 | planner |
| `content.focusRefs` | 384 | block id 数组 | planner |
| `content.constraints.verbatimRefs` | 384 | 0 条 378 次、1 条 6 次 | planner |
| `content.notes` | 384 | 非空 375 次，中位 64 字符（演讲备注，要求原样写回 tree.notes） | planner |
| `content.omissions` | 384 | 1 条 39 次、2 条 345 次（多为 materialHints/notes 转讲稿） | planner |
| `role` | 384 | 同 content.role（冗余一份） | 网关 |
| `density` | 384 | standard 207 / sparse 93 / dense 84 | planner |
| `materials` | 384 | 0 张 106 次、1 张 216、2 张 53、3 张 9；字段只有 `url` + `desc`，**349/349 没有任何 `aspectRatio`** | 网关素材库检索 |
| `neighbors` | 384 | 1 条 121 次、2 条 263 次；**每条只有 `{role, message}`** | 网关从语义页邻页取 |
| `styleBrief` | 384 | 189~295 字符，中位 262 | 风格卡 |
| `styleTokens` | 384 | 837~964 字符，中位 873 | 风格卡 |
| `revisionFeedback` | 177 | 固定长句（见 §1.4） | 网关 |
| `currentTree` | 164 | 上轮 v2 树 | 网关（自审回投） |
| `previousDesignIntent` | 67 | 上轮 designIntent | 网关（自审回投） |

**384 次里从未出现的字段**（旧内容模式才有）：`form`、`skeleton`、`units`、`composition`、`copy`、`data`、`budget`、`intent`、`takeaway`、`neighborSignatures`。
`slides-layout-tail.ts:706-720` 的语义分支只放行白名单，上述字段不进 semantic 请求。

---

## 4. 模型真实用它做了什么（行为统计，非猜测）

工具调用（事件表 `tool.started`，仅 slides-layouter，2026-10-23~26；590 个 run 有事件记录）：

| 工具 | 调用次数 | 覆盖 run |
|---|---|---|
| `slides_layout_validate` | 2261 | 500 / 597 |
| `read`（全部 skill 文件） | 1872 | — |
| ├ `skills/layout-tree-skill/SKILL.md` | 908 | 588 / 597 |
| ├ `skills/layout-tree-skill/components.md` | 441 | 416 / 597（70%） |
| └ `skills/layout-tree-skill/legacy.md` | 259 | — |
| `subagent_submit_result` | 656 | — |
| `slides_page_preview` | **0** | 0 |

- validate 平均 3.79 次/页，最多 45 次；>5 次的 run 有 116 个（提示词写"最多 4 次"，网关在第 5 轮强制收下，但计数器会重置，病态 run 仍能反复调用）。
- **384 页里只有 35 页（9.1%）用了任何组件**：`calloutBox` 17、`pointList` 14、`stats` 9、`agenda` 3、`timeline` 3。
- **10 个页面原子（founderProfile / radialFunnel / kpiRows / categoryCards / featureRail / sectionHeader / photoTriptych / competitorBoard / fullBleedQuote / financialBoard）使用次数为 0。**
- composition 分布：swiss 320（83%）、editorial 22、poster 17、immersive 10、chapter 6、hero-data 4、缺失 5。
- 读目录与用组件的关系：**用了组件的 35 页全部读过 components.md**；但另外 208 页读了目录也没用任何组件。

---

## 5. 三个真实决策样本（信号 → 选择）

| # | 输入信号（真实） | 实际选择 | 说明 |
|---|---|---|---|
| a | pageIndex 16 / flow / dense；`precedes`(4 阶段) + `supports`(对标→营收)；2 个 mustShow 表 + 1 张非必留图；focus=标题+营收表 | swiss；4 条等宽 text 带 + 2 个 table；**未用 timeline/steps** | 语义匹配不等于会选；模型用"等宽四带+表格主次"表达 |
| b | pageIndex 6 / flow / standard；2 条 `precedes`；5 条 text，focus=首尾；1 张图 | `pointList`(col1-8) + `calloutBox`(tint 底, col1-8) + 右栏 image(col9-12) | 用 pointList 的 `separator` 表达先后，仍然没用 timeline |
| c | pageIndex 17 / content / standard；`parallel`(4 位成员) + `supports`(创始人指标)；3 张图 + 4 个 metric | 4 条等宽 text 列 + `stats`(整宽 row6-7) + caption；**未用 teamGrid / persona**，图也没上 | 组件存在≠被选；materials 有图但未进树 |

样本 a/b/c 分别对应 `efee66b4-…`、`d234fc67-…`、`2661a50a-…`。

---

## 6. 结论：真实驱动选型的信号（按实测影响排序）

> 前 5 条是实测事实+直接观察；最后一条是推断。

1. **`content.blocks` 的类型与单条文本长度**——决定"装得下装不下"，实际强烈偏向 `text` + `table`（1771 text vs 84 table vs 5 chart）。
2. **`content.relations.type`**——提供形态线索，但**不决定**组件：`precedes` 出现 50 次，`timeline` 只用了 3 次；模型更愿意用等宽文本列/pointList 表达先后。
3. **`content.focusRefs` / `message` / `priority` / `mustShow`**——决定主焦点与面积，进而决定要不要组件（组件要大盘面）。
4. **`materials` 数量（无 aspectRatio）**——图槽类组件的前提；但实测素材常为 0~1 张，`featureCards`/`photoTriptych` 等图组件没有触发条件。
5. **`styleTokens` / `styleBrief`**——只影响 `style` 取值、字号与明暗，不改变组件类别。
6. **`role` / `density` / `neighbors`**——提示性信号。注意：`density` 在 384 次输入里都存在，但 **SYSTEM.md 与 SKILL.md 全文没有一处提到页面级 density**（`grep` 无命中），模型看到 `"density":"dense"` 却没有任何使用说明；`neighbors` 只有 role+message，信息量不足以做结构级避同。

## 7. 明确不存在的"信号"

- 组件清单 / 候选组件 / 组件推荐：无。context 里没有任何组件名，`components.md` 需模型主动 read。
- 上游的形态/骨架/组件建议：无（`form`/`skeleton`/`units`/`composition` 在 semantic 请求里全部缺席）。
- 图片长宽比：字段存在但**从未被填充**（`aspectRatio` 只有消费方 `slides-layout-tail.ts:691`，没有生产方）。
- 邻页几何 / 邻页图：无，只有 `{role, message}`。
- 页级预算明细：无，只有全局 caps 常量（48 元素 / 8 图 / 4 path，`layout-contract.ts:43`），且要在 validate 之后才以缺陷形式反馈。
- 渲染图：设计轮没有；只有自审回投轮有本页图。
- 「这页该用组件」的判据：无（`docs/slides-layout-batch2-plan.zh-CN.md:35-45` 自认此缺口）。

## 8. 采样局限

- 单一 deck（20 页 BP）、单一时间窗（2026-10-23~26）、当时 SYSTEM.md 为 2321→4473 字符。之后的 preview 工具、新组件、提示词改动可能改变行为。
- 统计只覆盖 `completed` 的 384 次；78 次超时、56 次失败、46 次中断、33 次取消的输入未计入行为统计（其输入字段分布与 completed 同构，但输出无树）。
- 组件使用率（9.1%）与 atoms 零使用是**该 deck + 该版本**的结果，不是全产品结论。

---

## 复现命令

```bash
DB="$HOME/Library/Application Support/EverRoom/database/gateway.sqlite"

# 1) 看某次真实调用收到的完整输入
sqlite3 "$DB" "select input from subagent_invocations where id='efee66b4-82f1-4fe3-826a-7c7a8a287840';"

# 2) 字段分布 / 组件使用率
python3 - <<'PY'
import sqlite3, json, os
db=os.path.expanduser("~/Library/Application Support/EverRoom/database/gateway.sqlite")
rows=sqlite3.connect(db).execute(
  "select input,result from subagent_invocations where agent_definition_id='slides-layouter' and status='completed'"
).fetchall()
def comps(res):
    d=json.loads(res).get("structuredOutput") or {}
    out=[]
    def walk(ns):
        for n in ns or []:
            if isinstance(n,dict):
                if n.get("type")=="component": out.append(n.get("name"))
                walk(n.get("children"))
    walk((d.get("tree") or {}).get("nodes")); return out
used=[c for _,r in rows if comps(r)]
print("completed:",len(rows),"pages with component:",len(used))
PY

# 3) 真实工具调用
sqlite3 "$DB" "select json_extract(payload,'\$.name'), count(*) from subagent_invocation_events where type='tool.started' group by 1 order by 2 desc;"
```

---

## 修复后状态（2026-10-27，与上文快照的差异）

本文主体是修复前的实测快照，保留不动。以下改动已落在工作区，后续复测请以这里为准：

| 项 | 修复前 | 修复后 |
|---|---|---|
| `materials.aspectRatio` | 从未填充（349/349 缺失） | `layouterInputFor` 用同一份 `imageArs` 回填（宽/高，保留 3 位小数）；网关测试覆盖 |
| 页面级 `density` | 传了但提示词无说明 | SYSTEM.md 增加口径：`sparse` 单焦点少容器、`dense` 优先结构化承载 |
| 组件选型判据 | 只有"按信息语义选择"一句 | SYSTEM.md 增加形态→候选组件、表格边界、先留槽位、未用组件写理由 |
| 组件槽位 | 只有条目上限/约几元素 | 权威正文两张组件表增加「槽位下限（列×行）」列（随 `scripts/render-layout-skills.mjs` 生成到 components.md） |
| 溢出缺陷 `hint` | 通用「调整权重/比例或精简内容」 | 组件溢出时按真实展开器反推本页最小槽位，输出「至少需要约 W×Hpx（c 列 × r 行，当前 …）」；`CompileDefect.hint` 透传到 validate |

未做（按原计划留待下一步）：组件载荷宽容化、语义模式的图形丰富度闸门、确定性升级 pass、A/B 复测。

