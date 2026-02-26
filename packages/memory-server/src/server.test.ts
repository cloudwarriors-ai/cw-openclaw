import { describe, expect, test } from "vitest";
import { createMemoryServer } from "./server.js";
import { InMemoryMemoryStore } from "./store.js";

function createTestServer() {
  let tick = 0;
  return createMemoryServer({
    store: new InMemoryMemoryStore(() => {
      tick += 1;
      return new Date(Date.UTC(2026, 1, 23, 12, 0, tick));
    }),
    authResolver: (token) => {
      if (token === "tenant-a-token") {
        return { tenantId: "tenant-a", subject: "svc-a", isAdmin: false };
      }
      if (token === "tenant-b-token") {
        return { tenantId: "tenant-b", subject: "svc-b", isAdmin: false };
      }
      if (token === "admin-token") {
        return { tenantId: "tenant-a", subject: "admin", isAdmin: true };
      }
      return null;
    },
  });
}

async function send(params: {
  server: ReturnType<typeof createMemoryServer>;
  method: string;
  path: string;
  token?: string;
  apiKey?: string;
  body?: unknown;
}) {
  const headers: Record<string, string> = {};
  if (params.token) {
    headers.authorization = `Bearer ${params.token}`;
  }
  if (params.apiKey) {
    headers["x-memory-api-key"] = params.apiKey;
  }
  return params.server.handle({
    method: params.method,
    path: params.path,
    body: params.body,
    headers,
  });
}

