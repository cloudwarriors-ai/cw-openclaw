import * as z from "zod";

const nonEmpty = z.string().trim().min(1);

export const importQaSchema = z.object({
  tenant_id: nonEmpty,
  source: z.enum(["zoom"]),
  idempotency_key: z.string().trim().min(8),
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
