import { randomUUID } from "node:crypto";
import type {
  MemoryRecord,
  MemoryServerClient,
  MemoryMetadataValue,
} from "./memory-client.js";
import type {
  ReviewActionActor,
  TrainingSessionRecord,
  TrainingSessionTurnRecord,
} from "./types.js";
import type { SlmSupervisorOrchestrator } from "./orchestrator.js";
import type { SupervisorResponse } from "./types.js";

const TRAINING_NAMESPACE = "slm.training.sessions";
const SESSION_KIND = "training_session";
const TURN_KIND = "training_session_turn";

export class TrainingStudioService {
  constructor(
    private readonly orchestrator: SlmSupervisorOrchestrator,
    private readonly memoryClient: MemoryServerClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async startSession(params: {
    tenantId: string;
    question: string;
    actor?: ReviewActionActor;
    traceId?: string;
    reviewRefId?: string;
  }): Promise<TrainingSessionRecord> {
    const timestamp = this.now().toISOString();
    const sessionId = randomUUID();
    const record = await this.memoryClient.upsert({
      id: sessionId,
      namespace: TRAINING_NAMESPACE,
      kind: SESSION_KIND,
      content: params.question,
      metadata: {
        status: "active",
        question: params.question,
        trace_id: params.traceId ?? null,
        review_ref_id: params.reviewRefId ?? null,
        created_at: timestamp,
        updated_at: timestamp,
        actor_id: params.actor?.actor_id ?? null,
        actor_name: params.actor?.actor_name ?? null,
        actor_role: params.actor?.actor_role ?? null,
      },
    });
    assertTenantRecord(record, params.tenantId);
    return toTrainingSessionRecord(record);
  }

  async turn(params: {
    tenantId: string;
    sessionId: string;
    userPrompt: string;
    editedAnswer?: string;
    actor?: ReviewActionActor;
  }): Promise<{
    session: TrainingSessionRecord;
    turn: TrainingSessionTurnRecord;
    supervisor: SupervisorResponse;
  }> {
    const session = await this.getActiveSession(params.tenantId, params.sessionId);
    if (!session) {
      throw new Error("training session not found");
    }
    if (session.status !== "active") {
      throw new Error(`training session is ${session.status}`);
    }

    const supervisor = await this.orchestrator.respond({
      tenant_id: params.tenantId,
      channel_id: "slm-dashboard",
      user_message: params.userPrompt,
      context_refs: session.trace_id ? [session.trace_id] : [],
    });
    const createdAt = this.now().toISOString();
    const turn = await this.memoryClient.create({
      namespace: TRAINING_NAMESPACE,
      kind: TURN_KIND,
      content: params.userPrompt,
      metadata: {
        session_id: session.session_id,
        user_prompt: params.userPrompt,
        model_answer: supervisor.final_answer,
        edited_answer: params.editedAnswer ?? null,
        created_at: createdAt,
        actor_id: params.actor?.actor_id ?? null,
        actor_name: params.actor?.actor_name ?? null,
        actor_role: params.actor?.actor_role ?? null,
      },
    });
    assertTenantRecord(turn, params.tenantId);

    const updatedSession = await this.memoryClient.upsert({
      id: session.session_id,
      namespace: TRAINING_NAMESPACE,
      kind: SESSION_KIND,
      content: session.question,
      metadata: {
        status: session.status,
        question: session.question,
        trace_id: supervisor.trace_id,
        review_ref_id: session.review_ref_id ?? null,
        created_at: session.created_at,
        updated_at: createdAt,
        actor_id: session.actor?.actor_id ?? params.actor?.actor_id ?? null,
        actor_name: session.actor?.actor_name ?? params.actor?.actor_name ?? null,
        actor_role: session.actor?.actor_role ?? params.actor?.actor_role ?? null,
      },
    });
    assertTenantRecord(updatedSession, params.tenantId);

    return {
      session: toTrainingSessionRecord(updatedSession),
      turn: toTrainingSessionTurnRecord(turn),
      supervisor,
    };
  }

  async finish(params: {
    tenantId: string;
    sessionId: string;
    actor?: ReviewActionActor;
  }): Promise<TrainingSessionRecord> {
    const session = await this.getActiveSession(params.tenantId, params.sessionId);
    if (!session) {
      throw new Error("training session not found");
    }
    const timestamp = this.now().toISOString();
    const record = await this.memoryClient.upsert({
      id: session.session_id,
      namespace: TRAINING_NAMESPACE,
      kind: SESSION_KIND,
      content: session.question,
      metadata: {
        status: "finished",
        question: session.question,
        trace_id: session.trace_id ?? null,
        review_ref_id: session.review_ref_id ?? null,
        created_at: session.created_at,
        updated_at: timestamp,
        finished_at: timestamp,
        actor_id: params.actor?.actor_id ?? session.actor?.actor_id ?? null,
        actor_name: params.actor?.actor_name ?? session.actor?.actor_name ?? null,
        actor_role: params.actor?.actor_role ?? session.actor?.actor_role ?? null,
      },
    });
    assertTenantRecord(record, params.tenantId);
    return toTrainingSessionRecord(record);
  }

  async getSession(params: {
    tenantId: string;
    sessionId: string;
  }): Promise<TrainingSessionRecord | null> {
    const session = await this.memoryClient.get(params.sessionId);
    if (!session || session.tenant_id !== params.tenantId || session.kind !== SESSION_KIND) {
      return null;
    }
    return toTrainingSessionRecord(session);
  }

  async listSessions(params: {
    tenantId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ records: TrainingSessionRecord[]; next_cursor: string | null }> {
    const listed = await this.memoryClient.list({
      namespace: TRAINING_NAMESPACE,
      kind: SESSION_KIND,
      cursor: params.cursor,
      limit: params.limit,
      sort_by: "updated_at",
      sort_order: "desc",
    });
    return {
      records: listed.records
        .filter((record) => record.tenant_id === params.tenantId)
        .map((record) => toTrainingSessionRecord(record)),
      next_cursor: listed.next_cursor,
    };
  }

  private async getActiveSession(
    tenantId: string,
    sessionId: string,
  ): Promise<TrainingSessionRecord | null> {
    const session = await this.getSession({ tenantId, sessionId });
    if (!session) {
      return null;
    }
    if (session.status !== "active") {
      return session;
    }
    return session;
  }
}

function toTrainingSessionRecord(record: MemoryRecord): TrainingSessionRecord {
  const metadata = record.metadata ?? {};
  const actorId = asString(metadata.actor_id);
  const actorRole = asString(metadata.actor_role);
  return {
    session_id: record.id,
    tenant_id: record.tenant_id,
    status: asTrainingStatus(metadata.status),
    question: asString(metadata.question) ?? record.content,
    review_ref_id: asString(metadata.review_ref_id),
    trace_id: asString(metadata.trace_id),
    created_at: asString(metadata.created_at) ?? record.created_at,
    updated_at: asString(metadata.updated_at) ?? record.updated_at,
    finished_at: asString(metadata.finished_at),
    actor:
      actorId && actorRole
        ? {
            actor_id: actorId,
            actor_name: asString(metadata.actor_name),
            actor_role:
              actorRole === "system"
                ? "system"
                : actorRole === "reviewer"
                  ? "reviewer"
                  : "operator",
          }
        : undefined,
  };
}

function toTrainingSessionTurnRecord(record: MemoryRecord): TrainingSessionTurnRecord {
  const metadata = record.metadata ?? {};
  const actorId = asString(metadata.actor_id);
  const actorRole = asString(metadata.actor_role);
  return {
    turn_id: record.id,
    session_id: asString(metadata.session_id) ?? "",
    tenant_id: record.tenant_id,
    user_prompt: asString(metadata.user_prompt) ?? record.content,
    model_answer: asString(metadata.model_answer) ?? "",
    edited_answer: asString(metadata.edited_answer),
    created_at: asString(metadata.created_at) ?? record.created_at,
    actor:
      actorId && actorRole
        ? {
            actor_id: actorId,
            actor_name: asString(metadata.actor_name),
            actor_role:
              actorRole === "system"
                ? "system"
                : actorRole === "reviewer"
                  ? "reviewer"
                  : "operator",
          }
        : undefined,
  };
}

function asString(value: MemoryMetadataValue | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asTrainingStatus(value: MemoryMetadataValue | undefined): TrainingSessionRecord["status"] {
  if (value === "finished") {
    return "finished";
  }
  if (value === "expired") {
    return "expired";
  }
  return "active";
}

function assertTenantRecord(record: MemoryRecord, tenantId: string): void {
  if (record.tenant_id !== tenantId) {
    throw new Error("memory record tenant mismatch");
  }
}
