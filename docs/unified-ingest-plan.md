# 统一理解引擎：Room / Wiki / 记忆三链路归一接入 — 实施方案（v1 草案）

> 状态：**草案，待拍板**（未写任何实现代码）
> 日期：2026-08-18
> 范围：`apps/gateway`（新增 `modules/ingest` 理解引擎模块，主体）、`apps/desktop`（统一导入入口）、既有 `modules/knowledge` / `modules/memory` 少量重构
> 与既有方案的关系：**不改** room-wiki-plan / entity-room-plan 的路由瀑布与晋升制，**不改** memory-md-source-plan 的 MemoryCore 文档子系统——本方案是它们**上游的统一进水口**；memory-md-source-plan §7 的 importMarkdown 保留自身存储逻辑，扇出并入本方案引擎（MemoryCore 侧 API 不变）
> 前置阅读：`docs/entity-room-plan.md`（实体晋升制，Room 链路现状）、`docs/memory-md-source-plan.md`（记忆文档链路现状）
>
> **2026-08-21 后续决策**：本地手动文件和目录扫描文件的存储、版本化解析、连接器文件准入及 FilesPage 聚类，改由 `docs/files-unified-catalog-and-ingest-plan.zh-CN.md` 规定。该专项方案覆盖本文 U8 中“本地 path 只读不拷贝”的部分；U9“modules/files 是唯一字节入口”继续有效。

## 1. 背景与问题

### 1.1 现状：三套入口、三种格式约束、零共享策略

| 链路 | 入口 | 收什么格式 | 收什么类型 | 判重/资产 |
| --- | --- | --- | --- | --- |
| Room（实体引擎） | `POST /v1/knowledge/files`（submitFileUpload）、`POST /v1/knowledge/route/manual`（外部信封）、`document.committed`（内部文档①直连） | 仅 `.md/.markdown`（file-convert 其余 415） | 文件 / 信封 | uploaded_files/parsed_contents + 四道闸门 |
| Wiki（KS Room wiki） | 无独立入口——挂在 Room 链路上（晋升/命中已晋升实体时 raw/write + ingest） | 同上（同一条链） | 同上 | KS 确定性文件名（闸 4） |
| 记忆（MemoryCore） | `POST /v1/memory/import/markdown`（importMarkdown）、pi agent 会话 auto-capture | 仅 md 文本 | 文档 | 复用 file-storage 原语，但**自成一套编排**（不走 knowledge 路由） |

具体问题：

1. **同一份资料想"既进 Room 又提炼记忆"没有通道**——两个入口互不相通，用户得传两遍，且两遍各自资产化、各自判重，没有一致的身份与状态；
2. **格式面窄且不一致**：knowledge 拒绝非 md，memory 只收 md 文本（连文件都不收）；会议纪要（reality_events 里有现成数据）、office 文件（docx/xlsx/pptx）完全没有进入通道；
3. **"什么类型该进哪条链路"是隐式的**——md 文件默认全走 Room 链，记忆导入默认只走记忆，没有一个可配置的策略面；表格类文件该不该提炼 L1 记忆、超长逐字稿该不该整篇进 wiki，目前连表达这种意图的地方都没有；
4. **无统一台账**：一份资料进了哪些链路、各自什么状态，散在 route_decisions / entities / MemoryCore documents 三处，用户不可见。

### 1.2 已否决的备选（勿回退）

- **"一个大 LLM 理解管线"**（一次调用同时产实体 + 记忆原子 + 知识页）：三条链路各有专用 prompt、模型与成本节奏（实体抽取开集输出 / L1 文档模式提炼 / KS ingest-v2 合并），强行合一会把三个独立演进的认知环节耦成单点，一次改 prompt 三处回归。**引擎统一"进入"，不统一"理解"**——归一化只做一次，理解各链路自理。
- **独立第四服务进程**（引擎单独起进程）：gateway 已持有全部编排状态（jobs 队列、SQLite、KS/MemoryCore 客户端），拆进程只增加运维面与 IPC；模块级内聚（`modules/ingest`）足够。
- **大一统 sources 表收编 documents/reality_events/uploaded_files**：资料本体留各自表（DocEnvelope 原则），引擎只发 `ref` + 资产指针，新增资料源零迁移。
- **引擎收编上传存储**（v1 草案曾设计 multipart 字节进引擎、拷贝入对象库）：2026-08-18 拍板否决——**引擎零原文存储，只收路径/引用**。上传与对象库归既有链路（knowledge submitFileUpload / file-storage 原语），引擎在其下游消费。

## 2. 目标与非目标

**目标**

1. **单一入口** `POST /v1/ingest`：只收"有家"数据（本地路径或库表引用）；md 与 json 两种内容格式，任一入口进来的资料走同一条归一化管道；
2. **格式扩展**：md / txt / html / csv / PDF / Word / Excel / PowerPoint / OpenDocument / json（Tiptap 文档、会议纪要、generic 结构）→ 统一归一化为 markdown + 元数据；
3. **数据类型注册表**：`document / meeting-minutes / office-doc / spreadsheet / slides / html / …` 开放集合，类型由显式声明 > jsonType 映射 > 扩展名推导；
4. **链路策略可配置**：每个数据类型可配置进入哪几条链路 `{room, wiki, memory}`（代码 defaults ⨝ 部署期配置文件，2026-08-19 修订：策略不是用户数据，无用户写入口），且单次请求可覆盖；
5. **零原文存储**：原文的落盘/拷贝归调用方与既有上传链路，引擎只读不拥有；引擎自身仅持久化解析产物（归一化 md）与台账/策略（2026-08-18 拍板，定死）；
6. **统一台账**：ingest_events 记录每次进入的类型、策略与扇出结果，用户可见"这份资料进了哪儿"；
7. **文件管理中心 + 统一上传接口**：`POST /v1/files` 成为全系统接收文件字节的唯一通道（对象库/登记表归 `modules/files` 所有，自 knowledge 移交）；桌面新增"文件"应用管理全部受管文件（§8）。

