# 组件参考 · 时间与顺序推进

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
| `timeline` | `direction` / `axis` | `h \| v` / `line \| dots \| none` |
| `steps` | `connector` | `line \| gap \| none` |
| `chevron` / `pyramid` / `funnel` | `form` | `outline \| filled \| tint` |

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
| timeline | 平铺 | 轴线独立控制 | ✓ | ✓（年份字体） | — |
| steps | 平铺 | connector 独立控制 | ✓ | ✓ | — |
| eraRail | 平铺 | ✓（脊线/刻度） | ✓ | ✓ | — |
| chevron / pyramid / funnel | 平铺 | — | ✓ | — | — |

## 参数

「约几元素」用于估算编译后的元素预算；组件选择依据其信息语义和实际容量。

「槽位下限」是该组件还给得出正常版面的经验最小值（列×行，12 列 × 8 行口径）。低于它时组件先按角色下限有限收缩（正文至 16pt、标题至 20pt、注释至 12pt），仍装不下报 `overflow`，并在缺陷 `hint` 里给出本页内容量下的实测需求（如「至少需要约 640×320px（6 列 × 4 行）」）。**装不下时的处理顺序：先扩大槽位 → 再减条目 → 最后换更简单的节点/组件**；不要靠缩字号、删必留内容或增加装饰绕过。

### 27 个核心组件

| 组件 | 形态与语义 | 参数 | 条目与上限 | 约几元素 | 槽位下限（列×行） |
|---|---|---|---|---|---|
| `timeline` | 轴线串节点，上标签下说明——进程与先后 | `direction?`（`h`/`v`，缺省 h）、`axis?`（`line`/`dots`/`none`）、`items: [{ label, text }]` | 3~6 条；`label` ≤24 字、`text` ≤80 字 | 10~19 | 8×4 |
| `steps` | 大编号 + 标题 + 说明横排——有序步骤 | `connector?`（`line`/`gap`/`none`）、`items: [{ title, text? }]` | 3~5 步；`title` ≤24 字、`text` ≤80 字 | 6~15 | 8×4 |
| `chevron` | 箭头形横排相扣，文字压箭头上——单向推进 | `form?`、`items: [{ title, text? }]` | 3~5 段；`title` ≤16 字、`text` ≤40 字 | 6~15 | 10×3 |
| `eraRail` | 脊线压区域顶，刻度下挂衬线年代 + 静音短注，`highlight` 条目主色——年代轴、节奏带 | `items: [{ era, note }]`、`highlight?`（重点条下标） | 3~6 条；`era` ≤8 字、`note` ≤12 字，各限一行 | 1+3×条数 | 8×2 |
