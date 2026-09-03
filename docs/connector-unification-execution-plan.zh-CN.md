# 连接器统一整改执行方向 v1

> 状态：已定稿（决策见 §10）
> 日期：2026-09-03
> 前置文档：《连接器架构统一设计 v3》（connector-platform-refactor-plan 同源提案，下称「设计 v3」）
> 决策输入：2026-09-03 评审（A–G 共 21 项，全部落定，见 §10）

---

## 0. 决策摘要（与设计 v3 的差异）

设计 v3 的五个 seam、双链路保留、删 Nango、L0/L1/L2 阶梯全部维持，**以下三点按最新决策调整**：

1. **OpenConnector 固定 SaaS 部署、默认 SaaS 模式**（原 P3「云端化」从可选升级为默认路径，且必须完成 SaaS 侧建设）；
2. **submodule 化**：gateway 连接器模块 + connector-contract 包 + desktop supervisor 抽为独立 git 仓库，以 submodule 挂回 EverRoomMac（仅挂 Mac 仓库）；
3. **SaaS 侧代码落在 EverRoomSass 仓库**（oo 部署、admin 管理页、路由转发、JWT 对接），不进 submodule。

**明确不做**：outlook/google-docs 增量不足时的「全量 + 指纹 diff」降级（E3，理由见 §7 风险 R3）、Nango 回滚开关（E4）、ics/feishu-wiki 直连适配器改造（E2）、connectors.sqlite 并入 drizzle 迁移体系（E5）。

---

## 1. 目标架构（定稿）

```
┌────────────────────────────────────────────────────────────────────┐
│ EverRoomSass（独立部署的 oo SaaS 实例）                              │
│   OpenConnector server（Node 容器，sqlite 文件卷持久化）              │
│   OAuth client 配置由 admin 管理页 → oo oauth-client-config-service │
│   路由：EverRoomSass api 反向纯转发（不解析、不改写）                 │
└──────────────────────────┬─────────────────────────────────────────┘
                           │  桌面默认走 SaaS（EverRoomSass 域名转发）
                           │  本地模式 = OpenConnectorSupervisor 拉起（隐私兜底，打包保留）
┌──────────────────────────┴─────────────────────────────────────────┐
│ EverRoomMac / gateway                                               │
│   submodule: everroom-connectors/                                  │
│     ├─ OpenConnectorHttpClient（唯一传输缝，HTTP 直连）              │
│     ├─ ConnectorManager（链路A编排，pull 适配器平移到 HTTP action）   │
│     ├─ ConnectorSyncService（链路B编排，spawn → HTTP）              │
│     ├─ 归一化 + 双 sink（原样保留）                                  │
│     └─ desktop OpenConnectorSupervisor（本地模式生命周期）           │
└────────────────────────────────────────────────────────────────────┘
```

### 1.1 传输与部署模式

| 模式 | oo 实例位置 | 打包 | 默认 |
|---|---|---|---|
| SaaS | EverRoomSass 侧容器（api 反代转发） | 不占本地空间 | **是**（要求已登录 SaaS 账号） |
| 本地 | OpenConnectorSupervisor 拉起本地 server | open-connector(98M)+oo(71M) 保留打包 | 否（设置页全局开关切换） |

- 模式切换是**全局单开关**（D1），切换后已有连接提示「需重新授权」（C3），不做 token 迁移；
- 未登录 SaaS 账号时**不自动回退**本地模式，要求登录（D2）；
- SaaS 模式下 supervisor 不拉起本地进程（`NXCORE_CLI_CONNECTOR_MANAGED=false` 通道已存在）。

### 1.2 鉴权与多租户

