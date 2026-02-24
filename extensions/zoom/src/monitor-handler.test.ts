import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZoomWebhookEvent } from "./types.js";
import { createZoomMessageHandler } from "./monitor-handler.js";
import { setZoomRuntime } from "./runtime.js";

const sendZoomTextMessageMock = vi.fn(async () => undefined);
const zoomApiFetchMock = vi.fn(async () => ({ ok: false, status: 404 }));

vi.mock("./send.js", () => ({
  sendZoomTextMessage: (...args: unknown[]) => sendZoomTextMessageMock(...args),
}));

vi.mock("./api.js", () => ({
  zoomApiFetch: (...args: unknown[]) => zoomApiFetchMock(...args),
}));

type RuntimeMocks = {
  dispatchReplyFromConfig: ReturnType<typeof vi.fn>;
  readAllowFromStore: ReturnType<typeof vi.fn>;
  upsertPairingRequest: ReturnType<typeof vi.fn>;
  buildPairingReply: ReturnType<typeof vi.fn>;
  finalizeInboundContext: ReturnType<typeof vi.fn>;
};

function installRuntime(overrides?: {
  storeAllowFrom?: string[];
  pairingCode?: string;
}): RuntimeMocks {
  const dispatchReplyFromConfig = vi.fn(async () => ({
    queuedFinal: false,
    counts: { final: 0 },
  }));
  const readAllowFromStore = vi.fn(async () => overrides?.storeAllowFrom ?? []);
  const upsertPairingRequest = vi.fn(async () => ({
    code: overrides?.pairingCode ?? "PAIR1234",
    created: true,
  }));
  const buildPairingReply = vi.fn(({ code }: { code: string }) => `Pairing code: ${code}`);
  const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);

  const runtime = {
    state: {
      resolveStateDir: vi.fn(() => "/tmp"),
    },
    channel: {
      pairing: {
        readAllowFromStore,
        upsertPairingRequest,
        buildPairingReply,
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          sessionKey: "rapture:zoom:dm",
          accountId: "default",
          agentId: "rapture",
        })),
      },
      reply: {
        finalizeInboundContext,
        resolveHumanDelayConfig: vi.fn(() => undefined),
        createReplyDispatcherWithTyping: vi.fn(() => ({
          dispatcher: { dispatch: vi.fn() },
          replyOptions: {},
          markDispatchIdle: vi.fn(),
        })),
        dispatchReplyFromConfig,
      },
    },
  } satisfies Partial<PluginRuntime>;

  setZoomRuntime(runtime as PluginRuntime);
  return {
    dispatchReplyFromConfig,
    readAllowFromStore,
    upsertPairingRequest,
    buildPairingReply,
    finalizeInboundContext,
  };
}

function createTestDeps(cfg: OpenClawConfig) {
  const conversationStore = {
    upsert: vi.fn(async () => undefined),
    findByUserJid: vi.fn(async () => null),
  };
  const log = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
  return {
    deps: {
      cfg,
      runtime: {} as RuntimeEnv,
      creds: {
        clientId: "client",
        clientSecret: "secret",
        accountId: "acct",
        botJid: "bot@xmpp.zoom.us",
      },
      textLimit: 2000,
      conversationStore,
      log,
    },
    conversationStore,
  };
}

function makeBotNotificationEvent(params: {
  userJid: string;
  text: string;
  userName?: string;
  userEmail?: string;
  toJid?: string;
  channelName?: string;
}): ZoomWebhookEvent {
  return {
    event: "bot_notification",
    event_ts: Date.now(),
    payload: {
      object: {
        userJid: params.userJid,
        userName: params.userName,
        user_email: params.userEmail,
        text: params.text,
        toJid: params.toJid,
        channelName: params.channelName,
      },
    },
  };
}

