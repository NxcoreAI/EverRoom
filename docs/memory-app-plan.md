# PC 端「记忆」应用改造 — 接入 MemoryCore 查看方案

> 状态：已实施（2026-08-15，代码全部落地并通过类型检查 / 单测 / 构建；真实 MemoryCore 联调待验证）
> 日期：2026-08-15
> 前置：`docs/pi-agent-memory-plan.md`（已实施，pi agent 已接入 MemoryCore 读写链路）
> 范围：`apps/desktop`（渲染层 + main + preload）、`apps/gateway`（新增 memory 模块）、`packages/agent-runtime-pi`（扩展 MemoryCoreClient）。不改 MemoryCore 本身。

## 1. 现状与问题

桌面端目前存在**两套互不相通的"记忆"实现**：

| 位置 | 现状 |
| --- | --- |
| `MemoryPage`（`apps/desktop/src/renderer/src/components/pages/MemoryPage.tsx`） | 纯 mock：组件顶部写死 `MEMORIES` 数组 + 硬编码筛选计数（128/96/24/8），无任何数据获取 |
| Context Room 的 `MemoriesPane` / `MemoryPane` / `MemoryDetail` | mock 数据（`ported/data.ts`）+ localStorage，实体-事实图谱是演示性质 |
| 真实记忆链路 | 全部封装在 `agent-runtime-pi` 的 memory 扩展内（自动召回/沉淀），渲染层完全不可见——preload 没有 `memory` 命名空间，main 没有 `memory:*` handler，gateway 没有 memory 路由 |

也就是说：**记忆一直在真实地写入 MemoryCore（L0 对话 → 服务端异步提炼 L1/L2/L3），但用户在 PC 端看不到、管不了**。本方案把「记忆」页改造成 MemoryCore 的查看/管理界面。

## 2. 目标与非目标

**目标**

1. `MemoryPage` 从 mock 改为真实数据，按 TencentDB Agent Memory 的 **L0–L3 四层模型**组织信息架构
2. 打通渲染层 → MemoryCore 的完整数据链路（IPC → gateway 代理）
3. 支持查看 + 基础管理：L1 编辑/删除、L3 编辑、L2 阅读、L0 按会话浏览、跨层搜索
4. 记忆未启用（`NXCORE_MEMORY_ENABLED=false`）或 MemoryCore 不可达时有清晰的降级 UI

**非目标（本期不做）**

- Context Room 内 `MemoriesPane` 等记忆面板的接真（保持现状，留作二期；见 §9）
- 写 L0（在 UI 里手工追加对话）、场景文件编辑（`scenario/write`）、`/v3/meta/*` 管理面、多用户/多 team 切换
- 替代 MemoryPanel（TencentDB 自带控制台）——PC 端只做本用户视角的查看器

## 3. 总体架构

```text
渲染层 MemoryPage
   │ window.nxcore.memory.*（新增 preload 命名空间）
   │ ipcRenderer.invoke('memory:*')
   ▼
Electron main：memory-gateway-bridge.ts（新增，仿 agent-gateway-bridge 模式）
   │ HTTP + 网关 token（gateway manifest 已有）
   ▼
Gateway（Fastify）：新模块 apps/gateway/src/modules/memory
   │ /v1/memory/* 路由（TypeBox schema）
   │ 复用 MemoryCoreClient（从 agent-runtime-pi 导出并扩展）
   ▼
MemoryCore（用户自建，默认 http://127.0.0.1:8420）
   /v3/atomic/query|search|update|delete|count
   /v3/scenario/ls|read|count
   /v3/core/read|write|count
   /v3/conversation/query|search|delete|count
   /v2/pipeline/status
```

**关键决策**

