import type { SupervisorPolicyConfig } from "./config.js";

export type EscalationDecision = {
  escalate: boolean;
  fallbackDirect: boolean;
  reasonCodes: string[];
};

export class EscalationPolicyEngine {
  constructor(private readonly config: SupervisorPolicyConfig) {}

  decide(params: {
    hasPrimaryAnswer: boolean;
    confidence: number;
    grounding: number;
    policyFlags: string[];
  }): EscalationDecision {
    const reasonCodes: string[] = [];

    if (!params.hasPrimaryAnswer) {
      reasonCodes.push("slm_empty_response");
      return { escalate: false, fallbackDirect: true, reasonCodes };
    }

    if (params.confidence < this.config.minConfidence) {
      reasonCodes.push("confidence_below_threshold");
    }
    if (params.grounding < this.config.minGrounding) {
      reasonCodes.push("grounding_below_threshold");
    }
    if (params.policyFlags.length > 0) {
      reasonCodes.push("policy_flags_present");
    }

    if (reasonCodes.length === 0) {
      return {
        escalate: false,
        fallbackDirect: false,
        reasonCodes,
      };
    }

    return {
      escalate: true,
      fallbackDirect: false,
      reasonCodes,
    };
  }
}
