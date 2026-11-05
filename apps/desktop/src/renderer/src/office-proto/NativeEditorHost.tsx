import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'

import type { FileCatalogDto } from '@/shared/ingest'

/**
 * GenOffice 原生编辑器宿主。原生 WebContentsView 永远画在 DOM 之上，z-index
 * 管不了它，只能靠「矩形上报 + 显隐时序」对齐（时序规则取自 EverOffice 的
 * officeViewport.ts，原型去掉遮挡扫描）：
 * 1. 挂载后先 open 实例；宿主矩形非零时先 activate 再报矩形
 * 2. 宿主矩形归零（切标签/收面板）上报零尺寸隐藏
 * 3. ResizeObserver + 窗口 resize + 捕获阶段 scroll 全部重报
 *
 * 两种数据源：
 * - 原型 mock 文件（无 realCatalog）：走 window.desktop 原型桥（office:open /
 *   office:activate / office:bounds），内容由 mock spec 落成沙箱 fixture；
 * - 真实文件库文件（带 realCatalog）：走 window.nxcore 文件库预览
 *   （files.openOriginal → office.setActiveInstance / office.setWorkspaceBounds），
 *   可编辑且保存回填版本链。迁移后 UI 里点了真实文件没有任何反应，就是这里缺
 *   了「打开后激活 + 上报矩形」这一步。
 */

export type NativeSpec =
  | { kind: 'docx'; blocks: Array<{ type: 'h1' | 'h2' | 'p' | 'quote'; text: string; cite?: { label: string; source: string } }> }
  | { kind: 'xlsx'; columns: string[]; rows: string[][] }
  | { kind: 'pptx'; slides: Array<{ title: string; bullets: string[] }> }
  | { kind: 'pdf'; paragraphs: string[] }

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

const ZERO: Bounds = { x: 0, y: 0, width: 0, height: 0 }

/** 文件库内置预览可编辑的扩展名（PDF 标注随选区工具卡一并开放编辑；
 * markdown 评论/编辑随 genoffice markdown runtime 开放；
 * 旧格式转换失败会回退系统应用）。 */
function isEditableName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  const extension = dot >= 0 ? name.slice(dot).toLowerCase() : ''
  return ['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsm', '.xlsx', '.pdf', '.md', '.markdown'].includes(extension)
}

