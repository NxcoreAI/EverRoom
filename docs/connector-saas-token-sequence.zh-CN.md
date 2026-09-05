# 连接器栈 token 链路时序（connector-mode = 'saas'）

> 范围：仅连接器栈的 saas 连接层（默认模式），不含 local 模式、本地数据源与迁移导入。
> 代码依据：`apps/desktop/src/main/cloud/saas-client.ts`、`apps/desktop/src/main/gateway/saas-connector-bridge.ts`、`apps/desktop/src/main/index.ts`（connector-mode 段）、`submodules/everroom-connectors/gateway-module/open-connector-sync-executor.ts`。

## 参与者

| 参与者 | 说明 |
| --- | --- |
| 渲染进程 | SourcesPage / 连接器 UI（`window.nxcore.nangoConnector`） |
| 桌面主进程 | Electron main：`SaasConnectorBridge`、`SaasClient`、oo 会话缓存与 env 注入 |
| SaaS | EverRoomSass：登录态、oo 会话代发、OAuth 授权代发起（经 oo admin 面），持有 oo admin token |
| 本地 Gateway | NxCore gateway（子进程）：连接注册表、sync engine、同步 worker，经 env 持 oo 用户 token |
| oo | OpenConnector 多租户数据面：托管 provider OAuth token（用户租户内），暴露 action 取数 |
| 上游 Provider | Gmail / Outlook / Google Calendar / Google Docs / Notion |

## 时序图

```mermaid
sequenceDiagram
    autonumber
    participant UI as 渲染进程
    participant Main as 桌面主进程
    participant SaaS as EverRoomSass
    participant GW as 本地 Gateway
    participant OO as oo 数据面
    participant Up as 上游 Provider

    rect rgb(235, 244, 255)
    Note over Main,OO: 阶段一 · 换取 oo 会话并注入（启动期 saas 模式 / 账号登录事件 / 授权前预热）
    Main->>SaaS: POST /app/connectors/oo/token（EverRoom 登录态）
    SaaS-->>Main: { baseUrl, tenantId, token(oct_…) }<br/>SaaS 侧幂等：已登记直接返回，否则代发并登记
    Note over Main: 缓存 connectorOoSessionCache（按 userId 去重）<br/>oo token 与 EverRoom 会话生命周期解耦（持久稳定）
    Main->>Main: applyConnectorOoSession()<br/>重建 ooCliBridge（桌面直连 oo 的在线工具面）
    Main->>GW: 注入 env（未运行则首次 spawn，已运行则重启生效）<br/>NXCORE_CLI_CONNECTOR_URL / RUNTIME_TOKEN / MANAGED=false
    Note over GW,GW: gateway 与桌面持同一 oo 用户 token，直连 oo 数据面
    end

    rect rgb(255, 248, 235)
    Note over UI,OO: 阶段二 · 连接 provider（OAuth 授权，SaaS 代发起）
    UI->>Main: nangoConnector.startAuthorization(provider)
    Main->>SaaS: POST /app/connectors/authorizations {service}
    Note over SaaS: oo admin token 由 SaaS 持有，客户端与 gateway 均不经手<br/>（gateway 无法代发起授权）
    SaaS-->>Main: { authorizationUrl }
    Main-->>UI: { id, status:'pending', expiresAt: +15min }
    UI->>Up: shell.openExternal 打开授权页，用户登录并同意
    Up->>OO: OAuth 回调直落 oo 公网回调<br/>（redirect_uri = {oo 公网域名}/oauth/callback，state 锁定用户租户）
    OO->>OO: 持 client 配置换取 provider token，凭证直接落入用户租户
    loop 渲染层每 2s 轮询直至终态（15min 超时）
        UI->>Main: authorizationStatus(id)
        alt oo 会话未就绪
            Main-->>UI: pending
        else oo 会话就绪
            Main->>OO: GET /v1/apps/services/:service（Bearer oct_…，5s 探测）
            alt 连接已落地 oo 租户
                Main->>GW: POST /v1/nango-connectors/connections（补注册连接）
                GW-->>Main: connection
                Main-->>UI: connected
                UI->>GW: triggerSync(scope,'full') 首同步（引导关闭后触发）
            else 尚未落地 / gateway 暂不可达
                Main-->>UI: pending（注册失败恢复 pending，下轮重试）
            end
        end
    end
    end

    rect rgb(235, 255, 240)
    Note over UI,Up: 阶段三 · 同步取数（链路A · Seam1：provider REST → oo action；UI 触发与后台 worker 同通道）
    UI->>GW: POST /v1/nango-connectors/scopes/:id/sync {mode}
    GW->>GW: sync engine 经 executor 路由<br/>provider 原生 REST URL → oo action 映射
    GW->>OO: oo action（如 gmail.fetch_emails / notion.search，Bearer oct_…）
    OO->>Up: 持用户租户内 provider OAuth token 调上游 API
    Up-->>OO: 原生响应
    OO-->>GW: action 结构化输出（字段与 REST 一致）
    GW->>GW: 归一化 → 投影 gateway.sqlite connector_* 域表（数据落地本地）
    GW-->>UI: SyncRun / 邮件·日历·文档可见
    end

    rect rgb(248, 240, 255)
    Note over Main,GW: 阶段四 · 连接注册对账（gateway 就绪后调度；覆盖重启前完成的授权与注册时 gateway 不可达的授权）
    Main->>OO: GET /v1/apps（Bearer oct_…）
    Main->>GW: GET /v1/nango-connectors/status + /providers
    Main->>GW: oo 有而注册表无的连接补 register<br/>（仅注册表白名单 provider，退避重试最多 3 轮）
    end
```

## token 分层

| token | 谁持有 | 用途 |
| --- | --- | --- |
| EverRoom SaaS 会话（refresh token） | 主进程 SaasClient | 登录态；换 oo 会话；代发起授权 |
| oo 用户 runtime token（`oct_…`） | 主进程缓存 + 注入 gateway env（两者共用） | 桌面探测 oo（授权落地/对账）；gateway 数据面取数；租户锁定在 token 内 |
| provider OAuth token | 仅 oo 用户租户 | oo 调上游 provider 用；客户端与 gateway 全程不经手 |
| gateway 本地 token | 主进程 ↔ 本地 gateway | `/v1/nango-connectors/*` 等本地内部通道，与 oo 无关 |

## 关键端点

| 方向 | 端点 | 用途 |
| --- | --- | --- |
| 桌面 → SaaS | `POST /app/connectors/oo/token` | 换 oo 用户会话（幂等） |
| 桌面 → SaaS | `POST /app/connectors/authorizations` | 代发起 OAuth，返回授权页地址 |
| 桌面 → oo | `GET /v1/apps/services/:service` | 授权落地探测（轮询） |
| 桌面 → oo | `GET /v1/apps` | 对账用账号清单 |
| 桌面 → Gateway | `POST /v1/nango-connectors/connections` | 连接补注册 |
| Gateway → oo | oo action（gmail/notion/google-calendar/google-docs/outlook 五族映射） | 链路A取数 |
