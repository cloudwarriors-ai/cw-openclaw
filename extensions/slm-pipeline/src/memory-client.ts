export type MemoryMetadataValue = string | number | boolean | null;

export type MemoryRecord = {
  id: string;
  tenant_id: string;
  namespace: string;
  kind: string;
  content: string;
  metadata?: Record<string, MemoryMetadataValue>;
  source_ref?: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
};

export type ListMemoriesRequest = {
  namespace?: string;
  kind?: string;
  metadata_filters?: Record<string, MemoryMetadataValue>;
  include_deleted?: boolean;
  cursor?: string;
  limit?: number;
  sort_by?: "created_at" | "updated_at";
  sort_order?: "asc" | "desc";
};

export type SearchMemoriesRequest = {
  query_text: string;
  namespace?: string;
  metadata_filters?: Record<string, MemoryMetadataValue>;
  include_deleted?: boolean;
  top_k?: number;
  min_score?: number;
  embedding_model?: string;
  embedding_version?: string;
};

export type MemoryServerClient = {
  enabled: boolean;
  create: (input: {
    namespace: string;
    kind: string;
    content: string;
    metadata?: Record<string, MemoryMetadataValue>;
    source_ref?: string;
  }) => Promise<MemoryRecord>;
  upsert: (input: {
    id: string;
    namespace: string;
    kind: string;
    content: string;
    metadata?: Record<string, MemoryMetadataValue>;
    source_ref?: string;
  }) => Promise<MemoryRecord>;
  get: (id: string) => Promise<MemoryRecord | null>;
  list: (
    request: ListMemoriesRequest,
  ) => Promise<{ records: MemoryRecord[]; next_cursor: string | null }>;
  search: (
    request: SearchMemoriesRequest,
  ) => Promise<{ records: MemoryRecord[]; scores: number[] }>;
};

export function resolveMemoryServerClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MemoryServerClient {
  const baseUrl = env.OPENCLAW_MEMORY_SERVER_URL?.trim() ?? "";
  const token = env.OPENCLAW_MEMORY_SERVER_TOKEN?.trim() ?? "";
  if (!baseUrl || !token) {
    return createDisabledMemoryServerClient();
  }
  return new HttpMemoryServerClient(baseUrl, token);
}

class HttpMemoryServerClient implements MemoryServerClient {
  readonly enabled = true;

  private readonly headers: HeadersInit;

  constructor(
    private readonly baseUrl: string,
    token: string,
  ) {
    this.headers = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    };
  }

  async create(input: {
    namespace: string;
    kind: string;
    content: string;
    metadata?: Record<string, MemoryMetadataValue>;
    source_ref?: string;
  }): Promise<MemoryRecord> {
    const payload = await this.request({
      method: "POST",
      path: "/memories",
      body: input,
    });
    return parseMemoryRecord(payload.record, "memories.create");
  }

  async upsert(input: {
    id: string;
    namespace: string;
    kind: string;
    content: string;
    metadata?: Record<string, MemoryMetadataValue>;
    source_ref?: string;
  }): Promise<MemoryRecord> {
    const payload = await this.request({
      method: "POST",
      path: "/memories/upsert",
      body: input,
    });
    return parseMemoryRecord(payload.record, "memories.upsert");
  }

  async get(id: string): Promise<MemoryRecord | null> {
    try {
      const payload = await this.request({
        method: "GET",
        path: `/memories/${encodeURIComponent(id)}`,
      });
      return parseMemoryRecord(payload.record, "memories.get");
    } catch (error) {
      if (isStatusError(error, 404)) {
        return null;
      }
      throw error;
    }
  }

  async list(
    request: ListMemoriesRequest,
  ): Promise<{ records: MemoryRecord[]; next_cursor: string | null }> {
    const payload = await this.request({
      method: "POST",
      path: "/memories/list",
      body: request,
    });
    const recordsRaw = Array.isArray(payload.records) ? payload.records : [];
    return {
      records: recordsRaw.map((entry, index) =>
        parseMemoryRecord(entry, `memories.list[${index}]`),
      ),
      next_cursor:
        typeof payload.next_cursor === "string" && payload.next_cursor ? payload.next_cursor : null,
    };
  }

  async search(
    request: SearchMemoriesRequest,
  ): Promise<{ records: MemoryRecord[]; scores: number[] }> {
    const payload = await this.request({
      method: "POST",
      path: "/memories/search",
      body: request,
    });
    const recordsRaw = Array.isArray(payload.records) ? payload.records : [];
    const scoresRaw = Array.isArray(payload.scores) ? payload.scores : [];
    return {
      records: recordsRaw.map((entry, index) =>
        parseMemoryRecord(entry, `memories.search[${index}]`),
      ),
      scores: scoresRaw.map((score) =>
        typeof score === "number" && Number.isFinite(score) ? score : 0,
      ),
    };
  }

  private async request(params: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
  }): Promise<Record<string, unknown>> {
    const response = await fetch(resolveMemoryEndpoint(this.baseUrl, params.path), {
      method: params.method,
      headers: this.headers,
      body: params.body ? JSON.stringify(params.body) : undefined,
    });

    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch {
      payload = {};
    }

    if (!response.ok) {
      throw new MemoryServerError(
        response.status,
        `memory request failed (${response.status}) ${params.path}`,
        payload,
      );
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(`memory response payload is not an object for ${params.path}`);
    }
    return payload as Record<string, unknown>;
  }
}