**非目标（本期不做）**

- 不改三条链路本体的任何认知逻辑（实体抽取/解析/晋升、KS ingest、MemoryCore L1-L3 提炼）；
- 不收编会话链路（pi agent auto-capture → L0 照旧）与 everroom-doc 的 ① 直连通道（零成本路径，ED5 不动）；
- 不做 pdf（文本层提取放下期）、邮件/云盘/网页剪藏连接器（按本引擎的 json 信封契约后续接入）；
- 不做多用户 ACL（表结构预留，与 room-wiki-plan 一致）。

## 3. 总体架构

```text
入口：desktop 统一导入对话框 / 文件管理页 / Room 知识库 Tab / MemoryPage / 连接器信封
   │   ①统一上传 POST /v1/files（multipart）→ 文件管理中心 modules/files
   │      （对象库 + uploaded_files，全系统唯一字节入口，§8）→ 得 fileId
   │   ②POST /v1/ingest（source = {path} | {ref: file-* …}，只收有家数据）
   ▼
┌─ 理解引擎  apps/gateway/src/modules/ingest（新增）──────────────────────┐
│                                                                        │
│  ① 接收 intake：source 校验（path 可读 / ref 可解析）→ 格式推导          │
│  ② 归一化 normalize：normalizers/ 分发 → 统一 IngestUnit                │
│      md 直通 / json{tiptap|meeting-minutes|generic} / office·html·csv  │
│  ③ 类型识别 classify：dataType（显式 > jsonType > 扩展名 > 嗅探）        │
│  ④ 读取与解析：按 path/ref 读原文（只收有家数据，零拷贝零搬移）→ 算 hash │
│      → 归一化 md 落 parsed_contents（引擎唯一持久化：解析产物+台账，U8）   │
│      （闸1 同内容跳过、闸2 解析幂等在此统一）                              │
│  ⑤ 策略 policy：dataType → {room, wiki, memory}，请求级可覆盖            │
│  ⑥ 扇出 fan-out + 台账 ingest_events（策略快照随台账落库）               │
└───────────────┬────────────────────────────────────┬───────────────────┘
    room=on     │                                    │ memory=on
                ▼                                    ▼
   实体引擎（modules/knowledge，原样复用）      MemoryCore /v3/document/import
   ③′ LLM 实体抽取 → ③″ 解析 → 链接累积        （memory.md-source-plan 子系统）
   → 达阈值 ready → 用户确认晋升                     │
        │ wiki=on：晋升批量 ingest / 命中已晋升      ▼
        │ 实体增量 ingest（wiki=off 仅链接计分）   L0→L1(文档模式)→L2→L3
        ▼                                        记忆召回（<memory-context>/memory_search）
   KS Room wiki（结构化知识页）
```

**核心原则**：归一化做一次，理解各链路自理；资产只落一份，链路只存引用（MemoryCore 仍只收 caller_ref + sha，勿回退）；引擎是编排层，不新增 LLM 调用（类型识别全部确定性）。

### 3.1 关键决策

| # | 决策 | 理由 |
| --- | --- | --- |
| U1 | **引擎 = 接入面，不是新的认知环节**：normalize/classify/policy/fan-out/ledger，全确定性零 LLM | 三条链路的理解环节各自成熟且独立演进（§1.2 否决项）；引擎若加"理解"，就是第四套 prompt 要养 |
| U2 | **wiki 开关的真实语义 = Room 链路上的"正文沉淀 vs 仅链接计分"**：wiki 无 Room 不存在（D2 不设全局 wiki），故 `wiki=on` 要求 `room=on`；wiki=off 的源照常抽实体、照常计证据分，晋升时**不** raw/write | 语义真实有用：超长会议逐字稿可以"Room 认门（累积证据）+ 记忆认事实，但 wiki 不要整篇正文"；比"三链路并列"的表述更贴合现有架构 |
| U3 | **策略快照随台账落库**：wiki 开关在**进入时**定死（ingest_events.pipelines），晋升/增量 ingest 读快照而非实时 policy | policy 事后变化不应让已进来的资料行为漂移；快照即审计 |
| U4 | **类型注册表与 defaults 在代码、策略覆盖在配置文件**（2026-08-19 修订）：内置类型 = 识别规则 + 默认策略；覆盖项放 `<dataDir>/ingest-policies.json`，部署期改、重启生效 | 类型识别逻辑（扩展名/jsonType 映射）必须跟代码走；策略是部署配置而非用户数据，不开用户写入口 |
| U5 | **旧端点降级为引擎薄别名，行为不变**：`/v1/knowledge/files` → `{room,wiki,memory:false}`；`/v1/memory/import/markdown` → `{memory}`；新语义只在新端点/新 UI 生效 | 存量调用方（两处桌面 UI、e2e）零回归；避免"旧入口突然开始产记忆"的行为漂移 |
| U6 | **Office/PDF/HTML 解析由 gateway 编排**（JS 库 + 旧版 Office 的本机 LibreOffice 兼容路径，见 §5.3），不引外部转换服务 | 本地优先单机部署；文件 ≤20MB 级转换是毫秒~秒级，不值得一个服务 |
| U7 | **归一化产物存全文（≤20MB），各链路消费时按自己的上限截断**：wiki 512KB（既有）、MemoryCore 2MB（fork 上限，超限截断+标注） | 现在 file-convert 在转换期就截到 512KB，记忆链路其实吃的是被截过的 md——统一后全文入解析产物，截断移到消费端，两条链路各得其所 |
| U8 | **零原文存储（2026-08-18 拍板，定死）**：引擎只接收有路径或有库表引用的数据，不收无家字节/裸文本；原文的落盘与拷贝归调用方/既有上传链路；引擎自身只持久化解析产物（归一化 md，parsed_contents）+ ingest_events/policies | 引擎是纯编排层，不做第二存储所有者——上传存储已有归属，引擎收编=双写入口回归。粘贴内容由桌面端先落盘再传路径；连接器内容先入自己的表再传 ref |
| U9 | **唯一字节入口 = 文件管理中心（modules/files）**：统一上传接口 `POST /v1/files` 是全系统接收文件字节的唯一通道；对象库 + uploaded_files/parsed_contents 从 knowledge 模块**移交** files 模块所有（模块搬家，表与磁盘零迁移）；knowledge/memory/ingest 一律经它存取 | 现状两个上传入口各自调 file-storage 原语 = 事实上的双写入口；收敛为一个模块一个 API，文件管理应用（§8）才有单一事实源可管理，U8 的"原文归别人管"才有正牌的"别人" |

