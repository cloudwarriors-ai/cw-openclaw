import { randomUUID } from "node:crypto";

import type { ApplyFeedbackRequest, EvalItem, FeedbackAction } from "./types.js";

export class FeedbackMergeService {
  apply(params: {
    request: ApplyFeedbackRequest;
    evalItems: Map<string, EvalItem>;
    now?: () => Date;
  }): FeedbackAction[] {
    const now = (params.now ?? (() => new Date()))().toISOString();
    const selected: EvalItem[] = [];

    for (const itemId of params.request.item_ids) {
      const item = params.evalItems.get(itemId);
      if (!item) {
        continue;
      }
      if (item.tenant_id !== params.request.tenant_id || item.run_id !== params.request.run_id) {
        continue;
      }
      if (!item.corrected_answer) {
        continue;
      }
      selected.push(item);
    }

    const maxAllowed = Math.floor(params.request.item_ids.length * params.request.max_ratio);
    if (maxAllowed <= 0) {
      return [];
    }
    const capped = selected.slice(0, maxAllowed);

    return capped.map((item) => ({
      feedback_id: randomUUID(),
      tenant_id: params.request.tenant_id,
      run_id: params.request.run_id,
      item_id: item.item_id,
      corrected_answer: item.corrected_answer ?? item.gold_answer,
      notes: item.reviewer_notes,
      applied_at: now,
    }));
  }
}
