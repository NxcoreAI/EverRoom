# 组件参考 · 人物与团队介绍

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

**组件专属变体**（每个组件至多一个，全部枚举）：

| 组件 | 变体 | 取值 |
|---|---|---|
| `teamGrid` | `avatar` | `circle \| initial` |

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
| teamGrid | 卡片 | ✓ | ✓ | ✓ | ✓ |
| persona | 卡片 | ✓ | ✓ | ✓ | ✓ |

## 参数

「约几元素」用于估算编译后的元素预算；组件选择依据其信息语义和实际容量。

「槽位下限」是该组件还给得出正常版面的经验最小值（列×行，12 列 × 8 行口径）。低于它时引擎先自动缩字（0.85/0.72/0.6 三档），仍装不下报 `overflow`，并在缺陷 `hint` 里给出本页内容量下的实测需求（如「至少需要约 640×320px（6 列 × 4 行）」）。**装不下时的处理顺序：先扩大槽位 → 再减条目 → 最后换更简单的节点/组件**；不要靠缩字号、删必留内容或增加装饰绕过。

### 27 个核心组件

| 组件 | 形态与语义 | 参数 | 条目与上限 | 约几元素 | 槽位下限（列×行） |
|---|---|---|---|---|---|
| `persona` | 左头像圆 + 右姓名/角色/要点——人物画像 | `person: { name, role? }`、`points`、`image?` | 要点 2~5 条，单条 ≤40 字；`name` ≤24 字、`role` ≤40 字 | 4~6 | 6×4 |
| `teamGrid` | 圆头像 + 姓名 + 职位（主色）+ 两行简介——团队网格 | `avatar?`、`members: [{ name, role?, bio?, image? }]` | 2~6 人（≤4 人单行，5~6 人两行各 3）；`name` ≤16 字、`role` ≤24 字、`bio` ≤48 字 | ~4×人数 | 10×4 |

### 10 个页面原子

页面原子只用下表的字段。它们不走核心组件的参数校验：内容放不下时报叶子缺陷（`LAYOUT_LEAF_INVALID`）。以下容量描述用于选型；必留信息超出容量时改用其他合法节点完整承载。`style` 语义同核心组件。

| 组件 | 形态与语义 | 参数 | 条目与上限 | 槽位下限（列×行） |
|---|---|---|---|---|
| `founderProfile` | 创始人履历：左轨节点 + 章节正文 + 底部技能条 | `personName`（必填）、`role?`、`subtitle?`、`variant?`（`timeline` 默认 / `resume` 左轨更宽）、`showHeader?`（`false` 时只画正文，页面已有 `sectionHeader`）、`sections: [{ label?, heading, bullets?, columns?, timeline?, weight? }]`、`skills?: [{ title, text }]` | `sections` 每段给 `bullets` 或 `columns: [{ title, meta?, text }]`（columns 画横向公司时间轴，`timeline: false` 关掉）；`weight` 0.5~2.2（引擎夹取）；正文每行不足 44px 或单栏文字超高时报错 | 10×6 |