- **走 gateway 代理，而不是 main 进程直连 MemoryCore**。理由：
  1. `NXCORE_MEMORY_*` 配置和隔离三元组（team/agent/user）已经在 gateway（`apps/gateway/src/config.ts`），直连则要在桌面端再维护一份配置与传递链；
  2. gateway token 鉴权链路现成（`gateway-supervisor` manifest），不向渲染层暴露 MemoryCore 地址和 API key；
  3. 后续接 SaaS 多用户账号时（`memoryUserId` 替换为账号标识），只有 gateway 一处要改。
- **复用并扩展 `MemoryCoreClient`**（`packages/agent-runtime-pi/src/memory/client.ts`），从包里 `export` 出来给 gateway 的 memory 模块使用，而不是在 gateway 再写一个客户端。agent 用不到的方法不注册到 pi 侧，纯类方法无副作用。超时从构造参数注入（agent 流程保持 3s，UI 浏览用 10s）。
- **渲染层不感知四层协议细节**：gateway 的 `/v1/memory/*` 返回 camelCase 的稳定 DTO，隔离三元组由 gateway 注入，前端永远只看"当前用户"的记忆。

## 4. 数据链路设计

### 4.1 Gateway：`/v1/memory/*` 路由（新模块）

新文件 `apps/gateway/src/modules/memory/`：

| 文件 | 作用 |
| --- | --- |
| `routes.ts` | Fastify 插件，注册下表路由，`config.memory` 为空时整组返回 503 `{error:"memory_disabled"}` |
| `service.ts` | 持有 `MemoryCoreClient` 实例，参数校验后的转发与响应映射 |

路由清单（全部挂 `/v1/memory` 前缀，命名对齐 MemoryCore 语义）：

| 方法+路径 | 转发到 | 请求参数 | 响应 |
| --- | --- | --- | --- |
| `GET /overview` | 并行 `atomic/count` ×3(type) + `conversation/count` + `scenario/count` + `core/read` + `/v2/pipeline/status` | — | `{ enabled, l1: {total, byType}, l0: {total}, l2: {total}, l3: {exists, updatedAt}, pipeline: {...} }`，单路失败该字段置 null（Promise.allSettled） |
| `GET /atomic` | `atomic/query` | `type?`, `limit(默认50,≤100)`, `offset`, `timeStart?`, `timeEnd?` | `{ items: MemoryAtomicItem[], total }` |
| `POST /atomic/search` | `atomic/search` | `{ query, limit?, type? }` | `{ items: (MemoryAtomicItem & {score})[] }` |
| `PATCH /atomic/:id` | `atomic/update` | `{ content, background? }` | `{ id, version, updatedAt }` |
| `DELETE /atomic` | `atomic/delete` | `{ ids[] }` | `{ deletedCount }` |
| `GET /scenario` | `scenario/ls` | `pathPrefix?` | `{ entries: MemoryScenarioEntry[], total }` |
| `GET /scenario/content` | `scenario/read` | `path`(query) | `{ path, content, version, updatedAt }`（content 可为 null） |
| `GET /core` | `core/read` | — | `{ content, version, updatedAt }`（content 可为 null） |
| `PUT /core` | `core/write` | `{ content }` | `{ version, updatedAt }` |
| `GET /conversation` | `conversation/query` | `sessionId?`, `limit(默认50,≤100)`, `offset`, `timeStart?`, `timeEnd?` | `{ messages: MemoryConversationItem[], total }` |
| `POST /conversation/search` | `conversation/search` | `{ query, limit?, sessionId? }` | `{ messages: (…&{score})[] }` |
| `DELETE /conversation` | `conversation/delete` | `{ sessionIds?[], messageIds?[] }` | `{ deletedCount }` |

约定：

- 所有错误统一映射：MemoryCore 连接失败 → `502 {error:"memory_unreachable"}`；`code!==0` → `502 {error:"memory_error", message}`；schema 校验失败走 Fastify 默认 400。前端据此区分"未启用 / 不可达 / 出错"三种态。
- `runtime-factory` 之外，gateway 入口注册 memory 模块时仅在 `config.memory` 存在时挂载（或挂载但恒 503，便于前端探测——**采用后者**，前端 `GET /overview` 一个请求即可判定整个功能态）。

