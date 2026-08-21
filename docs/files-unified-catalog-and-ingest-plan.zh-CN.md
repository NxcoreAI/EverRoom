# 文件中心统一目录、采集、解析与聚类实施方案

> 状态：已完成方案决策，待按本文实施
> 日期：2026-08-21
> 范围：`apps/gateway`、`apps/desktop`、Gateway 与 Desktop SQLite 迁移
> 关联方案：`docs/unified-ingest-plan.md`
> 决策优先级：本文覆盖 `unified-ingest-plan` 中“本地 path 只读不拷贝”的 U8 决策；U9“modules/files 是唯一字节入口”继续有效

## 1. 目标

将所有符合文件资格的资料收敛到同一个文件目录、同一个内容对象仓和同一条解析链路，使“文件”页面成为文件资产的唯一查询面。

本期必须完成：

1. 手动选择的本地文件和系统目录扫描发现的本地文件，统一存入 `<dataDir>/files/sha256`；
2. 两种入口都通过 Gateway 文件中心登记，再以不可变文件版本引用进入现有 `/v1/ingest`；
3. 首次启动后台扫描“桌面”和“文稿”，不显示 EverRoom 自定义授权弹窗；
4. 文件格式由 Gateway 单一注册表决定，不支持的文件在扫描阶段直接忽略，不登记、不落盘；
5. 连接器中的云文档、真实远端文件和附件进入文件目录，邮件与日历记录不进入；
6. 文件完成解析后，由专用文件整理 Agent 生成分类和聚类，聚类标题作为文件页面共享标题；
7. FilesPage 改为只查询统一文件目录，不再拼接 `uploaded_files`、本地 `source_items` 和连接器表。

## 2. 已确认决策

| 编号 | 决策 |
| --- | --- |
| F1 | EverRoom 受管副本统一位于 `<dataDir>/files/sha256/<hash前2位>/<sha256>`；不移动、不修改用户原文件。 |
| F2 | 手动上传和目录扫描只是两种采集来源，不是两种文件类型；页面仅以来源标签区分。 |
| F3 | 内容哈希只用于 blob 和解析结果去重，不作为文件逻辑身份。 |
| F4 | 手动文件使用随机稳定 ID；本地扫描文件使用目录数据源 ID 加文件资源标识；连接器使用服务、连接 ID 和远端记录 ID。 |
| F5 | 相同内容可对应多个来源文件；它们共享 blob 和解析结果，但保留独立来源身份，再由聚类归入同一文档族。 |
| F6 | 解析必须绑定不可变 `file_version`，不得在异步任务中读取“当前文件”，避免更新竞态。 |
| F7 | 文件准入、格式识别和解析器版本只有 Gateway 一处权威注册表。 |
| F8 | 不支持格式完全忽略；扩展名伪装或文件损坏则记录为解析失败，不进入 ready 状态。 |
| F9 | 邮件和日历记录不进入 FilesPage；云文档、真实远端文件和附件进入。连接器内部 Markdown 投影不生成第二个可见文件。 |
| F10 | 本地内容允许发送给云端模型；只有确定性解析完成后的有界文本进入文件整理 Agent。 |
| F11 | 不申请 Full Disk Access；不增加 EverRoom 自定义权限确认框；macOS 系统授权无法静默批准或屏蔽。 |
| F12 | Agent 维护稳定 cluster ID 和可变 canonical title；用户改过的标题进入 pinned 状态，Agent 不再覆盖。 |

## 3. 当前基线与需要删除的分叉

### 3.1 手动上传

当前链路已经接近目标：

```text
FilesGatewayBridge.pickAndImport
  -> POST /v1/files
  -> uploaded_files + files/sha256
  -> POST /v1/ingest (ref=file)
  -> parsed_contents
```

问题：

- `uploaded_files.id` 从规范化文件名派生，同名文件会互相覆盖；
- 上传和 ingest 是两个请求，应用在两者之间退出会留下裸文件；
- `uploaded_files` 只有当前内容指针，不能安全表达多个来源和不可变版本。

### 3.2 本地目录扫描

当前链路是另一套系统：

```text
LocalFolderConnector
  -> Desktop nxcore.db: source_items/source_versions
  -> <dataDir>/objects/sha256
  -> EvidenceService
  -> evidence_blocks/evidence_fts
```

问题：

- 与 Gateway 对象仓重复保存字节；
- 只解析 Markdown 和纯文本；
- 解析结果不进入 `parsed_contents` 和统一 ingest 台账；
- FilesPage 无法从一个查询面获得这些文件。

