import { afterEach, describe, expect, test } from "vitest";

import { createMemoryHttpServer } from "./http-server.js";

describe("memory http server", () => {
  const servers: Array<ReturnType<typeof createMemoryHttpServer>> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (!server) {
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    }
  });

  test("serves create/get flow over http", async () => {
    const server = createMemoryHttpServer({
      authResolver: (token) => {
        if (token === "token-a") {
          return { tenantId: "tenant-a", subject: "svc", isAdmin: false };
        }
        return null;
      },
    });
    servers.push(server);

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", (err?: Error) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    const createdResponse = await fetch(`${baseUrl}/memories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer token-a",
      },
      body: JSON.stringify({
        namespace: "test",
        kind: "note",
        content: "hello",
      }),
    });
    expect(createdResponse.status).toBe(201);
    const createdBody = (await createdResponse.json()) as {
      record: { id: string };
    };

    const fetchedResponse = await fetch(`${baseUrl}/memories/${createdBody.record.id}`, {
      headers: {
        authorization: "Bearer token-a",
      },
    });
    expect(fetchedResponse.status).toBe(200);
  });

  test("accepts X-Memory-API-Key header", async () => {
    const server = createMemoryHttpServer({
      authResolver: (token) => {
        if (token === "token-a") {
          return { tenantId: "tenant-a", subject: "svc", isAdmin: false };
        }
        return null;
      },
    });
    servers.push(server);

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", (err?: Error) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    const response = await fetch(`${baseUrl}/memory`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-memory-api-key": "token-a",
      },
      body: JSON.stringify({
        namespace: "test",
        kind: "note",
        content: "hello",
      }),
    });
    expect(response.status).toBe(201);
  });
});