class DisabledMemoryServerClient implements MemoryServerClient {
  readonly enabled = false;

  async create(): Promise<MemoryRecord> {
    throw new Error("memory server is disabled");
  }

  async upsert(): Promise<MemoryRecord> {
    throw new Error("memory server is disabled");
  }

  async get(): Promise<MemoryRecord | null> {
    return null;
  }

  async list(): Promise<{ records: MemoryRecord[]; next_cursor: string | null }> {
    return { records: [], next_cursor: null };
  }

  async search(): Promise<{ records: MemoryRecord[]; scores: number[] }> {
    return { records: [], scores: [] };
  }
}

class MemoryServerError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly payload: unknown,
  ) {
    super(message);
  }
}

function createDisabledMemoryServerClient(): MemoryServerClient {
  return new DisabledMemoryServerClient();
}

function resolveMemoryEndpoint(baseUrl: string, endpointPath: string): URL {
  const base = new URL(baseUrl);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  const relativePath = endpointPath.replace(/^\/+/, "");
  return new URL(relativePath, base);
}

function parseMemoryRecord(input: unknown, label: string): MemoryRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label}: memory record is missing`);
  }
  const value = input as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id : "";
  const tenantId = typeof value.tenant_id === "string" ? value.tenant_id : "";
  const namespace = typeof value.namespace === "string" ? value.namespace : "";
  const kind = typeof value.kind === "string" ? value.kind : "";
  const content = typeof value.content === "string" ? value.content : "";
  const createdAt = typeof value.created_at === "string" ? value.created_at : "";
  const updatedAt = typeof value.updated_at === "string" ? value.updated_at : "";
  if (!id || !tenantId || !namespace || !kind || !createdAt || !updatedAt) {
    throw new Error(`${label}: invalid memory record`);
  }
  return {
    id,
    tenant_id: tenantId,
    namespace,
    kind,
    content,
    metadata: parseMetadata(value.metadata),
    source_ref: typeof value.source_ref === "string" ? value.source_ref : undefined,
    created_at: createdAt,
    updated_at: updatedAt,
    deleted_at: typeof value.deleted_at === "string" ? value.deleted_at : undefined,
  };
}

function parseMetadata(input: unknown): Record<string, MemoryMetadataValue> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const out: Record<string, MemoryMetadataValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      out[key] = value;
    }
  }
  return out;
}

function isStatusError(error: unknown, status: number): boolean {
  return error instanceof MemoryServerError && error.status === status;
}
