# Connector module: Agent just-in-time retrieval

连接器已从「同步管道」收敛为「Agent 即席检索」。模块里不再有定时同步、
scope/run/游标、域投影或本地内容副本；连接的事实源是 oo，本地只保留
「已断开」墓碑与查询编排。

## 组成

| 文件/目录 | 职责 |
|---|---|
| `open-connector-http-client.ts` | 与 oo 的唯一 HTTP 传输缝（action / apps / schema / search） |
| `open-connector-authorization.ts` | 本地模式 OAuth 发起与轮询（SaaS 模式由桌面经 SaaS 代发起） |
| `connection-runtime.ts` | 连接目录：oo 实时清单 + 本地墓碑 |
| `routes.ts` | REST 面：status / providers / connections / authorizations；同步时代端点返回 410 |
| `query/` | 查询档案、扇出、合并、coverage、ref、read；无持久化 |
| `converters.ts` / `email-content.ts` / `legacy-office.ts` | 文件 → Markdown（服务文档理解与导入，不属于连接器同步） |

## 查询层

- `query/types.ts`：`QueryHit / Coverage / QueryProfile / ConnectorActionRuntime`
- `query/service.ts`：解析连接 → 按 provider 档案翻译 → 并发 action → 合并/去重/截断
- `query/profiles/*`：每家 provider 的搜索/详情映射；新增 provider = 一个文件 + 一行注册
- `query/ref.ts`：无状态 ref（base64url），read 只认 ref
- `query/http-runtime.ts`：生产适配器（包装 `OpenConnectorHttpClient`）
- `query/filtered-runtime.ts`：按墓碑过滤已断开的连接

## 边界

- 本模块不感知 SaaS token：宿主把当前 oo 会话注入 `OpenConnectorCliConfig`。
- 查询只读；写操作在 v1 被 MCP 中转的只读守卫拒绝。
- 文档导入（飞书/Notion）走宿主 `documents/import`，与本模块的查询链路独立。
