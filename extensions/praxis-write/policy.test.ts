import { describe, expect, it } from "vitest";
import {
  type ActorContext,
  checkPolicy,
  confirmTokenMatches,
  deriveActorContext,
  idempotencyKey,
  mintConfirmToken,
  resolveWritePolicyConfig,
} from "./policy.js";
import type { PraxisIssueState } from "./praxis-write-client.js";

const issue: PraxisIssueState = {
  id: 5,
  state: "blocked",
  state_reason: "no_response",
  version: 12,
};

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    requestedBy: "alice",
    channel: "dev_praxis",
    messageId: "m-1",
    toolCallId: "call-1",
    ...overrides,
  };
}

describe("resolveWritePolicyConfig", () => {
  it("defaults to empty allowlists when unset or malformed", () => {
    expect(resolveWritePolicyConfig(undefined)).toEqual({ allowedUsers: [], allowedChannels: [] });
    expect(resolveWritePolicyConfig({ allowedUsers: "nope" })).toEqual({
      allowedUsers: [],
      allowedChannels: [],
    });
  });

  it("keeps only non-empty string entries", () => {
    expect(
      resolveWritePolicyConfig({ allowedUsers: ["alice", "", 7, "bob"], allowedChannels: ["c1"] }),
    ).toEqual({ allowedUsers: ["alice", "bob"], allowedChannels: ["c1"] });
  });
});

describe("checkPolicy", () => {
  it("denies when there is no requester identity", () => {
    const decision = checkPolicy(actor({ requestedBy: "" }), {
      allowedUsers: ["alice"],
      allowedChannels: [],
    });
    expect(decision).toEqual({ allowed: false, reason: "no_requester_identity" });
  });

  it("fails closed when neither allowlist is configured", () => {
    expect(checkPolicy(actor(), { allowedUsers: [], allowedChannels: [] })).toEqual({
      allowed: false,
      reason: "write_policy_unconfigured",
    });
  });

  it("denies a requester not in a configured user allowlist", () => {
    expect(
      checkPolicy(actor({ requestedBy: "mallory" }), {
        allowedUsers: ["alice"],
        allowedChannels: [],
      }),
    ).toEqual({ allowed: false, reason: "requester_not_allowlisted" });
  });

  it("denies a channel not in a configured channel allowlist", () => {
    expect(
      checkPolicy(actor({ channel: "random" }), {
        allowedUsers: ["alice"],
        allowedChannels: ["dev_praxis"],
      }),
    ).toEqual({ allowed: false, reason: "channel_not_allowlisted" });
  });

  it("allows when every configured dimension matches", () => {
    expect(
      checkPolicy(actor(), { allowedUsers: ["alice"], allowedChannels: ["dev_praxis"] }),
    ).toEqual({ allowed: true });
  });

  it("treats a channel-only allowlist as 'anyone in this channel'", () => {
    expect(
      checkPolicy(actor({ requestedBy: "anyone" }), {
        allowedUsers: [],
        allowedChannels: ["dev_praxis"],
      }),
    ).toEqual({ allowed: true });
  });
});

describe("deriveActorContext", () => {
  it("reads identity from the trusted runtime context, not tool args", () => {
    const ctx = {
      requesterSenderId: "alice",
      deliveryContext: { channel: "dev_praxis", threadId: 99 },
      sessionId: "sess-1",
    };
    expect(deriveActorContext(ctx, "call-7")).toEqual({
      requestedBy: "alice",
      channel: "dev_praxis",
      messageId: "99",
      toolCallId: "call-7",
    });
  });

  it("falls back to messageChannel and sessionId, empty requester when absent", () => {
    expect(deriveActorContext({ messageChannel: "zoom", sessionId: "sess-2" }, "call-8")).toEqual({
      requestedBy: "",
      channel: "zoom",
      messageId: "sess-2",
      toolCallId: "call-8",
    });
  });

  it("gates on the room (deliveryContext.to), not the platform channel", () => {
    // The runtime sets deliveryContext.channel to the PLATFORM ("zoom") and puts the specific
    // room (the Zoom channel JID) in deliveryContext.to. The allowlist gates on the room, so `to`
    // wins — gating on the platform would (wrongly) allow every Zoom channel. Regression guard.
    const ctx = {
      requesterSenderId: "alice",
      messageChannel: "zoom",
      deliveryContext: { channel: "zoom", to: "room-jid@conference.xmpp.zoom.us", threadId: 1 },
    };
    expect(deriveActorContext(ctx, "call-9").channel).toBe("room-jid@conference.xmpp.zoom.us");
  });
});

describe("confirm token", () => {
  const secret = "server-only-secret";

  it("a token minted for an issue verifies against the same state", () => {
    const token = mintConfirmToken({ secret, kind: "unblock", issue });
    expect(confirmTokenMatches(token, mintConfirmToken({ secret, kind: "unblock", issue }))).toBe(
      true,
    );
  });

  it("rejects a stale token after the issue version changes", () => {
    const stale = mintConfirmToken({ secret, kind: "unblock", issue });
    const fresh = mintConfirmToken({
      secret,
      kind: "unblock",
      issue: { ...issue, version: 13 },
    });
    expect(confirmTokenMatches(stale, fresh)).toBe(false);
  });

  it("is bound to the command kind", () => {
    const unblock = mintConfirmToken({ secret, kind: "unblock", issue });
    const cancel = mintConfirmToken({ secret, kind: "cancelled", issue });
    expect(unblock).not.toBe(cancel);
  });

  it("changes with the secret, so it cannot be forged without the token", () => {
    const a = mintConfirmToken({ secret, kind: "unblock", issue });
    const b = mintConfirmToken({ secret: "other", kind: "unblock", issue });
    expect(a).not.toBe(b);
  });
});

describe("idempotencyKey", () => {
  it("is one logical command per issue version", () => {
    expect(idempotencyKey("unblock", issue)).toBe("unblock:5:12");
    expect(idempotencyKey("cancelled", { ...issue, version: 13 })).toBe("cancelled:5:13");
  });
});