## 4. 数据类型注册表

```ts
/** 内置类型：识别规则 + 默认策略（U4）。覆盖项在 <dataDir>/ingest-policies.json（部署期配置）。 */
interface DataTypeDef {
  key: string;                      // "document" | "meeting-minutes" | ...
  label: string;                    // UI 显示名
  matchExtensions: string[];        // 扩展名 → 类型（path 路径）
  jsonType?: string;                // json 载荷的 jsonType → 类型
  defaults: { room: boolean; wiki: boolean; memory: boolean };
}
```

| key | label | 识别 | 默认 {room, wiki, memory} | 默认的理由 |
| --- | --- | --- | --- | --- |
| `document` | 文档 | `.md` `.markdown` `.txt` `.pdf` | ✓ ✓ ✓ | 通用缺省类型：全链路 |
| `meeting-minutes` | 会议纪要 | jsonType=`meeting-minutes`（reality_events 适配器也发它） | ✓ ✓ ✓ | 纪要=典型多链路资料：实体（人物/议题）、知识页、事实记忆都要 |
| `office-doc` | Office 文档 | Word/Writer：`.doc/.docx/.docm/.dot*`、`.rtf/.odt` | ✓ ✓ ✓ | 与 document 同语义 |
| `spreadsheet` | 表格 | Excel/Calc：`.xls/.xlsx/.xlsm/.xlsb/.xlt*`、`.xla*`、`.ods/.csv` | ✓ ✓ ✗ | 表格抽 L1 原子意义低（数值矩阵），实体与知识页仍有价值 |
| `slides` | 幻灯片 | PowerPoint/Impress：`.ppt/.pptx/.pptm/.pot*/.pps*/.sld*`、`.odp` | ✓ ✓ ✗ | 同上（大纲文本进记忆噪音大） |
| `html` | 网页 | `.html` `.htm` | ✓ ✓ ✗ | 网页剪藏噪音大，记忆默认关 |
| （后续）`mail` / `cloud-doc` / `web-clip` | —— | 连接器信封 / 剪藏 | —— | 注册表开放，加一行 + 一个 normalizer |

- **识别优先级**：请求显式 `dataType` > `jsonType` 映射 > 扩展名注册表 > （都不中）md 嗅探成功 → `document`；未知扩展名且非 md/json → 422 `unsupported_type`（附支持列表）；
- **未识别不猜**：不做 LLM 类型嗅探（U1 零 LLM）；json 载荷不带 jsonType 时按结构特征嗅探（`type:"doc"+content` → tiptap；有 `transcript|decisions|actionItems` → meeting-minutes；其余 → generic）。

## 5. 归一化层（normalizers/）

### 5.1 统一产物：IngestUnit

```ts
interface IngestUnit {
  ref: { sourceKind: SourceKind; sourceId: string; sourceVersion: number }; // 兼容 DocEnvelope.ref，file-* 确定性身份沿用
  dataType: string;
  title: string;
  markdown: string;                 // 归一化终产物（全文，≤20MB）
  occurredAt?: string;              // 业务时间（会议时间/文档落款），≠ 入库时间
  entrySignals?: DocEnvelope["entrySignals"];
  origin: { channel: "file" | "paste-file" | "connector" | "reality" | "everroom-doc" };
  /** 引擎仅有的持久化指针：解析产物 + 内容指纹（原文不落引擎，U8） */
  derived: { parsedId: string; contentHash: string };
  pipelines: { room: boolean; wiki: boolean; memory: boolean };  // 策略决议（快照）
}
```

**输入两形态（U8，定死：只收有家数据）**——无路径无引用的内容**不允许**进引擎：

| 形态 | 适用 | 引擎动作 |
| --- | --- | --- |
| `path`（本地路径） | 明确不想入库的一次性本地文件（临时导入） | **只读**：读字节→算 hash→归一化；不拷贝、不搬移、不拥有 |
| `ref`（sourceKind+sourceId） | everroom-doc（documents）/ reality_events / 既有上传链路的 uploaded_files 行 | **零存储**：按需从源表取内容组装（现状 DocEnvelope 模式，本体留各自表） |

