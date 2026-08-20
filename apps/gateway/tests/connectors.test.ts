import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createConnectorDatabase } from "../src/infrastructure/connectors/client.js";
import { ConnectorRepository } from "../src/modules/connectors/repository.js";
import { normalizeGmailMessage, gmailHistoryChanges } from "../src/modules/connectors/providers/gmail.js";
import { normalizeOutlookMessage } from "../src/modules/connectors/providers/outlook.js";
import { createServer } from "../src/server/create-server.js";
import { NangoExecutor, nangoProxyRequest } from "../src/modules/connectors/nango-executor.js";
import { NangoAuthorizationService, nangoAuthorizationErrorMessage } from "../src/modules/connectors/nango-authorization.js";
import { ConnectorManager } from "../src/modules/connectors/manager.js";
import { ConnectorDocumentStore } from "../src/modules/connectors/document-store.js";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/infrastructure/database/client.js";
const dirs:string[]=[];
afterEach(async()=>Promise.all(dirs.splice(0).map(x=>rm(x,{recursive:true,force:true}))));
async function setup(){const dir=await mkdtemp(join(tmpdir(),"connector-test-"));dirs.push(dir);const path=join(dir,"connectors.sqlite");const db=createConnectorDatabase(path);return {db,path,repo:new ConnectorRepository(db.sqlite)};}
describe("connector repository",()=>{
 it("upgrades a legacy sync_changes table without discarding its events",async()=>{const dir=await mkdtemp(join(tmpdir(),"connector-legacy-test-"));dirs.push(dir);const path=join(dir,"connectors.sqlite");const legacy=new Database(path);legacy.exec("CREATE TABLE sync_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, connection_id TEXT NOT NULL, message_id TEXT, kind TEXT NOT NULL, created_at TEXT NOT NULL)");legacy.prepare("INSERT INTO sync_changes(event_key,connection_id,message_id,kind,created_at) VALUES(?,?,?,?,?)").run("legacy-event","legacy-connection",null,"upsert",new Date(0).toISOString());legacy.close();const db=createConnectorDatabase(path);expect(db.sqlite.prepare("PRAGMA table_info(sync_changes)").all()).toEqual(expect.arrayContaining([expect.objectContaining({name:"scope_id",notnull:1})]));expect(db.sqlite.prepare("SELECT event_key as eventKey,scope_id as scopeId FROM sync_changes").get()).toEqual({eventKey:"legacy-event",scopeId:""});db.close();});
 it("uses an isolated schema and deduplicates replay across runs",async()=>{const {db,repo}=await setup();const c=repo.registerConnection({provider:"gmail",nangoConfigKey:"g",nangoConnectionId:"c"});const s=repo.ensureScope(c.id,"me","Mailbox");const fence=repo.acquireLease(s.id,"a")!;const one=repo.createRun(s.id,"full");const change={kind:"upsert" as const,message:{providerMessageId:"m1",subject:"hello",providerRevision:"7",addresses:[{role:"from",address:"A@EXAMPLE.COM"}]}};repo.applyPage(s.id,one.id,fence,[change]);repo.finishRun(one.id,"completed");const two=repo.createRun(s.id,"full");repo.applyPage(s.id,two.id,fence,[change]);expect(db.sqlite.prepare("select count(*) n from sync_changes").get()).toEqual({n:1});expect(db.sqlite.prepare("select count(*) n from mail_messages").get()).toEqual({n:1});expect(db.sqlite.prepare("select address from mail_addresses").get()).toEqual({address:"a@example.com"});expect(repo.messages(c.id)[0]).toMatchObject({providerMessageId:"m1",isRead:false,isStarred:false,isDraft:false,isTombstone:false});expect(()=>db.sqlite.prepare("select * from agent_sessions").all()).toThrow();db.close();});
 it("persists normalized mail as a provider-independent JSON record",async()=>{const {db,repo}=await setup();const c=repo.registerConnection({provider:"gmail",nangoConfigKey:"g",nangoConnectionId:"c"});const s=repo.ensureScope(c.id,"me","Mailbox");const fence=repo.acquireLease(s.id,"a")!;const run=repo.createRun(s.id,"full");repo.applyPage(s.id,run.id,fence,[{kind:"upsert",message:{providerMessageId:"m-json",subject:"JSON",textBody:"body",addresses:[{role:"from",displayName:"Sender",address:"sender@example.com"}],attachments:[{providerId:"a1",filename:"note.txt",mimeType:"text/plain",size:4}]}}]);const row=db.sqlite.prepare("select record_type as recordType,payload_json as payloadJson from connector_records where connection_id=? and provider_record_id=?").get(c.id,"m-json") as any;expect(row.recordType).toBe("mail");expect(JSON.parse(row.payloadJson)).toMatchObject({schemaVersion:1,type:"mail",provider:"gmail",connectionId:c.id,data:{providerMessageId:"m-json",subject:"JSON",textBody:"body",addresses:[{role:"from",displayName:"Sender",address:"sender@example.com"}],attachments:[{providerId:"a1",filename:"note.txt",mimeType:"text/plain",size:4}]}});db.close();});
 it("rejects stale fences and checkpoint revisions",async()=>{const {db,repo}=await setup();const c=repo.registerConnection({provider:"outlook",nangoConfigKey:"o",nangoConnectionId:"c"});const s=repo.ensureScope(c.id,"inbox","Inbox");const fence=repo.acquireLease(s.id,"a")!;const run=repo.createRun(s.id,"full");expect(()=>repo.applyPage(s.id,run.id,fence+1,[])).toThrow("connector_fence_conflict");repo.casCursor(s.id,0,fence,"opaque");expect(()=>repo.casCursor(s.id,0,fence,"stale")).toThrow("connector_checkpoint_conflict");db.close();});
 it("keeps an Outlook message active when it moves between folder scopes",async()=>{const {db,repo}=await setup();const c=repo.registerConnection({provider:"outlook",nangoConfigKey:"o",nangoConnectionId:"c"});const old=repo.ensureScope(c.id,"old","Old"),next=repo.ensureScope(c.id,"new","New");const oldFence=repo.acquireLease(old.id,"old")!,nextFence=repo.acquireLease(next.id,"new")!;const oldRun=repo.createRun(old.id,"incremental"),nextRun=repo.createRun(next.id,"incremental");const upsert={kind:"upsert" as const,message:{providerMessageId:"m",providerThreadId:"thread",providerRevision:"2",subject:"Moved"}};repo.applyPage(old.id,oldRun.id,oldFence,[upsert]);repo.applyPage(next.id,nextRun.id,nextFence,[upsert]);repo.applyPage(old.id,oldRun.id,oldFence,[{kind:"tombstone",providerMessageId:"m"}]);expect(repo.messages(c.id)[0]).toMatchObject({providerMessageId:"m",isTombstone:false});expect(repo.records(c.id)).toHaveLength(1);expect(db.sqlite.prepare("select scope_id as scopeId,membership_key as key from mail_memberships").all()).toEqual([{scopeId:next.id,key:"new"}]);expect(db.sqlite.prepare("select count(*) n from mail_threads").get()).toEqual({n:1});expect(repo.getScope(next.id)?.deliveryCursor).toBe(2);expect(repo.getScope(old.id)?.deliveryCursor).toBe(3);db.close();});
 it("disables all scopes with their connection",async()=>{const {db,repo}=await setup();const c=repo.registerConnection({provider:"gmail",nangoConfigKey:"g",nangoConnectionId:"c"});repo.ensureScope(c.id,"me","Mailbox");repo.disableConnection(c.id);expect(repo.getConnection(c.id)?.status).toBe("disabled");expect(repo.listScopes()[0]?.state).toBe("disabled");db.close();});
});
describe("provider normalization",()=>{
 it("normalizes Gmail bodies, flags, and history deletion",()=>{const data=Buffer.from("hello").toString("base64url");const result=normalizeGmailMessage({id:"m",threadId:"t",historyId:"9",internalDate:"0",labelIds:["UNREAD","STARRED"],payload:{headers:[{name:"Subject",value:"Hi"}],mimeType:"text/plain",body:{data}}});expect(result).toMatchObject({kind:"upsert",message:{subject:"Hi",textBody:"hello",isRead:false,isStarred:true}});expect(gmailHistoryChanges({history:[{messagesDeleted:[{message:{id:"m"}}]}]})).toEqual([{id:"m",removed:true}]);});
 it("normalizes Graph messages and removals",()=>{expect(normalizeOutlookMessage({id:"m","@removed":{reason:"deleted"}})).toEqual({kind:"tombstone",providerMessageId:"m"});expect(normalizeOutlookMessage({id:"m",conversationId:"c",isRead:true,body:{contentType:"html",content:"<b>x</b>"},toRecipients:[{emailAddress:{address:"X@e.com"}}]})).toMatchObject({kind:"upsert",message:{providerThreadId:"c",htmlBody:"<b>x</b>",isRead:true}});});
});
describe("Nango executor",()=>{
 it("uses provider-relative proxy paths and prefixes provider headers",()=>{expect(nangoProxyRequest("secret","connection","microsoft-mail","https://graph.microsoft.com/v1.0/me/messages?$top=10",{Prefer:'IdType="ImmutableId"'})).toEqual({path:"/proxy/v1.0/me/messages?$top=10",headers:{Authorization:"Bearer secret","Connection-Id":"connection","Provider-Config-Key":"microsoft-mail",Retries:"3","Retry-On":"408","nango-proxy-Prefer":'IdType="ImmutableId"'}});});
 it("anchors Gmail before bootstrap and catches up messages created during the scan",async()=>{const calls:string[]=[];const responses=[{historyId:"10"},{messages:[{id:"old"}]},{id:"old",historyId:"9",payload:{headers:[]}},{historyId:"12",history:[{messagesAdded:[{message:{id:"new"}}]}]},{id:"new",historyId:"12",payload:{headers:[]}}];const http={get:async(path:string)=>{calls.push(path);return {data:responses.shift()};}} as any;const executor=new NangoExecutor("https://nango.local","secret",http);const pages=[];for await(const page of executor.pull({provider:"gmail",nangoConnectionId:"c",nangoConfigKey:"g",providerScopeId:"me",sourceCursor:null},"full"))pages.push(page);expect(calls[0]).toBe("/proxy/gmail/v1/users/me/profile");expect(pages.flatMap(p=>p.changes).map(c=>c.kind==="upsert"?c.message.providerMessageId:c.providerMessageId)).toEqual(["old","new"]);expect(pages.at(-1)?.terminalCursor).toBe("12");});
});
describe("Nango authorization",()=>{
 it("reports safe upstream status and error code without echoing response messages",()=>{const error=Object.assign(new Error("request failed"),{isAxiosError:true,response:{status:500,data:{error:{code:"server_error",message:"sensitive upstream detail"}}}});expect(nangoAuthorizationErrorMessage(error,"Unable to start Nango authorization")).toBe("Unable to start Nango authorization（Nango HTTP 500: server_error）");});
 it("creates a provider-scoped connect session and automatically registers the tagged connection",async()=>{const {db,repo}=await setup();const manager=new ConnectorManager(repo,{discoverScopes:async()=>[{id:"me",displayName:"Mailbox"}],async *pull(){}} as any);let postBody:any;let query:any;let attemptId="";const http={post:async(path:string,body:any)=>{postBody=body;attemptId=body.tags.auth_attempt_id;return {data:{data:{token:"short-lived",connect_link:"https://connect.nango.test/?session_token=short-lived",expires_at:new Date(Date.now()+60_000).toISOString()}}};},get:async(path:string,config:any)=>{query=config.params;return {data:{connections:[{connection_id:"nango-created",provider_config_key:"google-mail",tags:{auth_attempt_id:attemptId},errors:[]}]}};}} as any;const authorization=new NangoAuthorizationService("https://nango.test","secret",{gmail:"google-mail",outlook:"microsoft-mail"},manager,http);const started=await authorization.start("gmail");expect(postBody).toMatchObject({allowed_integrations:["google-mail"],tags:{auth_attempt_id:started.id,end_user_id:`everroom-local-${started.id}`}});expect(started.authorizationUrl).toBe("https://connect.nango.test/?session_token=short-lived&apiURL=https%3A%2F%2Fnango.test");const completed=await authorization.status(started.id);expect(query).toEqual({"tags[auth_attempt_id]":started.id,limit:10});expect(completed).toMatchObject({status:"connected",connection:{provider:"gmail",nangoConnectionId:"nango-created",nangoConfigKey:"google-mail"}});expect(repo.listScopes()).toHaveLength(1);await manager.dispose();db.close();});
 it("rejects a connect session that does not provide a hosted connect link",async()=>{const {db,repo}=await setup();const manager=new ConnectorManager(repo,null);const http={post:async()=>({data:{data:{token:"token",expires_at:new Date(Date.now()+60_000).toISOString()}}})} as any;const authorization=new NangoAuthorizationService("https://nango.test","secret",{gmail:"google-mail",outlook:"microsoft-mail"},manager,http);await expect(authorization.start("gmail")).rejects.toThrow("nango_connect_session_invalid");await manager.dispose();db.close();});
});
describe("connector manager recovery",()=>{
 it("stores connector documents as Markdown and reports them as processed",async()=>{const {db,repo}=await setup();const c=repo.registerConnection({provider:"google-docs",nangoConfigKey:"docs",nangoConnectionId:"c"});const s=repo.ensureScope(c.id,"documents","Google Docs");const output=join(dirname(repo.sqlite.name),"documents");const executor={async *pull(){yield {changes:[],documents:[{providerDocumentId:"doc-1",title:"Project Notes",markdown:"# Project Notes\n\nBody\n",providerRevision:"r1"}]};}} as any;const manager=new ConnectorManager(repo,executor,new ConnectorDocumentStore(output));const run=manager.trigger(s.id,"full");await manager.dispose();const files=await readdir(join(output,"google-docs",c.id));expect(files).toHaveLength(1);expect(files[0]).toMatch(/\.md$/);expect(await readFile(join(output,"google-docs",c.id,files[0]!),"utf8")).toBe("# Project Notes\n\nBody\n");expect(repo.getRun(run.id)).toMatchObject({status:"completed",processed:1});expect(db.sqlite.prepare("select count(*) n from mail_messages").get()).toEqual({n:0});db.close();});
 it("lists and previews stored connector Markdown with path-safe document ids",async()=>{const {db,repo}=await setup();const c=repo.registerConnection({provider:"notion",nangoConfigKey:"notion",nangoConnectionId:"c"});const output=join(dirname(repo.sqlite.name),"documents");const store=new ConnectorDocumentStore(output);await store.write("notion",c.id,{providerDocumentId:"page-1",title:"Ignored metadata",markdown:"# Product Brief\n\nPreview body"});const manager=new ConnectorManager(repo,null,store);expect(await manager.listDocuments(c.id)).toEqual([expect.objectContaining({id:"page-1",fileName:"page-1.md",title:"Product Brief",size:29})]);expect(await manager.readDocument(c.id,"page-1")).toMatchObject({id:"page-1",title:"Product Brief",content:"# Product Brief\n\nPreview body"});await expect(manager.readDocument(c.id,"../connectors.sqlite")).rejects.toThrow("invalid_document_id");await manager.dispose();db.close();});
 it("fans synced documents out to the memory sink without failing the run",async()=>{const {db,repo}=await setup();const c=repo.registerConnection({provider:"google-docs",nangoConfigKey:"docs",nangoConnectionId:"c"});const s=repo.ensureScope(c.id,"documents","Google Docs");const output=join(dirname(repo.sqlite.name),"documents");const executor={async *pull(){yield {changes:[],documents:[{providerDocumentId:"doc-9",title:"Fanout",markdown:"# Fanout\n",providerRevision:"r1"}]};}} as any;const manager=new ConnectorManager(repo,executor,new ConnectorDocumentStore(output));const seen:any[]=[];manager.setMemorySink(async(input)=>{seen.push(input);if(seen.length===1)throw new Error("memory down");});const run=manager.trigger(s.id,"full");await manager.dispose();expect(seen).toEqual([{kind:"document",provider:"google-docs",connectionId:c.id,documentId:"doc-9",title:"Fanout",markdown:"# Fanout\n"}]);expect(repo.getRun(run.id)).toMatchObject({status:"completed",processed:1});db.close();});
 it("fans synced mail upserts (not tombstones) out to the memory sink as markdown",async()=>{const {db,repo}=await setup();const c=repo.registerConnection({provider:"gmail",nangoConfigKey:"g",nangoConnectionId:"c"});const s=repo.ensureScope(c.id,"me","Mailbox");const executor={async *pull(){yield {changes:[{kind:"upsert",message:{providerMessageId:"m-1",subject:"季度总结",textBody:"正文内容",receivedAt:"2026-08-19T09:00:00Z",addresses:[{role:"from",displayName:"张三",address:"z@e.com"},{role:"to",address:"me@e.com"}]}},{kind:"tombstone",providerMessageId:"m-2"}]};}} as any;const manager=new ConnectorManager(repo,executor);const seen:any[]=[];manager.setMemorySink(async(input)=>{seen.push(input);});const run=manager.trigger(s.id,"full");await manager.dispose();expect(seen).toEqual([{kind:"mail",provider:"gmail",connectionId:c.id,documentId:"m-1",title:"季度总结",markdown:"# 季度总结\n\n发件人：张三 <z@e.com>\n\n收件人：me@e.com\n\n时间：2026-08-19T09:00:00Z\n\n正文内容"}]);expect(repo.getRun(run.id)).toMatchObject({status:"completed"});db.close();});
 it("fans synced calendar upserts out to the memory sink as markdown",async()=>{const {db,repo}=await setup();const c=repo.registerConnection({provider:"google-calendar",nangoConfigKey:"gc",nangoConnectionId:"c"});const s=repo.ensureScope(c.id,"primary","Primary calendar");const executor={async *pull(){yield {changes:[],calendarChanges:[{kind:"upsert",event:{providerEventId:"ev-1",title:"评审会",startsAt:"2026-08-20T02:00:00Z",endsAt:"2026-08-20T03:00:00Z",timeZone:"Asia/Shanghai",location:"会议室 A",organizer:{role:"organizer",address:"o@e.com"},attendees:[{role:"attendee",address:"a@e.com"}],description:"过方案"}},{kind:"tombstone",providerEventId:"ev-2"}]};}} as any;const manager=new ConnectorManager(repo,executor);const seen:any[]=[];manager.setMemorySink(async(input)=>{seen.push(input);});const run=manager.trigger(s.id,"full");await manager.dispose();expect(seen).toEqual([{kind:"calendar",provider:"google-calendar",connectionId:c.id,documentId:"ev-1",title:"评审会",markdown:"# 评审会\n\n时间：2026-08-20T02:00:00Z → 2026-08-20T03:00:00Z（Asia/Shanghai）\n\n地点：会议室 A\n\n组织者：o@e.com\n\n与会人：a@e.com\n\n## 描述\n\n过方案"}]);expect(repo.getRun(run.id)).toMatchObject({status:"completed"});db.close();});
 it("marks invalid Gmail history for rebuild without clearing its cursor",async()=>{const {db,repo}=await setup();const c=repo.registerConnection({provider:"gmail",nangoConfigKey:"g",nangoConnectionId:"c"});const s=repo.ensureScope(c.id,"me","Mailbox");db.sqlite.prepare("update sync_scopes set source_cursor='opaque-history' where id=?").run(s.id);const error=Object.assign(new Error("expired"),{response:{status:404}});const executor={async *pull(){throw error;}} as any;const manager=new ConnectorManager(repo,executor);manager.trigger(s.id,"incremental");await manager.dispose();expect(repo.getScope(s.id)).toMatchObject({state:"resync_required",sourceCursor:"opaque-history"});await manager.dispose();db.close();});
 it("purges an orphan connection when scope discovery fails",async()=>{const {db,repo}=await setup();const manager=new ConnectorManager(repo,{discoverScopes:async()=>{throw new Error("discovery failed");},async *pull(){}} as any);await expect(manager.register({provider:"outlook",nangoConfigKey:"o",nangoConnectionId:"c"})).rejects.toThrow("discovery failed");expect(repo.listConnections()).toEqual([]);db.close();});
});
describe("connector routes",()=>{
 it("inherits bearer authentication and rejects disabled mutations",async()=>{const dir=await mkdtemp(join(tmpdir(),"connector-route-"));dirs.push(dir);const app=await createServer({host:"127.0.0.1",port:0,dataDir:dir,databasePath:join(dir,"gateway.sqlite"),migrationsDir:resolve("drizzle"),runtimeManifestPath:join(dir,"runtime.json"),logLevel:"silent",authToken:"test-token-0123456789",agentRuntime:"fake",memory:null,pi:null,backgroundPi:null,asrInputDir:join(dir,"recordings"),asr:null,knowledge:null,cursorCompletionPi:null,mcpConfigPath:join(dir,"agent","mcp.json"),webSearch:null});expect((await app.inject({url:"/v1/connectors/status"})).statusCode).toBe(401);const headers={authorization:"Bearer test-token-0123456789"};expect((await app.inject({url:"/v1/connectors/status",headers})).json()).toMatchObject({enabled:false,connections:[]});expect((await app.inject({method:"POST",url:"/v1/connectors/connections",headers,payload:{provider:"gmail",nangoConfigKey:"g",nangoConnectionId:"c"}})).statusCode).toBe(503);await app.close();});
});
import {
  connectorPromptProfiles,
  connectorSyncJobStates,
  connectorSyncJobVersions,
} from "../src/infrastructure/database/schema.js";
import {
  ConnectorConfigVersionConflictError,
  ConnectorSyncService,
} from "../src/modules/connectors/service.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("ConnectorSyncService", () => {
  it("seeds configured jobs and idempotently upserts synchronized records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-connectors-"));
    const config = loadConfig(["--token", "0123456789abcdef"], {
      OO_CONNECTOR_URL: "http://127.0.0.1:3000",
      OO_CONNECTOR_TOKEN: "runtime-secret",
      NXCORE_CONNECTOR_SYNC_ENABLED: "true",
      NXCORE_CONNECTOR_SYNC_JOBS: JSON.stringify([{
        id: "mail-recent",
        ownerId: "local-user",
        service: "gmail",
        action: "fetch_emails",
        dataset: "email",
        connectionName: "default",
        input: { query: "newer_than:1d", maxResults: 10 },
      }]),
    });
    const database = createDatabase(join(directory, "gateway.sqlite"), config.migrationsDir);
    const calls: string[][] = [];
    const service = new ConnectorSyncService(database.db, config, logger, async (_config, args) => {
      calls.push(args);
      return [{ id: "message-1", subject: "Hello", updated_at: "2026-08-19T00:00:00.000Z" }];
    });

    try {
      await service.initialize();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(calls).toHaveLength(1);
      expect(service.status("local-user").recordCount).toBe(1);
      expect(service.queryRecords({ ownerId: "local-user", service: "gmail", dataset: "email" })).toHaveLength(1);

      await service.triggerJob("mail-recent");
      expect(calls).toHaveLength(2);
      expect(service.status("local-user").recordCount).toBe(1);
      expect(service.getJob("mail-recent")?.lastError).toBeNull();
    } finally {
      service.close();
      database.sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not start a scheduler when connector sync is disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-connectors-disabled-"));
    const config = loadConfig(["--token", "0123456789abcdef"], {
      OO_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_CONNECTOR_SYNC_ENABLED: "false",
      NXCORE_CONNECTOR_SYNC_JOBS: JSON.stringify([{
        id: "disabled-job",
        ownerId: "local-user",
        service: "github",
        action: "list_repositories",
        dataset: "repositories",
        input: {},
      }]),
    });
    const database = createDatabase(join(directory, "gateway.sqlite"), config.migrationsDir);
    let calls = 0;
    const service = new ConnectorSyncService(database.db, config, logger, async () => {
      calls += 1;
      return [];
    });

    try {
      await service.initialize();
      expect(service.getJob("disabled-job")).not.toBeNull();
      expect(calls).toBe(0);
    } finally {
      service.close();
      database.sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the database as the task source after the one-time JSON bootstrap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-connectors-source-"));
    const firstConfig = loadConfig(["--token", "0123456789abcdef"], {
      OO_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_CONNECTOR_SYNC_ENABLED: "false",
      NXCORE_CONNECTOR_SYNC_JOBS: JSON.stringify([{
        id: "database-job", ownerId: "local-user", service: "gmail", action: "fetch_emails",
        dataset: "emails", resourceType: "email", input: {},
      }]),
    });
    const database = createDatabase(join(directory, "gateway.sqlite"), firstConfig.migrationsDir);
    const firstService = new ConnectorSyncService(database.db, firstConfig, logger);
    await firstService.initialize();
    await firstService.dispose();

    const secondConfig = loadConfig(["--token", "0123456789abcdef"], {
      OO_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_CONNECTOR_SYNC_ENABLED: "false",
      NXCORE_CONNECTOR_SYNC_JOBS: JSON.stringify([{
        id: "environment-job", ownerId: "local-user", service: "notion", action: "search_pages",
        dataset: "documents", resourceType: "document", input: {},
      }]),
    });
    const secondService = new ConnectorSyncService(database.db, secondConfig, logger);
    try {
      await secondService.initialize();
      expect(secondService.getJob("database-job")?.status).toBe("active");
      expect(secondService.getJob("environment-job")).toBeNull();
    } finally {
      await secondService.dispose();
      database.sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("versions database-backed jobs and separates mutable scheduler state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-connectors-config-"));
    const config = loadConfig(["--token", "0123456789abcdef"], {
      OO_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_CONNECTOR_SYNC_ENABLED: "false",
    });
    const database = createDatabase(join(directory, "gateway.sqlite"), config.migrationsDir);
    const service = new ConnectorSyncService(database.db, config, logger);
    try {
      await service.initialize();
      expect(database.db.select().from(connectorPromptProfiles).all()).toHaveLength(3);
      const created = service.createJob({
        name: "Gmail 最近一天", service: "gmail", dataset: "emails", resourceType: "email",
        connectionName: "default", allowedActions: ["fetch_emails", "get_message"],
        input: { query: "newer_than:1d" }, goal: "同步最近一天邮件", scheduleType: "interval",
        intervalMs: 900_000, timezone: "Asia/Shanghai", status: "active",
      });
      expect(created.promptProfileId).toBe("gmail-email-sync-v1");
      expect(created.configVersion).toBe(1);
      expect(database.db.select().from(connectorSyncJobStates).all()).toHaveLength(1);
      expect(database.db.select().from(connectorSyncJobVersions).all()).toHaveLength(1);

      const paused = service.setJobStatus(created.id, "paused", created.configVersion)!;
      expect(paused).toMatchObject({ status: "paused", configVersion: 2, nextRunAt: null });
      expect(database.db.select().from(connectorSyncJobVersions).all()).toHaveLength(2);
      expect(() => service.updateJob(created.id, { configVersion: 1, name: "stale write" }))
        .toThrow(ConnectorConfigVersionConflictError);
    } finally {
      await service.dispose();
      database.sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
