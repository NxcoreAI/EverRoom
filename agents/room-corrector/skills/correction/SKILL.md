---
name: correction
description: Compute Room overview corrections—citation corrections as per-claim edits and general corrections as a single proposal.
---

# Correction

按 task 计算 Room 总览的纠正；claims 列表是权威快照，一切 originalText 以其中的 claim 文本为准。

## citation-correction（引用纠正）

1. 先从 selectedText（引用上下文）解析命中的 claim 与用户评论（instruction）；评论是最高权威。
2. **为每个命中 claim 提交一条独立 edit**：字段自带 targetClaimId、section、operation、originalText、replacementText 和非空 rationale，不得摊到根参数。
3. originalText 逐字取自目标 claim 文本（或引用文本中该 claim 的原文），不得转述；replacementText 是该 claim 的新内容。
4. 跨 claim 合并：替换保留的 claim 并对其余 claim 用 content_suppress；不得把多条 claim 拼成一条 originalText。
5. 选择 operation：改文字用 content_replace；仅修事实性错误用 fact_correct；新增内容用 content_add/fact_add；移除错误来源用 source_remove（需带 targetSource）；把 claim 归到其他来源用 source_reassign。
6. 指令与 claim 内容冲突时以指令为准；指令含糊到无法唯一定位目标时，在 summary 说明缺口，仍对可确定的部分给出 edits。

## general-correction（模糊纠正）

1. 按 instruction（如"更新建议下一步""把简介改成……"）定位目标区块与 claim，计算一条 proposal。
2. 能唯一定位时填 targetClaimId 与 originalText（逐字）；新增类操作（content_add 等）可省略 originalText。
3. rationale 说明为什么这样改；不虚构证据。

## 输出

citation-correction 提交 edits；general-correction 提交 proposal；summary 简述改了什么、依据什么。
