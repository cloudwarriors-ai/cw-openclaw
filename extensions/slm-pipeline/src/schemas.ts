import * as z from "zod";

const nonEmpty = z.string().trim().min(1);
const keyField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/i, "must use a slug-like key");
const qaStatusSchema = z.enum(["draft", "validated", "archived"]);
const qaOriginSchema = z.enum(["manual", "studio", "import"]);
const optionalUuid = z.uuid().optional();

export const importQaSchema = z.object({
  tenant_id: nonEmpty,
  source: z.enum(["zoom", "library"]),
  provider_key: keyField.optional(),
  channel_key: keyField.optional(),
  category_id: optionalUuid,
  status: qaStatusSchema.optional(),
  idempotency_key: z.string().trim().min(8),
});

export const categoryListSchema = z.object({
  tenant_id: nonEmpty,
  provider_key: keyField.optional(),
  channel_key: keyField.optional(),
  include_inactive: z.boolean().default(false),
  cursor: z.string().trim().min(1).max(2_048).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const categoryCreateSchema = z.object({
  tenant_id: nonEmpty,
  provider_key: keyField,
  channel_key: keyField,
  category_key: keyField,
  display_name: z.string().trim().min(1).max(128),
  sort_order: z.number().int().min(0).max(100_000).default(1000),
});

export const categoryUpdateSchema = z
  .object({
    tenant_id: nonEmpty,
    display_name: z.string().trim().min(1).max(128).optional(),
    is_active: z.boolean().optional(),
    sort_order: z.number().int().min(0).max(100_000).optional(),
  })
  .refine(
    (body) =>
      body.display_name !== undefined || body.is_active !== undefined || body.sort_order !== undefined,
    "at least one category field must be provided",
  );

export const qaCreateSchema = z.object({
  tenant_id: nonEmpty,
  question: z.string().trim().min(1).max(4_000),
  answer: z.string().trim().min(1).max(12_000),
  provider_key: keyField,
  channel_key: keyField,
  category_id: z.uuid(),
  category_key: keyField.optional(),
  status: qaStatusSchema.default("draft"),
  origin: qaOriginSchema.default("manual"),
  source_channel: z.string().trim().min(1).max(200).optional(),
  source_ref: z.string().trim().min(1).max(512).optional(),
  trace_id: z.string().uuid().optional(),
  ref_id: z.string().trim().min(1).max(200).optional(),
});

export const qaUpdateByIdSchema = z
  .object({
    tenant_id: nonEmpty,
    projection_id: z.uuid(),
    question: z.string().trim().min(1).max(4_000).optional(),
    answer: z.string().trim().min(1).max(12_000).optional(),
    provider_key: keyField.optional(),
    channel_key: keyField.optional(),
    category_id: z.uuid().optional(),
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

export const qaListSchema = z.object({
  tenant_id: nonEmpty,
  provider_key: keyField.optional(),
  channel_key: keyField.optional(),
  category_id: z.uuid().optional(),
  status: qaStatusSchema.optional(),
  cursor: z.string().trim().min(1).max(2_048).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  query: z.string().trim().min(1).max(4_000).optional(),
});

export const qaGetSchema = z.object({
  tenant_id: nonEmpty,
  projection_id: z.uuid(),
});

export const buildDatasetSchema = z.object({
  tenant_id: nonEmpty,
  split_seed: z.number().int().positive(),
  idempotency_key: z.string().trim().min(8),
});

export const startTrainingRunSchema = z.object({
  tenant_id: nonEmpty,
  dataset_id: z.uuid(),
  base_model: nonEmpty,
  idempotency_key: z.string().trim().min(8),
});

export const submitReviewSchema = z.object({
  score_accuracy: z.number().min(0).max(1),
  score_grounding: z.number().min(0).max(1),
  score_actionability: z.number().min(0).max(1),
  corrected_answer: nonEmpty,
  notes: z.string().trim().max(4_000).optional(),
});

export const applyFeedbackSchema = z.object({
  tenant_id: nonEmpty,
  run_id: z.uuid(),
  item_ids: z.array(z.uuid()).min(1),
  max_ratio: z.number().min(0.05).max(1).default(0.3),
  idempotency_key: z.string().trim().min(8),
});
