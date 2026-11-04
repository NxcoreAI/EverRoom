# Agent 对 Word 文档完整编辑方案

> 状态：已落地（M1–M5，2026-10-30）；实现说明见 `docs/word-agent-editing-implementation.zh-CN.md`  
> 日期：2026-10-17（设计）/ 2026-10-30（落地）  
> 关联工程：EverRoom 主仓（网关 documents 模块、桌面 office-bridge）、genoffice 子模块（docx-engine、docs 应用）

## 1. 方案结论

本方案让网关 agent 能对已有 docx 产物做增量编辑。目标：agent 读入一份 docx，改文字、改格式、调结构，写回原文件。未修改的部分一字节不动。

做法：不新造引擎，不新造命令集。复用三块既有资产：

1. docs 应用内的块模型与 AI 工具词汇（18 个工具、11 类命令）；
2. docx-engine 的增量落盘 saveDocx（`packages/docx-engine/src/patch.ts`）；
3. 桌面 office-bridge 接口体系（office-generate / office-reformat / office-edit 已有先例）。

扩展 `/v1/office-edit`，使其除 slides 外支持 docx。能力宿主仍是桌面 office-bridge。网关只做客户端。

默认「建议模式」：agent 的修改以修订（tracked changes）形式写入，用户在审阅页接受或拒绝。用户明确要求直接修改时才直写。

## 2. 现状与差距

### 2.1 已有资产

**资产一：docs 应用内嵌 AI**（`apps/desktop/vendor/genoffice/apps/docs/src/renderer/ai/tools.ts`）。工具 18 个：

| 类别 | 工具 |
|---|---|
| 读 | get_document_context、read_blocks（分页）、read_revisions、read_comments |
| 写 | insert_content、replace_blocks（受限 HTML）、apply_commands（命令数组） |
| 资产 | web_search、image_search、insert_image、generate_image、insert_chart、edit_chart |
| 文档级 | set_header_footer、create_document |
| 协作 | reply_comment、resolve_comment |

apply_commands 的命令词汇：文本样式、段落格式、标题级别、全文替换、删块、移块、列表转换、图片属性、插目录。

**资产二：docx-engine**（`packages/docx-engine/src/`）。能力由模块清单可见：

1. patch.ts 的 saveDocx：增量 OOXML patch。JSZip 读原包，未变部分保留原始字节。
2. text-patch.ts：段落级外科手术式替换。段落数变化时整条重建。
3. 修订记录、页眉页脚（section.ts）、水印（watermark.ts）、文档保护（protection.ts）、脚注（notes.ts）、主题（theme.ts）、图表（chart.ts）、公式（math.ts）。

**资产三：office-bridge 双侧**。桌面侧 `apps/desktop/src/main/gateway/office-bridge.ts`，网关侧客户端 `apps/gateway/src/modules/documents/capabilities/office-bridge-client.ts`：

1. `/v1/office-generate`：受限 HTML → docx / pptx / xlsx 全新生成。
2. `/v1/office-reformat`：论文装订。describe 把源 docx 转块大纲；build 按格式卡全量重建。
3. `/v1/office-edit`：目前仅支持 slides。事务式：read 取活会话大纲与 op 词汇表；apply 逐 op 报告成功失败。

### 2.2 差距

1. 网关 agent 无 docx 增量编辑工具。只能全量重建，或让用户进 docs 视图用内嵌 AI。
2. 表格只能整块替换。无行列增删、无合并单元格。
3. agent 不能创建批注，不能接受或拒绝修订。
4. 水印、文档保护、脚注等引擎能力未暴露为 agent 工具。
5. 论文排版不保留原文档样式，按格式卡完全重排。

## 3. 总体设计

三层结构：

```text
网关 agent（word-editor 技能）
   │  read / apply（HTTP）
桌面 office-bridge（能力宿主）
   │  块模型 + 命令执行（genoffice 共享包）
   │  saveDocx 增量落盘（docx-engine）
files 文件库（版本与广播）
```

### 3.1 能力层：块模型抽共享包

docs 应用的编辑器内核是 ProseMirror。当前命令执行在渲染进程内。

做法：把「docx ↔ 块模型」转换与命令执行抽成 genoffice 内共享包。docs 应用与桌面宿主共用同一个包。

理由：活会话路径与 headless 路径必须用同一套读写规则。否则两边改出不一致的结果。

ProseMirror 的 model / state / transform 层可在 Node 运行，不依赖浏览器渲染。M1 先做可行性探针。若探针失败，备选方案是命令直译：命令 → text-patch 段落手术，跳过块模型。探针结论回写本方案。

### 3.2 接口层：扩展 /v1/office-edit

新增 docx 支持。语义与 slides 版对齐：

1. read：文件引用 → 块列表（索引、类型、内容预览）、全文统计、样式表摘要、待定修订数、批注线程数。
2. read_blocks：分页读块全文。
3. apply：op 数组，事务执行。整体成功，或逐 op 报告失败（沿用 slides 的 failures 语义）。