### 4.2 MemoryCoreClient 扩展（`packages/agent-runtime-pi/src/memory/`）

- `client.ts`：constructor 增加 `timeoutMs`（默认 3000）；新增方法 `queryAtomic` / `queryConversation` / `updateAtomic` / `deleteAtomic` / `deleteConversation` / `readScenario` / `writeCore` / `counts` / `pipelineStatus`；`types.ts` 补对应类型（`MemoryConversationItem`、`MemoryScenarioFile`、`MemoryCoreFile`、`MemoryPipelineStatus` 等，字段以 v2-router 实际输出为准：`version` 是 number、`background` 即来源场景名）。
- `index.ts` 增加 `export { MemoryCoreClient }` 及相关类型，供 gateway 引用。
- **不影响 agent 行为**：extension/tools 调用方式不变（默认 3s 超时不变）。

### 4.3 桌面端桥（main + preload）

仿 `agent-gateway-bridge.ts` 新建 `apps/desktop/src/main/gateway/memory-gateway-bridge.ts`：

- `ipcMain.handle('memory:overview' | 'memory:list-atomic' | …)` → 对应 HTTP 调用，错误转成带 `code` 的结构化 Error 抛给渲染层（与 agent 桥一致的模式）
- `apps/desktop/src/main/index.ts` 注册 bridge；`apps/desktop/src/preload/index.ts` 增加 `nxcore.memory` 命名空间（方法与上表一一对应，参数用对象签名）

渲染层类型放 `renderer/src/types/memory.ts`（DTO 与 gateway 响应对齐）。

## 5. MemoryPage 重设计

### 5.1 信息架构

四层模型是核心心智，用**顶部水平 tab 导航**组织。应用已有全局左侧栏，页面内不再放竖向导航，避免出现双左栏：

```text
┌────────────────────────────────────────────────────────────────┐
│ 记忆                                               [🔍 搜索框]  │
│ ┌──────┬──────────┬──────────┬──────────┬────────┐              │
│ │ 总览 │ 原子记忆L1 │  场景L2  │  画像L3  │ 对话L0 │  ← 顶部 tab  │
│ └──────┴──────────┴──────────┴──────────┴────────┘              │
├────────────────────────────────────────────────────────────────┤
│ 主区域（随 tab 切换，占满剩余高度）                                │
│                                                                │
│ 总览：四层计数卡片（L0 对话 N 条 / L1 原子记忆 N 条 /             │
│ L2 场景 N 个 / L3 画像 ✓）+ pipeline 状态条                       │
│ （"L1 提炼中 · 队列 2 个会话" / "空闲"）                          │
│                                                                │
│ 列表类 tab：筛选条 + 列表 + 详情抽屉                              │
│                                                                │
│ 底部：数据来源标注（MemoryCore · 本地服务 · 更新时间）             │
└────────────────────────────────────────────────────────────────┘
```

- tab 标签带层级徽标（原子记忆 L1 / 场景 L2 / 画像 L3 / 对话 L0）；overview 加载后把各层计数作为徽章补到 tab 上
- L2 场景页内部的"文件树 + 正文"分栏是该 tab 自己的内容区布局，不算页面级导航

