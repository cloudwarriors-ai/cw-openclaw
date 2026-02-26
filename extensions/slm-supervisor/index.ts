import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { SlmSupervisorAppService } from "./src/app-service.js";
import { registerSlmPilotCommand } from "./src/command-mode.js";
import { registerSlmSupervisorGatewayMethods } from "./src/gateway-methods.js";
import { enforceSlmHttpAuth, resolveSlmHttpAuthConfig } from "./src/http-auth.js";
import { resolveMemoryServerClientFromEnv } from "./src/memory-client.js";
import { SlmSupervisorOrchestrator } from "./src/orchestrator.js";
import { createSlmSupervisorRouter } from "./src/routes.js";
import { resolveTraceExporterFromEnv } from "./src/trace-exporter.js";
import { TrainingStudioService } from "./src/training-studio.js";

const plugin = {
  id: "slm-supervisor",
  name: "SLM Supervisor",
  description: "SLM-first answer policy with supervisor fallback",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const orchestrator = new SlmSupervisorOrchestrator(
      undefined,
      undefined,
      undefined,
      undefined,
      resolveTraceExporterFromEnv(process.env),
      undefined,
      (error, trace) => {
        api.logger.warn("slm-supervisor: trace export failed", {
          error: error instanceof Error ? error.message : String(error),
          traceId: trace.trace_id,
          tenantId: trace.tenant_id,
        });
      },
    );
    const trainingStudio = new TrainingStudioService(
      orchestrator,
      resolveMemoryServerClientFromEnv(process.env),
    );
    const appService = new SlmSupervisorAppService(orchestrator, trainingStudio);

    registerSlmSupervisorGatewayMethods(api, appService);
    registerSlmPilotCommand(api, appService, process.env);
    const router = createSlmSupervisorRouter({ appService, orchestrator });
    const slmHttpAuthConfig = resolveSlmHttpAuthConfig(process.env);

    api.registerHttpHandler(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/v1/slm/supervisor/")) {
        return false;
      }
      const authFailure = enforceSlmHttpAuth(
        {
          xOpenclawSlmToken: normalizeHeader(req.headers["x-openclaw-slm-token"]),
        },
        slmHttpAuthConfig,
      );
      if (authFailure) {
        writeResponse(res, authFailure.status, authFailure.body);
        return true;
      }
      const request = await toRouterRequest(req, url);
      const response = await router.handle(request);
      writeResponse(res, response.status, response.body);
      return true;
    });
  },
};

async function toRouterRequest(
  req: IncomingMessage,
  url: URL,
): Promise<{
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: unknown;
}> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  let body: unknown = {};
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      body = { _raw: raw };
    }
  }

  return {
    method: req.method ?? "GET",
    path: url.pathname,
    query: url.searchParams,
    headers: {
      authorization: normalizeHeader(req.headers.authorization),
      "x-openclaw-slm-token": normalizeHeader(req.headers["x-openclaw-slm-token"]),
    },
    body,
  };
}

function normalizeHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function writeResponse(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export default plugin;
