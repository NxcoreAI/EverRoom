# 飞书 / Notion 导入导出 · 实施落地说明

> 实施日期：2026-09-03　方案：[feishu-notion-document-export-plan.md](../feishu-notion-document-export-plan.md)
> 本文记录按方案 M0–M2 落地的代码范围、关键实现决策与遗留事项。M3（真实账号回归）尚未执行。

## 交付范围

### Gateway（apps/gateway）

| 位置 | 内容 |
| --- | --- |
| `drizzle/0054_document_import_export.sql` + `schema.ts` | 6 张新表：`document_import_sources / runs / snapshots / comments / room_imports`、`agent_document_exports`（快照与导出 payload 的内容存 `document-imports/artifacts/<hash>` 内容寻址存储，表内只留引用；授权 challenge 不入库） |
| `modules/documents/import/` | `oo-runner.ts`（OpenConnector 调用 + 错误分类，复用 agent `runOo`）、`providers.ts`（feishu/notion 只读适配层，防御性解析）、`artifact-store.ts`、`service.ts`（search/preview/commit/checkExternalUpdate/applyCandidate/importHistory/评论 diff 摘要）、`routes.ts` |
| `modules/documents/agent-export/` | `lark-cli.ts`（网关侧 lark-cli 执行器，stdin 传正文、JSON 契约解析）、`service.ts`（固定版本渲染→环境自检→授权检查→update 预检→确认→一次性写入；不确定写入标 `needs_review` 禁止重发）、`tools.ts`（`document_export` Pi 工具）、`routes.ts` |
| `modules/agent/open-connector-tools.ts` | 导出 `runOo`/`connectorEnvironment` 供导入链路复用（方案 §13 预定改动） |
| `config.ts` | 新增 `larkCli`（env `NXCORE_LARK_CLI_PATH`，默认 `lark-cli`） |
| `create-server.ts` | 装配两个服务、注册路由、把 `document_export` 工具挂进主 Agent |
| `tests/document-import-export.test.ts` | 16 个用例：快照/评论降级/候选不覆盖/应用 v2/确认门槛/环境未就绪/授权挑战/版本钉定 |

### Desktop（apps/desktop）

| 位置 | 内容 |
| --- | --- |
| `src/main/agent-auth/` | `lark-auth-runner.ts`（`config init --new` 长驻、`auth login --no-wait` + `--device-code` 轮询；device code 不过 IPC）、`controller.ts`（challenge 状态机：飞书两阶段、Notion 引导连接器管理、过期/取消/失败；内存态，重启即过期） |
| `src/main/index.ts` | `AGENT_AUTH_CHANNELS`/`EXTERNAL_DOCUMENT_CHANNELS`、处理器、`NXCORE_LARK_CLI_PATH` 注入 gateway、退出清理 |
| `src/main/gateway/external-documents-gateway-bridge.ts` | 导入/导出 REST 的网关桥 |
| `src/shared/agent-auth.ts` + `sources.ts` + preload | `agentAuth.*`（start/resume/cancel/status/onEvent）与 `externalDocuments.*` 13 个方法 |
| `scripts/prepare-lark-cli.mjs` + `package.json` | `@larksuite/cli@1.0.93` 预装（构建期下载二进制+sha256 校验，拷贝到 `build/lark-cli/<platform>-<arch>/`，extraResources 打包；运行时不装依赖）；`pnpm-workspace.yaml` allowBuilds |
| renderer | `ExternalImportDialog` / `ExternalExportDialog`（"···"菜单入口）、`DocumentImportHistorySection`（版本面板内：检查外部更新 / 应用此版本）、`AgentAuthChallengeCard`（智能区授权步骤卡片，QR 复用 `qrcode`） |
| `tests/agent-auth-controller.test.ts` | 5 个用例（假 lark-cli 脚本驱动状态机） |
| i18n | contextRoom / surface 中英词条 |

### Agent（agents/main）

- `skills/document-export/SKILL.md` + `agent.yaml` 登记（`document_export` 工具、技能注入系统提示）。

