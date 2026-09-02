# 《飞书云文档 + Notion 双向同步：调研与方案设计》评审报告

> 2026-09-02 · 评审对象：`feishu-notion-connector-research.md`（2026-09-01 版）
> 评审方法：① lark-cli v1.0.84 本机实测（实读 spike 文档、逐命令核对 flag/模式）；② 飞书/Notion 官方文档逐条核查（独立检索，非引用原文）；③ 本仓库代码核验（Nango providers.yaml、sync-providers、gateway connectors、桌面 UI）；④ vendored open-connector（pin `5719a69`/v1.3.5）源码核验；⑤ 上游 open-connector main 源码比对。

---

## 总体结论

**方案主体成立，质量高，可以作为实施基线。** 核心设计决策——放弃"真双向合并"、改用"每对一个方向"的状态机 + 映射表防环 + 冲突只检测不自动合并 + 导出走独立 outbox——方向正确，且与飞书官方 lark-cli 自己的 `drive +sync` 设计同构（官方也没做自动合并），是有力的旁证。§4.4.4 规范化层判断被实测反复证实。

但评审发现 **1 处报告内部自相矛盾、4 处需要修正的事实性错误/过时结论、2 处设计缺口**，集中在"报告经过一轮二次核实后，新结论（§0 更正）与旧结论（§4 正文）没有清理干净"，以及 lark-cli 命令面描述与实际版本不符。这些直接影响 M1/M2 的工作量估算和 sync_update 的落地方式，建议按下文修订后再进入评审定稿。

---

## 一、实测确认为真的关键判断（抽查通过）

| 报告论断 | 评审验证方式 | 结果 |
|---|---|---|
| 飞书文档可单次 markdown 回读（§2.3/§4.9） | lark-cli 实读 spike 文档 `RLrpdlFGEoNhJExbkxucS3jhnMc`，单次取回全文，标题/表格/代码块完整；token `needs_refresh` 状态下自动刷新成功 | ✅ |
| 回读存在表示层差异、contentHash 必须算在规范化后（§4.4.4） | 实读内容中表格分隔线确为 `\|-|`（发送版为 `\|---\|`），引用块行尾空格差异同报告描述 | ✅ 实锤 |
| `docs +fetch` 支持 outline/section/range/keyword/revision_id 局部读 | `--scope full\|outline\|range\|keyword\|section`、`--revision-id`、`--context-before/after` 全部存在 | ✅ |
| lark-cli 授权模式（§2.7①） | `auth login --no-wait`/`--device-code`/`--recommend`、`config init --new` 一键建应用、凭据入 OS keychain，全部属实 | ✅ |
| `drive +sync` 默认 SHA-256、三态、`--on-conflict` 四选一、不传播删除、跳过在线文档（§2.7③） | `+sync`/`+status` help 原文逐条吻合（注意默认值是 `remote-wins`） | ✅ |
| 内嵌 Nango 无 feishu provider（§1.2.1） | gateway providers.yaml 26874 行，`feishu|lark` 0 命中 | ✅ |
| Nango notion 代理钉 `notion-version: 2022-06-28`（§1.2.5） | providers.yaml notion proxy 段（≈15516 行）确认，大小写为 `'notion-version'` | ✅ |
| `SyncProviderNangoMeta.credential` 仅 google/notion/outlook/none（§1.2.1） | [types.ts:66](apps/gateway/src/modules/connectors/sync-providers/types.ts:66) | ✅ |
| feishu-wiki 走 tenant_access_token + raw_content 纯文本（§1.1） | [feishu-wiki.ts:96](apps/gateway/src/modules/connectors/sync-providers/feishu-wiki.ts:96) | ✅ |
| 桌面飞书入口 comingSoon 占位（§1.2.4） | [ConnectSourceMenu.tsx:104](apps/desktop/src/renderer/src/components/pages/sources/ConnectSourceMenu.tsx:104) | ✅（行号漂移至 ~104） |
| open-connector pin `5719a69`/v1.3.5；notion provider 含 `retrieve_page_markdown`/`update_page_markdown`/`create_page`（§4） | desktop package.json pin + 源码动作清单 | ✅ |
| 飞书 OAuth（authen/v1/authorize + authen/v2/oauth/token + offline_access + client_secret_post + JSON body） | pin 版 feishu definition.ts 逐字段吻合 | ✅ |
| 飞书错误码 99991663/99991672/1069902/1069906/1069908/1069909/1069913/1069923 语义（§2.6） | 官方文档逐条吻合 | ✅ |
| 导出任务 API 仅 docx/pdf/xlsx/csv、docx 类文档只支持 docx/pdf、无 Markdown（§2.3） | 官方 export_task/create 枚举原文 | ✅ |
| Notion Markdown API 全套（GET/POST markdown、PATCH replace_content、allow_deleting_content 默认拒删子页、allow_async 202+轮询、~20000 块截断、`<unknown>` 占位、404 含连接名） | 官方文档逐条吻合 | ✅ |
| Notion 3 rps、429 Retry-After、529、capabilities 不得超用户权限、webhook 需公网端点 | 官方文档吻合 | ✅ |
| Notion-Version 最新 2026-03-11（block 定位与 trash 语义破坏性变更） | 官方 versioning/升级指南 | ✅ |

