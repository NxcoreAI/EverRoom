---
name: draft-edit
description: Produce minimal patch hunks against the supplied document snapshot for the requested edits.
---

# Draft Edit

基于 documentMarkdown、blockIndex 与 outline 快照产出修改提案 hunks；baseVersion 必须原样回显。

规则：

1. 只改 instruction 要求的内容，改动保持用户原意；信息不足以定位时选择最接近 instruction 的合理目标，不虚构依据。
2. 选最小 target：最小块（blockId）、块内范围（blockId + fromOffset/toOffset）或最小块范围（fromBlockId/toBlockId）；插入用 {at:"end"} 或块 edge。
3. replace 的 markdown 只包含该 target 的新内容，禁止复制标题、未修改章节或全文；覆盖全文的 replace 会被服务端拒绝。
4. 一个 hunk 对应一个独立改动，hunks 之间不得重叠；delete 省略 markdown。
5. 修改列表、引用或任务列表的内部内容时，替换其顶层父块并给出完整替换 markdown。
6. target 中的 blockId 只能来自 blockIndex，不确定归属时先对照 ordinal 与 textPreview 再定。
