import * as z from "zod";
import { SlmSupervisorAppService } from "./app-service.js";
import { SlmSupervisorOrchestrator } from "./orchestrator.js";

const supervisorRequestSchema = z.object({
  tenant_id: z.string().trim().min(1),
  channel_id: z.string().trim().min(1),
  user_message: z.string().trim().min(1),
  context_refs: z.array(z.string().trim().min(1)).default([]),
});

const supervisorFeedbackSchema = z.object({
  tenant_id: z.string().trim().min(1),
  trace_id: z.string().uuid(),
  feedback_type: z.enum(["thumbs_up", "thumbs_down"]),
  comment: z.string().trim().min(1).max(2_000).optional(),
});

export type SlmSupervisorRequest = {
  method: string;
  path: string;
  headers?: Record<string, string | undefined>;
  query?: URLSearchParams;
  body?: unknown;
};

export type SlmSupervisorResponse = {
  status: number;
  body: unknown;
};

export function createSlmSupervisorRouter(params?: {
  appService?: SlmSupervisorAppService;
  orchestrator?: SlmSupervisorOrchestrator;
}): {
  handle: (request: SlmSupervisorRequest) => Promise<SlmSupervisorResponse>;
  appService: SlmSupervisorAppService;
  orchestrator: SlmSupervisorOrchestrator;
} {
  const orchestrator = params?.orchestrator ?? new SlmSupervisorOrchestrator();
  const appService = params?.appService ?? new SlmSupervisorAppService(orchestrator);

  return {
    appService,
    orchestrator,
    async handle(request) {
      try {
        const method = request.method.toUpperCase();
        const query = request.query ?? new URL(request.path, "http://localhost").searchParams;
        const path = normalizePath(request.path);

        const tenantId = requireTenantId(request.headers?.authorization);
        if (method === "GET" && path === "/v1/slm/supervisor/traces") {
          const queryTenantId = query.get("tenant_id") ?? "";
          if (queryTenantId !== tenantId) {
            return {
              status: 403,
              body: {
                ok: false,
                error: {
                  code: "tenant_mismatch",
                  message: "tenant_id does not match auth context",
                },
              },
            };
          }
          const limitRaw = query.get("limit") ?? "50";
          const limit = Number.parseInt(limitRaw, 10);
          const traces = appService.listTraces({ tenantId, limit });
          return {
            status: 200,
            body: {
              ok: true,
              traces,
            },
          };
        }

        if (method === "POST" && path === "/v1/slm/supervisor/respond") {
          const payload = supervisorRequestSchema.parse(request.body ?? {});
          if (payload.tenant_id !== tenantId) {
            return {
              status: 403,
              body: {
                ok: false,
                error: {
                  code: "tenant_mismatch",
                  message: "tenant_id does not match auth context",
                },
              },
            };
          }

          const result = await appService.respond(payload);
          return {
            status: 200,
            body: {
              ok: true,
              ...result,
            },
          };
        }

        if (method === "POST" && path === "/v1/slm/supervisor/feedback") {
          const payload = supervisorFeedbackSchema.parse(request.body ?? {});
          if (payload.tenant_id !== tenantId) {
            return {
              status: 403,
              body: {
                ok: false,
                error: {
                  code: "tenant_mismatch",
                  message: "tenant_id does not match auth context",
                },
              },
            };
          }

          const feedback = appService.recordFeedback({
            tenantId,
            traceId: payload.trace_id,
            feedbackType: payload.feedback_type,
            comment: payload.comment,
          });
          if (!feedback) {
            return {
              status: 404,
              body: {
                ok: false,
                error: {
                  code: "trace_not_found",
                  message: "trace_id not found for tenant",
                },
              },
            };
          }

          return {
            status: 200,
            body: {
              ok: true,
              feedback_id: feedback.feedback_id,
              trace_id: feedback.trace_id,
            },
          };
        }

        return {
          status: 404,
          body: { ok: false, error: { code: "not_found", message: "route not found" } },
        };
      } catch (err) {
        if (err instanceof z.ZodError) {
          return {
            status: 400,
            body: {
              ok: false,
              error: {
                code: "validation_error",
                message: err.issues.map(
                  (issue) => `${issue.path.join(".") || "body"}: ${issue.message}`,
                ),
              },
            },
          };
        }

        if (err instanceof Error && err.message.startsWith("unauthorized")) {
          return {
            status: 401,
            body: {
              ok: false,
              error: {
                code: "unauthorized",
                message: err.message,
              },
            },
          };
        }

        return {
          status: 500,
          body: {
            ok: false,
            error: {
              code: "internal_error",
              message: String(err),
            },
          },
        };
      }
    },
  };
}

function normalizePath(pathname: string): string {
  const parsed = new URL(pathname, "http://localhost");
  return parsed.pathname.replace(/\/+$/, "") || "/";
}

function requireTenantId(authorization: string | undefined): string {
  const token = (authorization ?? "").trim();
  const match = /^Bearer\s+tenant:([a-zA-Z0-9_.-]+)$/i.exec(token);
  if (!match?.[1]) {
    throw new Error("unauthorized: expected Bearer tenant:<tenant_id> token");
  }
  return match[1];
}