原文的生命周期（落盘、拷贝、清理）归**文件管理中心（§8）/ 调用方**；引擎读取失败（路径消失/源行缺失）返回明确 4xx，台账记 failed。粘贴与选文件的**推荐路径**：先经 `POST /v1/files` 变成受管文件（进文件管理页可见、可管理）→ 以 ref 进引擎；path 形态只是逃生舱。

### 5.2 输入契约与格式推导

```jsonc
POST /v1/ingest
{
  "source": { "path": "C:/data/周三评审会.json" },   // 或 { "ref": { "sourceKind": "reality-event", "sourceId": "…" } }
  "dataType": "meeting-minutes",                     // 可缺省：由格式/扩展名/源类型推导
  "title": "周三产品评审会",                           // 可缺省：文件名/载荷/文档首行推导
  "occurredAt": "2026-08-20T09:00:00+08:00",
  "pipelines": { "room": true, "wiki": true, "memory": true },   // 可缺省：取类型策略
  "entrySignals": { }
}
```

**格式（md | json）由源自身推导**，不是请求字段：

| 源 | 格式判定 |
| --- | --- |
| `path` | 扩展名：`.md/.markdown/.txt` → md；`.json` → json（再按载荷结构定 jsonType）；office/html/csv 见 §5.3 |
| `ref` | sourceKind 内置映射：everroom-doc → tiptap；reality-event → meeting-minutes；file（uploaded_files 行）→ 按其原始扩展名 |

md 内容即归一化输入（标题 = 显式 `title` > 文件名去扩展名，`titleOfFilename` 沿用）；json 载荷按下表三种结构之一组装 md。

三种 jsonType 的 `data` 结构与 md 组装：

| jsonType | data 结构 | md 组装 |
| --- | --- | --- |
| `tiptap` | EverRoom 文档 contentJson（`{type:"doc",content:[…]}`） | 复用 `tiptap-markdown.ts` 导出器（与 everroom-doc 同一套，表格/列表覆盖一致） |
| `meeting-minutes` | `{title?, occurredAt?, participants?[], summary?, decisions?[{title,detail}], actionItems?[{owner,task,due}], transcript?[{speaker,text,at}]}` | 模板组装：标题 → 与会人 → 摘要 → 决议列表 → 行动项表 → 逐字稿（说话人+时间轴；超长截断走消费端上限） |
| `generic` | `{title?, text}` 或 `{title?, sections:[{heading, body}]}` | 纯映射（sections → ATX 标题层级） |

### 5.3 文件转换器（U2）

| 扩展名 | 库 | 转换 | 降级策略 |
| --- | --- | --- | --- |
| `.docx` | mammoth → HTML → turndown → md | 标题/列表/表格/加粗基本覆盖 | 图片/脚注丢弃，文首附一行转换说明（"由 docx 转换，图片已省略"） |
| `.xlsx` | exceljs | 每 sheet → md 表格（sheet 名作二级标题；行数 >500 截断标注） | 合并单元格展平 |
| `.csv` | 内置（按分隔符切） | 单表 → md 表格 | 同上 |
| `.pptx` | jszip + XML 遍历（`a:t` 文本游程） | 每页 → `## 第 N 页：标题` + 大纲文本 | 版式/图示丢失，标注 |
| `.pdf` | unpdf（PDF.js） | 每页 → `## 第 N 页` + 文本层 | 扫描件无文本层时提示先 OCR |
| `.txt` | 直通 | 内容即 md | —— |
| `.html/.htm` | turndown | HTML → md | script/style 剥离 |
| 旧版二进制与 ODF（`.doc/.xls/.ppt/.rtf/.odt/.ods/.odp` 等） | 本机 LibreOffice headless → OOXML/HTML → 上述转换器 | 与对应新版格式一致 | 缺少 LibreOffice 时返回明确的 `convert_failed` |

- 上限沿用 `MAX_UPLOAD_BYTES = 20MB`；转换失败 → 422 `convert_failed`（错误码沿用 FileConvertError）；
- 新依赖全部进 `apps/gateway`：mammoth、turndown、exceljs、jszip、unpdf（纯 JS、无原生编译，Windows 免编译关注）；旧版 Office 可选依赖本机 LibreOffice。

### 5.4 消费端截断（U7）

| 链路 | 上限 | 行为 |
| --- | --- | --- |
| Room/wiki（KS raw/write） | 512KB/文件 | 既有截断+标注逻辑，从 file-convert 移到扇出/ingest 消费点 |
| 记忆（MemoryCore import） | 2MB / 2000 块 | md >2MB 截断+标注再提交（fork 会拒绝超限，引擎先截免 4xx）；块数超限让 fork 拒并回传明确错误 |

## 6. 链路策略（policy）

### 6.1 策略来源：两层配置文件 ⨝ 代码兜底（迁移 0008 只有台账）

> 2026-08-19 修订：策略不是用户数据——**没有 `ingest_policies` 表，也没有 PUT/DELETE 写接口**。
> 策略分两层文件 + 代码兜底，读取顺序：**请求覆盖 > ②部署覆盖 > ①工程默认 > 代码注册表 defaults**。

