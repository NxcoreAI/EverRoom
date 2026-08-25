# Office/PDF 多模态解析实施方案

> 状态：实施中（已落地 P0/P1 原生解析基础骨架）
> 日期：2026-08-24
> 范围：PDF、Word、Excel、PowerPoint 及其兼容格式

## 0. 当前实施进度

截至 2026-08-24，已完成第一批基础实现：

- 新增 Canonical Document Artifact 契约及 `parsed_documents` 持久化，按 `(fileVersionId, parserRevision)` 幂等复用；
- 复用现有确定性转换器，接入 PDF、DOCX、XLSX、PPTX 和旧版 Office 兼容路径；
- 保留 PDF/PPTX 页边界、PPTX 标题和 XLSX 表格 cell 投影，Markdown 继续作为兼容输出；
- 将解析接入现有 `file.ingest` 任务重试/恢复链路，并提供 artifact 查询路由；
- 注册 `multimodal-document-parser` dispatch-only Agent，仅授予 Gateway 托管的解析、读取和校验工具；
- 增加 PDF、XLSX、幂等、artifact 校验、Agent 目录和迁移回归测试。

首版 OCR 决策：不新增本地 OCR 模型、SDK 或独立 OCR 服务，复用现有 OpenAI-compatible VLM 配置。仅在调用方传入 `privacyPolicy=external_vlm_allowed` 时，在本地渲染 PDF 全部页面并逐页发送给 VLM 执行 OCR，不因页面已有文本层而跳过；`local_only` 内容禁止进入该链路。VLM OCR 必须返回严格结构化文本、归一化 bbox 和置信度，并以 `source.method=vlm` 保存，不能伪装成确定性原生文本。Artifact 同时保留原生与 VLM 证据，Markdown 投影在原生文本可用时优先采用原生结果，避免重复正文。

当前已开始 P2：PDF 原生文本块保留页面尺寸和 bbox；扫描 PDF 可在没有文本层时先生成 artifact；授权后对全部页面执行页面渲染和 VLM OCR。PDF 嵌入图片、DOCX/XLSX/PPTX media 和 chart XML 已按内容哈希抽取为安全资产引用；PPTX 资产可绑定到 slide 页码，XLSX 表格保留 sheetName。高级版面模型、跨来源融合以及完整基准样本集仍未实现，artifact 会用 warning 和 `quality.status=partial` 明确标记这些缺口。后续仍按 P2-P5 推进，不能将当前版本描述为完整的 Office/PDF 多模态解析能力。

## 1. 方案结论

EverRoom 不直接接入第三方 MiniMax 开源 Skill 作为解析底座。该类 Skill 主要是脚本化的 PDF 页面渲染和 VLM 调用，不能提供 Office 原生结构、OCR 坐标、版面模型、表格结构、证据定位和可复现的解析产物。

本方案采用“确定性解析管线 + 受控视觉模型 + 多模态解析子 Agent”的组合：

```text
文件版本
  -> 格式检查与任务规划
  -> 原生结构/文本解析
  -> 页面渲染
  -> OCR 与版面分析
  -> 图片、图表、表格抽取
  -> 视觉模型分析困难区域
  -> 跨来源融合与质量校验
  -> Canonical Document Artifact
  -> Markdown、检索、Room/Wiki/Memory 投影
```

子 Agent 负责选择策略、调用工具、处理冲突和形成结构化结果；不直接读取任意路径、不执行 Bash、不直接写数据库。

## 2. 目标与非目标

### 2.1 目标

1. 支持有文本层 PDF、扫描 PDF、DOCX、XLSX、PPTX，并为旧版 Office 提供兼容路径。
2. 同时保留文本、版面、表格、图片、图表、OCR 和来源坐标。
3. 任何抽取事实都能定位到页码、区域、段落、sheet/cell 或嵌入资产。
4. 解析失败可重试、可降级、可解释，且同一文件版本可幂等复用。
5. 保持现有 Markdown、Room、Wiki、Memory 和 FilesPage 兼容。

### 2.2 非目标

