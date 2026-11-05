# 项目空间目录化方案（Project Space = 一个自描述目录）

> 状态：**P0–P4 已落地**（2026-11-02；P2 的 Agent 工作目录于 2026-11-03 补齐，见 §15.3-7；**目录布局于 2026-11-03 升级到 v2：根即资料库、标记收进 `.everoffice/`、v1 自动迁移**，见 §16）。默认根 `dataDir/Workspace`、目录名 ASCII、`default` 空间也绑目录，决策 5 采 (a)「空间目录为权威」。落地清单见 §15、§16。
> 关联：`docs/design/product-data-map.zh-CN.md`（数据/IPC 现状地图）、`docs/design/everoffice-feature-inventory.zh-CN.md`（工作空间六页）、`docs/hippo-memory-adoption-plan.zh-CN.md`（记忆库形态）
> 本文只给架构、目录结构与各目录职责，以及落地分期；不含实现代码。

---

## 0. 一句话

把「项目空间」从**数据库里的一行**升级为**磁盘上一个自描述目录**：空间根放**唯一一个** `space.everoffice`（JSON manifest），有这个文件即空间，它同时声明内部各子目录的角色；根目录只留配置文件，资料库 / 记忆 / 缓存各占一个专用子目录。会话记录仍走数据库（旧方法不变），但空间目录里为记忆预留了位置。

---

## 1. 现状（今天的事实）与差距

### 1.1 今天的存储事实

| 数据面 | 今天存在哪 | 代码位置 |
| --- | --- | --- |
| 空间元数据（名称/描述/目标/path） | SQLite `agent_workspaces` | `apps/gateway/src/infrastructure/database/schema.ts:189`、迁移 `drizzle/0089`、`0090` |
| 空间目录 | `agent_workspaces.path`，**用户手动选**，可为 `NULL`；`default` 空间恒为 `NULL` | `agent/service.ts:139`（必须绝对路径）、`service.ts:1042-1044`（`updateWorkspace` 的 path 分支） |
| 创建流程 | 桌面弹窗「本地目录（可选）」→ `workspace.pickDirectory` → `workspace.create`，**只登记路径，不在磁盘做任何事** | `renderer/.../workspace/CreateWorkspaceDialog.tsx:62`、`main/index.ts:2124`、`agent/routes.ts:175-232` |
| 资料库字节 | 内容寻址对象库 `<dataDir>/files/sha256/<hash前2>/<hash>`（**文件名是 hash，原文件名只存在 DB**） | `modules/files/storage.ts:45`、`schema.ts:1202`（`file_blobs`） |
| 资料库索引 | `file_entries`（名字/来源/归属空间）+ `file_versions`（版本 → `content_hash`）+ `parsed_contents` | `schema.ts:1210`、`1252` |
| 资料库目录树 | 由 `file_entries.relative_path`（导入时相对路径）派生，**纯虚拟**，磁盘上不存在 | `workbench/workspace/libraryTree.ts`、`useFileLibrary.ts` |
| 会话记录 | SQLite `agent_sessions` / `agent_messages` / `agent_runs` / `agent_events` | `schema.ts:207` 起 |
| 长期记忆 | hippo-memory 单库 `<dataDir>/memory/hippo`，逻辑上按 `scope = "workspace:<id>"` 分区（**同一物理库**） | `server/create-server.ts:706`、`memory/hippo-adapter.ts:97` |
| Agent 沙箱工作目录 | `<dataDir>/agent/runtimes/<agentId>/workspace`（**按 agent 全局**，不是按空间） | `agent/runtime-factory.ts:41-49` |
| Agent 临时/派生文件 | 全部 `mkdtemp(os.tmpdir())`，进程/机器级别，与空间无关 | `thesis-format/normalize.ts:82`、`subagents/screenshot-jpeg.ts:19`、`vision/vlm-client.ts:335` 等 10 余处 |
| 本机 CLI Agent 目录绑定 | JSON 存储，按 `(sessionId, agentId)` 记 `rootPath` | `desktop/src/main/local-agents/workspace-binding-store.ts:82` |
| 应用数据根 | `~/Library/Application Support/EverRoom`（`app.getPath('appData')/APP_NAME`，可被 `NXCORE_DATA_DIR` 覆盖） | `desktop/src/main/index.ts:175-183` |

### 1.2 「字节」和「索引」到底指什么（评审问题 5 的答复）

一份资料在系统里其实是**两半**：

- **字节（bytes）**= 文件内容本身，那堆 0/1。今天是 `.docx` / `.pdf` 的真实内容，存在对象库里，但**存储名是内容 hash**：`files/sha256/9f/9f2c3a…`。你在访达里翻不到"季度汇报.docx"这个名字，也认不出哪个 blob 是哪个文件。
- **索引（index）**= 数据库里描述这份资料的行：`file_entries`（原始文件名、来源、归属空间、状态）、`file_versions`（第几版 → 内容 hash、解析器版本）、`parsed_contents`（解析出的正文）。

今天资料库 = **索引 + hash 名 blob**。所以「资料库」在你的访达里并不存在，Agent 也拿不到一份"叫得出名字、能直接读"的文件树。

决策 5 要选的就是**字节搬到哪、谁是权威**：

| | (a) 空间目录为权威（本方案推荐） | (b) 双写（目录 + 对象库各一份） |
| --- | --- | --- |
| 磁盘占用 | 1 份 | 2 份（同一文件两处） |
| 访达/Git/iCloud 可用 | ✅ 真实文件名、真实目录 | ✅ 但两份会漂移 |
| Agent 文件工具 | ✅ 直接在空间根读写 | ⚠️ 不知道哪份是对的 |
| 去重（同内容只存一份） | 空间内保留（`Library/.cache/objects`），**跨空间不再去重** | 全局保留 |
| 版本语义（`file_versions.content_hash` 不可变） | 需要「`Library/` = 当前态，`objects/` = 被版本引用的历史快照」来保 | 天然保 |
| 实现成本 | 中（要 reconcile、rename/delete 两段式） | 高（要处理两份漂移） |

**已定 (a)**，并配一条明确语义：**`Library/` 里是"当前这一版"的实体文件；`Library/.cache/objects/` 里按 hash 保存被 `file_versions` 引用的历史快照**。这样用户在访达里改 Word 文件 → reconcile 时发现 hash 变了 → 生成新版本（旧版本仍有快照），既不丢版本历史，也不让"目录里的资料库"名不副实。后果与回填策略见 §12.1。

### 1.3 与目标的四条差距

1. **空间没有实体**：`path` 只是被记住的字符串，可以指向任意目录，也可以为空；换个窗口、删掉目录，空间照样"存在"。
2. **资料库只活在库里**：用户在访达里看不到自己的资料，无法用 Git/iCloud/Obsidian 管；Agent 也拿不到稳定的读写根。
3. **记忆没有落点**：记忆库是全局一个，`scope` 只是字段，空间被删/被搬时记忆无归属。
4. **缓存无主**：Agent 产物的大头（转写、切片、截图、缩略图）散落在系统临时目录，既不随空间清理，也无法告诉用户"这个空间占了多大"。

---

## 2. 设计原则

| # | 原则 | 具体含义 |
| --- | --- | --- |
| P1 | **目录是身份与内容的权威，DB 是索引与运行时状态** | 空间的"我是谁"写在 `.everoffice/space.json`；资料库当前态字节就在空间根（v2）；会话、run、版本历史、解析索引留在 DB + `.everoffice/objects` |
| P2 | **一个空间只有一个标记文件** | `.everoffice/space.json` 同时承担"我是空间"和"我的内部布局是什么"两件事；子目录**不**放任何标记，普通目录搬出去就是普通文件 |
| P3 | **单写者** | 所有落盘动作只经网关的 `WorkspaceLayoutService`；渲染层与桌面主进程都不直接 `mkdir/writeFile`（桌面主进程只负责原生选择框、`reveal`、`fs.watch` 上报） |
| P4 | **标记是一等契约** | `.everoffice/space.json` 是产品文件格式（可被人读、可被别的机器/别的工具读），必须版本号 + 未知字段宽容 + 未来版本只读降级 |
| P5 | **空间根即资料库（v2）** | 根上只允许两个隐藏目录（`.everoffice/` 元数据、`.tmp/` 过程缓存）；其余一切（含用户原有文件、`AGENTS.md`、产物）都是资料，应用不与之争名 |
| P6 | **托管与外部同构** | 「默认建在应用目录下」与「用户自选目录」产出的布局完全一致，只是 `rootMode` 不同 |
| P7 | **可修复、可发现、可迁移** | 任何时刻：能扫描发现未注册空间、能一键修复缺失目录、能整体搬移，且不依赖数据库也能读懂这个目录 |

