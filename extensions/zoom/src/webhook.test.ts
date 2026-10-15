import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  createZoomWebhookRequestHandler,
  handleZoomChallenge,
  verifyZoomWebhook,
} from "./webhook.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1234567890_000);
});
afterEach(() => vi.useRealTimers());

describe("verifyZoomWebhook", () => {
  const secret = "test-secret-token";

  it("returns true for valid signature", () => {
    const timestamp = "1234567890";
    const payload = '{"event":"bot_notification"}';
    // Pre-computed: v0:1234567890:{"event":"bot_notification"} with secret "test-secret-token"
    const message = `v0:${timestamp}:${payload}`;
    const hash = createHmac("sha256", secret).update(message).digest("hex");
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
    const hash = createHmac("sha256", secret).update(`v0:${timestamp}:${payload}`).digest("hex");
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

describe("signed webhook freshness", () => {
  const secret = "synthetic-freshness-secret";
  const payload = '{"event":"bot_notification"}';
  const sign = (timestamp: string) =>
    `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${payload}`).digest("hex")}`;
  it.each(Array.from({ length: 333 }, (_, i) => i - 301))(
    "enforces inclusive age/skew bounds for offset %ds",
    (offset) => {
      const timestamp = String(1234567890 + offset);
      expect(verifyZoomWebhook({ payload, timestamp, signature: sign(timestamp), secret })).toBe(
        offset >= -300 && offset <= 30,
      );
    },
  );
  it.each([
    [-30_001, false],
    [-30_000, true],
    [-29_999, true],
    [300_000, true],
    [300_999, true],
    [301_000, false],
  ])("uses integer Unix seconds at clock boundary %dms", (clockOffset, accepted) => {
    vi.setSystemTime(1234567890_000 + clockOffset);
    const timestamp = "1234567890";
    expect(verifyZoomWebhook({ payload, timestamp, signature: sign(timestamp), secret })).toBe(
      accepted,
    );
  });

  it.each([
    "1",
    "",
    "0",
    "-1",
    "01234567890",
    "+1234567890",
    "1234567890.0",
    "1.23456789e9",
    "1234567890 ",
    "NaN",
    "Infinity",
    "9007199254740992",
  ])("refuses signed noncanonical or ancient timestamp %s", (timestamp) => {
    expect(verifyZoomWebhook({ payload, timestamp, signature: sign(timestamp), secret })).toBe(
      false,
    );
  });
  it.each(["timestamp", "signature", "ancient"])(
    "does not dispatch %s header attack",
    async (kind) => {
      const timestamp = kind === "ancient" ? "1" : "1234567890";
      const handleMessage = vi.fn();
      const json = vi.fn();
      const status = vi.fn(() => ({ json }));
      const handler = createZoomWebhookRequestHandler({
        webhookSecretToken: secret,
        log: { warn() {}, error() {} },
        handleMessage,
      });
      await handler(
        {
          rawBody: payload,
          body: { event: "bot_notification" },
          headers: {
            "x-zm-request-timestamp": kind === "timestamp" ? [timestamp] : timestamp,
            "x-zm-signature": kind === "signature" ? [sign(timestamp)] : sign(timestamp),
          },
        },
        { status },
      );
      expect(status).toHaveBeenCalledWith(401);
      expect(handleMessage).not.toHaveBeenCalled();
    },
  );
});

describe("webhook rejection diagnostics", () => {
  const secret = "synthetic-diagnostic-secret";
  it.each([
    ["expired_timestamp", -301],
    ["future_timestamp", 31],
  ])("logs %s distinctly without exposing headers or payload", async (reason, offset) => {
    const timestamp = String(1234567890 + Number(offset));
    const body = { event: "bot_notification", payload: { plainToken: "synthetic-sensitive-body" } };
    const rawBody = JSON.stringify(body);
    const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
    const warn = vi.fn();
    const handleMessage = vi.fn();
    const handler = createZoomWebhookRequestHandler({
      webhookSecretToken: secret,
      log: { warn, debug: vi.fn(), error: vi.fn() },
      handleMessage,
    });
    const status = vi.fn().mockReturnValue({ json: vi.fn() });
    await handler(
      {
        body,
        rawBody,
        headers: { "x-zm-signature": signature, "x-zm-request-timestamp": timestamp },
      },
      { status },
    );
    expect(status).toHaveBeenCalledWith(401);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(`zoom webhook rejected: ${reason}`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(signature);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(timestamp);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(body.payload.plainToken);
  });
  it.each(["synthetic-bot-a", "synthetic-bot-b"])(
    "freshly signed old events retain dispatch for %s",
    async (bot) => {
      const timestamp = "1234567890";
      const body = {
        event: "bot_notification",
        event_ts: (1234567890 - 5100) * 1000,
        payload: { plainToken: bot },
      };
      const rawBody = JSON.stringify(body);
      const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
      const handleMessage = vi.fn();
      const handler = createZoomWebhookRequestHandler({
        webhookSecretToken: secret,
        log: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
        handleMessage,
      });
      const status = vi.fn().mockReturnValue({ json: vi.fn() });
      await handler(
        {
          body,
          rawBody,
          headers: { "x-zm-signature": signature, "x-zm-request-timestamp": timestamp },
        },
        { status },
      );
      expect(status).toHaveBeenCalledWith(200);
      expect(handleMessage).toHaveBeenCalledWith(body);
    },
  );
});
