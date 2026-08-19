import type { DocumentEvent, DocumentEventFrame } from "@nxcore/agent-contract";

export interface DocumentEventSocket {
  readyState: number;
  send(data: string): void;
}

export class DocumentEventBroker {
  private readonly subscribers = new Map<string, Set<DocumentEventSocket>>();
  private readonly listeners = new Set<(event: DocumentEvent) => void>();

  subscribe(roomId: string, socket: DocumentEventSocket): () => void {
    const sockets = this.subscribers.get(roomId) ?? new Set<DocumentEventSocket>();
    sockets.add(socket);
    this.subscribers.set(roomId, sockets);
    return () => {
      sockets.delete(socket);
      if (sockets.size === 0) this.subscribers.delete(roomId);
    };
  }

  /** 服务端事件监听（knowledge 路由层等模块消费，与 WS 订阅互不影响）。 */
  listen(listener: (event: DocumentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: DocumentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 单个监听者异常不阻断 WS 广播与其余监听者。
      }
    }
    const frame: DocumentEventFrame = { type: "document.event", protocol: 1, event };
    const payload = JSON.stringify(frame);
    for (const socket of this.subscribers.get(event.roomId) ?? []) {
      if (socket.readyState === 1) socket.send(payload);
    }
  }
}