| Tab | 内容与交互 | 数据来源 |
| --- | --- | --- |
| **总览** | 四层计数卡片（点击跳对应 tab）；pipeline 状态（l1/l2/l3 各自 queued/running/idle）；最近更新时间（取各层 max(updated_at)） | `GET /overview`，进页拉一次 + 手动刷新按钮 |
| **原子记忆（L1）** | 列表项：内容摘要、类型徽标（episodic 情景 / persona 人格 / instruction 指令）、来源场景（`background`）、updated_at；筛选：类型下拉 + 时间范围；分页（limit 50 / offset）；点击展开详情（全文 + background + created/updated）；详情内**编辑**（inline textarea，`PATCH /atomic/:id`）与**删除**（确认弹窗，`DELETE /atomic`） | `GET /atomic` |
| **场景（L2）** | 左侧文件树（按 `path` 的 `/` 分层渲染 `scenario/ls` 结果，目录可折叠，显示 summary）；右侧选中文件的 Markdown 渲染（`GET /scenario/content`，content 为 null 显示空态）；只读 | `GET /scenario` + `/scenario/content` |
| **画像（L3）** | 单篇 Markdown 渲染 + 元信息（version/updatedAt）；**编辑**模式（textarea 或复用现有 Markdown 编辑组件，`PUT /core` 全量覆盖保存）；未生成时空态："画像尚未生成，随着对话积累将由 MemoryCore 自动提炼" | `GET /core` + `PUT /core` |
| **对话（L0）** | 按 session_id 分组的消息流（user 左 / assistant 右气泡，时间戳），默认按时间倒序取最近 N 条再按 session 聚合；顶部时间范围筛选 + "按会话筛选"下拉（下拉项从已加载消息的 session_id 聚合而来——MemoryCore 无独立会话列表接口，不额外造接口）；会话卡片支持**删除整会话**（`DELETE /conversation`，带二次确认） | `GET /conversation` |

**全局搜索**：顶部搜索框回车 → 并行 `POST /atomic/search` + `POST /conversation/search`，结果分两组展示（原子记忆 / 对话命中，命中项带 score 排序与高亮），点击原子记忆命中跳到 L1 详情。

### 5.2 三种降级态（优先做，决定第一印象）

| 状态 | 判定 | UI |
| --- | --- | --- |
| 未启用 | `GET /overview` 返回 `503 memory_disabled` | 居中说明卡片："记忆服务未启用"，说明需在 gateway 配置 `NXCORE_MEMORY_ENABLED=true` 及 MemoryCore 地址，附配置项文档链接 |
| 不可达 | 返回 `502 memory_unreachable` | 居中错误卡片 + 重试按钮（MemoryCore 是独立进程，可能晚于 EverRoom 启动） |
| 空 | overview 各层 total=0 | 每层各自的空态文案（如 L0 空："与 agent 的对话将自动沉淀为长期记忆"） |

### 5.3 视觉与代码组织

- 沿用现有技术栈：纯 CSS（新 `MemoryPage.css`，走 `tokens.css` 变量与 `data-theme`）、lucide-react 图标，**不引入 tea-component/antd**
- 组件拆分（`renderer/src/components/pages/memory/`）：

```text
memory/
├─ MemoryPage.tsx          # 页头 + 顶部 tab 导航 + 全局搜索
├─ MemoryOverviewPane.tsx  # 总览
├─ AtomicMemoryPane.tsx    # L1 列表 + 筛选 + 详情/编辑/删除
├─ ScenarioPane.tsx        # L2 文件树 + 正文
├─ CoreProfilePane.tsx     # L3 查看/编辑
├─ ConversationPane.tsx    # L0 会话流
├─ MemorySearchResults.tsx # 全局搜索结果
├─ MemoryStatusViews.tsx   # 未启用/不可达/空 三种态
└─ useMemoryData.ts        # 数据获取 hook（window.nxcore.memory 封装、加载/错误状态）
```

- 旧的 mock `MemoryPage.tsx` 内容整体废弃；Context Room 的 mock 面板**不动**（见 §9）

## 6. 隔离与安全

| 项 | 处理 |
| --- | --- |
| 三元组 | gateway 侧从 `config.memory` 注入，`/v1/memory/*` 不接受前端传 team/agent/user，天然防止渲染层越权看他人记忆 |
| 写操作面 | 本期暴露的写操作仅 `atomic/update`、`atomic/delete`、`core/write`、`conversation/delete`，均为用户自己的数据；`scenario/write`、`conversation/add` 不暴露 |
| 鉴权 | gateway 对内网 MemoryCore 沿用现有 `x-tdai-service-id` + Bearer；渲染层只见过 gateway token 语义（现有 `nxcore` 通道），不新增暴露 |
| 后续 SaaS 化 | `memoryUserId` 换成账号标识后本方案零改动（渲染层不感知 user 维度） |

