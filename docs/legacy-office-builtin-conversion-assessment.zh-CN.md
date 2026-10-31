# 旧版 Office（.doc / .xls / .ppt）内置转换方案评估

> 状态：**评估，部分已落地**（2026-10-26 晚：入库文本抽取已改为进程内解析，见下）
> 日期：2026-10-26
> 范围：`apps/desktop`（内嵌预览 `office-preview-registry` 及三个 view manager）、`apps/gateway`（格式注册表 / 论文模板 / 参考 PPTX）、`apps/desktop/vendor/genoffice`（子模块既有能力）
> 触发：用户打开 `.doc/.xls/.ppt` 时提示「已用系统默认应用打开 —— 需要本机安装 LibreOffice」（`files.legacyPreviewFallbackMessage`）
> 前置阅读：`docs/unified-ingest-plan.md` §5.3（旧格式走本机 LibreOffice 的既有决策）、`docs/genoffice-everroom-integration-plan.zh-CN.md`
> **落地更新（2026-10-26 晚）**：`submodules/everroom-connectors/gateway-module/legacy-office.ts` 已实现 `.doc/.xls/.ppt/.rtf/.odt/.ods/.odp` 的进程内文本抽取，网关入库/索引不再调用 LibreOffice（§2 的「网关导入」一行已下线）；桌面内嵌预览仍按需用 soffice 渲染，不受影响。

## 1. 结论摘要

三个旧格式的可行性与成本差一个量级，**不能用一个方案一刀切**：

| 格式 | 上游 genoffice 内置能力 | 零依赖落地成本 | 建议 |
| --- | --- | --- | --- |
| `.xls` | **已有**：xlsx 侧车 `convert_workbook`（calamine）转最小 xlsx | 极低（去一层多余的 LibreOffice） | 立刻做 |
| `.doc` | 只有文本抽取（AI 附件用），无渲染路径 | 平台桥（macOS `textutil`）低但有保真损耗；自研/POI 中等 | 平台桥 + 质量闸门 |
| `.ppt` | **明确拒绝**（引导另存为 .pptx），只有文本抽取 | 除随包 LibreOffice / 商业 SDK / 文本重建外无廉价解 | 按真实占比决定 |

三条关键判断：

1. **EverRoom 现在对 `.xls` 是"多做了一层"**：上游 sheets 应用已能用 Rust 侧车把 `.xls` 转成 xlsx 再打开（`packages/.../xlsx-engine/src/convert.rs`），而 EverRoom 在 `prepareSpreadsheet` 里先用 LibreOffice 转一遍，等于把一个已有的能力外包给了外部依赖。
2. **全保真的唯一省事路径是随包 LibreOffice**：官方 macOS aarch64 dmg 实测 298,845,477 B（285 MiB，TDF 26.8.1），安装后 GB 级；许可 MPL-2.0 允许随专有应用分发，但签名/公证/CI 体积成本是真实的。
3. **先埋点再投入**：仓库里 `.doc/.xls/.ppt` 的真实样本只有 genoffice 自带的 2 个 fixture（`legacy-sample.doc` / `legacy-sample.ppt`，无 `.xls`）。没有语料就无法验收任何转换器，P0 必须先建语料库 + 统计真实占比。

## 2. 现状：LibreOffice 依赖点全清单

