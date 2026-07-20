/**
 * Plugin-boundary tests for scopelybot's before_dispatch confirm claim: six gated
 * bots register this same first-claim-wins hook, so each must only claim CONFIRMs
 * arriving through its OWN agent sessions (2026-07-20 incident: pulsebot claimed a
 * scopelybot confirm and answered "expired" from its own empty pending store).
 */

import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

type Handler = (
  event: unknown,
  ctx: unknown,
) => Promise<{ handled: boolean; text?: string } | undefined>;

function registerAndGetBeforeDispatch(): Handler {
  process.env.OPENCLAW_WORKSPACE = os.tmpdir();
  const handlers = new Map<string, Handler>();
  const api = {
    registerTool: vi.fn(),
    on: vi.fn((name: string, fn: Handler) => {
      handlers.set(name, fn);
    }),
    registerHook: vi.fn(),
  } as never;
  plugin.register(api, { writeApproverIds: [] });
  const handler = handlers.get("before_dispatch");
  if (!handler) throw new Error("before_dispatch handler not registered");
  return handler;
}

describe("scopelybot confirm claim scoping", () => {
  it("declines a CONFIRM from another agent's zoom session (does not steal it)", async () => {
    const handler = registerAndGetBeforeDispatch();
    const result = await handler(
      { content: "CONFIRM 8248" },
      {
        channelId: "zoom",
        conversationId: "thread-1",
        sessionKey: "agent:pulsebot:zoom:channel:thread-1",
        senderId: "someone",
      },
    );
    expect(result).toBeUndefined();
  });

  it("declines when no session key is present", async () => {
    const handler = registerAndGetBeforeDispatch();
    const result = await handler(
      { content: "CONFIRM 8248" },
      { channelId: "zoom", conversationId: "thread-1", senderId: "someone" },
    );
    expect(result).toBeUndefined();
  });

  it("claims a CONFIRM from its own zoom session (threaded)", async () => {
    const handler = registerAndGetBeforeDispatch();
    const result = await handler(
      { content: "CONFIRM 8248" },
      {
        channelId: "zoom",
        conversationId: "554f6079-4d2e-4727-87db-1b1c482fff3d",
        sessionKey: "agent:scopelybot:zoom:channel:554f6079-4d2e-4727-87db-1b1c482fff3d",
        senderId: "someone",
      },
    );
    // Claimed and suppressed — empty approver list yields the deterministic
    // authorization refusal, never a coordinator dispatch.
    expect(result?.handled).toBe(true);
    expect(result?.text).toContain("not authorized");
  });

  it("ignores non-CONFIRM messages in its own session", async () => {
    const handler = registerAndGetBeforeDispatch();
    const result = await handler(
      { content: "what's the status of user 47?" },
      {
        channelId: "zoom",
        conversationId: "thread-1",
        sessionKey: "agent:scopelybot:zoom:channel:thread-1",
        senderId: "someone",
      },
    );
    expect(result).toBeUndefined();
  });
});