### 3.3 目标边界

Desktop 继续负责：

- 访问受 macOS 保护的本地目录；
- 文件发现、监听、权限状态和本地来源台账；
- 将可读取字节流发送到 loopback Gateway；
- 打开用户原文件或在 Finder 中定位。

Gateway 统一负责：

- 文件格式能力注册表和最终准入；
- 内容对象仓、文件目录、版本、解析任务和 GC；
- 确定性格式转换、`parsed_contents`、`ingest_events`；
- 文件分类、聚类和 FilesPage 查询 API。

Gateway 不直接读取“桌面”或“文稿”路径，避免第二个本地权限主体和路径时序问题。

## 4. 目标架构

```text
手动选择器 ─────────────┐
                       ├─ Desktop 预筛选/读取 ── POST /v1/file-imports
桌面/文稿后台扫描 ──────┘                              │
                                                      ▼
连接器文件/云文档/附件 ── Gateway 内部 importFile ── 文件目录事务
                                                      │
                              ┌───────────────────────┼────────────────────┐
                              ▼                       ▼                    ▼
                      files/sha256              file_versions       jobs(file.ingest)
                                                                          │
                                                                          ▼
                                                             /v1/ingest(ref=file version)
                                                                          │
                                                                          ▼
                                                                 parsed_contents
                                                                          │
                                                          embedding top-K + organizer Agent
                                                                          │
                                                                          ▼
                                                        classification + cluster + FilesPage
```

## 5. Gateway 数据模型

### 5.1 `file_blobs`

物理内容对象，一份字节只存一行。

| 字段 | 约束/说明 |
| --- | --- |
| `content_hash` | PK，原始字节 SHA-256 |
| `storage_path` | UNIQUE，相对 `dataDir` 的 `files/sha256/...` |
| `byte_size` | 非负整数 |
| `mime` | Gateway 校验后的 MIME |
| `created_at` | 创建时间 |

不保存可漂移的 `ref_count`；GC 时从 `file_versions` 实时查询引用。

### 5.2 `file_entries`

一个独立、可追踪的来源文件。相同内容的手动文件与扫描文件仍是两个 entry。

| 字段 | 约束/说明 |
| --- | --- |
| `id` | PK；存量保留原 `uploaded_files.id`，新文件使用 UUID |
| `source_kind` | `manual-upload` / `local-folder` / `connector` / `legacy-upload` |
| `source_key` | 与 `source_kind` 组合唯一的幂等键 |
| `original_name` | 原始文件名，永不被聚类标题覆盖 |
| `display_name` | 用户对单个文件设置的别名，可空 |
| `extension` | 注册表规范化后的扩展名 |
| `provider` | 连接器服务名，本地文件为空 |
| `connection_id` | 连接器连接 ID，本地文件为空 |
| `local_source_id` | Desktop `data_sources.id`，非目录扫描为空 |
| `local_item_id` | Desktop `source_items.id`，非目录扫描为空 |
| `relative_path` | 相对授权目录的路径；不把根目录授权信息交给 Gateway |
| `source_uri` | 远端 URL，可空 |
| `current_version_id` | 当前生效的不可变版本 |
| `state` | `processing` / `ready` / `failed` / `missing` / `deleted` |
| `last_seen_at` | 来源最后一次确认存在的时间 |
| `created_at`, `updated_at`, `deleted_at` | 生命周期字段 |

`UNIQUE(source_kind, source_key)` 是跨进程重试幂等边界。

### 5.3 `file_versions`

| 字段 | 约束/说明 |
| --- | --- |
| `id` | UUID PK |
| `file_entry_id` | FK -> `file_entries` |
| `version_no` | entry 内单调递增 |
| `content_hash` | FK -> `file_blobs` |
| `source_modified_at` | 来源修改时间，可空 |
| `parser_id` | 例如 `docx-mammoth` |
| `parser_version` | 例如 `1` |
| `parsed_id` | FK -> 既有 `parsed_contents`，解析前为空 |
| `ingest_event_id` | FK/弱引用 -> `ingest_events` |
| `status` | `stored` / `queued` / `parsing` / `parsed` / `failed` |
| `error_code`, `error_message` | 失败诊断，可空 |
| `created_at`, `processed_at` | 时间字段 |

约束：

- `UNIQUE(file_entry_id, version_no)`；
- `UNIQUE(file_entry_id, content_hash)`，同一来源同内容重试不创建新版本；
- 一个解析任务必须携带 `file_version.id`，不能只携带 `file_entry.id`。

