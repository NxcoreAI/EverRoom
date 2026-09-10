export type RiderMode = 'riding' | 'swimming'

// One shared rAF loop drives every rider on the page.
export type Tick = (time: number) => void

const REDUCED_MOTION = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
const subscribers = new Set<Tick>()
let frameId = 0
let startAt = 0

function loop(timestamp: number) {
  frameId = 0
  const time = (timestamp - startAt) / 1000
  for (const tick of subscribers) tick(time)
  if (subscribers.size > 0) frameId = requestAnimationFrame(loop)
}

export function subscribeRider(tick: Tick): () => void {
  if (REDUCED_MOTION) return () => {}
  subscribers.add(tick)
  if (frameId === 0) {
    startAt = performance.now()
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