## 关键决策与方案对齐

1. **凭据域隔离**：飞书导入 = OpenConnector 连接（管理台）；飞书导出 = lark-cli 自己的应用+用户授权（OS keychain）；Notion 导出 = **官方 ntn CLI（2026-09-03 起，macOS）**：`ntn login --no-browser`（URL+校验码）→ `ntn login poll` 本地等待，token 存 OS keychain。授权结果全部由桌面主进程本地接收，Gateway 不碰 OAuth 回调与 token。Notion 导出执行走 `ntn api -d @-`（stdin 传官方 Markdown Content API payload：POST v1/pages / PATCH v1/pages/:id/markdown），与 OpenConnector notion provider 语义同源。
2. **候选版本**：再次导入物化为独立候选文档（标题带"外部更新候选"），目标文档不被触碰；"检查外部更新"与"应用此版本"是两个独立动作（`checkExternalUpdate` / `applyCandidate`）。
3. **update 门槛**：`update` 必须有用户提供的目标（createRun 即校验 `EXPORT_TARGET_REQUIRED`）；写入前预检目标（标题/URL/revision）并返回 `awaiting_confirmation`，确认后才 overwrite。
4. **写入不确定性**：超时/取消 → `needs_review`；结果不可识别 → `needs_review`；一律不自动重发。
5. **lark-cli 契约核实**：`docs +create/--title/--parent-token/--content -`（stdin）、`docs +update --command overwrite --revision-id`、`auth login --no-wait/--device-code`、`config init --new` 均按 1.0.93 实测 `--help` 与真机（本机已配置 lark-cli）验证。

## 与方案的偏差（v1 简化，后续迭代）

