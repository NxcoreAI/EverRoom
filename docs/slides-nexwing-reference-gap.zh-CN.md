# Nexwing BP 对标差距诊断

对比对象：`/Users/xjwang/Desktop/Nexwing Personal aircraft BP.pdf`（Canva，27 页，1920×1080，深蓝品牌系统）。
被检对象：最新 `Nexwing Personal Aircraft 商业计划书.pptx`（plan 13 页，实际落页 12 页）。

![参考 deck](../screenshots/nexwing-audit/reference-contact.png)
![最新生成](../screenshots/nexwing-audit/generated-final-contact.png)

## 结论先说

不是单一排版 bug，而是**内容预算、参考风格、版式组件、素材质量**四层同时偏离：

1. **页数预算把 27 页 BP 压成了 13 页**，大量章节在 planner draft 阶段就没了。
2. **editor 又把每页压到 message + 3 facts**（prose 减少 87%，18 条 dropped），表格/参数全部进讲稿。
3. **风格卡不是从这份 PDF 迁移的**，而是文本生成的“极简大留白/近白底 + 深靛蓝”，与参考的深蓝品牌、满版信息图相反。
4. **v2 语法此前没有 table / 图表以外的信息图组件**，layouter 只能做“文字 + 图片 + stats”，参考里的表格、对比、时间轴、飞轮做不出来。
5. **素材检索返回缩略图/竞品图**：封面 300×168、品牌页 275×183、产品页 480×360；产品页用的还是带 `EHANG` 标识的竞品图。
6. 两个确定性 bug 叠加：第 5 页 stats 竖排 ink 重叠被 genoffice 拒页，落页追加语义直接丢了这一页；layouter 又拿 planner 标题当 h1 而非 `copy.message`。

## 证据

### 1. 内容预算：27 → 13 → 12

- planner SYSTEM 原文有“页数克制：能 12 页讲清的不做 18 页”，这次按 13 页出方案。
- 参考 27 页的主干章节里，以下在草稿页就缺失：
  - 两位创始人独立页（参考 p2/p3，含照片与履历）
  - 使命/愿景蓝底金句页（p4/p9/p17）
  - 人类飞行梦想飞轮（p5）
  - TAM/SAM/SOM 市场规模图（p6）
  - 目标用户与高端户外生活方式（p7/p8）
  - 超轻型飞行器法规/认证对比（p10）
  - 无人机/VTOL 竞品对照表（p11/p12）
  - 产品特征/关键功能/为什么多旋翼/构型对比（p13–p16）
  - 技术生态（p17）
  - 战略演进与品类路径（p18/p19）
  - 财务预测表、售价与毛利表（p24/p25）
  - 供应链成熟度（p26）
- 草稿 13 页只剩：封面、品牌、门槛、市场、参数、安全、成本、竞品、团队、财务图、路线图、融资、收尾。

### 2. editor 压缩过深

`slides_storyboards` 最近记录：

```json
{
  "pageCount": 13,
  "draftPageCount": 13,
  "proseChars": 435,
  "draftPointsChars": 3445,
  "reductionPct": 87,
  "dropped": 18,
  "passed": true
}
```

每页 copy 只剩 kicker/message/1 supporting/≤3 facts；参数表、成本表、竞品表、费用表全部被塞进 speakerNotes。BP 的“表格即内容”被当成“冗余文字”压掉了。

### 3. 风格卡与参考相反

本次 style session：

- `palette.background #fbfbfb`、`primary #31346c`、`accent #857a56`
- 版式倾向“极简、大留白、瑞士网格”
- `selected_image_hash` 对应的风格纵览图是一个灰色骨架占位图，不是参考 PDF 的深蓝信息图

参考 deck 是 **深蓝渐变 + 白底高密度模块 + 蓝色表头 + 产品大图**；生成 deck 是 **近白底 + 大留白 + 宋体/靛蓝数字 + 通用摄影图**。风格阶段没有拿到参考 deck 的视觉样本，这是结构性偏差。

### 4. 版式组件不足

v2 原来只有 `text/image/shape/stats/chart`，没有 `table`；也没有 group/connector/icon/时间轴/飞轮。参考页大量依赖：

- 表格（成本、竞品、参数、财务、售价）
- 对比矩阵、金字塔、飞轮、时间轴、双泳道路线图
- 蓝底章节页/金句页
- 产品实拍/渲染图与人物照片

layouter 只能用 stats 卡片和图片填，页面自然变成“标题 + 3 个数字 + 一张图”的 AI  consulting 模板。

### 5. 素材质量

实际素材尺寸（按 blob 头解析）：

| 页面 | 素材 | 尺寸 | 问题 |
|---|---|---|---|
| 封面 | `bbe797…` | 300×168 | 铺满 1280×720 后严重糊 |
| 品牌页 | `8ad04a…` | 275×183 | 右侧小图也糊 |
| 产品参数 | `51def9…` | 480×360 | 非本品；图中可见 `EHANG` 标识 |
| 行业门槛 | `5c37d5…` | 1792×1024 | 清晰，但为通用机场图 |