| 层 | 文件 | 谁改 | 何时生效 |
| --- | --- | --- | --- |
| ① 工程默认 | `apps/gateway/ingest-policy-defaults.json`（随仓库进 git；打包时拷入 dist） | **工程师**（改默认策略不动 TS 代码） | 提交后随版本发布；本地改完重启 |
| ② 部署覆盖 | `<dataDir>/ingest-policies.json`（桌面版 = `%APPDATA%/EverRoom/`） | 运行环境/运维（不动代码仓库） | 改完重启 |
| 兜底 | `modules/ingest/types.ts` 的 DATA_TYPES defaults | 工程师（识别规则与兜底值，改动需过测试） | 随代码 |

两层文件同格式（`$comment` 等元信息键忽略）：

```jsonc
// 只写要覆盖的类型，未列出的类型走下一层
{
  "spreadsheet": { "room": true, "wiki": true, "memory": true },
  "document":    { "room": true, "wiki": true, "memory": false }
}
```

加载语义（`modules/ingest/policy.ts`，启动时两层各整表读入一次）：
- 缺文件 = 该层不存在；坏 JSON / 顶层不是对象 = 告警并忽略该层（不阻塞启动）；
- 未知类型 / 字段不全 / 组合非法的条目：逐条告警跳过，其余照常生效；
- 仓库随附的工程默认文件由 `ingest-engine.test.ts` 守护（改坏会在 CI 红）。

```ts
export const ingestEvents = sqliteTable("ingest_events", {
  id: text("id").primaryKey(),                 // ing-<uuid12>
  sourceKind: text("source_kind").notNull(),
  sourceId: text("source_id").notNull(),
  sourceVersion: integer("source_version").notNull(),
  dataType: text("data_type").notNull(),
  title: text("title").notNull(),
  contentHash: text("content_hash").notNull(),
  parsedId: text("parsed_id").notNull(),
  /** 策略快照（U3）：json {room, wiki, memory}——晋升/增量 ingest 的 wiki 判定依据 */
  pipelines: text("pipelines").notNull(),
  /** 记忆链路即时结果：json {documentId, chunkCount, deduplicated} | null */
  memoryResult: text("memory_result"),
  /** Room 链路 job 引用（route job id），wiki 状态不在台账冗余（见 §6.3） */
  routeJobId: text("route_job_id"),
  originChannel: text("origin_channel").notNull().default("upload"),
  createdAt / updatedAt,
});
```

### 6.2 开关组合语义（全表）

| room | wiki | memory | 语义 | 典型 |
| --- | --- | --- | --- | --- |
| ✓ | ✓ | ✓ | 全链路：实体累积 + 晋升沉淀正文 + L1 提炼 | 文档、会议纪要 |
| ✓ | ✓ | ✗ | 进 Room、转正沉淀 wiki，不产记忆 | 表格、幻灯片、网页 |
| ✓ | ✗ | ✓ | 实体累积证据但不沉淀正文（"Room 认门、记忆认事实"） | 超长逐字稿 |
| ✗ | — | ✓ | 只进记忆（现 MemoryPage 导入的语义） | 个人笔记只想被记住 |
| ✗ | — | ✗ | 422 拒绝（至少一条链路） | 误操作 |

- `room=false && wiki=true` 非法（U2）：REST 校验 422；配置文件里出现该组合则加载时告警跳过；
- **快照生效点**：扇出时写死 pipelines 进 ingest_events；晋升批量 ingest（entity-plan 4.4 步骤 6）与已晋升实体增量 ingest，按**该源最新版本 ingest_events.pipelines.wiki** 决定是否 raw/write（off → 只写 entity_doc_links 计分，进 evidence 账本标 link-only）；memory 开关只在进入时生效一次（import 是即时动作）。

### 6.3 台账边界（v1 从简）

- 引擎只记**自己做的**：进入记录 + 策略决议 + 记忆即时结果 + route job 引用；
- Room/wiki 下游状态（候选实体、证据分、晋升、wiki 页面）**继续查 knowledge 既有表**（entities/entity_doc_links/route_decisions），不往台账回写同步——现有"资料归类/推荐 Room"UI 已消费这些表，再造一份冗余状态只添漂移面；
- 桌面"导入记录"视图 = ingest_events ⨝（按 sourceId）knowledge/entities 的轻量聚合（只读 join，无同步）。

## 7. 扇出与各链路执行

```text
engine.ingest(input):                       // input.source = path | ref（此外一律 4xx）
  1. intake：源校验（path 存在可读 / ref 可解析）→ 格式推导（§5.2）
  2. 读取原文：path 直读字节 / ref 经源适配器取内容（只读，不落盘不拷贝）
  3. 算 contentHash → 闸1：同 (sourceId, contentHash) 已在台账
     → 全跳过，返回既有 ingest_events（deduped=true）
  4. normalize → 闸2：解析产物幂等落 parsed_contents（(hash, parser_version) 唯一）
  5. resolve pipelines（§6.2）→ IngestUnit → 台账落行（策略快照）
  6. memory=on → memory.importToMemoryCore({title, markdown, callerRef: sourceId 或 path})
       （memory 模块拆出的下半段；引擎不碰其存储逻辑）
  7. room=on  → knowledge.submitEnvelope({sourceKind, sourceId, sourceVersion, title, markdown,
                     occurredAt, entrySignals})   ← 既有 ROUTE_JOB 原样
  8. 返回 {ingestId, dataType, pipelines, memoryResult | null, routeQueued}
```

既有机制全部原样复用：实体抽取→解析→证据累积→ready→确认晋升（entity-plan 全套）；KS raw/write + ingest + per-wiki 串行 + 409 退避；MemoryCore /v3/document/import（分块→L0→L1 文档模式→L2 场景块与 L3 触发计数**都排除文档派生原子**——文档知识只走召回与溯源，不塑造场景画像；fork 91c967a，2026-08-19 定稿）。

