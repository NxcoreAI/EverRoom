# 参考 BP 组件差距审计

对照文件：`/Users/xjwang/Desktop/Nexwing Personal aircraft BP.pdf`  
当前实现：`materials/ppt-style-experiments/nexwing-reference-16/`

## 方法

逐页把参考页和当前 render 放大并排看，按“结构、字号、密度、图形、品牌细节”记录差距。  
先处理 p2 / p3 / p5 / p6 / p7 / p11 / p13 这 7 类页面。

## 全局差距

| 差距 | 参考 | 当前 | 状态 |
|---|---|---|---|
| 章节头 | 三枚蓝色 `>>>` + 标题/副标题 | 已新增 `sectionHeader`，p11-p16 已用 | 已修 |
| 标题尺度 | 章节页标题约 40px，不压内容 | 之前用 40pt `h1`，过大 | 已改为 sectionHeader |
| 正文 | 16-18px，行距松 | 组件内常用 caption 10-14px | 部分修，仍需统一放大 |
| 页面编号/页脚 | 多数页无页脚 | 每页有 SOURCE + 页码 | 风格差异，可保留 |
| 照片 | 产品/创始人/场景实拍 | 无照片，用线稿/圆形/卡片代替 | 资产缺失，不可等价 |
| 蓝色品牌带 | 仅部分页有 banner；不是所有页有顶栏 | 之前 p2-p10 都铺顶栏 | 已减，p11-p16 已改章节头 |
| 图表轴 | 折线图聚焦 65-85 万区间 | 从 0 起，线被压平 | 未修，需加 y 轴 min |

## 组件逐项

### founderProfile（参考 p2 / p3）

- 参考：`>>>` + 姓名/角色；p2 是竖向节点 + 大段履历；p3 是“学术/行业/核心技能”三段 + 横向公司时间轴。
- 当前：`showHeader:false` + `sectionHeader`；p2 已放大正文并拉满宽度；p3 已改成“学术 / 三家公司横排 / 技能三栏”，权重按内容分配。
- 当前：p3 公司横排已补连续蓝色时间轴 + 节点圆点；skills 不画线。
- 还差：头像仍是缩写圆；正文仍需最后一档字号统一。
- 优先级：P1 补 `resume` 的 horizontal experience 变体。

### radialFunnel（参考 p5）

- 参考：卫星贴中心左侧环绕；中心大圆；桥接小圆；大箭头到右侧结论圆；底部三行宣言。
- 当前：中心/卫星/漏斗/结论结构已有；卫星已改为环绕；桥接圆仍偏弱，漏斗是浅色四边形，没有真正箭头；底部只有一行。
- 还差：桥接圆 + 箭头尖、卫星数量/大小、底部 multi-line footnote。
- 优先级：P1。

### kpiRows / sectionBanner（参考 p6）

- 参考：左蓝 banner + 5 行 KPI + 迷你机场分布条 + 右蓝 banner + 全球玩家 bar + 协会 callout。
- 当前：p2 已改成 sectionHeader + 双 banner + kpiRows + line chart；结构接近，但缺机场分布小条、协会 callout，折线 y 轴从 0 起。
- 优先级：P1 加 `miniBars` / `callout`；P0 解决 y 轴 min。

### categoryCards（参考 p7）

- 参考：上方蓝 banner + 大英文 quote + 兴趣列表；下方 4 张“蓝色标题条 + 图片 + 指标”卡；底部蓝结论句。
- 当前：只有 4 张卡，且没有图片，卡片高度大、信息少；上方内容和底部结论缺失。
- 还差：`interestList`、`categoryCard` 的图像占位/矢量图、底部结论 banner。
- 优先级：P1。

### advantageGrid（参考 p11）

- 参考：优点/缺点两个标签；3×2 优点卡 + 右侧两条缺点 pill；底部蓝 banner + 小注“消费级产品的关键属性”。
- 当前：结构接近；缺“优点/缺点”标签和 caption；标题过长会被 sectionHeader 收小。
- 优先级：P2。

### featureRail（参考 p13）

- 参考：左侧产品图 + 同心圆；左参数块是竖排蓝 pill；中间平滑曲线 + 5 个胶囊；右侧说明。
- 当前：参数块/曲线/胶囊/说明已有；无产品图与同心圆；曲线偏折；胶囊是矩形不是 pill；没有竖排标签（引擎无文字旋转）。
- 还差：媒体占位（同心圆/线稿）、pill `adj=50000`、曲线平滑。
- 优先级：P1。

## 已修的全局项

- 新增 `sectionHeader`：三枚 chevron + 标题 + 副标题；p11-p16 使用。
- `founderProfile` 增加 `showHeader:false`，避免与页标题重复。
- founder bullets 加圆点，正文改用组件 body 字号（继续调大）。
- p2 改成参考 p6 的“双 banner + KPI 行 + line chart”。
- 新增 `sectionBanner` 组件。

## 下一批

1. 图表 y 轴 min：让 65-85 万的折线不再被 0 轴压平。
2. `categoryCards` 加媒体占位/图标；补 p7 上方 quote + interest list + 底部结论。
3. `featureRail` 加同心圆媒体占位、pill 圆角、平滑曲线。
4. `advantageGrid` 加优点/缺点标签和 caption。
5. `founderProfile` 的 resume 横向公司时间轴。
6. p9 竖向 banner、p10 法规金字塔侧注、p14+ 继续逐页抽。
