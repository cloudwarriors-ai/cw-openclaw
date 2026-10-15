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
type ZoomWebhookVerification = {
  payload: string;
  signature: string;
  timestamp: string;
  secret: string;
};
type ZoomWebhookRejection =
  | "missing_signature"
  | "malformed_timestamp"
  | "expired_timestamp"
  | "future_timestamp"
  | "invalid_signature";

/** Bounded diagnostic labels only; never log credentials, headers or payloads. */
export function zoomWebhookRejection(
  params: ZoomWebhookVerification,
): ZoomWebhookRejection | undefined {
  const { payload, signature, timestamp, secret } = params;
  if (!signature || !timestamp || !secret) {
    return "missing_signature";
  }
  if (!/^[1-9]\d{0,15}$/.test(timestamp)) {
    return "malformed_timestamp";
  }
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) {
    return "malformed_timestamp";
  }
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${payload}`).digest("hex")}`;
  try {
    const actual = Buffer.from(signature);
    const wanted = Buffer.from(expected);
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
      return "invalid_signature";
    }
  } catch {
    return "invalid_signature";
  }
  // Same freshness policy; diagnostics distinguish signed clock/delivery issues
  // from HMAC failures. event_ts is not this signed request-header timestamp.
  const now = Math.floor(Date.now() / 1000);
  if (seconds < now - 300) {
    return "expired_timestamp";
  }
  if (seconds > now + 30) {
    return "future_timestamp";
  }
  return undefined;
}

export function verifyZoomWebhook(params: ZoomWebhookVerification): boolean {
  return zoomWebhookRejection(params) === undefined;
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
      const signature = req.headers["x-zm-signature"];
      const timestamp = req.headers["x-zm-request-timestamp"];

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

      if (
        typeof signature !== "string" ||
        typeof timestamp !== "string" ||
        !signature ||
        !timestamp
      ) {
        log.warn("missing webhook signature headers");
        res.status(401).json({ error: "missing signature" });
        return;
      }

      const rejection = zoomWebhookRejection({
        payload: rawBody,
        signature,
        timestamp,
        secret: webhookSecretToken,
      });

      if (rejection) {
        log.warn(`zoom webhook rejected: ${rejection}`);
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
