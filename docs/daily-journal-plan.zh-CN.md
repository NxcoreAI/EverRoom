# 今日洞察 / 每日日记：数据从哪来、怎么提炼、如何实时更新

> 状态：设计定稿（2026-11-03），实现见同批提交。
> 关联：`docs/design/product-data-map.zh-CN.md`（IPC 现状）、`docs/design/tabs-workbench.zh-CN.md` §4.1（洞察卡当初「不迁移」的理由）、
> `docs/hippo-memory-adoption-plan.zh-CN.md`（记忆库）、`apps/gateway/src/modules/memory/`（提炼管线范式）。

---

## 1. 一句话结论

主页「最近」顶部放一张**今日洞察卡**；它的数据不是渲染层拼的 mock，而是网关侧一条**每日日记管线**的产物：

```
信号产生（记忆写入 → 去抖 45s）
  → 采集（collector，按本地日界取当天的记忆条目）
  → 打分聚类（ranker，无模型，控 token、去重复）
  → 提炼（composer，模型输出严格 JSON；无模型走模板兜底）
  → 落盘（journal_days + journal_entries 版本化）
  → 桌面 IPC（nxcore.journal.*）
  → 主页卡片（打字机 + 要点 + 可点动作）
  → 动作闭环（打开文件 / 起会话 / 生成文档 → 又成为新信号）
```

「每天实时更新」= **当天条目随信号增量重写（保留版本）**，跨天冻结成历史日记。

**本批范围（已与需求方确认）**：① 只做主页今日卡片（不做往期/独立日记页）；
② 数据面只接记忆（最纯）；③ 变化触发 + 45s 去抖 + 最小间隔 5 分钟。
下文标注「二期」的部分是接口已留好、但本批不实现的。

---

## 2. 现状：为什么现在没有这张卡

| 事实 | 位置 |
| --- | --- |
| 原型有洞察卡，但正文/来源/更新时间/动作全是 mock | `apps/desktop/src/renderer/src/office-proto/data.ts:174`（`dailyInsight`） |
| 原型卡片默认关闭，注释写明「接上真实洞察数据源前先隐藏」 | `office-proto/pages/RecentView.tsx:24`（`SHOW_DAILY_INSIGHT = false`） |
| 迁移到工作台外壳时**明确不迁移**，理由是没有真实数据源 | `workbench/home/RecentPage.tsx:54`、`docs/design/tabs-workbench.zh-CN.md:118` |
| 旧「日记」模块在上游重构中被整体删除（连带 diary 表、diary agent bundle） | commit `7acbaa03`（Phase 2e），表由 `drizzle/0084` DROP |
| 旧日记的供料端是屏幕记忆/感知（截图→VLM），这套采集链路已不在 | 同上 |

结论：**不是补一个 UI，而是给「洞察」一个真实上游**。旧的 `diary_*` 表设计（days / runs / versions / version_sources）
思路是对的（版本化 + 证据链），但它绑定的是已删除的采集管线，因此新模块另建表、只继承「版本 + 证据」两个概念。

---

## 3. 数据从哪来（真实、本机、当天）

四类证据，每类都有稳定 id 与「发生时间」，都已在网关进程内可读（无需新抓取器）：

| 类别 | 表 / API | 取什么 | 状态 |
| --- | --- | --- | --- |
| **记忆** | `MemoryService.list()`（hippo 全局库 + 各空间库，跨库合并） | 当天 `createdAt` 的 fact / lesson 条目、`confidence`、`strength` | ✅ **本批唯一供料** |
| 文件 | `file_entries`（`updated_at >= 日界`） | 名称、`source_kind`、`workspace_id` | 二期（`kind: 'file'` 已留位） |
| 工作 | `agent_sessions` + 最后一条 assistant 消息 | 标题、状态、结论摘要 | 二期 |
| 预期 | `agent_schedules` | 任务名、时间 | 二期 |
| 连接器 | `connector_emails` / `connector_calendar_events` | 当天计数、最近标题 | 二期（授权不稳 + 正文有隐私成本） |

**为什么先只接记忆**：记忆条目本来就经过一次会话蒸馏，信息密度高、噪声低、天然带「今天新写」的时间戳；
把文件/会话一起塞进来，卡片会在「我记住的你」和「你今天动了什么」之间摇摆。
先让一条链路稳定，再按 `JournalSignalKind` 扩类——采集器已经是按类别分层的形状，扩类不用改架构。

### 3.1 已有的触发钩子（不用新建轮询器）

