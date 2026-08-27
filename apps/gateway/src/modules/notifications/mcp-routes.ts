import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { NotificationMcpHost } from "./mcp-host.js";

const Params=Type.Object({sessionId:Type.String({minLength:1,maxLength:128})});
const Message=Type.Object({jsonrpc:Type.Literal("2.0")},{additionalProperties:true});
export function notificationMcpRoutes(host:NotificationMcpHost):FastifyPluginAsyncTypebox{return async app=>{
  app.post("/v1/mcp/notifications/:sessionId",{schema:{tags:["notifications","mcp"],params:Params,body:Message}},async(request,reply)=>{try{const messages=await host.exchangeTrusted(request.params.sessionId,request.body);if(!messages.length)return reply.code(202).send();return reply.type("application/json").send(messages.length===1?messages[0]:messages);}catch(error){if(error instanceof Error&&error.message.startsWith("MCP_SESSION_INVALID:"))return reply.code(404).send({jsonrpc:"2.0",error:{code:-32001,message:"Trusted MCP session is missing or expired"},id:"id" in request.body?request.body.id??null:null});throw error;}});
  app.delete("/v1/mcp/notifications/:sessionId",{schema:{tags:["notifications","mcp"],params:Params}},async(request,reply)=>{await host.closeTrustedSession(request.params.sessionId);return reply.code(204).send();});
};}