- 桌面 → SaaS oo：**per-user JWT**（C1-b）。EverRoomSass 复用现有 JWT 体系签发连接器用途 token，oo `runtime-jwt` 验签；验签对接方式（共享密钥 / JWKS / audience 约定）列为 **P0 新增验证项**（见 §3 P0-V5），若对接成本超预期，升级决策后再实施，不静默降级为全局 runtime token；
- admin → oo 管理：oo admin token（服务端环境变量持有，不落桌面）；
- connectionName 规范由 **SaaS 侧统一定义**（C2），格式约定：`{tenantId}:{userId}:{service}`（P0 与 oo 连接模型核对后可调），同一用户多设备**共享**同一 connection；
- OAuth client 凭据（google/microsoft/notion 等）全部配置在 SaaS oo 的 `oauth-client-config-service`，桌面不再持有任何 client id/secret（连带删除 `NXCORE_NANGO_*` 凭据族）。

---

## 2. Submodule 拆分方案（A1-a / A2 / A3 / F2 / F3）

### 2.1 新仓库：`everroom-connectors`

| 内容 | 来源（EverRoomMac 内路径） | 去向（submodule 内） |
|---|---|---|
| gateway 连接器模块 | `apps/gateway/src/modules/connectors/`（全目录，含 sync-providers/、providers/、auth-channels/） | `gateway-module/` |
| 契约包 | `packages/connector-contract/` | `connector-contract/`（保持独立 package） |
| desktop supervisor | `apps/desktop/src/main/open-connector/`（supervisor + 相关 IPC handler 逻辑） | `desktop-host/`（supervisor + 与宿主的装配说明/薄胶水接口） |
| P0 契约测试夹具 | 新增 | `test-fixtures/`（随模块走，F2） |

**不进 submodule**（留宿主）：renderer 页面（ConnectorSyncPage/ConnectorConsolePage/SettingsPage 新区块）、agent skills（`agents/connector-sync/`）、gateway `create-server.ts` 装配代码、desktop main/index.ts。submodule 通过 exports 暴露装配函数与类型，宿主引用。

### 2.2 宿主侧薄胶水（EverRoomMac 保留的接缝）

- gateway：`create-server.ts` 改为从 submodule 包 import（`ConnectorManager`/`ConnectorSyncService`/`OpenConnectorHttpClient`/路由注册函数）；
- desktop：main/index.ts 保留窗口与 IPC 注册，supervisor 实例化来自 submodule `desktop-host`；
- 配置：沿用 `NXCORE_CLI_CONNECTOR_*` 配置族（gateway config.ts 读取后注入），submodule 不直接读 env，全部构造注入（**submodule 零 env 依赖**，保证可移植）。

### 2.3 仓库操作顺序（保证可回溯）

1. `git filter-repo` 或手动 `git mv` + 单独提交，保留原文件历史（优先保 history 的 mv 方式）；
2. EverRoomMac 根 `.gitmodules` 增加 `submodules/everroom-connectors`（新路径，不复用原 nango submodule 位 `modules/connector`，E4 直接删）；
3. 宿主 tsconfig/pnpm workspace 调整：submodule 内 `gateway-module` 以源码路径或 workspace 包形式被 gateway 依赖（实现时二选一，原则：gateway 对 submodule 的 import 路径唯一且稳定）；
4. CI：EverRoomMac 流水线增加 `submodule sync` 步骤；submodule 仓库独立跑 vitest。

### 2.4 submodule 与 SaaS 的关系

EverRoomSass **不挂载** submodule（A2）。SaaS 侧只消费 HTTP API（转发 + admin 代理 + JWT 签发），与 submodule 无代码耦合。

---

## 3. 分阶段实施（重排后）

### Phase 0 · 覆盖验证 + 鉴权 spike（1.5-2 人日，P1 的门）

对五个主力 provider 核对 oo action 粒度（原表维持）：

| provider | 需要 | 风险 |
|---|---|---|
| gmail | fetch_emails / list_history（historyId 增量） | 低 |
| notion | search / retrieve_page_markdown | 低 |
| google-calendar | 事件列表 + syncToken | 低 |
| google-docs | drive 列表 + export | 中：确认 action 存在 |
| outlook | deltaLink 增量 | 高：实测 |

**新增验证项**：