| 钩子 | 现在谁在用 | 用途 |
| --- | --- | --- |
| `memoryService.setOnRemembered(cb)` | 用户画像聚合 | 记忆写入 → 日记信号 |
| `agentService.setMemoryDistiller(cb)` | 会话记忆蒸馏（每 run 结束回调） | 工作结束 → 日记信号 |
| 文件入库路由（`/v1/file-imports` 等） | 文件库 | 新文件 → 日记信号 |
| 进程启动 / 本地日切换 | — | 补写当天、冻结昨天 |

---

## 4. 怎么提炼（三层，先降噪再上模型）

### 4.1 第一层：归一化成「信号」

```ts
interface JournalSignal {
  id: string          // 稳定去重键：`memory:<id>` / `file:<id>` / `session:<id>` / `schedule:<id>`
  kind: 'memory' | 'file' | 'session' | 'schedule' | 'connector'
  at: string          // ISO 发生时间（用于排序与"今天"判定）
  title: string       // 一行标题（≤60 字）
  excerpt: string     // 摘要（≤120 字，进 prompt 的唯一正文）
  weight: number      // 0..1，见 4.2
  meta: { workspaceId?: string; category?: 'fact' | 'lesson'; sourceKind?: string }
}
```

**日界**用 `dateInTimezone(now, timezone)`（`infrastructure/time/zone-time.ts`，时区取桌面端时区设置），
不用 UTC 切日——否则 23:30 之后写的东西会掉进"明天"。

### 4.2 第二层：打分 + 聚类（纯函数，可单测，零 token）

```
weight = 新近度(0.5→1.0，按小时线性衰减) × 类别基线 × 强度修正
  类别基线：memory.lesson 1.0 | memory.fact 0.9 | file(agent-generated) 0.85
           | file(其他) 0.6 | session 0.7 | schedule 0.8 | connector 0.4
  强度修正：verified +0.1 / inferred −0.2 / strength < 0.5 −0.1
```

**聚类**（关键，不做会让同一件事灌满整张卡）：同一天里 tag 重合度（Jaccard）≥ 0.3 的记忆条目合成一簇，
取权重最高的一条作代表、其余降级为计数；会话与其产出的文件按「同空间 + 时间差 ≤ 30 分钟」并成一个工作单元。

**截断**：memory 6 条 / file 5 条 / session 4 条 / schedule 3 条，总计 ≤ 12 条进 prompt，prompt 正文 ≤ 4000 字。

### 4.3 第三层：模型提炼（严格 JSON + 硬校验）

输出契约（解析层逐字段校验，不满足就丢，不靠模型自觉）：

```json
{
  "headline": "≤16 字：今天的一句话主题",
  "summary": "2–4 句，助理口吻，点名具体文件/记忆，不堆形容词",
  "bullets": [{ "text": "≤36 字", "sourceIds": ["memory:xxx", "file:yyy"] }],
  "actions": [{ "label": "≤10 字", "kind": "open-file | ask-agent", "targetId": "file:xxx" }]
}
```

硬约束：
- `sourceIds` / `targetId` 必须出现在本次输入集合里（**防编造**），未知一律丢弃。
- `bullets` 1–3 条，`actions` 0–2 条；超限截断而不是整条失败。
- prompt 里显式写「只引用给出的证据，不要补充没有的事实」。

**兜底（必须做）**：模型档位未就绪 / 超时 / 解析失败 → 模板摘要：
`今天更新了 N 份文件、记下 M 条记忆` + top3 标题拼接 + 一个「打开最近文件」动作，
落盘 `model = null`，UI 不标「AI 生成」，避免把模板文当洞察。

### 4.4 提炼质量的三条自我约束

1. **只写今天**：昨天以前的证据不进 prompt（历史日条目已冻结），避免每次重写整段历史。
2. **不评价、不鼓励**：日记是"记录 + 提醒"，不是"夸用户"。提示词禁止「做得好/非常棒/继续加油」。
3. **可追溯**：每条 bullet 带 `sourceIds`，UI 悬停能看到来源标题；这是"洞察"和"幻觉"的分界线。

---

## 5. 存储：一天一条，版本化

