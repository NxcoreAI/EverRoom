<div align="center">

<img src="./everroom_logo/everroom_full.png" width="320" alt="EverRoom">

**本地优先的工作空间：用可治理的 AI Agent 生产真正的 Office 文档。**

Agent 起草 · 逐条审阅 · 导出可交付的 Office 文件

[English](./README.md) | [简体中文](./README.zh-CN.md) | [官网](https://r.nxcore.ai/)

[![Star History Rank](https://api.star-history.com/badge?repo=NxcoreAI/EverRoom&type=rank)](https://www.star-history.com/nxcoreai/everroom)
<a href="https://trendshift.io/repositories/178463?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-178463" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/178463/daily?language=TypeScript" alt="NxcoreAI%2FEverRoom | Trendshift" width="250" height="50"/></a>

![Stars](https://img.shields.io/github/stars/NxcoreAI/EverRoom?style=flat&label=stars)
![Version](https://img.shields.io/github/package-json/v/NxcoreAI/EverRoom?filename=apps%2Fdesktop%2Fpackage.json&label=version)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)

</div>

> [!IMPORTANT]
> Everroom 当前处于 Alpha 阶段，macOS 是主要开发目标。产品和 API 正在快速迭代，部分能力需要可选的本地服务或模型配置。

## Everroom 是什么？

Everroom 是一个本地优先的桌面工作空间，用来和 AI Agent 一起生产真正的 Office 文档。导入本地文件、代码仓库和已连接的服务，然后在内置 Office 编辑器里自己撰写 Word 文档、表格和演示文稿，或者交给 Agent 会话起草、改写和填充。

这里的 Agent 不是接在文件库旁边的聊天框：它在明确的会话与 run 中工作，只拿到当前请求需要的工具和文档，并把文档改动作为可审阅的操作提交，最终是否落到文件里由你决定。

> **让 Agent 起草，把最终决定权留给自己。**

### 产品闭环

1. **导入素材：** 引入本地文件与文件夹、代码仓库，以及飞书、Slack、Notion、Gmail 等已连接服务。
2. **生产 Office 产物：** 在内置 Office 编辑器里创建 Word 文档、表格和演示文稿，或让 Agent 起草。
3. **逐条审阅改动：** Agent 的写入与修改以 patch 和文档操作的形式呈现，确认后才成为文档的一部分。
4. **持续推进工作：** 有边界的 Agent 会话、定时 run、dispatch-only 子 Agent 和通知承担重复与长耗时任务。

## 为什么需要 Everroom？

当 AI 拿到正确的素材、并且有一个真正能落地的地方时，给出下一步并不难。真正困难的是此前的工作：把源材料导进来，产出同事能直接打开的文件，并让自动改动始终可审阅，而不是悄悄重写你的文档。

Everroom 补上的正是这一层。它面向文档、文件和已连接服务构建本地工作空间，并让 Agent 作用于真实的 Office 产物；它不是另一个聊天客户端、简单的 RAG 界面，也不是默默堆积未审阅产出的自动化工具。

产品主张很简单：

> **Agent 的产出应当落进真实文档，被限定在具体任务内，并且清晰到足以由文件所有者审阅。**

产品遵循四项原则：

- **本地优先：** 数据、文档、索引和凭据默认保存在用户设备上。
- **先审阅再落地：** Agent 改动以操作和 patch 的形式提出，而不是静默覆盖。
- **自动化但可治理：** Agent 获得明确、临时且可撤销的工具权限。
- **底座可替换：** 模型、连接器和 Agent runtime 均通过 Everroom 自有接口接入。

只有当人能够检查改了什么、修正它，并让修正进入下一次任务时，生成稿才真正有用。

## 产品模型

| 概念 | 在产品中的作用 | 它所保护的边界 |
| --- | --- | --- |
| **Documents** | 支持版本化、块级编辑的 Word 文档、表格和演示文稿 | 确保最终产物仍由人掌控 |
| **Agent** | 拥有明确工具、会话、run 记录和取消能力的任务执行者 | 让自动化能够被检查、停止和替换 |
| **Sources** | 汇集本地文件、文件夹和代码仓库的统一素材库；连接器由 Agent 即席查询 | 让 Agent 可读的素材只有一个入口 |
| **Connectors** | 通过 OpenConnector MCP 即席检索外部资料；不做定时同步、不留内容副本 | 用用户自己的凭据触达外部数据，Everroom 不存储 |
| **Schedules** | 周期性 Agent run 与 dispatch-only 子 Agent | 长耗时工作始终可见、可中断 |

原始文件和解析后的 Markdown 只有一个存储所有者：文档与 Agent run 通过稳定引用、哈希和溯源信息使用它们，而不是复制多份。

### 一次 Agent 会话如何工作？

Agent 不会绕过你远程改文档，它走的是和人一样的提交路径：

1. 会话被限定在某个工作区、一组工具和当前涉及的文档上。
2. 文档写入与修改以版本化文档上的显式操作或 patch 打开。
3. 待定 hunk 出现在编辑器里供审阅，由你接受或拒绝。
4. 接受后的改动通过文档内核提交，生成带操作历史的新版本。
5. 聚焦的任务可以派发给子 Agent，它们会汇报自己的调用时间线，也可以被取消。

### 产品边界

Everroom 刻意收窄范围：不做自治多 Agent 集群、不做企业管理，也不强制云端同步。重点是可信的本地文档工作，以及一个你能审阅的 Agent。

## 当前进度

仓库当前保留 Office + Agent 这一产品面。部分能力需要可选的本地服务或模型配置；使用隔离的开发 runtime 时，桌面应用仍可正常启动。

| 模块 | 状态 | 当前能力 |
| --- | --- | --- |
| 桌面工作空间 | 已可用 | Electron + React 工作空间，包含首页、文档、数据源、文件、Office、定时任务、Agent 连接和设置 |
| NxCore Gateway | 已可用 | 由 Electron 管理的独立 Fastify 服务，覆盖 REST / WebSocket / OpenAPI 边界、健康与就绪检查 |
| Office 文档 | 已可用，持续完善 | Word 文档、表格与演示文稿的内置编辑器、版本化提交、可审阅的 Agent patch 和 PDF 导出 |
| 文件与导入 | 已可用，持续完善 | 本地文件浏览、文件夹与 Obsidian 导入、Markdown / 文本与 Office / Web 内容解析、内容哈希与溯源，以及访达「打开方式」直接打开 Word / Excel / PPT |
| Agent 服务 | 已可用 | 持久化会话、run 记录、流式事件、取消，以及文档与文件范围的工具 |
| Agent 工作管理 | 已可用，持续完善 | Agent Office 状态、定时 run、dispatch-only 子 Agent、通知和手动执行 |
| Connectors | 基础能力已可用 | Agent 通过 OpenConnector MCP 即席检索（Gmail、Notion、Drive、Calendar、Outlook、Slack）；无后台同步 |

### 在访达中直接打开 Word / Excel / PPT

桌面端把 EverRoom 注册为 `.docx`、`.doc`、`.xlsx`、`.xls`、`.pptx`、`.ppt` 的备选打开方式。在访达里右键文档，选择**打开方式 → EverRoom**（也可以把它设为该类文件的默认程序）。EverRoom 会把文件导入本地文件库，并用内置 Office 编辑器打开——`.docx`、`.xlsx`、`.xlsm`、`.pptx` 可直接编辑。保存会把编辑结果写回磁盘上的原文件（Word、WPS、Keynote 打开也能看到新内容），同时在文件库为该条目生成新版本。之后它也会出现在「文件」页里。

> 开发态首次 `pnpm dev` 会重建带品牌信息的 Electron 应用并注册文档类型。若访达的「打开方式」里仍没有 EverRoom，再重启一次开发应用，让 LaunchServices 重新扫描。

## 快速开始

### 环境要求

- macOS
- Node.js 22 或更高版本
- pnpm 11.15.1，或兼容的 pnpm 11 版本

### 启动桌面应用

```bash
git clone https://github.com/NxcoreAI/Everroom.git
cd Everroom
pnpm install
pnpm dev
```

`pnpm dev` 会启动 Electron 和 Renderer，并由 Electron 以 watch 模式管理独立 Gateway。Gateway 默认使用动态 loopback 端口，避免多个开发实例冲突；修改 Gateway TypeScript 代码后会自动重启。需要固定端口时设置 `NXCORE_GATEWAY_DEV_PORT=4100`。

桌面端侧栏左下角会展示 Gateway 当前状态与进程 PID。

### Agent 服务

Gateway 会读取仓库根目录的 `.env`，也兼容 `apps/gateway/.env` 和通过 `NXCORE_ENV_FILE` 指定的文件。默认使用隔离的 `fake` runtime，确保没有模型密钥时桌面应用仍可启动。需要真实 Agent 时，配置内置 Pi runtime：

Gateway 中的生成式模型调用统一通过 `AgentResolver` 按稳定 ID 选择 Agent。主对话、Connector 同步、Cursor Completion、文档子 Agent 和 Web Search 都拥有独立的 Runtime 与 `config/sessions/workspace` 目录；业务模块不直接调用 LLM API。

```dotenv
NXCORE_AGENT_RUNTIME=pi
NXCORE_AI_PROVIDER=openai
NXCORE_AI_MODEL=gpt-5.2
NXCORE_AI_BASE_URL=https://api.openai.com/v1
NXCORE_AI_API_KEY=
NXCORE_AI_API=openai-responses
```

NxCore Gateway 同时提供受 Bearer Token 保护的 `/v1/mcp/documents/:sessionId` Streamable HTTP MCP 入口，供经过认证的 MCP 客户端使用。

<details>
<summary><b>文件驱动的子 Agent（目录结构、agent.yaml 与约束）</b></summary>

子 Agent 只能被主 Agent 或 Gateway 内部工作流调度，不提供独立聊天入口，也不需要管理页面。Gateway 默认扫描仓库根目录的 `agents`。该目录在 Gateway 构建时复制到 `dist/agents`，并随 Desktop 一起打包；开发或测试时可以通过环境变量临时覆盖：

```dotenv
NXCORE_SUBAGENTS_ENABLED=true
NXCORE_SUBAGENTS_DIR=/absolute/path/to/everroom-agents
```

每个一级子目录代表一个 Agent：

```text
everroom-agents/
└── mail-researcher/
    ├── agent.yaml
    ├── SYSTEM.md
    └── skills/
        └── summarize/
            └── SKILL.md
```

最小 `agent.yaml`：

```yaml
schemaVersion: 1
id: mail-researcher
name: 邮件研究员
description: 检索邮件并返回带来源的摘要
mode: dispatch_only
systemPrompt: ./SYSTEM.md
skills:
  - ./skills/summarize
mcp:
  - server: gmail
    includeTools: [search_messages, get_message]
policy:
  allowedCallers: [primary-agent]
  timeoutMs: 300000
  maxConcurrency: 1
  maxToolCalls: 40
```

`mcp.server` 引用设置中已有的全局 MCP 服务器名称，子 Agent 只会看到自己绑定并通过 `includeTools` 筛选后的服务器。修改目录内容后重启 Gateway 会自动生成新的不可变 Revision；已有 Invocation 继续使用原 Revision。完整约束见 [`docs/subagent-framework-design.zh-CN.md`](./docs/subagent-framework-design.zh-CN.md)。

每个 `SKILL.md` 必须包含 `name` 和 `description` YAML frontmatter。子 Agent 通过受限 `read` 工具读取自己的 Skill 快照，不能借此读取工作区或设备上的其他文件。MCP 的 `includeTools` 必须显式填写；需要开放服务器全部工具时使用 `["*"]`。

</details>

### 常用命令

```bash
pnpm dev          # 启动桌面端与 Gateway
pnpm typecheck    # 检查所有 workspace 包的类型
pnpm test         # 运行 Agent runtime 与 Gateway 测试
pnpm build        # 构建 Gateway 与 Electron
pnpm package:mac  # 生成 macOS DMG 与 ZIP
pnpm package:win  # 生成 Windows x64 NSIS 安装包
```

<details>
<summary><b>构建 Windows 安装包</b></summary>

`pnpm package:win` 与 macOS 构建走同一条链路 —— Gateway、OpenConnector、oo CLI、GenOffice runtimes（含 Rust `xlsx-sidecar.exe`）、打包环境，最后执行 `electron-builder --win nsis --x64`。前置要求：

- Node 22 与 `packageManager` 固定的 pnpm 版本（`corepack enable`）
- Rust 工具链（`cargo`），用于 GenOffice xlsx sidecar
- `git submodule update --init --recursive`（GenOffice）
- `apps/desktop/scripts/generate-packaged-env.mjs` 所需的打包环境变量；本地测试构建使用占位值，切勿使用生产密钥

未签名的安装包输出到 `release/EverRoom-<version>-windows-x64.exe`。可通过 `pnpm --filter @nxcore/desktop exec node scripts/verify-windows-package.mjs` 免安装验证。脚本化安装时可使用 `/S`（静默）与 `/D=<dir>` 指定目标目录。由于构建未签名，Microsoft Defender SmartScreen 可能会在首次启动前提示。

</details>

## 技术架构

Everroom 保持产品边界稳定，同时允许底层引擎替换。桌面端负责生命周期与信任边界；NxCore Gateway 负责本地编排与持久化；连接器和 Agent runtime 各自维护自己的数据契约。Renderer 无法直接访问数据库、文件系统或 Gateway 凭据；所有 IPC 请求由主进程处理，再转发给 Gateway。

### 实现策略

- **一份资产，多处引用。** 原始文件与解析后的 Markdown 只有一个存储所有者，文档与 Agent run 通过稳定引用、哈希和溯源信息使用它们，而不是复制多份。
- **有边界的上下文。** Agent 只会获得当前请求需要的文档、文件和工具，而不是无边界的全局语料。
- **先提交，再执行副作用。** 文档修改先通过事务化提交内核与 outbox 落盘，外部服务失败不会破坏权威文档版本。
- **确定性的外部操作。** Connector 检索基于真实 action schema 和连接准备，凭据留在可信进程中；当前版本只放行只读 action，写操作后续需显式确认。
- **优雅降级。** Fake Agent、不可用连接器和模型错误都有明确状态，可选服务缺失不会让本地文档不可访问。

### 技术栈

| 层级 | 技术 |
| --- | --- |
| 桌面端 | Electron 39、React、TypeScript、electron-vite |
| Gateway | Node.js 22+、Fastify 5、TypeBox、REST、WebSocket、OpenAPI |
| 存储 | SQLite WAL、better-sqlite3、Drizzle ORM、FTS5、内容寻址对象 |
| 文档 | Tiptap 文档模型、版本化提交、块引用、操作内核 |
| Office 产物 | 内置 GenOffice runtime，生成 docx、xlsx 与 pptx |
| Agent 边界 | 共享 Agent 契约、Pi runtime adapter、MCP 文档端点 |
| 连接器 | OpenConnector MCP bridge、`oo` HTTP 客户端、每 provider 查询档案 |
| 可观测性 | Pino 结构化日志、可读终端输出、按日切分的 JSON 日志 |
| 验证 | Vitest、严格 TypeScript 检查、Gateway 与 runtime 集成测试 |

## Gateway 与本地数据

桌面开发模式下，Electron 会从运行时清单发现 Gateway 地址，默认端口是动态分配的，避免多个本地实例冲突。需要固定开发端口时设置 `NXCORE_GATEWAY_DEV_PORT`：

- API 地址：`http://127.0.0.1:<动态端口>`
- OpenAPI UI：`http://127.0.0.1:<动态端口>/docs`
- 存活检查：`GET /v1/health/live`
- 就绪检查：`GET /v1/health/ready`

健康检查和 API 文档可以通过本地回环地址直接访问，其余接口需要 Electron 生成的临时 Bearer Token。Token 只保存在主进程，不会暴露给 Renderer。

Gateway 也可以独立启动：

```bash
pnpm --dir apps/gateway dev -- \
  --data-dir .data \
  --port 4100 \
  --token local-development-token
```

macOS 默认运行时目录：

```text
~/Library/Application Support/NxCore/
├── database/   # Gateway 与文档数据库
├── logs/       # Gateway 按日切分的 JSON 日志
├── objects/    # 内容寻址的来源与解析对象
├── runtime/    # 临时 Gateway 发现清单
└── open-connector/  # 托管连接器运行时与 CLI 数据
```

Windows 上相同布局位于 `%APPDATA%\EverRoom\`（即 `C:\Users\<user>\AppData\Roaming\EverRoom\`）。设置 `NXCORE_DATA_DIR` 可迁移该目录。

Gateway 日志命名为 `gateway.YYYY-MM-DD.N.log`，每天零点切分，保留 30 个历史文件，并自动脱敏已知凭据。终端日志使用可读的本地时间。

服务端细节见 [`apps/gateway/README.md`](./apps/gateway/README.md)；OpenConnector 生命周期与安全边界见 [`docs/open-connector-desktop-integration.zh-CN.md`](./docs/open-connector-desktop-integration.zh-CN.md)。

## 安全模型

- 数据、文档、索引和凭据默认保存在用户设备上。
- Gateway 只监听本地回环地址，每次桌面会话使用新的高熵 Token。
- Renderer 只能访问类型化 preload API；文件系统、数据库、模型 Token 和连接器凭据保留在可信进程中。
- 原始来源以内容寻址方式保存版本，文档历史记录每一次被接受的改动。
- 云服务、远程模型和外部 Agent 均为可选能力，并且只应获得用户批准的文档或任务范围。
- 日志会自动脱敏敏感请求头与凭据，托管连接器配置文件使用受限权限。
- 对外产生影响的操作与只读上下文收集相互分离，并应经过明确的准备与确认边界。

## 仓库结构

```text
Everroom/
├── apps/
│   ├── desktop/          # Electron main、preload 与 React renderer
│   └── gateway/          # 独立本地后端服务
├── packages/
│   ├── agent-contract/   # 共享 Agent 协议与事件类型
│   ├── agent-runtime/    # Runtime 接口与开发 adapter
│   ├── agent-runtime-pi/ # Pi runtime adapter 与 Agent 工具
│   ├── document-model/   # 纯文档规范化与块引用
│   └── reality-contract/ # 共享协议与事件类型
├── submodules/
│   └── everroom-connectors/  # 连接器契约、Gateway 模块与桌面宿主
└── docs/                 # 产品、架构和实施说明
```

## 路线图

当前重点是让本地工作闭环更可靠、更容易扩展：

1. 深化 Office 生产能力：更丰富的 Word、表格与演示文稿生成、模板保真度和可靠的导出。
2. 改善审阅体验：更清晰的 patch 审阅、冲突处理和 Agent 改动的操作恢复。
3. 扩展文件与导入体验，覆盖本地文件夹、GitHub、飞书、网页内容和连接器数据。
4. 让 Agent 会话更可靠：长耗时 run、子 Agent 交接、定时任务和通知。
5. 扩展可替换 Agent adapter，逐步接入 Codex、Claude Code 和 OpenCode。
6. 扩大移动端与桌面端的双向同步和 Agent 控制能力，同时保持本地权限边界清晰。
7. 提升 Windows 支持、隐私排除、安装体验和发布稳定性。

自治多 Agent 集群、企业管理和强制云端同步仍不属于当前首版范围。

## 致谢

Everroom 建立在众多开源项目和理念之上：

- [Electron](https://www.electronjs.org/) 与 [React](https://react.dev/) 提供桌面应用基础。
- [Fastify](https://fastify.dev/)、[TypeBox](https://github.com/sinclairzx81/typebox)、[Drizzle ORM](https://orm.drizzle.team/) 和 [SQLite](https://www.sqlite.org/) 提供本地服务与存储层。
- [Pi](https://github.com/earendil-works/pi) 与 Model Context Protocol 生态为可替换 Agent runtime 方向提供基础。
- OOMOL 的 [OpenConnector](https://github.com/oomol-lab/open-connector) 与 [`oo-cli`](https://github.com/oomol-lab/oo-cli) 提供本地 Connector Bridge。
- [Liminon](https://liminon.ai/) 为 AI 工作流和上下文产品方向提供启发。

## 开源协议与贡献

Everroom 以 [Apache License 2.0](./LICENSE) 开源。第三方组件仍适用各自的上游许可证；请以对应目录中的许可证和声明文件为准。

社区版计划包含桌面客户端、Office 文档体验、Agent runtime 边界、本地 Connector 和扩展 SDK。托管同步、团队管理、企业控制与托管连接器基础设施可能单独提供。

Everroom 仍处于早期阶段，接口会持续演进。当前有价值的贡献方向包括 Connector、Agent adapter、Office 文档与导出质量、文档操作、测试、文档和隐私审查。开始大规模架构改动前，请先创建 Issue，确保实现与当前契约和路线图保持一致。