- **P0-V5 JWT 对接验证**：EverRoomSass 签发的 JWT 能否被 oo `runtime-jwt` 正确验签（issuer/audience/密钥协商方式），给出对接结论与配置清单；
- **P0-V6 转发链路验证**：oo 的 connect 授权流（302/cookie/session）经 EverRoomSass 反代后是否完整可用（connect-app 资源路径、回调 URL 的 base path 假设）；
- **P0-V7 admin API 清单**：oo `oauth-client-config-service` 的管理端点面（路径/鉴权/脱敏返回），作为 admin 页面的接口契约。

**产出**：action 清单 + 契约测试夹具（入 `test-fixtures/`）+ V5/V6/V7 结论单页。

**硬门槛**：outlook（或任一 provider）action 粒度不足时，**不做降级**（E3）——该 provider 标记为「SaaS 整改后待上游补齐」，链路维持现状（见 §7 R3），不阻塞其他 provider 与整体架构切换。

### Phase 1 · Submodule 拆分 + HttpClient + 双链路切换（5-6 人日）

1. **先拆 submodule**（§2.3 顺序，纯搬迁零行为变更，Mac 仓库测试全绿为验收）；
2. 新增 `OpenConnectorHttpClient`：基于 `service.ts:2749`（runOpenConnector）与 `open-connector-tools.ts:176`（runOo）现有封套解析逻辑合并重写（E1：设计 v3 所述 `open-connector-client.ts` 不存在，以实际代码为准），含超时/重试（Retries:3 / Retry-On:408 语义）/脱敏/连接错误映射/64MiB 上限去除；
3. Seam 2：`runConnectorAction`（service.ts:1527）内部 spawn → `HttpClient.runAction`，签名不变，`runOpenConnector` 60 行删除；
4. Seam 1：链路A五 provider pull 适配器从 `NangoExecutor.proxy`（nango-executor.ts:50-74）平移到 action 编排，`ConnectorExecutor` 接口与 `PullPage`/游标 CAS 语义不变；
5. Seam 3：`createOpenConnectorPiTools` 的 `runOo` spawn 换 HTTP，工具 schema/审批链不变；
6. Seam 5 表迁移：`connector_connections` 探测式 `RENAME COLUMN nango_config_key→service / nango_connection_id→connection_name`（不并入 drizzle，E5）。

**验收**：本地模式（supervisor 拉起的 oo）下 gmail/notion/gcal 同步 E2E 通过；无 `oo` 子进程 spawn。

### Phase 2 · SaaS 部署 + admin 管理 + 默认 SaaS 切换（4-5 人日 + 运维）

EverRoomSass 仓库内：

1. **oo SaaS 实例容器化**（B1-b）：Node 容器跑 `@oomol-lab/open-connector` server（npm 固定版本，tarball 钉 commit 策略与 Mac 侧一致并加契约测试），sqlite 文件卷持久化，独立内部端口；
2. **api 纯转发**（B2/D4）：EverRoomSass api 新增转发路由（如 `/api/v1/connectors/*` → oo 实例），**只做透传不改写**，鉴权在网关处换发：桌面请求带 EverRoomSass JWT → 转发层校验用户身份 → 以 per-user 语义向 oo 传递（具体传递形态按 P0-V5 结论：原 token 透传或换签）；
3. **admin OAuth 配置页**（B3）：`apps/admin` 新增「连接器 OAuth 配置」页，直接代理 oo admin API（oo admin token 由 api 服务端持有）；页面能力：provider 列表、client id/secret 增改、连接测试；复用现有 runtime-config 的密钥脱敏交互模式；
4. **JWT 签发对接**：按 P0-V5 结论落地（新增 token purpose/audience 或独立签发路径）。

EverRoomMac 侧：

5. **设置页「连接层模式」区块**（D1/D2）：全局开关「SaaS（默认）/ 本地」，未登录 SaaS 账号时引导登录（不回退）；展示当前模式与连接健康状态；切换时提示「已有连接需重新授权」（C3）；
6. **默认 SaaS 接线**：`NXCORE_CLI_CONNECTOR_URL` 默认指向 EverRoomSass 转发路由；SaaS 模式下 supervisor 不拉起本地进程；本地 runtime（169M）**仍打包**（D3），体积目标 ≤400M；
7. `desktopPageMode` sources/connectors 分叉**一并消除**（D5）：main/index.ts:2800-2854 的互斥启动逻辑删除，统一为 oo 常驻策略（页面用到才拉起、失败仅禁用工具）。

