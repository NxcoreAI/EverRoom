# 依赖深度审计：大改后已失效的库与残留

> 审计对象：`nxcore-ce` monorepo（`apps/desktop`、`apps/gateway`、`packages/*`、`submodules/everoffice-connectors/*`）
> 审计基线：`feat/doc-flow-prototype` @ `97c4bf22`（含工作区改动，见 §9 待确认项）
> 结论性质：**只读审计**，本文件不含任何代码改动。

---

## 0. 摘要

| 包 | 声明依赖 | 建议删除 | 建议移位（dev→prod 或反之） | 连带死代码 |
| --- | --- | --- | --- | --- |
| `@nxcore/desktop` | 76 | **28** | 2（`@types/qrcode`、`@types/react-test-renderer`） | 10 个文件 |
| `@nxcore/gateway` | 74 | **23** | 2（`mammoth`、`ws` → dev） | 2 个文件 |
| `@nxcore/connectors-module`（submodule） | 32 | **9** | — | — |
| `@nxcore/agent-runtime-pi` | 10 | **1**（`zod`） | — | — |
| 其余 packages | — | 0 | — | — |
| **合计** | 192 | **61** | 4 | 12 |

可回收安装体积约 **20 MB**（desktop 11.4 MB + gateway 8.1 MB，不含其传递依赖与 lockfile 条目）。

三类根因：

1. **everoffice 原型 → 工作台重构**丢下的 UI 组件库（Radix 7 个、clsx、react-resizable-panels）与整套 **TipTap 编辑器栈**（13 个包）。
2. **文档转换管线迁入 submodule**（`gateway-module/email-content.ts`、`converters.ts`），但 `apps/gateway/package.json` 里那批 `rehype-* / remark-* / unified / turndown / mailparser / html-to-text / email-reply-parser` 声明没有同步删除。
3. **记忆 / 感知 / 剪藏 / 屏幕记忆等能力下线**后遗留的 `ali-oss`、`jsonata`、`pino-pretty`、`proxy-agent`、`axios` 等。

---

## 1. 判定口径

不采用"grep 一下没有就算没用"的粗判，每个候选项都经过三道核验：

| 步骤 | 做法 | 作用 |
| --- | --- | --- |
| ① 机械扫描 | 对每个包解析 `package.json`，在 `src/`、`tests/`、`scripts/`、包根配置文件中检索 **import / export-from / require / 动态 import** 的裸标识符（含子路径） | 得到"零引用"候选 |
| ② 可达性分析 | 从真实入口（`main/index.ts`、`preload/index.ts`、`main.tsx`、`debug.html`、`debug/*.html`、`*.test.ts*`）沿 import 图做 BFS，区分 **应用可达 / 仅测试可达 / 完全不可达** | 排除"文件还在但已成孤岛"的假阳性（例：TipTap 有 import，但 import 它的文件没人 import） |
| ③ 人工回溯 | 对每个候选查动态引用（`require.resolve`、运行时路径、CLI 二进制、`electron-builder` `extraResources`、tsup `external`/`noExternal`）、注释/字符串提及、以及历史替代方案 | 排除真阳性误判（例：`pdfjs-dist` 靠 `require.resolve` 取路径；`npm`、`ntn` 是被打进 `extraResources` 的运行时资源） |

三条已知误报模式，本报告已人工剔除：

- `@types/*` 不写 import 也可能必需（环境全局类型 / 为无类型库补声明）。`@types/better-sqlite3`、`@types/tar-stream`、`@types/node`、`@types/react*` 均属此类，**保留**。
- 文件名与包名同形的命中。`docx` 在源码里有 **384 次**命中，全部是 `.docx` 扩展名字符串，`docx` 包本身**一次 API 调用都没有**。
- 纯注释/文档提及。`unified` 在 gateway 的 5 次命中分别是 `docs/unified-ingest-plan.md` 的引用和 `describe("unified file catalog")`。