| 消费点 | 代码 | 行为 |
| --- | --- | --- |
| 桌面预览 `.doc` | `apps/desktop/src/main/office/office-view-manager.ts:67-76` | soffice 转 docx，缓存到 `userData/office-documents/<fileId>/<hash>/` |
| 桌面预览 `.xls` | `apps/desktop/src/main/office/spreadsheet-view-manager.ts:19-25` | soffice 转 xlsx |
| 桌面预览 `.ppt` | `apps/desktop/src/main/office/slides-view-manager.ts:18-25` | soffice 转 pptx |
| 转换链与回退 | `apps/desktop/src/main/office/legacy-convert.ts:26-42, 94-106`<br>`apps/desktop/src/main/index.ts:2494-2503` | 候选链 `EVERROOM_SOFFICE_PATH` → `soffice` → `/Applications/...`；失败回退系统应用并带 `legacyFallback` |
| 渲染端提示 | `apps/desktop/src/renderer/src/App.tsx:418`、`components/pages/FilesPage.tsx:430` | 弹出截图里的那条 toast |
| 网关导入 | `apps/gateway/src/modules/files/format-registry.ts:42-46`<br>`gateway-module/legacy-office.ts` | **已下线**：文本抽取改为进程内解析（`.doc`→CFB 分片表、`.xls`→BIFF、`.ppt`→记录树、`.rtf`/ODF→对应读取器）；parser id 更名 `legacy-*-text` |
| 论文模板 | `apps/gateway/src/modules/thesis-format/normalize.ts:70-100` | `.doc` 转 docx 取版式事实 |
| 参考 PPTX | `apps/gateway/src/modules/subagents/slides-reference.ts:76-78` | 无 soffice 直接报错 |

本机验证（2026-10-26）：`/Applications` 无 LibreOffice，PATH 无 `soffice` → 三个格式必然进入回退分支，提示文案与用户截图一致。

## 3. 上游 genoffice 已有能力（决定方案边界的硬事实）

| 格式 | 能力 | 证据 |
| --- | --- | --- |
| `.xlsx/.xlsm` | 完整编辑 | `apps/sheets` + `xlsx-sidecar` |
| `.xls` | **内置转换**：calamine 读 → 写最小 xlsx（值、公式、日期数字格式；样式不迁移，合并单元格/图片/图表不保留） | `native/xlsx-engine/src/convert.rs:1-22`（注释明确"a fresh workbook, not a byte-preserving edit"）；CLI 动词 `ConvertWorkbook`（`src/main.rs:206-213`）；TS 客户端 `convertWorkbook`（`src/main/xlsx-sidecar-client.ts:75-77`）；打开流程 `src/main/sheets-main.ts:3496-3546`（临时目录副本 + 首次保存建议另存 `.xlsx`） |
| `.csv` | 内置转 xlsx | `sheets-main.ts:3527-3536` |
| `.doc` | 仅文本抽取（`word-extractor`），供 AI 附件，不产出可渲染文档 | `packages/file-parse/src/doc.ts` |
| `.ppt` | 仅文本抽取（`ppt-to-text`）；打开时明确拒绝并引导另存 | `packages/file-parse/src/ppt.ts`；`apps/slides/src/main/cfb-sniff.ts`；`apps/slides/src/main/i18n-main.ts:39-43`（`legacyPptBody`："本应用只支持 .pptx…另存为 .pptx"） |
| `.odt/.ods/.odp/.rtf` | 无 | —— |

附带发现：`file-parse` 已 Apache-2.0 内置 `.doc`/`.ppt` 纯文本抽取，是"无转换器时至少能读"的现成降级材料。

## 4. 方案矩阵

### S0 维持现状 + 引导（基线，0 体积）

把 toast 拆成两类原因（未装 LibreOffice / 装了但转换失败），加安装指引与「另存为 OOXML」建议，`EVERROOM_SOFFICE_PATH` 写进设置说明。
成本 1–2 天；不解决任何格式。

### S1 复用上游 `.xls` 内置转换（推荐先做）

去掉 `prepareSpreadsheet` 的 LibreOffice 分支，把 `.xls` 原文件路径交给 sheets 视图（`queueWorkbookForView` → `select-workbook` 内部走侧车转换）。
- 覆盖：`.xls`（`.xlsb/.xlt/.xla/.ods` 侧车同样能读，但上游打开流程只放行 `csv/xls`，需要扩或保持现状）
- 增量体积：0（侧车已在包里，`build/genoffice-runtime/native/xlsx-sidecar`）
- 保真：值与公式、日期格式；**丢样式/合并/图片/图表**（预览可接受，编辑不安全）
- 成本：1–3 天（含回归；难点只在 editable 语义——转换件是临时副本，不能静默回写）

