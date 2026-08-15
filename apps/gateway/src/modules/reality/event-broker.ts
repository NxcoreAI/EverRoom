import {
  REALITY_PROTOCOL_VERSION,
  type RealityEvent,
  type RealityEventFrame,
} from "@nxcore/reality-contract";

interface EventSocket {
  readonly readyState: number;
  send(data: string): void;
}

export class RealityEventBroker {
  private readonly subscribers = new Set<EventSocket>();

  subscribe(socket: EventSocket): () => void {
    this.subscribers.add(socket);
    return () => this.subscribers.delete(socket);
  }

  publish(event: RealityEvent): void {
    const frame: RealityEventFrame = {
      type: "event.updated",
      protocol: REALITY_PROTOCOL_VERSION,
      change: { event, version: event.version },
    };
    const serialized = JSON.stringify(frame);
    for (const socket of this.subscribers) {
      if (socket.readyState === 1) socket.send(serialized);
    }
  }
}