### 5.4 分类与聚类

新增：

- `file_classifications`：`file_version_id`、类型、摘要、标签、模型/提示词/schema 版本、置信度；
- `file_clusters`：稳定 ID、`canonical_title`、`title_source(agent|user)`、`title_pinned`；
- `file_cluster_memberships`：entry 与 cluster 的成员关系、判定模型、置信度和时间。

精确内容重复可确定性加入同一 cluster；非精确重复由 Agent 决定。

### 5.5 Desktop 对账表

Desktop `nxcore.db` 新增 `source_exports`，解决 Desktop DB 与 Gateway DB 不能跨库事务的问题：

| 字段 | 说明 |
| --- | --- |
| `source_version_id` | PK，FK -> Desktop `source_versions` |
| `file_entry_id` | Gateway 返回值 |
| `file_version_id` | Gateway 返回值 |
| `status` | `pending` / `exporting` / `exported` / `failed` |
| `attempt_count`, `last_error`, `updated_at` | 重试信息 |

Gateway 的 `sourceKey + contentHash` 保证 Desktop 在响应丢失后重试不会重复导入。

## 6. 文件格式能力注册表

Gateway 新增唯一注册表 `FileFormatCapability`：

```ts
interface FileFormatCapability {
  extension: string
  dataType: string
  parserId: string
  parserVersion: number
  manualImport: boolean
  autoScan: boolean
  connectorImport: boolean
  maxBytes: number
}
```

通过 `GET /v1/files/capabilities` 暴露给 Desktop。Desktop 只用于早期剪枝，Gateway 导入时必须再次校验。

### 6.1 v1 准入集合

| 扩展名 | parser | 手动 | 自动扫描 | 连接器 |
| --- | --- | --- | --- | --- |
| `.md`, `.markdown`, `.mdx` | `markdown` | 是 | 是 | 是 |
| `.txt`, `.text` | `plain-text` | 是 | 是 | 是 |
| `.docx` | `docx-mammoth` | 是 | 是 | 是 |
| `.xlsx` | `xlsx-exceljs` | 是 | 是 | 是 |
| `.pptx` | `pptx-jszip` | 是 | 是 | 是 |
| `.csv` | `csv-rfc4180` | 是 | 是 | 是 |
| `.html`, `.htm` | `html-turndown` | 是 | 是 | 是 |

继续忽略：

- `.json`：只允许内部结构化入口，不能由文件系统扫描进入；
- `.eml`：邮件记录已确认不进入文件页面；
- `.pdf`：当前 Gateway 没有可靠解析器，完成 parser、回归样本和体积限制前不准入；
- 图片、音频、视频和压缩包：继续走 perception/reality 等专用入口，不作为本期文档文件扫描对象；
- `.doc`、`.xls`、`.ppt`：旧二进制 Office 格式无现成 parser，直接忽略。

文件扩展名通过后，Gateway 还要校验体积、文本编码或 Office ZIP 容器结构。损坏文件返回稳定错误码，不进入聚类。

## 7. 统一导入契约

### 7.1 API

新增：

```text
POST /v1/file-imports
Content-Type: multipart/form-data
```

元数据：

```json
{
  "sourceKind": "manual-upload | local-folder",
  "sourceKey": "稳定幂等键",
  "originalName": "方案.docx",
  "localSourceId": "可空",
  "localItemId": "可空",
  "relativePath": "项目/方案.docx",
  "sourceModifiedAt": "2026-08-21T...Z",
  "pipelines": { "room": true, "wiki": true, "memory": true }
}
```

返回 `202 Accepted`：

```json
{
  "fileEntryId": "...",
  "fileVersionId": "...",
  "jobId": "...",
  "contentHash": "...",
  "blobDeduped": false,
  "versionDeduped": false
}
```

连接器不走本机 multipart，而是在 Gateway 内调用同一个 `FilesService.importFile()`，其余流程完全相同。

### 7.2 原子性和恢复

1. 请求体流式写入 `<dataDir>/files/tmp/<import-id>.part`，同时计算 SHA-256 和体积；
2. 读取完成后校验格式；来源文件在传输前后 size/mtime 变化时，Desktop 放弃本次并重试；
3. 同一文件系统内将临时文件 rename 到内容寻址路径；目标已存在则删除临时文件；
4. Gateway 单个 SQLite 事务内 upsert blob、entry、version，并插入 `jobs`；
5. job ID 使用 `file.ingest:<fileVersionId>:<parserId>@<parserVersion>`，利用主键保证幂等；
6. 数据库事务失败后可能产生无引用 blob，由周期 GC 清理；不会产生有记录无字节的版本；
7. worker 失败按既有 jobs 重试策略执行，终态失败写回 `file_versions`。

