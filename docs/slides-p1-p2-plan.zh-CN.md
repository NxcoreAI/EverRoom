# PPT 组件能力 P1/P2 落地计划

2026-10-16 立项。承接 [component-gap-compare](../materials/ppt-style-experiments/component-gap-compare.html) 对照页的优先级表；P0（质感层/图表/图片基础/页脚）已落地并经真链路验证（见 `materials/ppt-style-experiments/gap-compare-assets/render-p0/`）。本计划按「依赖先行、每批次独立可验证」组织。

## 基线（P0 已具备的底座）

| 能力 | 状态 | P1/P2 如何复用 |
|---|---|---|
| 圆角卡 radiusAdj / 焦点裁切 / duotone / 压图字签 | 已落 | 头像、图槽、logo 墙直接用 |
| addPicture geometry 任意 prst | 已落（roundRect 已通） | 圆形裁切=加 ellipse 一档 |
| a:duotone 写入 | 已落 | —— |
| tint 面板 / 渐层纱罩 / 深色页翻色 | 已落 | pricing featured 列、contactCta 深色底、mapPins 底板 |
| 瀑布/面积/逐点填色 | 已落 | —— |
| 页脚契约（styleParams.footer） | 已落 | 不动 |
| lineArrow 连接箭头（pptx-engine） | 引擎已有 | flowBranch 最小路径直接用 |
| run 字距 letterSpacing→spc（pptx-engine） | 引擎已有 | kicker 眉标透传即可 |

## P1（按批次顺序执行，每批独立验收）

### 批次 1：图片能力补齐（P1 其余批次的依赖，~半天）

1. **圆形裁切**：词汇表 image 叶加 `circle?: true`；网关 ImageElement 透传 `geometry:{prst:'ellipse'}`（genoffice addPicture 已支持任意 prst，预计 0 行引擎改动）。
2. **灰度档**：词汇表 `grayscale?: true`；genoffice a:blip 加 `<a:grayscl/>`（与 duotone 同位置，~10 行）；page-spec 解析透传。
- 验收：gateway/genoffice 各补测试；真链路渲染圆头像 + 灰度 logo。

### 批次 2：五个新组件（核心批次）

| 组件 | 参数 | 引擎表达要点 | 元素预算 |
|---|---|---|---|
| `teamGrid` | `members[{name, role?, bio?, image?}]`，2~6 人 | 头像 ellipse 裁切 + 姓名/职位（主色小字）/两行简介；2~3 列自适应 | ~4×人数 |
| `quotes` | `items[{text, name, role?, avatar?, rating?}]`，2~3 条 | 评价卡：引文 + 细分隔 + 头像圆图 + 星级（icon star ×n，rating 可选缺省不画） | ~8×条数 |
| `comparison` 多方化 | `sides[2~4]{title, points[]}` + `featured`（下标）+ 点三态 | featured 列 tint 面板 + 顶条 + 「推荐」签；点三态 钩/横/叉 图标（icon 集已有 check-circle/minus/x-mark）；normalize 兼容旧 left/right | 6~20 |
| `pricingTiers` | `tiers[2~4]{name, price, unit?, features[≤4], cta?}` + `featured`（恰 1 个） | featured 档：主色描边 + 上浮（y 偏移）+ 实心按钮 + 徽章；其余平面；4 档时 features 降 3 | ~8×档数 |
| `logoWall` | `logos[4~8]{image?, text?}` | 图片：灰度 + 统一高（行高 1/3）；无图：文字字标（caption 号、字距由引擎定、muted 灰） | ≤10 |

- 落点：`tree/components/` 新文件 ×4 + comparison.ts 改造 + `components/index.ts` normalize + SKILL.md 组件表。
- 每组件伴随：normalize 拒绝用例 + 展开结构用例 + 真链路渲染一页。

### 批次 3：图标系统

