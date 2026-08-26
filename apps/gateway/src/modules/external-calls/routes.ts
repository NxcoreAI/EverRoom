import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  EXTERNAL_CALL_ENFORCEMENTS,
  EXTERNAL_CALL_PERIODS,
  EXTERNAL_CALL_SCOPES,
  EXTERNAL_CALL_SERVICES,
  type ExternalCallBudgetService,
} from "./service.js";

const Scope = Type.Union(EXTERNAL_CALL_SCOPES.map((value) => Type.Literal(value)));
const Service = Type.Union(EXTERNAL_CALL_SERVICES.map((value) => Type.Literal(value)));
const Period = Type.Union(EXTERNAL_CALL_PERIODS.map((value) => Type.Literal(value)));
const Enforcement = Type.Union(EXTERNAL_CALL_ENFORCEMENTS.map((value) => Type.Literal(value)));
const Page = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});
const Filters = Type.Intersect([Page, Type.Object({
  subjectScope: Type.Optional(Scope),
  subjectId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  service: Type.Optional(Service),
})]);
const TimeFilters = Type.Intersect([Filters, Type.Object({
  from: Type.Optional(Type.String({ format: "date-time" })),
  to: Type.Optional(Type.String({ format: "date-time" })),
})]);
const PolicyBody = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  subjectScope: Scope,
  subjectId: Type.String({ minLength: 1, maxLength: 200 }),
  service: Service,
  period: Period,
  limit: Type.Integer({ minimum: 0 }),
  warningThreshold: Type.Integer({ minimum: 0 }),
  enforcement: Enforcement,
});

export function externalCallRoutes(service: ExternalCallBudgetService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/v1/external-calls/policies", { schema: { tags: ["external-calls"], querystring: Filters } },
      async (request) => service.listPolicies(request.query));
    app.put("/v1/external-calls/policies", { schema: { tags: ["external-calls"], body: PolicyBody } },
      async (request) => service.upsertPolicy(request.body));
    app.delete("/v1/external-calls/policies/:id", {
      schema: { tags: ["external-calls"], params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) }) },
    }, async (request, reply) => service.deletePolicy(request.params.id)
      ? reply.code(204).send()
      : reply.code(404).send({ error: "external_call_policy_not_found" }));
    app.get("/v1/external-calls/usage", { schema: { tags: ["external-calls"], querystring: TimeFilters } },
      async (request) => {
        const { from, to, ...filters } = request.query;
        return service.listUsage({
          ...filters,
          ...(from ? { from: new Date(from) } : {}),
          ...(to ? { to: new Date(to) } : {}),
        });
      });
    app.get("/v1/external-calls/audits", { schema: { tags: ["external-calls"], querystring: TimeFilters } },
      async (request) => {
        const { from, to, ...filters } = request.query;
        return service.listAudits({
          ...filters,
          ...(from ? { from: new Date(from) } : {}),
          ...(to ? { to: new Date(to) } : {}),
        });
      });
  };
}
