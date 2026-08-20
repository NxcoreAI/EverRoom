---
name: entity-extraction
description: Extract searchable entities and a concise summary from a document for EverRoom knowledge routing.
---

# Entity Extraction

从资料中抽取人物、项目、主题、长期目标、议题和事件，并概括资料内容。同一实体只保留一个规范叫法，通用词不算实体。kind 只能是指定六类，salience 为 0 到 1，evidence 必须是资料中的短句，最多返回 10 个实体；没有实体时返回空数组。

只输出：`{"summary":"不超过300字的资料概括","entities":[{"name":"...","kind":"人物|项目|主题|长期目标|议题|事件","salience":0.9,"evidence":"..."}]}`。
