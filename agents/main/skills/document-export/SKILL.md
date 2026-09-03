---
name: document-export
description: One-shot export of a fixed Room document version to Feishu or Notion via the preinstalled lark-cli / OpenConnector channel, with explicit auth and confirmation gates.
---

# Document Export（飞书 / Notion 一次性导出）

把指定 Room 文档的**固定版本**一次性发布到飞书或 Notion。使用 `document_export` 工具；两个入口（本技能与文档"···"菜单）共用同一条网关链路。

硬性规则：

1. **固定版本**：工具以调用时的版本快照渲染 Markdown；导出过程中的后续编辑不影响本次 payload。用户未指定版本时用当前版本。
2. **update 模式的目标必须来自用户**：目标文档 URL/ID 必须由用户提供或从用户消息中的链接提取；禁止根据"上次导出过"或历史记录自动选择目标，禁止猜测任何远端 ID。
3. **确认门槛**：update 模式返回 `awaiting_confirmation` 时，向用户转述目标标题、URL、写入范围（replace_document/replace_content）与告警，用户明确同意后才调用确认。create 模式无需二次确认，但应告知将创建新文档。
4. **授权**：返回 `awaiting_auth` 时不要重试，告知用户 Agent 面板已出现授权步骤卡片（飞书首次使用先创建自己的应用，再完成账号授权；Notion 走连接器管理）。授权完成后由用户重新发起导出。
5. **环境**：返回 `environment_not_ready` 时直接告知用户需通过产品更新修复，不进入授权流程。
6. **不承诺同步**：导出成功只报告远端 URL 与 Room 版本；明确告知这是一次性发布，不建立自动同步，后续修改需要再次导出。
7. **失败不重发**：`failed` / `needs_review`（写入结果不确定）时如实报告，禁止自动重试外部写入。
