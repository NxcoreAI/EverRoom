# 桌面端图谱渲染分层架构设计

> 状态：Implemented（2026-08-27 完成 §4 步骤 1–4；`<ForceGraphSurface>` 组件为可选后续，样板已由 `useForceGraphLayout` 吸收）
> 日期：2026-08-27
> 范围：EverRoom Desktop renderer 图谱内核（现位于 `apps/desktop/src/renderer/src/components/graph/`）及其三个图谱使用面

## 1. 背景与问题

桌面端目前有 **3 个力导向图谱画布、4 个使用面**，全部构建在同一套 Pixi 渲染内核上：

| 图谱 | 画布组件 | 使用面 | 数据来源 |
| --- | --- | --- | --- |
| Room 关系图谱 | `RoomGraphCanvas.tsx` | `HomeView`（全局视图）、`RelationsPane`（单 Room compact 视图） | `useRoomRelationGraph` → 网关关系投影 |
| Wiki 内链图谱 | `WikiGraphCanvas.tsx` | `WikiPane`、`WikiPage`（页面级，**在 context-room 之外**） | `KnowledgeWikiGraphDto` |
| 实体与事实图谱 | `EntityFactGraphCanvas.tsx` | `MemoryPane` | `entityFactGraphModel`（静态记忆 + `useRoomAppliedEntities` 投影） |

内核位于 `components/context-room/ported/graph/`（12 个文件，约 2100 行），分三层：

```text
React 壳层   PixiForceGraphCanvas.tsx        ResizeObserver、渲染器生命周期、props→renderer 同步
渲染层       PixiForceGraphRenderer.ts       场景图与绘制（factory 模式）
             pixiForceGraphLabels / EdgeLabels / HitTesting
             pixiForceGraphTypes.ts          Pixi 结构化类型 + 依赖注入
布局层       forceGraphLayout.ts             主线程 Controller（worker 句柄 + SAB 快照）
             forceGraph.worker.ts / Simulation   d3-force @ Worker
             forceGraphProtocol.ts           SharedArrayBuffer 协议
```

用户诉求：**防止各图谱后续修改迭代互相耦合**。本设计先评估现状，再给出目标分层与增量迁移路径。

## 2. 现状评估

### 2.1 已 经做对、必须保留的设计约束

1. **渲染层类型零 Pixi 依赖**：`pixiForceGraphTypes.ts` 用结构化接口 + `PixiForceGraphDependencies` 依赖注入描述 Pixi 能力，渲染器自身不 `import 'pixi.js'`，测试用假对象即可覆盖（`pixi-force-graph-renderer.test.ts`）。
2. **布局所有权在渲染器之外**：Worker 通过 SharedArrayBuffer 写坐标，渲染器在共享 ticker 里只读 `positions`，用 `revision` 奇偶（写入中/可见）做无锁一致性。渲染与计算天然解耦。
3. **单一渲染器服务全部图谱**：性能优化（label 分级、ParticleContainer、icon 纹理共享）只需做一次，三个图谱同时受益。
4. **数据模型映射与画布分离**：`entityFactGraphModel`、Room 关系映射各自独立，画布组件只做「模型 → 节点/边视觉属性」一层转换。

### 2.2 耦合点（按风险排序）

**P1 内核目录困在 context-room 内部，页面级功能反向伸入**

通用内核位于 `components/context-room/ported/graph/` 五层深处，但 `pages/WikiPage.tsx` 直接 import `context-room/ported/components/WikiGraphCanvas`。图谱内核是应用级能力，却被一个功能模块的目录结构绑架：context-room 内部任何移动/改名都会波及无关页面。同类跨功能 import 已有 5 处（`adapters/uiText`、`MarkdownBody`、`WikiTree`、`types` 等），图谱是其中之一。

**P2 三个画布各自复制同一套组合样板**

每个画布都重复 ~40 行相同结构：`nodeIndex` Map、模型→`PixiForceGraphCanvasNode[]`/`PixiForceGraphEdge[]` 映射、fallback 初始坐标、`ForceGraphLayoutController` 的 useEffect 生命周期（try/catch + `ready.catch` + `dispose`）、`readRevision`/`resizeLayout` 回调。**漂移已经发生**：

- `RoomGraphCanvas` 有 `fitView` ref handle 和世界尺寸自适应（`roomGraphLayoutDimensions`），另两个没有；
- 初始坐标魔法数各自硬编码：Room 传 `screenWidth: 640, screenHeight: 420`，Wiki 螺旋围绕 `(320, 210)`，EntityFact 固定点位围绕 `(260, 140)` —— 三者都隐性依赖 `DEFAULT_FORCE_GRAPH_OPTIONS` 的 `640×420` 默认世界。

