# 论文排版 v2：模板剖面 + 槽位映射

状态：**已实施（M1–M5 全部落地）** · 2026-10-27

实施清单（逐里程碑提交，均在本地未推送）：

| 里程碑 | 提交 | 内容 |
|---|---|---|
| M1 模板剖面 | `d0d3c929` | 正文大纲→槽位、编号方案、样式锁、TemplateProfile |
| M2 内容剖面 | `b76cc055` | 归一化/编号剥离/角色推断/锚点/题注配对 |
| M3 映射引擎 | `6d849649` | R0–R5 阶梯、similarity、块守恒断言、待裁决钩子 |
| M4a 接管线 | `4625e801` | 有剖面即走确定性映射，装订不再派代理 |
| M4b 未归类渲染 | `2870e784` + 子模块 `1d22a05` | 未匹配内容→文末独立小节 + 红字/黄底高亮 |
| M4c 生成后自检 | `9f6f75be` | 6 项自检，硬伤不出稿 |
| M5 UI | `7f5ed5ba` | 映射报告展示 + 删除模版文件按钮（保留格式卡） |
| 编号重算 | `7e1e6b1`（子模块）+ 网关下发 | 渲染器按模板方案生成编号（cn-upper/decimal-tree/none），标题送干净文本 |
| 代理裁决接线 | 见下 | `adjudicate_mapping` 任务 + schema/提示词 + 结果消毒 + 失败回落 |

**实测（Room 内真实模版 × 真实内容）**：9 个槽位 × 62 个块 → 守恒 62/62（零丢失）、
19 个章节（含二级）送渲染器、6 条隶属顺序推断进「建议核对」、3 条模板缺口如实上报。

**使用前提**：剖面在**解析模版时**生成并挂在格式卡上。已存在的旧格式卡没有
`profile`，会回落原代理路径；**重新上传/解析一次模版**即可启用 v2。

拍板结论（2026-10-27）：①未匹配内容 → 追加到正文末尾独立章节；②章节不匹配 →
顺序对齐 + 追加兜底；③编号 → 按模板重算；④删除语义 → **不删格式卡**，另加
「删除模版文件」按钮；⑤范围 → 仅 docx。

本文替代当前"区间映射"管线（`bind_thesis` → `chapters[{blockStart, blockEnd}]`）。
目标是把排版从「照内容重排」改成「**套模板**」：模板的固定元素锁死，章节做成槽位，
内容按标题语义落进槽位，**未匹配内容单独标记、一块都不丢**。

---

## 1. 为什么现在做不到"按模板排版"

当前链路（可对照代码）：

```
模版 docx ──extractOoxmlFacts──> facts{styles,sections,headers,footers,coverText,coverImages}
        └─parse_template(代理)─> ThesisFormatCard{page,base,header,headings,cover,...}
内容 docx ──describeThesisBlocks──> 扁平块数组[{index,kind,level?,text}]
        └─bind_thesis(代理)────> bindingSpec{chapters[{blockStart,blockEnd}],...}
        └─buildThesisDocx──────> 输出 docx（封面/摘要/目录重建 + 区间内块重排）
```

结构性缺陷（不是 bug，是模型本身不够）：

| # | 缺陷 | 代码位置 | 后果 |
|---|---|---|---|
| D1 | **模板的章节骨架从未被提取** | `ooxml-facts.ts` 只抽 styles/sections/hf/封面，不抽正文大纲 | 不知道模板有哪些章节，无从"套槽位" |
| D2 | **映射是索引区间** | `ThesisBindingSpecInput.chapters[{blockStart,blockEnd}]` | 区间外的块**静默丢弃**；区间切错就整段消失 |
| D3 | **样式只有 4 级标题 + 正文** | `headings[{level,font,align,numbering}]` | 题注、图注、表格文字、列表、公式、脚注无独立锁 |
| D4 | **编号不提取** | `numbering: 'numeric-tree' \| 'none'` 二选一 | 复刻不出「一、（一）1.1.1」这类模板编号 |
| D5 | **没有"未匹配"容器** | 全链路无此概念 | 用户明确要求：未匹配内容不能丢 |