旧的 `/v1/files` 保留一版兼容，但所有 Desktop 新调用切换到 `/v1/file-imports`。兼容端点内部也应调用 `importFile()`，不再维护第二套实现。

## 8. 两种本地采集流程

### 8.1 手动选择文件

```text
用户点击“导入文件”
  -> 系统文件选择器
  -> Desktop 用 capabilities 预筛选
  -> 每个文件生成 manual:<uuid> sourceKey
  -> POST /v1/file-imports
  -> 页面立即出现 processing 行
  -> 后台解析、分类、聚类
```

手动导入是复制，不是移动。删除文件目录中的手动 entry 可清理受管副本及派生数据，但不得删除用户最初选择的外部文件。

### 8.2 桌面和文稿后台扫描

首次启动 `app.ready` 且 Gateway ready 后，在后台调用现有 `bootstrapDefaultLocalFolders()`：

```ts
[app.getPath('desktop'), app.getPath('documents')]
```

扫描规则：

1. 不显示 EverRoom 自定义介绍、确认或授权弹窗；
2. 忽略隐藏文件、隐藏目录、依赖/构建/缓存目录和符号链接目录；
3. 先按 capabilities、体积、文件类型剪枝；不支持文件不创建任何逐文件记录；
4. 文件身份优先使用 macOS file resource identifier；无法取得时使用 `dev:ino:birthtimeMs`，最后才回退规范化路径；
5. identity、size、mtime 均未变化时不读文件内容；变更时流式导入 Gateway；
6. rename/move 只更新路径；内容哈希不变时不创建新版本、不重新解析；
7. watcher 事件只作为触发信号，去抖后重新扫描；启动、定时校验和事件丢失后均执行全量 reconciliation；
8. 扫描和导入默认并发 2，可配置；不会阻塞窗口创建和 FilesPage 渲染；
9. 被拒绝或暂时不可读的目录只更新目录级状态，不持续弹窗，不阻塞另一个默认目录；
10. 用户在“数据源”设置中主动重新连接时，才允许显示系统目录选择器。

macOS 系统 TCC 提示由系统控制，EverRoom 不能静默批准。当前非 App Sandbox 构建不申请 Full Disk Access；未来启用 App Sandbox 时再增加 security-scoped bookmark 持久化。

## 9. 连接器文件准入

### 9.1 进入 FilesPage

- `connector_documents` 中的云原生文档；
- Drive/Dropbox/OneDrive 等服务中的真实文件；
- 邮件或其他业务记录上的文件附件，附件作为独立 file entry；
- generic record 只有在明确表达文件、具备稳定 remote ID、文件名/格式和可读取内容时才进入。

### 9.2 不进入 FilesPage

- 邮件正文、邮件线程；
- 日历事件；
- 普通 CRM、任务、联系人等结构化记录；
- `connector_markdown_artifacts` 等内部规范化投影。

### 9.3 字节策略

- 真实远端文件：下载原始支持格式，交给 `importFile()`；
- 云原生文档：优先导出受支持的原生格式；只有连接器仅能提供 Markdown 时，将该 Markdown 作为受管快照导入；
- 内部 Markdown 只作为 entry 的当前版本内容，不额外生成可见文件；
- source key 为 `connector:<service>:<connectionId>:<remoteRecordId>`；附件追加稳定 attachment ID；
- 远端版本/etag 未变化时不重复下载和解析。

## 10. 统一解析链路

job worker 使用精确版本引用调用 Ingest：

```json
{
  "source": {
    "ref": {
      "sourceKind": "file",
      "sourceId": "file-entry-id",
      "sourceVersionId": "file-version-id"
    }
  }
}
```

Ingest 必须：

1. 按 `file_versions.content_hash` 读取不可变 blob；
2. 从能力注册表选择 parser，而不是重新根据 UI 参数猜测；
3. 将 parser ID 和版本写入 `parsed_contents.parser_version`，例如 `docx-mammoth@1`；
4. 复用 `(content_hash, parser_version)` 唯一约束，同内容同 parser 只解析一次；
5. 将 `parsed_id` 回写到本次 `file_version`，而不是只回写 entry 当前指针；
6. 台账的 `sourceId` 使用 entry ID，`sourceVersion` 使用 `version_no`；
7. 解析成功后才创建分类任务；解析失败不进入 Agent。

