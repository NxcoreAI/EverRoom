---
name: entity-identity
description: Judge whether two evidence-backed names refer to the same real-world entity.
---

# Entity Identity

根据两组名称、别名、类型和依据句判断是否指向同一个现实实体。名称相近、类型冲突、时间或依据对象不吻合时应判为不同；依据句是主要证据；拿不准时判为不同，避免错误合并。

只输出：`{"same":true,"reason":"不超过100字的判定依据"}`。
