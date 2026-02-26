import http from "node:http";

import { createMemoryServer } from "./server.js";
import type { MemoryAuthResolver } from "./auth.js";
import type { MemoryStore } from "./store.js";

export function createMemoryHttpServer(params: {
  authResolver: MemoryAuthResolver;
  store?: MemoryStore;
}): http.Server {
  const server = createMemoryServer({
    authResolver: params.authResolver,
    store: params.store,
  });

  return http.createServer(async (req, res) => {
    const requestUrl = req.url ?? "/";
    const body = await parseBody(req);
    const response = await server.handle({
      method: req.method ?? "GET",
      path: requestUrl,
      headers: {
        authorization: normalizeHeader(req.headers.authorization),
        "x-memory-api-key": normalizeHeader(req.headers["x-memory-api-key"]),
      },
      body,
    });
    res.statusCode = response.status;
    for (const [key, value] of Object.entries(response.headers)) {
      res.setHeader(key, value);
    }
    res.end(JSON.stringify(response.body));
  });
}

function normalizeHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

async function parseBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { _raw: raw };
  }
}
