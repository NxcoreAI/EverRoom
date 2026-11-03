import { resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { and, eq, isNull } from "drizzle-orm";
import { fileEntries, fileVersions } from "../../infrastructure/database/schema.js";
import type { SpaceCacheManager } from "./cache.js";
import type { AgentService } from "../agent/service.js";
import type { FilesService } from "../files/service.js";
import type { SpaceLibraryWriter } from "./library.js";
import { reconcileSpaceLibrary } from "./reconcile.js";
import type { WorkspaceLayoutService } from "./service.js";

/**
 * 项目空间目录接口（`/v1/workspaces/*`）。
 *
 * 与 `/v1/agent/workspaces` 的分工：那边是空间元数据 CRUD（AgentService 维护），
 * 这里是"磁盘目录"这一面——默认落点、判定、发现、健康、修复。
 * 设计见 docs/project-space-layout-plan.zh-CN.md §6.2。
 */

/** 目录相关错误 → 400 负载（其余错误照常抛给全局错误处理）。 */
const SPACE_ERROR_STATUS: Record<string, { status: number; message: string }> = {
  space_marker_conflict: {
    status: 409,
    message: "该目录已经是另一个项目空间（space.everoffice 里的 spaceId 与当前空间不一致）",
  },
  space_marker_exists: {
    status: 409,
    message: "该目录已存在 space.everoffice，请改用「打开已有项目空间」",
  },
  space_root_not_writable: {
    status: 400,
    message: "目录不可写（只读卷 / 权限不足 / 磁盘已满）",
  },
  space_already_registered: {
    status: 409,
    message: "这个项目空间已经注册过了（spaceId 已存在），如需另存请选择「作为副本注册」",
  },
  space_path_taken: {
    status: 409,
    message: "该目录已绑定到另一个项目空间",
  },
  space_root_missing: { status: 404, message: "目录不存在或已被移动" },
  space_root_exists: { status: 409, message: "目标目录已存在，请先清空或换一个位置" },
  space_marker_invalid: { status: 400, message: "目录里的 space.everoffice 无法解析" },
  space_marker_unsupported: {
    status: 409,
    message: "该空间的标记版本比本应用新，请升级后再操作（当前只读）",
  },
  space_relocate_failed: { status: 500, message: "搬移未完成：目标目录校验失败，原目录已保留" },
  agent_workspace_not_found: { status: 404, message: "Workspace not found" },
};

export interface WorkspaceLibraryDeps {
  db: GatewayDatabase;
  writer: SpaceLibraryWriter;
  files: FilesService;
  cache: SpaceCacheManager;
}

export function workspaceLayoutRoutes(
  layout: WorkspaceLayoutService,
  agentService: AgentService,
  library: WorkspaceLibraryDeps,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    const mapSpaceError = (error: unknown): { status: number; body: { error: string; message: string } } | null => {
      const code = error instanceof Error ? error.message : "";
      const mapped = SPACE_ERROR_STATUS[code];
      if (mapped) return { status: mapped.status, body: { error: code, message: mapped.message } };
      const systemCode = (error as NodeJS.ErrnoException | undefined)?.code;
      if (systemCode === "EACCES" || systemCode === "EPERM" || systemCode === "EROFS" || systemCode === "ENOSPC") {
        return {
          status: 400,
          body: { error: "space_root_not_writable", message: "目录不可写（只读卷 / 权限不足 / 磁盘已满）" },
        };
      }
      return null;
    };

    app.get(
      "/v1/workspaces/default-root",
      {
        schema: {
          tags: ["workspaces"],
          querystring: Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }) }),
        },
      },
      async (request, reply) => {
        const preview = agentService.previewDefaultRoot(request.query.name);
        if (!preview) return reply.code(503).send({ error: "space_layout_unavailable", message: "目录服务未就绪" });
        return preview;
      },
    );

    app.post(
      "/v1/workspaces/detect",
      {
        schema: {
          tags: ["workspaces"],
          body: Type.Object({ dir: Type.String({ minLength: 1, maxLength: 2_000 }) }),
        },
      },
      async (request) => {
        const result = layout.detect(request.body.dir);
        if (result.status === "ok") {
          return {
            status: "space" as const,
            // v2 标记在 `.everoffice/` 里，根就是用户指定的目录本身。
            root: resolve(request.body.dir),
            spaceId: result.marker.spaceId,
            name: result.marker.name,
            slug: result.marker.slug,
            layoutVersion: result.marker.layoutVersion,
            readonly: false,
          };
        }
        return { status: result.status };
      },
    );

    /** 接管已有目录为自己的项目空间（保留标记里的 spaceId；复制品可重新分配）。 */
    app.post(
      "/v1/workspaces/adopt",
      {
        schema: {
          tags: ["workspaces"],
          body: Type.Object({
            dir: Type.String({ minLength: 1, maxLength: 2_000 }),
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
            reassignSpaceId: Type.Optional(Type.Boolean()),
          }),
        },
      },
      async (request, reply) => {
        try {
          return reply.code(201).send(agentService.adoptWorkspace(request.body));
        } catch (error) {
          const mapped = mapSpaceError(error);
          if (mapped) return reply.code(mapped.status).send(mapped.body);
          throw error;
        }
      },
    );

    /** 搬移空间目录：整个目录搬过去，再更新 DB 与标记。 */
    app.post(
      "/v1/agent/workspaces/:id/relocate",
      {
        schema: {
          tags: ["workspaces"],
          params: Type.Object({ id: Type.String({ minLength: 1 }) }),
          body: Type.Object({ dir: Type.String({ minLength: 1, maxLength: 2_000 }) }),
        },
      },
      async (request, reply) => {
        try {
          return await agentService.relocateWorkspace(request.params.id, request.body.dir);
        } catch (error) {
          const mapped = mapSpaceError(error);
          if (mapped) return reply.code(mapped.status).send(mapped.body);
          throw error;
        }
      },
    );

    app.get(
      "/v1/workspaces/discover",
      { schema: { tags: ["workspaces"] } },
      async () => agentService.discoverSpaces(),
    );

    app.get(
      "/v1/agent/workspaces/:id/layout",
      {
        schema: {
          tags: ["workspaces"],
          params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        },
      },
      async (request, reply) => {
        const workspace = agentService.getWorkspace(request.params.id);
        if (!workspace) return reply.code(404).send({ error: "not_found", message: "Workspace not found" });
        const snapshot = agentService.workspaceLayoutOf(workspace.id);
        if (!snapshot) {
          return reply.code(409).send({
            error: "space_layout_unavailable",
            message: "该空间尚未绑定目录或目录服务未就绪",
          });
        }
        return snapshot;
      },
    );

    /** 资料库对账：盘上删了→missing、回来了→恢复、多了→入库。 */
    app.post(
      "/v1/agent/workspaces/:id/library/reconcile",
      {
        schema: {
          tags: ["workspaces"],
          params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        },
      },
      async (request, reply) => {
        const workspace = agentService.getWorkspace(request.params.id);
        if (!workspace) return reply.code(404).send({ error: "not_found", message: "Workspace not found" });
        try {
          return await reconcileSpaceLibrary({
            db: library.db,
            writer: library.writer,
            files: library.files,
            spaceId: workspace.id,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          if (code === "space_library_unbound") {
            return reply.code(409).send({
              error: "space_library_unbound",
              message: "该空间尚未绑定目录，资料库暂不落盘",
            });
          }
          throw error;
        }
      },
    );

    /** 空间缓存统计（tmp / derived / objects 三项）。 */
    app.get(
      "/v1/agent/workspaces/:id/cache",
      {
        schema: {
          tags: ["workspaces"],
          params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        },
      },
      async (request, reply) => {
        const workspace = agentService.getWorkspace(request.params.id);
        if (!workspace) return reply.code(404).send({ error: "not_found", message: "Workspace not found" });
        return library.cache.stats(workspace.id);
      },
    );

    /**
     * `.tmp/` 只读清单（「临时文件」入口）。
     *
     * 刻意**不入资料库索引**：里面是 Agent 的过程产物，随时会被 GC，
     * 进索引只会制造 missing 噪音。这里只读目录，不写库、不删任何东西。
     */
    app.get(
      "/v1/agent/workspaces/:id/cache/scratch",
      {
        schema: {
          tags: ["workspaces"],
          params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        },
      },
      async (request, reply) => {
        const workspace = agentService.getWorkspace(request.params.id);
        if (!workspace) return reply.code(404).send({ error: "not_found", message: "Workspace not found" });
        return library.cache.listScratch(workspace.id);
      },
    );

    /** 缓存回收：tmp 按龄清、derived 按 LRU、objects 按"无版本引用 + 超龄"、回收站 30 天。 */
    app.post(
      "/v1/agent/workspaces/:id/cache/gc",
      {
        schema: {
          tags: ["workspaces"],
          params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        },
      },
      async (request, reply) => {
        const workspace = agentService.getWorkspace(request.params.id);
        if (!workspace) return reply.code(404).send({ error: "not_found", message: "Workspace not found" });
        const referenced = new Set(
          library.db.select({ contentHash: fileVersions.contentHash }).from(fileVersions)
            .innerJoin(fileEntries, eq(fileEntries.id, fileVersions.fileEntryId))
            .where(and(eq(fileEntries.workspaceId, workspace.id), isNull(fileEntries.deletedAt)))
            .all()
            .map((row) => row.contentHash),
        );
        return library.cache.gc(workspace.id, { referencedHashes: referenced });
      },
    );

    /** 存量懒回填：把这批"只在对象库里"的条目落到空间 Library（一次最多 200 条）。 */
    app.post(
      "/v1/agent/workspaces/:id/library/backfill",
      {
        schema: {
          tags: ["workspaces"],
          params: Type.Object({ id: Type.String({ minLength: 1 }) }),
          body: Type.Optional(Type.Object({
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 100 })),
          })),
        },
      },
      async (request, reply) => {
        const workspace = agentService.getWorkspace(request.params.id);
        if (!workspace) return reply.code(404).send({ error: "not_found", message: "Workspace not found" });
        if (!library.writer.targetOf(workspace.id)) {
          return reply.code(409).send({
            error: "space_library_unbound",
            message: "该空间尚未绑定目录，资料库暂不落盘",
          });
        }
        const limit = request.body?.limit ?? 100;
        const ids = library.files.listLibraryBacklog(workspace.id, limit);
        let materialized = 0;
        for (const id of ids) {
          if (await library.files.backfillLibraryFile(id).catch(() => false)) materialized += 1;
        }
        return { workspaceId: workspace.id, scanned: ids.length, materialized };
      },
    );

    app.post(
      "/v1/agent/workspaces/:id/layout/repair",
      {
        schema: {
          tags: ["workspaces"],
          params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        },
      },
      async (request, reply) => {
        try {
          const report = agentService.repairWorkspace(request.params.id);
          if (!report) {
            return reply.code(409).send({
              error: "space_layout_unavailable",
              message: "该空间尚未绑定目录或目录服务未就绪",
            });
          }
          return report;
        } catch (error) {
          const mapped = mapSpaceError(error);
          if (mapped) return reply.code(mapped.status).send(mapped.body);
          throw error;
        }
      },
    );
  };
}
