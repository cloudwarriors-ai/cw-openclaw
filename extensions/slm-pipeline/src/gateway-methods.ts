import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as z from "zod";
import type { PipelineAppService } from "./app-service.js";
import type { ReviewActionActor } from "./types.js";

const tenantParam = z.string().trim().min(1);

const qaListSchema = z.object({
  tenant_id: tenantParam,
  cursor: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  query: z.string().trim().min(1).max(4_000).optional(),
});

const qaGetSchema = z.object({
  tenant_id: tenantParam,
  projection_id: z.string().uuid(),
});

const qaUpdateSchema = z.object({
  tenant_id: tenantParam,
  question: z.string().trim().min(1).max(4_000),
  answer: z.string().trim().min(1).max(12_000),
  source_channel: z.string().trim().min(1).max(200).optional(),
  source_ref: z.string().trim().min(1).max(512).optional(),
  trace_id: z.string().uuid().optional(),
  ref_id: z.string().trim().min(1).max(200).optional(),
});

const trainingEnqueueSchema = z.object({
  tenant_id: tenantParam,
  base_model: z.string().trim().min(1).max(256),
  split_seed: z.number().int().min(1).optional(),
  idempotency_key: z.string().trim().min(8).max(128).optional(),
});

export function registerSlmPipelineGatewayMethods(
  api: OpenClawPluginApi,
  app: PipelineAppService,
): void {
  api.registerGatewayMethod("slm.control.qa.list", async ({ params, respond }) => {
    try {
      const payload = qaListSchema.parse(params ?? {});
      const listed = await app.listQa({
        tenantId: payload.tenant_id,
        cursor: payload.cursor,
        limit: payload.limit,
        query: payload.query,
      });
      respond(true, listed);
    } catch (error) {
      respond(false, { error: formatError(error) });
    }
  });

  api.registerGatewayMethod("slm.control.qa.get", async ({ params, respond }) => {
    try {
      const payload = qaGetSchema.parse(params ?? {});
      const record = await app.getQa({
        tenantId: payload.tenant_id,
        projectionId: payload.projection_id,
      });
      if (!record) {
        respond(false, { error: "qa record not found" });
        return;
      }
      respond(true, { record });
    } catch (error) {
      respond(false, { error: formatError(error) });
    }
  });

  api.registerGatewayMethod("slm.control.qa.update", async ({ params, client, respond }) => {
    try {
      const payload = qaUpdateSchema.parse(params ?? {});
      const actor = resolveGatewayActor(client?.connect);
      const record = await app.updateQa({
        tenantId: payload.tenant_id,
        question: payload.question,
        answer: payload.answer,
        sourceChannel: payload.source_channel,
        sourceRef: payload.source_ref,
        traceId: payload.trace_id,
        refId: payload.ref_id,
        actor,
        metadata: {
          source: "control_ui",
        },
      });
      respond(true, { record });
    } catch (error) {
      respond(false, { error: formatError(error) });
    }
  });

  api.registerGatewayMethod("slm.control.training.enqueue", async ({ params, respond }) => {
    try {
      const payload = trainingEnqueueSchema.parse(params ?? {});
      const result = await app.enqueueTraining({
        tenantId: payload.tenant_id,
        baseModel: payload.base_model,
        splitSeed: payload.split_seed,
        idempotencyKey: payload.idempotency_key,
      });
      respond(true, result);
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
