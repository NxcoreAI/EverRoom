# 场景验证：库里有线索时，主 Agent 自己查、自己解析

> 场景：某个工作空间的「资料库 / 产物」里放着一份 PDF 或 Office 文档，标题就能看出里面有线索。
> 用户在新会话里提一个问题（问题里**不提文件名**），答案只在这份文档里。
> 期望：主 Agent 主动查库、自己判断该不该解析、用工具读出正文后作答——全程一个主 Agent，不委派子 Agent。
>
> 适用范围：`library_browse` / `file_search` / `file_read` 链路（PDF + docx/xlsx/pptx）。桌面端需重启以载入最新 gateway 与 runtime。

---

## 一、期望行为链

| 步骤 | 期望 | 对应实现 |
| --- | --- | --- |
| 1 | 新会话知道"这个工作区的库里有材料"，只知道**数量**，不知道条目 | 每轮 run 注入库规模（`AgentLibraryInventory` → `buildLibraryInventoryContext`），只报份数 |
| 2 | 问题不带文件名时，自己决定怎么找：有实体词用关键词检索，没有就翻库 | `file_search`（关键词、可带 `scope`/`extension`、支持 `offset` 翻页）/ `library_browse`（无关键词分页浏览） |
| 3 | 靠标题（有的话再加分类摘要）判断哪份可能相关，再决定是否解析 | 两个查询工具都只返回标题级信息，绝不预加载正文 |
| 4 | 解析正文：PDF/Office 现场解析，长文分页 | `file_read`（首次解析几秒，结果缓存到该版本；`offset/limit` 分页） |
| 5 | 作答时点明依据哪份材料，并区分材料说法与一般知识 | 系统提示「标题只是线索，不是结论」 |
| 6 | 全程一个主 Agent，不调度 `agent_dispatch`，不要求用户上传/打开文件 | 系统提示「库内材料优先」第 7 条 + 运行提示里同一句硬要求 |

关键设计：**提示里不放条目清单**。资料库可能有上千份，任何"最近 N 条"都是抽样，模型看到就会以为看完了全库；条目一律由模型自己用工具取，翻页翻到找到候选或 `hasMore=false` 为止。

---

## 二、前置准备

1. 在工作台进入某个工作空间（不要用默认对话区的外部会话，空间隔离是这条链路的前提）。
2. 往该空间的**资料库**上传一份文档（推荐 `pdf` 或 `docx`），文件名自带线索，例如：
   - `Nexwing BP 数据汇编 2025-04.pdf`（内含公司营收、客单价等数字）
   - `产品定价与折扣政策 v3.docx`（内含折扣上限、账期）
   - `2026 年度目标拆解.xlsx`（内含各季度目标）
3. 确认「资料库」页签里能看到它（标题即文件名/显示名）。
4. **新开一个会话**（关键：不要沿用之前打开过这份文件的会话，也不要在界面把文件打开成页签），然后直接提问。

---

## 三、验收用例

每条给出：提示词 → 期望工具链 → 验证点。工具调用在对话时间线上以工具卡片显示，可逐条核对。

### 1. PDF 文本层（主用例）

```
我们 2025 年第一季度的营收是多少？毛利率大概多少？
```

- 期望工具链：`file_search`（query 用"营收/BP/2025"之类）→ `file_read`（命中《Nexwing BP 数据汇编 2025-04.pdf》的 fileId）
- 验证点：给的数字能在 PDF 正文里逐字对上；答复点名了这份 PDF；没有先反问"你指的是哪份文件"。

### 2. Office 文档（docx）

```
我们的经销商最高能给到几折？账期最长多久？
```

- 期望工具链：`file_search` → `file_read`（`.docx`）
- 验证点：答的是文档里的政策值，不是行业常识；没有引导用户"打开文档看一下"。

### 3. Office 文档（xlsx）

```
今年 Q3 的营收目标是多少？和 Q2 比变化多少？
```

- 期望工具链：`file_search`（可带 `extension=xlsx`）→ `file_read`
- 验证点：读出的是工作簿里的目标数字；表格内容按行/列说清，不把表头当数据。

### 4. 产物库而不是资料库

```
上次你给我做的那份调研报告，结论那部分怎么说的？
```

- 期望工具链：`file_search`（`scope=artifacts`）或 `library_browse`（`scope=artifacts`）→ `file_read`
- 验证点：命中产物库条目（结果里 `scope=产物`）；结论与正文一致。

### 5. 题面与标题没有字面重合（考"翻库 + 看标题判断"）

```
我们公司现在一共多少人？明年打算扩到多少？
```

- 前提：库里放的是《Nexwing BP 数据汇编 2025-04.pdf》，标题里没有"人数"。
- 期望：`file_search` 无命中后不放弃，改用 `library_browse` 翻库（或用"公司/BP/团队"等词再搜），看到 BP 类标题后 `file_read` 读它。
- 验证点：**不允许**直接答"我不知道"或让用户提供资料；至少有一次 `file_read`；确实没有时如实说"库里这份没有人数"。

### 6. 库里材料很多（考翻页，不预设 ≤ 20 条）