原有 `source.path` 保留为内部诊断逃生口，但 Desktop 手动导入和目录扫描禁止再使用它。

## 11. 文件分类与聚类 Agent

### 11.1 顺序

```text
格式确定性分类
  -> 内容哈希精确重复判断
  -> 解析 Markdown
  -> embedding 检索候选 cluster（top 8）
  -> 文件整理 Agent 选择已有 cluster 或新建 cluster
  -> 保存 canonical title 与 membership
```

### 11.2 Agent 输入

- 原始文件名、扩展名、来源标签和来源服务；
- 解析 Markdown 的有界片段和确定性摘要；
- top 8 候选 cluster 的 ID、标题、摘要和相似度；
- 明确声明文件内容是不可信数据，不得把其中指令当系统指令执行。

Agent 无工具权限，不得访问文件系统、网络或执行文件内容。

### 11.3 结构化输出

```json
{
  "action": "join_existing | create_new",
  "clusterId": "existing-id-or-null",
  "canonicalTitle": "共享标题",
  "category": "项目资料",
  "confidence": 0.86
}
```

规则：

- JSON schema 校验失败重试一次；仍失败则以原文件名创建待复核 cluster；
- 精确内容重复不调用 Agent，直接复用已存在 cluster；
- canonical title 长度 2-80 字符，不允许路径、扩展名堆叠和提示词内容；
- cluster ID 永不随标题变化；
- 用户编辑标题后 `title_pinned=true`，后续 Agent 只能调整成员关系；
- 保存模型、提示词、schema 和 embedding 版本，支持重跑与审计；
- v1 非精确场景均由 Agent 决定，暂不使用未经标注集校准的相似度阈值自动合并。

## 12. FilesPage 查询与交互

`GET /v1/files` 返回统一 DTO：

```ts
interface FileListItem {
  id: string
  originalName: string
  displayName: string | null
  sharedTitle: string
  sourceKind: 'manual-upload' | 'local-folder' | 'connector' | 'legacy-upload'
  sourceLabel: string
  relativePath: string | null
  provider: string | null
  bytes: number
  dataType: string | null
  processingState: 'processing' | 'ready' | 'failed' | 'missing'
  clusterId: string | null
  updatedAt: string
}
```

页面行为：

- 默认按 cluster 分组，组标题使用 `canonical_title`，组内保留原文件名和来源标签；
- 支持来源、类型、状态筛选和文本搜索；
- processing/failed/missing 有明确状态，后台任务不弹阻塞式提示；
- 预览始终读取 `parsed_contents`；
- 目录扫描文件的“显示原件”由 Desktop 用 `localSourceId + localItemId` 解析原路径；
- 原件缺失时仍可预览受管快照，状态显示 missing；
- 删除目录扫描 entry 只删除 EverRoom 目录记录和受管引用，绝不删除用户原件；
- 删除 cluster 仅解除分组，不级联删除文件；
- 用户可编辑共享标题并 pin。

FilesPage 不再读取 Desktop `source_items`、连接器表或 `ingest_events` 后在 UI 合并数组。

## 13. 兼容迁移与切换

### M1：新增结构，不切读流量

1. 生成 Gateway 新 migration，创建 blobs/entries/versions/classifications/clusters/memberships；
2. Desktop migration 创建 `source_exports`；
3. 新增 repository/service 和能力注册表；
4. 保留全部旧表和旧接口。

### M2：迁移 `uploaded_files`

1. 每行创建 `legacy-upload` entry，entry ID 保留原 ID，避免破坏 ingest/knowledge/memory 的文本引用；
2. 按当前 content hash 创建 blob 和 version；
3. 复制 `current_parsed_id` 到 version；
4. 对账行数、hash、对象存在性；
5. FilesService 新查询优先读新表，旧端点通过适配器保持 DTO。

现有同名覆盖造成的历史版本无法恢复；迁移只保证当前状态不丢失。

### M3：切换新写入

1. 实现 `/v1/file-imports` 和 version-specific ingest ref；
2. 手动选择文件改走新接口；
3. 旧 `/v1/files` 内部转调 `importFile()`；
4. 验证 Room、Wiki、Memory 旧引用仍可工作。

### M4：迁移本地目录

