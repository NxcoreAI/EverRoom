import { useCallback, useEffect, useRef, useState } from 'react'

import type { JournalEntryDto, JournalTodayDto, NxcoreDesktopApi } from '@/shared/sources'

export type DailyJournalState = 'loading' | 'ready' | 'empty' | 'unavailable' | 'failed'

export interface DailyJournalSnapshot {
  state: DailyJournalState
  /** 当天日期（YYYY-MM-DD，网关按本机时区给）；还没读到过就是 null。 */
  date: string | null
  /** 当天条目；null = 网关当天还没有可用条目（没信号 / 正在生成 / 生成失败）。 */
  entry: JournalEntryDto | null
  /** 当天进汇总的记忆条数，卡片副标题「基于 N 条记忆」。 */
  signalCount: number
  /** status=failed 时网关给的原因（一句话，可直接展示）。 */
  lastError: string | null
  /** 手动重写失败时的一行弱化提示（旧数据保留）；下次成功自动清掉。 */
  refreshError: string | null
  /** 最近一次成功读到数据的时间戳（ms），卡片「更新于 HH:MM」。 */
  fetchedAt: number | null
}

export interface DailyJournal extends DailyJournalSnapshot {
  /** 手动重写期间为 true（按钮禁用 + 旋转）。 */
  refreshing: boolean
  /** 手动重写当天（`journal.refresh`）：失败保留旧数据，只置 `refreshError`。 */
  refresh(): void
  /** 不可用/失败时重试读取（`journal.today`）。 */
  reload(): void
}

/** 页面可见时的轮询间隔。网关侧另有最小间隔与单飞保护，这里只管节奏。 */
const POLL_INTERVAL_MS = 60_000

const INITIAL_SNAPSHOT: DailyJournalSnapshot = {
  state: 'loading',
  date: null,
  entry: null,
  signalCount: 0,
  lastError: null,
  refreshError: null,
  fetchedAt: null,
}

/** 无 preload 桥 / 调用抛错时的共同落点：卡片显示不可用 + 重试，不回退任何 mock 文案。 */
const UNAVAILABLE_SNAPSHOT: DailyJournalSnapshot = { ...INITIAL_SNAPSHOT, state: 'unavailable' }

function journalApi(): NxcoreDesktopApi['journal'] | undefined {
  return window.nxcore?.journal
}

/**
 * 网关 DTO → 渲染层快照。
 *
 * 没有 entry 时要分清三种情况，别把「正在整理」说成「今天没动静」：
 * - `failed`：网关给了失败原因 → 失败态（可重试）；
 * - `generating`，或 `signalCount > 0`（有料，但还在去抖/排队/上一版尚未落盘）→ 加载态；
 * - 否则才是真的「今天还没有动静」。
 */
function snapshotFrom(dto: JournalTodayDto): DailyJournalSnapshot {
  const state: DailyJournalState = dto.entry
    ? 'ready'
    : dto.status === 'failed'
      ? 'failed'
      : dto.status === 'generating' || dto.signalCount > 0
        ? 'loading'
        : 'empty'
  return {
    state,
    date: dto.date,
    entry: dto.entry,
    signalCount: dto.signalCount,
    lastError: dto.lastError,
    refreshError: null,
    fetchedAt: Date.now(),
  }
}

/**
 * 当天日记（每日洞察）快照（`window.nxcore.journal.today` → `JournalTodayDto`）。
 *
 * 同 `useFileLibrary` 的约定：
 * - 无 preload 桥或网关抛错：`state === 'unavailable'`，卡片显示不可用态，**不造 mock 数据**。
 * - 重试/首帧期间 `state === 'loading'`；已有数据时保留旧条目，避免卡片闪空。
 *
 * 刷新节奏（日记由网关异步生成，所以只能靠轮询）：
 * - 每 60s 一次，但只在 `document.visibilityState === 'visible'` 时真的去拉；
 * - `visibilitychange` 变可见、窗口 `focus` 时立即补拉一次；
 * - 卸载时清定时器与两个监听（`cancelled` 标志拦住迟到的响应）。
 */
export function useDailyJournal(): DailyJournal {
  const [snapshot, setSnapshot] = useState<DailyJournalSnapshot>(INITIAL_SNAPSHOT)
  const [refreshing, setRefreshing] = useState(false)
  // 「重试」靠 nonce 重跑主 effect（与 useFileLibrary.reload 同构）。
  const [nonce, setNonce] = useState(0)
  // 手动重写是 effect 之外的异步链，用挂载标志挡住卸载后的 setState。
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  useEffect(() => {
    let cancelled = false

    const pull = async (): Promise<void> => {
      const api = journalApi()
      if (!api?.today) {
        // 浏览器预览 / 单测：没有桥。不可用态即事实，不垫假数据。
        if (!cancelled) setSnapshot(UNAVAILABLE_SNAPSHOT)
        return
      }
      try {
        const dto = await api.today()
        if (cancelled) return
        setSnapshot(snapshotFrom(dto))
      } catch {
        if (cancelled) return
        setSnapshot(UNAVAILABLE_SNAPSHOT)
      }
    }

    // 首帧先读一次（读到 entry=null 就是 empty，不是错误）。
    void pull()

    const timer = window.setInterval(() => {
      // 后台窗口不白跑网关：只在页面可见时轮询。
      if (cancelled || document.visibilityState !== 'visible') return
      void pull()
    }, POLL_INTERVAL_MS)

    const handleVisibility = (): void => {
      if (document.visibilityState === 'visible') void pull()
    }
    const handleFocus = (): void => { void pull() }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', handleFocus)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('focus', handleFocus)
    }
  }, [nonce])

  const reload = useCallback(() => {
    setSnapshot((current) => current.state === 'ready' ? current : INITIAL_SNAPSHOT)
    setNonce((value) => value + 1)
  }, [])

  const refresh = useCallback(() => {
    const api = journalApi()
    if (!api?.refresh) {
      setSnapshot(UNAVAILABLE_SNAPSHOT)
      return
    }
    setSnapshot((current) => ({ ...current, refreshError: null }))
    setRefreshing(true)
    void api.refresh()
      .then((dto) => {
        if (aliveRef.current) setSnapshot(snapshotFrom(dto))
      })
      .catch(() => {
        // 重写失败不算数据没了：旧条目留着，只补一行弱化错误文案。
        if (aliveRef.current) {
          setSnapshot((current) => ({ ...current, refreshError: '重写没成功，稍后可以再试一次。' }))
        }
      })
      .finally(() => {
        if (aliveRef.current) setRefreshing(false)
      })
  }, [])

  return { ...snapshot, refreshing, refresh, reload }
}
