import fs from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { createZoomConversationStoreFs } from "./conversation-store-fs.js";
import type { ZoomConversationStore } from "./conversation-store.js";
import { createZoomMessageHandler } from "./monitor-handler.js";
import type { ZoomMonitorLogger } from "./monitor-types.js";
import { getZoomRuntime } from "./runtime.js";
import { resolveZoomCredentials } from "./token.js";
import type { ZoomConfig, ZoomWebhookEvent } from "./types.js";
import { createUploadRoutes } from "./upload-handler.js";
import { isWithinUploadDir, resolveZoomUploadDir, UPLOAD_TTL_MS } from "./upload-path.js";
import { createZoomWebhookRequestHandler } from "./webhook.js";

export type MonitorZoomOpts = {
  cfg: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  conversationStore?: ZoomConversationStore;
};

export type MonitorZoomResult = {
  app: unknown;
  shutdown: () => Promise<void>;
};

export async function monitorZoomProvider(opts: MonitorZoomOpts): Promise<MonitorZoomResult> {
  const core = getZoomRuntime();
  const log = core.logging.getChildLogger({ name: "zoom" });
  const cfg = opts.cfg;
  const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;

  if (!zoomCfg?.enabled) {
    log.debug("zoom provider disabled");
    return { app: null, shutdown: async () => {} };
  }

  const creds = resolveZoomCredentials(zoomCfg);
  if (!creds) {
    log.error("zoom credentials not configured");
    return { app: null, shutdown: async () => {} };
  }
  if (!creds.webhookSecretToken) {
    // Loud at startup, enforced per-request: the webhook handler is fail-closed
    // and will 401 everything until the secret is configured.
    log.error(
      "ZOOM_WEBHOOK_SECRET_TOKEN is not set — all inbound webhooks will be REJECTED (fail-closed). " +
        "Set channels.zoom.webhookSecretToken or the env var to accept Zoom traffic.",
    );
  }

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const port = zoomCfg.webhook?.port ?? 4000;
  const webhookPath = zoomCfg.webhook?.path ?? "/zoom/webhook";
  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "zoom");
  const conversationStore = opts.conversationStore ?? createZoomConversationStoreFs();

  log.info(`starting provider (port ${port})`);

  // Dynamic import to avoid loading express when provider is disabled
  const express = await import("express");

  const expressApp = express.default();

  // Custom body parser to get raw body for signature verification
  expressApp.use(
    webhookPath,
    express.json({
      verify: (req: Request, _res: Response, buf: Buffer) => {
        // Store raw body for signature verification
        (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );

  // Also add general JSON parser for other routes (skip /zoom/file — has its own 15mb parser)
  expressApp.use((req: Request, res: Response, next: () => void) => {
    if (req.path === "/zoom/file") return next();
    express.json()(req, res, next);
  });

  const handleMessage = createZoomMessageHandler({
    cfg,
    runtime,
    creds,
    textLimit,
    conversationStore,
    log: log as ZoomMonitorLogger,
  });

  // File-upload routes
  const uploadRoutes = createUploadRoutes({
    cfg,
    runtime,
    creds,
    textLimit,
    conversationStore,
    log: log as ZoomMonitorLogger,
  });
  expressApp.get("/zoom/file", uploadRoutes.handleGet);
  expressApp.post("/zoom/file", express.json({ limit: "15mb" }), uploadRoutes.handlePost);

  // Serve uploaded files. Gated: path must resolve inside the uploads dir, the
  // file must be younger than UPLOAD_TTL_MS (a download URL is a bearer secret —
  // leaked links must expire), and dotfiles are denied.
  const uploadDir = resolveZoomUploadDir();
  expressApp.use(
    "/zoom/uploads",
    (req: Request, res: Response, next: () => void) => {
      let rel: string;
      try {
        rel = decodeURIComponent(req.path.replace(/^\/+/, ""));
      } catch {
        res.status(404).end();
        return;
      }
      const resolved = path.resolve(uploadDir, rel);
      if (!isWithinUploadDir(resolved)) {
        res.status(404).end();
        return;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved);
      } catch {
        res.status(404).end();
        return;
      }
      if (!stat.isFile() || Date.now() - stat.mtimeMs > UPLOAD_TTL_MS) {
        res.status(404).end();
        return;
      }
      next();
    },
    express.static(uploadDir, { dotfiles: "deny" }),
  );

  // Webhook endpoint. Fail-closed: rejects everything when no secret is set.
  const handleWebhookRequest = createZoomWebhookRequestHandler({
    webhookSecretToken: creds.webhookSecretToken,
    log,
    // The factory hands back the signature-verified request body; it is the
    // Zoom webhook event shape the message handler expects.
    handleMessage: (body) => handleMessage(body as ZoomWebhookEvent),
  });
  // Non-async express handler: handleWebhookRequest never rejects (it owns a
  // catch-all and answers 500 itself), so void-ing the promise is safe and
  // avoids the unhandled-rejection hazard of async endpoint handlers.
  expressApp.post(webhookPath, (req: Request, res: Response) => {
    void handleWebhookRequest(
      Object.assign(req, { rawBody: (req as Request & { rawBody?: string }).rawBody }),
      res,
    );
  });

  // Health check endpoint
  expressApp.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", channel: "zoom" });
  });

  log.debug("listening on path", { path: webhookPath });

  // Return a promise that stays pending until shutdown
  return new Promise<MonitorZoomResult>((resolve) => {
    const httpServer = expressApp.listen(port, () => {
      log.info(`zoom provider started on port ${port}`);
    });

    httpServer.on("error", (err) => {
      log.error("zoom server error", { error: String(err) });
    });

    const shutdown = async () => {
      log.info("shutting down zoom provider");
      return new Promise<void>((resolveShutdown) => {
        httpServer.close((err) => {
          if (err) {
            log.debug("zoom server close error", { error: String(err) });
          }
          resolveShutdown();
          resolve({ app: expressApp, shutdown });
        });
      });
    };

    // Handle abort signal - this is the only way the provider stops
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener("abort", () => {
        void shutdown();
      });
    }
  });
}