---

## 二、必须修正的问题

### P0-1 报告内部自相矛盾：feishu provider 动作到底就位没有

- §0"二次核实更正"说：`fetch_document`/`create_document`/`update_document`/`search_documents`/wiki/drive 发现动作**均已在上游就位，provider 层无需扩展**。
- §4 引言却说"动作只有 docx 元数据/纯文本读 + Bitable 读"；§4.3 说"provider 层补飞书动作"；§4.6 说"feishu provider 新增动作…+ scopes 扩展"；§4.8 说"可对当前 pin 做最小 fork"。

**源码核验结论：§0 是对的，§4 系列是没删干净的旧结论。** pin `5719a69`（就是当前仓库在用的版本，不是上游 main）的 [actions.ts](apps/desktop/node_modules/@oomol-lab/open-connector/src/providers/feishu/actions.ts) 在 7 个内联动作之后，以 `...createFeishu*Actions()` 展开引入了全套 shared 动作，实际可用清单包括：

- 文档：`fetch_document`（markdown/xml、scope full/outline/range/keyword/section、revisionId）、`create_document`、`update_document`、`search_documents`（Search v2）、`list_document_history`/`revert_document`
- 发现：`list_wiki_spaces`/`list_wiki_nodes`/`get_wiki_node`、`list_drive_files`/`create_drive_folder`/`inspect_drive_item`/`search_drive_items`
- **导出路径写动作也已就位**：`submit_drive_import`/`get_drive_import`（import_task 全流程）、`submit_drive_export`/`get_drive_export`/`download_drive_export`、`get_drive_task_status`、`upload_drive_file`
- Drive 原生 .md：`create/fetch/overwrite/patch/diff_markdown_file`

这比 §0 声称的还要全。**连带影响**：M1 的"fork/pin 升级"和 §4.6 的"provider 新增动作"工作项基本消失，M2/M5 的 provider 侧工作量大幅缩水；真实剩余工作 = 网关作业接入 + 规范化基建 + 端点行为 spike（见 P0-3）。报告需把 §0 与 §4/§4.3/§4.6/§4.8 统一成一份权威表述。

### P0-2 §4.2"上游 scopes 仅只读集、需要补权限点"在 pin 上不成立

scopes.ts 只定义了 3 个基础 scope（offline_access/docx:document:readonly/bitable:app:readonly），但 [definition.ts](apps/desktop/node_modules/@oomol-lab/open-connector/src/providers/feishu/definition.ts) 的授权 scope 列表是**派生的**：

```ts
const feishuOAuthScopes = [offlineAccess, ...new Set(feishuActions.flatMap(a => a.providerPermissions))];
```

由于 P0-1 的全套动作都在 `feishuActions` 里，实际授权 scope 已包含：`docx:document:create`、`docx:document:write_only`、`docs:document:import`、`docs:document:export`、`search:docs:read`、`wiki:node:read/retrieve/create/move/copy`、`wiki:space:read/retrieve/write_only`、`drive:file:download/upload`、`space:folder:create`、`space:document:move/shortcut` 等。

