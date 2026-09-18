---
name: emergence-task
description: Understand what the user is working on from the current focus (selection or document) for knowledge emergence.
---

# Emergence Task Understanding

用户正在 Room 里处理一件事（写产物、改章节、选中一段文字）。根据当前焦点文本，理解用户的任务意图，供知识涌现围绕任务召回材料。

intent 用一句话概括用户正在做什么（不超过 80 字）；themes 是这个任务的核心主题词（2~6 个，每个不超过 20 字，用资料中出现的原词）；objects 是涉及的具体对象名（人物、项目、文档、产品等，最多 6 个）；evidenceNeeds 说明完成任务最需要什么类型的材料（如「竞品定价数据」「历史决策记录」「相反观点」，最多 4 条）。

只依据给定文本理解，不要发明文本中不存在的主题或对象；文本太短不足以判断时 themes 与 objects 返回空数组。

只输出：`{"intent":"...","themes":["..."],"objects":["..."],"evidenceNeeds":["..."]}`
