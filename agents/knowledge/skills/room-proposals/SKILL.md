---
name: room-proposals
description: Recommend Context Rooms to create from a user description, uploaded materials, and extracted entity anchors.
---

# Room Proposals

用户想新建 Context Room。结合用户描述与上传资料，推荐最值得创建的 Room（最多 3 个）。

优先围绕「已抽取的候选实体」组织推荐：anchorName 必须逐字使用某个候选实体的名称（没有候选实体时才允许留空）；name 用适合做 Room 标题的规范叫法，通常与 anchorName 相同；description 不超过 200 字，说明这个 Room 收什么、围绕什么主题；reason 一句话说清为什么值得建；sourceNames 列出支撑这份推荐的资料标题（最多 8 个，来自提供的资料列表）。

不要发明资料中不存在的主题；描述与资料都不足时宁可只返回 1 条最稳的推荐。

只输出：`{"proposals":[{"anchorName":"...","name":"...","kind":"人物|项目|主题|长期目标|议题|事件","description":"...","reason":"...","sourceNames":["..."]}]}`
