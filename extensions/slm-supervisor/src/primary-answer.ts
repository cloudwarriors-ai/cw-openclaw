import type { PrimaryAnswer } from "./types.js";

export type PrimaryAnswerService = {
  answer: (params: {
    tenantId: string;
    channelId: string;
    userMessage: string;
    contextRefs: string[];
  }) => Promise<PrimaryAnswer>;
};

export class StubPrimaryAnswerService implements PrimaryAnswerService {
  async answer(params: {
    tenantId: string;
    channelId: string;
    userMessage: string;
    contextRefs: string[];
  }): Promise<PrimaryAnswer> {
    const text = params.userMessage.trim();
    if (!text) {
      return {
        answer_text: "",
        citations: [],
        slm_confidence: 0,
        grounding_score: 0,
        latency_ms: 50,
      };
    }

    return {
      answer_text: `SLM answer: ${text}`,
      citations: params.contextRefs,
      slm_confidence: 0.82,
      grounding_score: params.contextRefs.length > 0 ? 0.88 : 0.55,
      latency_ms: 120,
    };
  }
}
