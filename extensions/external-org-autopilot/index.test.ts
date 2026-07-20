/**
 * Plugin-boundary test for external-org-autopilot's before_dispatch confirm claim scoping.
 */

import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

// Six gated bots register the same first-claim-wins before_dispatch hook; each must
// only claim CONFIRMs from its OWN agent sessions (2026-07-20 incident: pulsebot
// claimed a scopelybot confirm and answered "expired" from its own empty store).
describe("external-org-autopilot confirm claim scoping", () => {
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
    } as never;
    plugin.register(api, undefined);
    const handler = handlers.get("before_dispatch");
    if (!handler) throw new Error("before_dispatch handler not registered");
    return handler;
  }

  it("declines a CONFIRM from another agent's zoom session (does not steal it)", async () => {
    const handler = registerAndGetBeforeDispatch();
    const result = await handler(
      { content: "CONFIRM 8248" },
      {
        channelId: "zoom",
        conversationId: "thread-1",
        sessionKey: "agent:scopelybot:zoom:channel:thread-1",
        senderId: "someone",
      },
    );
    expect(result).toBeUndefined();
  });

  it("claims a CONFIRM from its own zoom session", async () => {
    const handler = registerAndGetBeforeDispatch();
    const result = await handler(
      { content: "CONFIRM 8248" },
      {
        channelId: "zoom",
        conversationId: "thread-1",
        sessionKey: "agent:external-org-autopilot:zoom:channel:thread-1",
        senderId: "someone",
      },
    );
    expect(result?.handled).toBe(true);
  });
});
