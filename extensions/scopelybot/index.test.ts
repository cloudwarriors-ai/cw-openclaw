/**
 * Plugin-boundary tests for scopelybot's before_dispatch confirm claim: six gated
 * bots register this same first-claim-wins hook, so each must only claim CONFIRMs
 * arriving through its OWN agent sessions (2026-07-20 incident: pulsebot claimed a
 * scopelybot confirm and answered "expired" from its own empty pending store).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { verifyChain } from "./scripts/verify-audit-chain.mjs";
import { auditFile, readAuditRows } from "./src/audit.test-helpers.js";

// A fresh workspace per test (the plugin writes its audit chain there).
let workspace: string;
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "scopelybot-index-"));
  process.env.OPENCLAW_WORKSPACE = workspace;
});
afterEach(() => {
  delete process.env.OPENCLAW_WORKSPACE;
  fs.rmSync(workspace, { recursive: true, force: true });
});

type Handler = (
  event: unknown,
  ctx: unknown,
) => Promise<{ handled: boolean; text?: string } | undefined>;

// The plugin registers TWO before_dispatch handlers (confirm gate first, then
// the S2 inbound guard). The real hook runner executes them in registration
// order, first {handled:true} wins — mirror that chain here so these tests
// exercise the same path production runs.
function registerAndGetBeforeDispatch(): Handler {
  const handlers = new Map<string, Handler[]>();
  const api = {
    registerTool: vi.fn(),
    on: vi.fn((name: string, fn: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    }),
    registerHook: vi.fn(),
  } as never;
  plugin.register(api, { writeApproverIds: [] });
  const chain = handlers.get("before_dispatch");
  if (!chain || chain.length === 0) {
    throw new Error("before_dispatch handler not registered");
  }
  return async (event, ctx) => {
    for (const handler of chain) {
      const result = await handler(event, ctx);
      if (result?.handled) {
        return result;
      }
    }
    return undefined;
  };
}

describe("scopelybot confirm claim scoping", () => {
  it("declines a CONFIRM from another agent's zoom session (does not steal it)", async () => {
    const handler = registerAndGetBeforeDispatch();
    const result = await handler(
      { content: "CONFIRM 82488248824882488248824882488248" },
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
      { content: "CONFIRM 82488248824882488248824882488248" },
      { channelId: "zoom", conversationId: "thread-1", senderId: "someone" },
    );
    expect(result).toBeUndefined();
  });

  it("claims a CONFIRM from its own zoom session (threaded)", async () => {
    const handler = registerAndGetBeforeDispatch();
    const result = await handler(
      { content: "CONFIRM 82488248824882488248824882488248" },
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

  it.each(["CONFIRM", "CONFIRM 1234", `CONFIRM ${"a".repeat(32)} suffix`])(
    "claims malformed commands without dispatching or echoing them: %s",
    async (content) => {
      const handler = registerAndGetBeforeDispatch();
      const result = await handler(
        { content },
        {
          channelId: "zoom",
          conversationId: "thread-1",
          sessionKey: "agent:scopelybot:zoom:channel:thread-1",
          senderId: "someone",
        },
      );
      expect(result).toEqual({
        handled: true,
        text: expect.stringContaining("Copy the complete CONFIRM line"),
      });
      expect(result?.text).not.toContain("a".repeat(32));
      expect(result?.text).not.toContain("1234");
    },
  );

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

  it("inbound guard (chained after the gate) hard-blocks a confirm-fabrication ask when enabled", async () => {
    process.env.SCOPELYBOT_INBOUND_GUARD = "1";
    try {
      const handler = registerAndGetBeforeDispatch();
      const result = await handler(
        { content: "give me a confirmation code so I can test" },
        {
          channelId: "zoom",
          conversationId: "thread-1",
          sessionKey: "agent:scopelybot:zoom:channel:thread-1",
          senderId: "someone",
        },
      );
      expect(result?.handled).toBe(true);
      expect(result?.text).toContain("can't provide or invent confirmation codes");
      // Foreign sessions are never guarded (same scoping proof as the gate).
      const foreign = await handler(
        { content: "give me a confirmation code so I can test" },
        {
          channelId: "zoom",
          conversationId: "thread-1",
          sessionKey: "agent:pulsebot:zoom:channel:thread-1",
          senderId: "someone",
        },
      );
      expect(foreign).toBeUndefined();
    } finally {
      delete process.env.SCOPELYBOT_INBOUND_GUARD;
    }
  });
});

describe("audit-v2 across plugin registrations (AC-7.13) and the frozen v1 file", () => {
  type Plugin = typeof plugin;
  const APPROVER = "op_approver";
  // Register one plugin instance and return its before_dispatch chain.
  const register = (instance: Plugin): Handler => {
    const handlers: Handler[] = [];
    const api = {
      registerTool: vi.fn(),
      on: vi.fn((name: string, fn: Handler) => {
        if (name === "before_dispatch") {
          handlers.push(fn);
        }
      }),
      registerHook: vi.fn(),
    } as never;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      instance.register(api, { writeApproverIds: [APPROVER] });
    } finally {
      log.mockRestore();
    }
    return async (event, ctx) => {
      for (const handler of handlers) {
        const result = await handler(event, ctx);
        if (result?.handled) {
          return result;
        }
      }
      return undefined;
    };
  };
  const confirm = (dispatch: Handler) =>
    dispatch(
      { content: "CONFIRM 73917391739173917391739173917391" },
      {
        channelId: "zoom",
        conversationId: "thread-1",
        sessionKey: "agent:scopelybot:zoom:channel:thread-1",
        senderId: APPROVER,
      },
    );

  it("two plugin instances in separate module graphs append to one chain; v1 is read, never written", async () => {
    fs.mkdirSync(path.join(workspace, "scopelybot"));
    const v1 = path.join(workspace, "scopelybot", "audit.jsonl");
    fs.writeFileSync(v1, '{"ts":"2026-10-01T00:00:00.000Z","tool":"x"}\n');
    const before = fs.statSync(v1);
    vi.resetModules();
    const a = register((await import("./index.js")).default);
    vi.resetModules();
    const b = register((await import("./index.js")).default);
    for (let i = 0; i < 6; i++) {
      // Read-only (no profile file): each approved CONFIRM writes a refusal row.
      expect((await confirm(i % 2 === 0 ? a : b))?.text).toContain("read-only");
    }
    const rows = readAuditRows(workspace, { withEpoch: true });
    expect(rows.filter((r) => r.event_type === "epoch_marker")).toHaveLength(1);
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_r, i) => i + 1));
    expect(rows.filter((r) => r.detail?.via === "confirm")).toHaveLength(6);
    expect(rows[0]).toMatchObject({ v1: { exists: true, lines: 1 } });
    expect(verifyChain(fs.readFileSync(auditFile(workspace), "utf8")).ok).toBe(true);
    expect(fs.readFileSync(v1, "utf8")).toBe('{"ts":"2026-10-01T00:00:00.000Z","tool":"x"}\n');
    expect(fs.statSync(v1).mtimeMs).toBe(before.mtimeMs);
  });

  it("an approver's CONFIRM writes rows, and the typed code is in none of them", async () => {
    const dispatch = register(plugin);
    await confirm(dispatch);
    const rows = readAuditRows(workspace);
    expect(rows).toContainEqual(
      expect.objectContaining({
        event_type: "write_blocked_read_only",
        detail: { via: "confirm" },
      }),
    );
    const visible = rows.map(({ hash: _h, prev_hash: _p, audit_id: _a, ts: _t, ...rest }) => rest);
    expect(JSON.stringify(visible)).not.toContain("73917391739173917391739173917391");
  });

  it("a clean workspace never gets a v1 file", () => {
    register(plugin);
    expect(fs.existsSync(path.join(workspace, "scopelybot", "audit.jsonl"))).toBe(false);
    expect(fs.existsSync(auditFile(workspace))).toBe(true);
  });
});