### S2 macOS `textutil` 桥（`.doc`）

`textutil -convert docx` 走系统自带 Word 97 读取器。
- 已实测：仓库 `legacy-sample.doc` → textutil 产出的 docx 能被 `docx-engine#parseDocx` 正常解析（4 blocks，字体/字号/加粗都在）
- 保真：文本 + 基本字符格式；**丢表格结构、图片、超链接、真列表**（表格变逐段落、列表变手打符号）；读失败仍 `exit 0`，必须校验产物
- 体积 0；成本 3–5 天（含 Windows 分支与质量闸门）
- 仅 macOS（Windows 无等价系统工具）

### S3 Windows Office COM / macOS AppleScript 桥

有 Office 的机器用 COM/AppleScript `SaveAs` 转 OOXML，保真接近完美。但：依赖 Office 已安装、受 TCC/权限弹窗与环境差异影响（外部实践里 Word AppleScript 直接 `-1708` 失败），**不建议作为产品主路径**，可作为 Windows 上的"检测到 Office 就加速"的加分项。

### S4 自研 Rust 解析器（`.doc` / `.ppt`）

用已有的 `cfb`（OLE 容器）读流，再解析 Word 97 piece table / PPT 记录。
- `.doc`：文本 + 段落/字符格式可做（4–8 周，含表格、页眉页脚、中文编码、图片则大幅加长），产出 docx 供 docs 引擎渲染
- `.ppt`：形状树/母版/动画映射工作量爆炸（≥2 个月），产出 pptx 的保真天花板低
- 体积 ~0，许可干净（Apache-2.0），风险最高：**不建议自研 `.ppt`**，`.doc` 仅在"必须离线且不接受任何外部依赖"时才考虑

### S5 Java POI + jlink JRE

`poi` + `poi-scratchpad` 读 HWPF/HSLF/HSSF，再写 XWPF/XSLF。
- 体积：jlink 裁剪 JRE 约 40–60 MB + POI 及依赖 15–25 MB（估算），需双平台各打一份
- 保真：`.doc` 文本/表格尚可，`.ppt` 需自写 HSLF→XSLF 映射（POI 无现成转换器），图表/母版/动画丢失
- 许可：Apache-2.0 + JRE（GPLv2+CE，可分发）
- 成本：3–5 周（含 JRE 打包、签名、崩溃隔离）

### S6 随包 LibreOffice（全保真路线）

`extraResources` 随包 `/Applications/LibreOffice.app`（或 Windows MSI 解包），`prepare-libreoffice-runtime.mjs` 沿用 `prepare-genoffice-runtime.mjs` 的下载+SHA256+缓存模式。
- 覆盖：`.doc/.xls/.ppt/.rtf/.odt/.ods/.odp` 全部，保真最高，行为与用户自装 LO 完全一致
- 体积：官方 macOS aarch64 dmg **285 MiB**（实测），安装后 GB 级；当前 `EverRoom-0.1.9-arm64.dmg` 为 496 MB
- 许可：MPL-2.0，可随专有应用分发；需第三方便利清单（仓库已有 `THIRD-PARTY-NOTICES` 机制）+ 商标使用规范
- 成本：2–3 周（双平台打包、嵌套签名、公证、CI 下载缓存、冷启动与并发 profile 隔离）
- 风险：macOS 公证对嵌套 Mach-O 逐个签名；裁剪模块（去掉 help/gallery/dict/java）收益有限且易踩坏过滤器，建议**不裁剪**

### S7 商业 SDK（Aspose / GroupDocs / Syncfusion）

体积小（十几~几十 MB）、保真好、有商业支持；代价是按开发者/按年授权费用与供应商锁定，需安全评审。成本：1–2 周集成 + 采购周期。

### S8 网关侧转换

网关已有 soffice 调用（导入、论文、参考 PPTX）。可加一个"上传字节 → 返回 OOXML"接口给桌面用。
但：违背本地优先（文件出机）、离线不可用、网关侧同样要装 LO——只是把依赖挪位置。**仅在"服务端本来就要装 LO"的部署形态下有意义**。

