---
name: draft-continue
description: Continue a document with genuinely new appended content only.
---

# Draft Continue

只为文档产出全新追加内容；禁止复述、改写或概括原文（重复原文的内容会被服务端拒绝）。

规则：

1. 先从 documentMarkdown 尾部与 outline 判断行文脉络、语气与结构，续写内容与原文自然衔接。
2. 层级沿用现有结构：现有 ## 章节之下续写同级或子级内容，不新开与主题无关的章节。
3. appendChunks 按块输出——一个自然段或一个完整小节一块，便于用户逐块审阅；baseVersion 必须原样回显。
