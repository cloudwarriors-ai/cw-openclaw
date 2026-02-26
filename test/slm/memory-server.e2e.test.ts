import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryHttpServer } from "../../packages/memory-server/src/http-server.js";

type Harness = {
  baseUrl: string;
  close: () => Promise<void>;
};

describe("memory server e2e", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await cleanup.pop()?.();
    }
  });

  it("supports create/get/delete/timeline with bearer and x-memory-api-key auth", async () => {
    const harness = await createHarness();
    cleanup.push(harness.close);

    const created = await requestJson(harness.baseUrl, {
      method: "POST",
      path: "/memories",
      headers: {
        authorization: "Bearer tenant-a-token",
      },
      body: {
        namespace: "slm.qa",
        kind: "qa_projection",
        content: "How do we run safe deploys?",
        metadata: {
          source: "e2e",
        },
      },
    });
    expect(created.status).toBe(201);
    const memoryId = asString((created.body as { record?: { id?: string } }).record?.id);
    expect(memoryId).toBeTruthy();

    const fetched = await requestJson(harness.baseUrl, {
      method: "GET",
      path: `/memory/${memoryId}`,
      headers: {
        "x-memory-api-key": "tenant-a-token",
      },
    });
    expect(fetched.status).toBe(200);
    expect((fetched.body as { record: { id: string } }).record.id).toBe(memoryId);

    const deleted = await requestJson(harness.baseUrl, {
      method: "DELETE",
      path: `/memories/${memoryId}`,
      headers: {
        authorization: "Bearer tenant-a-token",
      },
    });
    expect(deleted.status).toBe(200);

    const hiddenGet = await requestJson(harness.baseUrl, {
      method: "GET",
      path: `/memories/${memoryId}`,
      headers: {
        authorization: "Bearer tenant-a-token",
      },
    });
    expect(hiddenGet.status).toBe(404);

    const includeDeletedGet = await requestJson(harness.baseUrl, {
      method: "GET",
      path: `/memories/${memoryId}?include_deleted=true`,
      headers: {
        authorization: "Bearer tenant-a-token",
      },
    });
    expect(includeDeletedGet.status).toBe(200);
    const deletedAt = asString(
      (includeDeletedGet.body as { record?: { deleted_at?: string } }).record?.deleted_at,
    );
    expect(deletedAt).toBeTruthy();

    const timeline = await requestJson(harness.baseUrl, {
      method: "GET",
      path: "/memory/timeline?namespace=slm.qa&include_deleted=true&limit=10",
      headers: {
        authorization: "Bearer tenant-a-token",
      },
    });
    expect(timeline.status).toBe(200);
    const records = (timeline.body as { records?: Array<{ id: string }> }).records ?? [];
    expect(records.some((record) => record.id === memoryId)).toBe(true);
  });

  it("enforces tenant isolation across API-key authenticated requests", async () => {
    const harness = await createHarness();
    cleanup.push(harness.close);

    const created = await requestJson(harness.baseUrl, {
      method: "POST",
      path: "/memories",
      headers: {
        "x-memory-api-key": "tenant-a-token",
      },
      body: {
        namespace: "slm.qa",
        kind: "qa_projection",
        content: "tenant-a only record",
      },
    });
    expect(created.status).toBe(201);
    const memoryId = asString((created.body as { record?: { id?: string } }).record?.id);
    expect(memoryId).toBeTruthy();

    const leaked = await requestJson(harness.baseUrl, {
      method: "GET",
      path: `/memories/${memoryId}`,
      headers: {
        "x-memory-api-key": "tenant-b-token",
      },
    });
    expect(leaked.status).toBe(404);
  });
});

async function createHarness(): Promise<Harness> {
  const server = createMemoryHttpServer({
    authResolver: (token) => {
      if (token === "tenant-a-token") {
        return {
          tenantId: "tenant-a",
          subject: "svc-a",
          isAdmin: true,
        };
      }
      if (token === "tenant-b-token") {
        return {
          tenantId: "tenant-b",
          subject: "svc-b",
          isAdmin: false,
        };
      }
      return null;
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function requestJson(
  baseUrl: string,
  params: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<{
  status: number;
  body: unknown;
}> {
  const response = await fetch(`${baseUrl}${params.path}`, {
    method: params.method,
    headers: {
      "content-type": "application/json",
      ...(params.headers ?? {}),
    },
    body: params.body ? JSON.stringify(params.body) : undefined,
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