参考 deck 用的是产品渲染/官方照片；生成 deck 用了缩略图和竞品图。`material_search` 只按语义匹配，没有品牌/实体/分辨率校验。

### 6. 第 5 页丢失（确定性 bug）

- p05 `产品参数` layouter 树：4 个 stats 放在 `col[1,7], row[5,8]` 的窄高槽，`buildStats` 原先竖排等分。
- 每项 h2 数字 + label 的 ink 高度大于等分高度，genoffice 报：

```
page rejected — element 5 ("115 kg整机重量") ink ... overlaps element 6 ...
```

- `runLayouterTail` 落页失败后采用“追加”语义：第 6 页填到第 5 页的位置，于是最终 deck 12 页、页码 05 缺失。
- 已修：`buildStats` 在宽而矮的槽位自动转 2×2 网格；p05 现在 13 页全部编译通过。

### 7. layouter 用了 planner 标题

- v2 输入同时传了 `title`（planner 行动标题）和 `copy.message`；layouter 优先用 title。
- 结果：p04 标题“美国有 85 万持证飞行员，机场超 2 万个”换行；p02 标题过长；封面同时出现 display title 与 lead 的近义重复。
- 已修：v2 不再传 `title`，主标题强制用 `copy.message`；skill/SYSTEM 同步。

### 8. composition 被 layouter 改掉

p07（竞品）、p11（融资）输入 composition 是 `editorial`，实际树是 `hero-data`；表格页被改成数字页。已加落页告警，v2 skill 明确“composition 必须等于输入”。

## 已落地的修复

- stats 宽槽 2×2，修 p05 丢页；用现有 13 页 layout trees 离线重编验证通过（`screenshots/nexwing-audit/nexwing-fixed-13p.pptx`）。
- v2 输入去掉 planner `title`，主标题回到 `copy.message`。
- v2 新增 `table` 节点；editor `data.table` + prompt，参数/成本/竞品/财务表可保留 3~8 行。
- 低分辨率素材落页前丢弃：封面/沉浸页 <1280×720、其他配图 <800×450，退化为纯色/图形版式并告警。
- planner 页数规则改为“按参考/完整 BP 覆盖主干，通常 18~24 页；不按固定 12 页裁剪”。
- planner 素材规则：本品/团队页不得使用竞品/第三方产品图；宁可不配图。
- editor timeout 90s→420s（真机 12 页耗时 254s，原 90s 必超时）。

## 参考抽取与 20 页干线（已落地）

- `materials/ppt-style-experiments/nexwing-reference/analyze.mts`：PDF → 渲染页 → `reference-style/v1` + 页标题。
- 实测参考抽取：27 页、`background #FCFCFC`、`primary #393BE4`、`density dense`、`darkCover true`、`composition editorial`。
- `reference-outline-20.json`：把 27 页合并成 20 页主干（封面/创始人×2/愿景/市场/用户/品牌/定位/法规/竞品/参数/特征/技术/构型/生态/战略/融资/财务/收尾）。
- `slides_draft` 新增 `referenceStyle` / `referenceOutline` / `targetPages`；planner 按参考章节补全，styler 按参考色板/密度出风格卡，generate 时参考 palette 覆盖风格卡 palette。
- 尚无模型重跑：这轮只把“参考进入链路”的能力和 20 页大纲做出来；重启网关后用 `targetPages:20` 重新 draft → style → generate 才会得到新 deck。

## 视觉与 AI 味修复（2026-10-19 晚）

- v2 新增 `icon`（Heroicons 名称校验）与 `path`（SVG d → custGeom）节点；layouter 可用 icon/path 做门槛、团队、时间轴、装饰线。
- 表格新增 `style: banded | outline | minimal`；第一列加粗、列宽可配；prompt 要求表头/首列/数值列分层，不再全表一个样。
- skill 增加底色/标题规则：章节页 dark 或 primarySoft，内容页可用 surface；kicker 加短线/色块，标题区与内容区分隔。
- editor copy 新增 AI 味清洗：`统计口径/待核实/待补充/未核实/仅作参考/示意/占位/待确认/……/···` 从页面 copy 移除；`source` 只留来源名与年份，口径进 speakerNotes。
- 这些是生成侧规则，当前 16:29 成品尚未重跑，下一轮才会生效。

## 下一步

1. **按参考 deck 重生成**：明确 20~24 页、覆盖参考主干；不要再用“极简 12 页”口径。
2. **把参考 PDF 作为视觉参考输入**：抽 3~5 张代表页，派生 palette/字体/网格/表头/图片处理，而不是只给文字风格卡。
3. 用新 table 节点重跑参数、成本、竞品、财务页；补 group/connector/时间轴组件后再对标飞轮/路线图。
4. 素材侧：参考 PDF 里的产品图/创始人照片入库；本品页禁止竞品图；低清素材直接退化为图形页。
5. 生成后按 `review.csv` 做一次 3 人盲评，重点 Q1 质感/Q2 信息层级。