describe("createZoomMessageHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    zoomApiFetchMock.mockResolvedValue({ ok: false, status: 404 });
  });

  it("sends a pairing reply for unknown DM senders when dmPolicy=pairing", async () => {
    const runtime = installRuntime({ storeAllowFrom: [], pairingCode: "ZMPAIR99" });
    const cfg = {
      channels: {
        zoom: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    } as OpenClawConfig;
    const { deps, conversationStore } = createTestDeps(cfg);
    const handle = createZoomMessageHandler(deps);

    await handle(
      makeBotNotificationEvent({
        userJid: "unknown@xmpp.zoom.us",
        userName: "Unknown User",
        userEmail: "unknown@example.com",
        text: "hello",
      }),
    );

    expect(runtime.readAllowFromStore).toHaveBeenCalledWith("zoom");
    expect(runtime.upsertPairingRequest).toHaveBeenCalledWith({
      channel: "zoom",
      id: "unknown@xmpp.zoom.us",
      meta: { name: "Unknown User", email: "unknown@example.com" },
    });
    expect(runtime.dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(conversationStore.upsert).not.toHaveBeenCalled();
    expect(sendZoomTextMessageMock).toHaveBeenCalledTimes(1);
    expect(sendZoomTextMessageMock.mock.calls[0]?.[0]).toMatchObject({
      to: "unknown@xmpp.zoom.us",
      isChannel: false,
    });
    expect(sendZoomTextMessageMock.mock.calls[0]?.[0]?.text).toContain("Pairing code: ZMPAIR99");
  });

  it("enforces group allowlist for bot_notification channel messages", async () => {
    const runtime = installRuntime();
    const cfg = {
      channels: {
        zoom: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["allowed@xmpp.zoom.us"],
        },
      },
    } as OpenClawConfig;
    const { deps, conversationStore } = createTestDeps(cfg);
    const handle = createZoomMessageHandler(deps);

    await handle(
      makeBotNotificationEvent({
        userJid: "blocked@xmpp.zoom.us",
        userName: "Blocked User",
        text: "hello",
        toJid: "team@conference.xmpp.zoom.us",
        channelName: "team",
      }),
    );

    expect(conversationStore.upsert).not.toHaveBeenCalled();
    expect(runtime.dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("accepts DM senders from persisted pairing allowlist", async () => {
    const runtime = installRuntime({ storeAllowFrom: ["paired@xmpp.zoom.us"] });
    const cfg = {
      channels: {
        zoom: {
          dmPolicy: "allowlist",
          allowFrom: [],
        },
      },
    } as OpenClawConfig;
    const { deps, conversationStore } = createTestDeps(cfg);
    const handle = createZoomMessageHandler(deps);

    await handle(
      makeBotNotificationEvent({
        userJid: "paired@xmpp.zoom.us",
        userName: "Paired User",
        userEmail: "paired@cloudwarriors.ai",
        text: "status",
      }),
    );

    expect(runtime.readAllowFromStore).toHaveBeenCalledWith("zoom");
    expect(runtime.upsertPairingRequest).not.toHaveBeenCalled();
    expect(conversationStore.upsert).toHaveBeenCalledTimes(1);
    expect(runtime.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const finalCtx = runtime.finalizeInboundContext.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(finalCtx?.SenderEmail).toBe("paired@cloudwarriors.ai");
    expect(finalCtx?.SenderUsername).toBe("paired@cloudwarriors.ai");
  });

  it("threads team_chat operator field into SenderUsername for channel routing", async () => {
    const runtime = installRuntime();
    const cfg = {
      channels: {
        zoom: {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    } as OpenClawConfig;
    const { deps, conversationStore } = createTestDeps(cfg);
    const handle = createZoomMessageHandler(deps);

    const event: ZoomWebhookEvent = {
      event: "team_chat.channel_message_posted",
      event_ts: Date.now(),
      payload: {
        operator: "trent.charlton@cloudwarriors.ai",
        operator_id: "user-123",
        object: {
          channel_id: "team-abc",
          channel_name: "team",
          message: "check status",
          message_id: "msg-1",
        } as unknown as ZoomWebhookEvent["payload"]["object"],
      },
    };

    await handle(event);

    expect(conversationStore.upsert).toHaveBeenCalledTimes(1);
    expect(runtime.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const finalCtx = runtime.finalizeInboundContext.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(finalCtx?.SenderEmail).toBe("trent.charlton@cloudwarriors.ai");
    expect(finalCtx?.SenderUsername).toBe("trent.charlton@cloudwarriors.ai");
  });

  it("does not use operator_email as a fallback when operator is missing", async () => {
    const runtime = installRuntime();
    const cfg = {
      channels: {
        zoom: {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    } as OpenClawConfig;
    const { deps, conversationStore } = createTestDeps(cfg);
    const handle = createZoomMessageHandler(deps);

    const event: ZoomWebhookEvent = {
      event: "team_chat.channel_message_posted",
      event_ts: Date.now(),
      payload: {
        operator_id: "user-123",
        operator_email: "trent.charlton@cloudwarriors.ai",
        object: {
          channel_id: "team-abc",
          channel_name: "team",
          message: "check status",
          message_id: "msg-1",
        } as unknown as ZoomWebhookEvent["payload"]["object"],
      },
    };

    await handle(event);

    expect(conversationStore.upsert).toHaveBeenCalledTimes(1);
    expect(runtime.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const finalCtx = runtime.finalizeInboundContext.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(finalCtx?.SenderUsername).toBeUndefined();
  });

  it("does not use operator_email as a fallback for bot_notification", async () => {
    const runtime = installRuntime();
    const cfg = {
      channels: {
        zoom: {
          dmPolicy: "open",
        },
      },
    } as OpenClawConfig;
    const { deps, conversationStore } = createTestDeps(cfg);
    const handle = createZoomMessageHandler(deps);

    const event: ZoomWebhookEvent = {
      event: "bot_notification",
      event_ts: Date.now(),
      payload: {
        object: {
          userJid: "user-123@xmpp.zoom.us",
          userName: "Trent",
          operator_email: "trent.charlton@cloudwarriors.ai",
          text: "status",
        } as unknown as ZoomWebhookEvent["payload"]["object"],
      },
    };

    await handle(event);

    expect(conversationStore.upsert).toHaveBeenCalledTimes(1);
    expect(runtime.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const finalCtx = runtime.finalizeInboundContext.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(finalCtx?.SenderUsername).toBeUndefined();
  });

  it("resolves bot_notification sender email from user JID via Zoom users API", async () => {
    zoomApiFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: { id: "user-123", email: "trent.charlton@cloudwarriors.ai" },
    });
    const runtime = installRuntime();
    const cfg = {
      channels: {
        zoom: {
          dmPolicy: "open",
        },
      },
    } as OpenClawConfig;
    const { deps, conversationStore } = createTestDeps(cfg);
    const handle = createZoomMessageHandler(deps);

    const event: ZoomWebhookEvent = {
      event: "bot_notification",
      event_ts: Date.now(),
      payload: {
        object: {
          userJid: "user-123@xmpp.zoom.us",
          userName: "Trent",
          text: "status",
        } as unknown as ZoomWebhookEvent["payload"]["object"],
      },
    };

    await handle(event);

    expect(zoomApiFetchMock).toHaveBeenCalled();
    expect(conversationStore.upsert).toHaveBeenCalledTimes(1);
    const finalCtx = runtime.finalizeInboundContext.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(finalCtx?.SenderEmail).toBe("trent.charlton@cloudwarriors.ai");
    expect(finalCtx?.SenderUsername).toBe("trent.charlton@cloudwarriors.ai");
  });

  it("resolves bot_notification sender email when webhook uses snake_case user_jid", async () => {
    zoomApiFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: { id: "user-123", email: "trent.charlton@cloudwarriors.ai" },
    });
    const runtime = installRuntime();
    const cfg = {
      channels: {
        zoom: {
          dmPolicy: "open",
        },
      },
    } as OpenClawConfig;
    const { deps, conversationStore } = createTestDeps(cfg);
    const handle = createZoomMessageHandler(deps);

    const event: ZoomWebhookEvent = {
      event: "bot_notification",
      event_ts: Date.now(),
      payload: {
        object: {
          user_jid: "user-123@xmpp.zoom.us",
          user_name: "Trent",
          text: "status",
        } as unknown as ZoomWebhookEvent["payload"]["object"],
      },
    };

    await handle(event);

    expect(zoomApiFetchMock).toHaveBeenCalled();
    expect(conversationStore.upsert).toHaveBeenCalledTimes(1);
    const finalCtx = runtime.finalizeInboundContext.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(finalCtx?.SenderEmail).toBe("trent.charlton@cloudwarriors.ai");
    expect(finalCtx?.SenderUsername).toBe("trent.charlton@cloudwarriors.ai");
  });

  it("resolves bot_notification sender email by matching JID-derived ID against users list", async () => {
    zoomApiFetchMock.mockImplementation(async (_creds: unknown, endpoint: string) => {
      if (endpoint.startsWith("/users?")) {
        return {
          ok: true,
          status: 200,
          data: {
            users: [
              { id: "MCzsBUKYQle4uyqBHCew3Q", email: "trent.charlton@cloudwarriors.ai" },
              { id: "someone-else", email: "someone@example.com" },
            ],
          },
        };
      }
      return {
        ok: false,
        status: 404,
        error: '{"code":1001,"message":"User does not exist"}',
      };
    });

    const runtime = installRuntime();
    const cfg = {
      channels: {
        zoom: {
          dmPolicy: "open",
        },
      },
    } as OpenClawConfig;
    const { deps, conversationStore } = createTestDeps(cfg);
    const handle = createZoomMessageHandler(deps);

    const event: ZoomWebhookEvent = {
      event: "bot_notification",
      event_ts: Date.now(),
      payload: {
        object: {
          userJid: "mczsbukyqle4uyqbhcew3q@xmpp.zoom.us",
          userName: "Trent",
          text: "status",
        } as unknown as ZoomWebhookEvent["payload"]["object"],
      },
    };

    await handle(event);

    expect(zoomApiFetchMock).toHaveBeenCalled();
    expect(conversationStore.upsert).toHaveBeenCalledTimes(1);
    const finalCtx = runtime.finalizeInboundContext.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(finalCtx?.SenderEmail).toBe("trent.charlton@cloudwarriors.ai");
    expect(finalCtx?.SenderUsername).toBe("trent.charlton@cloudwarriors.ai");
  });

  it("resolves team_chat sender email from operator_id via Zoom users API", async () => {
    zoomApiFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: { id: "user-123", email: "trent.charlton@cloudwarriors.ai" },
    });
    const runtime = installRuntime();
    const cfg = {
      channels: {
        zoom: {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    } as OpenClawConfig;
    const { deps, conversationStore } = createTestDeps(cfg);
    const handle = createZoomMessageHandler(deps);

    const event: ZoomWebhookEvent = {
      event: "team_chat.channel_message_posted",
      event_ts: Date.now(),
      payload: {
        operator_id: "user-123",
        object: {
          channel_id: "team-abc",
          channel_name: "team",
          message: "check status",
          message_id: "msg-1",
        } as unknown as ZoomWebhookEvent["payload"]["object"],
      },
    };

    await handle(event);

    expect(zoomApiFetchMock).toHaveBeenCalled();
    expect(conversationStore.upsert).toHaveBeenCalledTimes(1);
    const finalCtx = runtime.finalizeInboundContext.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(finalCtx?.SenderEmail).toBe("trent.charlton@cloudwarriors.ai");
    expect(finalCtx?.SenderUsername).toBe("trent.charlton@cloudwarriors.ai");
  });

  it("routes team_chat dm_message_posted using operator email for SenderUsername", async () => {
    const runtime = installRuntime();
    const cfg = {
      channels: {
        zoom: {
          dmPolicy: "open",
        },
      },
    } as OpenClawConfig;
    const { deps, conversationStore } = createTestDeps(cfg);
    const handle = createZoomMessageHandler(deps);

    const event: ZoomWebhookEvent = {
      event: "team_chat.dm_message_posted",
      event_ts: Date.now(),
      payload: {
        operator: "trent.charlton@cloudwarriors.ai",
        operator_id: "user-123",
        object: {
          message: "status",
          message_id: "dm-msg-1",
        } as unknown as ZoomWebhookEvent["payload"]["object"],
      },
    };

    await handle(event);

    expect(conversationStore.upsert).toHaveBeenCalledTimes(1);
    expect(runtime.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const finalCtx = runtime.finalizeInboundContext.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(finalCtx?.ChatType).toBe("direct");
    expect(finalCtx?.SenderEmail).toBe("trent.charlton@cloudwarriors.ai");
    expect(finalCtx?.SenderUsername).toBe("trent.charlton@cloudwarriors.ai");
  });
});
