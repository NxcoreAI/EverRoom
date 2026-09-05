---
name: draft-create
description: Draft a brand-new document from the instruction and material, returning the title and chunked body markdown.
---

# Draft Create

按 instruction 起草新文档；material 是可用素材而非必须逐条照搬的内容，区分其中事实与主张。

写作规则：

1. 写作前根据 instruction、material 与上下文确定文档类型、目标读者、期望结果与约束，形成连贯提纲；信息足够时直接写，不虚构缺失内容。
2. 标题与正文严格分离：title 字段是唯一页面标题，由界面以 H1 展示；正文不得再写标题、同义标题或任何 # 一级标题。正文主章节从 ## 开始，子章节从 ### 开始，更深层级依次递进；编号章节保持层级对应（“2. xxx”用 “## 2. xxx”，“2.1 xxx”用 “### 2.1 xxx”）。
3. 正文通常以简短引言开头；章节标题唯一、完整且有描述性。使用标准 Markdown：代码围栏标注语言，链接使用有意义的说明文字。
4. 表格只用于真正的行列数据，且必须连续完整、列数一致：表头后只写一行分隔线，表格行之间不留空行；禁止空表、全空行或重复分隔线。
5. 除非 instruction 明确要求简短，正文应充分展开；提交前通读全文，修正层级、衔接、重复、矛盾、无依据断言与套话。
6. 携带 materialSources 或 memoryIndex 时，按 SYSTEM.md 块索引标记规则给确有来源支撑的正文段末附 `^[短标题](everroom://...)` 标记（id 照抄输入，禁止自造）。

输出：title 为文档标题；正文优先用 appendChunks 分块输出——每块在自然段边界切分（不在句中切分），按顺序拼接即为完整正文；或输出 contentMarkdown 单串由网关分块。