即：**授权面不是"只读集"，编辑/导入/导出/wiki 权限都已按动作自动派生进去**。剩余工作不是"补 scopes"，而是做一次**精确对照审计**（§2.1 清单里的 `docx:document`/`drive:drive:readonly`/`wiki:wiki:readonly` 与 provider 实际用的 `docx:document:write_only`/`wiki:node:read` 等是不同粒度的合法等价物，逐动作核对 `requiredScopes` 是否满足即可）。注意派生机制的另一面：**新增任何动作会自动扩大授权 scope 面**，审批时管理员看到的权限清单会变——这本身值得在方案里写明。

### P0-3 `docs +update` 的"7 种模式"枚举错误，sync_update 设计需返工

报告 §2.4 称 `docs +update` 提供"append / replace_range（按开头…结尾内容定位，或按 `## 标题` 定位整节）/ replace_all / insert_before / insert_after / delete_range / overwrite"7 种模式，§4.4.6 的飞书 sync_update 据此设计了"replace_range 按标题定位整节"。

**实际 v1.0.84（与报告 spike 同版本）的命令集是 8 种、名称完全不同**：

```
str_replace | block_delete | block_insert_after | block_copy_insert_after
| block_replace | block_move_after | overwrite | append
```

- **不存在** replace_range/replace_all/insert_before/insert_after/delete_range；
- **不存在"按 `## 标题` 定位整节"的直接命令**——节粒度更新需要组合：`+fetch --scope outline/section` 拿 block id → `block_replace`/`block_insert_after`，或 `str_replace`（markdown 模式下 pattern 可多行匹配，等价于"按内容定位替换"）；
- 默认载荷格式是 **DocxXML**，markdown 只是 `--doc-format markdown` 选项（§2.7②"读写都以 markdown 为主载荷"表述过强）；
- open-connector 的 `update_document` 动作与实际 CLI 对齐（command 枚举 replace_text/delete_blocks/insert_after/copy_after/replace_block/move_after/overwrite/append，大文档返回 taskId/pollAfterMs 异步任务句柄），实现时应对齐这个事实。

**建议**：v1 飞书侧只做 `create_copy`（import_task，天然不覆盖），`sync_update` 降级为 v2 且按"outline 定位 block → block_replace / str_replace"重新设计——这也与 §4.8"单向导入先行"的分期精神一致。

### P0-4 "docs +fetch v2 基于同族接口（docs-v1 get）"不成立——markdown 读依赖未公开端点

lark-cli v2 fetch 的底层是 `POST /open-apis/docs_ai/v1/documents/:token/fetch`（docs_fetch_v2.go 源码可证），**不是**公开文档的 `GET /open-apis/docs/v1/content`；且 vendored open-connector 的 `fetch_document`（shared/docs-runtime.ts）走的也是 `/docs_ai/v1/documents` 一族。open.feishu.cn 公开文档检索不到 docs_ai/v1 端点。

风险与对策：
- 未公开端点 = 行为/权限/配额无契约。spike 实测账号带 `docs:document.content:read` 可用，说明权限耦合到这个 scope，但无官方承诺。
- 公开的 docs-v1 `/content` 接口有自己的硬限制：权限 `docs:document.content:read`、**内容超 10MB 报 2889925**、仅支持 docx 类型——大文档走它也会失败。
- **方案应显式记录这条依赖**（"markdown 主读路径 = 未公开端点，兜底 = docs-v1 content(10MB) / blocks 分页自转"），并把"单文档 >10MB / 高块数"列为 §5 待验证项，而不是像现在这样表述成"官方映射保证保真"的已解决问题。

### P1-5 refresh_token"约 30 天"已过时

现行 authen v2 文档只给示例值并注明"非固定值，不要硬编码"：user_access_token 示例 7200s（约 2h，✅），**refresh_token 示例 604800s（7 天）**。"约 30 天"出自 historic-version 旧文档。§4.5 矩阵里"30 天未活跃"的文案、以及 oo CLI 刷新调度的一切假设，都应改为**以响应体实际 `expires_in`/`refresh_token_expires_in` 为准**。这对"授权失效"提示的触发时机影响很直接（若实际 7 天，重度不活跃用户会比方案预期更早进入 needs_connection）。

