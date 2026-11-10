# 资料库/产物查询工具：提示词评审稿

面向主 Agent 的两个文件库工具（`file_search` 定位文件、`file_read` 读正文）。
本文是「模型到底看到哪些字」的完整清单 + 改前/改后逐字对照，用来评审措辞。

- 工具实现：`apps/gateway/src/modules/files/pi-tools.ts`
- 行为守则：`agents/main/SYSTEM.md`
- 装配入口：`apps/gateway/src/server/create-server.ts:755-762`（只挂主 Agent）

---

## 0. 一句话结论

工具描述里的文字**生效**；`SYSTEM.md` 路由表里的文字**生效**；代码里那两个
`promptGuidelines` 字段**从来没生效过**（本仓库 runtime 用自定义 system prompt，框架
不渲染工具级 guideline）。产物库过去在 Agent 眼里根本不存在——`file_search` 没有
「只搜产物」的维度，现在补上了 `scope`。

---

## 1. 模型实际接收到的提示词，按拼装顺序

最终 system prompt 由 `packages/agent-runtime-pi/src/index.ts:935-985` 的
`systemPromptOverride` 拼出，**整体替换**框架默认提示词（所以框架的「Available tools /
Guidelines」两段不会出现）：

| # | 内容 | 来源 |
| --- | --- | --- |
| 1 | 全部 SYSTEM.md 原文 | `agents/main/SYSTEM.md`（`builtin-bundles.ts:85` 读取） |
| 2 | 内置 Skill 全文（`document-export`） | `agents/main/skills/document-export/SKILL.md` |
| 3 | 界面 locale 语言约束 | 运行期 `input.responseLanguage` |
| 4 | 用户画像 | 运行期 `input.userProfilePrompt` |
| 5 | 知识库（wiki）使用说明 | 仅 `config.knowledge` 开启时 |
| 6 | 文稿 vs 连接器工具的分工说明 | 同时挂 `document_*` 与 `connector_*` 时 |
| 7 | `integration.promptGuidelines` | `runtime-factory.ts:172-176`（文稿能力 + 记忆规范） |

工具描述（下面第 2、3 节）不在 system prompt 里，它是 function-calling 的 tools 数组，
随每次请求一起发给模型，模型同样会读到。

---

## 2. `file_search` —— 改前 / 改后逐字对照

### 2.1 工具描述（`description`）

**改前：**

```
在文件库里按文件名子串搜索已入库的文件（Word/Excel/PPT/PDF/Markdown/图片等），返回 fileId 列表。
query 同时匹配原始文件名和显示名（不区分大小写，中文按子串）；extension 可以是单个扩展名或数组。
用户说“那份/之前生成的/叫 XX 的报告”但没给 fileId、或者要改的文件当前没打开时，先用本工具定位 fileId，
再把 fileId 传给 file_read / word_agent_read / word_agent_edit / word_agent_ops / slides_read /
sheets_agent_read / sheets_agent_edit。
用户提到“刚上传的 logo / 之前生成的那张图”时也先用本工具（extension 传 ["png","jpg","jpeg"]）找图片
fileId，再作为图片入参的 fileId。
query 省略 = 按最近更新时间倒序列出（可在 extension 过滤后浏览）。
```

**改后（新增/修改的部分）：**

```
…（前两行不变）
scope 用来对应用户界面上的两个页签：用户说“产物库/你生成的/上次做的”传 artifacts，
说“资料库/我上传的/我的资料”传 library，不提则省略（= 整库搜）。
…（中间三行不变）
query 省略 = 按最近更新时间倒序列出（可在 scope/extension 过滤后浏览）。
每条结果带 scope 字段（产物/资料），可用来核对命中是不是用户说的那一栏。
```

### 2.2 参数表

改前参数：`query`、`extension`、`workspaceId`、`limit`。

改后新增一个参数：

```
scope?: "all" | "library" | "artifacts"
  description: 来源范围：artifacts = 产物库（Agent 生成/产物导入），
               library = 资料库（上传/本地目录/连接器/剪藏等），all 或省略 = 整库
```

### 2.3 返回值

每条结果新增三个字段（原有 `fileId / originalName / displayName / extension / kind /
dataType / workspaceId / updatedAt` 不变）：

```json
{
  "scope": "产物",            // 产物 | 资料（给模型读的中文标签）
  "scopeKey": "artifacts",    // artifacts | library（可回传给 scope 参数）
  "sourceKind": "agent-generated"
}
```

顶层新增 `scope` 回显；空结果 `hint` 会点明查的是哪一栏，并在限定栏位扑空时提示
「确认真没有，再用 scope=all 搜一次整库」；整库命中且两栏都有内容时，提示
「结果里既有产物也有资料，按 scope 字段挑对那一栏再回话」。

### 2.4 被删掉的两段（从未生效）

```ts
promptSnippet: "按文件名搜索文件库、定位 fileId",
promptGuidelines: [
  "用户提到的文件没有 fileId（“那份调研报告”“之前生成的那个 Word/Excel”）或不在打开清单里时，先用 file_search 定位 fileId，再交给 file_read / word_agent_* / sheets_agent_* 读取或修改；不要要求用户先去打开/保存文件。",
],
```

不生效的证据：`@earendil-works/pi-coding-agent/dist/core/system-prompt.js` 的
`buildSystemPrompt` 在 `customPrompt` 分支直接返回，从不渲染 `toolSnippets /
promptGuidelines`；仓库里已踩过同一个坑并在 `apps/gateway/src/modules/memory/pi-tools.ts:11-12`
写明「必须走 integration 级」。删除后在原位留了注释指向 `SYSTEM.md`，避免下次又有人写在这里。

