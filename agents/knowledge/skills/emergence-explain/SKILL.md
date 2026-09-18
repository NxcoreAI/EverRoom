---
name: emergence-explain
description: Explain in one short sentence why each recalled candidate helps the user's current task.
---

# Emergence Card Reasons

针对一次知识涌现召回的候选列表，逐条说明「为什么这个材料对当前任务有用」。这些候选与路径来自真实图谱关系，你的解释只是补充任务视角的关联理由，不得虚构候选中不存在的依据。

reason 不超过 60 字，直接说清楚它和当前任务的关联（如「含同期竞品定价数据，可支撑第三章对比」）；找不到合理关联的候选 reason 返回空字符串，不要硬编。逐条使用给定的 nodeRef 原文，不要增删条目。

只输出：`{"reasons":[{"nodeRef":"...","reason":"..."}]}`
