import { randomUUID } from "node:crypto";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import * as z from "zod";
import { clearSessionCookie, parseCookieHeader, setSessionCookie } from "./cookies.js";
import { verifyPasswordHash } from "./password.js";
import { InMemorySessionStore } from "./session-store.js";
import type { Clock, DashboardConfig, GatewayMethodClient, SessionRecord } from "./types.js";

type RequestWithSession = Request & { session: SessionRecord };

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const loginBodySchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(512),
});

const qaListQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  query: z.string().trim().min(1).max(4_000).optional(),
});

const projectionIdSchema = z.string().uuid();

const qaUpdateBodySchema = z.object({
  question: z.string().trim().min(1).max(4_000).optional(),
  answer: z.string().trim().min(1).max(12_000),
  source_channel: z.string().trim().min(1).max(200).optional(),
  source_ref: z.string().trim().min(1).max(512).optional(),
  trace_id: z.string().uuid().optional(),
  ref_id: z.string().trim().min(1).max(200).optional(),
});

const startSessionSchema = z.object({
  question: z.string().trim().min(1).max(4_000),
  trace_id: z.string().uuid().optional(),
  review_ref_id: z.string().trim().min(1).max(200).optional(),
});

const turnSchema = z.object({
  user_prompt: z.string().trim().min(1).max(8_000),
  edited_answer: z.string().trim().max(12_000).optional(),
});

const finishSessionSchema = z.object({
  session_id: z.string().uuid(),
});

const trainingSchema = z.object({
  base_model: z.string().trim().min(1).max(256),
  split_seed: z.number().int().min(1).optional(),
  idempotency_key: z.string().trim().min(8).max(128).optional(),
});

function jsonError(
  res: Response,
  requestId: string,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  res.status(status).json({
    ok: false,
    request_id: requestId,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  });
}

function parseRequestBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) {
    return parsed.data;
  }
  throw new ApiError(400, "invalid_request", "request validation failed", parsed.error.flatten());
}

function parseProjectionId(id: string): string {
  const parsed = projectionIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new ApiError(400, "invalid_request", "projection id must be a UUID");
  }
  return parsed.data;
}

function findUser(config: DashboardConfig, username: string) {
  return config.users.find((entry) => entry.username === username);
}

async function invokeGateway<T>(
  client: GatewayMethodClient,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  try {
    return await client.request<T>(method, params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("not found")) {
      throw new ApiError(404, "not_found", message);
    }
    if (message.includes("unknown method")) {
      throw new ApiError(502, "gateway_method_missing", message);
    }
    throw new ApiError(502, "gateway_error", message);
  }
}

function withRequestId(req: Request): string {
  const raw = req.headers["x-request-id"];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return randomUUID();
}

function readSession(req: Request, store: InMemorySessionStore, cookieName: string): SessionRecord | null {
  const cookies = parseCookieHeader(req.headers.cookie);
  const sessionId = cookies[cookieName];
  if (!sessionId) {
    return null;
  }
  return store.get(sessionId);
}

function getRequiredSession(req: Request): SessionRecord {
  const session = (req as Partial<RequestWithSession>).session;
  if (!session) {
    throw new ApiError(401, "unauthorized", "login required");
  }
  return session;
}

function requireSession(
  req: Request,
  res: Response,
  next: NextFunction,
  store: InMemorySessionStore,
  config: DashboardConfig,
): void {
  const requestId = withRequestId(req);
  const session = readSession(req, store, config.cookieName);
  if (!session) {
    jsonError(res, requestId, 401, "unauthorized", "login required");
    return;
  }
  (req as RequestWithSession).session = session;
  next();
}