**知识模块的两处小改**：

1. `submitFileUpload` 的上传资产化（对象库/登记/闸1闸2）**保留在 knowledge 模块不动**；存储完成后以 ref 调引擎扇出（旧端点即此别名）。file-convert 的转换职责移入引擎 normalizer（按 ref 取 uploaded_files 行时经扩展名分发）；
2. 晋升/增量 ingest 的资料清单装配处，按台账 wiki 快照过滤（off 的源跳过 raw/write，账本标 link-only——补账逻辑 `evidence.rooms` 语义不变）。

**记忆模块的一处小改**：`importMarkdown` 拆两段——存储段改经 `modules/files` + `importToMemoryCore`（标题/内容/callerRef 直调 MemoryCore，引擎扇出时调用）；旧方法保留为旧端点别名。

**文件模块（新增，自 knowledge 移交，§8.1）**：file-storage 原语与 uploaded/parsed 两表服务移入 `modules/files`；引擎闸2 落解析产物、knowledge/memory 的一切字节存取都经它——U8 的"原文归别人管"里，这个"别人"就是 files 模块。

## 8. 文件管理中心（modules/files）与"文件"应用

### 8.1 统一文件模块（U9：唯一字节入口）

- **职责**：全系统唯一的文件字节入口与原文层——对象库（`files/sha256`）+ `uploaded_files` + `parsed_contents`（解析缓存一并移交所有；引擎闸2 落解析产物经它写入）；
- **从 knowledge 模块搬家**：file-storage.ts 原语与两表的服务代码移入 `modules/files`；表与磁盘结构不动，**零迁移**；knowledge/memory 改为依赖注入调用（消除现状 memory 经 requireAssets 直探 knowledge 资产的耦合）；
- **身份与判重沿用**：确定性 ID（`file-<规范化文件名 hash>`）、闸1（同身份同内容 deduped）、内容寻址对象库——机制不变，只是换了所有者。

### 8.2 统一上传与管理 API（modules/files/routes.ts）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/files` | **统一上传**（multipart）。返回 `{fileId, contentHash, deduped, bytes}`；同身份同内容幂等跳过 |
| GET | `/v1/files?limit=&offset=` | 文件列表（名称/大小/时间 + **用途聚合**：join 台账显示进了哪些链路） |
| GET | `/v1/files/:id` | 元数据 + 派生引用（关联实体/Room、记忆文档、wiki 页） |
| GET | `/v1/files/:id/markdown` | 归一化 md 预览（parsed_contents；未解析过则提示先 ingest） |
| GET | `/v1/files/:id/storage` | 本体路径（"显示原件"reveal 用） |
| PATCH | `/v1/files/:id/meta` | 改显示名（身份 ID 不变，aliases 语义） |
| DELETE | `/v1/files/:id` | 删除 + 级联清理（见下）+ 对象库 GC |

**删除级联**（files 模块编排，经各链路现有机制）：

1. knowledge：enqueueCleanup（实体链接回退 + wiki raw/rm，现行 document.deleted 同款）；
2. memory：MemoryCore `/v3/document/delete`（documentId 由台账 memoryResult 反查）；
3. parsed_contents 随删；对象库 blob 仅当**无其他 uploaded_files 行引用同一 hash** 时物理删除（内容寻址天然共享）。

**兼容迁移**：`POST /v1/knowledge/files` 上传段 → 薄别名（`/v1/files` + `/v1/ingest`）；`GET /v1/knowledge/files/*` 系列 → `/v1/files/*`（WikiPane"来源文件"、MemoryPage 同步换端点，旧端点保留一版兼容后下线）。

### 8.3 桌面"文件"应用（FilesPage）

- **新一级页面"文件"**：上传区（拖拽/选择，§5.3 全部格式）+ 文件列表（类型图标、名称、大小、时间、**用途徽标**：`已进实体池` `已晋升 Room` `已提炼记忆` `已沉淀 wiki`）；
- 行操作：预览（md 预览 / 显示原件）、改名、删除（展示将级联清理的派生物清单后确认）、**"进入链路"**（打开统一导入对话框，预填该文件 ref 与类型识别结果，三开关按策略预置）；
- 与统一导入对话框的联动：对话框提交的第一步就是把文件/粘贴内容经 `/v1/files` 变成受管文件（拿 ref），再 `POST /v1/ingest`——**进入系统的字节都有家、都被管理**；
- MemoryPage"文档"Tab 与 WikiPane"来源文件"分区保留，改为读 `/v1/files`（同一份数据的不同视图）。

## 9. 链路 API 设计（modules/ingest/routes.ts）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/ingest` | 统一入口，application/json。body 必含 `source`（`{path}` 或 `{ref}`，§5.2）；可选 `dataType/title/occurredAt/pipelines/entrySignals`。无 source 的裸内容 422 |
| GET | `/v1/ingest/:id` | 单次进入详情（含各链路结果/引用） |
| GET | `/v1/ingest?dataType=&limit=&offset=` | 导入记录（台账列表） |
| GET | `/v1/ingest/policies` | 全部类型的有效策略（代码兜底 ⨝ 工程默认 ⨝ 部署覆盖，`source: code/project/deploy`）——只读展示，无写接口（§6.1） |
| GET | `/v1/ingest/types` | 类型注册表（label/识别规则/默认策略）——只读展示 |