1. **形态**：icon 叶加 `chip?: "tint"|"solid"`（底衬圆角块/实底反白）、`tone?: "primary"|"accent"|"onDark"`；featureCards/bentoGrid 内图标缺省带 tint 底衬（修「裸图标无落点」）。展开产物 +1 shape/图标，SKILL.md 预算表同步。
2. **扩容**：genoffice `assets/icons` 补 Heroicons 至 120+（财务/法务/医疗/制造/物流场景），重跑 `scripts/bake-icons.mjs`；EverRoom 侧 `tree/icons.ts` 镜像同步；schema optIcon 校验自动随行。
- 风险：组件内底衬使既有页面元素数 +N，注意 48 cap 的存量页回归（跑金标准全量树测试）。

### 批次 4：文字形态

1. **runs 混排**：text 叶 `text` 兼容 `Array<{text, bold?, tone?}>`（normalize 层归一，string 照旧）；行内色限定 primary 档；renderTextLeaf 映射进段落 runs（spec 结构已支持）。
2. **kicker 眉标**：新 variant `kicker`（caption 号 + 字距 + 主色）；genoffice page-spec SpecRun 透传 `letterSpacing`（引擎 generate/parse 均已支持，只缺这一层）。
3. **侧条引用**：quote 组件加 `style?: "bar"`（4px 主色竖条 + 左对齐）。
- 验收：混排/kicker 各一页真链路渲染。

### 批次 5：流程连接（最小路径先行）

1. **path 箭头**：path 叶加 `stroke?: { tone: "primary"|"divider"|"muted", widthPt?, arrow?: true }`（颜色走主题词档，不开色号）；genoffice custGeom 的 `a:ln` 写 `tailEnd`（lineArrow 同款 triangle，~15 行）。
2. **flowBranch 组件**（评估后决定是否进 P1 尾或 P2）：节点（开始/过程/判断/结束）+ 分支边自动布线。**风险：自动布线质量难保证**——先交付 1 的手工拼装能力，真实 deck 跑一轮再定。

## P2（P1 批次 1-2 之后可穿插）

| 项 | 参数 | 引擎要点 | 前置 |
|---|---|---|---|
| `gantt` | `tasks[3~6]{name, start, end, done?}` + `milestones[]` + `today?` | 日期归一引擎算条形位置（手写 ISO 日期差，不引依赖）；done 实心/计划浅档双色分段；里程碑 diamond 预设；today 虚线 rect | 无 |
| `mapPins` | `pins[{x, y, label?, value?}]`（示意坐标 0~100）+ 可选连线 | 示意地块=tint 圆角底板（非真实地理）；节点 circle + 数量徽章 + line 连线；**不做瓦片地图** | tint（P0） |
| `contactCta` | `headline, channels[{icon?, text}], qrPayload?` | 深色渐层底自动套用；QR=引入 `qrcode-generator`（纯 JS 矩阵，无 canvas）→ 单个 path 元素（custGeom 多子路径，占 path 预算 1）；深浅两档反色 | 渐层底（P0）、新 npm 依赖过审 |

## 风险与协调

1. **共享检出**：slides-layout 仍有在飞改动（上一轮 schema.ts 被旧版写回过一次）。每批次开工前跑 `tree.test.ts` 基线；提交切分由主线掌控。
2. **genoffice 累积改动**：批次 1（ellipse/grayscl）、批次 3（图标烘焙）、批次 4（letterSpacing 透传）、批次 5（ln tailEnd）、P2（无）——建议攒一批走一次专线 PR，合并后主仓 bump 指针。
3. **元素预算**：新组件全部受 48 cap；每个组件落地后实测「约几元素」写回 SKILL.md，避免布局代理排页超限。
4. **LibreOffice 预览局限**：a:duotone 已知不渲染；ellipse/grayscl/diamond 均为 LibreOffice 支持项，但验收口径以「PPTX XML 正确 + soffice 出图无异常」双验。

## 执行顺序总表

```
P1-1 图片补齐 ──┬─→ P1-2 五组件 ──→ P1-3 图标 ──→ P1-4 文字 ──→ P1-5 流接
                └────────────────→ P2 gantt / mapPins（可穿插）
P2 contactCta（依赖 npm 依赖评审，最后）
```