---

## 3. 目标目录结构（v2：根即资料库）

默认根：`<dataDir>/Workspace/`（`dataDir` = `~/Library/Application Support/EverRoom`）。新建空间名「飞书相关工作」→ 目录 `Workspace/feishu-work/`。目录名一律 ASCII（中文名只存 manifest 与 DB，UI 显示中文）。

**核心约定：空间根就是资料库根。** 空间里只有两个隐藏目录（`.everoffice/` 元数据、`.tmp/` 过程缓存），其余位置全部是用户的资料；新生成的文件直接平铺在根上。这样"用户已经存满资料的目录"也能直接设为工作空间：应用只往里加两个隐藏目录，不会和任何已有文件冲突，Agent 也能直接用 bash 浏览。

```
<dataDir>/                                   # 应用数据根
├── database/nxcore.db                        # 会话/索引/元数据（不变，仍是会话记录的唯一权威）
├── files/sha256/…                            # 遗留对象库（降级为导入暂存，逐步 GC）
├── memory/hippo/                             # 全局记忆（无空间归属的记忆）
└── Workspace/                                # 项目空间默认根（容器，不是空间本身）
    └── feishu-work/                           # ← 项目空间根 == 资料库根
        ├── .everoffice/                       # ★ 唯一隐藏元数据目录（资料库视图隐藏）
        │   ├── space.json                     #   空间 manifest：身份 + 布局声明 + 缓存策略
        │   ├── memory/                        #   记忆库根（per-space）
        │   ├── conversation/                  #   对话记录预留位（会话权威仍在 DB）
        │   ├── trash/                         #   空间内回收站（30 天 GC）
        │   ├── objects/                       #   内容寻址存储：导入去重 + 版本历史快照
        │   └── cache/derived/                 #   可重建派生数据（解析 md、缩略图、切片）
        ├── .tmp/                              # Agent 过程缓存：scratch/转写/转换（小时级，可整删）
        ├── AGENTS.md                          # 可选：空间规则（人与 Agent 共读）
        ├── 季度汇报.md                         # ← 新资料/产物直接平铺在根上
        ├── 产品规划/                           # ← 用户自己的目录，应用不干预
        └── …                                  # 用户原有的一切文件，原样保留
```

> **为什么标记要藏在 `.everoffice/` 里**：一个空间对用户来说就是"一个装满资料的普通文件夹"。根上如果躺着一个 `space.everoffice`，它既会出现在访达里、也会被资料库当作一个陌生文件索引；而 `.everoffice/space.json` 天然被点目录规则排除在资料库之外，根上"看起来什么都没多出来"。识别方向反过来由标记决定：只要 `.everoffice/space.json` 可解析，整个目录就是本应用的空间。

### 3.1 每个目录的职责

| 路径 | 角色 | 谁写 | 谁读 | 生命周期 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `Workspace/` | 空间容器 | 网关（首个空间时创建） | 网关、桌面「发现空间」 | 应用级 | 容器根路径来自设置（默认 `dataDir/Workspace`），可整体改 |
| `<space>/` | **空间根 = 资料库根** | `WorkspaceLayoutService.provision()` | 全部 | 空间级 | 判定条件：`.everoffice/space.json` 可解析 |
| `.everoffice/space.json` | 空间 manifest | 网关 | 网关、桌面（识别）、其他 EverRoom | 空间级，唯一必需 | 见 §4 |
| `.everoffice/memory/` | 记忆库根 | 记忆服务 | 记忆服务、记忆页 | 空间级 | per-space hippo root；随空间搬走 |
| `.everoffice/conversation/` | 对话投影占位 | 网关（仅开启镜像时） | 用户、外部工具 | 空间级 | 默认空目录；会话权威仍在 DB |
| `.everoffice/trash/` | 空间内回收站 | 网关 | 网关（恢复/GC） | 30 天 | 删除 = 移入 `trash/<YYYYMMDD>/<uuid>/`，可恢复 |
| `.everoffice/objects/` | 内容寻址存储 | 网关 | 网关 | 周级（引用计数 + 30 天） | ① 导入去重 ② 被 `file_versions` 引用的历史版本快照 |
| `.everoffice/cache/derived/` | 可重建派生数据 | 网关 | 网关（预览/检索） | 天级（90 天 LRU） | 解析 md、缩略图、切片、embedding 落盘缓存 |
| `.tmp/` | Agent 过程缓存 | `withScratch()` | Agent、子系统 | **小时级**，可整删 | 替代 `mkdtemp(os.tmpdir())`；`.tmp/<用途>/<uuid>/` |
| `<space>/<任意>` | 资料/产物 | 用户、Agent、导入管线 | 网关、渲染层、Agent 文件工具、访达 | 跟随文件 | `file_entries.relative_path` 相对空间根；新文件平铺 |

**资料库视图**：只隐藏 `.everoffice/`；其余（包括用户自己的点目录以外的一切）都按普通文件/目录展示。`.tmp/` 是点目录，按同一条规则不进索引，但它在访达里可见可清。

---

## 4. `.everoffice/space.json` 契约（单文件）

### 4.1 判定与命名

- 位置固定 `<space>/.everoffice/space.json`，内容 UTF-8 JSON（v2）。宽容规则：`.everoffice/` 下任何 `*.json` 或 `*.everoffice` 且 `kind === "space"` 也算空间（用户重命名过的情况），解析时优先 `space.json`。
- **v1 兼容**：老空间把 `space.everoffice` 直接放在空间根上。判定时先看 `.everoffice/space.json`，再回落到根上任何 `*.everoffice`；v1 标记会被读成"扁平化后的布局"，并在 `provision/repair/adopt/relocate` 时就地迁移到 v2（见 §16.2）。
- **判定：某目录里有可解析的标记 → 整个目录（含所有子目录）都是本应用可解析的项目空间。** 子目录、后代目录不再需要任何标记。
- v1 之所以把标记放在根上，是"立即可见"的取舍；v2 改成隐藏目录内的文件后，"用户已经有资料的目录也能直接当空间"才成立——根上不会凭空多出本应用的文件。

### 4.2 manifest 结构（v2）

```json
{
  "$everoffice": 2,
  "kind": "space",
  "spaceId": "0c1f9c7a-3b2e-4f5a-9c11-7ad0e2f4b6a1",
  "name": "飞书相关工作",
  "slug": "feishu-work",
  "layoutVersion": 2,
  "rootMode": "managed",
  "createdAt": "2026-11-02T13:04:11.512Z",
  "createdBy": { "app": "EverRoom", "version": "0.1.0", "platform": "darwin" },
  "layout": {
    "library": "",
    "meta": ".everoffice",
    "memory": ".everoffice/memory",
    "conversation": ".everoffice/conversation",
    "trash": ".everoffice/trash",
    "objects": ".everoffice/objects",
    "derived": ".everoffice/cache/derived",
    "tmp": ".tmp"
  },
  "roles": {
    "library": { "writable": true, "retention": "keep" },
    "memory": { "writable": true, "retention": "keep" },
    "cache": { "writable": true, "retention": "ephemeral",
               "gc": { "tmpMaxAgeHours": 24, "derivedMaxAgeDays": 90,
                       "objectsMaxAgeDays": 30, "maxBytes": 2147483648 } },
    "trash": { "retention": "30d" }
  },
  "flags": { "conversationMirror": false, "memoryLocal": false },
  "integrity": "sha256:9f2c…"
}
```

