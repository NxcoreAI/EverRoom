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

1. **凭据域隔离**：飞书导入 = OpenConnector 连接（管理台）；飞书导出 = lark-cli 自己的应用+用户授权（OS keychain）；Notion 导出 = OpenConnector 连接。授权结果全部由桌面主进程本地接收（device flow 轮询），Gateway 不碰 OAuth 回调与 token。
2. **候选版本**：再次导入物化为独立候选文档（标题带"外部更新候选"），目标文档不被触碰；"检查外部更新"与"应用此版本"是两个独立动作（`checkExternalUpdate` / `applyCandidate`）。
3. **update 门槛**：`update` 必须有用户提供的目标（createRun 即校验 `EXPORT_TARGET_REQUIRED`）；写入前预检目标（标题/URL/revision）并返回 `awaiting_confirmation`，确认后才 overwrite。
4. **写入不确定性**：超时/取消 → `needs_review`；结果不可识别 → `needs_review`；一律不自动重发。
5. **lark-cli 契约核实**：`docs +create/--title/--parent-token/--content -`（stdin）、`docs +update --command overwrite --revision-id`、`auth login --no-wait/--device-code`、`config init --new` 均按 1.0.93 实测 `--help` 与真机（本机已配置 lark-cli）验证。

## 与方案的偏差（v1 简化，后续迭代）

- **导入链路整体挂起**：等 OpenConnector 正式迁入后启用（2026-09-03 决定；导入代码已就绪并按上游真实 schema 校对过解析：search res_units 无独立 id 需从 URL 提取 token、fetch 输出嵌套 `document.content`、评论透传 Drive v1 `reply_list.replies`/`content.elements[].text_run.text`）。
- **飞书 update 最小写入**：方案建议优先 `str_replace`/`block_*`；v1 提供 `append`（默认，安全追加）与 `replace_document`（显式确认覆盖）两种写入范围，最小范围写入待后续。
- **本地图片**：字节在桌面 DocumentAssetStore、网关拿不到，且 markdown 序列化会**静默丢弃**非 http 图片节点；导出前在 Tiptap JSON 层替换为可见占位并记 `local_assets_placeholder` 告警。真实上传（lark-cli media 链路）待后续设计。
- **export_file（飞书）**：已实现，走 lark-cli `markdown +create` 生成云空间原生 .md 文件。
- **跨文档 diff 视图**：候选 vs 当前的专用 diff 未做；v1 用"应用后版本 diff + 服务端摘要 + 打开候选文档人工对比"覆盖。评论 diff 仅在两次快照 `commentsStatus=complete` 时计算，否则显示"不可比较"。
- **评论面板**：编辑器内右侧"未定位评论"侧栏未做；评论在导入预览与版本面板外部导入区可见（只读记录均已入库，可追溯）。
- **附件物化**：见"本地图片"条。
- **导出入口的 Agent 化**：菜单路径直接调用网关服务（同一 service/确认/审计链路），不强制起一个 LLM run；Agent 聊天路径走 `document_export` 工具，且工具返回 awaiting_auth 时渲染层会自动拉起本地授权流程（与菜单入口行为一致）。

## M3 待办（真实账号回归）

1. 飞书真实文档：search/fetch 实际返回形状校验（provider 层为防御性解析，需按真实样本收紧）、评论分页（pageToken 循环）、`docs +update --revision-id` 乐观并发真实行为。
2. Notion：`update_page_markdown` 的 `replace_content.content` 字段名按真实 API 核对；`create_page {parentId,title,markdown}` 实测。
3. 打包版自检：`package:mac` 后 `resources/lark-cli` 路径解析、sandbox/entitlements 下 spawn。
4. 授权全链路真机走查：首次 `config init --new` 浏览器引导 → device flow → 导出重试。
