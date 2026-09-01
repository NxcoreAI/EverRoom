import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema,ListToolsRequestSchema,type JSONRPCMessage,type RequestId } from "@modelcontextprotocol/sdk/types.js";
import type { DocumentExecutionContext } from "../documents/capabilities/types.js";
import { resolveTrustedMcpSession,revokeTrustedMcpSession } from "../agent/mcp-session-authority.js";
import type { NotificationBridgeClient } from "./bridge-client.js";

export const SEND_NOTIFICATION_TOOL={
  name:"send_notification",
  title:"发送系统通知",
  description:"自主决定是否向用户的 iOS、macOS 或两端发送一条 EverRoom 系统通知。标题和摘要会显示在锁屏或系统通知中心；详细内容在用户点击后从对应 Agent 会话加载。",
  inputSchema:{type:"object",properties:{
    title:{type:"string",minLength:1,maxLength:80,description:"简短、可独立理解的通知标题。"},
    body:{type:"string",minLength:1,maxLength:120,description:"不包含正文、密钥或敏感原文的短摘要。"},
    platforms:{type:"array",items:{type:"string",enum:["ios","macos"]},minItems:1,maxItems:2,uniqueItems:true,description:"投递平台，可选 ios、macos 或两者。"},
  },required:["title","body","platforms"],additionalProperties:false},
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true},
} as const;

function requestId(message:JSONRPCMessage):RequestId|undefined{return "id" in message?message.id:undefined;}
function requestKey(id:RequestId){return`${typeof id}:${String(id)}`;}
class ExchangeTransport implements Transport{
  onclose?:()=>void;onerror?:(error:Error)=>void;onmessage?:<T extends JSONRPCMessage>(message:T)=>void;
  private started=false;private readonly pending=new Map<string,(messages:JSONRPCMessage[])=>void>();
  async start(){this.started=true;}
  async send(message:JSONRPCMessage,_options?:TransportSendOptions){const id=requestId(message);if(id===undefined)return;const resolve=this.pending.get(requestKey(id));if(!resolve)return;this.pending.delete(requestKey(id));resolve([message]);}
  async close(){this.pending.clear();this.onclose?.();}
  exchange(message:JSONRPCMessage):Promise<JSONRPCMessage[]>{if(!this.started||!this.onmessage)throw new Error("MCP transport is not ready");const id=requestId(message);if(id===undefined){this.onmessage(message);return Promise.resolve([]);}return new Promise(resolve=>{this.pending.set(requestKey(id),resolve);this.onmessage?.(message);});}
}
interface HostSession{server:Server;transport:ExchangeTransport;context:DocumentExecutionContext}

export class NotificationMcpHost{
  private readonly sessions=new Map<string,Promise<HostSession>>();
  constructor(private readonly bridge:NotificationBridgeClient|null){}
  listTools(){return this.bridge?[SEND_NOTIFICATION_TOOL]:[];}
  async callTool(name:string,args:Record<string,unknown>,context:DocumentExecutionContext){
    if(name!==SEND_NOTIFICATION_TOOL.name||!this.bridge)throw new Error("Notification tool is unavailable");
    const title=typeof args.title==="string"?args.title.trim():"";const body=typeof args.body==="string"?args.body.trim():"";
    const platforms=Array.isArray(args.platforms)?[...new Set(args.platforms.filter((value):value is "ios"|"macos"=>value==="ios"||value==="macos"))]:[];
    if(!title||title.length>80||!body||body.length>120||platforms.length<1)throw new Error("INVALID_REQUEST: title, body and platforms are required");
    const idempotencyKey=`agent-notification:${createHash("sha256").update(JSON.stringify([context.agentSessionId,context.runId,title,body,[...platforms].sort()])).digest("hex")}`;
    // 来源桌面端不接收自己的远程推送（SaaS 扇出时排除来源设备）；当请求包含
    // macos 时，由本机直接弹出内容相同的通知，点击可定位到对应会话。
    const local=platforms.includes("macos");
    const result=await this.bridge.send({title,body,platforms,sessionId:context.agentSessionId,runId:context.runId,roomId:context.roomId,idempotencyKey,local});
    return{content:[{type:"text" as const,text:JSON.stringify(result)}],structuredContent:result};
  }
  async exchangeTrusted(sessionId:string,message:Record<string,unknown>){const context=resolveTrustedMcpSession(sessionId);if(!context)throw new Error("MCP_SESSION_INVALID: Trusted MCP session is missing or expired");return this.exchange(sessionId,message,context);}
  async exchange(sessionId:string,message:Record<string,unknown>,context:DocumentExecutionContext):Promise<Record<string,unknown>[]>{
    if(message.jsonrpc!=="2.0")throw new Error("Invalid MCP JSON-RPC message");let session=this.sessions.get(sessionId);
    if(message.method==="initialize"){if(session)await(await session).server.close().catch(()=>undefined);session=this.createSession(context);this.sessions.set(sessionId,session);}else if(!session)throw new Error("MCP session must start with initialize");
    const current=await session;if(JSON.stringify(current.context)!==JSON.stringify(context))throw new Error("MCP session context mismatch");
    return await current.transport.exchange(message as JSONRPCMessage) as Record<string,unknown>[];
  }
  async closeTrustedSession(sessionId:string){revokeTrustedMcpSession(sessionId);const session=this.sessions.get(sessionId);this.sessions.delete(sessionId);if(session)await(await session).server.close().catch(()=>undefined);}
  async close(){const sessions=await Promise.allSettled(this.sessions.values());this.sessions.clear();await Promise.all(sessions.flatMap(result=>result.status==="fulfilled"?[result.value.server.close().catch(()=>undefined)]:[]));}
  private async createSession(context:DocumentExecutionContext):Promise<HostSession>{
    const transport=new ExchangeTransport();const holder={server:null as unknown as Server,transport,context:structuredClone(context)};
    const server=new Server({name:"everroom-notifications",version:"1.0.0"},{capabilities:{tools:{}},instructions:SEND_NOTIFICATION_TOOL.description});holder.server=server;
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:this.listTools()}));
    server.setRequestHandler(CallToolRequestSchema,async request=>{try{return await this.callTool(request.params.name,(request.params.arguments??{}) as Record<string,unknown>,holder.context);}catch(error){return{content:[{type:"text" as const,text:JSON.stringify({error:error instanceof Error?error.message:String(error)})}],isError:true};}});
    await server.connect(transport);return holder;
  }
}
