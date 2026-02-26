import type { z } from "zod";
import type {
  applyFeedbackSchema,
  buildDatasetSchema,
  importQaSchema,
  startTrainingRunSchema,
  submitReviewSchema,
} from "./schemas.js";

export type TrainingRunStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
export type EvalReviewState = "pending" | "in_review" | "completed" | "discarded";
export type QaRecordStatus = "draft" | "validated" | "archived";
export type QaRecordOrigin = "manual" | "studio" | "import";

export type ApprovedQaRecord = {
  example_id: string;
  tenant_id: string;
  source_channel: string;
  provider_key?: string;
  channel_key?: string;
  category_id?: string;
  category_key?: string;
  status?: QaRecordStatus;
  origin?: QaRecordOrigin;
  source_message_ids: string[];
  question: string;
  answer: string;
  citations: string[];
  approved_by: string;
  approved_at: string;
};

export type DatasetExample = {
  example_id: string;
  tenant_id: string;
  input: string;
  target: string;
  provider_key?: string;
  channel_key?: string;
  category_id?: string;
  category_key?: string;
  status?: QaRecordStatus;
  origin?: QaRecordOrigin;
  citations: string[];
  source_ids: string[];
};

export type DatasetArtifact = {
  dataset_id: string;
  tenant_id: string;
  split_seed: number;
  manifest_hash: string;
  train: DatasetExample[];
  eval: DatasetExample[];
  created_at: string;
};

export type TrainingRun = {
  run_id: string;
  tenant_id: string;
  dataset_id: string;
  adapter_path?: string;
  status: TrainingRunStatus;
  started_at: string;
  ended_at?: string;
  error_message?: string;
};

export type EvalItem = {
  item_id: string;
  run_id: string;
  tenant_id: string;
  prompt: string;
  model_answer: string;
  gold_answer: string;
  citations: string[];
  scores?: {
    accuracy: number;
    grounding: number;
    actionability: number;
  };
  review_state: EvalReviewState;
  reviewer_notes?: string;
  corrected_answer?: string;
};

export type FeedbackAction = {
  feedback_id: string;
  tenant_id: string;
  run_id: string;
  item_id: string;
  corrected_answer: string;
  notes?: string;
  applied_at: string;
};

export type ReviewActionActor = {
  actor_id: string;
  actor_name?: string;
  actor_role: "operator" | "reviewer" | "system";
};

export type QaProjectionRecord = {
  projection_id: string;
  tenant_id: string;
  question: string;
  answer: string;
  provider_key?: string;
  channel_key?: string;
  category_id?: string;
  category_key?: string;
  status: QaRecordStatus;
  origin: QaRecordOrigin;
  source_channel?: string;
  source_ref?: string;
  trace_id?: string;
  ref_id?: string;
  actor?: ReviewActionActor;
  approved_at: string;
  updated_at: string;
};

export type QaCategoryRecord = {
  category_id: string;
  tenant_id: string;
  provider_key: string;
  channel_key: string;
  category_key: string;
  display_name: string;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type TrainingSessionStatus = "active" | "finished" | "expired";

export type TrainingSessionRecord = {
  session_id: string;
  tenant_id: string;
  status: TrainingSessionStatus;
  question: string;
  review_ref_id?: string;
  trace_id?: string;
  created_at: string;
  updated_at: string;
  finished_at?: string;
  actor?: ReviewActionActor;
};

export type TrainingSessionTurnRecord = {
  turn_id: string;
  session_id: string;
  tenant_id: string;
  user_prompt: string;
  model_answer: string;
  edited_answer?: string;
  created_at: string;
  actor?: ReviewActionActor;
};

export type ImportQaRequest = z.infer<typeof importQaSchema>;
export type BuildDatasetRequest = z.infer<typeof buildDatasetSchema>;
export type StartTrainingRunRequest = z.infer<typeof startTrainingRunSchema>;
export type SubmitReviewRequest = z.infer<typeof submitReviewSchema>;
export type ApplyFeedbackRequest = z.infer<typeof applyFeedbackSchema>;

export type SlmPipelineState = {
  approvedQa: ApprovedQaRecord[];
  datasets: Map<string, DatasetArtifact>;
  runs: Map<string, TrainingRun>;
  evalItems: Map<string, EvalItem>;
  feedbackActions: FeedbackAction[];
  idempotency: Set<string>;
};