- 第一版不做通用图片、音频、视频解析。
- 第一版不执行 Office 宏、外部链接、嵌入脚本或 OLE 对象中的代码。
- 第一版不让解析 Agent 直接与最终用户对话。
- 第一版不把 VLM 输出直接当作事实；必须经过结构化校验和证据绑定。

## 3. 当前实现基线

当前 `apps/gateway/src/modules/ingest/converters.ts` 已有 DOCX、XLSX、PPTX、PDF 到 Markdown 的转换器，`FilesService` 已有对象存储、内容 hash、解析产物幂等和文件版本入口。`apps/gateway/src/modules/perception/vlm-client.ts` 已有 OpenAI-compatible 图片推理客户端，但只服务截图/照片感知。

本方案不删除这些能力，而是把它们调整为：

- native parser 的兼容实现或 fallback；
- Canonical Artifact 的 Markdown projection；
- 视觉模型的通用 provider adapter。

## 4. 目标架构

### 4.1 模块边界

新增 `apps/gateway/src/modules/document-understanding/`，建议包含：

```text
document-understanding/
├── types.ts                 # Canonical Artifact、Block、Asset、Table、Evidence
├── service.ts               # 解析任务编排与幂等
├── job-worker.ts            # 任务租约、重试、取消、恢复
├── native/                  # PDF/OOXML/Excel/PPT 原生解析
├── render/                  # PDF/Office 页面渲染
├── ocr/                     # OCR provider 与结果归一化
├── layout/                  # 页面区域和阅读顺序分析
├── assets/                  # 内嵌图片、图表、页面图片存储
├── fusion/                  # native/OCR/layout/VLM 融合
├── projection/              # Markdown、引用和下游投影
├── tools.ts                 # 子 Agent 受控工具
└── routes.ts                # 状态、详情和调试接口
```

`ingest` 仍负责 source、policy、ledger 和 fan-out；`document-understanding` 负责文件理解，不反向承担 Room/Wiki/Memory 业务语义。

### 4.2 解析流程

1. `FilesService` 固定 `fileVersionId`，避免解析期间文件更新造成 TOCTOU。
2. 检查 MIME、扩展名、文件签名、大小、页数和容器合法性。
3. 运行 native parser，得到文本和结构候选。
4. 按策略渲染页面和内嵌资产。
5. 对无文本层、低文本密度或低置信度区域执行 OCR。
6. 运行版面和表格分析。
7. 仅将必要页面/区域交给视觉模型。
8. 融合各来源结果，去重并建立 evidence。
9. 运行质量校验，生成 artifact 和 Markdown projection。
10. 写入 `parsed_contents` 兼容指针，并通知现有 ingest fan-out。

## 5. Canonical Document Artifact

Markdown 不再是唯一事实源。建议以结构化 artifact 为权威，Markdown 作为兼容投影。

```json
{
  "schemaVersion": 1,
  "document": {
    "fileVersionId": "...",
    "format": "pdf",
    "parserVersion": "document-understanding@1"
  },
  "pages": [],
  "blocks": [],
  "tables": [],
  "assets": [],
  "warnings": [],
  "quality": {}
}
```

### 5.1 Page

```json
{
  "pageNo": 3,
  "width": 2480,
  "height": 3508,
  "imageAssetId": "asset-page-3",
  "textLayerStatus": "present|absent|low_confidence",
  "ocrStatus": "not_needed|completed|failed"
}
```

### 5.2 Block

```json
{
  "id": "block-12",
  "type": "heading|paragraph|list|table|figure|chart|header|footer|formula",
  "pageNo": 3,
  "bbox": [80, 120, 920, 260],
  "readingOrder": 12,
  "content": "……",
  "confidence": 0.96,
  "source": {
    "method": "native|text_layer|ocr|vlm|fused",
    "nativeRef": "word:paragraph:17"
  }
}
```

表格需要额外保存 cell、row/column span、表头和原始坐标；Excel 需要保存 sheet、cell address、formula 和 displayed value。

## 6. 多模态解析子 Agent

新增 `agents/multimodal-document-parser/`，使用现有 `dispatch_only` 框架：

