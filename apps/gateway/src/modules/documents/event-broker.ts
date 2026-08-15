import type { DocumentEvent, DocumentEventFrame } from "@nxcore/agent-contract";

export interface DocumentEventSocket {
  readyState: number;
  send(data: string): void;
}

export class DocumentEventBroker {
  private readonly subscribers = new Map<string, Set<DocumentEventSocket>>();

  subscribe(roomId: string, socket: DocumentEventSocket): () => void {
    const sockets = this.subscribers.get(roomId) ?? new Set<DocumentEventSocket>();
    sockets.add(socket);
    this.subscribers.set(roomId, sockets);
    return () => {
      sockets.delete(socket);
      if (sockets.size === 0) this.subscribers.delete(roomId);
    };
  }

  publish(event: DocumentEvent): void {
    const frame: DocumentEventFrame = { type: "document.event", protocol: 1, event };
    const payload = JSON.stringify(frame);
    for (const socket of this.subscribers.get(event.roomId) ?? []) {
      if (socket.readyState === 1) socket.send(payload);
    }
  }
}
