# everroom-connectors 契约测试夹具（P0 产出）

本目录固化 gateway ↔ OpenConnector（@oomol-lab/open-connector@1.3.5，commit 5719a69）
的 HTTP 契约样本。上游升级时：重跑采集脚本核对样本，差异 = 显式决策点。

## 1. runtime action 封套（`runtime-action-envelope.json`）

`POST /v1/actions/{service}.{action}` 成功/失败响应的形状：
`{ success: true, message, data, meta: { executionId, actionId, auditPersisted } }`
`{ success: false, message, data, errorCode, meta }`

## 2. 五 provider action 输入输出样本（`actions/*.json`）

| 文件 | action | 关键字段（输出消费点） |
|---|---|---|
| gmail-fetch_emails.json | gmail.fetch_emails | messages[].{messageId,labelIds,subject,sender,to,messageTimestamp,messageText,attachmentList}、nextPageToken、resultSizeEstimate |
| gmail-list_history.json | gmail.list_history | history[].messagesAdded[].message.id、messagesDeleted、historyId、nextPageToken |
| notion-search.json | notion.search | results[]、has_more、next_cursor |
| googlecalendar-sync_events.json | googlecalendar.sync_events | events[]、nextPageToken、nextSyncToken |
| googledrive-changes_list.json | googledrive.changes.list | changes[]、nextPageToken、newStartPageToken |
| outlook-list_messages.json | outlook.list_messages | messages[]、nextLink（⚠️ 无 delta，待上游） |

输出字段与 provider 原生 REST 响应同名（action 即 REST 的结构化包装）——
这是链路A适配器零改动平移的基础（Seam 1，open-connector-sync-executor.ts）。

## 3. 连接名传递（映射表方案，P0-V5 结论）

connectionName 四种来源（connect-server.ts readConnectionName）：
body.connectionName / body.alias / header x-oomol-connector-alias / query。
EverRoomSass 转发层使用 **x-oomol-connector-alias**（服务端权威注入，
桌面不传 connectionName）。

## 4. 鉴权面

- runtime 面（/v1 /mcp）：Bearer runtime token
- admin 面（/api/oauth/* /api/connections/*）：Bearer admin token
- OAuth 回调 /oauth/callback：公开（provider 302 直达）

## 5. 采样脚本

夹具为手工核对上游源码（src/providers/*/actions.ts + server/api/runtime-api.ts）
后固化的最小样本；运行时回归由 open-connector-sync-executor.test.ts 的
路由单测与 fake-runner 集成测试覆盖。