### S9 文本降级视图（`.doc` / `.ppt`）

用 `file-parse` 的 `docToText` / `pptToText` 出纯文本/Markdown 只读视图，或用 genoffice 引擎按大纲重建一份 pptx（文本保真、版式重建）。
- 体积 0，3–5 天
- 不是"打开原样"，但对"只想看内容"的场景有真实价值；必须显式标注"简化视图"

### 方案对比

| 方案 | 覆盖 | 增量体积 | 保真 | 许可 | 工作量（估） | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| S0 引导 | — | 0 | — | — | 1–2 天 | 无 |
| S1 上游 xls | `.xls` | 0 | 值/公式，无样式 | Apache-2.0 | 1–3 天 | 低 |
| S2 textutil | `.doc`（mac） | 0 | 文本+基本字符 | 系统工具 | 3–5 天 | 中（保真/静默失败） |
| S4 自研 | `.doc` | 0 | 文本+段落 | Apache-2.0 | 4–8 周 | 高 |
| S5 POI+JRE | `.doc/.xls/.ppt` | +60–85 MB | 中 | Apache-2.0 / GPLv2+CE | 3–5 周 | 中高 |
| S6 随包 LO | 全部 | +285 MiB(dmg)，安装 +GB | 最高 | MPL-2.0 | 2–3 周 | 中（签名/公证/体积） |
| S7 商业 SDK | 全部 | +10–60 MB | 高 | 商业授权 | 1–2 周 | 低技术/高采购 |
| S8 网关转换 | 全部 | 0（客户端） | 高 | 同 S6 | 1 周 | 隐私/离线 |
| S9 文本降级 | `.doc/.ppt` | 0 | 纯文本 | Apache-2.0 | 3–5 天 | 低 |

## 5. 推荐路线

**P0（本周，0 体积）**
1. `.xls` 去 LibreOffice（S1）：把原文件交给 sheets 视图，保留 LO 作为"侧车转换失败"的第二跳
2. toast 原因分级 + 安装指引 + `EVERROOM_SOFFICE_PATH` 文档化（S0）
3. 埋点：旧格式打开次数 / 格式分布 / 转换结果（成功、侧车失败、LO 失败、回退外部）
4. 建语料库：每种格式 ≥20 份真实文件（含表格、图片、中文、页眉、合并单元格、母版），入 `tests/fixtures` 或独立 corpus 目录

**P1（1–2 周）**：`.doc` 走平台桥（S2）+ 质量闸门；Windows 先给 S9 文本降级或继续依赖 LO。
**P2（视埋点）**：`.ppt` —— 真实占比低 → 保持现状文案 + S9 降级；占比高且要求原样 → S7 商业 SDK 或 S6 随包 LO。
**P3（若拍板"全保真零依赖"）**：S6 或 S7 二选一，按体积预算与采购意愿定。

**决策闸门**（用 P0 的埋点数据回答）：
- 旧格式占全部打开量的比例？三格式各占多少？
- 用户是否要求"能编辑"（现在旧格式一律只读，转换件不回写原格式）？
- 体积预算：dmg 从 496 MB 起，+285 MiB 能否接受？
- 是否允许服务端中转（隐私/离线要求）？

## 6. 工程落点

