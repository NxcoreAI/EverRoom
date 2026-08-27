import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { RuntimeConfigManager } from "../../runtime-config.js";
import {
  aiFieldsConfigured,
  embeddingAiFields,
  isEmbeddingConfigured,
  isPrimaryConfigured,
  primaryAiFields,
  testAiConnection,
  testEmbeddingConnection,
  vlmAiFields,
} from "./validate.js";

const ConfigBody = Type.Object({}, { additionalProperties: true });
const SourceBody = Type.Object({ source: Type.Union([Type.Literal("user"), Type.Literal("saas"), Type.Literal("default")]) });

function configuredEmbeddingDimensions(): number | undefined {
  const raw = process.env.TDAI_EMBEDDING_DIMENSIONS?.trim();
  if (!raw) return undefined;
  const dimensions = Number(raw);
  return Number.isInteger(dimensions) && dimensions > 0 ? dimensions : undefined;
}

export function runtimeConfigRoutes(manager: RuntimeConfigManager): FastifyPluginAsyncTypebox {
  return async (app) => {
    // 桌面端启动 gate 靠该字段判定"已配置/未配置"；所有返回 snapshot 的
    // 路由统一附加（gate 在保存后立即读它决定是否进入连通测试）。
    const withFlag = (snapshot: unknown) => {
      const result = snapshot as ReturnType<RuntimeConfigManager["snapshot"]> & {
        config: Record<string, unknown>;
      };
      return { ...result, primaryConfigured: isPrimaryConfigured(result.config) };
    };
    app.get("/v1/runtime-config", { schema: { tags: ["runtime-config"] } }, async () =>
      withFlag(manager.snapshot(true)));
    app.put("/v1/runtime-config/user", { schema: { tags: ["runtime-config"], body: ConfigBody } }, async (request) => {
      manager.set("user", request.body);
      return withFlag(manager.snapshot(true));
    });
    // Never return the decrypted SaaS payload to the renderer. The main process
    // receives the secret from SaaS, but all gateway snapshots crossing IPC are redacted.
    app.put("/v1/runtime-config/saas", { schema: { tags: ["runtime-config"], body: ConfigBody } }, async (request) => {
      manager.set("saas", request.body);
      return withFlag(manager.snapshot(true));
    });
    app.delete("/v1/runtime-config/user", { schema: { tags: ["runtime-config"] } }, async () => {
      manager.clear("user");
      return withFlag(manager.snapshot(true));
    });
    app.delete("/v1/runtime-config/saas", { schema: { tags: ["runtime-config"] } }, async () => {
      manager.clear("saas");
      return withFlag(manager.snapshot(true));
    });
    app.put("/v1/runtime-config/source", { schema: { tags: ["runtime-config"], body: SourceBody } }, async (request) => {
      manager.selectSource(request.body.source);
      return withFlag(manager.snapshot(true));
    });
    /**
     * 仅供桌面主进程派生托管子进程 env 用：未脱敏 snapshot（真 apiKey）。
     * 与其余路由同走 token 鉴权——token 只在主进程，渲染层取不到；渲染层
     * 永远只拿上面那些脱敏快照。cursor-completion / knowledge / memory-core
     * 子进程没有 RuntimeConfigManager，spawn env 是唯一配置通道：给掩码
     * "********" 它们能正常起服务，然后每个上游请求 401。
     */
    app.get("/v1/runtime-config/secrets", { schema: { tags: ["runtime-config"] } }, async () =>
      withFlag(manager.snapshot(false)));
    /**
     * 连通测试（启动 gate 放行前的最后一关）：对当前生效配置的 LLM 端点发
     * 一次 max_tokens=1 的真实请求，2xx 才算 valid。凭据不回传——apiKey
     * 校验发生在 gateway 侧，渲染层只拿到 valid/error。body 可有可无（POST
     * 无 body 时客户端可能带任意 content-type，显式置 null 跳过解析）。
     * knowledge.embedding 四要素齐全时顺带测 /embeddings 并返回维度
     * （桌面主进程注入 MemoryCore TDAI_EMBEDDING_DIMENSIONS 用）；vlm 同样
     * chat/completions 探测（多模态模型接受纯文本）。两者均为可选项，
     * 未配置/部分填写时不带对应字段（不阻塞放行判定）。
     */
    app.post("/v1/runtime-config/test", {
      schema: { tags: ["runtime-config"], body: { type: "object", additionalProperties: true } },
    }, async (_request, reply) => {
      const config = manager.snapshot(false).config as Record<string, unknown>;
      const result = await testAiConnection(primaryAiFields(config));
      const embeddingFields = embeddingAiFields(config);
      const vlmFields = vlmAiFields(config);
      const [embeddingResult, vlmResult] = await Promise.all([
        isEmbeddingConfigured(embeddingFields)
          ? testEmbeddingConnection(embeddingFields, configuredEmbeddingDimensions())
          : null,
        aiFieldsConfigured(vlmFields) ? testAiConnection(vlmFields) : null,
      ]);
      return reply.send({
        ...result,
        ...(embeddingResult ? { embedding: embeddingResult } : {}),
        ...(vlmResult ? { vlm: vlmResult } : {}),
      });
    });
  };
}