| 字段 | 必需 | 语义 |
| --- | --- | --- |
| `$everoffice` | ✅ | 契约版本（现在 = 2）；未知（更高）版本 → **只读降级**，不写不改 |
| `kind` | ✅ | 只有 `space` 一种正式取值；未知值 → 视为不可解析，只读 |
| `spaceId` | ✅ | 稳定身份 = `agent_workspaces.id`；目录搬家/改名后靠它重新绑定 |
| `name` / `slug` | ✅ | 展示名（可为中文）/ 目录名（ASCII，一次性生成，改名不回写） |
| `layoutVersion` | ✅ | 目录布局版本（现在 = 2）；DB 里低于它的空间下次访问自动迁移 |
| `rootMode` | ✅ | `managed`（在 `Workspace/` 下）/ `external`（用户自选目录，仍由应用写标记） |
| `layout` | ✅ | 角色目录映射的**单一来源**：全部相对空间根，空串 = 空间根本身；代码与 DB 都不硬编码目录名 |
| `roles` | ✅ | 每个角色的能力位 + 保留策略 + 缓存 GC 参数（"缓存目录"的自我描述） |
| `flags` | ✅ | 是否镜像对话、记忆是否已本地化 |
| `integrity` | ❌ | 手改检测；不匹配 → 警告，继续用 DB 侧快照兜底 |

> `layout.library` 允许空串（v2 的常态）——**空串就是"资料库根＝空间根"**，不是缺字段。读 v1 标记时它会被翻译成旧值（`library: "Library"`、`meta: ""`），所以下游 `pathsOf()` / 落盘 / 对账 / GC 不需要区分两代布局。

### 4.3 识别流程（网关唯一实现）

```
detect(dir):
  # v2 优先：.everoffice/ 下的 space.json（其次同目录里任何 space 形状的 json/*.everoffice）
  # v1 回落：根上的 space.everoffice / 任何 *.everoffice
  f = 按上序找到的第一个可解析文件
  if !f: return null
  m = parseJson(f)
  if m.$everoffice > CURRENT: return { kind: m.kind, marker: m, readonly: true }
  if m.kind !== "space":      return { kind: "unknown", marker: m }   # 不碰
  return { kind: "space", marker: m, dir }

openOrRegister(dir):
  d = detect(dir)
  case null:  → 不是空间（若要在此目录建空间，走 adopt/new）
  case {kind:"space", spaceId}:
      有 DB 行且 path 相同  → 直接打开
      有 DB 行但 path 不同  → "空间已存在，是否重定位到此目录"（只改 DB 路径）
      无 DB 行             → "发现项目空间「name」，注册进应用"（复用 spaceId）
  另：用户若误选到空间内部子目录 → 向上逐级 detect 到根（最多 3 层），提示"这是某个空间的子目录"
```

### 4.4 写入纪律

- 原子写：`.everoffice/space.json.tmp-<uuid>` → `rename`，避免半截 JSON；写之前先 `mkdir -p .everoffice/`。
- 权限 `0644`（文件）/ `0755`（目录）；空间根不用 `0700`（用户要能在访达/其他工具里用）。
- 版本升级只加字段；子目录改名走 `layout` 映射，磁盘名字不动也能继续解析。
- `provision()` 幂等：只补缺（缺目录建目录，缺 manifest 写 manifest，缺字段按默认补齐）。

---

## 5. 模块划分

```
apps/gateway/src/modules/workspace-layout/        ← 新增（单写者）
├── service.ts          WorkspaceLayoutService：provision/detect/ensure/repair/reconcile/relocate/gc
├── markers.ts          manifest 校验、读写、版本门禁、原子写
├── paths.ts            slug 生成、路径安全校验（realpath/NFC/保留名/大小写）、容器根解析
├── reconcile.ts        Library ↔ file_entries 双向对账（P1）
└── routes.ts           /v1/workspaces/* 路由
```

| 层 | 新增/改动 | 职责 |
| --- | --- | --- |
| 网关 `workspace-layout` | 新增 | 全部磁盘布局动作；目录创建先于 DB 落库，失败回滚删目录 |
| 网关 `agent/service.ts` | 改 | `createWorkspace` 委派 layout 服务：`path` 缺省 → 默认根 + slug；新增 `slug/root_mode/layout_version` |
| 网关 `files/service.ts` + `storage.ts` | 改（P1） | 有空间根的条目：字节写 `Library/<rel>`，DB 记 `library_rel_path`；`file_versions` 快照留 `.cache/objects` |
| 网关 `memory/service.ts` | 改（P2） | 支持 per-space store root（`<space>/Memory`），全局库仍在 `dataDir/memory/hippo` |
| 网关 `agent/runtime-factory.ts` | 改（P2） | pi `workingDirectory` = 空间根；scratch 指向 `Library/.cache/tmp/agent/<runId>` |
| 桌面主进程 | 增 | 默认根预览、`pickDirectory`、`detect` 代理、`reveal`、`fs.watch`（debounce 500ms）→ 通知网关 reconcile |
| 渲染层（工作台） | 改 | 新建弹窗显示默认落点；空间设置页目录卡片（路径/健康/访达/修复/缓存清理）；首页「发现的空间」 |
| preload | 增 | `nxcore.projectSpace.*`（见 §6.3） |

**命名避坑**：仓库已有 `AgentWorkspace`（用户空间）与 `AgentWorkspaceStatus.workspace`（Agent 沙箱隔离）。本方案一律用 **`SpaceRoot` / `WorkspaceLayout`**，不引入第三套 "workspace"。

---

## 6. 接口清单

### 6.1 `WorkspaceLayoutService`

```ts
resolveDefaultRoot(name: string): { root: string; slug: string }   // <container>/<slug>，含重名去重
provision(input: { spaceId; name; root?; rootMode }): Promise<SpaceLayout>   // 建目录 + 写 manifest，幂等
detect(dir: string): Promise<MarkerResult>                          // §4.3
ensureLayout(spaceId: string): Promise<SpaceLayout>                 // 只补缺，不动内容
repair(spaceId: string, opts?): Promise<RepairReport>               // 补 manifest / 重建被删空目录 / 修 layout 映射
layoutOf(spaceId: string): SpaceLayout                              // 从 manifest 解析：{root, library, memory, conversation, trash, cache, tmp, derived, objects}
reconcile(spaceId: string): Promise<ReconcileReport>                // FS ↔ 索引对账（新增/改名/丢失/内容变更→新版本）
relocate(spaceId: string, nextRoot: string): Promise<SpaceLayout>   // 同卷 rename / 跨卷 copy+校验+删
adopt(dir: string): Promise<SpaceLayout>                            // 已有目录升级为空间（写 manifest + 建布局）
trash(spaceId: string, relPaths: string[]): Promise<void>
restore(spaceId: string, trashId: string): Promise<void>
withScratch<T>(spaceId: string, purpose: string, fn: (dir: string) => Promise<T>): Promise<T>
cacheStats(spaceId: string) / gcCache(spaceId: string, policy?)
discover(container?: string): Promise<SpaceCandidate[]>             // 扫容器根，列出未注册/失效
```

### 6.2 HTTP（网关）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/agent/workspaces` | 已存在；body 扩 `rootMode?`/`createDirectory?`，`path` 可省（默认根） |
| `POST` | `/v1/workspaces/detect` | `{ dir }` → marker 或 null |
| `POST` | `/v1/workspaces/adopt` | `{ dir }` → 注册并返回 layout |
| `GET` | `/v1/workspaces/discover` | 未注册/失效空间清单 |
| `GET` | `/v1/agent/workspaces/:id/layout` | layout + 健康（缺失目录、离线、缓存大小） |
| `POST` | `/v1/agent/workspaces/:id/layout/repair` · `/reconcile` · `/relocate` | 修复 / 对账 / 搬移 |
| `GET/POST` | `/v1/agent/workspaces/:id/cache` · `/cache/gc` | 缓存统计 / 清理 |

