import type { AgentEvent, AgentEventFrame } from "@nxcore/agent-contract";
import { AGENT_PROTOCOL_VERSION } from "@nxcore/agent-contract";

interface EventSocket {
  readonly readyState: number;
  send(data: string): void;
}

export class AgentEventBroker {
  private readonly subscribers = new Map<string, Set<EventSocket>>();

  subscribe(sessionId: string, socket: EventSocket): () => void {
    const sockets = this.subscribers.get(sessionId) ?? new Set<EventSocket>();
    sockets.add(socket);
    this.subscribers.set(sessionId, sockets);
    return () => {
      sockets.delete(socket);
      if (sockets.size === 0) this.subscribers.delete(sessionId);
    };
  }

  publish(event: AgentEvent): void {
    const frame: AgentEventFrame = {
      type: "event",
      protocol: AGENT_PROTOCOL_VERSION,
      event,
    };
    const serialized = JSON.stringify(frame);
    for (const socket of this.subscribers.get(event.sessionId) ?? []) {
      if (socket.readyState === 1) socket.send(serialized);
    }
  }
}