- 鉴权/错误约定同既有 `/v1` 路由（auth 中间件、`{code,message,data}` envelope、FileConvertError → 422 映射）;
- **兼容别名（U5）**：`POST /v1/knowledge/files`（multipart 上传）与 `POST /v1/memory/import/markdown`（md 文本）**保留各自的存储逻辑不变**（上传资产化/md 落盘归各自模块），内部改为"存储完成 → 以 ref/path 调引擎扇出"（pipelines 分别固定 `{room,wiki}` 与 `{memory}`，行为与现状一致）。标 Deprecated，桌面 UI 迁移到统一入口后下线。

## 10. 桌面端（apps/desktop，U3）

- **统一导入对话框**（新组件，替换两处旧入口的内部实现）：
  - 选文件 / 粘贴 md / 粘贴 json：统一先经 `POST /v1/files` 变成受管文件拿 ref（粘贴由主进程组装 `pasted-<ts>.md/.json` 上传；自动识别 jsonType，会议纪要表单化预览）；
  - 类型显示（可改，默认识别结果）+ **三个链路开关**（预填该类型有效策略，用户可临时改——即请求级覆盖）；
  - 提交 → `POST /v1/ingest`，结果反馈"已入实体池 / 已提炼 N 条记忆 / 仅链接"；
- **入口收敛**：Room 知识库 Tab 上传、MemoryPage 文档 Tab 导入、首页"导入资料"、文件管理页"进入链路"都开同一对话框（各自预置上下文：Room Tab 默认 room=on 强调，MemoryPage 默认 memory=on）；
- **文件管理页（FilesPage，§8.3）**：新一级入口，上传/管理/预览/删除/进入链路；
- ~~策略设置页~~（2026-08-19 修订：移除）：策略不是用户数据——defaults 在 gateway 代码注册表，覆盖走 `<dataDir>/ingest-policies.json`（部署期配置），桌面端不再提供策略编辑 UI；
- **导入记录视图**（首页资料归类面板加一栏）：ingest_events 轻量列表 + 点开看各链路状态/跳转（实体详情、MemoryPage 文档）；
- bridge/preload/shared DTO 照 knowledge/memory 既有模式加 `files.ts` 与 `ingest.ts` 两套。

## 11. 代码改动清单

| 位置 | 改动 | 量级 |
| --- | --- | --- |
| `apps/gateway/src/modules/files/`（新，自 knowledge 移交） | file-storage 原语 + uploaded/parsed 服务 + 统一上传与管理路由 + 删除级联与对象库 GC（§8） | 中 |
| `apps/gateway/src/modules/ingest/`（新） | `types.ts`（DataType 注册表 + IngestUnit）、`normalizers/`（md/json-tiptap/json-meeting/json-generic/office/html/csv）、`policy.ts`、`ledger.ts`、`service.ts`（编排 §7）、`routes.ts` | **主体** |
| `apps/gateway/src/infrastructure/database/schema.ts` + 迁移 0008 | +`ingest_events`（策略无表，走配置文件，§6.1） | 小 |
| `apps/gateway/src/modules/knowledge/service.ts` | file-storage/两表服务移交 modules/files（依赖注入改调）；submitFileUpload 改为 files+ingest 组合的薄别名；晋升/增量 ingest wiki 快照过滤 | 中 |
| `apps/gateway/src/modules/knowledge/file-convert.ts` | 512KB 截断迁往消费端（U7）；保留错误码 | 小 |
| `apps/gateway/src/modules/memory/service.ts` | importMarkdown 拆段（存储段改经 modules/files，引擎调 importToMemoryCore） | 小 |
| `apps/gateway/src/modules/knowledge/routes.ts`、`memory/routes.ts` | 旧端点转薄别名 | 小 |
| `apps/gateway/package.json` | +mammoth、turndown、exceljs、jszip（U2） | 小 |
| `apps/desktop` | shared/files.ts + ingest.ts、bridge、**文件管理页 FilesPage**、统一导入对话框、导入记录（U3） | 中 |
| 测试 | `tests/files-store.test.ts`（上传幂等/删除级联/对象库 GC）+ `tests/ingest-engine.test.ts`（归一化/类型识别/策略/闸1/快照/扇出单测）+ `ingest-pipeline.test.ts`（e2e：三链路产物断言，真实 MemoryCore/KS 起法照 memory-doc-pipeline） | 中 |

## 12. 里程碑

| 阶段 | 内容 | 出口标准 |
| --- | --- | --- |
| **F 文件中心**（先行，约 3~4 天） | modules/files 抽取（对象库 + 两表自 knowledge 移交）+ `POST /v1/files` 统一上传 + 管理 API + 删除级联与对象库 GC + knowledge/memory 改依赖 | 任何入口上传的字节都经 /v1/files 入库且幂等；两旧上传入口对外行为不变（内部换实现）；WikiPane/MemoryPage 读新端点正常 |
| **U1 引擎核心**（约 1 周） | modules/ingest（md + 三种 json 的归一化、类型注册表、policy/台账、扇出）+ `/v1/ingest` 全套 REST + 旧端点别名 + knowledge/memory 两处小改 | 一次 POST /v1/ingest（json 会议纪要）：实体池出现候选实体 + MemoryPage 出现文档与派生 L1 + 台账可查；改策略后新上传行为随策略变；既有 e2e 全绿 |
| **U2 格式扩展**（约 1 周） | office/pdf/html/csv/txt 转换器 + 扩展名识别 + 20MB 上限与消费端截断 + desktop 文件选择放宽 | Office/PDF/csv 上传三链路产物正确；>512KB 内容 wiki 截断标注、>2MB 记忆截断标注；旧版 Office 缺少 LibreOffice 时明确提示 |
| **U3 桌面统一入口 + 文件管理页** | 统一导入对话框（类型+三开关）+ **文件管理页 FilesPage**（上传/列表/用途徽标/预览/删除/进入链路）+ 入口收敛 + 导入记录视图 | 三处入口同一对话框；文件页可见全部受管文件且用途徽标正确；导入记录可见各链路去向 |
| **U4 连接器与扩展**（不承诺） | reality_events（ASR 实录）→ meeting-minutes 适配器；邮件/云盘信封 | 连接器按 json 契约接入零引擎改动 |

