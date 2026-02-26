import { SlmPipelineError } from "./errors.js";

import type { EvalItem, SubmitReviewRequest } from "./types.js";

export class HumanEvalService {
  getQueue(params: {
    tenantId: string;
    evalItems: Map<string, EvalItem>;
    limit: number;
  }): EvalItem[] {
    return [...params.evalItems.values()]
      .filter((item) => item.tenant_id === params.tenantId)
      .filter((item) => item.review_state === "pending" || item.review_state === "in_review")
      .slice(0, params.limit);
  }

  submitReview(params: {
    evalItems: Map<string, EvalItem>;
    itemId: string;
    tenantId: string;
    request: SubmitReviewRequest;
  }): EvalItem {
    const current = params.evalItems.get(params.itemId);
    if (!current || current.tenant_id !== params.tenantId) {
      throw new SlmPipelineError(404, "not_found", "eval item not found");
    }

    const updated: EvalItem = {
      ...current,
      corrected_answer: params.request.corrected_answer,
      reviewer_notes: params.request.notes,
      review_state: "completed",
      scores: {
        accuracy: params.request.score_accuracy,
        grounding: params.request.score_grounding,
        actionability: params.request.score_actionability,
      },
    };

    params.evalItems.set(updated.item_id, updated);
    return updated;
  }
}