### P1-6 若干小修正

- "事件订阅 10 次/分钟"（§2.6）：10/min 是**取消订阅**接口；订阅接口 1000次/分、50次/秒。且 `drive.file.edit_v1` 的前提是先按 file_token 调"订阅云文档事件"接口，tenant 身份还需应用+用户双身份事件权限——比报告描述多一层前置。
- "import_task 只会创建新文档、不存在覆盖面"（§2.4）：官方无此明文，属合理推断（API 无覆盖参数）。作为设计假设没问题，但不应表述成平台保证。
- "官方推荐 replace_content"（§3.2）：官方同时推荐 `update_content` 与 `replace_content`。
- "capability 变更使 refresh_token 失效（invalid_grant）"（§3.1）：官方只说"用户需重新授权"；invalid_grant 是对通用 OAuth 错误码的合理推断，措辞应为"推断"。
- lark-cli 概况（官方开源/Go/MIT/`npx @larksuite/cli`/keychain）：全部属实，唯命令数/技能数等宣传数字未逐一清点。

---

## 三、报告遗漏、建议补入的事实

**飞书侧**

1. **docx 写入是双限频**：应用级 3 QPS 之外，另有"单篇文档并发编辑 3 QPS"（创建/嵌套/删除/更新合计）——导出器必须同时按应用与按文档两个维度限速，outbox 退避表要考虑这一点。
2. **导入有两条上传路径**：报告只提 `files/upload_all`（永久保留、占上传者云盘配额）；另有 `medias/upload_all`（parent_type=ccm_import_open，导入完成即删源文件）。批量导出场景后者更合适，方案应二选一并写明。
3. **md→docx 导入的图片保真缺口（导出方向的最大隐雷）**：官方无 md 导入语法子集文档；最接近的 convert 接口清单显示支持块类型有限（文本/标题/列表/代码/引用/待办/图片/表格），且**图片块需另走"上传图片素材→replace_image"两步**，md 里的本地图片引用不会自动带图。EverRoom 文档多含图片，M5"导出飞书"若走 import_task(.md)，图片大概率丢失或空块——要么按 lark-cli `+media-insert` 的四步编排补图（provider 已有 `upload_drive_file`/media 动作可参考），要么在验收标准里明确降级。**报告完全没讨论这一点。**
4. blocks list page_size 上限 500；响应中用户 ID 等字段需额外字段权限（contact:user.employee_id:readonly）。

**Notion 侧**

5. **限流是双层的**：per-connection 约 3 rps 之外新增 per-workspace 限流（按 plan 缩放），429 响应带 `rate_limit_reason` 可区分层级。
6. **search 实为"按标题搜索"**：query 只匹配标题；filter 仅 `object`（page/data_source）+ `in_trash`，**不能按属性过滤**；query 为空返回连接可见全部页面（这对 reconcile 全量发现反而有用）。报告 §3.3 未提"仅标题"这一限制。
7. `unknown_block_ids` 不区分"权限不可见"与"超限截断"两种成因；权限型 unknown 补拉会得到 404。迭代补拉逻辑（§4.3）要容忍这种二义性。
8. **synced page（external_object_instance_page）不可用 markdown PATCH 更新**——导入发现时应过滤这类页面，导出映射也不应接受它们。
9. `allow_async` 同样适用于 `POST /v1/pages`（带 markdown 时）；**202 只代表过初始校验，任务仍可能 failed，必须轮询到终态**；异步任务元数据仅保留有限时间——outbox"句柄存在即续轮询"的状态机（§4.4.6）要加"任务元数据过期→按失败处理并提示人工确认"的分支。
10. **Free workspace block limit 2026-09-08 生效**（就在本周）：超限是 403 restricted_resource 的第三种成因。§4.5 错误矩阵建议补一行，否则会把配额问题误报成"权限不足"。
11. 2026-07 起**新公共连接每次授权都铸造全新 token 对**（旧逻辑返回存量 token）；加上 capability 锁死约束，"上线前 capabilities 定稿 + 存量重授权一次"的 M3 安排要和发布节奏绑死。
12. Notion MCP token 约 8 小时有效（REST 公共连接 OAuth token 仍无文档化有效期）——若未来接 MCP 通道不要混淆两套 token 语义。
13. OpenAPI 409 enum 里出现 `idempotency_key_reused` 但无文档化参数——官方疑似有内部幂等机制，"建页无幂等"的当前设计假设成立，但值得跟踪 changelog。
14. webhook 送达是 at-most-once、失败最多重试 8 次（约 24h 内）、事件可能乱序——v2 若做事件加速，消费端必须回查 API 而非信任 payload。

