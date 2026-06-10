import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Zoom webhook signature using HMAC-SHA256.
 * https://developers.zoom.us/docs/api/rest/webhook-reference/#verify-webhook-events
 *
 * Zoom sends:
 * - x-zm-signature: v0=<hash>
 * - x-zm-request-timestamp: <timestamp>
 *
 * Message format: v0:<timestamp>:<payload>
 */
export function verifyZoomWebhook(params: {
  payload: string;
  signature: string;
  timestamp: string;
  secret: string;
}): boolean {
  const { payload, signature, timestamp, secret } = params;

  if (!signature || !timestamp || !secret) {
    return false;
  }

  // Build message: v0:<timestamp>:<payload>
  const message = `v0:${timestamp}:${payload}`;

  // Compute expected hash
  const hash = createHmac("sha256", secret).update(message).digest("hex");
  const expected = `v0=${hash}`;

  // Use timing-safe comparison
  try {
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

/**
 * Handle Zoom URL validation challenge.
 * When Zoom validates the webhook URL, it sends a challenge that must be
 * hashed and returned.
 *
 * https://developers.zoom.us/docs/api/rest/webhook-reference/#validate-your-webhook-endpoint
 */
export function handleZoomChallenge(params: { plainToken: string; secret: string }): {
  plainToken: string;
  encryptedToken: string;
} {
  const { plainToken, secret } = params;

  const encryptedToken = createHmac("sha256", secret).update(plainToken).digest("hex");

  return {
    plainToken,
    encryptedToken,
  };
}

// Minimal request/response shapes so the handler is unit-testable without express.
type WebhookRequest = {
  body?: { event?: string; payload?: { plainToken?: string } } & Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: string;
};
type WebhookResponse = {
  status: (code: number) => { json: (body: unknown) => void };
  headersSent?: boolean;
};
// debug is optional to match the runtime child logger's shape.
type WebhookLogger = {
  debug?: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

/**
 * Webhook intake handler — FAIL-CLOSED. Without a configured webhookSecretToken
 * every request is rejected 401: this endpoint is internet-facing (the zoom
 * plugin runs its own express listener behind a public reverse proxy) and an
 * unsigned webhook would otherwise drive the full button/command tree and
 * upload-token minting. A missing secret must never silently disable auth.
 */
export function createZoomWebhookRequestHandler(deps: {
  webhookSecretToken: string | undefined;
  log: WebhookLogger;
  handleMessage: (body: unknown) => Promise<void>;
}) {
  const { webhookSecretToken, log, handleMessage } = deps;

  return async function handleWebhookRequest(
    req: WebhookRequest,
    res: WebhookResponse,
  ): Promise<void> {
    try {
      const rawBody = req.rawBody ?? JSON.stringify(req.body);
      const signature = req.headers["x-zm-signature"] as string | undefined;
      const timestamp = req.headers["x-zm-request-timestamp"] as string | undefined;

      // Fail closed: no secret configured means no request can be authenticated.
      if (!webhookSecretToken) {
        log.error(
          "webhook rejected: ZOOM_WEBHOOK_SECRET_TOKEN / channels.zoom.webhookSecretToken not configured (fail-closed)",
        );
        res.status(401).json({ error: "webhook secret not configured" });
        return;
      }

      // Handle URL validation challenge
      if (req.body?.event === "endpoint.url_validation") {
        const plainToken = req.body.payload?.plainToken;
        if (plainToken) {
          const challenge = handleZoomChallenge({ plainToken, secret: webhookSecretToken });
          log.debug?.("responding to URL validation challenge");
          res.status(200).json(challenge);
          return;
        }
        log.warn("URL validation received but missing plainToken");
        res.status(400).json({ error: "missing challenge data" });
        return;
      }

      if (!signature || !timestamp) {
        log.warn("missing webhook signature headers");
        res.status(401).json({ error: "missing signature" });
        return;
      }

      const valid = verifyZoomWebhook({
        payload: rawBody,
        signature,
        timestamp,
        secret: webhookSecretToken,
      });

      if (!valid) {
        log.warn("invalid webhook signature");
        res.status(401).json({ error: "invalid signature" });
        return;
      }

      // Acknowledge webhook immediately
      res.status(200).json({ status: "ok" });

      // Process message asynchronously
      await handleMessage(req.body);
    } catch (err) {
      log.error(
        "webhook handler failed: " +
          (err instanceof Error ? err.stack || err.message : String(err)),
      );
      if (!res.headersSent) {
        res.status(500).json({ error: "internal error" });
      }
    }
  };
}