### 6.3 preload：`window.nxcore.projectSpace`

```ts
defaultRootPreview(name): Promise<{ root; slug; exists }>
detect(dir) / adopt(dir) / discover()
layout(spaceId): Promise<SpaceLayoutHealth>
repair(spaceId) / reconcile(spaceId) / relocate(spaceId, dir)
cacheStats(spaceId) / gcCache(spaceId)
reveal(spaceId, sub?: 'root' | 'library' | 'cache' | 'memory'): Promise<void>
onLayoutChanged(cb: (spaceId: string) => void): () => void   // 主进程 fs.watch 去抖上报
```

---

## 7. 数据模型变更（迁移 `0096_project_space_layout.sql`）

`agent_workspaces`（复用现有 `path` 作为空间根，不新增 `root_path`）：

| 列 | 类型 | 默认 | 用途 |
| --- | --- | --- | --- |
| `slug` | TEXT | NULL | 目录名（ASCII）；改名不重算，重名检测用 |
| `root_mode` | TEXT | `'managed'` | `managed` / `external` |
| `layout_version` | INTEGER | `0` | 0 = 未初始化（触发 provision）；1 = 当前布局 |
| `root_missing_at` | INTEGER | NULL | 目录被外部删除/移动的发现时间（UI 显示"目录离线"） |

索引：`CREATE UNIQUE INDEX agent_workspaces_path_idx ON agent_workspaces(path) WHERE path IS NOT NULL`。

`file_entries`：

| 列 | 类型 | 用途 |
| --- | --- | --- |
| `library_rel_path` | TEXT | 相对 `Library/` 的路径（`inbox/a.docx`）；**不复用** `relative_path`（那是连接器导入的原始相对路径，语义不同） |
| `fs_state` | TEXT | `indexed`（仅索引，旧条目）/ `materialized`（已在空间目录）/ `missing`（外部被删） |

`default` 空间（已定：**要绑目录**）：迁移把 `id='default'` 的 `path` 设为 `<container>/inbox`、`slug='inbox'`、`root_mode='managed'`、`layout_version=0`（0 表示首次启动时由 `ensureLayout` 建目录），`kind` 仍为 `default`（不可删语义不变）。

> 记忆不需要 DB 变更：hippo 的 `scope` 已存在，P2 只是把 store root 换成空间目录。

---

## 8. 关键流程

### 8.1 创建空间（默认目录，无需手动选）

1. 弹窗调 `projectSpace.defaultRootPreview(name)`，**直接显示**：「将创建于 `…/EverRoom/Workspace/feishu-work`（可改）」；名字一改预览实时变。
2. 点「创建空间」→ `workspace.create({ name, description, goals, rootMode: 'managed' })`（不再带 `path`）。
3. 网关 `provision()`：生成 `slug` → 同卷 `Workspace/.staging-<uuid>/` 建完整布局（`.everoffice/{memory,conversation,trash,objects,cache/derived}`、`.tmp/`）→ 写 `.everoffice/space.json` → `rename` 成最终目录 → 落 DB 行。根上不建任何资料子目录（资料平铺）。
4. 任一步失败：删 staging，DB 不落行，UI 报「创建失败」。
5. 成功：返回 layout，进三步引导（现状不变）。

### 8.2 打开 / 发现

- 「打开已有项目空间」选目录 → `detect` → 三分支（打开 / 重定位 / 注册），误选子目录时向上找根。
- 启动或手动刷新 → `discover()` 扫容器根：列出「有 manifest 但 DB 无行」「DB 有行但目录不存在」两类，首页给一张低干扰卡片。
- 每次打开空间 → `ensureLayout()`（幂等补缺，不写内容）。

### 8.3 导入资料（Library 落盘）

1. 解析出 `file_entries` 行（现状）→ `planTarget(spaceId, name, hintDir)`：**v2 下一律平铺在空间根**（`dir = ""`）；已在子目录里的老条目沿用原目录，不搬动用户已整理好的位置。
2. 字节：先写 `.everoffice/objects/<hash>`（去重 + 版本快照）→ 硬链/复制到 `<space>/<rel>`（当前态，`rel` 相对空间根）。
3. DB：`relative_path`（相对空间根）、`state='materialized'`、`workspace_id` 不变。
4. 冲突：同名不同 hash → `name (2).ext`；同 hash → 只加索引行，不复制字节。
5. 删除/改名：先动磁盘（→ `.everoffice/trash/` 或改名）再改 DB；两侧不一致时以 `reconcile` 为准。
6. `root_mode` 缺失（老数据）时走旧路径，行为完全不变——回滚开关。

### 8.4 外部改动（访达里改/删/加）

- 主进程 `fs.watch`（监听空间根，debounce 500ms）→ 通知网关 `reconcile(spaceId)`。
- 内容变了（hash 不同）→ 新 `file_versions` 行（旧快照仍在 `.everoffice/objects`）。
- 文件消失 → `fs_state='missing'`（不立刻删索引，UI 标灰 + 可恢复）。
- 新文件出现 → 走 §8.3 建立索引（`sourceKind='manual-upload'`，`provider='filesystem'`）。

### 8.5 Agent 产物、临时文件与记忆

- **产物**：office-bridge `/v1/office-generate` 完成 → §8.3，**平铺在空间根**，同时广播 `office:agent-file`（事件不变）。
- **缓存（P3）**：`mkdtemp(os.tmpdir())` 的调用点里凡有 `workspaceId` 上下文的（论文排版、office 转换、导入媒体、截图、VLM 降采样），换成 `withScratch(spaceId, purpose, fn)` → `<space>/.tmp/<purpose>/<uuid>/`，`finally` 删除；无空间上下文的（启动期子 Agent）继续用系统 temp。
- **Agent 工作目录（P2 ✅）**：pi 会话的 `cwd` = 空间根（`allowedRoots` 并上空间根），`AGENTS.md` 作为 project instructions 注入；按 **run 级 cwd** 落地而不是「按 `agentId × spaceId` 建 runtime」——同一 runtime 实例的不同会话各持自己的 cwd 与会话文件，实例数不变（差异见 §15.3-7）。
- **记忆（P2）**：`MemoryService` 支持 per-space root（`<space>/.everoffice/memory`），`flags.memoryLocal=true`；无空间归属的记忆继续落全局库。迁移按 `scope=workspace:<id>` 导出 → 导入对应空间库，全局库保留只读期 30 天。

### 8.6 删除、回收站、搬移

- **删除空间**：确认 manifest → 目录整体移到 `<container>/.trash/<spaceId>-<ts>/`（或按选择"仅移除引用，保留目录"）；DB 行删除（会话按现状回落 `default`）。
- **删除文件**：进 `<space>/.everoffice/trash/<YYYYMMDD>/<uuid>/`，30 天 GC。
- **改名**：只改 DB `name` + manifest `name`；**目录名不动**（避免外部链接/Sync 全量重传），UI 显示"目录名 feishu-work"。
- **搬移（relocate）**：同卷 `rename`（更新 manifest + DB）；跨卷 `copy → 校验 hash 清单 → 切 DB → 删旧`；有未关闭 Office 实例/运行中 run 时拒绝。
- **复制空间目录**：两份同 `spaceId` → 只允许一个绑定，另一个提示"复制品，请以新空间注册"（生成新 `spaceId` 重写 manifest）。

### 8.7 缓存回收

- `.tmp/`：进程启动全清 + 超 24h 清；`.everoffice/cache/derived/`：LRU 90 天；`.everoffice/objects/`：被 `file_versions` 引用则保留，其余 30 天清。
- `maxBytes` 默认 2 GB（写在 manifest `roles.cache.gc`），超限 LRU 清到 80%。
- 空间设置页显示 `.tmp`/`derived`/`objects` 三项大小 + 「清理缓存」；点目录（`.everoffice/`、`.tmp/`）在 catalog 层过滤，**永不进资料库列表**。

---

## 9. 分期落地