1. 启用 Desktop `source_exports` worker；
2. 对存量 `source_items` 的最新受支持版本，读取现有 `<dataDir>/objects/sha256` 快照并幂等导入 Gateway；
3. 新扫描文件直接流式进入 Gateway，不再创建新的 Desktop object；
4. 对账 source/version/hash/解析结果；
5. 停止 `EvidenceService` 为文件目录生成新解析任务；
6. 至少保留一个发布周期的旧 objects 和 evidence 数据，确认无回滚需求后再单独执行 GC。

### M5：连接器接入

1. 为 connector document/file/attachment 生成稳定 source key；
2. 同步成功后调用 `importFile()`；
3. 回填现有符合资格的 connector documents；
4. 验证邮件、日历和普通 generic records 没有进入文件目录。

### M6：聚类与页面切换

1. 创建 embedding、Agent 分类 worker 和聚类 API；
2. 对 ready 文件后台回填分类和 cluster；
3. FilesPage 切换到统一 DTO；
4. 旧数据面保留只读一版，指标稳定后删除 UI 依赖。

## 14. 实施阶段与出口标准

| 阶段 | 主要改动 | 出口标准 |
| --- | --- | --- |
| P0 契约与迁移 | schema、migration、DTO、capabilities | migration 可前滚；旧测试不回归 |
| P1 统一存储 | `importFile()`、流式临时文件、CAS、幂等和 GC | 两入口相同内容只产生一个 blob |
| P2 版本化解析 | version ref、持久化 job、parser registry | 两入口均产同 parser/version 的 parsed content；重启可恢复 |
| P3 本地扫描 | 默认目录 bootstrap、权限状态、source_exports、watch/reconcile | 首次后台扫描；unsupported 零记录；rename 不重解析 |
| P4 连接器文件 | 文档/文件/附件准入和回填 | 目标类型进入；邮件/日历不进入 |
| P5 Agent 聚类 | embedding 候选、Agent schema、pin 与回填 | 同主题共享标题；用户标题不被覆盖 |
| P6 FilesPage | 统一列表、分组、筛选、状态和操作 | 页面只依赖统一文件 API |
| P7 清理 | 停止旧写入、兼容期、受控 GC | 无旧 UI/新写依赖；可回滚期结束后再清理 |

阶段必须按顺序合并。P1/P2 完成前不得启用默认目录扫描；P5 完成前 FilesPage 可按原文件名展示 processing/ready 文件，但不得伪造共享标题。

### 14.1 2026-08-21 实施状态

- P0-P2：已完成。新目录迁移、流式 CAS、不可变版本 ref、持久化解析 job 和重启恢复已落地；
- P3：已完成。Desktop/Documents 在 Gateway ready 后后台 bootstrap，使用 capabilities 剪枝和 `source_exports` 对账；新扫描文件不再写 Desktop 对象仓；
- P4：已完成当前可读取内容范围。Gateway `connector_documents`，以及 Desktop Google Docs、Notion、GitHub 实际仓库文件进入 catalog；邮件、日历、GitHub issue 投影和 connector markdown artifact 不进入；
- P5：已完成。exact hash 确定性归并，非精确内容走 embedding top-8 与无工具 Knowledge Agent，失败保守新建 fallback cluster，用户标题可固定；
- P6：已完成。FilesPage 只读取 `/v1/files/catalog`，直接展示共享标题、原文件名、来源和处理状态；
- P7：已完成兼容期第一阶段。新写入已切换到 Gateway，旧表和旧对象只保留兼容，不在本版本物理删除。

邮件附件当前只从连接器取得文件名、MIME、大小和 provider ID，没有附件字节或可信下载流，因此不会用邮件正文伪造文件。连接器一旦提供附件内容流，应以 `connector:<service>:<connectionId>:<messageId>:<attachmentId>` 调用同一 `FilesService.importFile()`，无需增加新存储或解析链路。

### 14.5 文件页拖拽：一次性手动采集

- 文件页接受操作系统拖入的一个或多个文件、目录；renderer 只处理拖拽交互，不直接读取本地路径或字节；
- preload 使用 Electron `webUtils.getPathForFile(file)` 将本次用户明确拖入的 `File` 转为原生路径，再通过专用 IPC 交给主进程；不依赖已移除的非标准 `File.path`；
- 主进程每次 drop 只展开一次目录。隐藏目录、依赖/构建/缓存目录直接剪枝，符号链接不跟随，失效路径和 Gateway 不支持的格式在读取字节前过滤；
- 格式准入只消费 `/v1/files/capabilities` 中 `manualImport=true` 的扩展名，不在 renderer 或拖拽入口维护第二份白名单；
- 每个候选使用独立 `manual:<uuid>` source key，随后调用现有 `/v1/file-imports`，因此最终存储、解析、分类和 Agent 聚类均与普通手动导入一致；
- 此入口不调用 `addLocalFolder()`，不创建本地数据源，不持久化目录授权，不启动 watcher，也不因目录后续变化而重扫；再次拖入属于新的用户操作；
- 拖拽是用户明确选择，不增加 EverRoom 自定义权限弹窗；若操作系统因受保护目录触发 TCC，应用不能静默批准或屏蔽系统弹窗。

