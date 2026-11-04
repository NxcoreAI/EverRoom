# Agent 编辑 Word：headless 会话与结构化操作（实现说明）

> 状态：M1 + B1–B5 + A1–A4 全部落地（2026-10-31），apply_operations 共 69 个 op / 10 个域；干净画布（隐藏操作区）已上线
> 关联设计：`docs/agent-docx-editing-design.zh-CN.md`
> 关联测试手册：`word-agent-test-prompts.md`
> Excel 对等实现：`docs/xlsx-agent-editing-implementation.zh-CN.md`

## 1. 目标

Agent 对任意已入库 `.docx` 的编辑不再依赖“用户已经把文件打开在 GenOffice 编辑器里”：

1. 文件没有打开、页签已关闭、编辑器 UI 被隐藏时，`word_agent_read` / `word_agent_edit` / `word_agent_ops` 仍然可用；
2. 后台编辑不弹页签、不抢焦点、不覆盖用户未保存的输入；
3. 编辑结果落盘并回填文件库版本链，后续打开看到的是最新版本；
4. 能力覆盖 Word 编辑器可完成的文档内容/结构/格式/对象/引用/审阅变更。

## 2. 架构

```
Agent (gateway)
 ├─ word_agent_read    → describe：块列表 + 文档状态 + 工具/操作词汇
 ├─ word_agent_edit    → 现有块级/格式/批注/图表/图片/水印/页面设置工具
 ├─ word_agent_ops     → apply_operations：表格/页面/分节/脚注/域/引用/审阅（B1 已上线）
 └─ word_agent_illustration / file_search
        │  /v1/office-agent-tools
桌面 office-bridge
 └─ OfficePreviewRegistry
     ├─ 有可见可编辑实例 → 活会话（实时重绘 + 脏闸门 + 版本回填）
     ├─ 有只读可见实例   → not_editable（不绕过用户选择）
     └─ 无可见实例       → AgentDocSession（隐藏 docs 视图，同一套渲染层执行器）
            │ fileSaved hook
            └─ importAgentGeneratedFile(fileEntryId 钉住) → 版本 +1 + edited 广播
```

关键原则：**隐藏会话与活会话跑同一份 renderer 工具/操作实现**，不新造 docx 引擎；能力扩展只改 GenOffice 共享层，gateway 只做目标校验与透传。

## 3. 隐藏会话（AgentDocSession）

文件：`apps/desktop/src/main/office/office-agent-doc-session.ts`
接入：`office-preview-registry.ts`（`describeDocArtifact` / `applyDocAgentTools` 无活实例时路由到这里）

- **创建**：`catalogEntry`（legacy `get` 兜底）→ `storagePath` + sha256 → `prepareOfficeDocument` 工作副本 → `createDocsView(path, {hostMode:'everroom'})`。
- **视图**：挂到主窗口 `contentView`，固定 `1100×1400` 布局尺寸、`setVisible(false)`；不调用 `setActiveDocsResolver` / `setActive` / bounds IPC / 首帧闸门，因此不出现在页签清单、不影响用户当前视图。
- **就绪**：渲染层在文档装载完成后通过 `docs:agent-ready` 上报 `filePath`；主进程 `waitForAgentReady(contents, expectedPath, 15s)` 只有路径一致才放行。避免把启动空白文档当成目标文件去写。
- **串行**：每个 fileId 一条 promise 链；创建/describe/apply/销毁互斥。全局最多保留 2 个隐藏会话（LRU），空闲 3 分钟回收。
- **保存与回填**：复用 Registry 的 `editStates` + `onOfficeFileSaved` → 2s 去抖 → `performEditImport`。`apply` 返回前主动 drain 一次导入，回传新 `version`；用工作副本 sha256 更新会话基线。
- **失效**：catalog 当前 hash ≠ 会话基线（外部/其它版本改动）→ 关闭重建；不覆盖。
- **销毁**：`teardownDocsRenderer` → `removeChildView` → `contents.close({waitForBeforeUnload:false})`，**不走** `requestDocsClose`，不弹脏关闭对话框。
- **防护**：CFB 魔数（加密 docx）直接拒绝并提示手动输入密码；单文件上限 100MB；应用退出时硬清理。
- **菜单**：`setDocsMenuGate(() => hasActiveDocInstance())`，后台保存不会用 docs 菜单覆盖应用菜单。

## 4. 结构化操作（apply_operations）

- 渲染层：`apps/desktop/vendor/genoffice/apps/docs/src/renderer/ai/operations/`
  - `types.ts`：`OperationDef` / `OperationContext` / `OperationBatchResult`
  - `table.ts`：B1 表格 ops（注册表 + 参数 schema + 执行）
  - `index.ts`：`runOperations(editor, rawOps, {dryRun, contentWidthPx, document?})`、`describeOperations()`、`OPERATIONS_GUIDE`、上限 50
