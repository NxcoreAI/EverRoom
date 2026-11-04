import { FolderOpen, RefreshCw, Trash2, TriangleAlert, Wand2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import type {
  AgentScratchListing,
  AgentSpaceCacheStats,
  AgentSpaceLayout,
  AgentWorkspace,
} from '@nxcore/agent-contract'

import { workbenchApi } from '../api'
import { Modal } from '../ui/modal'
import { Button, Spinner } from '../ui/primitives'

/**
 * 概览页的「空间目录」卡：把磁盘上的项目空间暴露给用户。
 *
 * 方案见 docs/project-space-layout-plan.zh-CN.md：
 * - 空间 = 一个目录，根上只有 `.everoffice/`（元数据）与 `.tmp/`（过程缓存）；
 * - 健康检查（目录在不在、标记在不在、哪些角色目录缺了）由网关 `/layout` 给；
 * - 「修复」是幂等的补缺，不删用户内容；
 * - `.tmp/` 是 Agent 的过程缓存，不进资料库索引，这里给一个**只读**清单入口。
 *
 * 未绑定目录（老数据 / 目录服务不可用）时显示空态，不阻塞概览其它内容。
 */

export interface SpaceDirectoryCardProps {
  workspace: AgentWorkspace
  onToast(message: string): void
}

type CardState = 'loading' | 'ready' | 'unbound'

export function SpaceDirectoryCard({ workspace, onToast }: SpaceDirectoryCardProps) {
  const [state, setState] = useState<CardState>(workspace.path ? 'loading' : 'unbound')
  const [layout, setLayout] = useState<AgentSpaceLayout | null>(null)
  const [cache, setCache] = useState<AgentSpaceCacheStats | null>(null)
  const [busy, setBusy] = useState(false)
  const [scratch, setScratch] = useState<AgentScratchListing | null>(null)
  const [scratchOpen, setScratchOpen] = useState(false)
  const [scratchBusy, setScratchBusy] = useState(false)

  const workspaceId = workspace.id
  const workspacePath = workspace.path

  const load = useCallback(async () => {
    if (!workspacePath) {
      setState('unbound')
      setLayout(null)
      return
    }
    try {
      const result = await workbenchApi.spaceLayout(workspaceId)
      setLayout(result)
      setState('ready')
      setCache(await workbenchApi.cacheStats(workspaceId).catch(() => null))
    } catch {
      setState('unbound')
    }
  }, [workspaceId, workspacePath])

  useEffect(() => {
    void load()
  }, [load])

  const reveal = async (): Promise<void> => {
    const ok = await workbenchApi.revealDirectory(layout?.paths.root ?? workspacePath ?? '')
    if (!ok) onToast('目录不存在或已被移动')
  }

  const repair = async (): Promise<void> => {
    setBusy(true)
    try {
      const report = await workbenchApi.repairSpace(workspaceId)
      onToast(report.createdDirectories.length > 0
        ? `已补回 ${report.createdDirectories.length} 个目录`
        : '目录已完好，无需修复')
      await load()
    } catch {
      onToast('修复失败：目录可能已被移动或不可写')
    } finally {
      setBusy(false)
    }
  }

  const reconcile = async (): Promise<void> => {
    setBusy(true)
    try {
      const report = await workbenchApi.reconcileLibrary(workspaceId)
      const parts = [
        report.added.length > 0 ? `新增 ${report.added.length}` : null,
        report.missing.length > 0 ? `丢失 ${report.missing.length}` : null,
        report.restored.length > 0 ? `恢复 ${report.restored.length}` : null,
      ].filter(Boolean)
      onToast(parts.length > 0 ? `已同步目录：${parts.join('，')}` : '目录与资料库一致')
      await load()
    } catch {
      onToast('同步失败：目录可能已被移动或不可写')
    } finally {
      setBusy(false)
    }
  }

  /** 目录被搬走/删掉后重新定位：选目录 → 把空间搬过去（或在原地重建）。 */
  const relocate = async (): Promise<void> => {
    const picked = await window.nxcore?.workspace?.pickDirectory().catch(() => null)
    if (!picked) return
    setBusy(true)
    try {
      await workbenchApi.relocateSpace(workspaceId, picked)
      onToast('已把空间目录搬到新位置')
      await load()
    } catch {
      onToast('重定位失败：目标目录可能已被占用')
    } finally {
      setBusy(false)
    }
  }

  const gc = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await workbenchApi.gcCache(workspaceId)
      const freed = formatBytes(result.freedBytes)
      onToast(result.freedBytes > 0 ? `已清理 ${freed} 缓存` : '没有可清理的缓存')
      await load()
    } catch {
      onToast('清理缓存失败')
    } finally {
      setBusy(false)
    }
  }

  /** 弹窗里的「清理全部」：走同一套缓存 GC，清完顺手刷新清单。 */
  const gcFromScratch = async (): Promise<void> => {
    setScratchBusy(true)
    try {
      const result = await workbenchApi.gcCache(workspaceId)
      onToast(result.removedTmp > 0 ? `已清理 ${result.removedTmp} 个临时文件` : '没有可清理的临时文件')
      setScratch(await workbenchApi.scratchFiles(workspaceId).catch(() => null))
      await load()
    } catch {
      onToast('清理临时文件失败')
    } finally {
      setScratchBusy(false)
    }
  }

  /** 在访达里打开 `.tmp/`（不存在就退回空间根）。 */
  const revealTemp = async (): Promise<void> => {
    const target = layout?.paths.tmp ?? joinPath(root, '.tmp')
    const ok = await workbenchApi.revealDirectory(target)
    if (!ok) onToast('临时目录不存在')
  }

  /** 打开「临时文件」：只读拉一遍 `.tmp` 清单（不入索引、不写库）。 */
  const openScratch = async (): Promise<void> => {
    setScratchOpen(true)
    setScratchBusy(true)
    try {
      setScratch(await workbenchApi.scratchFiles(workspaceId))
    } catch {
      onToast('读取临时文件失败')
      setScratch(null)
    } finally {
      setScratchBusy(false)
    }
  }

  const closeScratch = (open: boolean): void => {
    if (!open) {
      setScratchOpen(false)
      setScratch(null)
    }
  }

  if (state === 'unbound') {
    return (
      <section className="wb-ov-card wb-ov-dir" aria-labelledby="wb-ov-dir-heading">
        <header className="wb-ov-card-head">
          <h2 id="wb-ov-dir-heading">空间目录</h2>
        </header>
        <p className="wb-ov-note">这个空间还没有绑定目录，资料库暂时只存在应用内。</p>
      </section>
    )
  }

  const root = layout?.paths.root ?? workspacePath ?? ''
  const health = layout?.health
  const missing = health?.missingDirectories ?? []
  const broken = health ? (!health.exists || !health.markerPresent || missing.length > 0) : false

  return (
    <section className="wb-ov-card wb-ov-dir" aria-labelledby="wb-ov-dir-heading">
      <header className="wb-ov-card-head">
        <h2 id="wb-ov-dir-heading">
          空间目录
          {layout?.rootMode === 'external' ? <span className="wb-ov-dir-mode">自选目录</span> : null}
        </h2>
        <div className="wb-ov-dir-actions">
          <Button variant="ghost" size="sm" icon={<FolderOpen size={13} />} onClick={() => { void reveal() }}>
            在访达中显示
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={busy ? <Spinner size={13} /> : <Wand2 size={13} />}
            disabled={busy}
            onClick={() => { void reconcile() }}
          >
            同步目录
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={busy ? <Spinner size={13} /> : <RefreshCw size={13} />}
            disabled={busy}
            onClick={() => { void repair() }}
          >
            修复
          </Button>
        </div>
      </header>
      {state === 'loading' ? (
        <p className="wb-ov-insight-state"><Spinner size={13} /></p>
      ) : (
        <>
          <p className="wb-ov-dir-path" title={root}>{root}</p>
          {broken ? (
            <p className="wb-ov-dir-warn">
              <TriangleAlert size={13} aria-hidden="true" />
              <span>
                {!health?.exists
                  ? '目录不在原位（可能被移动或删除）'
                  : !health?.markerPresent
                    ? '目录缺少 .everoffice/space.json，已不是可识别的项目空间'
                    : `缺少 ${missing.length} 个目录：${missing.join('、')}`}
              </span>
              {!health?.exists || !health?.markerPresent ? (
                <span className="wb-ov-dir-warn-actions">
                  <button type="button" disabled={busy} onClick={() => { void relocate() }}>重新定位</button>
                  <button type="button" disabled={busy} onClick={() => { void repair() }}>在原位重建</button>
                </span>
              ) : null}
            </p>
          ) : (
            <p className="wb-ov-dir-hint">
              根即资料库；.everoffice/ 收标记与记忆，.tmp/ 收过程缓存
            </p>
          )}
          {cache?.bound ? (
            <p className="wb-ov-dir-cache">
              <span>缓存 {formatBytes(cache.totalBytes)}</span>
              <span className="wb-ov-dir-cache-parts">
                tmp {formatBytes(cache.tmpBytes)} · 派生 {formatBytes(cache.derivedBytes)} · 对象 {formatBytes(cache.objectsBytes)}
              </span>
              <button
                type="button"
                className="wb-ov-dir-cache-action"
                disabled={busy}
                onClick={() => { void openScratch() }}
              >
                临时文件{cache.tmpFiles > 0 ? ` ${cache.tmpFiles}` : ''}
              </button>
              <button
                type="button"
                className="wb-ov-dir-cache-action"
                disabled={busy}
                onClick={() => { void gc() }}
              >
                清理缓存
              </button>
            </p>
          ) : null}
        </>
      )}
      <Modal
        open={scratchOpen}
        onOpenChange={closeScratch}
        title="临时文件"
        description="Agent 工作时产生的过程缓存（.tmp/），不进资料库；随时可以清理。"
        size="md"
        footer={(
          <>
            <Button
              variant="ghost"
              icon={<FolderOpen size={13} />}
              onClick={() => { void revealTemp() }}
            >
              在访达中显示
            </Button>
            <span className="wb-scratch-foot-gap" />
            <Button variant="ghost" onClick={() => closeScratch(false)}>关闭</Button>
            <Button
              variant="secondary"
              icon={scratchBusy ? <Spinner size={13} /> : <Trash2 size={13} />}
              disabled={scratchBusy || !scratch || scratch.fileCount === 0}
              onClick={() => { void gcFromScratch() }}
            >
              清理全部
            </Button>
          </>
        )}
      >
        {scratchBusy && !scratch ? (
          <p className="wb-ov-insight-state"><Spinner size={13} /></p>
        ) : !scratch || !scratch.present || scratch.entries.length === 0 ? (
          <p className="wb-scratch-empty">还没有临时文件。Agent 做转换、截图、转写时会在这里放中间产物。</p>
        ) : (
          <>
            <p className="wb-scratch-summary">
              {scratch.fileCount}{scratch.truncated ? '+' : ''} 个文件 · {formatBytes(scratch.totalBytes)}
              {scratch.truncated ? '（只展示最近 500 个）' : ''}
            </p>
            <ul className="wb-scratch-list">
              {scratch.entries.map((entry) => (
                <li key={entry.path} className="wb-scratch-item">
                  <span className="wb-scratch-path" title={entry.path}>{entry.path}</span>
                  <span className="wb-scratch-size">{formatBytes(entry.size)}</span>
                  <span className="wb-scratch-time">{formatTime(entry.modifiedAt)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Modal>
    </section>
  )
}

/** 拼路径（只用于展示层兜底，避免依赖 node:path）。 */
function joinPath(root: string, name: string): string {
  return root.endsWith('/') || root.endsWith('\\') ? `${root}${name}` : `${root}/${name}`
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 日期。 */
function formatTime(iso: string): string {
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return ''
  const diff = Date.now() - time
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(time).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/** 人类可读的字节数（缓存行用）。 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return `${unit === 0 ? Math.round(value) : rounded} ${units[unit]}`
}