## 7. 改动文件清单

| 文件 | 改动 |
| --- | --- |
| `packages/agent-runtime-pi/src/memory/client.ts` | 超时可配 + 新增 query/update/delete/count/pipeline 方法 |
| `packages/agent-runtime-pi/src/memory/types.ts` | 补 L0/L2/L3/统计类型 |
| `packages/agent-runtime-pi/src/index.ts` | 导出 MemoryCoreClient 与类型 |
| `apps/gateway/src/modules/memory/routes.ts`（新） | `/v1/memory/*` 路由 |
| `apps/gateway/src/modules/memory/service.ts`（新） | 转发 + 错误映射 |
| gateway 入口（注册模块处） | 挂载 memory 路由（`config.memory` 为空时挂恒 503 版本） |
| `apps/desktop/src/main/gateway/memory-gateway-bridge.ts`（新） | `memory:*` IPC handler |
| `apps/desktop/src/main/index.ts` | 注册 bridge |
| `apps/desktop/src/preload/index.ts` | `nxcore.memory` 命名空间 + 类型 |
| `apps/desktop/src/renderer/src/types/memory.ts`（新） | 渲染层 DTO |
| `apps/desktop/src/renderer/src/components/pages/memory/*`（新） | §5.3 组件树 |
| `apps/desktop/src/renderer/src/components/pages/MemoryPage.tsx` | 重写为薄壳（保留导出名，`PageCanvas` 不用改） |
| 单测 | client 新方法（fetch mock）、gateway memory service 错误映射、（可选）useMemoryData |

## 8. 实施顺序与工作量

1. **MemoryCoreClient 扩展 + 导出**（半天）——纯增量，含单测
2. **gateway memory 模块**（1 天）——路由 + service + 错误映射，curl 自测
3. **桌面端 bridge + preload**（半天）
4. **MemoryPage 重写**（2 天）——先做三种降级态 + L1/L3（价值最高的两个 tab），再做 L2/L0/总览/搜索
5. **联调**（半天）——真实 MemoryCore 实例上过一遍 CRUD、断进程验证降级

## 9. 二期方向（本期不做，仅记录）

- Context Room 的 `MemoriesPane`/`MemoryPane` 接真：Room 与记忆的关联需要按 room/pageLabel 维度建索引（当前 MemoryCore 只有 agent 会话维度，可考虑把 `roomId` 映射到 `session_id` 前缀或 `task_id`），是独立的设计题
- 会话删除联动 pi session 删除（pi-agent-memory-plan §5.4 遗留项）可与本期的 `conversation/delete` UI 合并验证
- 记忆提炼日志（`/v3/memory-generation-log/list`）作为总览页的"最近提炼活动"流
- 手工导入历史对话到 L0（Panel 的 ImportBlockDialog 对应能力）

## 10. 开放问题（评审时定）

1. **L0 默认浏览策略**：按时间倒序拉全量消息再前端按 session 聚合（简单，但会话切分依赖返回顺序），还是进页先 `conversation/query` 探测最近 24h 再向两侧扩展（Panel 的做法，复杂些）？倾向前者，量级大了再优化。
2. **L3 编辑**：`core/write` 是全量覆盖且服务端会自动剥离 Scene Navigation 段——编辑器是否需要先 `read` 回显剥离后的内容？首版按"读什么编辑什么"处理，不做防冲突（单人桌面场景，version 冲突可接受）。
3. **`/v2/pipeline/status` 的版本耦合**：该接口仅 v2 挂载（standalone 模式）。若用户的 MemoryCore 部署形态不同导致 404，总览页 pipeline 卡片静默隐藏即可，不作为硬依赖。
