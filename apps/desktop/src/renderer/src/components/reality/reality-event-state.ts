import type { RealityEvent } from '../../../../shared/sources'

function newerEvent(current: RealityEvent | undefined, incoming: RealityEvent): RealityEvent {
  return current && current.version >= incoming.version ? current : incoming
}

export function mergeRealityEvent(current: RealityEvent[], incoming: RealityEvent): RealityEvent[] {
  const existing = current.find((event) => event.id === incoming.id)
  if (existing && existing.version >= incoming.version) return current
  return [incoming, ...current.filter((event) => event.id !== incoming.id)]
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
}

export function mergeRealitySnapshot(current: RealityEvent[], snapshot: RealityEvent[]): RealityEvent[] {
  const currentById = new Map(current.map((event) => [event.id, event]))
  return snapshot
    .map((incoming) => newerEvent(currentById.get(incoming.id), incoming))
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
}
