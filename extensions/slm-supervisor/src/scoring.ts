export type ScoringInput = {
  answerText: string;
  citations: string[];
  modelConfidence: number;
  groundingSignal: number;
};

export type ScoringOutput = {
  confidence: number;
  grounding: number;
  reasonCodes: string[];
  policyFlags: string[];
};

export class ConfidenceAndGroundingScorer {
  score(input: ScoringInput): ScoringOutput {
    const reasonCodes: string[] = [];
    const policyFlags: string[] = [];

    const citationPenalty = input.citations.length > 0 ? 0 : 0.2;
    const shortAnswerPenalty = input.answerText.trim().length < 20 ? 0.1 : 0;

    const confidence = clamp(input.modelConfidence - shortAnswerPenalty, 0, 1);
    const grounding = clamp(input.groundingSignal - citationPenalty, 0, 1);

    if (input.citations.length === 0) {
      reasonCodes.push("missing_citations");
      policyFlags.push("needs_grounding");
    }
    if (confidence < 0.5) {
      reasonCodes.push("low_confidence");
    }
    if (grounding < 0.5) {
      reasonCodes.push("low_grounding");
    }

    return {
      confidence,
      grounding,
      reasonCodes,
      policyFlags,
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
