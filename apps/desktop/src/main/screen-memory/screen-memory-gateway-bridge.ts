import type { GatewaySupervisor } from '../gateway/gateway-supervisor'
import type { ScreenMemoryIntervalPersistence } from './screen-memory-controller'
import type { ClosedInterval } from './interval-tracker'

const FLUSH_INTERVAL_MS = 30_000

/**
 * 把关闭的观察区间投递到本地网关 screen-memory 模块。
 * 网关未就绪或请求失败时留在内存队列定时重试；进程退出前尽力冲刷。
 */
export class ScreenMemoryGatewayBridge implements ScreenMemoryIntervalPersistence {
  private queue: ClosedInterval[] = []
  private initialized = false
  private timer: ReturnType<typeof setInterval> | null = null
  private operation: Promise<void> = Promise.resolve()

  constructor(
    private readonly getSupervisor: () => GatewaySupervisor | null,
    private readonly onError?: (message: string) => void,
  ) {}

  async saveInterval(interval: ClosedInterval): Promise<void> {
    await this.initialize()
    this.queue.push(interval)
    void this.flush()
  }

  async setSummaryDispatch(allowed: boolean): Promise<void> {
    await this.initialize()
    const next = this.operation.then(async () => {
      const supervisor = this.getSupervisor()
      if (!supervisor) return
      let connection
      try {
        connection = await supervisor.ensureConnection()
      } catch {
        return
      }
      try {
        await fetch(`${connection.baseUrl}/v1/screen-memory/summary-control`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ dispatchAllowed: allowed }),
        })
      } catch (error) {
        this.onError?.(`screen-memory summary-control failed: ${String(error instanceof Error ? error.message : error)}`)
      }
    })
    this.operation = next.catch(() => undefined)
    await next
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.operation
    await this.flush()
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS)
    this.timer.unref?.()
  }

  private flush(): Promise<void> {
    const next = this.operation.then(async () => {
      const supervisor = this.getSupervisor()
      if (!supervisor || this.queue.length === 0) return
      let connection
      try {
        connection = await supervisor.ensureConnection()
      } catch {
        return
      }
      while (this.queue[0]) {
        const interval = this.queue[0]
        try {
          const response = await fetch(`${connection.baseUrl}/v1/screen-memory/intervals`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(toPayload(interval)),
          })
          if (!response.ok) throw new Error(`screen-memory save failed (${String(response.status)})`)
          this.queue.shift()
        } catch (error) {
          this.onError?.(`screen-memory save retry queued: ${String(error instanceof Error ? error.message : error)}`)
          return
        }
      }
    })
    this.operation = next.catch(() => undefined)
    return next
  }
}

function toPayload(interval: ClosedInterval): Record<string, unknown> {
  return {
    bundleId: interval.bundleId,
    appName: interval.appName,
    windowTitle: interval.windowTitle,
    title: interval.title,
    startedAt: interval.startedAt.toISOString(),
    endedAt: interval.endedAt.toISOString(),
    endReason: interval.endReason,
    textLines: interval.textLines,
    textBlocks: interval.textBlocks,
    keyframes: interval.keyframes.map((frame) => ({
      capturedAt: frame.capturedAt.toISOString(),
      imagePath: frame.imagePath,
      imageBytes: frame.imageBytes,
      perceptualHash: frame.perceptualHash,
      width: frame.width,
      height: frame.height,
      lineCount: frame.lineCount,
      elapsedMs: frame.elapsedMs,
    })),
  }
}