**验收**：默认 SaaS 模式下完成 gmail/notion 授权→同步→双 sink E2E；admin 页可完成一个 provider 的 OAuth client 配置；模式切换 UX 符合 C3。

### Phase 3 · 删除 Nango（2 人日）

submodule 位 `modules/connector`（nango fork）、`prepare-nango-runtime.mjs`、`NangoSupervisor`（441行）、`nango-bootstrap/-authorization/-executor`、`sync-engine` 的 nango 分支、extraResources `nango` 段、`NXCORE_NANGO_*` 配置族（含 config.ts:778-779/1131-1141 及校验）、`desktopPageMode` 残余引用。**不设回滚开关**（E4）。**-810M。**

### Phase 4 · 清理与验收（2 人日）

- README 与 connector 相关设计文档更新/归档（含本文件转「已执行」）；
- 双编排器合并评估、L1 声明式映射引擎评估（可选优化，不阻塞）；
- 打包验收 + E2E 全量（§8）。

---

## 4. 各仓库 / 模块职责总表

| 仓库/模块 | 职责 | 变更 |
|---|---|---|
| **submodule `everroom-connectors`** | gateway 连接器模块 + contract + supervisor + 契约夹具 | 新建（P1） |
| EverRoomMac（宿主） | create-server 装配、renderer 页面、设置页新区块、agent skills | 薄胶水化 |
| EverRoomSass api | oo 实例容器 + 纯转发路由 + admin 代理 + JWT 签发 | 新增模块 |
| EverRoomSass admin | OAuth client 配置管理页 | 新增页面 |
| oo 上游（@oomol-lab） | OAuth、action 目录、connect UI、密文存储 | 钉 commit + 契约测试 |

---

## 5. 配置项最终态

| 配置 | 处置 |
|---|---|
| `NXCORE_NANGO_*` 全族（URL/SECRET/POLL/CLIENT_ID...） | **删除**（P3） |
| `NXCORE_CLI_CONNECTOR_URL` | 保留；默认值改为 EverRoomSass 转发路由；本地模式时指向 supervisor 拉起的实例 |
| `NXCORE_CLI_CONNECTOR_RUNTIME_TOKEN` | 保留（本地模式用；SaaS 模式被 JWT 取代） |
| `NXCORE_CLI_CONNECTOR_CONFIG_DIR / DATA_DIR / CLI_PATH` | 保留（本地模式） |
| `NXCORE_CLI_CONNECTOR_MANAGED` | 保留；SaaS 模式等价 `false`（不拉起本地进程） |
| `NXCORE_CLI_CONNECTOR_AGENT_MODE` | 保留 |
| `NXCORE_DESKTOP_PAGE_MODE`（sources/connectors） | **删除**（P2，随分叉消除） |
| EverRoomSass env 新增 | oo 实例地址、oo admin token、JWT 对接密钥/配置（按 P0-V5） |

---

## 6. 工作量汇总

| 阶段 | 内容 | 工作量 |
|---|---|---|
| P0 | action 覆盖 + JWT/转发/admin API 三个 spike | 1.5-2 人日 |
| P1 | submodule 拆分 + HttpClient + 双链路 + 表迁移 | 5-6 人日 |
| P2 | SaaS 部署 + admin 页 + 设置页 + 默认 SaaS + 分叉消除 | 4-5 人日 + 运维 |
| P3 | 删 Nango | 2 人日 |
| P4 | 清理验收 | 2 人日 |
| **合计** | | **~15-17 人日 + 运维** |

---

## 7. 风险与对策（更新版）

