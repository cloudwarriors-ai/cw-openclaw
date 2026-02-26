import { randomUUID } from "node:crypto";
import type { SupervisorPolicyConfig } from "./config.js";
import type { PrimaryAnswerService } from "./primary-answer.js";
import type { SupervisorService } from "./supervisor.js";
import type {
  DecisionTrace,
  SupervisorFeedback,
  SupervisorFeedbackType,
  SupervisorRequest,
  SupervisorResponse,
} from "./types.js";
import { defaultSupervisorPolicy } from "./config.js";
import { EscalationPolicyEngine } from "./policy.js";
import { StubPrimaryAnswerService } from "./primary-answer.js";
import { ConfidenceAndGroundingScorer } from "./scoring.js";
import { StubSupervisorService } from "./supervisor.js";
import { NoopTraceExporter, type TraceExporter } from "./trace-exporter.js";
import { InMemoryTraceStore } from "./trace-store.js";

export class SlmSupervisorOrchestrator {
  private readonly scorer: ConfidenceAndGroundingScorer;
  private readonly policyEngine: EscalationPolicyEngine;
  private readonly traceStore: InMemoryTraceStore;

  constructor(
    private readonly primaryService: PrimaryAnswerService = new StubPrimaryAnswerService(),
    private readonly supervisorService: SupervisorService = new StubSupervisorService(),
    policyConfig: SupervisorPolicyConfig = defaultSupervisorPolicy,
    traceStore: InMemoryTraceStore = new InMemoryTraceStore(),
    private readonly traceExporter: TraceExporter = new NoopTraceExporter(),
    private readonly now: () => Date = () => new Date(),
    private readonly onTraceExportError: (error: unknown, trace: DecisionTrace) => void = () => {},
  ) {
    this.scorer = new ConfidenceAndGroundingScorer();
    this.policyEngine = new EscalationPolicyEngine(policyConfig);
    this.traceStore = traceStore;
  }

  async respond(request: SupervisorRequest): Promise<SupervisorResponse> {
    const traceId = randomUUID();

    const primary = await this.primaryService.answer({
      tenantId: request.tenant_id,
      channelId: request.channel_id,
      userMessage: request.user_message,
      contextRefs: request.context_refs,
    });

    const scoring = this.scorer.score({
      answerText: primary.answer_text,
      citations: primary.citations,
      modelConfidence: primary.slm_confidence,
      groundingSignal: primary.grounding_score,
    });

    const decision = this.policyEngine.decide({
      hasPrimaryAnswer: primary.answer_text.trim().length > 0,
      confidence: scoring.confidence,
      grounding: scoring.grounding,
      policyFlags: scoring.policyFlags,
    });

    if (decision.fallbackDirect) {
      const fallback = await this.supervisorService.directFallback({
        tenantId: request.tenant_id,
        userMessage: request.user_message,
      });
      return this.finalize({
        traceId,
        request,
        finalAnswer: fallback,
        sourcePath: "frontier_direct_fallback",
        reasonCodes: decision.reasonCodes,
        policyFlags: scoring.policyFlags,
        confidence: scoring.confidence,
        grounding: scoring.grounding,
      });
    }

    if (!decision.escalate) {
      return this.finalize({
        traceId,
        request,
        finalAnswer: primary.answer_text,
        sourcePath: "slm_only",
        reasonCodes: scoring.reasonCodes,
        policyFlags: scoring.policyFlags,
        confidence: scoring.confidence,
        grounding: scoring.grounding,
      });
    }

    try {
      const verdict = await this.supervisorService.review({
        tenantId: request.tenant_id,
        userMessage: request.user_message,
        primary,
      });

      if (verdict.action === "approve") {
        return this.finalize({
          traceId,
          request,
          finalAnswer: primary.answer_text,
          sourcePath: "slm_plus_supervisor",
          reasonCodes: [...decision.reasonCodes, ...verdict.reason_codes],
          policyFlags: [...scoring.policyFlags, ...verdict.policy_flags],
          confidence: scoring.confidence,
          grounding: scoring.grounding,
        });
      }

      if (verdict.action === "edit" && verdict.edited_answer_text) {
        return this.finalize({
          traceId,
          request,
          finalAnswer: verdict.edited_answer_text,
          sourcePath: "slm_plus_supervisor",
          reasonCodes: [...decision.reasonCodes, ...verdict.reason_codes],
          policyFlags: [...scoring.policyFlags, ...verdict.policy_flags],
          confidence: scoring.confidence,
          grounding: scoring.grounding,
        });
      }

      const fallback = await this.supervisorService.directFallback({
        tenantId: request.tenant_id,
        userMessage: request.user_message,
      });

      return this.finalize({
        traceId,
        request,
        finalAnswer: fallback,
        sourcePath: "frontier_direct_fallback",
        reasonCodes: [...decision.reasonCodes, ...verdict.reason_codes],
        policyFlags: [...scoring.policyFlags, ...verdict.policy_flags],
        confidence: scoring.confidence,
        grounding: scoring.grounding,
      });
    } catch {
      const fallback = await this.supervisorService.directFallback({
        tenantId: request.tenant_id,
        userMessage: request.user_message,
      });
      return this.finalize({
        traceId,
        request,
        finalAnswer: fallback,
        sourcePath: "frontier_direct_fallback",
        reasonCodes: [...decision.reasonCodes, "supervisor_failure"],
        policyFlags: scoring.policyFlags,
        confidence: scoring.confidence,
        grounding: scoring.grounding,
      });
    }
  }

  getTraces(tenantId: string): DecisionTrace[] {
    return this.traceStore.listByTenant(tenantId);
  }

  recordFeedback(params: {
    tenantId: string;
    traceId: string;
    feedbackType: SupervisorFeedbackType;
    comment?: string;
  }): SupervisorFeedback | null {
    const trace = this.traceStore.getByTenantAndTrace(params.tenantId, params.traceId);
    if (!trace) {
      return null;
    }

    const trimmedComment = params.comment?.trim();
    const feedback: SupervisorFeedback = {
      feedback_id: randomUUID(),
      tenant_id: params.tenantId,
      trace_id: params.traceId,
      feedback_type: params.feedbackType,
      comment: trimmedComment && trimmedComment.length > 0 ? trimmedComment : undefined,
      created_at: this.now().toISOString(),
    };
    this.traceStore.appendFeedback(feedback);
    return feedback;
  }

  private finalize(params: {
    traceId: string;
    request: SupervisorRequest;
    finalAnswer: string;
    sourcePath: "slm_only" | "slm_plus_supervisor" | "frontier_direct_fallback";
    reasonCodes: string[];
    policyFlags: string[];
    confidence: number;
    grounding: number;
  }): SupervisorResponse {
    const trace: DecisionTrace = {
      trace_id: params.traceId,
      tenant_id: params.request.tenant_id,
      channel_id: params.request.channel_id,
      user_message: params.request.user_message,
      source_path: params.sourcePath,
      reason_codes: params.reasonCodes,
      policy_flags: params.policyFlags,
      slm_confidence: params.confidence,
      grounding_score: params.grounding,
      created_at: this.now().toISOString(),
    };
    this.traceStore.append(trace);
    void this.traceExporter.exportTrace(trace).catch((error) => {
      this.onTraceExportError(error, trace);
    });

    return {
      final_answer: params.finalAnswer,
      source_path: params.sourcePath,
      trace_id: params.traceId,
      reason_codes: params.reasonCodes,
      policy_flags: params.policyFlags,
    };
  }
}
