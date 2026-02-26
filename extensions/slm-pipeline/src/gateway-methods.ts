import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as z from "zod";
import type { PipelineAppService } from "./app-service.js";
import type { ReviewActionActor } from "./types.js";

const tenantParam = z.string().trim().min(1);
const keyField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/i, "must use a slug-like key");
const qaStatusSchema = z.enum(["draft", "validated", "archived"]);
const qaOriginSchema = z.enum(["manual", "studio", "import"]);

const categoryListSchema = z.object({
  tenant_id: tenantParam,
  provider_key: keyField.optional(),
  channel_key: keyField.optional(),
  include_inactive: z.boolean().optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

const categoryCreateSchema = z.object({
  tenant_id: tenantParam,
  provider_key: keyField,
  channel_key: keyField,
  category_key: keyField,
  display_name: z.string().trim().min(1).max(128),
  sort_order: z.number().int().min(0).max(100_000).optional(),
});

const categoryUpdateSchema = z
  .object({
    tenant_id: tenantParam,
    category_id: z.string().uuid(),
    display_name: z.string().trim().min(1).max(128).optional(),
    is_active: z.boolean().optional(),
    sort_order: z.number().int().min(0).max(100_000).optional(),
  })
  .refine(
    (body) =>
      body.display_name !== undefined || body.is_active !== undefined || body.sort_order !== undefined,
    "at least one category field must be provided",
  );

const qaListSchema = z.object({
  tenant_id: tenantParam,
  provider_key: keyField.optional(),
  channel_key: keyField.optional(),
  category_id: z.string().uuid().optional(),
  status: qaStatusSchema.optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  query: z.string().trim().min(1).max(4_000).optional(),
});

const qaGetSchema = z.object({
  tenant_id: tenantParam,
  projection_id: z.string().uuid(),
});

const qaCreateSchema = z.object({
  tenant_id: tenantParam,
  question: z.string().trim().min(1).max(4_000),
  answer: z.string().trim().min(1).max(12_000),
  provider_key: keyField,
  channel_key: keyField,
  category_id: z.string().uuid(),
  category_key: keyField.optional(),
  status: qaStatusSchema.optional(),
  origin: qaOriginSchema.optional(),
  source_channel: z.string().trim().min(1).max(200).optional(),
  source_ref: z.string().trim().min(1).max(512).optional(),
  trace_id: z.string().uuid().optional(),
  ref_id: z.string().trim().min(1).max(200).optional(),
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

const qaUpdateByIdSchema = z
  .object({
    tenant_id: tenantParam,
    projection_id: z.string().uuid(),
    question: z.string().trim().min(1).max(4_000).optional(),
    answer: z.string().trim().min(1).max(12_000).optional(),
    provider_key: keyField.optional(),
    channel_key: keyField.optional(),
    category_id: z.string().uuid().optional(),
    category_key: keyField.optional(),
    status: qaStatusSchema.optional(),
    origin: qaOriginSchema.optional(),
    source_channel: z.string().trim().min(1).max(200).optional(),
    source_ref: z.string().trim().min(1).max(512).optional(),
    trace_id: z.string().uuid().optional(),
    ref_id: z.string().trim().min(1).max(200).optional(),
  })
  .refine(
    (body) =>
      body.question !== undefined ||
      body.answer !== undefined ||
      body.provider_key !== undefined ||
      body.channel_key !== undefined ||
      body.category_id !== undefined ||
      body.category_key !== undefined ||
      body.status !== undefined ||
      body.origin !== undefined ||
      body.source_channel !== undefined ||
      body.source_ref !== undefined ||
      body.trace_id !== undefined ||
      body.ref_id !== undefined,
    "at least one QA field must be provided",
  );

const trainingEnqueueSchema = z.object({
  tenant_id: tenantParam,
  base_model: z.string().trim().min(1).max(256),
  source: z.enum(["zoom", "library"]).optional(),
  provider_key: keyField.optional(),
  channel_key: keyField.optional(),
  category_id: z.string().uuid().optional(),
  status: qaStatusSchema.optional(),
  split_seed: z.number().int().min(1).optional(),
  idempotency_key: z.string().trim().min(8).max(128).optional(),
});

export function registerSlmPipelineGatewayMethods(
  api: OpenClawPluginApi,
  app: PipelineAppService,
): void {
  api.registerGatewayMethod("slm.control.category.list", async ({ params, respond }) => {
    try {
      const payload = categoryListSchema.parse(params ?? {});
      const listed = await app.listCategories({
        tenantId: payload.tenant_id,
        providerKey: payload.provider_key,
        channelKey: payload.channel_key,
        includeInactive: payload.include_inactive,
        cursor: payload.cursor,
        limit: payload.limit,
      });
      respond(true, listed);
    } catch (error) {
      respond(false, undefined, toGatewayError(error));
    }
  });

  api.registerGatewayMethod("slm.control.category.create", async ({ params, respond }) => {
    try {
      const payload = categoryCreateSchema.parse(params ?? {});
      const record = await app.createCategory({
        tenantId: payload.tenant_id,
        providerKey: payload.provider_key,
        channelKey: payload.channel_key,
        categoryKey: payload.category_key,
        displayName: payload.display_name,
        sortOrder: payload.sort_order,
      });
      respond(true, { record });
    } catch (error) {
      respond(false, undefined, toGatewayError(error));
    }
  });

  api.registerGatewayMethod("slm.control.category.update", async ({ params, respond }) => {
    try {
      const payload = categoryUpdateSchema.parse(params ?? {});
      const record = await app.updateCategory({
        tenantId: payload.tenant_id,
        categoryId: payload.category_id,
        displayName: payload.display_name,
        isActive: payload.is_active,
        sortOrder: payload.sort_order,
      });
      if (!record) {
        respond(false, undefined, { code: "not_found", message: "category not found" });
        return;
      }
      respond(true, { record });
    } catch (error) {
      respond(false, undefined, toGatewayError(error));
    }
  });

  api.registerGatewayMethod("slm.control.qa.list", async ({ params, respond }) => {
    try {
      const payload = qaListSchema.parse(params ?? {});
      const listed = await app.listQa({
        tenantId: payload.tenant_id,
        providerKey: payload.provider_key,
        channelKey: payload.channel_key,
        categoryId: payload.category_id,
        status: payload.status,
        cursor: payload.cursor,
        limit: payload.limit,
        query: payload.query,
      });
      respond(true, listed);
    } catch (error) {
      respond(false, undefined, toGatewayError(error));
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
        respond(false, undefined, { code: "not_found", message: "qa record not found" });
        return;
      }
      respond(true, { record });
    } catch (error) {
      respond(false, undefined, toGatewayError(error));
    }
  });

  api.registerGatewayMethod("slm.control.qa.create", async ({ params, client, respond }) => {
    try {
      const payload = qaCreateSchema.parse(params ?? {});
      const actor = resolveGatewayActor(client?.connect);
      const record = await app.createQa({
        tenantId: payload.tenant_id,
        question: payload.question,
        answer: payload.answer,
        providerKey: payload.provider_key,
        channelKey: payload.channel_key,
        categoryId: payload.category_id,
        categoryKey: payload.category_key,
        status: payload.status,
        origin: payload.origin,
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
      respond(false, undefined, toGatewayError(error));
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
      respond(false, undefined, toGatewayError(error));
    }
  });

  api.registerGatewayMethod("slm.control.qa.updateById", async ({ params, client, respond }) => {
    try {
      const payload = qaUpdateByIdSchema.parse(params ?? {});
      const actor = resolveGatewayActor(client?.connect);
      const record = await app.updateQaById({
        tenantId: payload.tenant_id,
        projectionId: payload.projection_id,
        question: payload.question,
        answer: payload.answer,
        providerKey: payload.provider_key,
        channelKey: payload.channel_key,
        categoryId: payload.category_id,
        categoryKey: payload.category_key,
        status: payload.status,
        origin: payload.origin,
        sourceChannel: payload.source_channel,
        sourceRef: payload.source_ref,
        traceId: payload.trace_id,
        refId: payload.ref_id,
        actor,
        metadata: {
          source: "control_ui",
        },
      });
      if (!record) {
        respond(false, undefined, { code: "not_found", message: "qa record not found" });
        return;
      }
      respond(true, { record });
    } catch (error) {
      respond(false, undefined, toGatewayError(error));
    }
  });

  api.registerGatewayMethod("slm.control.training.enqueue", async ({ params, respond }) => {
    try {
      const payload = trainingEnqueueSchema.parse(params ?? {});
      const result = await app.enqueueTraining({
        tenantId: payload.tenant_id,
        baseModel: payload.base_model,
        source: payload.source,
        providerKey: payload.provider_key,
        channelKey: payload.channel_key,
        categoryId: payload.category_id,
        status: payload.status,
        splitSeed: payload.split_seed,
        idempotencyKey: payload.idempotency_key,
      });
      respond(true, result);
    } catch (error) {
      respond(false, undefined, toGatewayError(error));
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

function toGatewayError(error: unknown): { code: string; message: string } {
  if (error instanceof z.ZodError) {
    return {
      code: "invalid_request",
      message: formatError(error),
    };
  }
  const message = formatError(error);
  return {
    code: message.toLowerCase().includes("not found") ? "not_found" : "failed",
    message,
  };
}
