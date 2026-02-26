import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as z from "zod";
import type { SlmSupervisorAppService } from "./app-service.js";
import type { ReviewActionActor } from "./types.js";

const tenantParam = z.string().trim().min(1);

const startSessionSchema = z.object({
  tenant_id: tenantParam,
  question: z.string().trim().min(1).max(4_000),
  trace_id: z.string().uuid().optional(),
  review_ref_id: z.string().trim().min(1).max(200).optional(),
});

const turnSchema = z.object({
  tenant_id: tenantParam,
  session_id: z.string().uuid(),
  user_prompt: z.string().trim().min(1).max(8_000),
  edited_answer: z.string().trim().max(12_000).optional(),
});

const finishSchema = z.object({
  tenant_id: tenantParam,
  session_id: z.string().uuid(),
});

export function registerSlmSupervisorGatewayMethods(
  api: OpenClawPluginApi,
  appService: SlmSupervisorAppService,
): void {
  api.registerGatewayMethod("slm.control.session.start", async ({ params, client, respond }) => {
    try {
      const payload = startSessionSchema.parse(params ?? {});
      const actor = resolveGatewayActor(client?.connect);
      const session = await appService.startTrainingSession({
        tenantId: payload.tenant_id,
        question: payload.question,
        traceId: payload.trace_id,
        reviewRefId: payload.review_ref_id,
        actor,
      });
      respond(true, { session });
    } catch (error) {
      respond(false, { error: formatError(error) });
    }
  });

  api.registerGatewayMethod("slm.control.session.turn", async ({ params, client, respond }) => {
    try {
      const payload = turnSchema.parse(params ?? {});
      const actor = resolveGatewayActor(client?.connect);
      const result = await appService.runTrainingTurn({
        tenantId: payload.tenant_id,
        sessionId: payload.session_id,
        userPrompt: payload.user_prompt,
        editedAnswer: payload.edited_answer,
        actor,
      });
      respond(true, result);
    } catch (error) {
      respond(false, { error: formatError(error) });
    }
  });

  api.registerGatewayMethod("slm.control.session.finish", async ({ params, client, respond }) => {
    try {
      const payload = finishSchema.parse(params ?? {});
      const actor = resolveGatewayActor(client?.connect);
      const session = await appService.finishTrainingSession({
        tenantId: payload.tenant_id,
        sessionId: payload.session_id,
        actor,
      });
      respond(true, { session });
    } catch (error) {
      respond(false, { error: formatError(error) });
    }
  });
}

function resolveGatewayActor(connect: unknown): ReviewActionActor | undefined {
  if (!connect || typeof connect !== "object" || Array.isArray(connect)) {
    return undefined;
  }
  const value = connect as Record<string, unknown>;
  const actorId = asString(value.instanceId) ?? asString(value.deviceId) ?? "operator";
  const role = asString(value.role);
  return {
    actor_id: actorId,
    actor_name: asString(value.clientName),
    actor_role: role === "reviewer" ? "reviewer" : role === "system" ? "system" : "operator",
  };
}

function asString(input: unknown): string | undefined {
  return typeof input === "string" && input.trim().length > 0 ? input.trim() : undefined;
}

function formatError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}
