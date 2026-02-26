import type { PrimaryAnswer, SupervisorVerdict } from "./types.js";

export type SupervisorService = {
  review: (params: {
    tenantId: string;
    userMessage: string;
    primary: PrimaryAnswer;
  }) => Promise<SupervisorVerdict>;
  directFallback: (params: {
    tenantId: string;
    userMessage: string;
  }) => Promise<string>;
};

export class StubSupervisorService implements SupervisorService {
  async review(params: {
    tenantId: string;
    userMessage: string;
    primary: PrimaryAnswer;
  }): Promise<SupervisorVerdict> {
    const lower = params.userMessage.toLowerCase();
    if (lower.includes("policy") || lower.includes("forbidden")) {
      return {
        action: "reject",
        reason_codes: ["policy_safety_reject"],
        policy_flags: ["policy_sensitive"],
        confidence: 0.9,
      };
    }

    if (params.primary.slm_confidence < 0.75 || params.primary.grounding_score < 0.8) {
      return {
        action: "edit",
        edited_answer_text: `${params.primary.answer_text} (supervisor edited for clarity)`,
        reason_codes: ["quality_improvement"],
        policy_flags: [],
        confidence: 0.8,
      };
    }

    return {
      action: "approve",
      reason_codes: [],
      policy_flags: [],
      confidence: 0.85,
    };
  }

  async directFallback(params: { tenantId: string; userMessage: string }): Promise<string> {
    return `Fallback answer: ${params.userMessage}`;
  }
}
