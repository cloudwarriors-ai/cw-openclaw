import type { DecisionTrace, SupervisorFeedback } from "./types.js";

const MAX_TRACES = 5_000;
const MAX_FEEDBACK = 10_000;

export class InMemoryTraceStore {
  private readonly traces: DecisionTrace[] = [];
  private readonly feedback: SupervisorFeedback[] = [];

  append(trace: DecisionTrace): void {
    this.traces.push(trace);
    if (this.traces.length > MAX_TRACES) {
      this.traces.splice(0, this.traces.length - MAX_TRACES);
    }
  }

  getByTenantAndTrace(tenantId: string, traceId: string): DecisionTrace | undefined {
    return this.traces.find((trace) => trace.tenant_id === tenantId && trace.trace_id === traceId);
  }

  getByTraceId(traceId: string): DecisionTrace | undefined {
    return this.traces.find((trace) => trace.trace_id === traceId);
  }

  listByTenant(tenantId: string): DecisionTrace[] {
    return this.traces.filter((trace) => trace.tenant_id === tenantId);
  }

  appendFeedback(feedback: SupervisorFeedback): void {
    this.feedback.push(feedback);
    if (this.feedback.length > MAX_FEEDBACK) {
      this.feedback.splice(0, this.feedback.length - MAX_FEEDBACK);
    }
  }

  listFeedbackByTenant(tenantId: string): SupervisorFeedback[] {
    return this.feedback.filter((item) => item.tenant_id === tenantId);
  }
}