describe("memory server", () => {
  test("creates and fetches a memory record", async () => {
    const server = createTestServer();

    const created = await send({
      server,
      method: "POST",
      path: "/memories",
      token: "tenant-a-token",
      body: {
        namespace: "zoom.qa",
        kind: "approved_answer",
        content: "Enable SAML in admin settings.",
      },
    });
    expect(created.status).toBe(201);
    const createdBody = created.body as { record: { id: string; tenant_id: string } };
    expect(createdBody.record.tenant_id).toBe("tenant-a");

    const fetched = await send({
      server,
      method: "GET",
      path: `/memories/${createdBody.record.id}`,
      token: "tenant-a-token",
    });
    expect(fetched.status).toBe(200);
  });

  test("enforces tenant isolation on reads", async () => {
    const server = createTestServer();
    const created = await send({
      server,
      method: "POST",
      path: "/memories",
      token: "tenant-a-token",
      body: {
        namespace: "zoom.qa",
        kind: "approved_answer",
        content: "Tenant A only",
      },
    });
    const createdBody = created.body as { record: { id: string } };

    const leaked = await send({
      server,
      method: "GET",
      path: `/memories/${createdBody.record.id}`,
      token: "tenant-b-token",
    });
    expect(leaked.status).toBe(404);
  });

  test("accepts X-Memory-API-Key without Authorization header", async () => {
    const server = createTestServer();
    const created = await send({
      server,
      method: "POST",
      path: "/memories",
      apiKey: "tenant-a-token",
      body: {
        namespace: "zoom.qa",
        kind: "approved_answer",
        content: "API key auth path",
      },
    });
    expect(created.status).toBe(201);
  });

  test("searches by relevance and metadata filters", async () => {
    const server = createTestServer();
    await send({
      server,
      method: "POST",
      path: "/memories",
      token: "tenant-a-token",
      body: {
        namespace: "zoom.qa",
        kind: "approved_answer",
        content: "Configure SAML SSO in Zoom admin portal",
        metadata: { source: "zoom", stage: "approved" },
      },
    });
    await send({
      server,
      method: "POST",
      path: "/memories",
      token: "tenant-a-token",
      body: {
        namespace: "zoom.qa",
        kind: "approved_answer",
        content: "General small talk response",
        metadata: { source: "zoom", stage: "rejected" },
      },
    });

    const searched = await send({
      server,
      method: "POST",
      path: "/memories/search",
      token: "tenant-a-token",
      body: {
        query_text: "How to configure saml sso",
        metadata_filters: { stage: "approved" },
        top_k: 5,
      },
    });
    expect(searched.status).toBe(200);
    const body = searched.body as { records: Array<{ content: string }>; scores: number[] };
    expect(body.records).toHaveLength(1);
    expect(body.records[0]?.content).toContain("SAML");
    expect(body.scores[0]).toBeGreaterThan(0);
    expect((searched.body as { query_embedding_model: string }).query_embedding_model).toBe(
      "lexical-v1",
    );
    expect((searched.body as { query_embedding_version: string }).query_embedding_version).toBe(
      "1",
    );
  });

  test("lists memories with deterministic cursor pagination", async () => {
    const server = createTestServer();
    await send({
      server,
      method: "POST",
      path: "/memories/upsert",
      token: "tenant-a-token",
      body: {
        id: "00000000-0000-4000-8000-000000000001",
        namespace: "zoom.qa",
        kind: "note",
        content: "first",
        metadata: { status: "approved" },
      },
    });
    await send({
      server,
      method: "POST",
      path: "/memories/upsert",
      token: "tenant-a-token",
      body: {
        id: "00000000-0000-4000-8000-000000000002",
        namespace: "zoom.qa",
        kind: "note",
        content: "second",
        metadata: { status: "approved" },
      },
    });
    await send({
      server,
      method: "POST",
      path: "/memories/upsert",
      token: "tenant-a-token",
      body: {
        id: "00000000-0000-4000-8000-000000000003",
        namespace: "zoom.qa",
        kind: "note",
        content: "third",
        metadata: { status: "approved" },
      },
    });

    const firstPage = await send({
      server,
      method: "POST",
      path: "/memories/list",
      token: "tenant-a-token",
      body: {
        namespace: "zoom.qa",
        kind: "note",
        metadata_filters: { status: "approved" },
        limit: 2,
        sort_by: "created_at",
        sort_order: "desc",
      },
    });
    expect(firstPage.status).toBe(200);
    const firstBody = firstPage.body as {
      records: Array<{ id: string }>;
      next_cursor?: string;
    };
    expect(firstBody.records.map((record) => record.id)).toEqual([
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000002",
    ]);
    expect(firstBody.next_cursor).toBeTruthy();

    const secondPage = await send({
      server,
      method: "POST",
      path: "/memories/list",
      token: "tenant-a-token",
      body: {
        namespace: "zoom.qa",
        kind: "note",
        metadata_filters: { status: "approved" },
        limit: 2,
        sort_by: "created_at",
        sort_order: "desc",
        cursor: firstBody.next_cursor,
      },
    });
    expect(secondPage.status).toBe(200);
    const secondBody = secondPage.body as {
      records: Array<{ id: string }>;
      next_cursor?: string;
    };
    expect(secondBody.records.map((record) => record.id)).toEqual([
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(secondBody.next_cursor).toBeUndefined();
  });

  test("applies embedding model/version filters in search", async () => {
    const server = createTestServer();
    await send({
      server,
      method: "POST",
      path: "/memories",
      token: "tenant-a-token",
      body: {
        namespace: "zoom.qa",
        kind: "approved_answer",
        content: "Tenant scoped memory",
      },
    });

    const mismatch = await send({
      server,
      method: "POST",
      path: "/memories/search",
      token: "tenant-a-token",
      body: {
        query_text: "tenant memory",
        embedding_model: "custom-model",
        embedding_version: "9",
      },
    });
    expect(mismatch.status).toBe(200);
    const mismatchBody = mismatch.body as {
      records: unknown[];
      query_embedding_model: string;
      query_embedding_version: string;
    };
    expect(mismatchBody.records).toHaveLength(0);
    expect(mismatchBody.query_embedding_model).toBe("custom-model");
    expect(mismatchBody.query_embedding_version).toBe("9");
  });

  test("rejects invalid list cursor payloads", async () => {
    const server = createTestServer();
    const invalid = await send({
      server,
      method: "POST",
      path: "/memories/list",
      token: "tenant-a-token",
      body: {
        cursor: "not-base64url",
      },
    });
    expect(invalid.status).toBe(400);
  });

  test("requires admin token for migration route", async () => {
    const server = createTestServer();
    const forbidden = await send({
      server,
      method: "POST",
      path: "/memories/migrate/file-core",
      token: "tenant-a-token",
      body: {
        records: [
          {
            namespace: "legacy",
            kind: "note",
            content: "from file",
          },
        ],
      },
    });
    expect(forbidden.status).toBe(403);

    const allowed = await send({
      server,
      method: "POST",
      path: "/memories/migrate/file-core",
      token: "admin-token",
      body: {
        records: [
          {
            namespace: "legacy",
            kind: "note",
            content: "from file",
          },
        ],
      },
    });
    expect(allowed.status).toBe(201);
  });

  test("supports /memory compatibility aliases and PUT /memories/{id}", async () => {
    const server = createTestServer();
    const memoryId = "0f0cd56f-f04a-45ef-b537-c9d3090a4f20";
    const put = await send({
      server,
      method: "PUT",
      path: `/memory/${memoryId}`,
      token: "tenant-a-token",
      body: {
        namespace: "compat.alias",
        kind: "note",
        content: "first",
      },
    });
    expect(put.status).toBe(200);

    const fetched = await send({
      server,
      method: "GET",
      path: `/memory/${memoryId}`,
      token: "tenant-a-token",
    });
    expect(fetched.status).toBe(200);
    expect((fetched.body as { record: { content: string } }).record.content).toBe("first");
  });

  test("soft deletes records by default and allows explicit include_deleted retrieval", async () => {
    const server = createTestServer();
    const created = await send({
      server,
      method: "POST",
      path: "/memories",
      token: "tenant-a-token",
      body: {
        namespace: "zoom.qa",
        kind: "note",
        content: "soft-delete-me",
      },
    });
    const memoryId = (created.body as { record: { id: string } }).record.id;
    const deleted = await send({
      server,
      method: "DELETE",
      path: `/memories/${memoryId}`,
      token: "tenant-a-token",
    });
    expect(deleted.status).toBe(200);

    const hiddenGet = await send({
      server,
      method: "GET",
      path: `/memories/${memoryId}`,
      token: "tenant-a-token",
    });
    expect(hiddenGet.status).toBe(404);

    const visibleGet = await send({
      server,
      method: "GET",
      path: `/memories/${memoryId}?include_deleted=true`,
      token: "tenant-a-token",
    });
    expect(visibleGet.status).toBe(200);
    expect((visibleGet.body as { record: { deleted_at?: string } }).record.deleted_at).toBeTruthy();

    const hiddenList = await send({
      server,
      method: "POST",
      path: "/memories/list",
      token: "tenant-a-token",
      body: {
        namespace: "zoom.qa",
        kind: "note",
      },
    });
    expect((hiddenList.body as { records: unknown[] }).records).toHaveLength(0);

    const visibleList = await send({
      server,
      method: "POST",
      path: "/memories/list",
      token: "tenant-a-token",
      body: {
        namespace: "zoom.qa",
        kind: "note",
        include_deleted: true,
      },
    });
    expect((visibleList.body as { records: unknown[] }).records).toHaveLength(1);
  });

  test("lists timeline results with range filters", async () => {
    const server = createTestServer();
    for (const content of ["one", "two", "three"]) {
      const response = await send({
        server,
        method: "POST",
        path: "/memories",
        token: "tenant-a-token",
        body: {
          namespace: "timeline.qa",
          kind: "note",
          content,
        },
      });
      expect(response.status).toBe(201);
    }

    const timeline = await send({
      server,
      method: "GET",
      path: "/memory/timeline?namespace=timeline.qa&limit=2",
      token: "tenant-a-token",
    });
    expect(timeline.status).toBe(200);
    const records = (timeline.body as { records: Array<{ content: string }> }).records;
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.content)).toEqual(["one", "two"]);
  });

  test("rejects upsert id collisions across tenants", async () => {
    const server = createTestServer();
    const id = "6f426e4a-1a1f-4285-871e-1d40c5eb7e4a";
    const created = await send({
      server,
      method: "POST",
      path: "/memories/upsert",
      token: "tenant-a-token",
      body: {
        id,
        namespace: "tenant-a",
        kind: "note",
        content: "alpha",
      },
    });
    expect(created.status).toBe(200);

    const collision = await send({
      server,
      method: "POST",
      path: "/memories/upsert",
      token: "tenant-b-token",
      body: {
        id,
        namespace: "tenant-b",
        kind: "note",
        content: "beta",
      },
    });
    expect(collision.status).toBe(409);
  });
});