---

## 2. `@nxcore/desktop`：28 个可删依赖

### 2.1 零引用（20）

| 依赖 | 声明位置 | 说明 |
| --- | --- | --- |
| `@radix-ui/react-avatar` | dependencies | 组件已随原型外壳下线 |
| `@radix-ui/react-collapsible` | dependencies | 同上 |
| `@radix-ui/react-context-menu` | dependencies | 同上 |
| `@radix-ui/react-popover` | dependencies | 同上 |
| `@radix-ui/react-scroll-area` | dependencies | 同上 |
| `@radix-ui/react-separator` | dependencies | 同上 |
| `@radix-ui/react-tabs` | dependencies | 仅出现在 `scripts/open-connector-package-lock.json`（那是 vendored open-connector 的 lockfile，不是本包引用） |
| `clsx` | dependencies | 渲染层改用本地类名拼接，全仓 0 引用 |
| `react-resizable-panels` | dependencies | 1.1 MB；面板改用自绘拖拽 |
| `docx` | dependencies | 4.5 MB；见 §1 误报说明——零 API 调用 |
| `react-test-renderer` | devDependencies | 1.5 MB；测试统一用 `react-dom/client` + `act()` 手写渲染（见 `tests/workbench-home.test.tsx` 注释） |
| `@types/react-test-renderer` | devDependencies | 随上一项删除 |
| `@nxcore/document-model` | dependencies（`workspace:*`） | desktop 侧 0 引用（该包只被 gateway 使用） |
| `@nxcore/connectors-module` | dependencies（`workspace:*`） | 只有 `tsconfig.json` 的 `paths` 映射，无任何 import |
| `@types/qrcode` | **dependencies** | 与 `src/renderer/src/types/qrcode.d.ts` 的手写声明重复，且类型包放错位置。二选一：删本项、留手写 stub（改动最小） |
| `@tiptap/extension-document` | dependencies | 0 引用 |
| `@tiptap/extension-drag-handle-react` | dependencies | 0 引用 |
| `@tiptap/extension-table-of-contents` | dependencies | 0 引用 |
| `@tiptap/extensions` | dependencies | 0 引用 |
| `@tiptap/html` | dependencies | 0 引用 |

### 2.2 死代码联动（8）—— 需先删 4 个孤儿文件

下列 8 个包**有 import，但只被 4 个已无任何调用方的文件引用**：

```
src/renderer/src/components/context-room/operations/DocumentContinuationExtension.ts
src/renderer/src/components/context-room/operations/DocumentContinuationToolbar.tsx
src/renderer/src/components/context-room/operations/DocumentOperationReviewExtension.ts
src/renderer/src/components/context-room/operations/DocumentOperationReviewToolbar.tsx
```

证据：`operations/index.ts` 这个 barrel **没有**导出这 4 个文件；全仓检索 `DocumentContinuation*` / `DocumentOperationReview*` 只剩类型名（`documentContinuationState.ts` 引用的是 `presenterRegistry` 的类型，不 import 这 4 个文件）。也就是说：文档续写/审阅的 TipTap 编辑器已被原生编辑器（`office-proto/NativeEditorHost.tsx`）取代，这 4 个文件是重构遗留。

删掉它们后，以下 8 个包一并归零：

`@tiptap/pm`、`@tiptap/react`、`@tiptap/starter-kit`、`@tiptap/markdown`、`@tiptap/extension-image`、`@tiptap/extension-table`、`@tiptap/extension-task-item`、`@tiptap/extension-task-list`

叠加 §2.1 里零引用的 5 个（`@tiptap/extension-document`、`-drag-handle-react`、`-table-of-contents`、`@tiptap/extensions`、`@tiptap/html`）—— **desktop 的 TipTap 栈 13 个包可整体移除**。

> 注意：`@nxcore/gateway` 仍然真实使用 TipTap（`modules/documents/agent-markdown.ts`、`modules/documents/block-index-mark.ts`），gateway 侧**不要动**。