- 执行语义：按序执行、逐 op 隔离（失败只记录该条，后续继续；若 handler 已改文档则回滚到该 op 前）、支持 `dryRun` 只校验不落盘。
- App 分发：`apply_operations` 在 `ALLOWED_TOOLS` + describe tools 列表；成功后静默保存。
- describe 额外返回 `operationsGuide` 与 `documentState`（分节/页眉页脚/脚注尾注/书签/来源/保护/域/表格/修订/批注），供模型构造 ops。
- Gateway：`word_agent_ops {fileId?, ops, dryRun?}` 只做目标校验与单条 `apply_operations` 透传；op 词汇由渲染层唯一事实源下发，避免双份定义漂移。

### 已上线（B1）

`table.insert / delete / insertRow / deleteRow / insertColumn / deleteColumn / mergeCells / splitCell / setCell / setProperties / autoFit`

### 已上线（B2）

`page.break / blank / cover / numberFormat`、`section.break / set`、`notes.insert / update / delete`、`field.insert / updateAll`

### 已上线（B3）

`format.changeCase / clear / setBidi / hangingIndent / applyStyle / listRestart / listContinue / multilevelList`；
`object.textbox.insert / wordArt.insert / dropCap / equation.insert / symbol.insert / image.format / shape.format`；
`object.image.unsupported`（replace/crop/removeBackground 明确报“需要宿主图片字节”，不假装成功）。

### 已上线（B4）

`reference.bookmark.insert/remove / crossRef.insert / caption.insert / source.add / citation.insert / bibliography.insert / index.mark / index.insert`；
`review.trackChanges / accept / reject / protect / encrypt / findReplace`。
`accept/reject/protect/encrypt` 必须带 `confirm:true`，否则返回 `CONFIRMATION_REQUIRED` 且不改任何东西；修订 id 用 `read_revisions` 返回的 `[rN]`；密码永不回显/落日志（结果只报 `passwordSet`）。

### 已上线（B5：操作区剩余差距）

`format.applyCharacterStyle`（强调/Strong 预设 + 文档字符样式）、`table.setProperties.look`（首行/末行/镶边行等）、
`format.setTabStops`（制表位/前导符，保留 rel stops）、`replaceAllText` 的 `wholeWord/replaceFirstOnly`、
`object.equation.update`（原位再编辑公式）、`format.insertBreak`（换行符/分栏符）、`format.applyListStyle`（自定义项目符号/编号库）。

### 已上线（A1/A2：剩余能力）

- A1（渲染层）：`object.image.replace` / `object.image.crop` / `object.image.removeBackground`（本地容差抠图）、
  `object.shape.zOrder`（导入形状定向 patch `wp:anchor@relativeHeight`）、`object.equation.convert`（块级↔行内）。
- A2（host/gateway）：`word_compare`（两份 docx 段落 LCS 对比）、`word_export_pdf`（LibreOffice 转 PDF → 新文件入库）。
- A3（已完成）：`headerFooter.insertImage/removeImage/replaceImage`（扩展 docx-engine 写 media/rels/drawing，保存后可被 parseDocx 读回）、`object.ink.add / object.ink.mark`（程序化笔画/按段落位置画直线，保存栅格化）、`format.createCharacterStyle`（styles.xml 定向 upsert）。
- A4（口语化易用性）：`object.image.crop` 支持 `unit:"fraction"`（相对自然尺寸，适合“裁中间一半”）；`object.ink.mark` 一句话画下划线/删除线；`headerFooter.replaceImage` 一步换页眉页脚图；documentState 标注 `sizeBasis:"display"`。

### 全部操作词汇（63 个）

| 域 | 数量 | op |
|---|---|---|
| table | 11 | insert / delete / insertRow / deleteRow / insertColumn / deleteColumn / mergeCells / splitCell / setCell / setProperties（含 look）/ autoFit |
| page | 4 | break / blank / cover / numberFormat |
| section | 2 | break / set |
| notes | 3 | insert / update / delete |
| field | 2 | insert / updateAll |
| format | 13 | changeCase / clear / setBidi / hangingIndent / applyStyle / applyCharacterStyle / createCharacterStyle / setTabStops / insertBreak / applyListStyle / listRestart / listContinue / multilevelList |
| object | 16 | textbox.insert / wordArt.insert / dropCap / equation.insert / equation.update / equation.convert / symbol.insert / image.format / image.replace / image.crop / image.removeBackground / shape.format / shape.zOrder / ink.add / ink.mark / image.unsupported |
| reference | 9 | bookmark.insert/remove / crossRef.insert / caption.insert / source.add / citation.insert / bibliography.insert / index.mark / index.insert |
| review | 6 | trackChanges / accept / reject / protect / encrypt / findReplace |
| headerFooter | 3 | insertImage / removeImage / replaceImage |

**明确不支持（返回清晰错误，不伪造成功）**：图片替换/裁剪/去背景（需要宿主图片字节，改用 `insert_image_base64`/重插+删块）、导入形状的 z-order（原始锚点不可改）、`wholeWord`/仅替换第一处、字符样式 id。

## 5. 读与发现