| # | 风险 | 对策 |
|---|---|---|
| R1 | **JWT 验签对接成本超预期**（oo runtime-jwt 与 EverRoomSass JWT 体系不匹配） | P0-V5 前置验证；若不匹配，升级决策（改 oo / 换签层 / 过渡方案），不静默降级全局 token |
| R2 | **反代破坏 oo 授权流**（302/cookie/base path） | P0-V6 前置验证；必要时 oo 侧支持 base-path 配置或子域名直连兜底 |
| R3 | **outlook deltaLink action 缺失**（已决策不降级） | 该 provider 保持现状（链路A Nango 版在 P3 删除前仍可用），标记「待上游补齐」；P3 删 Nango 时若仍缺 action，outlook 从五主力降级为待定，接受功能缺口（已获业务确认 E3） |
| R4 | 上游 tarball 钉 commit 漂移 | P0 契约测试固化（submodule `test-fixtures/`）；升级显式决策 |
| R5 | 多用户并发下 SaaS oo 单实例 sqlite 写竞争 | B1-b 容器单实例 + 文件卷；用量级评估（P2 运维项）；超限再议 D1 化 |
| R6 | submodule 拆分丢历史/破坏 CI | mv 保历史 + 拆分独立 PR，Mac 全量测试绿为门 |
| R7 | 模式切换后连接失效的用户困惑 | C3 统一 UX：切换即提示「需重新授权」+ 连接面板状态标记 |

---

## 8. 验收标准（更新版）

1. mac dmg：P3 后 ≤ 400M（当前 ~800M）；
2. 默认 SaaS 模式开箱可用（登录 SaaS 账号后零额外配置）；本地模式可从设置页一键切换；
3. 无 `oo` 子进程 spawn；无 nango / embedded-postgres 进程；首启无 10 分钟等待；
4. E2E：gmail/notion/google-calendar（+google-docs/outlook 视 P0 结果）授权 → 同步 → 记忆与知识库双 sink 可查；增量游标续跑、断点续传、410 全量重建正常；
5. SaaS↔本地切换后「需重新授权」提示与重授权流程正常；
6. admin 页可管理至少一个 provider 的 OAuth client 配置；
7. submodule 可独立 clone 并跑通自身测试；
8. L0 长尾连接器零代码接入演示。

---

## 9. 开放问题（不阻塞开工，随阶段收敛）

1. P0-V5 若 oo 不支持 EverRoomSass 的验签方式，倾向「api 换签」还是「子域名直连 oo（绕过转发）」？——P0 结束时决策；
2. connectionName 规范 `{tenantId}:{userId}:{service}` 与 oo 连接模型（唯一性约束、列表过滤）的契合度——P0 核对；
3. SaaS oo 实例的备份/监控归属（EverRoomSass 运维体系）——P2 运维项细化；
4. 双编排器合并、L1 引擎——P4 评估。

---

## 10. 决策记录（2026-09-03）

| # | 决策 | # | 决策 |
|---|---|---|---|
| A1 | submodule 主体 = gateway 连接器模块 | B3 | admin 直接代理 oo admin API |
| A2 | 仅 EverRoomMac 挂载 | C1 | per-user JWT（Sass 签发） |
| A3 | gateway 模块+contract+supervisor 进 submodule | C2 | connectionName 规范 SaaS 定，多设备共享 |
| B1 | oo SaaS = Node 容器 + sqlite 卷 | C3 | 切换即提示需重新授权 |
| B2 | Sass api 纯转发到 oo 实例 | D1 | 全局单开关 |
| D2 | 要求登录，不回退 | E4 | 不留回滚开关，直接删 |
| D3 | 本地 runtime 仍打包，≤400M | E5 | connectors.sqlite 不并入 drizzle |
| D4 | oo API 挂 Sass 路由纯转发 | F1 | SaaS 代码放 EverRoomSass 仓库 |
| D5 | desktopPageMode 分叉一并消除 | F2 | 契约夹具放 submodule |
| E1 | 以实际代码为准（client 文件不存在） | F3 | 设置页区块留宿主 |
| E2 | ics/feishu-wiki 暂不处理 | G1/G2 | 里程碑重排与验收更新确认 |
| E3 | 不做无游标降级策略 | | |
