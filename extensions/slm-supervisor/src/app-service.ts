import type { SlmSupervisorOrchestrator } from "./orchestrator.js";
import type { TrainingStudioService } from "./training-studio.js";
import type {
  ReviewActionActor,
  SupervisorFeedback,
  SupervisorFeedbackType,
  SupervisorRequest,
  SupervisorResponse,
} from "./types.js";

export class SlmSupervisorAppService {
  constructor(
    private readonly orchestrator: SlmSupervisorOrchestrator,
    private readonly trainingStudio?: TrainingStudioService,
  ) {}

  async respond(request: SupervisorRequest): Promise<SupervisorResponse> {
    return this.orchestrator.respond(request);
  }

  listTraces(params: { tenantId: string; limit: number }) {
    const safeLimit = Number.isFinite(params.limit)
      ? Math.max(1, Math.min(200, Math.floor(params.limit)))
      : 50;
    return this.orchestrator.getTraces(params.tenantId).slice(-safeLimit).toReversed();
  }

  recordFeedback(params: {
    tenantId: string;
    traceId: string;
    feedbackType: SupervisorFeedbackType;
    comment?: string;
  }): SupervisorFeedback | null {
    return this.orchestrator.recordFeedback({
      tenantId: params.tenantId,
      traceId: params.traceId,
      feedbackType: params.feedbackType,
      comment: params.comment,
    });
  }

  async startTrainingSession(params: {
    tenantId: string;
    question: string;
    traceId?: string;
    reviewRefId?: string;
    actor?: ReviewActionActor;
  }) {
    return this.requireTrainingStudio().startSession(params);
  }

  async runTrainingTurn(params: {
    tenantId: string;
    sessionId: string;
    userPrompt: string;
    editedAnswer?: string;
    actor?: ReviewActionActor;
  }) {
    return this.requireTrainingStudio().turn(params);
  }

  async finishTrainingSession(params: {
    tenantId: string;
    sessionId: string;
    actor?: ReviewActionActor;
  }) {
    return this.requireTrainingStudio().finish(params);
  }

  private requireTrainingStudio(): TrainingStudioService {
    if (!this.trainingStudio) {
      throw new Error("training studio is not configured");
    }
    return this.trainingStudio;
  }
}