op 词汇分两组：

1. 结构 op：insertBlocks、replaceBlocks、deleteBlocks、moveBlocks。
2. 格式命令：沿用 docs 应用 apply_commands 现有词汇，不新造。

op 词汇表由 read 响应下发，agent 不硬编码。理由：词汇演进不依赖 agent 提示词更新。

### 3.3 agent 层：word-editor 技能

新建 `agents/word-editor/`。SKILL.md 写编辑循环：

1. read 拿块列表。
2. read_blocks 读目标块全文。改写前必须读原文（docs 工具已有同款纪律）。
3. 组装 op 数组，apply。
4. 渲染验证：office-render-page 已有 slides 先例，扩展到 docx。agent 看图确认再交差。
5. 报告改动清单。

## 4. 关键设计决策

### D1 建议模式优先

默认把 agent 修改写成修订。用户在审阅页接受或拒绝。

理由：

1. agent 改错可整体回退。用户敢放手让 agent 大改。
2. 修订本身是沟通载体。用户能看到 agent 改了什么。
3. 引擎已支持修订写入，成本低。

直写模式仅在用户明确要求时启用。判断规则写进技能提示词。

### D2 不透明块保真底线

块模型装不下的内容（文本框、OLE 对象、复杂域、嵌套表格深层结构等）标记为不透明块。规则：

1. 可读：类型、位置、文本摘要。
2. 可整体删除、移动。
3. 不可拆开编辑。
4. 落盘时原 XML 原样保留。

这是保真度的地基。任何「读入 → 改 → 写回」链路都有丢失风险。增量 patch 加不透明块，把风险压到「agent 主动删除」一种。

### D3 增量落盘

写回一律走 saveDocx 增量 patch。禁止整包重建。

理由：保真。原文档里 agent 未感知的能力（自定义样式、宏、自定义 XML）全部原样保留。

### D4 双路并发协调

路径一（活会话）：文档已在 docs 视图打开。agent 编辑事务送进已打开会话，编辑过程实时重绘。slides 的 office-edit 已是此模式。

路径二（headless）：文档未打开。桌面宿主直接执行块操作并落盘。落盘后广播文件变更，docs 视图若随后打开则取新版本。

冲突规则：同一时刻同一文件只允许一条写路径。活会话存在时，headless 路径拒绝执行。

### D5 验证回路

每次 apply 后渲染改动页为 PNG，agent 自查。沿用 slides 视觉复检的封闭清单思路。渲染链路（LibreOffice → 图）已在仓库内成熟。

### D6 版本与入库

编辑产物走 files 文件库，产生新版本，不覆盖历史版本。EverRoom 已有文件版本体系，直接挂接。

## 5. 与论文排版的关系

论文排版（office-reformat）保持现状：按格式卡全量重建。

理由：装订场景的目的就是丢弃原文档排版。

装订产物生成后，后续微调走本方案的 office-edit。两条链路不合并。

## 6. 落地里程碑

### M1 打通读写（含探针）

1. 探针：块模型与命令执行在 Node 侧运行。结论回写本方案。
2. office-edit read / read_blocks 支持 docx。块大纲解析复用 reformat describe。
3. office-edit apply 支持结构 op 与文本替换。直写模式。
4. 渲染验证：docx 页 → PNG。
5. word-editor 技能注册。agent 可改文字、调块顺序。

### M2 命令全集与建议模式

1. 格式命令全集接入：样式、列表、目录、页眉页脚。
2. 修订写入模式，默认开启。
3. 图片与图表 op。接素材库检索，复用 PPT material_search 先例。

### M3 高级能力

1. 表格结构 op：行列增删、合并拆分单元格。
2. 创建批注。
3. 水印、文档保护、脚注暴露为命令。
4. 不透明块清单固化，附字节级回归测试。

每个里程碑附真机回归清单。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 块模型保真度不足，改写丢内容 | D2 不透明块 + D3 增量落盘；字节级回归比对（仓库已有 PPTX 字节级回归先例） |
| ProseMirror headless 抽取受阻 | M1 探针先行；备选命令直译 text-patch |
| 双路语义漂移 | 共享包同一实现；活会话与 headless 跑同一套测试用例 |
| 大文档性能 | 分页读沿用；写回只 patch 变化段 |
| agent 误删 | 建议模式默认开；文件版本可回退 |

## 8. 不做什么

1. 不给 agent 接受或拒绝修订的权限。审阅权留给用户。
2. 不在本通道做 Excel 编辑。Excel 的 agent 编辑已另立实现，见 `docs/xlsx-agent-editing-implementation.zh-CN.md`。
3. 第一期不做表格结构编辑与合并单元格。
4. 不做多人协同编辑。
5. 不改 docs 应用现有内嵌 AI 的行为。

## 9. 开放问题

1. 探针结论：块模型能否完整脱离浏览器运行。
2. 不透明块的清单边界。用真实用户文档语料圈定。
3. 修订作者名。agent 改动是否统一显示为一个助手名。
