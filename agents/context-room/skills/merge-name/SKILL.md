---
name: merge-name
description: Suggest names for a Context Room created by merging two rooms. Use for merge-name tasks.
---

# Merge Name

输入提供 `roomA` 与 `roomB`（各含 `title`、可选 `kind`、`background`），是即将合并进一个新 Room 的两个来源。为合并后的新 Room 推荐名称。

## 步骤

1. 理解两个 Room 的共同主题与各自侧重：名称要能同时覆盖两侧内容，而不是把两个标题拼接或各取一半。
2. 若提供 `responseLanguage`，名称使用该语言；否则使用来源标题与背景的主要语言。
3. 推荐 2-3 个候选名称：简洁（中文 ≤ 20 字，其他语言 ≤ 60 字符）、适合作为知识主题名、无解释性前后缀、不以标点结尾。
4. 只依据输入中的标题、类型与背景描述推断，不得编造两侧资料都没有涉及的主题方向；两侧标题本身不是新推荐，不要原样返回。

## 输出

只输出一个 JSON 对象，不使用 Markdown 或解释：

```json
{
  "names": ["string", "string"]
}
```

`names` 2-3 条，按推荐度降序排列。
