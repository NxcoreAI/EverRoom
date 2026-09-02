# 飞书云文档 + Notion 双向同步：调研与方案设计

> 2026-09-01 · 面向需求：飞书 OAuth 授权、飞书云文档/Notion 页面导入 EverRoom、EverRoom 文档导出回两平台、授权失效/权限不足/同步失败的提示与重试、双向防重复与防覆盖。
> 结论与建议均基于官方文档（检索于 2026-09）与对本仓库 connector 架构的代码调研。
> **2026-09-02 评审修订**（lark-cli v1.0.84 实测 + 官方文档复核 + pin 源码核验，评审报告见 `feishu-notion-connector-research.review.md`）：修正 feishu provider 动作与 scopes 现状（§0/§4.2/§4.3/§4.6/§4.8）、`docs +update` 实际命令集并取消 v1 飞书 sync_update（§2.4/§4.4.6）、markdown 读路径对未公开 docs_ai 端点的依赖（§2.3/§5.8）、refresh_token 时效表述（§2.1/§4.5）。

---

## 0. 结论速览

| 需求项 | 可行性 | 关键结论 |
|---|---|---|
| 飞书 OAuth 授权 | ✅ | 标准 OAuth 2.0 授权码模式（v2 接口）。`user_access_token`/`refresh_token` 有效期官方仅给示例并注明"非固定值"（uat 示例约 2 小时、refresh_token 示例 **7 天**，以响应体实际值为准），refresh 即轮换（旧的一次性失效）。仓库内嵌 Nango 无 feishu provider（OpenConnector 路线下不再需要） |
| 飞书云文档导入 | ✅ | 优先 provider `fetch_document`（markdown 整读/局部读；底层为未公开 docs_ai 端点，风险与兜底见 §2.3/§5.8）；导出任务 API 只有 docx/pdf 等、**无 Markdown**。云空间 + 知识库（wiki v2）两条发现路径都要支持（provider 动作已就位，见 §0 架构落位） |
| Notion 页面导入 | ✅（大半已有） | Notion 官方已提供 **Markdown 内容 API**（`GET /v1/pages/:id/markdown`），可整页一次拉取，优于现有 blocks 分页实现；导入链路（Nango OAuth→同步→ingest）仓库已基本具备 |
| EverRoom → 飞书导出 | ✅ | 两条写路径：官方"导入任务"支持 `.md` → 飞书新版文档（创建新文档，API 无覆盖语义，≤20MB、100 次/分钟）；原地更新命令族另存在（`docs +update`：str_replace / block_* / append / overwrite，v1.0.84 实测**无"按标题整节替换"**），节粒度 sync_update 需多步编排——**v1 飞书只做 create_copy**（§4.4.6） |
| EverRoom → Notion 导出 | ✅ | `POST /v1/pages` 带 `markdown` 参数直接建页（首个 `# h1` 自动作标题）；大内容 `allow_async: true` 走异步任务轮询。更新已有页有 `replace_content`，且**默认拒绝删除子页面**，防覆盖有平台级保险 |
| 权限/失效提示 | ✅ | 两平台错误码语义清晰（见 §5.5 矩阵）。Notion 特有：页面未共享给连接 → `404 object_not_found`，是最常见"权限不足"形态，文案必须与"授权失效"区分 |

**架构落位（2026-09-01 最终决策：统一 OpenConnector 路线，Nango 弃用）**：导入走 CLI 路径（OpenConnector/`oo` CLI + 网关 `document-sync` 确定性作业 + domain-projection → markdown-service → ingest）；**上游 open-connector 已有 feishu provider（OAuth 用户授权已实现）且 notion provider 已含 Markdown API 动作（`retrieve_page_markdown`/`update_page_markdown`/`create_page`）**。（2026-09-01 二次核实、09-02 评审源码复核定论：feishu provider 的 `fetch_document`（markdown/局部读）、`create_document`/`update_document`、`search_documents`、wiki/drive 发现动作、以及导出用的 `submit_drive_import`/`get_drive_import`/`get_drive_task_status` **均已就位于当前 pin（`5719a69`/v1.3.5），provider 层无需扩展、无需 fork**——早期"动作只有元数据/纯文本读 + Bitable 读"的误判，是这些动作以 `...createFeishu*Actions()` 从 shared/ 展开注入、对 actions.ts 做内联 grep 查不到所致；授权 scope 集由全部动作的 `providerPermissions` 自动派生，编辑/导入/导出/wiki 权限已在派生集内，剩余工作是精确审计而非"补权限"。实际缺口在网关作业接入与规范化基建。）导出是全新能力，建议新建"导出 outbox + 导出映射表"，反向复用 markdown-service 的 lease/退避模式，并绕开同步作业的只读白名单（写操作走独立导出通道，不放松导入作业约束）。

---

## 1. 代码库现状（本仓库调研结论）

### 1.1 已有
- **Notion 导入全链路已可用**：Nango 路径（[sync-providers/notion.ts](apps/gateway/src/modules/connectors/sync-providers/notion.ts)：search + blocks→markdown）+ 授权/自举/首同步直启；CLI 路径还有 reconcile/incremental 双作业（`last_edited_time` 水位）与 `notion-document-sync-v1` prompt profile。
- **飞书 wiki 导入（api-token 版）已在网关注册**：[sync-providers/feishu-wiki.ts](apps/gateway/src/modules/connectors/sync-providers/feishu-wiki.ts)（自建应用 `tenant_access_token` → wiki spaces → 节点树 → docx raw_content，凭据 `appId:appSecret`），但桌面 UI 仍是 disabled 占位（ConnectSourceMenu.tsx:95-97）。
- **同步基础设施全部可复用**：ConnectorManager/SyncEngine/Repository（lease + fenceToken + cursor 防并发）、domain-projection 幂等 upsert（唯一键 `ownerId+service+connectionName+sourceRecordId` + contentHash 跳过）、ConnectorMarkdownService（双向 hash 幂等、outbox 退避 `[30s,2m,10m,1h]`、10 次进 dead）、IngestService（`connector-document` sourceKind 已含）。
- 内嵌 Nango（modules/connector，127.0.0.1:3003）承担 gmail/outlook/google-*/notion 的 OAuth 获取与刷新，Connect UI 现成。

### 1.2 缺口（= 本需求工作量所在）
1. 飞书**用户级 OAuth**（区别于现有应用级 api-token）：内嵌 Nango providers.yaml **无 feishu/lark 定义**（已验证，26874 行里 0 命中）；`SyncProviderNangoMeta.credential` union 只有 `google|notion|outlook|none`。
2. 飞书云文档（个人云空间，非 wiki）的发现与导入 provider 不存在；现有 feishu-wiki 用 raw_content 纯文本，**不满足"正文结构完整"**，需换 blocks→Markdown 转换。
3. **导出方向是全新能力**：现有同步作业强制只读（allowedActions 白名单拒绝写动作）；唯一写回是 Agent 工具的 Notion `create_page`（open-connector-tools.ts），无批量/结构化导出管线。
4. 桌面 UI：飞书入口 disabled；docs 类菜单不消费 `api-token` 通道；无导出 UI。
5. 内嵌 Nango 的 notion 代理配置钉在 `Notion-Version: 2022-06-28`（providers.yaml:15516），调用新 Markdown API 需要按请求覆盖版本头或升级定义。