| 阶段 | 范围 | 交付物 | 验收 | 粗估 |
| --- | --- | --- | --- | --- |
| **P0 契约与骨架 ✅** | manifest 契约 + layout 服务 + 默认根 + `default` 空间绑目录 + 迁移 0096 | `workspace-layout/{markers,paths,service,routes}.ts`；创建弹窗默认落点；空间设置页目录卡片；`projectSpace.*` IPC | 新建「飞书相关工作」→ `Workspace/feishu-work/` 落盘，**1 个 `space.everoffice` + 5 个角色目录**；重启后识别；删掉 `Memory/` 后 `ensureLayout` 自动补回；手动把目录改名 → `discover` 报"DB 路径失效"；`default` 空间首次启动得到 `Workspace/inbox/` | 3–4 人日 |
| **P1 资料库落盘 ✅** | 导入/生成写 `Library/`，DB 记 `library_rel_path`；rename/delete/trash 两段式；`reconcile`；**存量懒回填 + 后台补齐**（§12.1.3） | `files/service.ts`+`storage.ts` 改造；对账任务；回填任务；资料库「在访达中显示」 | 导入 3 个文件 → 访达里真实可见可双击；访达改名 → reconcile 后库内同步；库内删除 → 进 `.trash`；同文件改内容 → 生成新版本；老条目首次打开即回填成真文件 | 5–7 人日 |
| **P2 记忆与 Agent 根 ⚠️（记忆已完成，Agent 根待做）** | per-space memory store + pi `workingDirectory`=空间根 + `AGENTS.md` 注入 | memory 多根；runtime 按 `agentId × spaceId`；绑定存储改按空间 | 新空间里让 Agent 记一条 → 落 `Memory/`（`scope=workspace:<id>`）；Agent 写文件出现在 `outputs/`；旧记忆仍可读 | 4–6 人日 |
| **P3 缓存归位 ✅（调用点部分）** | `withScratch` + `derived` + `objects` GC + 缓存 UI | 8 处 `mkdtemp` 改造；gc 任务；设置页缓存卡 | 跑一次论文排版 → `tmp/` 自动清空、`derived/` 有产物；「清理缓存」后磁盘下降且功能不坏 | 3–4 人日 |
| **P4 运维闭环 ✅（缺首页发现卡）** | discover / adopt / relocate / 离线标记 / 复制冲突 / 外部目录 | 首页发现卡片；重定位向导；`adopt` 流程 | 把空间目录拖到桌面再 relocate 回来 → 会话/资料/记忆都在；复制一份 → 提示 ID 冲突不覆盖 | 3–5 人日 |

先落 **P0**：它是地基，且单独就解决了"创建后不用手选目录"的诉求。

---

## 10. 存量迁移与兼容

| 场景 | 处理 |
| --- | --- |
| `default` 空间（`path=NULL`，不可删） | 迁移写入 `path=<container>/inbox`、`slug='inbox'`、`layout_version=0`；首次启动 `ensureLayout` 建目录。`kind` 仍是 `default`，仍不可删 |
| 自定义空间，`path=NULL` | provision 到默认根（`slug` 由名称生成），成功后写 DB |
| 自定义空间，`path` 有值，**无 manifest** | 首次打开弹确认："目录将被初始化为项目空间（写入 1 个 `space.everoffice` + 建 Library/Memory/.trash）"，确认后 `adopt` 就地升级，不搬文件 |
| 自定义空间，`path` 有值，**有 manifest** | 直接绑定；`spaceId` 与 DB 不一致 → 报冲突，不自动修复 |
| 目录已被用户删除 | `ensureLayout` 失败 → 标 `root_missing_at`，UI 显示"目录离线"，提供 重建空目录 / 重新定位 / 解除绑定 |
| 老对象库 `<dataDir>/files/sha256` | P1 后仅只读兜底；新文件不再写它。GC：被 `file_versions` 引用的保留，其余按年龄清理（另开迁移） |
| 老 `file_entries.relative_path` | 语义变为"相对空间根"（v1 时相对 `Library/`）；v1→v2 迁移把 `Library/` 的子目录原样上移到根，路径字符串不变、无需改库 |
| v1 空间目录（根上 `space.everoffice` + `Library/`） | 读时翻译成 v2 布局（只读可用）；`list/open/repair/adopt/relocate` 任一次触达即就地迁移（幂等、非破坏，见 §16.2） |

---

## 11. 风险与边界

| # | 风险 | 处置 |
| --- | --- | --- |
| 1 | 只允许单标记 ⇒ 子目录被单独搬走就失去身份 | 可接受（搬出去的只是普通文件）；UI 的「在访达中显示」始终开到空间根 |
| 1b | v2 把标记藏进 `.everoffice/` ⇒ 用户更容易"看不见这是个空间" | 空间设置页/目录卡片始终展示空间根与 `.everoffice/` 的存在；`AGENTS.md` 与 README 里写明 |
| 2 | 同步盘（iCloud/Dropbox）同步 `.cache` 与 `.trash` | 缓存目录可用 `.cache.nosync` 约定；首版容器根在 `Application Support`（不被 iCloud 扫），风险仅出现在用户把空间建在 iCloud 目录时 |
| 3 | 大小写不敏感文件系统 / Windows 保留名 / 路径长度 | slug 唯一性按 `toLowerCase()`；拒绝 `CON/PRN/AUX/NUL/COM1…`；路径 ≤ 200 字符 |
| 4 | 只读卷 / 网络卷 / 权限不足 / 磁盘满 | 同卷 `.staging` 建，失败整体回滚；错误码 `space_root_not_writable` |
| 5 | 用户手改/手删 manifest | 版本宽容 + `repair` 幂等 + `integrity` 警告；**绝不**因 manifest 坏了就删目录 |
| 6 | pi 工作目录由"按 agent"改"按空间"会增加 runtime 实例数（N agent × M 空间） | **已规避**（2026-11-03）：改用 run 级 cwd，实例数不变，见 §15.3-7 |
| 7 | 大目录扫描性能（万级文件） | `discover` 只读一层；`reconcile` 分页 + `fs.watch` debounce；启动不做全量对账 |
| 8 | 复制空间目录产生两个相同 `spaceId` | 只允许一个绑定；另一个引导"以新空间注册"（重写 manifest 新 ID） |
| 9 | 符号链接/同目录别名 | 一律 `realpath` 归一后再比较（参考 `local-agents/workspace-binding-store.ts:82`） |
| 10 | 空间建在应用数据目录外，卸载后数据留存 | `rootMode='external'` 不随卸载删除；卸载文案说明托管空间位置 |

---

## 12. 已确认决策

| # | 决策 | 结论 |
| --- | --- | --- |
| 1 | 默认根 | `<dataDir>/Workspace/`（`~/Library/Application Support/EverRoom/Workspace`） |
| 2 | 目录名语言 | v2：根上只有 `.everoffice/`、`.tmp/` 两个隐藏目录；角色映射写在 manifest `layout`（全相对空间根）。UI 显示中文 |
| 3 | 标记文件 | **每个空间只一个** `.everoffice/space.json`（v2；v1 为根上 `space.everoffice`，自动迁移）——子目录、容器根都不放标记；它同时声明内部布局 |
| 4 | `default` 空间 | **绑目录**：`Workspace/inbox/` |
| 5 | 资料库字节 | **已定 (a)**：空间目录为权威（**空间根即资料库**，v2 起新文件平铺在根），`.everoffice/objects/` 存去重副本与被版本引用的历史快照；回滚靠"无 manifest 走旧路径"。后果见 §12.1 |

### 12.1 采纳 (a) 的直接后果（P1 必须照此实现）