```text
agents/multimodal-document-parser/
├── agent.yaml
├── SYSTEM.md
├── skills/
│   ├── pdf-parsing/SKILL.md
│   ├── office-parsing/SKILL.md
│   ├── layout-and-table/SKILL.md
│   └── evidence-reconciliation/SKILL.md
└── schemas/
    ├── input.schema.json
    └── output.schema.json
```

### 6.1 输入

```json
{
  "fileVersionId": "fver-123",
  "profile": "full|text_only|visual_review",
  "pageRange": "1-5",
  "localeHint": "zh-CN",
  "privacyPolicy": "local_only|external_vlm_allowed",
  "requestedOutputs": ["layout", "tables", "figures", "markdown"]
}
```

### 6.2 受控工具

```text
document_inspect
document_extract_native
document_render_pages
document_extract_assets
document_ocr
document_detect_layout
document_extract_tables
document_analyze_regions
document_reconcile
document_validate
```

工具必须支持批量页面/区域，避免每页建立一次 Agent 调用。工具返回 asset ref 和结构化 JSON，不返回任意本地路径。

### 6.3 权限边界

子 Agent 默认：

- 无 Bash、任意文件系统、任意网络；
- 无 Memory、Knowledge、Room 和 Connector 直接权限；
- 只能读取当前 `fileVersionId` 授权的数据；
- 只能通过受控工具调用视觉模型；
- 不直接写数据库，由解析服务提交结果；
- 不保存对话记忆，不与最终用户交互。

## 7. 分格式实现

### 7.1 PDF

- 保留现有 PDF.js 文本层提取。
- 增加页面渲染、页面尺寸和文本块坐标。
- 文本为空或密度低于阈值时执行 OCR。
- 表格区域使用文本布局优先，视觉模型作为 fallback。
- 抽取嵌入图像、页面截图、注释和基本元数据。
- 扫描件必须生成 OCR 置信度和人工复核警告。

### 7.2 DOCX

- 读取段落、样式、标题层级、列表、表格、页眉页脚、脚注、批注和超链接。
- 解包 `word/media`，建立图片和文档 block 的引用关系。
- 处理 OMML 公式和嵌入对象的安全降级。
- 使用 LibreOffice 或等价渲染器生成页面图像，补充版面和图表理解。

### 7.3 XLSX

- 保留 workbook、sheet、cell、公式、显示值、样式、合并单元格、隐藏行列和批注。
- 解包 drawing/chart/media 关系，建立图表与数据区域关联。
- 页面视觉分析只用于图表、复杂布局和截图，不替代 cell-level native parser。
- Markdown 表格由结构化 sheet 投影生成。

### 7.4 PPTX

- 读取文本框、形状、表格、图表、备注、图片、组关系和坐标。
- 解析 `ppt/media` 和 speaker notes。
- 渲染整页，使用视觉模型识别流程图、关系图、图表和页面语义。
- 保留 slide、shape、region 级引用。

### 7.5 旧版 Office

继续使用 LibreOffice headless 作为兼容路径，但必须记录：

- 原格式；
- 转换格式；
- LibreOffice 版本；
- 转换警告；
- 哪些结构因转换而降级。

## 8. 存储与任务模型

建议新增：

- `document_parse_jobs`：任务状态、租约、尝试次数、错误和取消信息；
- `parsed_documents`：artifact 主记录、质量摘要和 parser/model 版本；
- `parsed_pages`：页尺寸、渲染 asset、OCR 状态；
- `parsed_blocks`：版面 block、坐标、来源和置信度；
- `parsed_tables`：表格和 cell 结构；
- `parsed_assets`：图片、图表、页面图像和安全元数据。

`parsed_contents` 继续保留，用于 Markdown projection 和现有链路兼容。

幂等键建议为：

```text
(fileVersionId, parserRevision, nativeParserVersion, layoutVersion, ocrVersion, vlmModelVersion)
```

## 9. 分阶段交付

### P0：契约和样本集

- 固化 Canonical Artifact、输入/输出 Schema、错误码和状态机。
- 准备 PDF、扫描 PDF、DOCX、XLSX、PPTX 回归样本。
- 建立每个样本的页数、结构、表格和图片基准答案。

