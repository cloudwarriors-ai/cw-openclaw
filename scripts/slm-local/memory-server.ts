import { createServer } from "node:http";

import { createStaticTokenAuth } from "../../packages/memory-server/src/auth.js";
import { createMemoryServer } from "../../packages/memory-server/src/server.js";
import { resolvePostgresMemoryStoreFromEnv } from "../../packages/memory-server/src/postgres-store.js";
import { InMemoryMemoryStore } from "../../packages/memory-server/src/store.js";

const port = parsePort(process.env.OPENCLAW_MEMORY_SERVER_PORT, 19090);
const tenantId = (process.env.OPENCLAW_MEMORY_SERVER_TENANT || "tenant-local").trim();
const serviceToken = (process.env.OPENCLAW_MEMORY_SERVER_TOKEN || "moltbot-local-token").trim();
const adminToken = process.env.OPENCLAW_MEMORY_SERVER_ADMIN_TOKEN?.trim();

const authResolver = createStaticTokenAuth({
  [serviceToken]: {
    tenantId,
    subject: "local-service",
    isAdmin: false,
  },
  ...(adminToken
    ? {
        [adminToken]: {
          tenantId,
          subject: "local-admin",
          isAdmin: true,
        },
      }
    : {}),
});

const store = resolvePostgresMemoryStoreFromEnv(process.env) ?? new InMemoryMemoryStore();
const app = createMemoryServer({
  authResolver,
  store,
});

const server = createServer(async (req, res) => {
  const response = await app.handle({
    method: req.method ?? "GET",
    path: req.url ?? "/",
    headers: {
      authorization: normalizeHeader(req.headers.authorization),
      "x-memory-api-key": normalizeHeader(req.headers["x-memory-api-key"]),
    },
    body: await parseJsonBody(req),
  });

  res.statusCode = response.status;
  for (const [key, value] of Object.entries(response.headers)) {
    res.setHeader(key, value);
  }
  res.end(JSON.stringify(response.body));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`[memory-server] listening on http://127.0.0.1:${port}\n`);
  process.stdout.write(`[memory-server] tenant=${tenantId}\n`);
  if (process.env.OPENCLAW_MEMORY_SERVER_DB_URL || process.env.SLM_PG_URL) {
    process.stdout.write("[memory-server] mode=postgres\n");
  } else {
    process.stdout.write("[memory-server] mode=in-memory\n");
  }
});

function normalizeHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

async function parseJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
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

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65_535) {
    return fallback;
  }
  return parsed;
}
