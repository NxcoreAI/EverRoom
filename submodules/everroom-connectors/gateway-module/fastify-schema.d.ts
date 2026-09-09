/**
 * FastifySchema 增量（submodule 自包含化）。
 *
 * 宿主路由里的 `tags: ["cli-connectors"]` 等开放 API 元字段由
 * @fastify/swagger 的模块增强注入宿主的 FastifySchema；模块独立
 * typecheck 时没有该依赖，这里声明等价的字段增量（字段名与
 * @fastify/swagger 的增强一致），避免为类型引入 swagger 依赖。
 */
import "fastify";

declare module "fastify" {
  interface FastifySchema {
    summary?: string;
    description?: string;
    operationId?: string;
    tags?: readonly string[];
    consumes?: readonly string[];
    produces?: readonly string[];
    security?: ReadonlyArray<Record<string, readonly string[]>>;
    externalDocs?: { url: string; description?: string };
    deprecated?: boolean;
  }
}
