import { afterEach, describe, expect, it } from "vitest";
import { registerZoomSubagentHooks } from "./subagent-hooks.js";
import { clearZoomSessionReplyRootsForTest, rememberZoomSessionReplyRoot } from "./thread-state.js";

type DeliveryEvent = {
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  expectsCompletionMessage: boolean;
};

// Minimal api stub that captures the registered subagent_delivery_target handler.
function makeApi() {
  let handler: ((event: DeliveryEvent) => unknown) | undefined;
  const api = {
    on(name: string, fn: (event: DeliveryEvent) => unknown) {
      if (name === "subagent_delivery_target") handler = fn;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerZoomSubagentHooks(api as any);
  if (!handler) throw new Error("hook not registered");
  return handler;
}

describe("zoom subagent_delivery_target hook", () => {
  afterEach(() => clearZoomSessionReplyRootsForTest());

  it("routes the spoke result into the requester session's remembered reply-root thread", () => {
    const handler = makeApi();
    rememberZoomSessionReplyRoot({
      sessionKey: "agent:scopelybot:zoom:channel:vip",
      explicitReplyMainMessageId: "MSG-ROOT-1",
    });
    const result = handler({
      childSessionKey: "subagent:scopely-observe:1",
      requesterSessionKey: "agent:scopelybot:zoom:channel:vip",
      requesterOrigin: { channel: "zoom", accountId: "acct", to: "vip@conference.xmpp.zoom.us" },
      expectsCompletionMessage: true,
    }) as { origin?: { channel?: string; to?: string; threadId?: string | number } } | undefined;
    expect(result?.origin).toMatchObject({
      channel: "zoom",
      to: "vip@conference.xmpp.zoom.us",
      threadId: "MSG-ROOT-1",
    });
  });

  it("returns nothing for non-zoom requesters", () => {
    const handler = makeApi();
    rememberZoomSessionReplyRoot({ sessionKey: "s", explicitReplyMainMessageId: "M" });
    const result = handler({
      childSessionKey: "c",
      requesterSessionKey: "s",
      requesterOrigin: { channel: "discord", to: "x" },
      expectsCompletionMessage: true,
    });
    expect(result).toBeUndefined();
  });

  it("returns nothing when there is no remembered reply-root", () => {
    const handler = makeApi();
    const result = handler({
      childSessionKey: "c",
      requesterSessionKey: "unknown-session",
      requesterOrigin: { channel: "zoom", to: "vip@conference.xmpp.zoom.us" },
      expectsCompletionMessage: true,
    });
    expect(result).toBeUndefined();
  });

  it("does not override an origin that already carries a thread target", () => {
    const handler = makeApi();
    rememberZoomSessionReplyRoot({ sessionKey: "s", explicitReplyMainMessageId: "M" });
    const result = handler({
      childSessionKey: "c",
      requesterSessionKey: "s",
      requesterOrigin: { channel: "zoom", to: "vip@conference.xmpp.zoom.us", threadId: "EXISTING" },
      expectsCompletionMessage: true,
    });
    expect(result).toBeUndefined();
  });

  it("ignores events that do not expect a completion message", () => {
    const handler = makeApi();
    rememberZoomSessionReplyRoot({ sessionKey: "s", explicitReplyMainMessageId: "M" });
    const result = handler({
      childSessionKey: "c",
      requesterSessionKey: "s",
      requesterOrigin: { channel: "zoom", to: "vip@conference.xmpp.zoom.us" },
      expectsCompletionMessage: false,
    });
    expect(result).toBeUndefined();
  });
});