1. **跨空间不再全局去重**：同一份资料导入两个空间 = 两份字节。`objects/` 内的去重只在一个空间内生效。这是"目录就是空间"的必然代价，写进产品说明。
2. **版本语义靠快照维持**：空间根（资料库）是当前态（可变），`.everoffice/objects/<hash>` 是不可变快照。改文件 → 新 `file_versions` 行 + 旧 hash 仍在；`objects/` 的 GC 必须先查引用（被 `file_versions` 引用的永不删）。
3. **存量已入库文件要回填**：今天所有条目的字节都在老对象库 `<dataDir>/files/sha256`，磁盘上没有资料库文件。采用**懒回填 + 后台补齐**：
   - 懒回填：空间首次打开 / 条目首次被列出时，把该条目落到 `<space>/<rel>`（v1 空间为 `Library/<rel>`），`state='materialized'`；
   - 后台任务：空闲时按 `workspace_id` 分页补齐，日志记进度；
   - 老对象库保持只读兜底，回填完成后按引用 GC（另一迁移）。
   - 理由：全量回填会让升级后首次启动长时间占满磁盘 IO；懒回填不阻塞使用。
4. **两段式写必须落地**：`rename`/`delete`/`trash` 都是"先动磁盘再改 DB"，`reconcile` 从"可选优化"升级为**必需品**（外部改动、崩溃残留都靠它收敛）。
5. **`fs_state` 成为一等状态**：`indexed`（未回填）/ `materialized`（已落盘）/ `missing`（外部删除）。UI 对 `indexed` 条目禁用"在访达中显示"，避免点了找不到。

---

## 13. 测试要点

- **契约**：manifest 读写幂等、未知版本只读、`kind` 非 space 不碰、`integrity` 不匹配降级、原子写（中断不留半截 JSON）、`layout` 映射改名后仍能解析。
- **路径**：slug 生成（中文/emoji/超长/保留名/大小写重名/末尾点空格）、`realpath` 归一、跨卷 relocate。
- **回归**：无 manifest 的老空间，导入/打开/删除行为与今天逐字节一致（现有 `files`、`workbench-library` 单测不改全绿）。
- **对账**：访达改名/删除/新增/改内容 → `reconcile` 后库内一致；同名不同内容不静默覆盖，而是新增版本。
- **销毁**：删除空间 → `.trash` 可恢复；GC 30 天后不可恢复。
- **并发**：两窗口同时 `provision` 同名空间 → 一个成功一个 `slug_taken`，磁盘不留残骸。
- 位置：网关 `apps/gateway/tests/workspace-layout.test.ts`（新增）；桌面补 IPC 与弹窗默认落点用例（可复用 `tests/default-local-folders.test.ts` 的 `mkdtemp` 模式）。

---

## 14. 收尾

`product-data-map` 里「资料库/产物按空间隔离」已经是真的（`file_entries.workspace_id`，迁移 0091）；本方案把那层**逻辑隔离变成物理隔离**，并给记忆、缓存、对话投影各留一个明确的家。会话记录继续由 DB 权威——这是唯一刻意不搬的东西。

---

## 15. 落地状态（2026-11-02 P0–P4；2026-11-03 布局升 v2）

> 一句话：空间是磁盘上一个目录——根上只有 `.everoffice/`（元数据）和 `.tmp/`（过程缓存），其余全是资料；
> 创建不必选目录，目录能被发现、修复、搬移、接管；资料库与磁盘双向对账。

### 15.1 阶段状态

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| P0 契约与骨架 | ✅ | 单标记 `.everoffice/space.json` + 骨架（`.everoffice/*` + `.tmp/`）+ 默认根 + default→`Workspace/inbox` |
| P1 资料库落盘 | ✅ | 入库/改名/删除直接写空间根，`reconcile` 三向对账，存量懒回填 |
| P2 记忆与 Agent 根 | ✅ | **记忆按空间隔离**（`<space>/.everoffice/memory`）；**pi 会话 cwd = 空间根**（run 级 cwd，见 §15.3-7） |
| P3 缓存归位 | ✅（调用点部分） | `SpaceCacheManager` + 统计/GC + 启动清扫；论文排版已迁到空间 scratch，其余 6 处仍 `os.tmpdir` |
| P4 运维闭环 | ✅（缺首页发现卡） | 搬移、离线标记、原地重建、接管/复制品另立身份、detect/discover |
| **v2 布局** | ✅（2026-11-03） | 根即资料库；标记收进 `.everoffice/space.json`；`.tmp/` 独立；v1 目录自动迁移（§16） |

### 15.2 新增文件

| 文件 | 内容 |
| --- | --- |
| `gateway/src/modules/workspace-layout/paths.ts` | 容器根、slug 生成（纯中文名退化 `space-<hash6>`）、大小写不敏感去重、Windows 保留名 |
| `.../markers.ts` | 标记契约 v2（`.everoffice/space.json`）：解析/校验/版本门禁/`integrity`/原子写；v1 标记读时翻译成扁平布局 |
| `.../service.ts` | `provision / detect / ensure / repair / health / layoutOf / discover / reassignIdentity / relocateDirectory`（staging+rename，失败不留残骸） |
| `.../library.ts` | `SpaceLibraryWriter`：`<space>/<name>` 平铺落盘（硬链+回落复制）、改名、回收站、对象库补种、目录遍历 |
| `.../reconcile.ts` | `reconcileSpaceLibrary`：少了→`missing`、回来了→恢复、多了→`manual-upload` 入库（单文件 ≤64 MB） |
| `.../cache.ts` | `SpaceCacheManager`：`withScratch / createScratch / scratchPathSync / stats / gc`；未绑目录自动回落系统临时目录 |
| `.../memory-root.ts` | `SpaceMemoryRoots`：`workspaceId → <space>/.everoffice/memory`（60s 缓存 + 失效 + 命中时校验目录还在） |
| `.../routes.ts` | 10 个接口：default-root / detect / discover / adopt / layout / repair / relocate / library.reconcile / library.backfill / cache + cache.gc |
| `gateway/drizzle/0096_project_space_layout.sql` | `agent_workspaces` 增 `slug/root_mode/layout_version/root_missing_at` + `path` 唯一索引（重建表写法，可重放） |
| `desktop/.../workspace/SpaceDirectoryCard.tsx` | 概览「空间目录」卡：路径/健康/缓存/在访达显示/同步目录/修复/重新定位 |
| 测试 | `gateway/tests/workspace-{layout,library,cache,ops,memory}.test.ts`（22 例）+ `desktop/tests/project-space-directory.test.tsx`（7 例） |

### 15.3 关键实现取舍（与 v2 方案有出入的地方）

1. **P1 没有新增列**：原计划给 `file_entries` 加 `library_rel_path`/`fs_state`；实际复用 `relative_path`（v2 起存相对**空间根**的路径，v1 时相对 `Library/`）与 `state='missing'`。理由：`file_entries` 30+ 列、被 `file_versions`/`parsed_contents` 外键引用，为了加两列做整表重建风险远大于收益；而这两个语义本来就吻合（方案 §12.1 的"当前态 + missing"用现有列就能表达）。
2. **落点（v2）**：新条目一律**平铺在空间根**（不再按来源分 `inbox/outputs/imports`）；已在子目录里的老条目重导入/回填时**沿用原目录**（避免编辑保存把文件搬走）。
3. **`local-folder` 不复制**：本地夹条目引用的是用户磁盘上的原文件，落盘会变成两份会漂移的副本。
4. **离线只打标不重建**：`listWorkspaces` 逐行 `existsSync`，目录没了只写 `root_missing_at`；「重新定位 / 在原位重建」是显式动作（避免静默盖掉用户搬走的目录）。
5. **搬移是"移动"不是"复制"**：同卷 `rename`，跨卷 `cp + 校验标记 + 删旧`；失败保留原目录。
6. **缓存 GC 递归按龄**：`.tmp/<purpose>/<uuid>/` 里逐个文件判断年龄并剪空目录；`.everoffice/objects/` 被 `file_versions` 引用的永不删（历史快照），其余按 30 天清；`.everoffice/trash/` 按日期桶 30 天彻底删。
7. **Agent 工作目录用 run 级 cwd，不按空间复制 runtime**（2026-11-03）：方案原写「pi `workingDirectory` = 空间根 ⇒ 按 `agentId × spaceId` 建实例 ⇒ §11 风险 6 的实例数爆炸」。实做改成在**会话级**换 cwd：`PiAgentRuntime` 拿到 `integration.resolveProjectRoot(input)`（网关用 `SpaceAgentRoots` 按 `input.workspaceId` 解析空间根），建会话时把 `createAgentSession.cwd` / `SessionManager` cwd / 资源加载器 cwd / bash 沙箱根都换成空间根；`sessionsDir` / `agentDirectory` / runtime 实例仍是按 agent 一份。会话句柄记住自己的 cwd，**cwd 变了就丢掉句柄按同一 session 文件重建**（换绑空间、搬移目录、首次拿到空间根都走这条），历史不丢。好处：实例数不变、空间搬家自动跟随、无需热重载与实例回收；代价：`runtimeId` 仍是 `pi`（一个 runtime 代表一个 agent，不是一个 cwd）。空间未绑目录 / 目录丢了 / 标记坏了 → `SpaceAgentRoots` 返回 null，回落 agent 默认工作目录（旧行为）。
8. **`AGENTS.md` 手工加载**：`DefaultResourceLoader` 一直是 `noContextFiles: true`（避免把 agent 默认工作目录里的残留文件吸进提示词），所以空间级 `AGENTS.md` 由 `loadProjectInstructions()` 在**建会话时**读一次（16k 字符上限、缺失/不可读静默跳过），拼进 system prompt 的 `<project-instructions>` 段。