- **统一入口**：`legacy-convert.ts` 引入 `builtinConverters: Partial<Record<'.doc'|'.xls'|'.ppt', Converter>>`，顺序为「内置 → soffice → 回退外部应用」，缓存键沿用 `(fileId, contentHash)`，产物仍落在 `userData/office-*/` 工作副本目录
- **`.xls`**：`prepareSpreadsheet` 直接返回原始 blob 路径的副本（扩展名保留 `.xls`），交给 sheets 视图；不再预转
- **`.doc`（mac）**：新增 `legacy-convert-textutil.ts`，`textutil -convert docx -output <target> <input.docx>`；**必须**校验产物体积/`word/document.xml` 存在（textutil 读失败也 exit 0）
- **质量闸门**：转换前后做轻量结构比对（源文件 OLE 流里可见的图片/表格标记 vs 产物 XML 里 `w:tbl`/`w:drawing` 数量）；低于阈值 → 标注「简化预览」并在界面提供「用系统应用打开」
- **可编辑语义**：旧格式转换件一律只读（与 `officeEditing.ts` 现状一致），保存走「另存为 OOXML」，绝不回写 `.doc/.xls/.ppt`
- **PPT 文本重建（若选 S9）**：复用 genoffice `pptx-engine` 生成只读 deck，明确标注"按大纲重建，版式非原样"

## 7. 验收口径

| 项 | 口径 |
| --- | --- |
| 语料 | 每格式 ≥20 份真实文件，覆盖表格/图片/中文/页眉页脚/合并单元格/母版/宏启用格式 |
| 结构保真 | 段落数、表格数、图片数、文本相似度（对齐 LibreOffice 转换结果做基线） |
| 渲染保真 | 转换件 → PDF 逐页图 diff（仓库已有 soffice 渲染链路） |
| 性能 | ≤20 MB 文件（`RICH_MEDIA_FILE_MAX_BYTES`）P95 转换耗时、峰值内存 |
| 失败可见 | 任何转换失败必须显式报错，禁止"成功但空白"（textutil exit 0 陷阱） |
| 不可变 | 原 CAS blob 与用户原文件零写入 |

## 8. 许可与合规提示

- **LibreOffice（S6）**：MPL-2.0，允许随专有应用分发，文件级 copyleft 不传染；需附许可证与源码获取方式（TDF 官方链接即可，除非改动 LO 本身）；不得暗示 TDF 背书，商标使用遵循 LO 商标政策
- **POI（S5）**：Apache-2.0；**JRE**：GPLv2+CE（可闭源分发，需附许可与源码获取途径）
- **商业 SDK（S7）**：核对是否有"再分发到桌面应用"条款、离线激活限制、遥测条款
- 三者都要进 `THIRD-PARTY-NOTICES` 打包链路（genoffice 已有 `gen-third-party-notices.mjs` 可参照）

## 附录：实测记录与来源

| 项 | 值 | 方式 |
| --- | --- | --- |
| LibreOffice 26.8.1 macOS aarch64 dmg | 298,845,477 B（285 MiB） | TDF 镜像 HTTP `content-length`，2026-10-26 |
| EverRoom 当前发行包 | `EverRoom-0.1.9-arm64.dmg` 496 MB | `du -sh release/*` |
| genoffice 运行时 | 95 MB | `du -sh apps/desktop/build/genoffice-runtime` |
| 本机 LibreOffice | 未安装（`/Applications` 与 PATH 均无） | `ls` / `command -v` |
| textutil 产出可被引擎解析 | 4 blocks，保留字体/字号/加粗 | `parseDocx(textutil 产出)` 实跑 |
| calamine `.xls` 支持 | `calamine-0.36.0` 导出 `Xls`/`XlsOptions` | `~/.cargo/registry/.../calamine-0.36.0/src/lib.rs:114` |

参考：
- [LibreOffice 下载（TDF）](https://download.documentfoundation.org/libreoffice/stable/)
- [textutil 实测：docx 丢弃表格/图片/链接，读失败仍 exit 0](https://picklog.cc/blog/textutil)
- [textutil → RTF → pandoc 绕开 .doc 表格丢失的实践](https://zenn.dev/shinsei99/articles/legacy-office-convert)
- [Apache POI HSLF/XSLF（.ppt 读写）](https://svn.apache.org/repos/asf/poi/site/publish/components/slideshow/index.html)
- [calamine crate](https://crates.io/crates/calamine)
- [ZetaOffice：浏览器里的 LibreOffice（WASM 路线，体积仍重，仅作备选记录）](https://hn.svelte.dev/item/42249746)