---

## 3. `@nxcore/gateway`：23 个可删依赖

### 3.1 转换管线已迁入 submodule（14）

实现位于 `submodules/everoffice-connectors/gateway-module/email-content.ts` 与 `converters.ts`。gateway 自身源码里这 14 项（10 个库 + 4 个类型包）**零 import**，只剩过时声明：

`rehype-parse`、`rehype-remark`、`rehype-sanitize`、`remark-gfm`、`remark-stringify`、`unified`、`turndown`（+`@types/turndown`）、`html-to-text`（+`@types/html-to-text`）、`mailparser`（+`@types/mailparser`）、`email-reply-parser`、`@types/hast`

可靠性依据：`apps/gateway/tsup.config.ts` 设了 `noExternal: [/^(?!(better-sqlite3|@napi-rs\/canvas|@node-rs\/jieba)$).*/, /^@nxcore\/connectors-module/]`，即除三件原生模块外全部内联打包；submodule 的依赖由它自己的 `package.json` 提供，gateway 无需重复声明。

### 3.2 能力下线后的残留与杂项（9）

| 依赖 | 大小 | 说明 |
| --- | --- | --- |
| `ali-oss` + `@types/ali-oss` | 3.4 MB | 素材/对象存储上传链路已删；全仓 0 引用（`dashscope.aliyuncs.com` 是模型 API 域名，与 OSS 无关） |
| `axios` | 2.0 MB | 唯一引用在 `src/http/logged-axios.ts`，而该文件本身不可达（见 §5）。网关已统一走 `undici`（`infrastructure/network/proxy-fetch.ts`） |
| `jsonata` | 848 KB | 0 引用 |
| `pino-pretty` | 468 KB | 0 引用（pino transport 未配置它） |
| `proxy-agent` | 32 KB | 0 引用；代理已由 `undici` 的 `EnvHttpProxyAgent` 接管 |
| `ajv-formats` | 88 KB | 0 引用 |
| `@types/cross-spawn` | 16 KB | `cross-spawn` 本身未在任何包声明或使用 |
| `@nxcore/connector-contract` | — | gateway 0 直接 import（经 `connectors-module` 间接使用） |

### 3.3 位置错误（2，勿删只移位）

| 依赖 | 现状 | 建议 |
| --- | --- | --- |
| `mammoth` | dependencies，但只有 `tests/office-file-edit.test.ts` 用 | → devDependencies |
| `ws` | dependencies，但只有 `tests/agent.test.ts` 用（生产侧用 `@fastify/websocket`） | → devDependencies（`@types/ws` 已在 dev，无需动） |

---

## 4. submodule 与 packages

### 4.1 `@nxcore/connectors-module`：9 个零引用声明

`axios`、`better-sqlite3`、`drizzle-orm`、`@sinclair/typebox`、`@fastify/type-provider-typebox`、`@napi-rs/canvas`、`pdfjs-dist`、`@nxcore/agent-runtime`、`@nxcore/agent-runtime-pi`

该 submodule 只有 28 个源文件，实际依赖是：`fastify`（仅类型 import，保留）、`jszip`、`mammoth`、`exceljs`、`unpdf`、`turndown`、`html-to-text`、`mailparser`、`email-reply-parser`、`rehype-*`/`remark-*`/`unified`。其余 9 项是切分模块时整块复制过来的，源码里一次都没用到。

### 4.2 `@nxcore/agent-runtime-pi`：`zod`

`zod` 零引用；该包用 `typebox`（已使用）+ `@earendil-works/pi-coding-agent` 的 schema。删。

### 4.3 其余 packages

`agent-contract`、`agent-runtime`、`document-model`、`reality-contract`、`connector-contract`、`migration-kit` 的依赖声明**全部有效**（`@types/*` 属 §1 误报模式；`migration-kit` 的 `better-sqlite3` 被 `tests/sqlite.test.ts` 使用，位置正确）。

