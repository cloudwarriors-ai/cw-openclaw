import * as z from "zod";

const metadataValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const metadataSchema = z.record(z.string(), metadataValueSchema);
const nonEmptyString = z.string().trim().min(1);
const datetimeSchema = z.string().datetime({ offset: true });

export const memoryCreateSchema = z.object({
  namespace: nonEmptyString.max(128),
  kind: nonEmptyString.max(64),
  content: nonEmptyString.max(16_000),
  metadata: metadataSchema.optional(),
  source_ref: z.string().trim().max(512).optional(),
});

export const memoryUpsertSchema = memoryCreateSchema.extend({
  id: z.uuid(),
});

export const memoryRecordSchema = memoryCreateSchema.extend({
  id: z.uuid(),
  tenant_id: nonEmptyString.max(128),
  created_at: datetimeSchema,
  updated_at: datetimeSchema,
  deleted_at: datetimeSchema.optional(),
});

export const bulkCreateSchema = z.object({
  records: z.array(memoryCreateSchema).min(1).max(500),
});

export const searchRequestSchema = z.object({
  query_text: nonEmptyString.max(2_000),
  namespace: z.string().trim().max(128).optional(),
  metadata_filters: metadataSchema.optional(),
  embedding_model: z.string().trim().min(1).max(256).optional(),
  embedding_version: z.string().trim().min(1).max(64).optional(),
  include_deleted: z.boolean().default(false),
  top_k: z.number().int().min(1).max(50).default(5),
  min_score: z.number().min(0).max(1).default(0),
});

export const listSortBySchema = z.enum(["created_at", "updated_at"]);
export const listSortOrderSchema = z.enum(["asc", "desc"]);

export const listRequestSchema = z.object({
  namespace: z.string().trim().max(128).optional(),
  kind: z.string().trim().max(64).optional(),
  metadata_filters: metadataSchema.optional(),
  include_deleted: z.boolean().default(false),
  cursor: z.string().trim().min(1).max(2_048).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  sort_by: listSortBySchema.default("created_at"),
  sort_order: listSortOrderSchema.default("desc"),
});

export const timelineRequestSchema = z.object({
  namespace: z.string().trim().max(128).optional(),
  kind: z.string().trim().max(64).optional(),
  from: datetimeSchema.optional(),
  to: datetimeSchema.optional(),
  include_deleted: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(100),
});

export const bearerTokenSchema = z
  .string()
  .trim()
  .regex(/^Bearer\s+\S+$/i, "authorization header must use Bearer token");

export type MemoryCreateInput = z.infer<typeof memoryCreateSchema>;
export type MemoryUpsertInput = z.infer<typeof memoryUpsertSchema>;
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type BulkCreateRequest = z.infer<typeof bulkCreateSchema>;
export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type ListRequest = z.infer<typeof listRequestSchema>;
export type TimelineRequest = z.infer<typeof timelineRequestSchema>;