## 15. 测试矩阵

### 15.1 Gateway 单元/集成测试

- 每个准入扩展名：有效文件成功、空文件失败、损坏文件失败、超限失败；
- source key 幂等：响应丢失后重试不创建第二个 entry/version；
- 同内容不同来源：两个 entry、一个 blob、一个 parsed content；
- 同来源内容更新：同 entry、新 version、新 ingest event；
- version 竞态：v1 parsing 时导入 v2，两个任务读取各自 blob；
- 进程在 stored/queued/parsing 各状态退出，重启后任务恢复；
- blob GC 不删除仍被任一 version 引用的内容；
- legacy uploaded file 迁移后原 ID、预览、Room/Memory 引用不变；
- 精确重复聚类不调用 Agent；Agent 非法 JSON 的重试和 fallback；
- pinned title 不被重分类覆盖。

### 15.2 Desktop 测试

- capabilities 驱动扫描，不再依赖独立扩展名常量；
- Desktop/Documents 任一拒绝不影响另一目录；
- 不支持格式不创建 `source_items/source_versions/source_exports`；
- 文件 rename/move 保持 identity；
- 文件在导入中变化会重试，不提交撕裂快照；
- Gateway 成功但 Desktop 回写前退出，重启后幂等对账；
- scan/watch 大量事件去抖且窗口保持可用；
- 删除 FilesPage 扫描文件不调用本地 unlink。
- 拖入目录只递归展开一次，不注册 source/watcher；
- 拖入目录剪枝隐藏、依赖、构建和缓存目录，不跟随符号链接；
- 拖入多个重叠路径时按绝对路径去重，不支持格式和失效路径不进入上传。

### 15.3 端到端验收

1. 同一个 `.docx` 分别手动导入和放入“文稿”：页面显示两个来源，物理 blob 和解析结果各一份，聚类标题相同；
2. 修改“文稿”中的文件：仅扫描来源生成 v2，手动来源保持 v1；
3. 移动文件：来源路径更新，版本与解析不变；
4. 放入 PDF、JSON、图片：FilesPage、Gateway 目录、对象仓均无新增；
5. 重启应用：未完成任务继续，ready 文件不重复解析；
6. 同步云文档和附件：进入 FilesPage；同步邮件和日历：不进入；
7. 编辑 cluster 标题后再次同步/重跑 Agent：标题保持用户值；
8. 删除扫描 entry：用户原件仍存在；删除最后一个 blob 引用后才允许 GC 受管副本。
9. 拖入一个同时包含支持/不支持格式的目录：只显示支持文件，所有入选文件进入与按钮导入相同的解析和聚类链路；
10. 拖入目录后修改或新增文件：不会自动导入；再次拖入时才执行新的一次性采集；
11. 拖入目录不会在“数据源”中新增目录，也不会在应用重启后自动重扫。

## 16. 可观测性与发布门槛

新增结构化指标：

- `files.scan.discovered/eligible/ignored/failed`；
- `files.import.started/completed/deduped/failed`；
- `files.parse.queued/completed/failed/duration_ms`；
- `files.cluster.joined/created/fallback/pinned`；
- 按 `source_kind`、`extension`、`parser_id` 分组，不记录文件正文和完整本地路径。

发布门槛：

- migration、Gateway typecheck/test、Desktop typecheck/test 全通过；
- 端到端矩阵 8 项通过；
- 存量 `uploaded_files` 和本地最新版本回填对账为 100%；
- 没有任何代码路径为新本地文件写入 `<dataDir>/objects/sha256`；
- FilesPage 生产查询不再拼接旧数据源；
- 至少保留一个发布周期的旧表/对象，只停止写入，不在首个版本物理删除。

## 17. 代码改动清单

Gateway：