## 13. 风险与对策

| 风险 | 对策 |
| --- | --- |
| Office/PDF 转换保真度（表格/公式/图示/扫描页丢失） | 转换说明标注 + 预览确认；旧版 Office 走 LibreOffice，扫描 PDF 无文本层时提示 OCR |
| 大文件 × memory=on 的 L1 噪音（批量导入手册类文档） | 类型默认策略先保守（表格/幻灯片/网页 memory=off）；2MB 截断上限；MemoryCore 侧 L2/L3 都已排除文档派生（fork 91c967a） |
| wiki 快照过滤与补账账本（evidence.rooms）交互 | link-only 源进账本标 skip 语义不变；补账按"本房本文件"判定，快照 off 的源永远不落 raw，账本不误跳 |
| path 输入稳定性（文件被移动/删除） | 调用方负责内容有家（U8）；引擎读取失败明确 4xx + 台账记 failed；重试只需新路径，hash 判重保证不重复入链路 |
| 新依赖供应链（mammoth/turndown/exceljs/jszip/unpdf） | 全部纯 JS、主流维护中、无原生编译；pnpm 审计过再进 |
| MemoryCore 2MB/2000 块硬限 | 引擎消费端先截（§5.4），fork 拒绝时错误透传给台账 |
| 类型识别错（csv 被当 document 等） | 识别规则全确定性可解释；UI 可改类型；台账记录识别依据，错案可追 |
| 对象库 GC 误删（内容寻址 blob 被多文件共享） | 仅删引用计数为 0 的 blob；GC 为维护操作，可手动触发并输出删除报告 |
| 删除级联不彻底（某链路派生物残留） | 级联全部走各链路现有机制（enqueueCleanup / document delete）；删除前 API 返回将清理的派生物清单供 UI 确认；台账留删除审计 |

## 14. 验收标准

1. **单入口**：`POST /v1/ingest` 两种源（path 文件、ref 库表引用）× md/json/office 格式全部走通；无 source 的裸内容 422；同一份内容二次提交闸1 跳过（零重复解析、零重复 LLM）。
2. **策略生效**：配置文件里加 `"spreadsheet": {"room":true,"wiki":true,"memory":false}` 重启后上传 xlsx——实体照常累积、wiki 照常（晋升后）、MemoryPage 无新文档；请求级 `pipelines` 覆盖优先于类型策略。
3. **wiki=off 快照**：上传 meeting-minutes（wiki:off）→ 实体证据分照常累积；确认晋升后该源不出现在 Room wiki 检索中，但同批 wiki=on 的源正常沉淀。
4. **会议纪要 json**：transcript/decisions/actionItems 组装的 md 三链路产物齐备（候选实体含人物/议题、MemoryPage 出现派生记忆）。
5. **office**：docx 的标题层级与表格在归一化 md 中保真；xlsx 多 sheet → 多级标题 + md 表格；转换说明标注可见。
6. **兼容**：`/v1/knowledge/files` 与 `/v1/memory/import/markdown` 行为与改造前一致（既有 93 个 gateway 用例 + memory-doc-pipeline 6 用例全绿）。
7. **台账**：`GET /v1/ingest` 能列出每次进入的类型、识别依据、策略快照与各链路结果/引用。
8. **文件中心**：任一入口上传的文件在文件管理页可见、用途徽标正确（实体池/Room/记忆/wiki）；删除文件后三条链路派生物一并清理，wiki 检索不再命中该源，对象库中无引用的 blob 被回收。

## 15. 开放问题（待拍板）

1. **类型默认策略表**（§4）：表格/幻灯片/网页 memory=off 的默认是否符合直觉？office-doc memory=on 是否太激进？
2. **超 2MB 的记忆截断 vs 拒绝**：本方案选截断+标注（长文档前 2MB 通常已覆盖主要事实）；还是干脆拒绝让用户手动拆分？
3. **台账深度**：v1 不回写 Room/wiki 下游状态（§6.3），导入记录视图靠只读 join——是否需要更强的状态 rollup？
4. **exceljs vs SheetJS CE**：xlsx 解析选型（exceljs 维护更稳；SheetJS CE 功能全但分发渠道特殊）。
5. **everroom-doc 是否纳入策略面**：本方案定为不纳入（① 直连零成本路径不动，ED5 延续）；若将来用户想"Room 内文档不进记忆"，再议。
6. **json 输入是否需要批量形态**（一次 POST 多份）：连接器场景可能要；v1 先单份，批量=循环。
7. **`.doc`/`.xls` 老格式**：直接 422 提示转存，还是找库支持（如 word-extractor）？
8. **文件删除的确认交互**：级联清单（将撤销的实体链接/删除的记忆文档/清理的 wiki 页）在 UI 上如何呈现——删除前二次确认，还是先删可撤销？
