import { WORKSPACE_DOCUMENT_CHANNEL, type DocumentEvent, type DocumentEventFrame } from "@nxcore/agent-contract";

export interface DocumentEventSocket {
  readyState: number;
  send(data: string): void;
}

export class DocumentEventBroker {
  /** 键为 Room id；工作区级事件统一落在 WORKSPACE_DOCUMENT_CHANNEL 频道。 */
  private readonly subscribers = new Map<string, Set<DocumentEventSocket>>();
  private readonly listeners = new Set<(event: DocumentEvent) => void>();

  subscribe(roomId: string | null, socket: DocumentEventSocket): () => void {
    const channel = roomId ?? WORKSPACE_DOCUMENT_CHANNEL;
    const sockets = this.subscribers.get(channel) ?? new Set<DocumentEventSocket>();
    sockets.add(socket);
    this.subscribers.set(channel, sockets);
    return () => {
      sockets.delete(socket);
      if (sockets.size === 0) this.subscribers.delete(channel);
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
    for (const socket of this.subscribers.get(event.roomId ?? WORKSPACE_DOCUMENT_CHANNEL) ?? []) {
      if (socket.readyState === 1) socket.send(payload);
    }
  }
}
