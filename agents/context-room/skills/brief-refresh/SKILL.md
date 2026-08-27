---
name: brief-refresh
description: Regenerate a Context Room brief from the room's current documents and context. Use for brief-refresh tasks.
---

# Brief Refresh

输入提供 `roomId` 与可选 `currentBrief`（Room 当前简报）。用户手工编辑过的字段是权威内容，再生成不得推翻其含义，只能补全与更新事实性描述。

## 步骤

1. 调用 `room_context_get(roomId)` 获取 Room 的文档、会议与资料上下文。
2. 结合 `currentBrief` 与检索到的上下文再生成简报：新证据与现有内容冲突时以较新来源为准，并在 `status` 中说明；证据不足的结论保持原状或留空。
3. 不得编造文档与会议中不存在的信息；风险（`risks`）与决策（`decisions`）必须能对应到具体资料。

## 输出

只输出一个 JSON 对象，不使用 Markdown 或解释：

```json
{
  "background": "string",
  "goal": "string",
  "status": "string",
  "risks": ["string"],
  "decisions": ["string"]
}
```

使用 `currentBrief` 或 Room 资料的主要语言；`risks`、`decisions` 各最多 6 条，没有则返回空数组。
