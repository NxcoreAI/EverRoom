# 工作会话标题 = 一次 LLM 总结

> 状态：**已实现**（2026-11-03）。服务端兜底 + 渲染层首选，两条路径互不覆盖。

## 0. 一句话

工作空间里的「工作会话」，标题不再是首条 prompt 的前 48 个字，而是**首轮跑完后由一次 LLM
调用总结出来的短语**；用户手动改过名、或计划指派自带任务标题的，保持原名不动。

## 1. 现状问题

会话标题的写入只有一处兜底：

```
apps/gateway/src/modules/agent/service.ts:2176
title: session.title ?? displayPrompt.slice(0, 48)
```

也就是「用户第一句话的前 48 字」。于是一段整理成本表的工作，标题会变成
「帮我整理这个季度的成本对比表，并核对物料单价……」——是**原话**，不是**这件事叫什么**。

## 2. 两种实现路径（都已存在，分工明确）

| 路径 | 位置 | 触发 | 局限 |
| --- | --- | --- | --- |
| **渲染层（首选）** | `apps/desktop/src/renderer/src/components/agent/useAgentSession.ts` `maybeGenerateSessionTitle` | 对话面板订阅到 `run.completed`，且会话只有一次 run、标题仍是自动占位 | 只在**对话面板开着并订阅该会话**时有效；后台跑完、计划指派、面板未开 → 拿不到 |
| **服务端（兜底）** | `apps/gateway/src/modules/processing/auto-session-title.ts` `AutoSessionTitles` | 网关 `run.completed` → 延迟 8 秒后检查并生成 | 延迟窗口内渲染层已写好就自动让路；网关重启会丢掉未执行的兜底任务 |

两条路径都调用同一个标题服务 `SessionTitleService`（`POST /v1/processing/session-title` 的实现），
提示词、长度上限（48 字）与清洗规则完全一致，所以谁先写都得到同一风格的结果。

### 为什么服务端要延迟 8 秒

渲染层没有提示词可用时会先 `getSession` 确认标题仍是自动占位，再调模型，整个过程 1–3 秒。
服务端如果立刻也生成，同一个会话就会白跑两次 LLM。延迟 8 秒后再检查：
渲染层已经把标题改掉 → 直接跳过；确实没人管 → 服务端补上。

## 3. 服务端规则（`AutoSessionTitles`）

按顺序判定，任一不满足就安静退出：

1. 会话存在且 `workspaceId` 非空（**只处理工作空间内的工作会话**，空间外一次性对话不做额外开销）；
2. 这是**第一次成功跑完**：除本次 run 外没有其它 `completed` 的 run（标题应当稳定，不反复改写）；
3. 标题仍是自动占位：`title === null` 或 `title === 首条用户消息前 48 字`
   —— 否则视为用户改名 / 计划指派带入的任务标题，尊重既有命名；
4. 有可总结的内容：本次 run 的 user 消息非空（assistant 正文取最后一条，缺失也可）；
5. 生成成功且返回非空；
6. **写回前再查一次**：标题在生成期间被动过（用户改名 / 渲染层写入）就不覆盖。

失败一律静默（运行时未配置、超时、返回空、抛错）——标题是增强能力，绝不影响对话主流程。

### 语言

服务端没有界面语言，用 CJK 字符粗判：含中日韩字符 → `zh-CN`，否则 `en`（标题服务只支持这两个口径）。
渲染层路径本来就带 `localeRef.current`，更准确，所以它是首选。

### 哑会话

`assistantText` 为空（模型只回了一句寒暄 / 工具失败）时仍然会生成，因为 user 侧通常已足够概括意图；
完全没有 user 消息（理论不该出现）才跳过。

## 4. 改动面

| 文件 | 改动 |
| --- | --- |
| `apps/gateway/src/modules/processing/auto-session-title.ts`（新增） | `AutoSessionTitles`：判定 + 延迟 + 生成 + 写回，失败静默 |
| `apps/gateway/src/modules/agent/service.ts` | 新增 `setSessionTitleGenerator` 回调，在 `run.completed` 完成分支触发（与记忆蒸馏同款，失败不影响对话） |
| `apps/gateway/src/server/create-server.ts` | 构造 `AutoSessionTitles`（复用 `SessionTitleService`）、接线、`onClose` 时 `dispose()` 清掉待跑定时器 |
| `apps/gateway/tests/auto-session-title.test.ts`（新增） | 8 条：首次总结 / 二次不重复 / 用户改名不动 / 非工作空间不动 / 失败静默 / 生成期间被改不覆盖 / 延迟窗口让路 / 与 `AgentService` 的真实接线 |

桌面侧**零改动**：标题写回后，侧边栏与对话头走既有的会话轮询（3.5s）自然刷新。

## 5. 验收

```bash
cd apps/gateway && ./node_modules/.bin/vitest run tests/auto-session-title.test.ts
```

- [x] 首轮跑完 → `generate` 调用一次，参数含 user 正文 / 最后一条 assistant 正文 / `zh-CN`，标题写回；
- [x] 第二次跑完 → 不再调用（标题稳定，不再花 LLM）；
- [x] 用户改名 → 不调用、不覆盖；
- [x] 非工作空间会话 → 不调用；
- [x] 生成抛错 → 标题保持占位、不抛错；
- [x] 生成期间标题被改 → 不覆盖；
- [x] 延迟窗口内渲染层先写好 → 到期直接让路、不调用；
- [x] 与 `AgentService` 真实接线：`run.completed` → 标题变成总结。

## 6. 已知边界

- **网关重启会丢掉待执行的兜底**（延迟窗口内的定时器不持久化）：极端情况下后台会话标题停在占位，
  下次会话再有 run 完成时也不会补（错过「第一次」）。可接受——渲染层仍是主路径。
- **`work-review` 等事件行显示的会话名**跟随 `session.title` 实时解析，所以标题更新后动态行会自动变；
  不需要额外刷新逻辑。
- 若产品以后要「会话进行到一半、话题变了就重命名」，那是另一个功能（周期性重写标题），
  本能力刻意只做一次，避免标题抖动。
