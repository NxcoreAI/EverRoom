import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import { SkillNotFoundError, type SkillService, type SkillView } from "./service.js";
import { SkillInputError, type SkillInputErrorCode } from "./user-skills.js";

const SkillDto = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  ownerId: Type.String(),
  ownerName: Type.String(),
  ownerKind: Type.Union([
    Type.Literal("builtin"),
    Type.Literal("subagent"),
    Type.Literal("user"),
  ]),
  path: Type.String(),
  enabled: Type.Boolean(),
  bytes: Type.Integer(),
  updatedAt: Type.Union([Type.String(), Type.Null()]),
});

const SkillDetailDto = Type.Composite([
  SkillDto,
  Type.Object({
    /** SKILL.md 全文（frontmatter + 正文）。 */
    prompt: Type.String(),
  }),
]);

const SkillErrorDto = Type.Object({
  error: Type.String(),
  message: Type.Optional(Type.String()),
});

export interface SkillRouteHooks {
  /**
   * 开关变化后让运行时重新装配（内置 Agent 的 skillPrompts 与子 Agent 的
   * skill 缓存都在 runtime 里定型）。失败不回滚状态：状态已经落库，
   * 下一次任何重载都会带上它。
   */
  onStateChanged: (skillId: string, enabled: boolean) => Promise<void>;
  /** 目录变化（新增/导入/删除）后同样要重装，否则新技能进不了系统提示词。 */
  onCatalogChanged: (action: "created" | "imported" | "removed", skillId: string) => Promise<void>;
}

/** 可预期的用户输入错误 → HTTP 状态码（与其它路由的 error/message 风格一致）。 */
const INPUT_ERROR_STATUS: Record<SkillInputErrorCode, 400 | 404 | 409> = {
  skill_name_invalid: 400,
  skill_description_required: 400,
  skill_body_required: 400,
  skill_source_invalid: 400,
  skill_source_missing_manifest: 400,
  skill_source_too_large: 400,
  skill_name_taken: 409,
  skill_not_removable: 409,
  skill_not_found: 404,
};

/**
 * 错误体固定 `{ error: 机器码, message: 机器码(+细节) }`。
 *
 * 桌面端按机器码翻成用户话术（同 thesis / connector 两条链路的口径）：网关不写
 * 面向用户的中文长句，否则同一句话要在网关与桌面各维护一份。
 */
function inputErrorPayload(error: SkillInputError): { error: string; message: string } {
  return {
    error: error.code,
    message: error.message === error.code ? error.code : `${error.code}: ${error.message}`,
  };
}

/**
 * 「技能」页的数据端点。
 *
 * 读：清单（内置 Agent bundle + 子 Agent 清单 + 用户技能）、单条正文。
 * 写：启停（三类都能改）、新增/导入/删除（只对用户技能）。
 *
 * 内置技能与子 Agent 技能是随版本发布的只读资源：删不掉，接口给
 * `skill_not_removable`（409）而不是假装成功。
 */