---

## 5. 死代码孤岛（依赖失效的根因）

### desktop —— 10 个完全不可达文件

| 文件 | 说明 |
| --- | --- |
| `components/context-room/operations/DocumentContinuationExtension.ts` | TipTap 续写扩展 |
| `components/context-room/operations/DocumentContinuationToolbar.tsx` | 同上 |
| `components/context-room/operations/DocumentOperationReviewExtension.ts` | TipTap 审阅扩展 |
| `components/context-room/operations/DocumentOperationReviewToolbar.tsx` | 同上 |
| `components/agent/AgentInfoView.tsx` | 0 引用 |
| `components/agent/AgentPanelSkeleton.tsx` | 0 引用 |
| `components/agent/LocalAgentAdapterWizard.tsx` | 0 引用 |
| `workbench/home/useAgentOverview.ts` | 0 引用 |
| `shared/knowledge.ts` | 知识库能力已下线，0 引用 |
| `main/migrations/hermes-adapter.ts` | 0 import；但**工作区有未提交改动**，见 §H |
| `renderer/src/{assets,env,i18n/i18next,qrcode}.d.ts` | 环境声明，非死代码（BFS 天然不可达） |

### desktop —— 仅被测试守护的旧外壳（5 个文件）

`office-proto/OfficeProto.tsx`、`office-proto/SettingsView.tsx`、`office-proto/pages/{AgentView,AllFilesView,KnowledgeView,RecentView}.tsx`
应用侧已无引用，只有 `tests/office-proto-{real-file-open,recent-view}.test.tsx` 还在渲染它。属于"测试在保护已下线的原型外壳"，建议连同这两个测试一起清理。

### gateway —— 2 个完全不可达文件

| 文件 | 说明 |
| --- | --- |
| `src/http/logged-axios.ts` | `axios` 的最后据点 |
| `src/modules/slides-layout/parse.ts` | 0 引用 |

另有 4 个只被测试使用的模块，同样值得一并处理：`slides-layout/craft.ts`、`slides-layout/page-structure.ts`、`slides-layout/quality-report.ts`、`slides-layout/tree/v3/skeletons.ts`。

---

## 6. 结构性残留（与"库"无关但同源）

| # | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| S1 | `packages/connector-contract/` 是**空壳目录**（只有 `node_modules/`，无 `package.json`） | 同名真实包在 `submodules/everoffice-connectors/connector-contract`；`pnpm-lock.yaml` 中无该 importer | 删除目录 |
| S2 | `apps/browser-extension/` 是**空壳目录**（只有 `node_modules/`） | 剪藏能力已下线，全仓 0 引用 | 删除目录 |
| S3 | gateway 与 submodule **重复声明**同一批转换库 | 见 §3.1 | 以 submodule 为唯一事实源 |
| S4 | desktop 的 `reality-contract` 只剩 2 处 **type-only** 引用 | `src/shared/sources.ts:113`（`RealityInsights`）、`src/main/cloud/saas-client.ts:26`（`RealityTag`）——现实感知能力已下线 | 清掉这两个类型后即可摘除依赖 |
| S5 | TypeScript 三个版本并存 | gateway/packages `^7.0.2`、desktop `~5.6.2`、submodule `^5.8.0` | 统一（desktop 落后一个大版本） |
| S6 | `@types/node` 两个版本 | gateway `^26`、desktop/migration-kit/submodule `^22` | 统一 |
| S7 | `docx`、`@types/qrcode` 等运行时未用到的包放在 `dependencies` | desktop | 随 §2 移除 |
| S8 | `apps/desktop/build/vision-ocr/` 制品仍在 | OCR 侧车已删，`native/` 源码目录已不存在；该路径已被 `.gitignore` 覆盖 | 本地清理即可，不影响仓库 |

---

## 7. 建议执行顺序

依赖不能先删——先清死代码，再删声明，最后验证。

