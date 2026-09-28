/**
 * 大纲滚动锚点（当前章节高亮的几何口径）：以阅读区顶缘 + 小偏移为准线，
 * 按文档序取最后一个顶缘越过准线的标题。不用扩展 isActive 的
 * `scrollTop >= offsetTop` 口径——offsetTop 相对 offsetParent 而非滚动容器，
 * 两个坐标系不一致，停靠工具栏/大纲推挤布局下高亮会漂移差一节。
 * 纯函数保持可单测；items 约定按文档序传入。
 */
export const OUTLINE_ACTIVE_LINE_OFFSET_PX = 8

export function computeOutlineActiveId(
  items: Array<{ id: string }>,
  topFor: (id: string) => number | null,
  containerTop: number,
  offset: number = OUTLINE_ACTIVE_LINE_OFFSET_PX,
): string | null {
  const line = containerTop + offset
  let active: string | null = null
  for (const item of items) {
    const top = topFor(item.id)
    // 找不到 DOM（如未渲染）跳过，不中断后续判定。
    if (top === null) continue
    if (top <= line) active = item.id
    else break
  }
  return active
}