- `word_agent_read` 对任意 docx（打开或未打开）返回块列表、工具词汇、`commandsGuide`、`htmlRules`、`watermark`、`pageSetup`、`operationsGuide`、`documentState`。
- `file_search`（gateway pi tool）：按文件名子串 + 扩展名 + 工作区搜索文件库，返回 `fileId`。用户只说“那份报告”且文件没打开时，先搜索再编辑。
- gateway 的 `word_agent_*` 目标解析改为**元数据校验**（不读整份 docx 字节），去掉了 25MB 单次编辑上限；大文件由桌面侧上限与超时保护。
- `/v1/office-agent-tools` 可携带 `roomId/workspaceId`，后台会话回填版本链时保留 Room 投影。

## 6. 错误模型

| 场景 | 返回 | 行为 |
|---|---|---|
| 未打开/UI 隐藏，catalog 有文件 | 正常 | 后台会话编辑，版本 +1，不弹页签 |
| 可见可编辑实例 | 正常 | 活会话（实时重绘/脏闸门） |
| 可见只读实例 | `not_editable` | 不绕过；提示重新以可编辑方式打开 |
| 活实例有未保存修改 | `unsaved` | 提示先保存 |
| 文件不存在/已删除 | `not_found` | 不创建会话 |
| 加密 docx（CFB） | `encrypted` | 提示手动打开输入密码 |
| 损坏/加载超时 | `open_failed` | 15s 内未就绪即失败，不写空白文档 |
| 外部版本改动 | — | catalog hash 变化 → 重建会话，不覆盖 |
| 保存失败 | `save_failed` / apply.error | 不谎报成功；保留会话以便重试 |
| 超过 100MB | `too_large` | 明确拒绝 |

## 7. 验证

- GenOffice docs：`apps/docs/tests/operations.test.ts`（B1 23 例）、`commands.test.ts` 回归；`npm run typecheck -w @genoffice/docs`。
- Desktop：`apps/desktop/tests/office-agent-doc-session.test.ts`（隐藏会话生命周期/就绪/复用/重建/加密/串行/清理）、`office-preview-registry.test.ts`（隐藏会话不进页签清单、只读不绕过）、`src/main/gateway/office-bridge.test.ts`（docx 不再广播 open-edit）；全量 736 例通过。
- Gateway：`word-agent-ops.test.ts`、`file-search.test.ts`、`office-bridge-client.test.ts` 等 41 例通过；`tsc --noEmit` 通过。
- Runtime：`apps/desktop/scripts/prepare-genoffice-runtime.mjs` 重建后，`build/genoffice-runtime/docs/main/embed.js` 导出 `waitForAgentReady` / `setDocsMenuGate`，renderer bundle 含 `apply_operations` / `operationsGuide` / `documentState`。
- 手动：`word-agent-test-prompts.md` 第八组（headless）与第九组（ops）。

## 8. 已知边界

- 后台会话默认不弹页签；用户想边看边改时自行打开文件（打开时隐藏会话会先排空并关闭，避免双写者）。
- 只读打开是用户显式选择，agent 不绕过。
- 加密 docx 需用户先手动输入密码；legacy `.doc` 依赖 LibreOffice 转换。
- 图片替换/裁剪/本地容差去背景、页眉页脚图片、程序化 ink、新建字符样式、形状 z-order、公式互转、文档比较、PDF 导出均已支持；
  自动主体分割（AI 去背景）仍不支持（只用本地容差抠图）。
- 物理打印不可由 agent 完成：`word_export_pdf` 导出后由用户/宿主打印。
- 剪贴板、视图/缩放等非文档内容操作不在 ops 范围（用 insert/replace/move 或宿主能力覆盖）。
- 页眉页脚图片当前只接默认 header/footer part；ink 页面相对定位在页首附近最精确；`word_compare` 只比段落文本。
## 9. 干净画布（隐藏操作区，只留正文）

> 用户要求：GenOffice 编辑器的**操作区**（Ribbon/工具栏/命令入口）可以隐藏，正文画布保留，由 agent 承担全部操作；隐藏操作区不能降低可用能力。

实现：
- docs 渲染器新增 `chromeHidden` 状态：EverRoom embed 下**默认隐藏**；localStorage `aidocs.chromeHidden` 记住用户选择；standalone 默认显示。
- 根节点加 `chrome-hidden` class，隐藏 `.ribbon / .status-bar / .nav-pane / .ruler / .hf-variant-chips`；正文画布、查找/批注/比较面板、对话框保留。
- 恢复入口：右上角半透明「显示工具栏」胶囊（`chrome-restore`）、`⌘⇧F` 切换、宿主 IPC `setDocsChromeHidden(contents, hidden?)`。
- EverRoom 宿主：`OfficePreviewRegistry.setDocsChromeHidden(fileId|'active', hidden?)` + `office:chrome-toggle` IPC + `window.desktop.office.toggleChrome({fileId?, hidden?})`，供顶栏/菜单/快捷键接入。
- Agent 的所有工具/op 直接调用编辑器内部命令与 helper，**不经过 Ribbon**，因此操作区隐藏不影响能力；操作区 → agent 对照见 `docs/word-agent-operation-coverage.zh-CN.md`。
