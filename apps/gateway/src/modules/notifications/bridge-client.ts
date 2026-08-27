import type { GatewayConfig } from "../../config.js";

export interface AgentNotificationRequest {
  title: string;
  body: string;
  platforms: Array<"ios"|"macos">;
  sessionId: string;
  runId: string;
  roomId: string|null;
  idempotencyKey: string;
}

export class NotificationBridgeClient {
  constructor(private readonly config:NonNullable<GatewayConfig["notificationBridge"]>){}

  async send(input:AgentNotificationRequest):Promise<Record<string,unknown>>{
    const response=await fetch(`${this.config.baseUrl}/v1/agent-notifications`,{
      method:"POST",
      headers:{Authorization:`Bearer ${this.config.token}`,"Content-Type":"application/json",Accept:"application/json"},
      body:JSON.stringify(input),
      signal:AbortSignal.timeout(15_000),
    });
    const body=await response.json().catch(()=>({})) as {message?:unknown;data?:Record<string,unknown>};
    if(!response.ok)throw new Error(typeof body.message==="string"?body.message:`Notification bridge failed (${response.status})`);
    return body.data??body;
  }
}
