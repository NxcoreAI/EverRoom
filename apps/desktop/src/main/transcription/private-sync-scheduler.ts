import type { PrivateTranscriptionSyncResult } from '../../shared/sources'
import type { PrivateTranscriptionSyncService } from './private-transcription-sync'

const DEFAULT_INTERVAL_MS = 15_000

/** Keeps private multi-device transcription sync alive independently of the active renderer page. */
export class PrivateSyncScheduler {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<PrivateTranscriptionSyncResult> | null = null
  private authenticated = false

  constructor(
    private readonly sync: PrivateTranscriptionSyncService,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
    private readonly onCompleted?: (result: PrivateTranscriptionSyncResult) => void,
  ) {}

  setAuthenticated(authenticated: boolean): void {
    this.authenticated = authenticated
    if (authenticated) {
      this.start()
      void this.run()
    } else {
      this.stop()
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.authenticated = false
  }

  private start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.run(), this.intervalMs)
  }

  private async run(): Promise<void> {
    if (!this.authenticated || this.running) return
    this.running = this.sync.sync()
    try {
      const result = await this.running
      this.onCompleted?.(result)
    } catch {
      // Authentication and transient network errors are retried on the next tick.
    } finally {
      this.running = null
    }
  }
}