验收：Schema、样本和评测脚本可独立运行。

### P1：解析基础设施

- 新增 `document-understanding` 模块、任务 worker 和 artifact 存储。
- 将 `FilesService` 的 file version 作为唯一输入引用。
- 实现 native parser adapter、Markdown projection 和失败重试。

验收：现有 ingest 行为不回归；重复解析命中缓存。

### P2：PDF 完整链路

- 文本层、页面渲染、坐标、扫描件检测、OCR、页级引用。
- 表格和图片区域抽取。
- 视觉模型只处理无文本/低置信度/复杂区域。

验收：扫描 PDF 可以产出带页码、bbox、OCR 置信度的 artifact。

### P3：Office 原生结构

- DOCX、XLSX、PPTX 原生结构解析。
- 嵌入资产、公式、图表、备注、sheet/cell/shape 引用。
- LibreOffice 兼容路径和降级警告。

验收：Office 结构不再仅以 Markdown 表示；关键元素可回指原文件。

### P4：视觉融合与子 Agent

- 注册 `multimodal-document-parser` dispatch-only Agent。
- 接入批量页面/区域工具、结构化输出校验和冲突融合。
- 增加通用 VLM provider adapter，MiniMax 只作为可选 provider，不进入解析协议。

验收：Agent 可从同一文件版本生成完整 artifact，失败时不会产生无证据事实。

### P5：生产化和评测

- 并发、租约、取消、断点续跑和资源限额。
- 外部 VLM 隐私策略、审计和脱敏。
- 建立准确率、召回率、结构保真度、引用正确率和成本监控。

验收：达到发布门槛并完成安全评审。

## 10. 评审指标

建议至少衡量：

| 指标 | 目标方向 |
|---|---|
| 文本抽取召回率 | 数字 PDF/Office 不低于当前实现 |
| OCR 字符准确率 | 中文、英文、数字分别评测 |
| 版面 block F1 | 标题、段落、表格、图片、图表 |
| 表格结构准确率 | 行列、合并单元格、表头和 cell 值 |
| 引用定位准确率 | page/bbox/sheet/cell 可回指 |
| 视觉事实支持率 | 无 evidence 的事实必须为零 |
| 解析幂等率 | 同一版本不重复执行昂贵步骤 |
| 单页成本和延迟 | native 优先，VLM 只处理必要区域 |

## 11. 关键风险与待决策项

1. OCR 和版面引擎采用本地 worker 还是外部服务；本地优先但会增加安装包体积。
2. PDF/Office 页面渲染采用 Node 原生方案还是独立 Python/LibreOffice worker。
3. 是否允许企业用户启用外部 VLM；默认应为关闭或显式授权。
4. Artifact 是否全部规范化入表，还是保留一个 JSON 主体并为高频查询加索引。
5. 表格和图表的准确率是否达到进入 Memory 的门槛；默认应先进入 Room/Wiki，低置信度内容不直接进入长期记忆。
6. 解析 Agent 是否只由 `internal-workflow` 调度，还是允许 `primary-agent` 直接请求 `visual_review` profile。

## 12. 预计投入

以现有 Gateway、FilesService、Subagent 和 VLM 基础设施复用为前提：

- PDF 可用版本：约 2 个工程周；
- Office 原生结构和资产：约 2～3 个工程周；
- 子 Agent、融合、任务恢复和评测：约 2 个工程周；
- 生产化、安全和回归：约 1～2 个工程周。

完整第一版预计为 7～9 个工程周。若只做 PDF 文本/OCR/页面视觉 MVP，可压缩到约 2～3 个工程周，但不能宣称已经具备完整 Office/PDF 多模态解析能力。

## 13. 推荐评审结论

建议批准 P0、P1 和 P2 作为第一阶段，暂缓将所有视觉结果直接接入 Memory。先把 Canonical Artifact、证据定位和失败降级做稳定，再扩展 Office 图表、公式和复杂版面。这样可以保持现有系统兼容，同时避免再次形成“只有 Markdown、没有来源和结构”的解析黑盒。