export function skillRoutes(service: SkillService, hooks: SkillRouteHooks): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/skills",
      {
        schema: {
          tags: ["skills"],
          response: {
            200: Type.Object({
              skills: Type.Array(SkillDto),
              counts: Type.Object({
                total: Type.Integer(),
                enabled: Type.Integer(),
              }),
            }),
          },
        },
      },
      async () => {
        const skills = service.list();
        return {
          skills,
          counts: {
            total: skills.length,
            enabled: skills.filter((skill) => skill.enabled).length,
          },
        };
      },
    );

    app.get(
      "/v1/skills/:skillId",
      {
        schema: {
          tags: ["skills"],
          params: Type.Object({ skillId: Type.String({ minLength: 1, maxLength: 300 }) }),
          response: {
            200: SkillDetailDto,
            404: SkillErrorDto,
          },
        },
      },
      async (request, reply) => {
        const skill = service.get(request.params.skillId);
        if (!skill) return reply.code(404).send({ error: "skill_not_found" });
        return skill;
      },
    );

    // 手写一个技能：name/description 进 frontmatter，body 是正文。
    app.post(
      "/v1/skills",
      {
        schema: {
          tags: ["skills"],
          body: Type.Object({
            name: Type.String({ minLength: 1, maxLength: 64 }),
            description: Type.String({ minLength: 1, maxLength: 500 }),
            body: Type.String({ minLength: 1, maxLength: 200_000 }),
          }),
          response: {
            200: SkillDto,
            400: SkillErrorDto,
            404: SkillErrorDto,
            409: SkillErrorDto,
          },
        },
      },
      async (request, reply) => {
        let skill: SkillView;
        try {
          skill = service.createUserSkill(request.body);
        } catch (error) {
          if (error instanceof SkillInputError) {
            return reply.code(INPUT_ERROR_STATUS[error.code]).send(inputErrorPayload(error));
          }
          throw error;
        }
        await hooks.onCatalogChanged("created", skill.id).catch((error: unknown) => {
          app.log.error({
            event: "skills.apply_failed",
            skillId: skill.id,
            error: error instanceof Error ? error.message : String(error),
          }, "skill created but runtime reload failed");
        });
        return skill;
      },
    );

    // 从本地文件夹导入（该目录里必须有 SKILL.md）。
    app.post(
      "/v1/skills/import",
      {
        schema: {
          tags: ["skills"],
          body: Type.Object({ sourceDirectory: Type.String({ minLength: 1, maxLength: 4_000 }) }),
          response: {
            200: SkillDto,
            400: SkillErrorDto,
            404: SkillErrorDto,
            409: SkillErrorDto,
          },
        },
      },
      async (request, reply) => {
        let skill: SkillView;
        try {
          skill = service.importUserSkill(request.body.sourceDirectory);
        } catch (error) {
          if (error instanceof SkillInputError) {
            return reply.code(INPUT_ERROR_STATUS[error.code]).send(inputErrorPayload(error));
          }
          throw error;
        }
        await hooks.onCatalogChanged("imported", skill.id).catch((error: unknown) => {
          app.log.error({
            event: "skills.apply_failed",
            skillId: skill.id,
            error: error instanceof Error ? error.message : String(error),
          }, "skill imported but runtime reload failed");
        });
        return skill;
      },
    );

    app.delete(
      "/v1/skills/:skillId",
      {
        schema: {
          tags: ["skills"],
          params: Type.Object({ skillId: Type.String({ minLength: 1, maxLength: 300 }) }),
          response: {
            200: Type.Object({ removed: Type.Boolean(), id: Type.String() }),
            400: SkillErrorDto,
            404: SkillErrorDto,
            409: SkillErrorDto,
          },
        },
      },
      async (request, reply) => {
        const skillId = request.params.skillId;
        try {
          service.removeSkill(skillId);
        } catch (error) {
          if (error instanceof SkillNotFoundError) {
            return reply.code(404).send({ error: "skill_not_found" });
          }
          if (error instanceof SkillInputError) {
            return reply.code(INPUT_ERROR_STATUS[error.code]).send(inputErrorPayload(error));
          }
          throw error;
        }
        // 目录已经删掉：运行时必须重装，否则被删技能还留在系统提示词里。
        await hooks.onCatalogChanged("removed", skillId).catch((error: unknown) => {
          app.log.error({
            event: "skills.apply_failed",
            skillId,
            error: error instanceof Error ? error.message : String(error),
          }, "skill removed but runtime reload failed");
        });
        return { removed: true, id: skillId };
      },
    );

    app.patch(
      "/v1/skills/:skillId",
      {
        schema: {
          tags: ["skills"],
          params: Type.Object({ skillId: Type.String({ minLength: 1, maxLength: 300 }) }),
          body: Type.Object({ enabled: Type.Boolean() }),
          response: {
            200: SkillDto,
            404: SkillErrorDto,
          },
        },
      },
      async (request, reply) => {
        let skill: SkillView;
        try {
          skill = service.setEnabled(request.params.skillId, request.body.enabled);
        } catch (error) {
          if (error instanceof SkillNotFoundError) {
            return reply.code(404).send({ error: "skill_not_found" });
          }
          throw error;
        }
        // 状态已经落库：即使运行时重装失败也不回滚（下一次任何重载都会带上它），
        // 但必须留日志，否则用户只会看到「开关没生效」。
        await hooks.onStateChanged(skill.id, skill.enabled).catch((error: unknown) => {
          app.log.error({
            event: "skills.apply_failed",
            skillId: skill.id,
            error: error instanceof Error ? error.message : String(error),
          }, "skill state applied to storage but runtime reload failed");
        });
        return skill;
      },
    );
  };
}
