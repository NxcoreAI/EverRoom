export type RiderMode = 'riding' | 'swimming'

// One shared rAF loop drives every rider on the page.
export type Tick = (time: number) => void

const subscribers = new Set<Tick>()
let frameId = 0
// Set once and never reset: the time base stays monotonic even when the
// subscriber set empties and the loop restarts, so rider phase and position
// refs that survive across re-subscriptions never see time jump backwards.
let startAt = 0

function loop(timestamp: number) {
  frameId = 0
  const time = (timestamp - startAt) / 1000
  for (const tick of subscribers) tick(time)
  if (subscribers.size > 0) frameId = requestAnimationFrame(loop)
}

export function subscribeRider(tick: Tick): () => void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {}
  subscribers.add(tick)
  if (frameId === 0) {
    if (startAt === 0) startAt = performance.now()
    frameId = requestAnimationFrame(loop)
  }
  return () => {
    subscribers.delete(tick)
    if (subscribers.size === 0 && frameId !== 0) {
      cancelAnimationFrame(frameId)
      frameId = 0
    }
  }
}
