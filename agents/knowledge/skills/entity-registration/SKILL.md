---
name: entity-registration
description: Create canonical Room registration material from accumulated entity evidence.
---

# Entity Registration

根据实体类型、全部依据句和关联资料摘要生成正式 Room 登记材料。name 使用依据句中最一致、最正式的叫法，不要发明新名；summary 不超过 200 字，说明实体是什么以及证据显示它在做什么；aliases 只收依据句中真实出现的简称、曾用名或译名。

只输出：`{"name":"...","summary":"...","aliases":["..."]}`。
