import { describe, it, expect, vi } from "vitest";
import {
  createZoomWebhookRequestHandler,
  handleZoomChallenge,
  verifyZoomWebhook,
} from "./webhook.js";

describe("verifyZoomWebhook", () => {
  const secret = "test-secret-token";

  it("returns true for valid signature", () => {
    const timestamp = "1234567890";
    const payload = '{"event":"bot_notification"}';
    // Pre-computed: v0:1234567890:{"event":"bot_notification"} with secret "test-secret-token"
    const crypto = require("node:crypto");
    const message = `v0:${timestamp}:${payload}`;
    const hash = crypto.createHmac("sha256", secret).update(message).digest("hex");
    const signature = `v0=${hash}`;

    const result = verifyZoomWebhook({ payload, signature, timestamp, secret });
    expect(result).toBe(true);
  });

  it("returns false for invalid signature", () => {
    const result = verifyZoomWebhook({
      payload: '{"event":"bot_notification"}',
      signature: "v0=invalid",
      timestamp: "1234567890",
      secret,
    });
    expect(result).toBe(false);
  });

  it("returns false for missing signature", () => {
    const result = verifyZoomWebhook({
      payload: '{"event":"bot_notification"}',
      signature: "",
      timestamp: "1234567890",
      secret,
    });
    expect(result).toBe(false);
  });

  it("returns false for missing timestamp", () => {
    const result = verifyZoomWebhook({
      payload: '{"event":"bot_notification"}',
      signature: "v0=abc",
      timestamp: "",
      secret,
    });
    expect(result).toBe(false);
  });

  it("returns false for missing secret", () => {
    const result = verifyZoomWebhook({
      payload: '{"event":"bot_notification"}',
      signature: "v0=abc",
      timestamp: "1234567890",
      secret: "",
    });
    expect(result).toBe(false);
  });
});

describe("handleZoomChallenge", () => {
  it("returns correct encrypted token", () => {
    const plainToken = "test-plain-token";
    const secret = "test-secret";

    const result = handleZoomChallenge({ plainToken, secret });

    expect(result.plainToken).toBe(plainToken);
    expect(result.encryptedToken).toBeDefined();
    expect(result.encryptedToken.length).toBe(64); // SHA256 hex is 64 chars

    // Verify it's deterministic
    const result2 = handleZoomChallenge({ plainToken, secret });
    expect(result2.encryptedToken).toBe(result.encryptedToken);
  });

  it("produces different tokens for different secrets", () => {
    const plainToken = "test-plain-token";

    const result1 = handleZoomChallenge({ plainToken, secret: "secret1" });
    const result2 = handleZoomChallenge({ plainToken, secret: "secret2" });

    expect(result1.encryptedToken).not.toBe(result2.encryptedToken);
  });
});

describe("createZoomWebhookRequestHandler (fail-closed intake)", () => {
  const secret = "test-secret-token";
  const noopLog = { debug: () => {}, warn: () => {}, error: () => {} };

  function makeRes() {
    const out: { code?: number; body?: unknown } = {};
    return {
      res: {
        status(code: number) {
          out.code = code;
          return { json: (body: unknown) => void (out.body = body) };
        },
      },
      out,
    };
  }

  function sign(payload: string, timestamp: string): string {
    const crypto = require("node:crypto");
    const hash = crypto
      .createHmac("sha256", secret)
      .update(`v0:${timestamp}:${payload}`)
      .digest("hex");
    return `v0=${hash}`;
  }

  it("rejects EVERY request with 401 when no secret is configured (fail-closed)", async () => {
    const handleMessage = vi.fn();
    const handler = createZoomWebhookRequestHandler({
      webhookSecretToken: undefined,
      log: noopLog,
      handleMessage,
    });
    const { res, out } = makeRes();
    // Even a correctly-shaped, signed-looking request must be rejected.
    const payload = '{"event":"bot_notification"}';
    await handler(
      {
        body: { event: "bot_notification" },
        headers: { "x-zm-signature": "v0=deadbeef", "x-zm-request-timestamp": "123" },
        rawBody: payload,
      },
      res,
    );
    expect(out.code).toBe(401);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("accepts a correctly signed request and dispatches it", async () => {
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const handler = createZoomWebhookRequestHandler({
      webhookSecretToken: secret,
      log: noopLog,
      handleMessage,
    });
    const { res, out } = makeRes();
    const payload = '{"event":"bot_notification"}';
    const timestamp = "1234567890";
    await handler(
      {
        body: { event: "bot_notification" },
        headers: {
          "x-zm-signature": sign(payload, timestamp),
          "x-zm-request-timestamp": timestamp,
        },
        rawBody: payload,
      },
      res,
    );
    expect(out.code).toBe(200);
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects a bad signature and does not dispatch", async () => {
    const handleMessage = vi.fn();
    const handler = createZoomWebhookRequestHandler({
      webhookSecretToken: secret,
      log: noopLog,
      handleMessage,
    });
    const { res, out } = makeRes();
    await handler(
      {
        body: { event: "bot_notification" },
        headers: { "x-zm-signature": "v0=wrong", "x-zm-request-timestamp": "1234567890" },
        rawBody: '{"event":"bot_notification"}',
      },
      res,
    );
    expect(out.code).toBe(401);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("rejects when signature headers are missing", async () => {
    const handleMessage = vi.fn();
    const handler = createZoomWebhookRequestHandler({
      webhookSecretToken: secret,
      log: noopLog,
      handleMessage,
    });
    const { res, out } = makeRes();
    await handler({ body: { event: "bot_notification" }, headers: {}, rawBody: "{}" }, res);
    expect(out.code).toBe(401);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("answers the URL validation challenge when the secret is configured", async () => {
    const handler = createZoomWebhookRequestHandler({
      webhookSecretToken: secret,
      log: noopLog,
      handleMessage: vi.fn(),
    });
    const { res, out } = makeRes();
    await handler(
      {
        body: { event: "endpoint.url_validation", payload: { plainToken: "abc" } },
        headers: {},
        rawBody: "{}",
      },
      res,
    );
    expect(out.code).toBe(200);
    expect((out.body as { encryptedToken: string }).encryptedToken).toBe(
      handleZoomChallenge({ plainToken: "abc", secret }).encryptedToken,
    );
  });
});