### 15.4 用户可见行为

- 新建空间：不选目录，直接落 `…/EverRoom/Workspace/<slug>`；同名自动 `-2`；概览页能看到目录、缓存占用、一键同步/修复。
- 资料库：导入/生成的文件**真的在空间根上**（与用户自己的文件并排），访达可见可用；改名同步改磁盘；删除进 `.everoffice/trash/<日期>/`。
- 访达里删/加文件 → 概览「同步目录」：删掉的标 missing、加上来的自动入库到原目录位置。
- 目录被搬走 → 概览显示「目录不在原位」，可「重新定位」（选目录把空间搬过去）或「在原位重建」。
- 复制一份空间目录 → 「作为副本注册」才会另立身份（同 `spaceId` 只允许一份绑定）。
- 记忆：绑了目录的空间，记忆写在 `.everoffice/memory/` 内，与全局库隔离；画像类汇总仍能合并看到。
- Agent 工作目录：会话属于哪个空间，Agent 的 bash / 文件工具就落在哪个空间根（相对路径以此为基准，提示词里会告诉它当前目录）；在空间根放一份 `AGENTS.md`，它会被当作项目约定读入（前缀注入，16k 字符上限）。空间没绑目录时行为与以前一致。
- 缓存：`.tmp`（过程缓存）与 `.everoffice/{cache/derived,objects}` 单独统计，可一键清理；启动 60s 后自动清一遍 tmp。
- 临时文件：概览「空间目录」卡的缓存行里有「临时文件 N」入口，点开是**只读**清单（相对路径 / 大小 / 修改时间，按时间倒序，最多 500 条，超出标 `500+`），可「在访达中显示」或「清理全部」。它**不入资料库索引**——`.tmp` 里是 Agent 的过程产物，进索引只会把临时文件变成一堆 `missing`。

### 15.5 明确未做（下一步）

| 项 | 原因 / 建议下一步 |
| --- | --- |
| **其余 6 处 `mkdtemp`** | `office/legacy-convert`、`documents/import`（媒体）、`vision/vlm-client`、`subagents/screenshot-jpeg`、`slides-style/render`、`subagents/slides-reference` 目前还没有 `workspaceId` 上下文；`SpaceCacheManager.withScratch/scratchPathSync` 已就绪，逐条把 workspaceId 透下去即可（论文排版已示范）。 |
| 首页「发现的空间」卡 | `discover` 接口与 IPC 已就绪（含"复制品未注册"标记），只差渲染层一张卡片。 |
| 外部目录 → 托管目录的"迁入"向导 | `relocate` 已支持，需要一层 UI 引导（当前只能在概览卡里重定位）。 |
| 真沙箱（路径围栏） | 空间根只是 `cwd`：pi 没有内置沙箱，`read`/`write`/`edit` 收绝对路径、bash 命令由审批 UI 把关；`allowedRoots` 自检恒真（cwd 是我们自己选的）。要真边界需 macOS `sandbox-exec`/Seatbelt 或容器化工具执行（见 `docs/agent-architecture-optimization-plan.zh-CN.md` 一类的后续期）。 |

### 15.5.1 2026-11-03 补齐（P2 Agent 根）

| 文件 | 变化 |
| --- | --- |
| `gateway/src/modules/workspace-layout/agent-root.ts`（新增） | `SpaceAgentRoots`：`workspaceId → 空间根`（标记健康才算；**不缓存**——一轮 run 只解析一次，缓存会带来"刚搬完目录就用旧路径"的窗口） |
| `gateway/src/server/create-server.ts` | 注入 `SpaceAgentRoots`，以 `projectRoot: (input) => spaceAgentRoots.resolve(input.workspaceId)` 传给用户档集成 |
| `gateway/src/modules/agent/runtime-factory.ts` | `AgentRuntimeIntegrationOptions.projectRoot` → pi 的 `resolveProjectRoot`（三档 main / main-direct / main-lite 共用） |
| `packages/agent-runtime-pi/src/index.ts` | `resolveProjectRoot` 钩子、`sessionCwd()`、会话句柄记 `cwd` 并在变化时重建、`loadProjectInstructions()`、bash/审批扩展改用会话 cwd |
| 测试 | `gateway/tests/space-agent-root.test.ts`（3 例：健康绑定/未绑与坏标记/搬移失效）+ `packages/agent-runtime-pi/tests/project-root.test.ts`（3 例：空间根进 system prompt 与 AGENTS.md、同会话换空间重建不丢历史、目录消失回落） |

### 15.6 验证

- `@nxcore/agent-contract` / `@nxcore/gateway` / `@nxcore/desktop` typecheck 无新增错误。
- 网关全量：**1913 通过 / 6 失败**（2026-11-03 v2 后复测），6 个失败在改动前就红且与本方案无关（`bundled-agent`、`database-migrations` 的 Yjs 重放断言、`document-understanding`、`file-catalog` 的 `.odt`、`thesis-format` 两条指向 `/Users/nxcore/Downloads` 的夹具）；`0096` 用重建表写法验证过不会新增失败。
- 桌面全量：**813 通过 / 0 失败**（含新增 7 例）。
- 新增 22 例网关测试覆盖：单标记与骨架、中文名 slug、default 绑址、健康与修复、判定与冲突、默认落点、发现未注册副本、落盘与落点分派、改名/删除/回收站、对账三向、存量回填、本地夹不复制、文件名收敛、scratch 生命周期与回落、缓存统计与 GC、搬移、离线标记与原地重建、接管与复制品另立身份、空目录接管、按空间记忆与合并列表。

---

## 16. v2 布局（2026-11-03：根即资料库）

### 16.1 为什么改

v1 的目录是"应用优先"的：根上摆 `space.everoffice`，资料全都塞在 `Library/` 里，记忆、对话、回收站各自一个专用目录。它有两个直接后果：

1. **用户的目录无法直接当工作空间**。把一个已经存满资料的文件夹设成空间，根上会凭空多出 `space.everoffice` + 5 个目录，资料库视图里还会看到 `Library/` 这一层多余的壳。
2. **和 coding agent 的心智不一致**。用户对"工作空间"的预期是：打开就是资料本身，Agent 用 `ls` / `cat` 就能看到业务文件，而不是"所有东西都在一个叫 Library 的子目录里"。

v2 把这两点反过来：**空间根就是资料库根**，应用只占用两个隐藏目录。