改内核生命周期语义（比如 dispose 时机）需要同步改三处，且容易漏。

**P3 领域知识泄漏进内核**

- `roomGraphVisuals.ts`（Room kind 配色/图标映射 + Room 布局尺寸启发式）放在通用 `graph/` 目录，虽然消费者只有 `RoomGraphCanvas`；
- `PixiForceGraphNode.icon` 是封闭枚举 `'book' | 'flag' | 'message' | 'target' | 'user' | 'zap'`，6 个图标的多边形绘制硬编码在通用渲染器的 `createNodeIconTexture` 里。**新图谱想加一种图标必须修改内核**，这是最典型的反向依赖。

**P4 CSS 类名耦合**

`.context-room-graph-shell` / `.context-room-graph-canvas` 被 Room 和 Wiki 两个图谱共享（前缀却是 context-room 领域名），EntityFact 自成一套（`.context-room-entity-fact-graph-*`）。内核的 React 壳层组件 `PixiForceGraphCanvas` 背着领域前缀类名，宿主高度策略散落在三个使用面的 CSS 里。改一处壳层布局规则（例：canvas 脱流防止 Pixi autoDensity 内联尺寸回灌）需要同时验证 3 个宿主，而那本应是内核单点职责。

**P5 协议约定只活在代码注释里**

SAB 布局协议的关键语义 —— 奇数 revision 表示 Worker 正在写入、`drawFrame` 双读 revision 校验、resize 时世界尺寸策略 —— 分散在 `forceGraphProtocol.ts` 与 `PixiForceGraphRenderer.ts` 的注释中，新增画布的作者必须读源码才能正确使用 `revision` 回调。

## 3. 目标架构

### 3.1 分层与依赖规则

```text
L4 使用面    RoomGraphCanvas / WikiGraphCanvas / EntityFactGraphCanvas
            （+ HomeView / RelationsPane / WikiPane / WikiPage / MemoryPane）
            职责：领域数据→视觉映射、领域配色/半径/图标、领域 CSS、a11y
L3 组合层    useForceGraphLayout()  +  <ForceGraphSurface>
            职责：Controller 生命周期、revision/resize 回调、fitView 策略、
                  fallback 初始坐标、壳层 DOM/类名
L2 渲染内核  graph/pixi/*   职责：场景图、绘制、命中、label 分级（不认识任何领域名词）
L1 布局内核  graph/layout/* 职责：d3-force 计算、SAB 协议（纯计算，零渲染依赖）
```

依赖规则（只允许向下）：

- **R1** L1/L2 禁止出现领域词（room/wiki/fact/entity/memory/knowledge）与领域类型 import；可加 grep 门禁（见 §5）。
- **R2** L4 之间互不 import；共享视觉常量（如配色）归各自模型文件。
- **R3** 使用面不直接接触 `ForceGraphLayoutController` 与 `PixiForceGraphRenderer`，只通过 L3。
- **R4** 内核 DOM 类名中性化（`nx-graph-shell` / `nx-graph-canvas`），由 L3 组件持有；使用面类名只做修饰（高度、边框、图例），不再重定义壳层盒模型。

### 3.2 组合层接口（吸收 P2 的样板）

> 落地形态：`useForceGraphLayout()` 已实现并接入三个画布（含测试注入用 `workerFactory`）；
> `<ForceGraphSurface>` 壳组件为可选后续 —— 样板已被 hook 吸收，Surface 只在需要统一
> fitView 策略/a11y 结构时再引入。

```tsx
// 新增 hook：三个画布共同的布局生命周期
const graph = useForceGraphLayout({
  nodes,                       // { id, radius, x?, y? }
  edges,                       // { source, target }
  options?,                    // Partial<ForceGraphOptions>，领域各自调参
})
// graph.snapshot.positions / graph.revision() / graph.drag / graph.release
// graph.resize(width, height) / graph.fitViewHost? —— dispose 与 ready 错误处理内置

// 新增壳组件：包住 PixiForceGraphCanvas + 默认类名 + 事件接线
<ForceGraphSurface
  graph={graph}
  nodes={visualNodes}           // PixiForceGraphCanvasNode[]（领域配色/图标/半径）
  edges={visualEdges}
  selectedId={...}
  onSelectNode={...}
  fallbackPositions={...}
/>
```

fitView、世界尺寸自适应（现 `roomGraphLayoutDimensions` 的通用部分：按节点数估计世界面积）上收为 L3 的可选策略 `worldSizing: 'adaptive' | 'screen'`；Room 特有的 spacing/edgePressure 参数留在 L4 传入。

