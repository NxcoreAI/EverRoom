import type { WebContents } from 'electron'

/** Registers at most one destruction callback per WebContents for one bridge. */
export class WebContentsLifecycle {
  private readonly observed = new WeakSet<WebContents>()

  observe(contents: WebContents, onDestroyed: () => void): void {
    if (this.observed.has(contents)) return
    this.observed.add(contents)
    contents.once('destroyed', onDestroyed)
  }
}