```bash
# 第 1 步：删死代码（desktop 11 + 2 个 OfficeProto 测试；gateway 2）
git rm -r apps/desktop/src/renderer/src/components/context-room/operations/Document{Continuation,OperationReview}{Extension.ts,Toolbar.tsx}
git rm apps/desktop/src/renderer/src/components/agent/{AgentInfoView.tsx,AgentPanelSkeleton.tsx,LocalAgentAdapterWizard.tsx}
git rm apps/desktop/src/renderer/src/workbench/home/useAgentOverview.ts apps/desktop/src/shared/knowledge.ts
git rm apps/gateway/src/http/logged-axios.ts apps/gateway/src/modules/slides-layout/parse.ts

# 第 2 步：删声明（各包 package.json）
# 第 3 步：重新接线
pnpm install

# 第 4 步：四道验证
pnpm typecheck
pnpm test
pnpm -C apps/gateway build      # 确认 tsup external/noExternal 与打包产物完整
pnpm -C apps/desktop build      # 确认 renderer 打包不再引用 tiptap/radix
```

验证后建议再复查两点：

- `apps/gateway/dist` 里不再出现 `axios` / `ali-oss` / `jsonata` / `pino-pretty`（约 −6 MB 分发体积）。
- desktop 渲染层 bundle 不再包含 `prosemirror-*`（`@tiptap/pm` 的传递依赖）。

---

## 8. 不要误删的清单

这些看起来可疑，实际是**活的**，已逐个回溯：

| 依赖 | 为什么必须留 |
| --- | --- |
| `pdfjs-dist`（gateway / desktop `extraResources`） | `modules/document-understanding/pdf.ts` 用 `require.resolve("pdfjs-dist/package.json")` 取磁盘路径，**无 import 语句** |
| `@napi-rs/canvas`、`@node-rs/jieba`（gateway） | tsup `external` 白名单；原生 `.node` 二进制不能内联 |
| `better-sqlite3`（gateway/desktop/migration-kit） | 同上 + `main/migrations/*` 真实使用 |
| `npm`、`ntn`、`@larksuite/cli`、`@oomol-lab/oo-cli`、`@oomol-lab/open-connector`（desktop devDeps） | 由 `scripts/prepare-*.mjs` 打进 `build/*` 并经 `extraResources` 随包分发，不走 import |
| `electron-updater`（desktop） | `src/main/updater.ts` 由 `main/index.ts:48` 引入，更新链路仍然在线 |
| `@node-rs/jieba`（gateway） | `modules/memory/cjk.ts` 在用（记忆能力在网关侧**仍然在线**，见 §H） |
| `@types/better-sqlite3`、`@types/tar-stream`、`@types/node`、`@types/react*` | 环境全局类型 / 为无类型库补声明，不写 import |
| `tsup`、`tsx`、`drizzle-kit`、`typescript`、`vitest`、`vite`、`electron-*`、`@vitejs/plugin-react`、`@sentry/vite-plugin` | 通过 CLI / 配置文件使用，无 import |

---

## 9. 待确认项（需人工拍板）

| # | 事项 | 现状 |
| --- | --- | --- |
| H1 | `docs/office-agent-only-refactor-plan.zh-CN.md` 声称网关侧记忆模块已删除，但 `apps/gateway/src/modules/memory/**` **仍然注册在** `server/create-server.ts:711/985` 与 `agent/runtime-factory.ts:19` | 文档与代码不一致。若记忆确已下线，这是比依赖更值钱的一整块清理（含 `hippo-memory`、`@node-rs/jieba`） |
| H2 | `main/migrations/hermes-adapter.ts` 不可达，但工作区有未提交修改（`git status: M`） | 疑似在途开发，本次不纳入删除建议 |
| H3 | `main/cloud/**`（SaaS 客户端）中部分文件仅测试可达 | 与 §H1 同源，建议单独审计 |
