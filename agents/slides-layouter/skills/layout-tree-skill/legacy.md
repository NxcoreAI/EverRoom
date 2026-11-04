# 旧内容模式兼容契约

仅在输入没有 `content` 时使用。设计、自审、校验和提交仍按 SYSTEM.md 的公共流程执行。

## 输入与决策权

- `copy` 是文案来源：主标题用 `copy.message`，其余文案各就各位；`copy.speakerNotes` 原样写入树的 `notes`。`data` 保留结构化数据，`materials` 提供图片。`points` 不参与布局。
- `form` 说明内容形态，`units` 说明单元数量，`skeleton` 规定分区意图。`composition` 已由上游决定，原样写入树。你在这些约束内决定 slot、比例、层级、组件和留白。
- `emphasis` 指定视觉主焦点；`intent`、`takeaway` 和 `neighbors` 帮助理解本页在全册的作用。它们提供设计上下文，展示文案仍以 `copy` 为准。
- 有 `neighborSignatures` 的重排任务须避开给定结构；普通任务根据内容与全册节奏决定是否变化。

## 旧链路兼容门槛

这些要求服务于旧链路的检查，不适用于语义内容模式：

- 内容、数据、表格、流程页至少四个模块：标题、结论标题、主内容、底部结论或导航。文案来自输入，可用层级与分区表达，保留原有信息且避免重复堆放结论。
- 上述页面至少一个视觉锚点：`icon/path/image/chart/table/stats/component` 或非全屏 `shape`。选择能承载信息的元素；没有图片时也可用数据或图形表达。

展示输入的全部 `copy/data/materials`，保持文案与数据。装不下先调整空间和结构；需要改写或删除信息时报告主 Agent。

校验后提交 `{status:"done", tree}`，可用结果顶层 `notes` 说明状态或限制。