### 3.3 图标注入（解开 P3）

```ts
// pixiForceGraphTypes.ts
export type PixiForceGraphIconTextureFactory = (
  icon: string, deps: PixiForceGraphDependencies, renderer: PixiRenderer, resolution: number,
) => PixiTexture | null

// PixiForceGraphRendererOptions 增加：
createIconTexture?: PixiForceGraphIconTextureFactory   // 缺省 = 现有 6 个内置图标
```

`icon` 字段从封闭枚举放宽为 `string`；内置 6 图标作为默认工厂保留（Room 图谱零改动）。新图谱（如实体事实图谱想加「属性/关系」小标记）自带工厂，不动内核。

### 3.4 目录与入口（解 P1）

目标位置（已落地）：内核位于 `renderer/src/components/graph/`（L1 `layout/`、L2 `pixi/`、L3 `useForceGraphLayout.ts` + `PixiForceGraphCanvas.tsx` + `graphShell.css`），对外只暴露一个门面：

```ts
// components/graph/index.ts —— 唯一公开入口
export { ForceGraphSurface } from './ForceGraphSurface'
export { useForceGraphLayout } from './useForceGraphLayout'
export type { PixiForceGraphCanvasNode, PixiForceGraphEdge } from './pixi'
```

`WikiPage`、context-room 各画布一律从 `@/components/graph` import。`roomGraphVisuals.ts` 移到 `RoomGraphCanvas.tsx` 旁（其唯一消费者），测试随迁。

### 3.5 协议文档化（解 P5）

在 `graph/layout/` 增加短文档（README.md 或 `forceGraphProtocol.ts` 头部块），写明：SAB 布局上 `revision` 单调递增、奇数 = Worker 写入中（渲染层跳帧）、`control[NodeCount]`/`Status` 语义、resize 消息只影响向心力世界尺寸。让「新增画布」只需读组合层文档。

## 4. 迁移路径（增量，每步可独立合入、测试保持绿）

| 步骤 | 内容 | 风险 |
| --- | --- | --- |
| 1 ✅ | 抽 `useForceGraphLayout` hook，三个画布接入，删除 ×3 样板；行为不变 | 低（纯等价重构，现有测试不动） |
| 2 ✅ | `roomGraphVisuals.ts` 移位到 RoomGraphCanvas 旁；图标改为纹理工厂注入，内置 6 图标做默认实现 | 低 |
| 3 ✅ | 壳层类名中性化（`nx-graph-*`，内核自带 + `graphShell.css`），旧类名保留一个过渡期作别名；三处宿主 CSS 改为只调高度/修饰 | 中（需目检三个宿主） |
| 4 ✅ | 内核目录上移 `components/graph/`（`layout/` + `pixi/` + 组合层）+ 公开门面 `index.ts`；三个画布与测试改走新路径 | 中（牵动 import 面，纯移动） |

步骤 1–3 收益立得（去样板、解图标反向依赖、CSS 单点化）；步骤 4 解决目录绑架，可与下一次大改一并做。

## 5. 门禁建议

- `apps/desktop` 增加一个轻量测试（或 lint 规则）：对 `components/graph/**` 源文件 grep 领域词白名单外的 `room|wiki|fact|entity|memory|knowledge`，命中即失败 —— 把 R1 变成机器约束而非口头约定。
- 新增图谱的 checklist：模型映射独立文件 → 视觉常量随模型 → `useForceGraphLayout` 接线 → 领域类名只修饰高度与周边 UI。

落地记录（2026-08-27）：门禁已实现为 `apps/desktop/tests/graph-kernel-boundary.test.ts`，
共两条断言 —— 内核禁领域词（R1）、渲染层引入内核只走 `@/components/graph` 门面（R3）。
清理内核时顺带修掉了三处历史领域泄漏：Worker 线程名 `wiki-force-layout` → `force-graph-layout`、
错误日志 'PIXI Wiki graph renderer' → 'PIXI force graph renderer'、局部变量 `memory` → `shared`。

## 6. 结论

**需要补架构设计，但内核不需要推倒重写。** 分层本身是健康的（渲染/布局/壳层三段清晰、可测试性好），风险集中在**边界**上：目录位置、三份组合样板、两处领域泄漏（roomGraphVisuals 位置、图标枚举）、CSS 前缀。当前 3 个图谱尚可人工守住；当出现第 4 个图谱（例如文档引用图谱、跨 Room 实体图谱）时，这些边界会硬化成真正的耦合。建议按 §4 顺序增量收敛。
