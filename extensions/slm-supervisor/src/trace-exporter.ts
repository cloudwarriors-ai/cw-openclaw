import type { DecisionTrace } from "./types.js";

export type TraceExporter = {
  exportTrace: (trace: DecisionTrace) => Promise<void>;
};

export class NoopTraceExporter implements TraceExporter {
  async exportTrace(_trace: DecisionTrace): Promise<void> {}
}

export class MemoryServerTraceExporter implements TraceExporter {
  private readonly memoriesUrl: URL;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.memoriesUrl = resolveMemoryEndpoint(this.baseUrl, "/memories");
  }

  async exportTrace(trace: DecisionTrace): Promise<void> {
    const response = await fetch(this.memoriesUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        namespace: "slm.supervisor.trace",
        kind: "decision_trace",
        content: trace.user_message,
        metadata: {
          trace_id: trace.trace_id,
          source_path: trace.source_path,
          reason_codes: trace.reason_codes.join(","),
          policy_flags: trace.policy_flags.join(","),
          slm_confidence: trace.slm_confidence,
          grounding_score: trace.grounding_score,
          channel_id: trace.channel_id,
          created_at: trace.created_at,
        },
      }),
    });
    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        body = "";
      }
      throw new Error(
        `memory-server trace export failed with status ${response.status}${body ? `: ${body}` : ""}`,
      );
    }
  }
}

export function resolveTraceExporterFromEnv(env: NodeJS.ProcessEnv = process.env): TraceExporter {
  const baseUrl = env.OPENCLAW_MEMORY_SERVER_URL?.trim();
  const token = env.OPENCLAW_MEMORY_SERVER_TOKEN?.trim();
  if (!baseUrl || !token) {
    return new NoopTraceExporter();
  }
  return new MemoryServerTraceExporter(baseUrl, token);
}

function resolveMemoryEndpoint(baseUrl: string, endpointPath: string): URL {
  const base = new URL(baseUrl);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  const relativePath = endpointPath.replace(/^\/+/, "");
  return new URL(relativePath, base);
}