export function NativeEditorHost({
  fileId, title, spec, realCatalog,
}: {
  fileId: string
  title: string
  spec?: NativeSpec
  realCatalog?: FileCatalogDto
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'opening' | 'ready' | 'error'>('opening')
  const [error, setError] = useState<string | null>(null)
  // 真实文件库预览的实例 id（= fileId）；mock 走原型桥，不需要。
  const instanceRef = useRef<string | null>(null)
  const real = realCatalog !== undefined

  const open = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (realCatalog) {
      const files = window.nxcore?.files
      if (!files?.openOriginal) return { ok: false, error: '文件服务尚未就绪，请稍后重试。' }
      const editable = isEditableName(realCatalog.originalName)
      const result = await files.openOriginal(
        realCatalog.id,
        realCatalog.originalName,
        realCatalog.contentHash,
        editable ? { editable: true } : undefined,
      )
      if (result.openedWith !== 'office') {
        return {
          ok: false,
          error: result.legacyFallback
            ? '旧版 Office 格式转换失败，已交给系统默认应用打开。'
            : '该格式不支持内置预览，已交给系统默认应用打开。',
        }
      }
      instanceRef.current = result.instanceId
      return { ok: true }
    }
    if (!window.desktop?.office || !spec) return { ok: false, error: '原型 Office 桥不可用。' }
    const result = await window.desktop.office.open({ fileId, title, spec })
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? '未知错误' }
  }, [fileId, realCatalog, spec, title])

  const activate = useCallback(async () => {
    if (real) {
      const instanceId = instanceRef.current
      if (instanceId) await window.nxcore?.office?.setActiveInstance(instanceId)
      return
    }
    await window.desktop?.office.activate(fileId)
  }, [fileId, real])

  const sendBounds = useCallback((bounds: Bounds) => {
    if (real) window.nxcore?.office?.setWorkspaceBounds(bounds)
    else window.desktop?.office.sendBounds(bounds)
  }, [real])

  useEffect(() => {
    let cancelled = false
    setStatus('opening')
    setError(null)
    void open()
      .then((result) => {
        if (cancelled) return
        if (result.ok) setStatus('ready')
        else {
          setStatus('error')
          setError(result.error ?? '未知错误')
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setStatus('error')
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // 实例就绪后才上报矩形：open 之前发出的 setWorkspaceBounds 没有监听者。
  useEffect(() => {
    if (status !== 'ready') return
    const host = hostRef.current
    if (!host) return
    let visible = false
    let raf = 0
    let lastKey = ''

    /// WebContentsView 盖在 DOM 之上、完全不吃 CSS：祖先用 visibility:hidden 收起
    /// 原生区时（气泡窗收起/关闭/拖宽期间，见 bubble.css）布局不变、矩形也不变，
    /// 只有显式上报 ZERO 才能让原生视图让位，否则它会继续画在下面的对话区上。
    const hostPaintable = (): boolean => {
      const rect = host.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      for (let node: HTMLElement | null = host; node; node = node.parentElement) {
        const style = window.getComputedStyle(node)
        if (style.visibility === 'hidden' || style.display === 'none') return false
      }
      return true
    }

    /// 模态浮层（新建空间对话框、命令面板…）也是 DOM：原生视图会把它们整块盖住。
    /// Radix 只在打开时挂载并打 data-state=open，所以"有可见浮层"就等于"原生区被挡"。
    const OVERLAY_SELECTOR =
      '.ui-modal-overlay[data-state="open"], .wb-palette-overlay[data-state="open"], [role="dialog"][data-state="open"], [aria-modal="true"]'
    const overlayCoversHost = (): boolean => {
      for (const node of document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)) {
        if (node.closest('.op-native-wrap')) continue
        const rect = node.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
        if (window.getComputedStyle(node).visibility === 'hidden') continue
        return true
      }
      return false
    }

    const paintable = (): boolean => hostPaintable() && !overlayCoversHost()

    /// 原生视图同样不吃祖先的 overflow/contain 裁剪：flex 溢出、窗口变窄、面板动画中
    /// 它都会画到兄弟元素上去（就是"右侧 Excel 悬浮窗盖住中间对话区"）。这里把上报
    /// 矩形夹到宿主的裁剪祖先与视口的交集内，夹空即视为不可见。
    const clippedRect = (rect: DOMRect): { x: number; y: number; width: number; height: number } | null => {
      let left = rect.left
      let top = rect.top
      let right = rect.right
      let bottom = rect.bottom
      for (let node: HTMLElement | null = host.parentElement; node; node = node.parentElement) {
        const style = window.getComputedStyle(node)
        const clips =
          style.overflowX !== 'visible' ||
          style.overflowY !== 'visible' ||
          style.contain.includes('paint')
        if (!clips) continue
        const box = node.getBoundingClientRect()
        left = Math.max(left, box.left)
        top = Math.max(top, box.top)
        right = Math.min(right, box.right)
        bottom = Math.min(bottom, box.bottom)
      }
      left = Math.max(left, 0)
      top = Math.max(top, 0)
      right = Math.min(right, window.innerWidth)
      bottom = Math.min(bottom, window.innerHeight)
      if (right - left < 1 || bottom - top < 1) return null
      return { x: left, y: top, width: right - left, height: bottom - top }
    }

    const report = async () => {
      if (!paintable()) {
        if (visible) {
          visible = false
          lastKey = ''
          sendBounds(ZERO)
        }
        return
      }
      const rect = clippedRect(host.getBoundingClientRect())
      if (rect === null) {
        if (visible) {
          visible = false
          lastKey = ''
          sendBounds(ZERO)
        }
        return
      }
      // 类名批量变动（拖拽、标签切换、悬停）会触发大量 mutation：矩形没变就不重复发 IPC。
      const key = `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`
      if (key === lastKey) return
      lastKey = key
      if (!visible) {
        visible = true
        await activate()
      }
      sendBounds(rect)
    }

    // visibility / 浮层进出都不触发 ResizeObserver（原生区尺寸没动），靠 DOM mutation
    // 兜住；按帧合并 + 100ms 节流，避免聊天流式输出时每帧都查一遍浮层。
    let scheduled = false
    let lastRun = 0
    let trailing: ReturnType<typeof setTimeout> | null = null
    const runReport = () => {
      lastRun = Date.now()
      void report()
    }
    const schedule = () => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        const wait = 100 - (Date.now() - lastRun)
        if (wait <= 0) {
          runReport()
          return
        }
        // 节流窗内的最后一次变更不能丢：浮层"秒开秒关"时必须补一次上报，
        // 否则原生视图会停在隐藏态。
        if (trailing !== null) return
        trailing = setTimeout(() => {
          trailing = null
          runReport()
        }, wait)
      })
    }

    const observer = new ResizeObserver(() => void report())
    const mutations = new MutationObserver(schedule)
    const onResize = () => void report()
    const onScroll = () => void report()
    observer.observe(host)
    mutations.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['class', 'style', 'data-state', 'aria-hidden', 'hidden'],
    })
    const onSettle = () => schedule()
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('transitionend', onSettle, true)
    window.addEventListener('animationend', onSettle, true)
    raf = requestAnimationFrame(() => requestAnimationFrame(() => void report()))

    return () => {
      observer.disconnect()
      mutations.disconnect()
      if (trailing !== null) clearTimeout(trailing)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('transitionend', onSettle, true)
      window.removeEventListener('animationend', onSettle, true)
      cancelAnimationFrame(raf)
      if (visible) sendBounds(ZERO)
    }
  }, [activate, sendBounds, status])

  return (
    <div className="op-native-wrap">
      <div className="op-native-host" ref={hostRef}>
        {status === 'opening' && (
          <div className="op-native-status">
            <Loader2 size={16} className="op-spin-icon" /> {real ? '正在打开文件…' : '正在启动 GenOffice 原生编辑器…'}
          </div>
        )}
        {status === 'error' && (
          <div className="op-native-status error">
            <AlertTriangle size={16} /> {real ? '文件打开失败' : 'GenOffice 运行时不可用'}
            <div className="op-native-error-detail">{error}</div>
            <div className="op-native-error-hint">
              {real
                ? '请确认文件已成功导入且本地文件完整；可在「所有文件」重新导入后再试。'
                : '请确认 EverOffice 仓库已执行 prepare:genoffice，或设置 GENOFFICE_RUNTIME_ROOT 指向 genoffice-runtime 目录。'}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
