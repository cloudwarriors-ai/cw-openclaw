// Thin HTTP client for writing a2a task lifecycle records to the local
// omni-mem HTTP API (`/api/save-memory`). Fire-and-forget: a failed write
// must never block mesh.send_task acceptance or mark a task as failed.

const TASK_META_OPEN = "<task-meta>";
const TASK_META_CLOSE = "</task-meta>";
const DEFAULT_TIMEOUT_MS = 5_000;

type FetchImpl = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export type TransitionStatus = "accepted" | "executing";
export type CompletionStatus = "completed" | "failed" | "rejected";

export type OmniMemWriteResult = {
  ok: boolean;
  memoryId?: string;
  error?: string;
  skipped?: boolean;
};

export type PostTaskTransitionParams = {
  omniMemUrl: string | undefined;
  taskId: string;
  status: TransitionStatus;
  actor: string;
  note?: string;
  workspaceId?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  source?: string;
};

export type PostTaskCompletionParams = {
  omniMemUrl: string | undefined;
  taskId: string;
  status: CompletionStatus;
  actor: string;
  summary?: string;
  details?: string;
  workspaceId?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  source?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function embedMeta(meta: Record<string, unknown>): string {
  return `${TASK_META_OPEN}${JSON.stringify(meta)}${TASK_META_CLOSE}`;
}

function normalizeUrl(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed || undefined;
}

export async function postTaskTransition(
  params: PostTaskTransitionParams,
): Promise<OmniMemWriteResult> {
  const url = normalizeUrl(params.omniMemUrl);
  if (!url) {
    return { ok: false, skipped: true, error: "omni-mem url not configured" };
  }
  if (!params.taskId || !params.status || !params.actor) {
    return { ok: false, error: "missing required field (taskId|status|actor)" };
  }
  const source = params.source ?? "mesh-gateway";
  const embedded = embedMeta({
    kind: "task_transition_record",
    task_id: params.taskId,
    status: params.status,
    actor: params.actor,
    note: params.note,
    recorded_at: nowIso(),
    source,
  });
  const body = {
    title: `task-${params.status}:${params.taskId}`,
    text: [
      `Task ${params.taskId} → ${params.status} (recorded by ${source} for ${params.actor}).`,
      ...(params.note ? ["", params.note] : []),
      "",
      embedded,
    ].join("\n"),
    workspaceId: params.workspaceId ?? "default",
    taskId: params.taskId,
  };
  return sendSaveMemory(url, body, params.fetchImpl, params.timeoutMs);
}

export async function postTaskCompletion(
  params: PostTaskCompletionParams,
): Promise<OmniMemWriteResult> {
  const url = normalizeUrl(params.omniMemUrl);
  if (!url) {
    return { ok: false, skipped: true, error: "omni-mem url not configured" };
  }
  if (!params.taskId || !params.status || !params.actor) {
    return { ok: false, error: "missing required field (taskId|status|actor)" };
  }
  const source = params.source ?? "mesh-gateway";
  const embedded = embedMeta({
    kind: "task_completion_record",
    task_id: params.taskId,
    status: params.status,
    completed_by: params.actor,
    completed_at: nowIso(),
    summary: params.summary,
    source,
  });
  const body = {
    title: `task-completed:${params.taskId}`,
    text: [
      `Task ${params.taskId} completed with status=${params.status} by ${params.actor}.`,
      ...(params.summary ? ["", `**Summary:** ${params.summary}`] : []),
      ...(params.details ? ["", params.details] : []),
      "",
      embedded,
    ].join("\n"),
    workspaceId: params.workspaceId ?? "default",
    taskId: params.taskId,
  };
  return sendSaveMemory(url, body, params.fetchImpl, params.timeoutMs);
}

async function sendSaveMemory(
  baseUrl: string,
  body: Record<string, unknown>,
  fetchImpl: FetchImpl | undefined,
  timeoutMs: number | undefined,
): Promise<OmniMemWriteResult> {
  const impl = fetchImpl ?? (globalThis as { fetch?: FetchImpl }).fetch;
  if (typeof impl !== "function") {
    return { ok: false, error: "fetch implementation unavailable" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await impl(`${baseUrl}/api/save-memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { ok: false, error: `save-memory ${response.status}: ${text.slice(0, 200)}` };
    }
    const data = (await response.json().catch(() => ({}))) as { id?: unknown };
    if (!data || typeof data !== "object" || typeof data.id !== "string") {
      return { ok: false, error: "save-memory response missing id" };
    }
    return { ok: true, memoryId: data.id };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e?.name === "AbortError") {
      return { ok: false, error: "save-memory timed out" };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
