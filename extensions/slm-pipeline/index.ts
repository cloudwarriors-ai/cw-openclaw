import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { enforceSlmHttpAuth, resolveSlmHttpAuthConfig } from "./src/http-auth.js";
import { PipelineAppService, type PipelineReviewEventSink } from "./src/app-service.js";
import { registerSlmPipelineGatewayMethods } from "./src/gateway-methods.js";
import { resolveMemoryServerClientFromEnv } from "./src/memory-client.js";
import {
  JsonlSlmPipelineEventSink,
  resolveDefaultSlmPipelineEventsPath,
} from "./src/pipeline-events.js";
import { JsonlReviewEventQaSource, resolveDefaultZoomReviewEventsPath } from "./src/qa-ingest.js";
import { QaProjectionService } from "./src/qa-projection.js";
import { emitPipelineReviewEvent } from "./src/review-events.js";
import { createSlmPipelineRouter } from "./src/routes.js";
import {
  JsonFileSlmPipelineStateStore,
  resolveDefaultSlmPipelineStatePath,
} from "./src/state-store.js";
import { resolveTrainingExecutorFromEnv } from "./src/training-orchestrator.js";

const plugin = {
  id: "slm-pipeline",
  name: "SLM Pipeline",
  description: "Approved Q&A import, dataset build, training runs, and eval feedback routes",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const stateDir = api.runtime.state.resolveStateDir(process.env);
    const qaSource = new JsonlReviewEventQaSource(resolveDefaultZoomReviewEventsPath(stateDir));
    const stateStore = new JsonFileSlmPipelineStateStore(
      resolveDefaultSlmPipelineStatePath(stateDir),
    );
    const eventSink = new JsonlSlmPipelineEventSink(resolveDefaultSlmPipelineEventsPath(stateDir));
    const router = createSlmPipelineRouter({
      qaSource,
      stateStore,
      eventSink,
      trainingExecutor: resolveTrainingExecutorFromEnv(process.env),
    });
    const memoryClient = resolveMemoryServerClientFromEnv(process.env);
    const qaProjectionService = new QaProjectionService(memoryClient);
    const reviewEventSink: PipelineReviewEventSink = {
      emitApprovedEvent: async (input) => {
        const event = await emitPipelineReviewEvent({
          tenantId: input.tenantId,
          eventType: "qa.approved",
          traceId: input.traceId,
          refId: input.refId,
          actorId: input.actor?.actor_id,
          actorName: input.actor?.actor_name,
          sourceChannelJid: input.sourceChannelJid,
          question: input.question,
          answer: input.answer,
          metadata: input.metadata,
          storePath: resolveDefaultZoomReviewEventsPath(stateDir),
        });
        return {
          traceId: event.trace_id,
          refId: event.ref_id,
        };
      },
    };
    const appService = new PipelineAppService(router, qaProjectionService, reviewEventSink);
    const slmHttpAuthConfig = resolveSlmHttpAuthConfig(process.env);

    registerSlmPipelineGatewayMethods(api, appService);

    api.registerHttpHandler(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!isPipelineHttpPath(url.pathname)) {
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

function isPipelineHttpPath(pathname: string): boolean {
  if (!pathname.startsWith("/v1/slm/")) {
    return false;
  }
  if (pathname.startsWith("/v1/slm/supervisor/")) {
    return false;
  }
  return true;
}
