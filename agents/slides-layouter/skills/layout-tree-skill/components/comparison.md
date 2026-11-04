# 组件参考 · 比较、定位与选择

由 scripts/render-layout-skills.mjs 从 docs/slides-layout-tree-spec.zh-CN.md 生成；语法变更在权威正文维护。本文件只覆盖本用途类别的组件，全部用途索引见 SKILL.md「按展示用途选组件」。

`style` 是改组件样式的唯一入口。值全部是语义枚举，缺省从风格卡推导（输入 `styleTokens.componentDefaults`）。不写裸色号、裸 pt、裸 px；未知字段报错。

| 字段 | 取值 | 语义 |
|---|---|---|
| `surface` | `none \| card \| tint \| outline \| ink \| band` | 底面语言：无底 / 卡面（描边 + 阴影 + 圆角）/ 主色浅档 / 透明描边 / 墨面反白 / 强调色顶条 |
| `separator` | `line \| gap \| none` | 条目之间：1px 分隔线 / 只留间距 / 什么都不留（风格卡关掉分隔线时 `line` 自动降为 `gap`） |
| `align` | `start \| center` | 文本对齐与整组水平落位 |
| `density` | `tight \| normal \| airy` | 内部间距密度：间距与内边距 ×0.75 / 1 / 1.4 |
| `numeral` | `serif \| sans \| none` | 装饰性序号/年份/大数字：标题字体 / 正文字体 / 去掉装饰序号 |
| `accent` | `primary \| accent \| muted` | 唯一强调位（刻标、顶条、星、目标刻度）取色 |
| `motif` | `inherit \| none` | 是否在有底面的组件上画风格卡母题（色带 / 角标 / 幽灵块）；`inherit` 跟随风格卡，`surface:"none"` 时不重复画 |

**styleTokens 语义**（输入字段，是主题口径的权威来源）：

- `composition`：构图家族（`swiss / editorial / poster / immersive`），决定页面骨架倾向。
- `darkCover`：封面/收尾是否自动深色。
- `motif`：页级母题（色带 / 角标 / 幽灵块）。母题由引擎统一铺，`surface:"none"` 的组件不重复画。
- `palette` / `typeScale` / `fonts` / `spacing` / `decoration`：色板、字号档、字体、间距和装饰的默认口径。
- `componentDefaults`：组件 `style` 的默认值。省略即继承。

组件 style 使用上述语义枚举，在主题口径内选择变体。

**组件语义子集**（哪些 style 真的有差）。组件只表达与自己语义相关的维度，未列出的组合对该组件是 no-op：不报错，也没有视觉变化。默认底面写「卡片」的组件用风格卡卡面；写「平铺」的组件只有显式 `style.surface` 才铺底。

| 组件 | 默认底面 | separator | accent | numeral | 图槽 |
|---|---|---|---|---|---|
| comparison | 卡片 | ✓ | ✓ | — | — |
| matrix2x2 | 卡片 | ✓ | — | — | — |
| prosCons | 卡片 | ✓ | ✓ | ✓ | — |
| pricingTiers | 卡片 | ✓ | ✓ | ✓ | — |
| venn | 平铺 | — | ✓ | — | — |

## 参数

「约几元素」用于估算编译后的元素预算；组件选择依据其信息语义和实际容量。

「槽位下限」是该组件还给得出正常版面的经验最小值（列×行，12 列 × 8 行口径）。低于它时组件先按角色下限有限收缩（正文至 16pt、标题至 20pt、注释至 12pt），仍装不下报 `overflow`，并在缺陷 `hint` 里给出本页内容量下的实测需求（如「至少需要约 640×320px（6 列 × 4 行）」）。**装不下时的处理顺序：先扩大槽位 → 再减条目 → 最后换更简单的节点/组件**；不要靠缩字号、删必留内容或增加装饰绕过。

### 27 个核心组件

| 组件 | 形态与语义 | 参数 | 条目与上限 | 约几元素 | 槽位下限（列×行） |
|---|---|---|---|---|---|
| `comparison` | 2~4 方对照，中央分隔随 `style.separator`——多方横评 | `sides: [{ title, tag?, points }]`、`featured?`（重点列下标，0 起） | 2~4 方；`title` ≤24 字、`tag` ≤8 字；每方 2~5 点，单点 ≤60 字；点是字符串或 `{ text, mark: "yes"\|"mid"\|"no" }` | 6~20 | 8×4 |
| `matrix2x2` | 四块面板田字格 + 四边轴标——双维度交叉定位 | `quadrants: [{ title, points? }] ×4`、`axes?: { top?, right?, bottom?, left? }` | 象限固定 4 个；`title` ≤24 字；每象限 1~4 点，单点 ≤40 字；轴标各 ≤20 字 | 8~20 | 8×6 |
| `prosCons` | 左优势右风险两栏，钩/叉图标打头——利弊清单 | `pros`、`cons`: 字符串数组 | 各 2~5 条，单条 ≤60 字 | 4+2×条数 | 6×4 |
| `venn` | 两交叠圆 + 两侧与交集标签——交集关系 | `a`、`b`、`both?` | 各 ≤10 字 | 3~4 | 6×4 |
| `pricingTiers` | 套餐定价卡，`featured` 档垫板描边上浮 + 实心按钮 | `tiers: [{ name, price, unit?, features, cta? }]`、`featured`（必填，恰一个） | 2~4 档；`name` ≤12 字、`price` ≤12 字、`unit` ≤10 字、`cta` ≤8 字；每档 2~4 条特性，单条 ≤24 字 | ~7×档数+3 | 10×5 |

### 10 个页面原子

页面原子只用下表的字段。它们不走核心组件的参数校验：内容放不下时报叶子缺陷（`LAYOUT_LEAF_INVALID`）。以下容量描述用于选型；必留信息超出容量时改用其他合法节点完整承载。`style` 语义同核心组件。

| 组件 | 形态与语义 | 参数 | 条目与上限 | 槽位下限（列×行） |
|---|---|---|---|---|
| `competitorBoard` | 竞品行：厂商 / 产品图 / 特点胶囊 / 市场数据 | `competitors: [{ name, imageUrl?, tags: string[], facts: string[] }]` | 最多画 3 家（超出丢弃）；表头固定为厂商/产品/特点/市场情况；行高不足 60px 或 `facts` 超高时报错 | 10×5 |