**仓库侧（评审新增确认）**

15. open-connector notion provider **已经使用 `Notion-Version: 2026-03-11`**（executors.ts:25）——报告 §4.2/M3 的"确认 Notion-Version"待办可以直接结案。

---

## 四、方案设计层面意见

**维持不变（评审认同）**：
- §4.4.0 每对一个方向的状态机——与 lark-cli `+sync` 的官方设计同构，正确。
- §4.4.2 回环阻断放在"PullPage 之后、domain-projection 之前"单一 choke point——正确。
- §4.4.3 冲突只检测 + 三选一显式 UI、基线存远端自报时间——正确。
- §4.4.4 规范化层三道防线——被实测证实（`|-|` 差异），且"规范化参照形态取回读形态"的结论与实测一致。
- §4.4.5 删除不传播、每连接单线程串行——正确。
- §4.8 路线无关拆分与"单向导入先行"的分期——正确且现在更顺（provider 动作已就位，首期连 fork 都不需要）。

**需要修改**：
- §4.4.6 飞书 sync_update：按 P0-3 返工（去掉 replace_range 按标题定位的假设），建议 v1 直接砍掉飞书 sync_update，只留 create_copy。
- §4.6 改动清单：open-connector 条目从"新增动作+fork pin"改为"零 provider 改动（或仅 scope 审计+按需升 pin）"；补"飞书导出图片编排"工作项（见三.3）。
- M1 里程碑重写：原"fork/pin 升级→scopes 补齐"改为"provider 现状审计（动作/端点/scope 派生集）+ docs_ai 端点风险决断 + 飞书后台配置与审批"。
- §4.5 错误矩阵补：飞书单文档 429、docs-v1 10MB(2889925)、Notion per-workspace 限流、Free block limit 403、Notion async 任务元数据过期。
- §5 风险表补一条：**markdown 主读路径依赖未公开的 docs_ai 端点**（含公开兜底的局限），并把"pin 派生 scope 集合需与自建应用实际开通权限对齐（管理员审批可见）"写入。

---

## 五、修订清单（按优先级）

1. [ ] 统一 §0 与 §4/§4.3/§4.6/§4.8 关于 feishu provider 动作/scopes 的表述（以 §0 为准，附 pin 源码证据）
2. [ ] 重写 §2.4/§2.7 的 `docs +update` 模式枚举为实际 8 命令；§4.4.6 飞书 sync_update 返工或降期
3. [ ] §2.3/§2.7 更正"docs +fetch v2 基于 docs-v1 同族接口"→ 实为 docs_ai/v1/documents/fetch；补 docs-v1 content 10MB/2889925 限制；§5 补未公开端点依赖风险
4. [ ] §2.1/§4.5 更正 refresh_token 时效表述（示例 7 天、非固定值、以响应为准）
5. [ ] §2.6 事件订阅限频更正（10/min=取消订阅；补按文件订阅前置与双身份权限）
6. [ ] §3 补 Notion 双层限流、search 仅标题、synced page 不可更新、unknown 双成因、async 任务元数据过期、Free block limit（2026-09-08）
7. [ ] §4.6/M5 补"飞书导出图片保真"工作项（media 编排或明确降级验收）
8. [ ] M3 的"Notion-Version 确认"待办结案（已是 2026-03-11）
9. [ ] 全文把"官方保证不覆盖/官方推荐 X"类推断性表述标注为设计假设

---

*评审证据可复现：lark-cli 1.0.84 本机命令输出；仓库文件行号引用见文中链接；官方文档核查由独立检索完成（飞书 open.feishu.cn 各 API 页、Notion developers.notion.com reference/guides、github.com/larksuite/cli 与 oomol-lab/open-connector 源码）。*