- `src/infrastructure/database/schema.ts` 和新 Drizzle migration；
- `src/modules/files/format-registry.ts`；
- `src/modules/files/import-service.ts`、对象仓流式写入、版本 repository、GC；
- `src/modules/files/routes.ts`：capabilities、imports、统一 list/detail；
- `src/modules/ingest/types.ts/service.ts`：version-specific file ref；
- `src/modules/ingest/converters.ts/normalizers.ts`：parser ID/version 对齐；
- 文件分类/聚类 worker、Agent schema 和列表查询；
- files、ingest、migration、connector、Agent 测试。

Desktop：

- `src/main/file-format-policy.ts` 改为消费 Gateway capabilities，删除独立白名单；
- `src/main/core/local-data-service.ts`：默认目录启动、source_exports、Gateway export worker；
- `src/main/connectors/local-folder-connector.ts`：稳定资源身份、metadata-first reconcile；
- `src/main/gateway/files-gateway-bridge.ts`：统一 import/capabilities/list API；
- `src/main/index.ts`：Gateway ready 后后台 bootstrap；
- preload/shared DTO；
- `FilesPage.tsx`：统一查询、cluster 分组和来源状态；
- scanner、bridge、FilesPage 测试。

本文所有 P0-P7 完成并满足发布门槛后，才视为“文件页面统一数据源、存储、解析和聚类”目标完成。

## 18. 调研与决策依据

| 结论 | 依据 |
| --- | --- |
| Gateway 对象仓作为唯一最终位置 | 当前 `apps/gateway/src/modules/files/storage.ts` 已实现 `files/sha256` 内容寻址；Desktop `local-data-service.ts` 另有 `objects/sha256`，统一到前者可以直接删除重复存储边界。 |
| 不再使用文件名生成逻辑身份 | 当前 `fileIdOf(filename)` 位于 `apps/gateway/src/modules/files/storage.ts`，同名不同路径会冲突；Desktop 已能取得 `dev:ino`，见 `local-folder-connector.ts`。 |
| 解析绑定不可变 version | 当前手动上传会更新 `uploaded_files` 当前 hash，而异步处理读取当前行；版本引用可以消除导入 v1 后快速更新到 v2 的 TOCTOU 竞态。 |
| 单一格式注册表 | 当前 Desktop 自动扫描、手动选择和 Gateway 上传各维护一份不同扩展名集合；Gateway converters 已实际支持 docx/xlsx/pptx/csv/html，见 `apps/gateway/src/modules/ingest/converters.ts`。 |
| 原始字节必须先进入文件中心再解析 | 当前 `IngestService` 的 file ref 已从对象仓读字节，并用 `(contentHash, parserVersion)` 复用解析结果；扩展为 version ref 可以保留这条成熟路径。 |
| Desktop 读取保护目录、Gateway 不直接读路径 | Electron 当前以 Desktop 主进程取得 `appData/userData` 并启动 loopback Gateway。macOS 对 Desktop/Documents 的访问由系统隐私控制，不能由应用静默授权；参见 [Apple Platform Security: Controlling app access to files](https://support.apple.com/guide/security/controlling-app-access-to-files-secddd1d86a6/web)。 |
| 拖入文件路径由 preload 的 `webUtils` 获取 | Electron 已移除 `File.path`，官方要求使用 `webUtils.getPathForFile(file)` 取得拖入文件的真实路径；参见 [Electron webUtils API](https://www.electronjs.org/docs/latest/api/web-utils)。 |
| 不申请 Full Disk Access，沙盒化后才使用 bookmark | Apple App Sandbox 对用户选择目录使用 security-scoped bookmark；当前构建未启用 App Sandbox。参见 [Apple App Sandbox entitlement reference](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html)。 |
| watcher 只触发 reconciliation | 文件系统事件可能合并或丢失，必须在启动和 dropped events 后重扫；参见 [Apple File System Events Programming Guide](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/UsingtheFSEventsFramework/UsingtheFSEventsFramework.html)。 |
| embedding 只负责候选召回，Agent 决定非精确聚类 | 语义向量适合降候选集，但未经标注集校准的固定阈值不能可靠替代最终归类；候选检索/表示/聚类分层可参考 [BERTopic modular algorithm](https://maartengr.github.io/BERTopic/algorithm/algorithm.html)。 |
| Agent 无工具、输入有界、输出 JSON 校验 | 文件正文属于不可信输入，必须防止其中指令改变 Agent 行为；参见 [OWASP LLM01: Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)。 |

以上依据是实现评审基线。若实现需要改变 F1-F12 中任一决策，必须先更新本文的决策、迁移影响和验收用例，不能只在代码中形成隐式新行为。
