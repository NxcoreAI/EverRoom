/**
 * 图谱内核公开门面 —— 使用面（各图谱画布/页面）只从这里 import，
 * 不要深入 layout/、pixi/ 内部模块（见 docs/graph-rendering-architecture-design.zh-CN.md）。
 * 内核分层：layout/ = d3-force Worker 布局（纯计算）；pixi/ = 渲染；根目录 = React 组合层。
 */

export {
  PixiForceGraphCanvas,
  type PixiForceGraphCanvasHandle,
  type PixiForceGraphCanvasNode,
} from './PixiForceGraphCanvas'
export {
  useForceGraphLayout,
  type UseForceGraphLayoutInput,
  type UseForceGraphLayoutResult,
} from './useForceGraphLayout'
export type {
  PixiForceGraphEdge,
  PixiForceGraphNode,
  PixiForceGraphIconTextureFactory,
} from './pixi/pixiForceGraphTypes'
export type {
  ForceGraphEdge,
  ForceGraphNode,
  ForceGraphOptions,
} from './layout/forceGraphProtocol'
