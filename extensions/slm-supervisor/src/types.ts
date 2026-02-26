export type ResponsePath = "slm_only" | "slm_plus_supervisor" | "frontier_direct_fallback";

export type SupervisorAction = "approve" | "edit" | "reject" | "insufficient_evidence";
export type SupervisorFeedbackType = "thumbs_up" | "thumbs_down";

export type ReviewActionActor = {
  actor_id: string;
  actor_name?: string;
  actor_role: "operator" | "reviewer" | "system";
};

export type SupervisorRequest = {
  tenant_id: string;
  channel_id: string;
  user_message: string;
  context_refs: string[];
};

export type PrimaryAnswer = {
  answer_text: string;
  citations: string[];
  slm_confidence: number;
  grounding_score: number;
  latency_ms: number;
};

export type SupervisorVerdict = {
  action: SupervisorAction;
  edited_answer_text?: string;
  reason_codes: string[];
  policy_flags: string[];
  confidence: number;
};

export type SupervisorResponse = {
  final_answer: string;
  source_path: ResponsePath;
  trace_id: string;
  reason_codes: string[];
  policy_flags: string[];
};

export type DecisionTrace = {
  trace_id: string;
  tenant_id: string;
  channel_id: string;
  user_message: string;
  source_path: ResponsePath;
  reason_codes: string[];
  policy_flags: string[];
  slm_confidence: number;
  grounding_score: number;
  created_at: string;
};

export type SupervisorFeedback = {
  feedback_id: string;
  tenant_id: string;
  trace_id: string;
  feedback_type: SupervisorFeedbackType;
  comment?: string;
  created_at: string;
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