```sql
journal_days (
  date            text primary key,      -- 'YYYY-MM-DD'（本地时区）
  scope           text not null default 'global',  -- 'global' | 'workspace:<id>'
  status          text not null default 'pending', -- pending|generating|ready|failed
  current_entry_id text,
  source_fingerprint text,               -- 信号集指纹，相同则跳过重写
  signal_count    integer not null default 0,
  last_error      text,
  created_at      integer not null,
  updated_at      integer not null
);

journal_entries (
  id              text primary key,
  date            text not null,
  version         integer not null,       -- 同一天的第几版
  trigger         text not null,          -- boot|memory|run|file|schedule|manual|tick
  headline        text not null,
  summary         text not null,
  bullets_json    text not null,
  actions_json    text not null,
  evidence_json   text not null,          -- 进 prompt 的信号快照（可追溯 + 便于排查）
  source_fingerprint text not null,
  model           text,                   -- null = 模板兜底
  status          text not null default 'ready',
  created_at      integer not null
);
create index journal_entries_date_idx on journal_entries(date, version desc);
```

- 每次重写 +1 version，`journal_days.current_entry_id` 指向最新可用版；
- 每保留最近 30 版，其余裁掉（一天写太多次不至于撑爆库）；
- **跨天冻结**：本地日切换时把昨天标 `ready` 并停止重写（手动「重新生成」除外）。

---

## 6. 实时更新：去抖 + 指纹 + 单飞行

```
noteSignal(reason)  ──去抖 45s──┐
                                ├─→ maybeGenerate()
日切换 / 启动 ──────────────────┘        │
                                          ├─ 单飞行（inflight 标志）
                                          ├─ 最小间隔 5 分钟（除 manual）
                                          ├─ 指纹未变 → 直接返回（0 次模型调用）
                                          └─ 每天上限 24 次
```

为什么不是"来一条信号就重算"：一次 run 结束会同时产生记忆 + 文件 + 会话三类信号，
不去抖会连打 3 次模型；而指纹保证「没有新证据就不重写」，避免卡片文案反复横跳。

渲染端的"实时"：主页可见时 60s 轮询 + 窗口重新聚焦时刷新 + 卡片上的手动「刷新」；
返回值带 `updatedAt` 与 `status`，UI 自己决定显示「刚刚更新 / 正在更新…」。

---

## 7. 任务驱动的闭环

这是「任务驱动」的具体含义——**卡片不是终点，动作会产生新信号**：

```
用户点「整理成周报」→ 起会话（预填 prompt，带上当天证据）→ run 结束
        ↑                                                    ↓
   卡片刷新（新 bullet：已生成《周报》）  ←── 新文件入库 + 记忆蒸馏 ──┘
```

本批动作只做 `ask-agent`（证据只有记忆条目，没有文件可开）：
在工作空间里起一条会话，prompt = 卡片当天的 headline + 相关信号。
`open-file` 的类型已留在 DTO 里，但**网关侧解析时会丢弃**——没有文件证据时不允许出现打开文件的动作。

---

## 8. 契约（网关 → 桌面 → 渲染）

### 8.1 网关路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/journal/today` | 当天条目 + 状态 + 信号计数（无条目时 `entry: null`，不 500） |
| `POST` | `/v1/journal/refresh` | 手动重写当天（绕过最小间隔与"指纹未变"，仍受单飞行保护） |

历史列表端点（`/v1/journal/days`）本批**不提供**：卡片之外没有消费方，等往期日记页落地再加。

### 8.2 桌面 IPC

`shared/sources.ts` 新增 `journal` 命名空间：

```ts
journal: {
  today(): Promise<JournalTodayDto>
  refresh(): Promise<JournalTodayDto>
}
```

通道：`journal:today` / `journal:refresh`（`main/index.ts` 的 `JOURNAL_CHANNELS` + `AgentGatewayBridge` 的两个薄方法 + `preload/index.ts`；都走 quiet 调用，失败由卡片自己显示，不弹全局错误）。

---

## 9. UI（主页「最近」第一屏）

```
┌───────────────────────────────────────────────────────────┐
│ ✦ 今日洞察   4 条记忆 · 2 份文件 · 1 项工作 · 刚刚更新   ⟳ │
│                                                           │
│ 一句话主题（≤16 字，加粗）                                 │
│ 正文 2–4 句，打字机逐字出现（尊重 reduced-motion）          │
│                                                           │
│ · 要点一（≤36 字）                                        │
│ · 要点二                                                  │
│                                                           │
│ [聊聊这条 →]  （动作来自成稿；本批只有 ask-agent）          │
└───────────────────────────────────────────────────────────┘
```

状态机：`loading`（骨架）→ `ready` / `empty`（今天没信号：引导聊天，不编内容）/ `unavailable`（网关未就绪，可重试）。
空态文案不写"暂无数据"，写下一步动作。

---