- **Notion 导出（macOS）已切 ntn CLI**：预装 `prepare-ntn.mjs`（npm 包自带平台二进制，无需下载）+ extraResources；Windows 无 ntn（官方未支持），`externalDocumentFeatures.notionExport` 按平台（darwin）门控，桌面注入 `NXCORE_NTN_CLI_PATH`（非 darwin 不注入，网关 environment_not_ready）。
- **导入链路启用（2026-09-06，连接器统一 PR #172 迁入后）**：导入 `oo-runner.ts` 从已废弃的 `runOo`（oo CLI 子进程）迁到统一传输缝 `runOoHttp` + `envelopeData`（错误分类按 HTTP status 优先）；`/v1/apps` 封套 `{success,data}` 与 `alias` 连接名字段已实测对齐（独立拉起 build/open-connector 运行时验证）；渲染层 `externalDocumentFeatures.externalImport` 置 true 开放入口。无连接负路径已真机走通（search/preview → 422 IMPORT_CONNECTION_REQUIRED 引导建连）。真机正路径（真实账号搜索/预览/导入/评论/候选/diff/apply）待连接器控制台建立 feishu/notion 连接后执行。导入解析仍按上游真实 schema（search res_units 无独立 id 需从 URL 提取 token、fetch 输出嵌套 `document.content`、评论透传 Drive v1 `reply_list.replies`/`content.elements[].text_run.text`）。
- **连接器统一后的两个环境修正（2026-09-06）**：① 合并后从未执行 `pnpm install`，`@nxcore/connectors-module` 工作区链接缺失导致网关 dev 起不来（ERR_MODULE_NOT_FOUND）——`CI=true pnpm install` 修复；② 子模块 `open-connector-tools.ts` 的 `connectorApps` 不解 HTTP 封套也不认 `alias`，会让 Agent `connector_run` 在有活跃连接时误报 "no active connection"——已修并加回归锁（`open-connector-tools.test.ts`）。
- **飞书 update 最小写入**（2026-09-04 已补）：`replace_document` 确认后先 fetch 远端全文 → 行级 diff → 每处变更生成 `str_replace` 命令（pattern 在远端必须唯一、≤12 处、无纯插入，全有或全无）逐条执行（首条带乐观 revision）；不满足条件回退整篇 overwrite。成功记 `minimal_write_applied` 告警说明未触碰其余内容。
- **本地图片**（2026-09-03 已闭环）：桌面 DocumentAssetStore 挂 loopback 资产桥（`document-asset-bridge.ts`，随机端口+token 路径，env `NXCORE_DOCUMENT_ASSET_BRIDGE_URL` 注入网关）；网关把 `nxcore-document-asset://` 图改写为桥 URL，lark-cli 的 markdown 导入自动下载上传（记 `local_assets_via_bridge`）；export_file（.md 会分发到别处）保留占位+`local_assets_placeholder`；payloadHash 用改写前正文（桥 URL 含每次启动变化的端口/token）。另修复根因：网关 MarkdownManager 缺 Image 扩展，此前**所有**图片节点在序列化时被静默丢弃（连带 http 图）。飞书评论分页（pageToken ≤5 页 + 远端 id 去重）同日补齐。
- **export_file（飞书）**：已实现，走 lark-cli `markdown +create` 生成云空间原生 .md 文件。
- **跨文档 diff 视图**（2026-09-04 已补）：版本面板候选条目新增"对比差异"，服务端 `GET /v1/document-import/room-imports/:id/diff` 计算行级 hunks（变更行 ±3 上下文），前端着色渲染并支持从 diff 内直接"应用此版本"。评论 diff 仅在两次快照 `commentsStatus=complete` 时计算，否则显示"不可比较"。
- **评论面板**（2026-09-04 已补）：编辑器工具栏"导入的评论"按钮（有评论才可用）→ 右侧只读面板，含回复线程、解决状态、引用块与"未定位"标记；数据来自 import-history 附带的最新快照评论。
- **附件物化（导入侧）**（2026-09-04 已补）：资产桥新增鉴权 PUT 写口（6MB 上限、mime 白名单），导入 preview 时远端图片（≤10 张、单张 ≤5MB）下载后经桥落桌面 DocumentAssetStore，markdown 改写为本机 `nxcore-document-asset://` URL（编辑器原生渲染）；失败保留远端链接并告警。
- **导出入口的 Agent 化**：菜单路径直接调用网关服务（同一 service/确认/审计链路）；Agent 聊天路径走 `document_export` 工具——awaiting_auth 时自动拉起本地授权，update 缺目标时返回 `needs_input` 并自动弹出对应文档的导出面板补齐（§6.4）。另有 `document_import_search/preview` 两个 Agent 导入工具（结构化降级：OpenConnector 未迁入 → 环境提示；连接缺失 → 引导建连接）。update 目标支持搜索选择（飞书 `docs +search` / Notion `api v1/search`）。

## 连接器页批量导入（2026-09-07 新增，未提交）

用户澄清导入主入口设计：**连接器页按连接全量列出文档 → 批量勾选 → 两个去向**。已实现：

