---
name: canonical-schema
description: canonical schema 字段语义与各 provider 原始格式要点（gmail/outlook/google-calendar）。产出格式映射时使用。
---

# canonical schema 字段语义

## 邮件（recordKind = "mail"）

- `providerMessageId`（必填）：provider 内全局唯一消息 id（Gmail `id`；Outlook `id`）。
- `providerThreadId`：会话 id（Gmail `threadId`；Outlook `conversationId`）。
- `subject` / `snippet`：主题；正文摘要（Gmail `snippet`；Outlook `bodyPreview`）。
- `textBody` / `htmlBody`：正文明文与 HTML；两者都有时都输出。
- `receivedAt` / `sentAt`：ISO-8601。
- `isRead` / `isStarred` / `isDraft`：布尔。
- `addresses`：`{role, address, displayName?}` 数组；role 枚举 from/sender/to/cc/bcc/reply-to。
- `memberships`：Gmail labelIds 原样（不含语义推导）。
- `attachments`：`{providerId?, filename?, mimeType?, size?, inline?}`。

## 日程（recordKind = "calendar"）

- `providerEventId`（必填）、`title`（必填，缺失时输出 `"(无标题)"`）、
  `startsAt` / `endsAt`（必填，ISO-8601）。
- `allDay`：全天事件（Google `start.date` 无 dateTime 时为 true）。
- `timeZone` / `location` / `description` / `status` / `providerRevision`（etag）。
- `organizer` / `attendees`：`{role, address, displayName?}`；日程专用 role：
  organizer 用 `"organizer"`、参与人用 `"attendee"`。
- 墓碑：Google `status === "cancelled"` → isTombstone。

# provider 原始格式要点

## gmail（映射输入 = Gmail REST 资源形状）

- `payload.headers`：`{name, value}` 数组，name 大小写不敏感 → 地址字段。
- 正文：`payload` MIME 树递归，`mimeType="text/plain"` / `"text/html"` 的
  `body.data` 是 base64url；附件节点有 `body.attachmentId`。
- `labelIds` 数组：`UNREAD`（无 → isRead=true）、`STARRED`、`DRAFT`。
- `internalDate`：毫秒字符串 → `$fromMillis($number(internalDate))`；`historyId` → providerRevision。

## outlook（映射输入 = Microsoft Graph 消息对象）

- `@removed` 存在 → 墓碑（tombstoneId = `$string(id)`）。
- 地址：`from`/`sender`（单对象）、`toRecipients`/`ccRecipients`/`bccRecipients`/`replyTo`
  （数组），均为 `{emailAddress: {name, address}}` → role 依次映射 sender/to/cc/bcc/reply-to。
- `flag.flagStatus === "flagged"` → isStarred；`isRead`/`isDraft` 直取。
- `body.contentType` "text"|"html" → textBody|htmlBody（content）；
  `receivedDateTime`/`sentDateTime` 已是 ISO；`changeKey` → providerRevision。

## google-calendar（映射输入 = Google Calendar API v3 event）

- `start`/`end`：`dateTime`（含时区）或 `date`（全天 → 追加 `T00:00:00Z`，allDay=true）。
- `status === "cancelled"` → 墓碑；`etag` → providerRevision；`recurrence` → recurrence.rules。
- `organizer`/`attendees`：`{email, displayName, ...}`。

# JSONata 表达式注意事项（实测）

- **单匹配退化**：过滤或对象构造（`x[cond].{...}`）在只有 1 个匹配时结果是
  单对象而非数组。canonical 的数组字段（addresses / attendees / memberships /
  attachments）必须用数组构造包裹保证类型：`[x[cond].{'role': ..., 'address': ...}]`。
  包裹后无匹配产出 `[]`（合法）。
- **特殊字符字段名用反引号**：`` $exists(`@removed`) ``、`` `@odata.deltaLink` ``。
- **数组直接当条件会逐项映射**：存在性/判空一律 `$count(x) > 0` 或
  `$count($filter(labelIds, function($v){$v='UNREAD'})) = 0`。
- **`$append` 只接受 2 个参数**：多段拼接需嵌套并数组包裹：
  `[$append($append(a, b), c)]`。
- 递归下降收集 MIME 节点用 `**[mimeType='text/plain'][0].body.data`
  （`($**)` 语法不合法）。
- 无匹配的字段表达式返回 undefined，服务端自动略过该字段；不要用占位值
  （title 必填除外，canonical 规定缺失时输出 `"(无标题)"`）。
