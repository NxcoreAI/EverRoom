/**
 * 调试页「来源」的纯函数：排序、默认选中、标签与连接态文案。
 * 不依赖 React / DOM / fetch，便于单测；App 与 api 客户端共用这里的定义。
 *
 * 两种来源（见 docs/agent-debug-offline-archive.zh-CN.md §2.2）：
 * - live：Gateway 代理，标签「<label> · v<version>」，进程不在时追加「 · 离线」；
 * - archive：dev server 直读磁盘归档，标签「（历史归档 ·）<label> · 只读」。
 */
import type { DebugSource } from './api'

/** archive 来源的连接态文案：只读、与 EverRoom 是否运行无关。 */
export const ARCHIVE_CONNECTION_LABEL = '历史归档 · 只读'

/** 标签里「历史归档」前缀只出现一次（host 的 label 可能已经带上了）。 */
const ARCHIVE_PREFIX = '历史归档'

export function isArchiveSource(source: Pick<DebugSource, 'backend'> | null | undefined): boolean {
  return source?.backend === 'archive'
}

/**
 * 来源下拉标签：live = `<label> · v<version>`（不可用时追加 ` · 离线`）；
 * archive = `历史归档 · <label> · 只读`（label 已含「历史归档」时不重复前缀）。
 */
export function sourceLabel(
  source: Pick<DebugSource, 'backend' | 'label' | 'version' | 'available'>,
): string {
  if (isArchiveSource(source)) {
    const base = source.label.includes(ARCHIVE_PREFIX) ? source.label : `${ARCHIVE_PREFIX} · ${source.label}`
    return `${base} · 只读`
  }
  const base = `${source.label}${source.version ? ` · v${source.version}` : ''}`
  return source.available ? base : `${base} · 离线`
}

/** 下拉 option 的 hover title：live 给代理目标；archive 给归档目录与 run 概况。 */
export function sourceTitle(source: DebugSource): string {
  if (!isArchiveSource(source)) {
    const base = `代理目标 ${source.baseUrl}`
    return source.available ? base : `${base} · 当前不可用（Gateway 进程未运行）`
  }
  const dir = source.archiveDir?.trim() || '未知目录'
  const latest = source.latestStartedAt ? ` · 最新 ${source.latestStartedAt}` : ''
  return `归档目录 ${dir} · 共 ${source.runCount} 条历史 run${latest}`
}

/**
 * 来源排序：可用 live（发现顺序）→ archive（发现顺序）→ 不可用 live。
 * 不可用的 live 沉底，避免 EverRoom 退出后默认落在死来源上。
 */
export function orderDebugSources(sources: readonly DebugSource[]): DebugSource[] {
  const availableLive: DebugSource[] = []
  const archives: DebugSource[] = []
  const unavailableLive: DebugSource[] = []
  const unavailableArchive: DebugSource[] = []
  for (const source of sources) {
    if (isArchiveSource(source)) {
      if (source.available) archives.push(source)
      else unavailableArchive.push(source)
      continue
    }
    if (source.available) availableLive.push(source)
    else unavailableLive.push(source)
  }
  return [...availableLive, ...archives, ...unavailableLive, ...unavailableArchive]
}

/**
 * 选中来源的决策（初始加载与 15s 刷新都走这里）：
 * 1. 当前来源仍在列表里且可用 → 保持（不打断用户选择）；
 * 2. 否则取 {@link orderDebugSources} 第一个（第一个可用 live → 第一个 archive → 第一个来源）。
 * 当前 live 来源变不可用时，这里会自动落到可用的 archive（EverRoom 退出 → 历史归档）。
 * 列表为空返回 null。
 */
export function pickSourceId(
  sources: readonly DebugSource[],
  currentId: string | null | undefined,
): string | null {
  if (currentId) {
    const current = sources.find((source) => source.id === currentId)
    if (current?.available) return current.id
  }
  return orderDebugSources(sources)[0]?.id ?? null
}

/** archive 来源的连接态文案；live 返回 null（由轮询状态决定「在线 / 离线 / 连接中」）。 */
export function sourceConnectionLabel(source: DebugSource | null | undefined): string | null {
  return isArchiveSource(source) ? ARCHIVE_CONNECTION_LABEL : null
}

/** archive 来源的连接态 hover title（归档目录 + 无需 EverRoom 运行）；live 返回 null。 */
export function sourceConnectionTitle(source: DebugSource | null | undefined): string | null {
  if (!isArchiveSource(source)) return null
  const dir = source?.archiveDir?.trim() || '未知目录'
  return `归档目录 ${dir} · 直接读取本机归档，无需 EverRoom 运行`
}