- **网关**：`POST /v1/document-import/list`（feishu：`list_drive_files` 根目录 BFS 递归（folder 下钻深≤5、≤500 篇、visited 防环）+ `list_wiki_spaces`→`list_wiki_nodes`（≤10 空间、has_child 递归，**wiki 的 remoteDocumentId=obj_token** 与 preview 链路对齐；notion：`search` 空 query+filter page+pageSize 100 翻页 ≤10 页）；响应带 truncated/warnings 与 per-篇 imported 标记（documentRoomImports 落 Room 记录）。
- **批量异步批**：`document_import_batches` 表（0060 迁移，items 内联 JSON ≤50/批）+ `DocumentBatchImportService`（fire-and-forget + DB 状态行，蓝本 AgentExport runFrom）：逐篇 preview→commitToRoom 完整继承快照/评论/附件物化/候选版本；单项失败不中断；IMPORT_CONNECTION_REQUIRED/OPEN_CONNECTOR_UNAVAILABLE 短路整批；取消幂等；启动 recoverInterrupted 置 failed。REST `/v1/document-import/batch(+/id,/cancel)`。
- **AI 归类（归房+孵化混合，用户拍板）**：`room-classifier.ts`（仿 IndexBackfillLlm：隔离内部 runtime `createImportClassifierRuntime`、prompt 带白名单/不执行文档内指令/拿不准输出 null、roomId 白名单代码过滤、置信阈值 0.7 低于索引回溯的 0.8——错归房代价高于孵化兜底）；高置信 commitToRoom 到判定 Room，低置信/无匹配 `ingestConnector cloud-doc` 全文投喂 knowledge 弱实体管线（待处理面板晋升）；roster=`knowledgeService.listRooms()` 一次/批；router 关闭或分类器缺席 → 400 BATCH_ROUTER_DISABLED/BATCH_AUTO_UNAVAILABLE（UI 禁用按钮）。
- **桌面**：ConnectorSyncPage 新"文档导入" tab + `ConnectorDocumentImportPanel`（provider/连接选择→加载列表（loading/truncated/notion 共享范围提示）→多选列表（表头全选/过滤/已导入 badge）→「导入到 Room…」（Room 选择器仿 RoomAssignControl，数据 knowledge.listRooms）/「AI 自动归类」→ 2s 轮询进度+取消+失败明细）；IPC 四通道 `external-documents:import-list/import-batch/import-batch-status/cancel-import-batch` 全链路透传；i18n 中英 40 key。
- **数据源页入口（同日追加）**：侧边栏"数据源/连接器"两页按构建模式 `NXCORE_DESKTOP_PAGE_MODE` 互斥（默认 sources——连接器页被隐藏，当前构建无处设置过该变量）。批量导入面板 connections 改可选（不传时自拉 cliConnector apps）；数据源页待连接九宫格（ConnectGrid 可选 prop `onExternalDocumentImport`，主页+connectors 子页）新增「从飞书/Notion 导入」tile → `ExternalBatchImportDialog`（sources/ 新对话框内嵌同一面板）——默认 sources 模式下用户可直达。
- 测试：gateway `document-import-batch.test.ts`（18：列举递归/去重/截断/翻页/imported 标记/批量逐篇/失败续跑/取消/短路/恢复/auto 分流）+ `document-import-room-classifier.test.ts`（5：prompt/解析护栏）；导入相关合计 58 全绿；gateway 全量 1063 通过、基线 9 预存失败不变（另 2 处 server.test.ts MCP 工具清单失败为**并发会话文档评论工作**引入，非本次）；desktop scoped 基线 8 预存失败不变；双侧 typecheck 干净。

## M3 回归状态（2026-09-04，不依赖 OpenConnector 的部分全部完成）

1. ✅ 飞书真机：create（多次）、update append（确认→写入，revision 3→4，远端文末核实）、auth 全链路（logout→设备码→授权→retry 自动续跑）。`docs +update --command overwrite --revision-id` 与 append 共用确认/执行链路，仅整篇覆盖未单测真机。
2. ✅ Notion 真机（ntn）：create（POST v1/pages markdown）、update append（insert_content.content）与 replace（**replace_content.new_str**——字段不对称，已按真实 API 修正并加假件回归锁）、PATCH 响应无 url → 由 id 构造 notion.so 链接。
3. ✅ 打包自检：`package:mac` 产物 `Resources/{lark-cli,ntn,oo,open-connector}` 就位且可执行，与 `resourcesPath` 解析匹配。（预存问题：package:mac 不生成 packaged-env.json，仅 package:win 有该步骤。）
4. ✅ 授权全链路：飞书两阶段 + Notion 两步登录均真机走通；授权后自动重试已修复（prepare 通过后清理 awaiting_auth 状态的网关 bug）。
5. ⏸ 导入侧回归：传输层迁移与无连接降级已完成（见上）；正路径待连接器控制台建立 feishu/notion 连接（需账号 OAuth 授权）后执行。
6. 遗留测试痕迹（可删）：Notion 页 3d1695c6（TI 简介 dup，现内容为"短文测试"）、飞书 docx EPwKdtiLNoFFqPx7UFNcAxsWn9f（M3 飞书 Update）。
