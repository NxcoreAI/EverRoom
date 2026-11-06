/**
 * 执行带：把整条 run 压成一条带子——灰=等待，蓝=生成，青=工具。
 * 拖动/播放即回放，所有面板按同一光标弱化「尚未发生」的部分。
 * 只保留一条主带（上下文曲线、异常刻度都在各自面板里），避免首屏再次变花。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { formatOffset } from '../insight/format'
import { unionSpans } from '../insight/timeMath'
import type { TraceInsight } from '../insight/types'
import { pctOf, widthOf, TimeRuler } from './TimeScale'

import './replay-strip.css'

const SPEEDS = [1, 4, 16] as const

interface ReplayStripProps {
  insight: TraceInsight
  cursorMs: number | null
  onCursor: (cursorMs: number | null) => void
}

export function ReplayStrip({ insight, cursorMs, onCursor }: ReplayStripProps) {
  const { wallMs, rounds, tools } = insight
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(4)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const lastTickRef = useRef(0)
  const cursorRef = useRef<number | null>(cursorMs)
  cursorRef.current = cursorMs

  const toolBars = useMemo(
    () => unionSpans(tools.map((tool) => ({ startMs: tool.startMs, endMs: tool.endMs }))),
    [tools],
  )
  const genBars = useMemo(
    () => unionSpans(rounds.flatMap((round) => round.segments.map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs })))),
    [rounds],
  )

  const seekFromClientX = useCallback((clientX: number) => {
    const track = trackRef.current
    if (!track || wallMs <= 0) return
    const rect = track.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    onCursor(Math.round(ratio * wallMs))
  }, [onCursor, wallMs])

  useEffect(() => {
    if (!playing || wallMs <= 0) return
    lastTickRef.current = performance.now()
    const tick = (now: number): void => {
      const delta = now - lastTickRef.current
      lastTickRef.current = now
      const next = Math.min(wallMs, (cursorRef.current ?? 0) + delta * speed)
      onCursor(next)
      if (next >= wallMs) setPlaying(false)
      else frameRef.current = requestAnimationFrame(tick)
    }
    frameRef.current = requestAnimationFrame(tick)
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [playing, speed, wallMs, onCursor])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (wallMs <= 0) return
    const step = Math.max(100, Math.round(wallMs / 100))
    if (event.key === 'ArrowRight') { event.preventDefault(); onCursor(Math.min(wallMs, (cursorMs ?? 0) + step)) }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); onCursor(Math.max(0, (cursorMs ?? 0) - step)) }
    else if (event.key === 'Home') { event.preventDefault(); onCursor(0) }
    else if (event.key === 'End') { event.preventDefault(); onCursor(wallMs) }
    else if (event.key === 'Escape') { event.preventDefault(); setPlaying(false); onCursor(null) }
  }, [cursorMs, onCursor, wallMs])

  const togglePlay = useCallback(() => {
    setPlaying((current) => {
      const next = !current
      if (next && (cursorMs === null || cursorMs >= wallMs)) onCursor(0)
      return next
    })
  }, [cursorMs, onCursor, wallMs])

  return (
    <section className="strip" aria-label="执行带">
      <div className="strip-head">
        <span className="strip-title">执行带</span>
        <span className="strip-sub">灰=等待模型 · 蓝=生成 · 青=工具</span>
        <div className="strip-controls">
          <button
            type="button"
            className="strip-play"
            onClick={togglePlay}
            aria-label={playing ? '暂停回放' : '开始回放'}
          >
            {playing ? '暂停' : '回放'}
          </button>
          <div className="strip-speeds" role="group" aria-label="回放倍速">
            {SPEEDS.map((option) => (
              <button
                key={option}
                type="button"
                className={option === speed ? 'strip-speed is-on' : 'strip-speed'}
                onClick={() => setSpeed(option)}
              >
                ×{option}
              </button>
            ))}
          </div>
          {cursorMs !== null && (
            <button type="button" className="strip-reset" onClick={() => { setPlaying(false); onCursor(null) }}>
              退出回放
            </button>
          )}
        </div>
        <div className="strip-clock num">
          {formatOffset(cursorMs ?? wallMs)}
          <span className="strip-clock-total">/ {formatOffset(wallMs)}</span>
        </div>
      </div>

      <div
        className="strip-track"
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="回放光标"
        aria-valuemin={0}
        aria-valuemax={Math.round(wallMs)}
        aria-valuenow={Math.round(cursorMs ?? wallMs)}
        aria-valuetext={formatOffset(cursorMs ?? wallMs)}
        onKeyDown={handleKeyDown}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          setPlaying(false)
          event.currentTarget.setPointerCapture(event.pointerId)
          seekFromClientX(event.clientX)
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
          seekFromClientX(event.clientX)
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
      >
        <TimeRuler wallMs={wallMs} compact />
        <div className="strip-lane">
          <span className="strip-wait" />
          {genBars.map((bar, index) => (
            <span
              key={`gen-${index}`}
              className="strip-piece strip-gen"
              style={{ left: `${pctOf(bar.startMs, wallMs)}%`, width: `${widthOf(bar.startMs, bar.endMs, wallMs)}%` }}
            />
          ))}
          {toolBars.map((bar, index) => (
            <span
              key={`tool-${index}`}
              className="strip-piece strip-tool"
              style={{ left: `${pctOf(bar.startMs, wallMs)}%`, width: `${widthOf(bar.startMs, bar.endMs, wallMs)}%` }}
            />
          ))}
          {cursorMs !== null && (
            <span className="strip-future" style={{ left: `${pctOf(cursorMs, wallMs)}%` }} />
          )}
        </div>
        {cursorMs !== null && <div className="strip-cursor" style={{ left: `${pctOf(cursorMs, wallMs)}%` }} aria-hidden="true" />}
      </div>
    </section>
  )
}