真实数据佐证（同一 Room 实测）：

- 模板《人工智能创新创业实践课程设计报告(模板）.docx》章节：`一、项目任务 / 二、项目需求分析 / 三、项目系统设计 / 四、项目概要设计 / 五、项目模块详细设计 / 六、项目测试结果 / 七、项目总结与展望 / 参考资料 / 附录`
- 内容《开题与需求、系统设计报告.docx》共 **62 块**（list 28 / heading 19 / table 8 / paragraph 7），标题是 `一、业务场景分析 / 1.1 政策与业务背景 / 二、需求梳理 / 2.1 用户角色 …`

两者的章节名**对不上**（业务场景分析 vs 项目任务），层级也错位（源 H2/H3，模板 H1 级章节）。
所以规则必须是「**语义匹配 + 顺序回退 + 追加兜底**」三层，纯字符串匹配必然失败。

---

## 2. 不变量（实施时必须成立，写进测试）

| ID | 不变量 | 验收方式 |
|---|---|---|
| I1 | logo 字节级不变 | 输出 docx 里 logo media 的 sha256 == 模板的 sha256 |
| I2 | 页眉/页脚按模板事实回填（含图片、横线、页码域） | 部件存在性 + 图片 sha256 |
| I3 | **块守恒**：源文档每个可见块必须出现且仅出现一次（槽位内 / 未归类容器） | 输出块计数 = 模版生成块 + 源块 + 标记块；且每块有 traceId |
| I4 | 所有样式来自模板剖面；源样式只当"语义线索" | 抽样段落 rPr/pPr 与模板锁一致 |
| I5 | 引擎只做确定性渲染，不做语义判断 | 代码评审：genoffice 侧不出现"猜"的逻辑 |

> I3 是本方案的关键。当前实现**无法**满足 I3（区间外直接丢），这正是用户抱怨的"内容丢 / 没按模版"的根源。

---

## 3. 架构：四段式

```
            ┌──── 网关（确定性抽取）────┐        ┌── 代理（语义）──┐
模板 docx ─>│ TemplateProfile (固定元素+槽位) │
内容 docx ─>│ ContentProfile  (块+标题语义)  │
            └───────────────┬────────────┘
                            │ 两侧剖面
                            ▼
                   MappingPlan（槽位 ↔ 内容 的分配表 + 未匹配清单）
                            │
                            ▼
                   RenderPlan（有序渲染指令）
                            │
                            ▼  桌面 genoffice（纯渲染）
                        输出 docx + 映射报告
```

| 阶段 | 输入 | 输出 | 谁做 | 失败处理 |
|---|---|---|---|---|
| A 模板剖面 | 模板 docx | `TemplateProfile` | 网关确定性 + 代理补语义标签 | 抽不到就报 `templateFactsGaps`，不静默 |
| B 内容剖面 | 内容 docx | `ContentProfile` | 网关确定性（标题归一/编号剥离/块分类） | 空文档 → 明确报错 |
| C 映射 | 两个剖面 | `MappingPlan` | 规则引擎（确定性）为主，代理只裁决低置信区间 | 低于阈值 → 进"未归类"，不丢弃 |
| D 渲染 | RenderPlan | docx + 报告 | 引擎 | 自检失败 → 报错并保留中间产物 |

**分工原则**：能算的用算（序号、对齐、编号、哈希），只能理解的交给代理（"业务场景分析"≈"需求分析"），
且代理只输出**分配决策**，不输出文档内容——避免模型抄错字、烧输出预算。

---

## 4. 数据结构

### 4.1 TemplateProfile（模板剖面）

```ts
interface TemplateProfile {
  version: 2
  sourceName: string
  /** 固定元素：整篇不变、逐字逐字节锁定 */
  fixed: {
    page: { widthMm; heightMm; margins{top,bottom,left,right}; gutterMm }
    /** 图片：封面校徽 / 页眉 / 页脚 / 水印（衬底） */
    logos: Array<{ role: 'cover'|'header'|'footer'|'watermark'; sha256: string; dataUrl: string;
                    widthPx; heightPx; floating; behind; posH; posV; posXPx; posYPx; posHRel; posVRel }>
    header: { enabled; template: string; font: FontLock; underline: boolean; skipOnCover: boolean }
    footer: { enabled; font: FontLock; frontMatterFormat: 'roman'|'decimal'; pageFieldFormat: string }
    /** 样式锁：key 是被内容引用的语义名，不是模板里的 styleId */
    styles: Record<StyleKey, StyleLock>
    /** 编号方案（从 word/numbering.xml + 标题样式的 numPr 反推） */
    numbering: { scheme: 'cn-upper'|'cn-lower'|'decimal-tree'|'decimal-dot'|'none';
                 levels: Array<{ level: 1|2|3|4; fmt: string; text: string; start: number; indentTwips: number }> }
    /** 封面版式：字段行（用表格还是段落、居中与否、间距） */
    coverLayout: { mode: 'fields'|'table'; rows: Array<{ label: string; key: string; labelFont; valueFont }> }
    toc: { enabled: boolean; levels: string; titleFont; dotLeader: boolean }
  }
  /** 槽位：模板章节骨架，按输出顺序排列 */
  slots: ThesisSlot[]
}

type StyleKey =
  | 'body' | 'h1' | 'h2' | 'h3' | 'h4'
  | 'caption'        // 图表题注
  | 'tableText'      // 表格内文字
  | 'listItem'       // 列表项
  | 'formula'        // 公式所在段落
  | 'abstractTitle' | 'abstractBody' | 'keywords'
  | 'referencesItem' | 'quote'

interface StyleLock {
  font: { eastAsia; ascii; size; bold; italic?; color? }
  paragraph: { align; firstLineIndentChars; lineSpacingMultiple?; lineSpacingExactPt?; spaceBeforePt; spaceAfterPt }
  /** 从模板实际段落采样的"指纹"，用于生成后自检 */
  sampleFingerprint: string
}

interface ThesisSlot {
  id: string                       // 稳定 id，写进 trace
  kind: 'cover' | 'commitment' | 'abstract_zh' | 'abstract_en' | 'toc'
      | 'body'                     // 正文章节组（可扩展，容量 many）
      | 'reference' | 'appendix' | 'acknowledgement' | 'other'
  /** 模板里该槽位的原样标题（如「二、项目需求分析」），用于匹配与展示 */
  title: string
  /** 归一化后的匹配特征（见 §6.1） */
  matchKey: { normalized: string; tokens: string[]; anchor?: string }
  /** 该槽位的层级（正文槽位才有） */
  level?: 1|2|3|4
  /** 生成时用的样式 key */
  styleKey: StyleKey
  /** 是否在输出里生成模板原标题（固定槽位 true；body 槽位由内容标题替换） */
  emitTemplateTitle: boolean
  /** 容量：single=一个源章节；many=可继续吸收（body 分组用） */
  capacity: 'single' | 'many'
  order: number
}
```

> 关键设计：**模板正文大纲就是槽位骨架**。「一、项目任务…七、项目总结与展望」会被抽成 9 个 slot，
> 其中 body 类槽位声明 `capacity: 'many'`，允许源章节数量与模板不一致时追加。

### 4.2 ContentProfile（内容剖面）

```ts
interface ContentProfile {
  version: 2
  blocks: ContentBlock[]            // 与 describeThesisBlocks 同序，但更富
}

interface ContentBlock {
  traceId: string                   // 贯穿到输出，保证 I3 可验证
  index: number                     // 源 docx 块序号（透传用）
  kind: 'heading'|'paragraph'|'list'|'table'|'image'|'formula'|'caption'
  level?: number                    // 原始 outline 层级
  /** 章节角色：由"归一化 + 序列位置"推出，不直接用原始 level */
  role?: 'chapter'|'section'|'subsection'|'body'
  text: string
  /** 归一化：去编号前缀、全半角统一、压缩空白、去尾部标点 */
  normalized?: string
  /** 识别到的原编号（"一、"、"1.1"、"（2）"），用于剥除与诊断 */
  originalNumber?: string
  /** 结构特征：表格行列数、图片尺寸、列表项数 */
  metrics?: { rows?: number; cols?: number; widthPx?: number; heightPx?: number; items?: number }
  /** 图表是否带题注（相邻块判定） */
  captionOf?: string
}

interface ContentDocMeta {
  /** 文档级语义锚点：命中即直达对应槽位 */
  anchors: { abstractZh?: blockRef; abstractEn?: blockRef; toc?: blockRef;
             references?: blockRef; acknowledgement?: blockRef; appendix?: blockRef }
  chapters: ChapterNode[]           // 树形章节结构
}
```

### 4.3 MappingPlan（映射计划）

```ts
interface MappingPlan {
  assignments: Array<{
    slotId: string
    /** 源章节（单个）或块组（容器槽位） */
    source: { headingBlockId?: string; blockRange: [number, number] }
    /** 生成时用哪个样式 key；与槽位默认不同时说明降级原因 */
    styleKey: StyleKey
    confidence: number              // 0–1
    rule: 'R0-anchor'|'R1-title'|'R2-order'|'R3-fuzzy'|'R4-append'|'R5-single'
    /** 需要人工注意的降级说明（进报告与 UI） */
    notes: string[]
  }>
  /** 未匹配：必须渲染，不得丢弃 */
  unmatched: Array<{
    reason: 'no-slot'|'slot-taken'|'below-threshold'|'orphan-block'|'unknown-kind'
    blockRange: [number, number]
    nearestSlotId?: string
    note: string
  }>
  /** 块级守恒核对：Σassignments.blocks + Σunmatched.blocks == contentProfile.blocks.length */
  conservation: { matched: number; unmatched: number; total: number }
  gaps: string[]                    // 模板侧缺口（沿用 templateFactsGaps）
}
```

### 4.4 与现有 `ThesisFormatCard` 的关系

`ThesisFormatCard` 保留，降级为 **TemplateProfile 的投影**：

- `page/base/headings/abstract/toc/references/cover` → `fixed.page / styles / coverLayout / toc`
- `header.images`、`cover.logo` → `fixed.logos[]`
- 新字段 `slots[]` 是**新增**，老卡片读到时用「无 slots 模式」（走现有区间逻辑）以保证兼容。

---

## 5. 模板解析：固定元素 + 槽位

### 5.1 固定元素提取（扩展 `ooxml-facts.ts`）

| 元素 | 来源 | 算法要点 |
|---|---|---|
| 页面/页边距/装订线 | `w:sectPr/pgSz,pgMar` | 已有 |
| 页眉/页脚文字+图片 | `header*.xml / footer*.xml` + 各自 rels | 已有（`hfImages`）；新增把 `w:pict/v:shape` 的文本框也纳入 |
| 封面 logo | `document.xml` 首节内的 drawing | 已有（`coverImages`） |
| **水印/衬底图** | drawing 的 `behindDoc=1` 或 `v:shape` 于 header | 新增：判 `behind`，记 `role:'watermark'` |
| **样式锁** | `styles.xml` + **正文实际用量采样** | 新增：对每个语义 key，取模板中**使用该样式的段落**的 rPr/pPr 作为锁（比 style 定义更准），存 `sampleFingerprint` |
| **题注/表格/列表/公式样式** | 正文采样 | 新增：按段落特征分类（紧邻图片且含"图 1"式文本→caption；在 tbl 内→tableText；带 numPr 且非标题→listItem；整段仅 OMML→formula） |
| **编号方案** | `numbering.xml` + 标题样式 numPr | 新增：解析 `numFmt/lvlText/start/indent`，归一到 `numbering.scheme` + `levels[]` |
| **章节骨架 → 槽位** | `document.xml` 正文标题序列 | 新增：`outlineBlocks()` 抽出模板自身 H1..H4 序列（排除封面区），每个 H1 级 = 一个 body 槽位候选；`摘要/目录/参考文献/致谢/附录` 命中锚点词典的升级为 fixed 槽位 |

**槽位识别规则（模板侧）**：

1. 取模板正文（封面区之后、`sectPr` 之前）的标题序列，按 outline 层级建树。
2. 顶层（最高层）标题逐个成为 `kind:'body'` 槽位，`emitTemplateTitle: false`（正文标题用内容原文标题套样式），`capacity:'many'`。
3. 顶层标题命中锚点词典 → 升级为 `abstract_zh / abstract_en / toc / reference / appendix / acknowledgement` 固定槽位，`emitTemplateTitle: true`（这些标题在模板里是固定文案，如「参考资料」「附录」）。
4. 模板若**没有**正文骨架（只有样式条款的规范文件）→ slots 只含固定槽位 + 一个兜底 body 槽位（`matchKey` 为空、`capacity:'many'`），映射全部走 §6.10 的追加规则。

### 5.2 何时让代理介入

代理只做两件事，输入输出都很小：

1. 给每个槽位产 `matchKey.tokens`（从标题里取"实词"，去掉"分析/研究/概述"等虚词）+ 一句 `intent`（≤40 字）。
2. 给低置信度映射做一次性裁决（§6.9），输入是「N 个源标题 × M 个空槽位 + 各自 tokens」，输出最多 N 个决策行。

代理**不产出**任何正文、样式、编号——这几项全确定性。

---

## 6. 映射规则设计

### 6.1 归一化（所有比较的前提）

```
normalize(title):
  1) 剥离编号前缀：^[（(]?[\d一二三四五六七八九十百]+[)）、\.．]\s*  与  ^\d+(\.\d+)*\s*
     （"一、业务场景分析"→"业务场景分析"；"1.1 政策与业务背景"→"政策与业务背景"；"（2）模型"→"模型"）
  2) 全半角统一（NFKC）+ 繁转简 + 大小写折叠
  3) 删除空白、书名号外的标点、末尾标点
  4) 生成 tokens：中文按 2-gram 切（"业务场景"→[业务,务场,场景]）+ 英文按词；去停用词
```

### 6.2 匹配阶梯（按优先级串行尝试，命中即消费）

| 规则 | 条件 | 动作 | 置信度 | 打标 |
|---|---|---|---|---|
| **R0 锚点** | 归一化标题 ∈ 锚点词典（含同义词）且该槽位未被占用 | 分配到对应固定槽位 | 0.98 | — |
| **R1 精确标题** | `normalize(src) == slot.matchKey.normalized` | 分配 | 0.95 | — |
| **R2 顺序对齐** | 源章节按序 + 模板 body 槽位按序，**且数量相符**（或源多但模板 body 可 many） | 依次 1:1 分配（跳过已占用） | 0.85 | — |
| **R3 模糊** | `similarity(src, slot) ≥ 0.62` 且槽位空闲 | 分配高分者（贪心，一对多则按分值） | 0.62–0.85 | 低于 0.75 记 note |
| **R4 追加** | 仍有未分配源章节 | 追加到 `body` 容器槽位末尾（沿用同级样式） | 0.6 | 「模板无对应槽位，已追加」 |
| **R5 孤立块** | 首标题之前 / 槽位之外的散块 | 归到最近的**前一个**已分配槽位内（无前则 `other` 容器） | 0.5 | 「前置于首个章节的内容」 |

`similarity`：

```
sim = 0.50 * jaccard(tokens_src, tokens_slot)
    + 0.20 * numberCompat(原编号体系是否同类：一/1./（一）)   // 同类=1 不同=0
    + 0.20 * orderCompat(相对序号差 ≤1 → 1；≤2 → 0.6；else 0)
    + 0.10 * anchorBonus(命中同义词表 → 1)
```

> 顺序一致性占 0.2 权重是关键：中文论文模板的章节顺序高度一致，即使标题措辞不同，
> "第二个 H1 对第二个槽位"通常是对的。这能救住"业务场景分析 → 项目需求分析"这类情况。

### 6.3 锚点词典（固定槽位，双向同义词）

| 槽位 | 锚点（正则，归一化后匹配） |
|---|---|
| abstract_zh | `^摘\s*要$`, `内容摘要`, `中文摘要` |
| abstract_en | `^abstract$`, `summary` |
| toc | `^目\s*录$`, `^contents$` |
| reference | `^参考文献$`, `^参考资料$`, `^引用文献$`, `^bibliography$` |
| acknowledgement | `^致\s*谢$`, `^谢\s*辞$`, `鸣谢`, `acknowledg` |
| appendix | `^附\s*录.*$`, `^appendix` |
| commitment | `^诚信承诺书$`, `^原创性声明$`, `^授权书$` |

### 6.4 层级映射

**先把两侧都归到"角色层"，再对齐**：
`role` = 该块在本文大纲中的相对深度（首个章节层 = `chapter`，其下 = `section`，再下 = `subsection`）。

- 源 `chapter` → 槽位 `level 1` 的 styleKey（`h1`）
- 源 `section` → 模板若存在 H2 锁用 `h2`；不存在则用 `h1` 的**降级变体**（同字体、字号 -2pt、左对齐），并在 note 写「模板无二级标题样式，已按一级样式降级」
- 源层级比模板深 >2 级 → 一律用最深可用级 + note（不新增样式，避免破坏模板观感）

### 6.5 数量不匹配

| 情形 | 处理 |
|---|---|
| 源章节 = 模板槽位数 | R2 顺序对齐（最理想） |
| 源章节 **多** | 前 M 个走 R2/R3，其余 R4 追加到 body 末尾；报告里列"追加章节" |
| 源章节 **少** | 模板多余槽位**不生成空标题**（否则出现"四、项目概要设计"下面空着）；`emitTemplateTitle` 对空槽位置 false，只保留其样式锁供后续使用 |
| 源把两章合并成一张 | R3 会让其中一个源章节占用一个槽位，另一个进 R4 追加 → 内容不丢，报告提示"疑似合并章节" |

### 6.6 编号处理

1. 源标题的编号前缀**剥除**（`originalNumber` 留档，仅用于诊断与 similarity）。
2. 输出编号由 `fixed.numbering` 重新生成：`numeric-tree` → `1 / 1.1 / 1.1.1`；`cn-upper` → `一、/（一）/1.`。
3. 生成方式：写 `w:numPr`（`numId` 指向模板 `numbering.xml` 的既有定义，没有则按 `fixed.numbering.levels` 现场生成一份）——**不用手工拼文本**，这样 Word 里编号是活的、可续排。
4. 模板 `scheme: 'none'` → 不生成 `numPr`，保留源标题文字但剥除原编号（避免"1.1 1.1 背景"重号）。

### 6.7 段落级落位（章节内部）

| 源块 | 输出 | 样式 |
|---|---|---|
| paragraph | 生成段落 | `styles.body` |
| list（含 numPr） | 生成段落 + 沿用源 `numPr` 层级 | `styles.listItem` + 列表编号 |
| table | **原文透传**（保留表格样式/合并单元格字节） | 不改 |
| image | 原文透传（或生成块引用原 media） | 不改 |
| image + 紧邻"图 X"文本 | image 透传 + caption 生成 | `styles.caption` |
| 仅 OMML | 原文透传 | `styles.formula` |
| caption（表/图题） | 生成 | `styles.caption` |

### 6.8 未匹配内容的三个桶（**不丢**）

| 桶 | 触发 | 落点 | 可见标记 |
|---|---|---|---|
| U1 槽位内孤立块 | 块在已分配区间内但类型不认识 | 原位置保留（透传或生成） | 段首加 `〔未识别格式〕` 前缀，黄色高亮 |
| U2 整章未匹配 | R4 追加 / R5 兜底 | 追加到正文末尾，标题写 `其他内容：<源标题>`（或并入 `other` 槽位） | 标题行黄色高亮 + 批注「模板无对应槽位」 |
| U3 映射报告 | 任何 note/gap | 不出现在正文 | UI 弹窗 + 文末"排版报告"章节（可选开关） |

**标记的 OOXML 落地**：`Run{ color:'C00000', highlight:'yellow' }` + `w:commentRangeStart/End`（批注正文写原因），
保证在 Word 里一眼能找、且能被"接受/删除"。

**守恒断言（I3）**：渲染前校验
`Σ assignments.blockRange 覆盖的块 ∪ Σ unmatched.blockRange == profile.blocks.length`，
不相等直接抛 `thesis_mapping_not_conservative`，**宁可不生成也不丢内容**。

### 6.9 低置信度的代理裁决（可选，第二阶段）

仅当 `0.4 ≤ sim < 0.62` 或出现"一个槽位被 2+ 源章节争抢"时触发：
输入 `{slots:[{id,matchKey,intent}], candidates:[{traceId,normalized,level,order}]}`（通常 < 3KB），
输出 `[{sourceId, slotId|null, reason}]`。代理**不得**返回正文。
仍为 `null` 的进 R4 追加。

### 6.10 无骨架模板（规范条款型）

模板只有样式条款、没有章节 → slots 只有固定槽位；全部源章节 R4 追加到 `body`，
标题套 `h1/h2/h3` 锁。此时"按模板排版"= 只套样式与页面，不改内容顺序——与现有行为一致。

---

## 7. 渲染与自检（桌面侧）

### 7.1 图片通道（I1）

- 模板 logo 的字节在解析阶段算 `sha256` 并随 profile 传递；渲染时**复用同一字节**写入 `word/media/`（按 hash 去重），
  页眉/页脚/封面分别建 rels，drawing 的 `wxh` 取模板原始 EMU（不做 px 往返换算，避免 ±1px 漂移）。
- 生成后自检：重新打开输出 zip，对每个 `role` 的 media 计算 hash，与 profile 比对，不等 → 报 `thesis_logo_bytes_changed`。

### 7.2 渲染顺序（RenderPlan）

```
[封面（含 cover logo）] → [承诺书] → [中文摘要] → [英文摘要] → [目录] →
[前置节 sectPr(roman)] → [body: 槽位顺序 × 章节（标题+段落+透传块）] →
[参考文献] → [致谢] → [附录] → [未归类容器] → [正文节 sectPr(decimal)]
```

### 7.3 生成后自检清单

1. 块守恒（I3）
2. 每个 logo hash == 模板（I1）
3. 页眉/页脚部件存在 + 图片 hash（I2）
4. 抽样 5 段正文 + 各级标题，rPr/pPr 与 `StyleLock.sampleFingerprint` 一致（I4）
5. 目录域存在且 levels 正确（若模板有目录）
6. 编号：抽查前 3 个章节的 `numPr.numId` 与层级

任何一项失败 → 抛出带明细的错误，不产出"看起来正常"的文件。

---

## 8. 删除已上传模版的按钮

现状：`removeCard` IPC + card store 已具备；AI 页签面板有删除，**产物区「排版工具」弹窗没有**。

方案：

1. 弹窗里每个模版行右侧加 `🗑`（hover 显示），点击 → 行内二次确认（「删除模版？不会影响已生成的文档」）→ `thesisFormat.removeCard(roomId, cardId)` → 刷新列表 + toast。
2. 若该模版**同时是资料区文件**（`sourceFileEntryId != null`），确认框多一个勾选「同时把模版文件移入回收站」（默认不勾）。
3. **顺带修数据脏点**：实测 `room_source_memberships` 里存在指向已删除文件的悬空引用（如 `file-9bbf3f04`、`file-dbb064db` 已不在 `file_entries`）。删除模版时顺手清该 Room 的悬空成员行，并在资料/产物列表过滤掉 `catalogEntry == null` 的成员。
4. 空态：没有模版时显示「还没有模版」+ 上传按钮（已有）。

---

## 9. 实施拆分

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1 模板剖面（确定性抽取）** | 正文大纲 → slots；样式锁采样；题注/表格/列表分类；编号方案解析 | 单测：给定模板 docx，slots 数量/标题/层级正确；编号 scheme 识别正确；封面 logo hash 稳定 |
| **M2 内容剖面** | 归一化（编号剥离/NFC/token）；role 推断；锚点识别；图表题注配对 | 单测：`一、业务场景分析`→normalized `业务场景分析`；62 块全部有 role/kind |
| **M3 映射引擎（规则）** | R0–R5 + similarity + 守恒校验 + MappingPlan | 单测：用户真实两份文件的映射表符合预期；构造"源多/源少/重名/合并"四类边界；守恒断言在人为丢块时抛错 |
| **M4 渲染** | RenderPlan → buildThesisDocx v2；图片字节通道；未匹配标记（highlight+comment）；自检 | 集成：输出 docx 通过 6 项自检；logo hash 相等；未匹配段落可见高亮 |
| **M5 UI** | 产物区弹窗接入映射报告（匹配数/未匹配数/追加章节）+ 删除模版按钮 | 手测：报告可展开看每条 note；删除有二次确认 |

依赖顺序：M1/M2 可并行 → M3 依赖两者 → M4 依赖 M3 → M5 最后。

---

## 10. 风险与取舍

| 风险 | 取舍 |
|---|---|
| 模板章节骨架抽取不稳（有些模板用表格排版、无真标题） | 抽出 0 个槽位时降级到 §6.10 全追加模式，报告里明确说"未能识别模板章节" |
| 中文标题语义匹配准确率 | 顺序权重 0.2 + 代理裁决兜底；宁可"追加"也不硬塞错槽位（错塞比追加更难发现） |
| 图片字节往返 | 只用 hash + 原字节，不做重编码；SVG/EMF 原样透传 |
| 老格式卡兼容 | 无 `slots[]` 的卡片走旧区间逻辑，v2 生效以卡片版本号切换 |
| 输出块数校验误报（表格内部块） | 守恒以"顶层块"为单位，表格/图片整体计 1 |

---

## 11. 需要你拍板

1. **未匹配内容的呈现**：A) 追加到正文末尾独立章节（推荐，最安全）B) 就地保留在原章节内并高亮 C) 只出报告、正文不留（不推荐，等于丢）
2. **章节不匹配时**：宁可按顺序硬套（前 N 个对齐），还是宁可"追加"不硬套？（我倾向：R2 顺序对齐 + 追加兜底，两者都给 note）
3. **编号**：输出编号一律按模板重算（推荐），还是允许"保留源编号体系"开关？
4. **删除按钮**的语义：只删格式卡（模版配置）还是连资料区那份模版文件一起删？默认只删卡、文件另给勾选，可否？
5. **范围**：先只做 docx 论文（当前），还是这轮就要覆盖"有表格章节骨架"的模板（如某些学校用表格排封面字段/目录）？

确认后我按 M1→M5 顺序实施，每个里程碑带回归测试与实测样本（就用 Room 里这两份真实文件）。
