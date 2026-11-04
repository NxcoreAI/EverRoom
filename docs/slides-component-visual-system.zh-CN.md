# 组件视觉系统 v3：面向通用融资 BP 的审美收敛

- 日期：2026-11-04（v2 → v3，对应「PPT 组件审美优化」规格）
- 目标：组件适合投资人快速阅读——**结论突出、数据清楚、装饰克制、主次准确**。
  默认无衬线商务表达；风格卡显式选择的编辑风格（衬线 numeral 等）继续生效。
- 仍然只读 `ComponentSkin`，不写裸像素；组件名、输入结构与 style 入口不变。

## 1. v2 遗留问题（本轮修正）

1. **装饰过量**：eyebrow 短规则、标本索引、幽灵序号、4px 顶条、自动「推荐」徽章层层叠加，
   装饰与内容争夺注意力。
2. **强调错位**：bento 默认反白首格，把排列顺序误表达为重要程度；featured 同时叠
   反白 + 描边 + 顶条 + 徽章 + 阴影。
3. **字号漂移**：`metrics(frame)` 按 `frame.h/576` 缩放（0.48–1.4），同一风格卡下
   同级文字随框高各漂各的；小框正文可缩到 11pt，低于可读底线。
4. **兜底掩盖问题**：`expandComponent` 以 0.85/0.72/0.6 三档整体缩字号硬塞，
   真实装不下的内容被压成蚁字而不是报可执行缺陷。

## 2. 设计语言

### 2.1 字号角色（固定在 1280×720 设计基准，不随框高缩放）

| 角色 | 默认字号 | 收缩下限 | 用途 |
|---|---|---|---|
| `display` 核心数据 | 56–80pt，按数字长度适配 | 56pt | KPI 数字、价格、年份 |
| `title` 组件内标题 | 24pt | 20pt | 条目/卡片/象限标题 |
| `body` 正文 | 18pt | 16pt | 要点、正文、说明 |
| `label` 标签 | 14pt | 12pt | 全大写微标签、职位 |
| `caption` 注释 | 12pt | 12pt | 单位、注脚、简介 |

- 同一风格卡下同级文字保持一致；`density` 只乘间距，不乘字号。
- 数字默认**正文字体**；显式 `numeral: serif` 恢复衬线，`numeral: none` 省略装饰性数字。
- 溢出次序：换行 → 压缩非必要间距 → 正文有限缩至 16pt / 标题至 20pt；注释不低于 12pt。
- 仍装不下直接抛 `LAYOUT_LEAF_INVALID`（布局错误通道，提示扩大区域或减少内容）；
  **没有**整体缩字号兜底。

### 2.2 间距与卡片

- `metrics.pad/gap/tightGap` 仍按 frame 短边与 density 推导（间距可压缩，字号不可）。
- 卡片默认轻底面、无阴影；显式风格卡 `cardStroke/cardShadow` 与 `style.surface` 覆盖继续生效。

### 2.3 结构件：语义 vs 可选装饰

**表达语义（保留）**：
- 分组线：stats 列间发丝线、pointList/teamGrid 条目间线、comparison 标题下规则——分隔有分组作用的内容。
- 顺序/连接：timeline 轴线与节点、steps 连接轨道与落点、cycle 环与编号节点、orgChart 肘形连线。
- 层级：orgChart 根部 ink 卡承担层级对比。
- 编号：`numbered: true` 的 pointList 序号、steps 的 STEP 标签、cycle 节点编号。
- 徽章：comparison/pricingTiers **已有标签文本**时显示（featured 徽章不自动生成「推荐」文案）。

**纯装饰（默认取消）**：
- 数据组件（stats/progress）的短强调线；内容组件（featureCards/bentoGrid/pointList）的
  eyebrow 规则、标本索引、压底序号；steps 的幽灵大序号；quote/quotes 的强调短规则；
  persona 的装饰序号；featured 的 4px 顶条。
- `motif` 只装饰组件外表面（surface ≠ none 时一次），不在每个条目内重复铺设；
  页级母题由 `pageMotifElements` 统一承担。

### 2.4 视觉强调对应主次

- **bentoGrid**：默认各项平级，不反白首格。
- **comparison / pricingTiers featured**：浅强调底（`emphasisSoft`）+ 一条强调边（1.25pt），
  不同时叠加重描边、顶条、徽章与阴影。
- 图标是辅助信息：小尺度（≤40px），不为填补空白放大；wide 条带不放补空大图标。

### 2.5 组件内部比例

- 卡内标题与正文组成紧凑阅读组**顶对齐**；图片卡图片在上、文字在下
  （featureCards/bentoGrid）。wide 条带同样顶对齐。
- comparison 标题起点与首条要点起点跨列统一（标题高取全组最大值）。
- teamGrid 头像尺寸全组统一（姓名基线对齐），简介自然向下；persona 右栏要点行均分。

## 3. 逐组件方向（v3 增量）

| 组件 | v3 变化 |
|---|---|
| stats | 去短强调线；数字 56–80 长度适配（单位可缩至 12pt）；列间线保留 |
| timeline | 轴线/节点/刻线保留（语义）；年份按格子宽度适配 |
| steps | 去幽灵序号与逐列短规则；STEP 标签 + 轨道保留；内容顶对齐 |
| pointList | 编号仅 `numbered:true`；标签 title、正文 body；条目线保留 |
| featureCards | 去短规则与压底序号；图标 40px；图片上文字下；溢出降档（16/20 + 压间距） |
| comparison | featured = 浅底 + 强调边；徽章仅在已有 tag；标题/要点跨列统一；要点可降 16pt |
| quote | 去顶部短规则；引文与署名为主体 |
| quotes | 去标本索引与署名短线；星级保留；引文收缩下限 16pt |
| teamGrid | 去索引序号；头像全组统一；简介自然向下 |
| persona | 去短规则与右栏装饰序号；结构竖线保留 |
| bentoGrid | 默认平级（不反白首格）；去索引/短规则/wide 补空大图标；溢出降档 |
| pricingTiers | featured = 浅底 + 强调边（去反白/顶条/阴影）；CTA 保留 |
| 其余（agenda/matrix2x2/prosCons/layeredStack/logoWall/indexHeader/eraRail/chevron/pyramid/funnel/venn/calloutBox/cycle/progress/orgChart） | 字号换固定角色；结构不变（indexHeader 的章节短规则属页级结构件，保留） |

## 4. 实现记录（2026-11-04，v3）

- `ComponentSkin.metrics(frame)`：文字角色固定为 2.1 表值；间距仍按 frame/density。
- `theme.design.numeral` 缺省 `serif → sans`（数字默认正文字体；显式配置优先）。
- `expandComponent`：移除 0.85/0.72/0.6 整体缩字重试；装不下直接走布局错误通道。
- 组件内有限收缩：stats 数字 56 下限；featureCards/bento/comparison 按 16/20 档降
  （全组同档，同级一致）；quotes 引文 16pt 下限；callout 结论句 20pt 下限。
- 回归基线：`aesthetic-convergence.test.ts`（行为）+ `aesthetic-contact-sheet.test.ts`
  （5 场景 × 全宽真实编译零缺陷 / 半页·窄栏字号下限）。视觉评审轮换真机渲染时以此对照。
- 已有文档不主动重绘；重新生成/重新编译时应用新样式（默认外观有意变化）。
