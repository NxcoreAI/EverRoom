# P0 覆盖验证结论（连接器统一整改）

> 状态：已完成（2026-09-03）
> 依据：《连接器统一整改执行方向 v1》§3 Phase 0
> 上游版本：`@oomol-lab/open-connector@1.3.5`（tarball 钉 commit `5719a69`）
> 勘察对象：`node_modules/.pnpm/@oomol-lab+open-connector@…/src/`（源码直接勘察，非运行时验证）

---

## 1. 五 provider action 覆盖核对

| provider | 需要 | 结论 | 佐证（`src/providers/<p>/actions.ts`） |
|---|---|---|---夹具 |
|---|---|---|---|
| gmail | fetch_emails / list_history（historyId 增量） | ✅ 全覆盖 | `gmail/actions.ts`：fetch_emails、list_history、fetch_message_by_message_id、get_message、search_threads 等 40+ action |
| notion | search / retrieve_page_markdown | ✅ 全覆盖 | `notion/actions.ts`：search、retrieve_page_markdown、query_data_source、list_block_children 等 25 action |
| google-calendar | 事件列表 + syncToken | ✅ 全覆盖 | `googlecalendar/actions.ts:471` `sync_events`（"Incrementally sync events"，输入含 syncToken :245/:265，输出含 nextPageToken/nextSyncToken :686-687）；另有 list_events / list_events_all_calendars |
| google-docs | drive 列表 + export（changes 增量） | ✅ 全覆盖 | `googledrive/actions.ts:64` `changes.getStartPageToken`、`:112` `changes.list`（输出 newStartPageToken :432）、`:1421` `files.export`；`googledocs/actions.ts` 有 get_document_plaintext / export_document_as_pdf / search_documents |
| outlook | deltaLink 增量 | ⚠️ **无 delta** | `outlook/actions.ts:163` `list_messages` 仅 OData filter + nextLink 分页（top/filter/orderby/select），全 provider 目录 grep `delta` 零命中 |

**Outlook 处置（依 E3 决策：不做降级）**：outlook 标记「待上游补齐」。链路A的 outlook 适配器在 P3 删 Nango 前仍可用；P3 时若上游仍未补 delta action，接受 outlook 功能缺口（从五主力降级为待定），不实现「全量 + 指纹 diff」降级。

## 2. V5 · runtime-jwt 验签机制（结论：不采用 JWT 直连，改映射表方案）

- 算法：**仅 JWKS 非对称验签**（`server/api/runtime-jwt.ts:43-46`，createRemoteJWKS + jwtVerify），**不支持 HS256**；iss/aud 精确匹配、exp 强制、JWKS 须 HTTPS（或 loopback）。
- **关键缺口：JWT 无租户隔离**。验签通过不产生 RuntimeGrant（`auth.ts:253-264`），connectionName 完全由客户端自报（`connect-server.ts:1096-1105`），任何合法 JWT 可访问任意 connection。
- **定案（2026-09-03 用户决策）**：桌面请求不携带 oo connectionName；EverRoomSass 转发层维护**映射表**（userId+service ↔ oo connectionName），转发时注入。oo 侧**不配置 JWT/JWKS**（鉴权在 SaaS 转发层终结），SaaS→oo 使用 runtime token（`OOMOL_CONNECT_RUNTIME_TOKEN`）。RS256/JWKS 对接方案保留存档，不实施。

## 3. V6 · 反代与授权流（结论：子路径转发可行，console 不可用为已知限制）

- oo 服务端路由全部根路径注册，无 hardcoded origin（publicOrigin 注入，`server/index.ts:25`）；子路径反代剥前缀后 JSON API（/v1 /api /mcp /health）与 **OAuth 回调流可用**：callback 公开路径（`auth.ts:104-105`），`OOMOL_CONNECT_ORIGIN` 设为带前缀全 origin 后 `expectedRedirectUri` 正确生成（`oauth-client-config-service.ts:117-120`），provider 侧按精确 redirect_uri 注册即可。
- **已知限制**：内置 web console 前端用根绝对路径 fetch（`web/src/api.ts:16-47`），子路径部署下 console/docs 不可用。桌面授权流不依赖 console（走 gateway 轮询 + 独立窗口），admin 管理页由 EverRoomSass 自建。本地模式 console 不受影响（根路径直连）。
- admin cookie `oomol_connect_admin_session` path=/ host-wide：SaaS 侧 admin 面不直接暴露 console，无实际影响。

## 4. V7 · admin / oauth-client-config API（admin 页面接口契约）

鉴权：`OOMOL_CONNECT_ADMIN_TOKEN`（constant-time 比较，`auth.ts:218-232`）；`/v1` `/mcp` 为 runtime scope，其余为 admin scope（`auth.ts:239-241`）。

**OAuth client 配置（admin 页直接对接）**：

| 端点 | 方法 | 请求 | 响应 |
|---|---|---|--- 页面 |
|---|---|---|---|
| `/api/oauth/configs` | GET | — | `[{service, configured, clientId\|null, expectedRedirectUri, auth}]`；secret 永不回显 |
| `/api/oauth/configs/:service` | PUT | `{clientId, clientSecret, extra?, secretExtra?}` | 脱敏 summary；extra 字段按 provider 白名单过滤 |
| `/api/oauth/configs/:service` | DELETE | — | `{service, configured: false}` |
| `/api/oauth/authorizations` | POST | `{service, connectionName?}` | `{authorizationUrl, state}`（发起授权，admin 鉴权） |

**连接管理**：`GET /api/connections`（全量，无 service 过滤）、`PUT/DELETE /api/connections/:service`；runtime 侧 `GET /v1/apps`、`/v1/apps/services/:service`、`/v1/apps/authenticated`。无独立刷新 token 端点（action 执行时惰性刷新，`connection-service.ts:505-560`）。

**服务配置**：`PORT`（默认 3000）、`HOST`（默认 127.0.0.1，容器需 0.0.0.0）、`OOMOL_CONNECT_ORIGIN`（redirect_uri 基址）、`OOMOL_CONNECT_DATA_DIR`（sqlite 于 `<dataDir>/connect.sqlite`）、`OOMOL_CONNECT_ENCRYPTION_KEY`（凭据加密，**必配**）。

## 5. 对 P1/P2 的影响清单

1. **HttpClient 的 action 面**：五 provider 所需 action 全部存在（outlook 增量除外），Seam 1/2 平移无阻塞；
2. **SaaS 转发层设计**（P2）：需实现 userId→connectionName 映射表 + 转发时 header 注入（`x-oomol-connector-alias`，见 `connect-server.ts:1096-1105` 支持的四种 connectionName 来源之一）；
3. **redirect_uri 注册**（P2 运维）：Google/Microsoft/Notion OAuth client 需按 `https://<sass-host>/<prefix>/oauth/callback` 精确注册；
4. **oo 环境变量清单**（P2 部署）：`PORT/HOST=0.0.0.0/OOMOL_CONNECT_ORIGIN/OOMOL_CONNECT_ADMIN_TOKEN/OOMOL_CONNECT_RUNTIME_TOKEN/OOMOL_CONNECT_ENCRYPTION_KEY/OOMOL_CONNECT_DATA_DIR`；不配 JWT 三件套。

---

## 附：与执行方向文档的差异

- §1.2「per-user JWT + runtime-jwt 验签」**作废**，改为 §2 映射表方案（用户 2026-09-03 决策）；
- 执行方向文档 §3 P0-V5 描述的「共享密钥/JWKS 对接」验证项已由映射表方案替代关闭；
- 其余（V6 子路径可行 + console 限制、V7 API 契约）与执行方向一致。