export function createSlmDashboardApp(params: {
  config: DashboardConfig;
  gatewayClient: GatewayMethodClient;
  clientDir: string;
  clock?: Clock;
}) {
  const app = express();
  const sessionStore = new InMemorySessionStore(params.config.sessionTtlMs, params.clock);

  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post("/api/auth/login", (req, res) => {
    const requestId = withRequestId(req);
    try {
      const body = parseRequestBody(loginBodySchema, req.body);
      const user = findUser(params.config, body.username);
      if (!user || !verifyPasswordHash(body.password, user.passwordHash)) {
        jsonError(res, requestId, 401, "unauthorized", "invalid username or password");
        return;
      }
      const session = sessionStore.create({
        username: user.username,
        tenantId: user.tenantId,
        displayName: user.displayName,
      });
      setSessionCookie({
        res,
        cookieName: params.config.cookieName,
        value: session.sessionId,
        secure: params.config.cookieSecure,
        maxAgeSeconds: Math.floor(params.config.sessionTtlMs / 1000),
      });
      res.status(200).json({
        ok: true,
        request_id: requestId,
        data: {
          username: session.username,
          tenant_id: session.tenantId,
          display_name: session.displayName,
        },
      });
    } catch (error) {
      handleApiError(error, res, requestId);
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    const requestId = withRequestId(req);
    const session = readSession(req, sessionStore, params.config.cookieName);
    if (session) {
      sessionStore.delete(session.sessionId);
    }
    clearSessionCookie({
      res,
      cookieName: params.config.cookieName,
      secure: params.config.cookieSecure,
    });
    res.status(200).json({ ok: true, request_id: requestId });
  });

  app.get("/api/auth/me", (req, res) => {
    const requestId = withRequestId(req);
    const session = readSession(req, sessionStore, params.config.cookieName);
    if (!session) {
      jsonError(res, requestId, 401, "unauthorized", "login required");
      return;
    }
    res.status(200).json({
      ok: true,
      request_id: requestId,
      data: {
        username: session.username,
        tenant_id: session.tenantId,
        display_name: session.displayName,
      },
    });
  });

  app.use("/api/slm", (req, res, next) =>
    requireSession(req, res, next, sessionStore, params.config),
  );

  app.get("/api/slm/qa", async (req, res) => {
    const requestId = withRequestId(req);
    try {
      const query = qaListQuerySchema.parse(req.query);
      const session = getRequiredSession(req);
      const payload = await invokeGateway<{ records: unknown[]; next_cursor: string | null }>(
        params.gatewayClient,
        "slm.control.qa.list",
        {
          tenant_id: session.tenantId,
          cursor: query.cursor,
          limit: query.limit,
          query: query.query,
        },
      );
      res.status(200).json({
        ok: true,
        request_id: requestId,
        data: payload,
        trace: { gateway_method: "slm.control.qa.list" },
      });
    } catch (error) {
      handleApiError(error, res, requestId);
    }
  });

  app.get("/api/slm/qa/:projectionId", async (req, res) => {
    const requestId = withRequestId(req);
    try {
      const session = getRequiredSession(req);
      const projectionId = parseProjectionId(req.params.projectionId ?? "");
      const payload = await invokeGateway<{ record?: unknown }>(
        params.gatewayClient,
        "slm.control.qa.get",
        {
          tenant_id: session.tenantId,
          projection_id: projectionId,
        },
      );
      if (!payload?.record) {
        throw new ApiError(404, "not_found", "qa projection not found");
      }
      res.status(200).json({
        ok: true,
        request_id: requestId,
        data: payload,
        trace: { gateway_method: "slm.control.qa.get" },
      });
    } catch (error) {
      handleApiError(error, res, requestId);
    }
  });

  app.put("/api/slm/qa/:projectionId", async (req, res) => {
    const requestId = withRequestId(req);
    try {
      const session = getRequiredSession(req);
      const projectionId = parseProjectionId(req.params.projectionId ?? "");
      const body = parseRequestBody(qaUpdateBodySchema, req.body);
      const methods = ["slm.control.qa.update"];
      let question = body.question;
      if (!question) {
        const existing = await invokeGateway<{ record?: { question?: string } }>(
          params.gatewayClient,
          "slm.control.qa.get",
          {
            tenant_id: session.tenantId,
            projection_id: projectionId,
          },
        );
        methods.unshift("slm.control.qa.get");
        if (!existing?.record?.question) {
          throw new ApiError(404, "not_found", "qa projection not found");
        }
        question = existing.record.question;
      }

      const payload = await invokeGateway<{ record: unknown }>(
        params.gatewayClient,
        "slm.control.qa.update",
        {
          tenant_id: session.tenantId,
          question,
          answer: body.answer,
          source_channel: body.source_channel,
          source_ref: body.source_ref,
          trace_id: body.trace_id,
          ref_id: body.ref_id,
        },
      );
      res.status(200).json({
        ok: true,
        request_id: requestId,
        data: payload,
        trace: { gateway_methods: methods },
      });
    } catch (error) {
      handleApiError(error, res, requestId);
    }
  });

  app.post("/api/slm/session/start", async (req, res) => {
    const requestId = withRequestId(req);
    try {
      const session = getRequiredSession(req);
      const body = parseRequestBody(startSessionSchema, req.body);
      const payload = await invokeGateway<{ session: unknown }>(
        params.gatewayClient,
        "slm.control.session.start",
        {
          tenant_id: session.tenantId,
          question: body.question,
          trace_id: body.trace_id,
          review_ref_id: body.review_ref_id,
        },
      );
      res.status(200).json({
        ok: true,
        request_id: requestId,
        data: payload,
        trace: { gateway_method: "slm.control.session.start" },
      });
    } catch (error) {
      handleApiError(error, res, requestId);
    }
  });

  app.post("/api/slm/session/:sessionId/turn", async (req, res) => {
    const requestId = withRequestId(req);
    try {
      const session = getRequiredSession(req);
      const sessionId = parseRequestBody(finishSessionSchema, { session_id: req.params.sessionId }).session_id;
      const body = parseRequestBody(turnSchema, req.body);
      const payload = await invokeGateway<{ turn: unknown; session: unknown; supervisor: unknown }>(
        params.gatewayClient,
        "slm.control.session.turn",
        {
          tenant_id: session.tenantId,
          session_id: sessionId,
          user_prompt: body.user_prompt,
          edited_answer: body.edited_answer,
        },
      );
      res.status(200).json({
        ok: true,
        request_id: requestId,
        data: payload,
        trace: { gateway_method: "slm.control.session.turn" },
      });
    } catch (error) {
      handleApiError(error, res, requestId);
    }
  });

  app.post("/api/slm/session/:sessionId/finish", async (req, res) => {
    const requestId = withRequestId(req);
    try {
      const session = getRequiredSession(req);
      const sessionId = parseRequestBody(finishSessionSchema, { session_id: req.params.sessionId }).session_id;
      const payload = await invokeGateway<{ session: unknown }>(
        params.gatewayClient,
        "slm.control.session.finish",
        {
          tenant_id: session.tenantId,
          session_id: sessionId,
        },
      );
      res.status(200).json({
        ok: true,
        request_id: requestId,
        data: payload,
        trace: { gateway_method: "slm.control.session.finish" },
      });
    } catch (error) {
      handleApiError(error, res, requestId);
    }
  });

  app.post("/api/slm/training/enqueue", async (req, res) => {
    const requestId = withRequestId(req);
    try {
      const session = getRequiredSession(req);
      const body = parseRequestBody(trainingSchema, req.body);
      const payload = await invokeGateway<{
        dataset_id: string;
        run_id: string;
        status: string;
        attempts: number;
      }>(params.gatewayClient, "slm.control.training.enqueue", {
        tenant_id: session.tenantId,
        base_model: body.base_model,
        split_seed: body.split_seed,
        idempotency_key: body.idempotency_key,
      });
      res.status(200).json({
        ok: true,
        request_id: requestId,
        data: payload,
        trace: { gateway_method: "slm.control.training.enqueue" },
      });
    } catch (error) {
      handleApiError(error, res, requestId);
    }
  });

  app.use("/api", (req, res) => {
    const requestId = withRequestId(req);
    jsonError(res, requestId, 404, "not_found", "route not found");
  });

  app.use(express.static(params.clientDir, { index: "index.html" }));
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    res.sendFile(path.join(params.clientDir, "index.html"));
  });

  return { app, sessionStore };
}

function handleApiError(error: unknown, res: Response, requestId: string): void {
  if (error instanceof ApiError) {
    jsonError(res, requestId, error.status, error.code, error.message, error.details);
    return;
  }
  if (error instanceof z.ZodError) {
    jsonError(res, requestId, 400, "invalid_request", "request validation failed", error.flatten());
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  jsonError(res, requestId, 500, "internal_error", message);
}