---

## 3. `file_read` —— 改前 / 改后

### 3.1 工具描述：**未改动**（原文如下，供评审是否需要调整）

```
读取用户当前正在浏览的 Office 文件（Word/Excel/PPT/PDF）或指定 fileId 的正文（Markdown）。
fileId 省略 = 用户当前打开/浏览的那个文件；回答“这份文档写了什么”之前先调用本工具，
不要用 document_list/document_read 去猜工作区里的其他文稿。
读的是最近一次保存到磁盘的版本（未保存的编辑不在其中）；长文按 offset/limit 分页，
truncated/nextOffset 标明是否还有后续。空白文件会返回 empty=true。
```

参数：`fileId?`、`offset?`、`limit?`（默认 40000 字符，上限 80000）。

### 3.2 删掉的两段（同样从未生效）

```ts
promptSnippet: "读取当前/指定 Office 文件正文",
promptGuidelines: [
  "用户提到“这份文档/这个表格/这份 PPT/当前打开的文件”时，先用 file_read 读取它，再回答或修改。",
],
```

这两句的语义**没有丢**，已搬进 `SYSTEM.md` 路由表（见 4.2 第 1 行）。

---

## 4. `agents/main/SYSTEM.md` 改动

### 4.1 路由表

改前：

```
| 问当前浏览的 Office 文件内容（Word/Excel/PPT/PDF） | file_read | 省略 fileId 即当前文件；文件不在打开清单里先用 file_search 定位 |
| 不确定用户说的是哪份文件（“那份报告/之前生成的”） | file_search | 按文件名子串搜索文件库，拿到 fileId 后再用具体读写工具 |
```

改后：

```
| 问当前浏览的 Office 文件内容（Word/Excel/PPT/PDF） | file_read | 省略 fileId 即当前文件；用户说“这份文档/这个表格/当前打开的文件”就先读它再回答或修改，文件不在打开清单里先用 file_search 定位 |
| 不确定用户说的是哪份文件（“那份报告/之前生成的”） | file_search | 按文件名子串搜索文件库，拿到 fileId 后再用具体读写工具；不要要求用户先去打开或保存文件 |
| 用户说的是“产物库里的/你生成的那份/上次做的” | file_search（scope=artifacts） | 界面上「产物」页签 = scope=artifacts（Agent 生成 + 产物导入），「资料库」页签 = scope=library；不提哪一栏就省略 scope 搜整库，再按结果里的 scope 字段核对 |
```

### 4.2 「Word 常见说法 → 工具」新增一行

```
- “产物库里那份 PPT / 昨天你做的那个表格”：`file_search` 传 `scope=artifacts`（要 PPT 再带
  `extension=pptx`），拿 fileId 直接干活，不要让用户先在侧栏翻页签。
```

### 4.3 顺带修正

`agents/main/agent.yaml` 的工具清单漏了 `file_read`（该字段目前只作声明、不参与装配，
属于文档不一致），已补。

---

## 5. 产物 / 资料的判据（口径统一）

| 层 | 判据 | 位置 |
| --- | --- | --- |
| 桌面端界面 | `sourceKind ∈ {agent-generated, artifact-imported}` | `apps/desktop/src/renderer/src/workbench/workspace/fileBrowser.tsx:19-26` |
| 桌面端 shared | `ROOM_ARTIFACT_SOURCE_KINDS` | `apps/desktop/src/shared/sources.ts:592` |
| 网关（本次新增） | `ARTIFACT_SOURCE_KINDS` + `FileCatalogScope` | `apps/gateway/src/modules/files/service.ts:54-67` |

三处必须同步，注释里已互相点名。`sourceKind` 全枚举（`schema.ts:1222`）：
`manual-upload / local-folder / connector / migration / web-clipper / legacy-upload` 归资料库，
`agent-generated / artifact-imported` 归产物库。

---

## 6. 需要评审拍板的三个点

1. **参数名 `scope` vs `sourceKind`**：`scope` 是产品语言（页签），模型不用知道内部枚举；
   `sourceKind` 更贴近实现但会让模型直接面对 8 种枚举值。当前选 `scope`。
2. **默认是否收紧**：现在是「不提 = 整库」。另一种做法是「不提 = 当前界面所在页签」，
   但那需要把 UI 焦点塞进 run 上下文（现在只传了 `activeFile`），改动面大，暂不做。
3. **`file_read` 描述未动**：它是读正文的，不涉及两栏区分；是否也要给它加一句
   「产物也可能被直接读」的说明？我判断不需要——`fileId` 已经唯一确定文件。

---

## 7. 改动清单与验证

| 文件 | 改动 |
| --- | --- |
| `apps/gateway/src/modules/files/service.ts` | 新增 `ARTIFACT_SOURCE_KINDS` / `FileCatalogScope`；`searchCatalog` 支持 `scope` 过滤 |
| `apps/gateway/src/modules/files/pi-tools.ts` | `file_search` 增 `scope` 参数 + 结果标注 + 提示语；删两个工具的死 guideline 并留注释 |
| `agents/main/SYSTEM.md` | 路由表 3 行 + Word 常见说法 1 行 |
| `agents/main/agent.yaml` | 工具清单补 `file_read` |
| `apps/gateway/tests/file-search.test.ts` | 新增 3 个用例（服务层 scope、工具透传与标注、默认值与非法值兜底） |

验证：`npx vitest run tests/file-search.test.ts` 13 passed；
`npx vitest run tests/file-read-tool.test.ts tests/workspace-library.test.ts` 15 passed；
`npx tsc --noEmit`（gateway）通过。
