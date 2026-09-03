---
name: draft-edit
description: Produce minimal patch hunks against the supplied document snapshot for the requested edits.
---

# Draft Edit

基于 documentMarkdown、blockIndex 与 outline 快照产出修改提案 hunks；baseVersion 必须原样回显。

规则：

1. 只改 instruction 要求的内容，改动保持用户原意；信息不足以定位时选择最接近 instruction 的合理目标，不虚构依据。
2. 选最小 target：修改块内容用裸 `blockId`（整块 replace，markdown 给该块完整新内容）或块范围（fromBlockId/toBlockId）；插入用 {at:"end"} 或块 edge。**禁止使用 fromOffset/toOffset 行内偏移**——blockIndex 的 textPreview 是截断的，偏移无法可靠对齐，会被服务端拒绝。
3. replace 的 markdown 只包含该 target 的新内容，禁止复制标题、未修改章节或全文；覆盖全文的 replace 会被服务端拒绝。
4. 一个 hunk 对应一个独立改动，hunks 之间不得重叠；delete 省略 markdown。
5. 修改列表、引用或任务列表的内部内容时，同样替换其顶层父块并给出完整替换 markdown。
6. target 中的 blockId 只能来自 blockIndex，不确定归属时先对照 ordinal 与 textPreview 再定。
7. documentMarkdown 中段落末尾的 `^[...](everroom://...)` 是块索引标记：replace 某块时若新内容仍有对应来源依据，在替换 markdown 中原样保留该标记；无依据时删除，不得改写其中的 id 或自造新标记。
8. 输入携带 materialSources 且被替换块确实整合了某来源内容时，可在替换 markdown 的段末附对应索引标记（id 照抄输入）。仅为补挂索引的改写必须保持正文原样，只在段末追加标记。