---

## 2. 飞书开放平台调研

### 2.1 OAuth 授权（用户级）
- **授权链接**：`https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=cli_xxx&redirect_uri=...&scope=...&state=...`；用户同意后回调带 `code`+`state`。scope 需含 `offline_access` 才会下发 refresh_token（[获取授权码](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code?lang=zh-CN)、[浏览器网页接入指南](https://open.feishu.cn/document/sso/web-application-end-user-consent/guide?lang=zh-CN)）。
- **换 token（v2）**：`POST /open-apis/authen/v2/oauth/token`，标准 OAuth2 字段（grant_type/client_id/client_secret/code/redirect_uri）（[Get user_access_token (v2)](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token)）。
- **时效（2026-09-02 评审修正）**：授权码 5 分钟一次性；`user_access_token` 与 `refresh_token` 的有效期**官方现行文档只给示例并注明"非固定值，务必以响应体实际值为准"**——uat 示例 7200s（约 2 小时），refresh_token 示例 **604800s（7 天，不是历史版文档的"约 30 天"）**；**刷新即轮换**（旧的立即失效，防重放，重放会报错）（[刷新 v2](https://open.feishu.cn/document/authentication-management/access-token/refresh-user-access-token?lang=zh-CN)、[旧版时效说明](https://open.feishu.cn/document/historic-version/authen/create-3?lang=zh-CN)）。刷新调度与"授权失效"文案一律以 `refresh_token_expires_in` 实际返回为准，不得硬编码任何天数。
- **权限点（调用云文档 API 需要）**：
  - 读：`docx:document:readonly`（查看新版文档）、`drive:drive:readonly`（查看云空间所有文件）
  - 写/导出：`docx:document`（编辑）、`docs:document:import`（导入任务）、`docs:document:export` 或 `drive:export:readonly`（导出任务）、`drive:drive`（全量云空间读写，可作兜底）
  - wiki：`wiki:wiki:readonly` 系
  - **生效流程**：开发者后台 → 开发配置 → 权限管理 → 开通权限 → **创建版本发布**（[申请 API 权限](https://open.feishu.cn/document/server-docs/application-scope/introduction?lang=zh-CN)）。企业自建应用发布一般仅需本企业管理员审批（可配免审），**不需要商店审核**——团队内部场景建议自建应用；商店应用才走平台审核。
- `user_access_token` 模式下文档权限**跟随用户**（用户可见的文档应用即可见），比 tenant token 少一层"添加文档应用"的授权摩擦，是导入场景的正确选择。

### 2.2 文档发现
- **个人云空间**：`GET /drive/explorer/v2/root_folder/meta` 取根 token → `GET /drive/v1/files?folder_token=...`（page_token/page_size/order_by 分页）（[文件夹概述](https://open.feishu.cn/document/docs/drive-v1/folder/folder-overview?lang=zh-CN)、[根目录元数据](https://open.feishu.cn/document/server-docs/docs/drive-v1/folder/get-root-folder-meta?lang=zh-CN)）。
- **知识库（团队文档主战场）**：`GET /wiki/v2/spaces` → `GET /wiki/v2/spaces/:space_id/nodes`（node_token 树）→ 节点的 **`obj_type=docx` 时 `obj_token` 即 document_id**，转 docx API 读写（[获取知识空间节点信息](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space-node/get_node?lang=zh-CN)、[知识空间列表](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space/list?lang=zh-CN)）。节点信息含编辑时间，可做增量水位。

### 2.3 读取正文（导入方向）
- `GET /docx/v1/documents/:document_id/blocks`：分页返回**全部块的富文本结构**，5 QPS（[获取文档所有块](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/list?lang=zh-CN)）。块类型枚举：Text=2、Heading1~9=3~11、Bullet=12、Ordered=13、Code=14、Table=31 等（[块数据结构](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/data-structure/block)）。**这是结构化导入的唯一正确路径**，需自建 blocks→Markdown 转换器（成熟参考：[feishu-pages](https://github.com/yangzupan/feishu-pages) 覆盖标题/列表/代码块/表格/高亮块/分栏）。
- `GET /docx/v1/documents/:document_id/raw_content`：纯文本，5 QPS（[文档纯文本](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/raw_content?lang=zh-CN)）——现有 feishu-wiki 用的就是它，结构丢失，只适合兜底/摘要。
- **Markdown 直接读取（重要，2026-09-02 评审修正端点归属）**：公开的 docs-v1 [Get docs content](https://open.feishu.cn/document/docs/docs-v1/get?lang=zh-CN)（`GET /open-apis/docs/v1/content`）确实直接返回**新版文档的 Markdown 格式内容**；**但**官方 lark-cli 的 `docs +fetch`（v2）与 open-connector 的 `fetch_document` 动作底层走的**不是**这个接口，而是**未公开文档的 `POST /open-apis/docs_ai/v1/documents/:token/fetch`**（lark-cli 源码 docs_fetch_v2.go 与 open-connector shared/docs-runtime.ts 均可证；open.feishu.cn 检索不到该端点的公开文档；`--api-version` 现已是隐藏兼容 flag，新版默认即 v2）。outline/section/range/keyword 局部读取与 `revision_id` 只在这个 docs_ai 端点上可用。两条路径各有硬限制：docs-v1 /content 权限为 `docs:document.content:read`、**内容超 10MB 报 2889925**、仅支持 docx；docs_ai 端点无公开契约（行为/配额/存续无承诺）。**导入方向仍应优先用 provider 的 `fetch_document`**（一次调用、官方映射保真、请求量小），但必须把未公开端点依赖列为显式风险（§5.8）并准备三级兜底：`fetch_document` → docs-v1 /content（10MB 内）→ blocks 分页自转；大文档/高块数行为列入 §5 待实测项。
- **导出任务 API 不能用于导入**：仅支持导出为 Word/Excel/PDF/CSV（docx 类型只有 docx/pdf），**无 Markdown**（[创建导出任务](https://open.feishu.cn/document/server-docs/docs/drive-v1/export_task/create?lang=zh-CN)）。桌面端"下载为 Markdown"是客户端功能，API 不可用。
- 图片/附件：block 内资源 token 需经 drive media 下载接口取回；导入时应立即下载落入 files 模块（外部 URL 均短时效）。

### 2.4 写入（EverRoom → 飞书导出）
三步异步流程（[导入文件概述](https://open.feishu.cn/document/server-docs/docs/drive-v1/import_task/import-user-guide?lang=zh-CN)）：
1. `POST /drive/v1/files/upload_all`（或 media/upload_all）上传 `.md` 源文件拿 file_token（**token 5 分钟有效**、文件 ≤20MB）；
2. `POST /drive/v1/import_tasks`：`{file_extension:"md", file_token, type:"docx", file_name, point:{mount_type:1, mount_key:"目标文件夹token"}}`（[创建导入任务](https://open.feishu.cn/document/server-docs/docs/drive-v1/import_task/create?lang=zh-CN)，100 次/分钟，支持 user_access_token）；
3. 轮询 `GET /drive/v1/import_tasks/:ticket` → 成功后返回新文档 token。
- import_task 路径**只会创建新文档，不存在覆盖面**——与"不覆盖已有内容"的验收标准天然契合。
- **原地更新（第二条写路径，2026-09-02 评审按 lark-cli v1.0.84 实测修正）**：`docs +update` 的命令集是 **8 种**——`str_replace`（文本定位替换；markdown 模式下 pattern 可多行匹配）/ `block_delete` / `block_insert_after` / `block_copy_insert_after` / `block_replace` / `block_move_after`（block_id 定位的块级操作，删除支持逗号分隔批量）/ `append` / `overwrite`（官方标注慎用：整页替换可能丢无关富内容）。**没有**"replace_range 按标题整节替换"这类模式（早期 7 模式枚举已不成立）——节粒度更新需组合编排：`+fetch --scope outline/section` 拿 block_id → `block_replace`/`block_insert_after`。默认载荷格式是 **DocxXML**，markdown 是 `--doc-format markdown` 选项；`--revision-id` 支持乐观并发。局部更新保留原有媒体、评论、协作历史；大文档返回异步 `task_id` 轮询。open-connector 的 `update_document` 动作与该命令集对齐（command 枚举 replace_text/delete_blocks/insert_after/copy_after/replace_block/move_after/overwrite/append，异步时返回 taskId/pollAfterMs）。底层为公开 OpenAPI（写操作需 `docx:document.block:convert` 权限做服务端 markdown→blocks 转换，[社区踩坑记](https://juejin.cn/post/7611047795055624244)）。限制：图片/画板/电子表格/多维表格等内容以 token 形式存储，**读出后无法原样写回**，更新时要避开这些区域；写入受应用级 3 QPS + **单篇文档 3 QPS** 双限频约束（§2.6）。
- `file_extension` 必须与实际上传后缀严格一致（`md`≠`markdown`≠`mark`，否则 1069910）。

### 2.5 事件订阅（可选加速）
- `drive.file.edit_v1`（文件编辑）、文件已读、权限申请等事件（[云文档事件订阅](https://open.feishu.cn/document/server-docs/docs/drive-v1/event/subscribe?lang=zh-CN)、[事件概述](https://open.feishu.cn/document/server-docs/event-subscription-guide/overview?lang=zh-CN)）；事件订阅支持 **Webhook 与长连接**两种模式——桌面场景若要事件推送只能长连接，但复杂度高，**建议 V1 用轮询 + 编辑时间水位**，事件留作优化项。

### 2.6 限流与错误码
- 频率：blocks/raw_content 5 QPS、block 写 3 QPS、导入/导出任务 100 次/分钟、事件订阅 10 次/分钟；超限 429（导入任务错误码 1069923）。
- 关键错误码：
  - `99991663` token 无效/过期（[官方排查](https://open.feishu.cn/document/faq/trouble-shooting/how-to-fix-99991663-error)）→ 刷新或重授权；
  - `99991672` 应用未开通该 API 权限 → 引导管理员开权限并发布版本（[排查](https://open.feishu.cn/document/faq/trouble-shooting/how-to-fix-the-99991672-error?lang=zh-CN)）；
  - `1069902` 无文档阅读/编辑权限（user token = 该用户无权限；文案应指引到文档分享）；
  - `1069908` 挂载点文件夹无权限（导出目标文件夹不可写）；
  - `1069906` 文档已删除、`1069913` 上传 token 过期（重上传即可）、`1069909` 超 20MB。

### 2.7 lark-cli（官方 CLI）参照分析

[lark-cli](https://github.com/larksuite/cli) 是飞书/Lark **官方**开源的 CLI（Go 实现、MIT、`npx @larksuite/cli` 安装、200+ 命令、26 个 Agent Skills；OpenClaw 上的飞书官方插件底层就是它）。它对我们方案的四点直接参照：

**① 授权模式（化解 M1 最大风险）**
- `config init` **一键创建一个新应用**（也可复用已有应用）——"依赖飞书应用创建"这个门槛官方已有产品化方案。
- `auth login`：TUI 交互选 scope / `--recommend` 常用权限集 / `--scope` 精确指定 / `--domain` 按业务域增量授权；**`--no-wait` 立即返回授权 URL、`--device-code` 之后恢复轮询**——一种不需要本地 redirect URI 的授权形态，direct 引擎方案 B 可直接照抄这个模式，Nango 127.0.0.1 回调的验证风险被降级为"二选一"。
- 凭据存 OS keychain；`--as user|bot` 身份切换；多 profile 多应用并发安全。

**② 文档读写**：读 = `docs +fetch --doc-format markdown`（局部读取见 §2.3；底层为未公开的 docs_ai 端点）；写 = `docs +update` 8 命令（§2.4，v1.0.84 实测枚举）。载荷默认 **DocxXML**、markdown 是选项——"读写都以 markdown 为主载荷"的说法过强，准确表述是"markdown 是受支持的一等载荷之一"。

**③ 双向同步模型（官方印证 §4.4 的方向状态机）**
`drive +sync`（本地目录 ↔ Drive 文件夹）的做法：
- `+status` 先做 diff：**默认 SHA-256 精确内容比较**，`--quick` 才退化为修改时间近似；
- `+sync` 把每个文件判为三态：`new_remote`（拉取）/ `new_local`（推送）/ `modified`（**按显式策略 `--on-conflict=remote-wins|local-wins|keep-both|ask` 处理，绝不自动合并**）；
- **不删除两端多余文件**（删除不传播）；只同步 `type=file`，**跳过在线文档**。
与 §4.4"每对一个方向 + 冲突显式决策 + 删除不传播"完全同构——官方也没有做自动合并。

**④ Drive 原生 .md 文件（无损双向的另一形态）**
`lark-markdown` skill 对 Drive 里作为普通文件存储的 `.md` 提供 create / fetch / **overwrite / patch** / **diff（含版本历史比对）**——如果团队接受 `.md` 文件形态（而非在线 docx），飞书侧可获得真正的无损双向同步（整文件覆盖语义 + 版本历史兜底）。

**工程细节可抄**：同一目标文件夹的批量导入**必须串行**（并发冲突错误 232140101/232140100/233523001，失败重试 ≤3 次且间隔数秒）；异步任务统一 `+task_result` 查询；wiki URL 用 `+inspect` 解包出 obj_token；错误契约 stdout（成功）/stderr（错误）分离、错误码透传上游 OpenAPI code。

**复用边界（2026-09-01 最终决策）**：**连接器统一到 OpenConnector（`oo` CLI）路线，内嵌 Nango 弃用**（退役本身是独立工作项）。不引入 lark-cli 作为运行时依赖。lark-cli 的价值定位为：① 调研期用它的 skills 文档与 MIT 源码确认底层公开 API 的行为（markdown 读、定位更新、异步任务、并发约束）；② 其授权模式（`--no-wait`/`--device-code` 轮询）与"一键创建应用"产品思路作为参照。

---

## 3. Notion 调研

### 3.1 公共连接 OAuth 与 capabilities
- 授权 URL：`https://api.notion.com/v1/oauth/authorize?client_id=...&redirect_uri=...&response_type=code&owner=user&state=...`（[Authorization 指南](https://developers.notion.com/guides/get-started/authorization)）。**没有 scope 参数**——权限 = 开发者后台配置的 **connection capabilities** + 用户在 page picker 里勾选共享的页面（父页面带动全部子页面）。
- capabilities（[官方说明](https://developers.notion.com/reference/capabilities)）：本需求需要 **Read content + Insert content + Update content**（建页还需 insert property；可在后台一并勾上）。用户信息能力选"不含邮箱"即可。
- 换 token：`POST /v1/oauth/token`（HTTP Basic：client_id:client_secret；body `grant_type=authorization_code`+code+redirect_uri），返回 `access_token`+`refresh_token`+`bot_id`+`workspace_id/name`+`owner`（[Create a token](https://developers.notion.com/reference/create-a-token)）。refresh：`grant_type=refresh_token`，**返回新的 access+refresh（轮换）**（[Refresh a token](https://developers.notion.com/reference/refresh-a-token)）。
- 文档未标明 access_token 有效期（历史上长期有效），但按标准做法：**401 → 先 refresh → 仍失败 → 引导重授权**。OAuth 错误码：`invalid_grant`（code/refresh 失效、被撤销、capability 变更）、`invalid_client` 等（RFC 6749 语义）。
- ⚠️ **capability 变更会使存量授权的 refresh_token 失效（invalid_grant），用户必须重新授权**——上线前必须定稿 capabilities，之后不再改动。
- ⚠️ capability 永远≤用户权限：用户失去某页编辑权后连接对该页自动降为只读。
- API 版本：当前最新 `2026-03-11`（block 操作与 trash 语义有破坏性变更，[升级指南](https://developers.notion.com/guides/get-started/upgrade-guide-2026-03-11)）。仓库 Nango notion 代理钉在 `2022-06-28`，调用 Markdown API 需按请求覆盖 `Notion-Version` 头。

### 3.2 官方 Markdown 内容 API（本调研最重要发现）
（[Working with markdown content](https://developers.notion.com/guides/data-apis/working-with-markdown-content)）Notion 现支持以"增强 Markdown"整页读写，**完全绕过 block JSON 转换**：

| 操作 | 端点 | 能力要求 | 要点 |
|---|---|---|---|
| 读 | `GET /v1/pages/:id/markdown` | read_content | 单次返回整页 markdown；文件 URL 自动预签名；**约 20,000 块截断**：`truncated=true` + `unknown_block_ids`，可带块 ID 迭代补拉；权限不可见的子块同样标记 `<unknown>` |
| 建页 | `POST /v1/pages` + `markdown` 参数 | insert_content(+insert_property) | 与 `children` 互斥；省略标题时首个 `# h1` 自动作页标题 |
| 更新 | `PATCH /v1/pages/:id/markdown` | update_content | 命令式 union：`replace_content`（整页替换，推荐）/ `update_content`（搜索替换，`old_str` 须唯一否则 validation_error）/ legacy insert/replace_range；**默认拒绝删除子页面与子数据库**（需显式 `allow_deleting_content:true`）——平台级防覆盖保险 |

- **大写入异步化**：`allow_async:true` → `202` + `async_task`（`status_url` 轮询，状态 queued/running/retrying/succeeded/failed；retrying 按 `poll_after_seconds` 等待）。导出长文必须走这条路径。
- 不支持的块类型在输出中呈现为 `<unknown url="..." alt="块类型"/>`——导入时保留占位与原链接，保证"主要内容完整"且可溯源。
- 对导入方向的意义：替换现有 notion.ts 的 blocks 分页拉取（1 次调用 vs N 次分页），在 3 rps 限流下收益显著；`last_edited_time`（search/页面属性）仍作增量水位。

### 3.3 文档发现、分页、webhooks
- 发现共享页面：`POST /v1/search`（分页 page_size≤100）（[Search](https://developers.notion.com/reference/post-search)）；页面被取消共享后 API 返回 404 而非从 search 消失的即时保证，需容错。
- Webhook 已有（页面/数据库增删改事件，payload 只含 ID 需回查，[Webhooks](https://developers.notion.com/reference/webhooks)），但需要**公网回调端点**，桌面应用不适用——V1 用轮询，事件留作服务端部署形态的优化。

### 3.4 限流与错误码
- 平均 **约 3 请求/秒/连接**；429（`rate_limited`）带 `Retry-After` 头，另有 529 过载（[Request limits](https://developers.notion.com/reference/request-limits)、[Status codes](https://developers.notion.com/reference/status-codes)）。客户端应主动节流排队 + 退避。
- 关键错误码：`401 unauthorized`（token 失效→refresh→重授权）；`403 restricted_resource`（capability 不足或用户权限降级）；**`404 object_not_found`（页面未共享给连接——Notion 最常见的"权限不足"形态，错误消息里带连接名，文案要引导去 Notion 页面 ··· 菜单添加连接）**；`409 conflict_error`；`429 rate_limited`。

---

## 4. 方案设计

> **路线决策（2026-09-01 用户确认，最终版）**：**连接器统一到 OpenConnector（`oo` CLI）路径，内嵌 Nango 弃用**。新能力全部落在：① 上游 [oomol-lab/open-connector](https://github.com/oomol-lab/open-connector) 的 provider 层（仓库以 tarball 固定 commit `5719a69`/v1.3.5 引入，desktop 的 `build/open-connector`），② 网关 CLI 路径（`service.ts`/`document-sync.ts`，`/v1/cli-connectors/*`），③ 桌面 cliConnector IPC + open-connector supervisor。**关键现状（已核实，2026-09-02 评审对 pin 源码复核）**：feishu provider 已声明式实现飞书 OAuth 用户授权（`authen/v1/authorize` + `authen/v2/oauth/token` JSON body + `offline_access`），且**导入与导出所需动作全部就位于当前 pin（`5719a69`/v1.3.5）**——除 7 个内联基础动作外，docs/wiki/drive/markdown/file 全套 shared 动作以 `...createFeishu*Actions()` 展开注入（`fetch_document`/`create_document`/`update_document`/`search_documents`/`list_wiki_*`/`list_drive_files`/`submit_drive_import`/`get_drive_task_status` 等，完整结论见 §0）；notion provider 已含 `retrieve_page_markdown`/`update_page_markdown`/`create_page` 等 Markdown API 动作。Nango 路径（`/v1/nango-connectors/*`、sync-providers）与 direct 引擎的 feishu-wiki 不再投入，随退役处理。

### 4.1 总体数据流
```
导入（复用现有管线，零新增存储）：
  Feishu OAuth ──┐
                 ├→ SyncProvider.pull (NormalizedDocument: markdown)
  Notion OAuth ──┘        ↓
           domain-projection 幂等 upsert（唯一键+contentHash 跳过）
                        ↓
           ConnectorMarkdownService（双向 hash 幂等）→ ingest_events → rooms/memory/files

导出（新增）：
  EverRoom 文档提交/用户触发
        ↓ connector_export_targets（映射+lastExportedHash+remoteBaseline）
        ↓ export outbox（lease + 退避，复用 markdown-service 模式）
        ├→ 飞书：upload .md → import_tasks(md→docx) → 轮询 ticket → 新文档 token
        └→ Notion：POST /v1/pages(markdown) [或 PATCH replace_content]（allow_async 大文）
```

### 4.2 授权模块（OpenConnector 统一路线）
- **授权全部由 OpenConnector（oo CLI）承担**：provider 以声明式定义授权端点与 scopes——上游 feishu provider 已配置 `authen/v1/authorize` + `authen/v2/oauth/token`（JSON body、client_secret_post）+ `offline_access`，**飞书 OAuth 用户授权在上游已实现**；token 生命周期/刷新由 oo CLI 自管，凭据经 `open-connector-secret-store.ts`（Electron safeStorage 加密）注入 `OO_CONFIG_DIR/OO_DATA_DIR`。授权发起与状态查看沿用桌面 open-connector 既有流程（cliConnector IPC）。
- **要做的是权限审计（不是补 scopes，2026-09-02 评审修正）**：feishu provider 的 OAuth scope 列表**由全部动作的 `providerPermissions` 自动派生**（definition.ts：`[offline_access, ...new Set(actions.flatMap(a => a.providerPermissions))]`）——由于全套动作已在 pin 里，派生集已含 `docx:document:create`/`docx:document:write_only`/`docs:document:import`/`docs:document:export`/`search:docs:read`/`wiki:node:read`/`wiki:space:read`/`drive:file:upload` 等（§2.1 清单里的 `docx:document`/`drive:drive:readonly`/`wiki:wiki:readonly` 是不同粒度的同义权限，逐动作核对即可）。剩余审计项：① `docs:document.content:read`（docs-v1 /content 的公开要求；docs_ai 端点实测账号以此权限可用、是否必需待 M1 验证）**不在当前派生集内**（`fetch_document` 声明的是 `docx:document:readonly`）——自建应用需在后台单独开通；② 派生机制意味着**新增任何动作 = 自动扩大授权面**，管理员审批页可见，需写入发布说明。
- 应用凭据走"用户自建应用"（app_id/secret 由用户或团队管理员在飞书后台创建后填入，同 lark-cli `config init` 的产品形态）；飞书后台的 redirect_uri 按 OpenConnector 授权机制配置（notion/gmail 同一套已跑通），M1 实测确认。
- **连接状态 UI**：连接卡片展示授权身份（feishu user profile / Notion workspace_name+owner.email）+ 最近 run；授权过期置 `needs_connection` 态（CLI 路径已有该 status），显式"重新授权"按钮，不影响其他连接。

**Notion**
- OpenConnector notion provider 动作已含 `retrieve_page_markdown` / `update_page_markdown` / `create_page` / `update_page` 等（上游已跟进 2026 Markdown API），**导入导出动作层零缺口**；需要做的是：① 开发者后台 capabilities 定稿为 Read+Insert+Update content（上线后不可再改，否则存量用户全体 invalid_grant）；② 确认 provider 请求使用的 `Notion-Version` 头是否已升到 2026-03-11。

### 4.3 导入管线（CLI 路径）
- **网关 CLI 路径扩展**：`service.ts` 托管作业 seed 列表（现仅 gmail/notion/googledrive）加 feishu；`document-sync.ts` 确定性文档作业扩展 feishu——复用 notion 的 reconcile→incremental 双作业模式（`last_edited_time`/飞书 `edit_time` 水位 + contentHash 幂等跳过）。
- **OpenConnector provider 动作已就位、无需扩展（2026-09-02 评审确认）**：markdown 获取用现成 `fetch_document`（注意底层为 docs_ai 端点，风险见 §2.3/§5.8），云空间发现用 `list_drive_files`、wiki 节点树用 `list_wiki_spaces`/`list_wiki_nodes`，导出写动作见 §4.4.6。网关工作 = 把这些动作接进 document-sync 作业；产出 markdown 后经 domain-projection → markdown-service → ingest 全链路照旧。
- **Notion**：网关 document-sync 从 blocks 拉取切到 provider 的 `retrieve_page_markdown`（`truncated`/`unknown_block_ids` 迭代补拉逻辑放网关侧）。
- 图片/附件：markdown 中的素材 token/预签名 URL 由执行器**即取即下载**入 files 模块，并按 §4.4.4 规范化后再算 contentHash。

### 4.4 双向同步与导出管线（全新，重点）

#### 4.4.0 总原则：不做"真双向合并"，做"每对一个方向"的状态机

真正的双向同步（两边都是工作区、随时编辑、自动 diff-merge）在这两个平台上**做不到安全**，原因硬性：

- **飞书的原地更新粒度受限**（2026-09-02 评审按 v1.0.84 实测修正）：原地更新命令族存在（str_replace / block_* / append / overwrite），可保留图片评论；但**没有"按标题整节替换"的单命令**——节粒度更新需 outline→block_id→block_replace 多步编排，且**整页级 overwrite 仍有损**（可能丢媒体与评论），图片/画板等以 token 存储的内容**读出后无法原样写回**。结论：**v1 飞书侧不做 sync_update，导出一律 create_copy**；节粒度 sync_update 连同其编排成本留 v2 评估。
- **Notion 有 `replace_content`（整页替换），但那是替换不是合并**：跨表示（markdown ↔ blocks）的三路合并每轮都是有损的，合并结果再写回会继续产生偏差。
- 两平台的"修改时间"都没有变更粒度信息（谁改的、改了哪个块），无法做可靠的增量归并。

替代模型：**每个文档对（EverRoom 文档 ↔ 外部页面）在映射表里有且只有一行，带一个 `direction` 字段**：

| direction | 权威方 | 行为 |
|---|---|---|
| `inbound`（默认，占绝大多数） | 飞书/Notion | 正常导入管线，EverRoom 侧是只读镜像；用户在 EverRoom 里编辑它 → 提示"该文档由 XX 同步控制，改动会被下次导入覆盖"，给出转 outbound / 断开 / 分叉三选项 |
| `outbound` | EverRoom | 导出建立的副本打镜像标记，**永不自动反向导入**；拉取时只观察远端 edited_time 用于冲突检测 |

这个模型恰好匹配团队场景的真实分布：文档主要产生在飞书/Notion，EverRoom 是聚合/记忆层，导出是"发布/分享副本"。需要两边日常编辑同一篇的文档是极少数，那类需求留给 v2（§4.4.7）。

#### 4.4.1 身份层：映射表

**新表 `connector_export_targets`**（gateway.sqlite，下一个迁移号）：

```
id, owner_id, document_id, service, connection_name,
external_id(远端 page/doc token), external_url,
direction(inbound|outbound), mode(create_copy|sync_update),
last_exported_hash, last_exported_md(基线 markdown，供 v2 三路合并),
exported_at, remote_edited_at(导出完成时远端自报的 edited_time),
local_synced_at(导入应用时本地基线),
status(active|conflict|orphaned|exporting), error,
created_at/updated_at
```

身份映射是双向同步唯一的**结构性防环手段**（内容去重靠不住——导出再拉回的文本和库里那份几乎必然不同）。所有方向判断都查这张表。

#### 4.4.2 回环阻断

拦截点放在**同步引擎消费 PullPage 之后、domain-projection 之前**（单一入口）：

```
pull 产出 NormalizedDocument{providerDocumentId, markdown, ...}
  → 查映射表 (service, connection, external_id = providerDocumentId)
     ├─ 无记录 → 正常投影+ingest（普通导入）
     ├─ direction=outbound（自己导出的镜像）
     │    → 不投影、不 ingest
     │    → 只比对远端 edited_time vs remote_edited_at：
     │       未变 → 无事；变了 → status=conflict（远端副本被人为修改）
     └─ direction=inbound → 正常投影（幂等 upsert 照旧）
```

这样"导出 → 被同步拉回 → 重复入库 → 再导出"的雪球在结构上不存在，且 outbound 副本的远端修改**顺便变成了冲突信号**（一份数据两个用途）。

#### 4.4.3 冲突：只检测、不自动合并

| 方向 | 检测信号 | 触发后 |
|---|---|---|
| outbound，mode=sync_update（仅 Notion） | 远端 `last_edited_time` > `remote_edited_at` 基线 | 不执行 replace_content，置 conflict |
| outbound，mode=create_copy | 同上 | 置 conflict（副本被人改了） |
| inbound | 本地文档更新时间/修订号 > `local_synced_at` 且远端 contentHash 也变了（双向都动过） | 置 conflict |

conflict 的 UI 永远是三选一：**以 EverRoom 为准**（outbound：Notion 覆盖远端 / 飞书另存新副本）/ **以远端为准**（拉回覆盖本地）/ **分叉另存**（断开映射，本地复制一份独立文档）。**任何选项都不是静默的**，对应验收标准"不覆盖已有内容"。

两个实现细节：
- 基线必须存**远端自报的时间**（Notion `last_edited_time`、飞书文档基础信息的 `edit_time`），不能存本地时钟——跨平台时钟不可比。
- 飞书 `edit_time` 是否会被评论/权限变更触发需要实测（Notion 的 last_edited_time 只反映内容编辑，可靠）；若飞书有噪声，退化为"拉取该文档内容做 hash 比对"（单文档成本可接受）。

#### 4.4.4 同步抖动（round-trip churn）——最容易被忽视的杀手

即使**没有任何人编辑**，"拉取→转换→哈希"如果不确定，会让每次同步都判定"内容变了"→ 无限重物化/重导出，几天内把平台配额和用户耐心耗光。三道防线：

1. **哈希前规范化层**（在 provider 产出 markdown 之后、contentHash 计算之前）：Notion Markdown API 返回的文件 URL 是**预签名的、带过期时间戳**——直接哈希必然每次不同，必须先替换成稳定资源 ID（图片在拉取时即下载入库，markdown 里引用本地稳定路径）；同理剥离/归一化所有时间戳类字段与空白差异。
2. **转换器纯函数 + 快照测试**：同一份 blocks 输入必须产出字节级相同的 markdown（feishu blocks→md、Notion markdown 归一化都要锁死；对象键序、转义规则都是坑）。
3. **contentHash 跳过链路照旧**：domain-projection 与 markdown-service 的双重 hash 幂等是现成的刹车，只要规范化层做对，它就生效。

#### 4.4.5 删除与并发

- **删除 v1 一律不自动传播**（破坏性操作无撤销）：远端删除 → 映射置 orphaned，EverRoom 侧保留内容并提示；本地删除 outbound 文档 → 映射置 orphaned，远端副本保留（Notion 可后续提供"确认删除远端"，走 2026-03-11 的 trash 语义，显式按钮）。
- **并发**：导入（sync scope lease）与导出（outbox lease）已是各自串行；同一连接的导入与导出在**同一个 worker 里串行执行**（每连接单线程），任何文档对上的操作天然全序，不存在"正在导出时被导入覆盖"的窗口。

#### 4.4.6 导出执行

- **导出 outbox**：复用 markdown-service 的 lease/退避（[30s,2m,10m,1h]，上限 10 次）模式反方向实现；导出执行器是独立服务，**不进入同步作业的 allowedActions 体系**（导入作业保持只读白名单不动摇）。
- **mode 语义**：
  1. `create_copy`（默认）：飞书 import_task 建新文档 / Notion `POST /v1/pages` 建新页——永不触碰已有内容；
  2. `sync_update`（**仅 Notion，v1**）：过 §4.4.3 基线检查后执行 `replace_content`，`allow_deleting_content` 保持默认 false（平台级子页面保护）。飞书 sync_update **v1 明确不做**：`docs +update` 无"按标题整节替换"命令（§2.4 实测枚举），节粒度更新需 outline→block_id→block_replace 多步编排，复杂度与出错面不匹配首期收益——飞书导出一律 create_copy，节粒度原地更新留 v2 评估。
- **大文档**：Notion `allow_async:true` + async_task 轮询；飞书 ticket 轮询；都在 outbox 内以租约推进，进程重启可续。
- **幂等**：Notion 建页无服务器幂等，靠 outbox 状态机（pending→exporting[带远端任务句柄]→done）保证 at-least-once；句柄存在即续轮询而非重发，崩溃窗口内最坏重复一页，UI 提供按标题去重提示。

#### 4.4.7 v2 升级路径（真双向，Notion only）

映射表已保存 `last_exported_md`（上次同步点的基线 markdown）。真双向 = 经典"无 merge 的 fetch"模型：
- 本地当前 md、远端当前 md、基线 md 做 **diff3 三路合并**：不重叠的改动自动合，重叠段置 conflict；
- 合并结果 EverRoom 侧直接落，Notion 侧 `replace_content` 写回，更新基线；
- 飞书原地更新无安全的整页替换语义（§2.4），即便 v2 也只评估节粒度更新，主体维持副本模型。

这个路径每个文档对等价于一个微型 Git，成本可控，但 v1 明确不做——先把方向模型和防环跑稳。

### 4.8 路线切换期的动工顺序（OpenConnector 未就位时，2026-09-01 补）

前提：新 OpenConnector 替换 Nango 尚需时间。按"是否绑路线"拆分本需求的工作项：

**立即可动（与 Nango/OpenConnector 之争完全无关）**

1. **平台外部流程（周期最长，今天就该发起）**：
   - 飞书：开发者后台创建企业自建应用 → 申请权限点（§2.1 清单）→ 配置 redirect_uri → 发布版本过管理员审批。审批链路是全需求最长的外部依赖。
   - Notion：开发者后台创建公共连接 → **capabilities 一次定稿**（Read+Insert+Update content，之后不可改）→ 配置 redirect URI。
2. **导出域模型与状态机（gateway 侧，路线无关）**：`connector_export_targets` 迁移 + export outbox（lease/退避/幂等）+ §4.4 方向状态机 + 冲突检测 + 防回环拦截点 + `/v1/connector-exports*` REST。执行器面向"平台客户端抽象接口"编程，Notion/飞书实现后插。
3. **双向同步纯逻辑组件**：markdown 规范化层（预签名 URL→稳定资源 ID、时间戳剥离、空白归一）+ contentHash、基线比较、冲突三选一流——纯函数 + 快照测试，零平台依赖，是防抖动/防覆盖的地基。
4. **Notion 全链路（现有 CLI 路径已够用，不必等）**：vendored open-connector 1.3.5 的 notion provider 已含 `retrieve_page_markdown`/`update_page_markdown`/`create_page`，网关 CLI 路径 notion 托管作业也在运行——**导入切 markdown 拉取（M3）与导出 Notion（M4，执行器经现有 open-connector 动作调用机制）现在就能做**，且全部代码在目标路线上、零弃置。
5. **飞书 API spike（用第 1 项的应用凭据 + 一次性脚本）**：实测 docs-v1 markdown 读、`docs +update` 定位更新、import_task、`edit_time` 语义（冲突检测的关键前提）、限流。产出即未来 feishu provider 动作的实现规格；lark-cli 可作对照客户端。
6. **桌面导出 UI 骨架 + i18n 错误矩阵文案**：挂在导出 REST 上，与路线无关。

**必须等产品层路线决策的（技术上有 finer 切法，见下）**

- feishu provider 接入（原"动作扩展 + 最小 fork"项，2026-09-02 评审作废）：全套动作与派生 scopes 已确认在 pin（`5719a69`/v1.3.5）就位，**无需 fork、无需新增动作**——"切换期是否维护 fork"的决策不再存在，飞书导入导出随时可在现有 pin 上接入。
- 飞书 OAuth 的产品化接入（授权 UI、账号管理、连接状态）——授权机制在 provider 定义里已实现，接入走现有 cliConnector 通道即可。
- Nango 存量连接迁移（独立工作项）。

**推荐首期切法（2026-09-01 补，2026-09-02 修订）：单向导入先行。** 双向的冲突/防覆盖/防回环/outbox/映射表全部延后，保留：规范化层 + contentHash（防抖动仍需要）、增量水位、错误矩阵。Notion 侧零等待（现有 CLI 路径 + vendored provider 已有 markdown 动作）；飞书侧只等自建应用审批（provider 动作已在 pin 就位，无需 fork）。

### 4.9 Spike 实测记录（2026-09-01，lark-cli v1.0.84）

用 lark-cli 把本报告发布为飞书文档并回读，全链路实测结论：

- **建文档**：`docs +create --doc-format markdown --content @file --title` 一次成功（约 2.5 万字、大量表格/代码块/链接的中文文档），落在"我的空间"根目录，返回 `document_id` + `revision_id=5`（导入内部经历多次块修订）。
- **回读**：`docs +fetch --api-version v2 --doc-format markdown` **单次调用**取回全文，标题、表格、引用块、链接、加粗、代码全部完整——验证 §2.3"Markdown 直读替代自建转换器"的判断（2026-09-02 评审注：`--api-version` 已是隐藏兼容 flag，新版默认即 v2；该路径底层为**未公开的 docs_ai 端点**，风险与兜底见 §2.3/§5.8）。
- **授权**：token `needs_refresh` 状态下首次调用自动刷新成功（refresh token 有效期内）；实测账号的 scope 集覆盖 `docx:document:create`/`docs:document.content:read`/`docs:document:import`/`wiki:*`/`search:docs:read`/`offline_access`。2026-09-02 评审注：其中除 `docs:document.content:read` 外均已在 provider 派生 scope 集内（§4.2）——该权限点是当前唯一确认的开通缺口，需自建应用后台开通并在 M1 验证其对 docs_ai 端点的必要性。
- **规范化实证**：回读的 markdown 与发送版存在**表示层差异**——表格分隔线 `|---|` 变 `|-|`、引用块行尾多空格等。直接证实 §4.4.4：**contentHash 必须算在"规范化之后"的形态上，绝不能假设"发出去什么读回来什么"**；规范化参照形态应取"回读形态"（平台的规范化输出是稳定的）。
- 实测文档：https://vyi-tech.feishu.cn/docx/RLrpdlFGEoNhJExbkxucS3jhnMc（本报告 2026-09-01 快照）。

### 4.5 提示与重试矩阵（验收标准 4 的直接答案）

| 场景 | 飞书信号 | Notion 信号 | 用户提示（要点） | 自动处理 |
|---|---|---|---|---|
| 授权失效 | 99991663 / refresh_token 过期（以响应体 `refresh_token_expires_in` 实际值为准，官方示例 7 天且"非固定值"） | 401 unauthorized / invalid_grant | "飞书授权已过期，请重新授权"（跳授权流） | 作业置 needs_connection 暂停；其余连接不受影响；UI 徽标 |
| 权限不足（页面/文档级） | 1069902（用户无该文档权限） | 403 restricted_resource | 指明具体文档 + "在飞书分享中授予访问 / 在 Notion 页面 ··· 添加连接"步骤文案 | 单文档跳过并计入 run.failed，不中断批次；连续 N 次后从范围摘除并提示 |
| 页面未共享（Notion 特有） | — | 404 object_not_found | "该页面未与 EverRoom 共享"（消息含连接名，直接透出） | 同上，标记该页待重授权范围 |
| 应用权限未申请 | 99991672 | — | "管理员尚未开通 XX 权限"（面向管理员） | 不重试，人工介入 |
| 限流 | 429 / 1069923 | 429 + Retry-After / 529 | 不打扰用户；同步详情可见"因平台限流等待" | 客户端节流（Notion ≤3rps 队列；飞书按 3–5 QPS/接口、任务 100/min）+ outbox 退避 |
| 上传素材过期 | 1069913 | — | 无感 | 重上传后重建导入任务 |
| 目标文件夹不可写 | 1069908 | 404/403（父页面不可写） | "导出目标不可写，请检查分享或另选位置" | 导出条目置 conflict，可改目标重试 |
| 远端被他人修改 | doc edit_time > 基线 | last_edited_time > 基线 | 冲突三选一（覆盖/断开/另存） | 不自动覆盖 |
| 文档被删除 | 1069906 | 404 object_not_found（持续） | "源文档已在平台删除，是否移除映射" | 映射置 orphaned；EverRoom 侧内容保留 |

### 4.6 代码改动清单（按模块）
- **open-connector（零 provider 改动，2026-09-02 评审修正）**：feishu 动作（markdown 读/发现/`update_document`/`submit_drive_import` 等写动作）与 scopes 派生集已在 pin（`5719a69`/v1.3.5）就位，**不 fork、不升 pin、不新增动作**；唯一 provider 侧工作是 §4.2 的权限审计（含 `docs:document.content:read` 开通确认）。若上游后续把 `fetch_document` 的 requiredScopes 对齐 docs_ai 实际所需，随常规 pin 升级带入即可。
- **gateway/cli-connectors**：`service.ts` 托管作业 seed 加 feishu；`document-sync.ts` 扩展 feishu + notion 切 markdown；agent-tools 按需暴露新动作。
- **gateway/export（新模块，与路线无关）**：export-targets 表 + 迁移、export-outbox 服务、导出执行器（经 oo CLI 调 open-connector 动作：Notion 用现成 `create_page`/`update_page_markdown`，飞书用新增写动作）、REST（`/v1/connector-exports*`）。
- **desktop**：连接/授权入口走 cliConnector 通道（ConnectorConsolePage/ConnectorSyncPage 现成骨架）、导出对话框（目标选择 + mode + 冲突三选一 UI）、bridge/IPC/preload 按现有模式扩展；Nango 相关 UI 随退役移除（独立工作项）。
- **i18n**：en-US/zh-CN 新增 connector 相关文案（错误矩阵逐条）。

### 4.7 里程碑建议
1. **M1 OpenConnector 路线打通**：provider 现状审计（动作清单/scope 派生集 vs 自建应用实际开通权限，重点确认 docs_ai 端点相关的 `docs:document.content:read`）→ 实测飞书 OAuth 授权闭环（含飞书后台 redirect_uri 配置、权限审批链路）→ 连接状态 UI。（原"fork/pin 升级 + scopes 补齐"工作项经 2026-09-02 评审确认不存在。）
2. **M2 飞书云文档导入**：provider 补 markdown 读 + drive/wiki 发现动作；网关 document-sync 扩展 feishu + edit_time 增量水位。
3. **M3 Notion 导入收尾**：网关切 `retrieve_page_markdown`、capabilities 定稿重授权一次、确认 Notion-Version。
4. **M4 导出 Notion**：映射表 + outbox + create_copy（provider 动作已有，零 provider 改动）+ allow_async。
5. **M5 导出飞书**：写动作 provider 已就位（`submit_drive_import`/`get_drive_import`/`get_drive_task_status`，零 provider 改动）——工作 = 网关导出执行器接入 import_task 流程 + 防回环；sync_update 不做（§4.4.6，v1 仅 create_copy）。
6. **M6 错误矩阵 UX + 冲突流 + 验收**（逐条对照四条验收标准）。

---

## 5. 风险与待验证项
1. **OpenConnector 版本策略（2026-09-02 修订）**：上游以 tarball 固定 commit（`5719a69`/v1.3.5）引入；feishu 导入/导出所需动作与派生 scopes 已确认在该 pin 就位（§0），**当前无需 fork 也无需升 pin**——常规升级随上游发布节奏走，升级时重跑一遍动作/scope 审计即可。飞书 OAuth 回调沿用 OpenConnector 既有授权机制（notion/gmail 同一套已跑通），但飞书后台 redirect_uri 配置与权限审批链路仍需 M1 实测。
2. **Nango 退役是独立迁移工作项**：存量 gmail/outlook/google-*/notion 连接需迁到 OpenConnector 或等上游支持，不阻塞本需求，但架构假定其最终下线；期间两条路径并存（README.md 的边界约定仍有效）。
2. **飞书应用创建与权限审批**：自建应用 + 管理员开权限 + 版本发布即可，无需商店审核；但企业若开审批流，权限生效有时滞（依赖项已列入需求）。
3. **Notion capability 定稿即锁死**：上线后改动 = 全体用户重授权；把 Read+Insert+Update content 一次定到位。
4. **Notion 3 rps**：批量导入大空间时是主要吞吐瓶颈；Markdown API 单页单请求已是最优，必要时并发=1 串行 + 节流队列。
5. **结构保真度边界**：飞书高亮块/分栏、Notion 部分块类型无对应 Markdown 表示——按"占位+原文链接+导入报告说明降级项"验收，不追求 100% 视觉等价。
6. **防回环**是双向同步最易翻车点：export_targets 的 mirror 标记必须在第一个导出 MVP 里就落地，不能后补。
7. 仓库现状补充：Nango 路径的 feishu-wiki（api-token、raw_content 纯文本）与 notion.ts（blocks 拉取）不再投入，随 Nango/direct 退役处理；Notion-Version 升级问题转移到 OpenConnector notion provider 侧确认。
8. **markdown 主读路径依赖未公开端点（2026-09-02 评审新增）**：provider `fetch_document` 与 lark-cli `docs +fetch` 底层均为 `POST /open-apis/docs_ai/v1/documents/:token/fetch`，open.feishu.cn 无公开文档（行为/配额/存续无契约）；公开兜底 docs-v1 `GET /open-apis/docs/v1/content` 有 **10MB 上限**（超限报 2889925）、权限 `docs:document.content:read`（**不在 provider 派生 scope 集内**，需自建应用单独开通）、仅支持 docx。对策：M2 实测大文档（>10MB/高块数）行为；导入执行器按 `fetch_document` → docs-v1 /content → blocks 分页自转三级兜底；`docs:document.content:read` 列入自建应用权限开通清单。

## 6. 主要参考链接
- 飞书 OAuth：[授权码](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code?lang=zh-CN) · [v2 换 token](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token) · [刷新 v2](https://open.feishu.cn/document/authentication-management/access-token/refresh-user-access-token?lang=zh-CN)
- 飞书文档：[blocks 列表](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/list?lang=zh-CN) · [raw_content](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/raw_content?lang=zh-CN) · [块数据结构](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/data-structure/block) · [wiki 节点](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space-node/get_node?lang=zh-CN)
- 飞书导入/导出：[创建导入任务](https://open.feishu.cn/document/server-docs/docs/drive-v1/import_task/create?lang=zh-CN) · [导入概述](https://open.feishu.cn/document/server-docs/docs/drive-v1/import_task/import-user-guide?lang=zh-CN) · [创建导出任务](https://open.feishu.cn/document/server-docs/docs/drive-v1/export_task/create?lang=zh-CN)
- 飞书错误/事件：[99991663](https://open.feishu.cn/document/faq/trouble-shooting/how-to-fix-99991663-error) · [99991672](https://open.feishu.cn/document/faq/trouble-shooting/how-to-fix-the-99991672-error?lang=zh-CN) · [事件订阅概述](https://open.feishu.cn/document/server-docs/event-subscription-guide/overview?lang=zh-CN)
- Notion：[Authorization](https://developers.notion.com/guides/get-started/authorization) · [capabilities](https://developers.notion.com/reference/capabilities) · [Markdown API](https://developers.notion.com/guides/data-apis/working-with-markdown-content) · [Create/Refresh token](https://developers.notion.com/reference/create-a-token) · [限流](https://developers.notion.com/reference/request-limits) · [错误码](https://developers.notion.com/reference/status-codes) · [2026-03-11 升级指南](https://developers.notion.com/guides/get-started/upgrade-guide-2026-03-11)
- 开源参考：[feishu-pages（docx→Markdown）](https://github.com/yangzupan/feishu-pages) · [feishu-cli](https://github.com/riba2534/feishu-cli)