- 前提：该空间资料库放 200+ 份文件，目标文件不在最近更新的一屏里（把它的更新时间排到很后面）。
- 期望：`library_browse` 至少翻两页（`offset` 递增，`hasMore` 从 true 到 false 或翻到候选），或 `file_search` 用关键词直接命中；命中后 `file_read`。
- 验证点：没有在"第一页没看到"之后就断言库里没有；`nextOffset` 被真正使用过。

### 7. 库里确实没有（负例，防止瞎编）

```
我们 2031 年在火星的分部营收多少？
```

- 期望：`file_search` / `library_browse` 各试 1~2 次（换过关键词）→ 明确说"库里没有相关材料"，并说明缺什么。
- 验证点：没有编造数字；没有把不相关文件的内容凑成答案。

### 8. 扫描版 PDF（边界）

- 前提：换成一份扫描件（无文字层）。
- 期望：`file_read` 返回 `empty=true` → 如实说明"这份是扫描件，读不出文字"，并可建议走 OCR/重新提供文本版。
- 验证点：没有编内容，也没有谎称"库里没有材料"。

---

## 四、失败模式（出现任一即不通过）

1. 问题里的实体（公司名/项目名/指标）在库里有对应文件，但 Agent 一次 `library_browse` / `file_search` / `file_read` 都没有就作答。
2. 翻了一页没看到就断言"库里没有"（200+ 份材料的空间尤其要盯这一点）。
3. 让用户"先把文件上传/打开/另存"，或用"你告诉我文件名我再查"结束。
4. 为找文件调用 `agent_dispatch` / `content_analysis` 等子 Agent（这条链路要求主 Agent 自己完成）。
5. 只凭标题或分类摘要给数字（例如看到"定价政策"就编一个折扣上限）。
6. 读到的文件不相关，却把相近内容当答案。
7. 引用不准：说"根据资料"但不说是哪一份，或说成另一份同名文件。

---

## 五、自动化验证

```bash
# 新增工具：分页浏览、scope 过滤、工作区隔离、类型可读性、翻页提示
pnpm --filter @nxcore/gateway exec vitest run tests/library-browse.test.ts

# 库规模计数（只报数量、空库不注入）
pnpm --filter @nxcore/gateway exec vitest run tests/library-browse.test.ts -t collectLibraryInventory

# 运行提示渲染（只报数量、指到三个工具、单 Agent 要求）
pnpm --filter @nxcore/agent-runtime-pi exec vitest run tests/library-inventory-context.test.ts

# 上下游回归（工具行为与提示词未变）
pnpm --filter @nxcore/gateway exec vitest run tests/file-search.test.ts tests/file-read-tool.test.ts
```

自动化只覆盖"工具怎么翻、提示里有没有数量"，**模型是否真的去翻、去解析，必须按第三节在真实会话里跑一遍**（有模型凭据时也可在 agent-debug 页面观察工具序列）。

---

## 六、实现落点（改了什么）

| 位置 | 作用 |
| --- | --- |
| `apps/gateway/src/modules/files/library-browse.ts` | 新增 `library_browse` 工具：按工作区、分页（默认 25 / 上限 100）、`scope`/`extension` 过滤，返回标题级定位信息 + `hasMore`/`nextOffset` |
| `apps/gateway/src/modules/files/file-kind.ts` | `library_browse` 与 `file_search` 共用的类型/可读性/归属口径 |
| `apps/gateway/src/modules/files/library-inventory.ts` | 库规模计数（只要数量，不取条目） |
| `apps/gateway/src/modules/files/service.ts` | 新增 `catalogCounts()`（一条 SQL 出资料库/产物份数） |
| `apps/gateway/src/modules/files/pi-tools.ts` | `file_search` 支持 `offset` 翻页并返回 `hasMore`/`nextOffset`；`file_read` 说明补"资料库/产物任意 fileId 可读、未解析会现解析" |
| `apps/gateway/src/server/create-server.ts` | 注册 `library_browse` |
| `packages/agent-contract/src/index.ts` | `AgentLibraryInventory`（只有 library/artifacts/total 三个数） |
| `packages/agent-runtime/src/index.ts` | `StartRuntimeRunInput.libraryInventory` |
| `packages/agent-runtime-pi/src/library-inventory-context.ts` | 渲染「本工作区文件库里有材料：资料库 N 份、产物 M 份」，并指向 `file_search` / `library_browse` / `file_read` |
| `apps/gateway/src/modules/agent/service.ts` | 每轮 run 开始时取库规模并注入；失败只记日志，不影响对话 |
| `agents/main/agent.yaml` | 工具清单增加 `library_browse` |
| `agents/main/SYSTEM.md` | 路由表两条（事实类问题先查库、不知道有什么就翻库）+「库内材料优先」七条 |

## 七、已知边界

- 翻页是模型的自觉行为：一页 25 条、上限 100 条，材料多时需要多轮 `offset`；提示里要求"翻到找到候选或 `hasMore=false`"，但没有强制的翻页轮数上限。
- 只给标题级信息（标题、类型、分类摘要、标签），不给正文；判断内容必须 `file_read`。
- 扫描版 PDF 无 OCR（`file_read` 走文字层）；图片条目读不出正文，只能当配图素材。
- 解析成本按需发生：首次 `file_read` 一份大 PDF 可能几秒，同一版本之后走缓存。
- 库内容按会话所属工作区隔离：跨工作区的文件既不会出现在浏览结果里，也不会被检索到。