## 10. 分期与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **P1（本批）** | `journal_days` / `journal_entries` 表 + collector + composer（含模板兜底）+ scheduler + 两个路由 + IPC + 主页卡片 | 真实数据下卡片出现；写一条记忆后 ≤1 分钟卡片变化；无模型时仍有模板文案且不标「AI 生成」 |
| P2 | 文件/会话/日程信号（扩 `JournalSignalKind` + 放开 `open-file` 动作）、往期日记 | 卡片能说"今天做了什么/接下来要做什么"；昨天日记不再变 |
| P3（可选） | 连接器邮件/日历并入、每日定时总结、导出 Markdown、按空间维度 | — |

**不要做的事**（明确划出去，防止范围膨胀）：不做截图/屏幕采集供料（那条链路已被删除）、
不做可手写编辑的富文本日记（先只读）、不做跨设备同步（日记是本地产物）。

---

## 11. 风险与取舍

| 风险 | 处理 |
| --- | --- |
| 模型档位在启动瞬间常为空（SaaS 激活后才 patch） | 与记忆提炼同款：每次调用现解析 runtime，不可用走模板兜底且**不计入重试** |
| 卡片文案抖动（同一份证据反复重写） | 信号指纹相同即跳过；最小间隔 5 分钟 |
| 记忆条目与文件是"机器观察"，可能包含误判 | 只陈述"发生了什么"，不做因果推断；证据可追溯 |
| 每天多次重写撑大 DB | 每天保留 30 版，超出裁剪 |
| 时区 | 统一走 `dateInTimezone` + 桌面端时区；日界不做 UTC 截断 |

---

## 12. 实现索引（P1 落地）

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 表 | `apps/gateway/src/infrastructure/database/schema.ts`（`journalDays` / `journalEntries`） | 日状态 + 版本快照 |
| 迁移 | `apps/gateway/drizzle/0097_daily_journal.sql` + `drizzle/meta/_journal.json` | 语句全部 `IF NOT EXISTS`（可重放） |
| 采集 | `apps/gateway/src/modules/journal/collector.ts` | 本地日界 + 权重 + 标签聚类 + 指纹 |
| 提炼 | `apps/gateway/src/modules/journal/composer.ts` | prompt / 严格解析 / 模板兜底 |
| 编排 | `apps/gateway/src/modules/journal/service.ts` | 日行、版本、指纹跳过、失败记录、版本裁剪 |
| 调度 | `apps/gateway/src/modules/journal/scheduler.ts` | 去抖 45s / 最小间隔 5min / 单飞行 / 每日上限 24 / 跨日 tick |
| 路由 | `apps/gateway/src/modules/journal/routes.ts` | `GET /v1/journal/today`、`POST /v1/journal/refresh` |
| 装配 | `apps/gateway/src/server/create-server.ts` | 构造 + `setOnRemembered` 挂钩 + `journalScheduler.start()` + 退出 `stop()` |
| IPC | `apps/desktop/src/shared/sources.ts`、`main/index.ts`（`JOURNAL_CHANNELS`）、`main/gateway/agent-gateway-bridge.ts`、`preload/index.ts` | `nxcore.journal.today/refresh` |
| UI | `apps/desktop/src/renderer/src/workbench/home/{useDailyJournal.ts,DailyJournalCard.tsx,RecentPage.tsx,home.css}` | 卡片 + 60s 轮询 + 打字机 + 动作 |
| 测试 | `apps/gateway/tests/journal.test.ts`（17 例）、`apps/desktop/tests/daily-journal-card.test.tsx`（7 例） | 见下 |

### 12.1 验收记录（2026-11-03）

- 网关 `tsc --noEmit` 0 错误；`tests/journal.test.ts` 17/17 通过。
- 全量网关套件：仅 6 个**既有基线**失败（bundled-agent / database-migrations / document-import-export / document-understanding / file-catalog / thesis-format），
  已验证其中 `database-migrations` 的失败在移除本批迁移后依旧存在（与本功能无关）。
- 桌面 `tsc --noEmit` 0 错误；`daily-journal-card` / `workbench-home` / `ipc-channel-routing` 27/27 通过。
- 端到端（临时 dataDir + 未配置模型）：启动即生成 v1（模板兜底，`model: null`，`signalCount: 3`）→ 重复 `GET` 保持 v1（指纹未变）→
  `POST /refresh` 升到 v2 → 再写一条记忆并重启，升到 v3 且新条目出现在要点里。
- 已知行为：`ask-agent` 动作当前落到最近空间的「新工作草稿」（渲染层还没有"带 prompt 起会话"的入口）；
  `open-file` 的类型已留但网关侧会丢弃（本期没有文件证据）。