| | v1 | v2 |
| --- | --- | --- |
| 空间根 | `space.everoffice` + `Library/` + `Memory/` + `Conversation/` + `.trash/` | 只有 `.everoffice/` 与 `.tmp/`；其余都是资料 |
| 资料位置 | `Library/<dir>/<name>`（再分 inbox/outputs/imports） | `<space>/<name>`，新文件平铺 |
| 标记位置 | 根上 `space.everoffice` | `.everoffice/space.json` |
| 记忆 | `<space>/Memory` | `<space>/.everoffice/memory` |
| 回收站 | `<space>/.trash/` | `<space>/.everoffice/trash/` |
| 对象快照 | `<space>/Library/.cache/objects/` | `<space>/.everoffice/objects/` |
| 派生缓存 | `<space>/Library/.cache/derived/` | `<space>/.everoffice/cache/derived/` |
| 过程缓存（scratch） | `<space>/Library/.cache/tmp/` | `<space>/.tmp/` |
| 资料库隐藏项 | `Library/.cache`（点目录规则） | `.everoffice/` 与 `.tmp/`（点目录规则天然不进索引） |
| `relative_path` 基准 | `Library/` | 空间根 |

好处：

- **可以就地接管任意目录**：用户把"存满资料的目录"直接设为空间，应用只新增两个隐藏目录，零冲突。
- **资料库视图干净**：打开就是用户自己的文件与目录，没有被应用造的 `Library/` 壳。
- **Agent 好用**：`ls` / `glob` / `grep` 直接看到业务文件；`.tmp/` 与 `.everoffice/` 天然被点目录规则排除，不会污染检索。
- **外部工具友好**：Git / 同步盘 / 其他编辑器打开这个目录，看到的就是资料本身；元数据都在 `.everoffice/` 里，可被忽略规则一句话排除。

代价（已接受）：

- 标记不再"一眼可见"，用户需要知道 `.everoffice/` 是应用目录 → 概览卡与创建弹窗文案明说。
- 老的 v1 空间需要一次性迁移（见 §16.2）。

### 16.2 v1 → v2 迁移

触发点：`provision()` / `repair()` / `adopt()` / `relocate()` 与 `listWorkspaces()` 的 `ensureWorkspaceDirectory()`（DB `layout_version < 2` 即触发）。语义是**幂等 + 非破坏**：

| v1 位置 | v2 位置 | 冲突处理 |
| --- | --- | --- |
| `Library/<child>`（`inbox/`、`outputs/`、`imports/`、用户自建目录） | `<space>/<child>` | 目标已存在则跳过该条，保留原处（绝不合并、不覆盖） |
| `Library/.cache/objects/*` | `.everoffice/objects/` | 同上 |
| `Library/.cache/derived/*` | `.everoffice/cache/derived/` | 同上 |
| `Library/.cache/tmp/*` | 丢弃 | scratch 本就是小时级临时文件 |
| `Memory/` | `.everoffice/memory/` | 同上 |
| `Conversation/` | `.everoffice/conversation/` | 同上 |
| `.trash/` | `.everoffice/trash/` | 同上 |
| 根上 `space.everoffice` | `.everoffice/space.json`（重写为 `$everoffice=2`） | 旧文件改名为 `.everoffice/space.everoffice.migrated` 留档 |

关键性质：**`file_entries.relative_path` 不用改**。v1 的路径相对 `Library/`，迁移把 `Library/` 的 children 原样上移到空间根后，同一字符串相对空间根仍然指向同一个文件（`inbox/季度汇报.md` → `<space>/inbox/季度汇报.md`）。所以迁移不碰数据库，也不会让老条目变 `missing`。

未迁移的 v1 目录仍然**可读**（`readSpaceMarker` 回落根上 `*.everoffice`，`legacyLayoutToV2` 把旧 layout 翻译成扁平结构），只是布局还是 v1；任何一次 `provision/repair/adopt/relocate/list` 触达即迁移。

不迁移的情况（`status: unsupported`）：标记版本高于当前应用 → 只读降级，绝不改写。

### 16.3 代码落点

| 文件 | 变化 |
| --- | --- |
| `gateway/.../workspace-layout/markers.ts` | 契约 v2：`META_DIRNAME`/`SPACE_MARKER_BASENAME`/`SCRATCH_DIRNAME`、扁平 `SpaceLayoutMap`（含 `meta`，`library` 可为空串）、`legacyLayoutToV2()`、`spaceMarkerPath()`、`readSpaceMarker()` 双代兼容、`writeSpaceMarker()` 写 `.everoffice/space.json` |
| `.../service.ts` | `pathsOf()` 支持空角色（= 空间根）；`expectedDirectories()` 改 v2 清单；`provision()`/`relocateDirectory()`/`reassignIdentity()` 适配新标记路径；新增 `migrateLegacyLayout()` 与 `moveIfPresent()`；`layoutVersion` 暴露为服务属性 |
| `.../library.ts` | `defaultLibraryDirFor()` 一律返回 `""`（平铺） |
| `.../files/service.ts` | `libraryDirFor()`：新条目落根，老条目沿用原目录 |
| `.../memory-root.ts` | 缓存命中时校验目录还在（迁移换路径后不会复活旧 `Memory/`） |
| `.../routes.ts` | `detect` 的 `root` 改成用户给的那个目录（v2 标记在子目录里，不能再 `dirname(markerPath)`）；新增 `GET /v1/agent/workspaces/:id/cache/scratch`（`.tmp` 只读清单） |
| `.../cache.ts` | 新增 `listScratch()`：递归列 `.tmp`、按 mtime 倒序、500 条上限 + `truncated` 标记；**只读目录，不写库** |
| `gateway/.../agent/service.ts` | DB `layout_version` 跟随 `provisioned.marker.layoutVersion`；`ensureWorkspaceDirectory()` 对 `layoutVersion < 2` 也走 provision（顺带迁移）；`repairWorkspace()`/`relocateWorkspace()` 回写真实版本 |
| `packages/agent-contract` | `AgentSpacePaths` 增 `meta`；`library` 语义改为"资料库根（v2 = 空间根）" |
| `desktop/.../CreateWorkspaceDialog.tsx`、`SpaceDirectoryCard.tsx` | 文案改成"只新增 `.everoffice/`，其余原样保留"；空间目录卡新增「临时文件」只读弹窗（清单 / 在访达中显示 / 清理全部） |
| `gateway/tests/workspace-{layout,library,cache,ops,memory}.test.ts`、`space-agent-root.test.ts`、`agent-workspaces.test.ts` | 全部改 v2 语义；`workspace-layout.test.ts` 新增 v1→v2 迁移用例 |

### 16.4 验证

- `@nxcore/gateway` 全量：**1913 通过 / 6 失败**，剩余 6 个为改动前既有红（`bundled-agent`、`database-migrations` 的 Yjs、`document-understanding`、`file-catalog` 的 `.odt`、`thesis-format` 两条夹具）。`@nxcore/desktop`：871 通过 / 1 失败（`local-agents/discovery`，单跑通过，全量下并行 flaky，与本改动无关）。
- 空间相关测试：`workspace-layout`(7)、`workspace-library`(7)、`workspace-cache`(5)、`workspace-ops`(4)、`workspace-memory`(4)、`space-agent-root`(3)、`agent-workspaces`(4) 全绿。
- 临时文件入口：`workspace-cache.test.ts` 覆盖递归/倒序/上限截断/未绑定/空 `.tmp`；`workspace-layout.test.ts` 起真实 server 断言 HTTP 清单可用且**资料库索引仍为空**；桌面 `project-space-directory.test.tsx` 断言入口、只读清单与「清理全部」走缓存 GC。
- 迁移用例断言：`Library/inbox/季度汇报.md` → `<space>/inbox/季度汇报.md`、`Memory/notes.md` → `.everoffice/memory/notes.md`、objects/trash 就位、旧标记消失、`layoutVersion=2`、`markerFiles(root) == [".everoffice/space.json"]`。

### 16.5 后续（不在本次范围）

- 老 v1 空间的 `inbox/`、`outputs/`、`imports/` 目录会作为普通文件目录保留（不主动拍平）：想彻底"全部平铺"需要改 DB 的 `relative_path` + 处理重名，风险大于收益，留待需要时再做。
- 资料库 UI 的"隐藏项"目前靠点目录规则天然生效；若将来要展示 `.tmp` 用量，走设置页而非资料库列表。
