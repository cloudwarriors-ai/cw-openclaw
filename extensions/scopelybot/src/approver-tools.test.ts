/**
 * Approver-tool tests: granting rides the standard confirm gate end-to-end —
 * the tool only STAGES, only an existing approver's CONFIRM executes, the grant
 * records who approved it, and the new approver is effective immediately.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the channel sender so staging delivers the confirm prompt to a spy instead
// of hitting Zoom — the code travels only through this deterministic send.
const sendScopelyTextMock = vi.fn();
vi.mock("./comfort.js", () => ({
  sendScopelyText: (...args: unknown[]) => sendScopelyTextMock(...args),
  getChannelThreadAnchor: () => "MSG-ANCHOR",
  rememberChannelThreadAnchor: () => {},
  sendComfortMessage: () => {},
}));

import { createApproverStore } from "./approver-store.js";
import { registerApproverTools } from "./approver-tools.js";
import { tryExecuteConfirm } from "./confirm.js";

type ToolDef = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};

const noopLogger = () => {};
const CHANNEL = "vipbot@conference.xmpp.zoom.us";
const CHAD = "Mb4vcQ4YQUaQKJjoY4vntQ";
const RUDY = "wc7WZVkGRMGcNWOYTksTvQ";
const RUDY_EMAIL = "john.rudolph@cloudwarriors.ai";

let dir: string;

function buildTools(store: ReturnType<typeof createApproverStore>): Record<string, ToolDef> {
  const tools: Record<string, ToolDef> = {};
  const api = {
    registerTool: (factory: () => ToolDef) => {
      const t = factory();
      tools[t.name] = t;
    },
  } as never;
  registerApproverTools(api, noopLogger as never, store);
  return tools;
}

function parse(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

function codeFromDelivery(): string {
  const text = sendScopelyTextMock.mock.calls.at(-1)?.[1];
  const code = String(text ?? "").match(/CONFIRM (\d{4})/)?.[1];
  if (!code) throw new Error("no confirm code delivered");
  return code;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "approver-tools-"));
  sendScopelyTextMock.mockReset();
  process.env.SCOPELYBOT_ZOOM_CHANNEL = CHANNEL;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SCOPELYBOT_ZOOM_CHANNEL;
});

describe("approver tools", () => {
  it("grant stages only; an existing approver's CONFIRM executes and records grantedBy", async () => {
    const store = createApproverStore({ workspaceDir: dir, configuredIds: [CHAD] });
    store.recordSeenIdentity(RUDY, RUDY_EMAIL);
    const tools = buildTools(store);

    const staged = parse(await tools.scopely_grant_approver.execute("t", { email: RUDY_EMAIL }));
    expect(staged.awaiting_confirmation).toBe(true);
    // Staging must not mutate — the grant only exists after CONFIRM.
    expect(store.approverIds()).not.toContain(RUDY.toLowerCase());
    // The prompt names exactly who is being granted: the boundary redactor masks
    // the full address, so identity rides on the local-part handle + Zoom id.
    const prompt = String(sendScopelyTextMock.mock.calls.at(-1)?.[1]);
    expect(prompt).toContain("grant write-approver access to john.rudolph");
    expect(prompt).toContain(RUDY);
    expect(prompt).not.toContain(RUDY_EMAIL); // full address must stay redacted

    const result = await tryExecuteConfirm({
      text: `CONFIRM ${codeFromDelivery()}`,
      actor: CHAD,
      conversationId: CHANNEL,
      approverIds: store.approverIds(),
      logger: noopLogger as never,
    });
    expect(result).toContain("✅ Done");
    expect(store.approverIds()).toContain(RUDY.toLowerCase());
    expect(store.listGrants()[0]).toMatchObject({ operatorId: RUDY, grantedBy: CHAD });
  });

  it("a non-approver cannot execute a staged grant (no self-escalation)", async () => {
    const store = createApproverStore({ workspaceDir: dir, configuredIds: [CHAD] });
    store.recordSeenIdentity(RUDY, RUDY_EMAIL);
    const tools = buildTools(store);
    await tools.scopely_grant_approver.execute("t", { email: RUDY_EMAIL });

    // The target of the grant tries to confirm it themselves.
    const result = await tryExecuteConfirm({
      text: `CONFIRM ${codeFromDelivery()}`,
      actor: RUDY,
      conversationId: CHANNEL,
      approverIds: store.approverIds(),
      logger: noopLogger as never,
    });
    expect(result).toContain("not authorized");
    expect(store.approverIds()).not.toContain(RUDY.toLowerCase());
  });

  it("grant fails fast without staging when the target identity is unknown", async () => {
    const store = createApproverStore({ workspaceDir: dir, configuredIds: [CHAD] });
    const tools = buildTools(store);
    const res = parse(
      await tools.scopely_grant_approver.execute("t", { email: "never.posted@cloudwarriors.ai" }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("post any message");
    expect(sendScopelyTextMock).not.toHaveBeenCalled();
  });

  it("revoke stages for a granted approver and refuses config-seeded ones without staging", async () => {
    const store = createApproverStore({ workspaceDir: dir, configuredIds: [CHAD] });
    store.recordSeenIdentity(CHAD, "chad.simon@cloudwarriors.ai");
    store.grant({ operatorId: RUDY, email: RUDY_EMAIL, grantedBy: CHAD });
    const tools = buildTools(store);

    // Config-seeded: refused before staging.
    const refused = parse(
      await tools.scopely_revoke_approver.execute("t", { email: "chad.simon@cloudwarriors.ai" }),
    );
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("config");
    expect(sendScopelyTextMock).not.toHaveBeenCalled();

    // Granted: staged, then executed by an approver's CONFIRM.
    const staged = parse(await tools.scopely_revoke_approver.execute("t", { email: RUDY_EMAIL }));
    expect(staged.awaiting_confirmation).toBe(true);
    const result = await tryExecuteConfirm({
      text: `CONFIRM ${codeFromDelivery()}`,
      actor: CHAD,
      conversationId: CHANNEL,
      approverIds: store.approverIds(),
      logger: noopLogger as never,
    });
    expect(result).toContain("✅ Done");
    expect(store.approverIds()).not.toContain(RUDY.toLowerCase());
  });

  it("list shows configured and granted approvers with display handles (emails redacted)", async () => {
    const store = createApproverStore({ workspaceDir: dir, configuredIds: [CHAD] });
    store.recordSeenIdentity(CHAD, "chad.simon@cloudwarriors.ai");
    store.grant({ operatorId: RUDY, email: RUDY_EMAIL, grantedBy: CHAD });
    const tools = buildTools(store);
    const res = parse(await tools.scopely_list_approvers.execute("t", {}));
    // Full addresses are masked by the boundary redactor; the local-part display
    // handle survives and identifies the person.
    expect(res.configured[0]).toMatchObject({ display: "chad.simon" });
    expect(res.granted[0]).toMatchObject({ display: "john.rudolph", operatorId: RUDY });
    expect(res.granted[0].email).toBe("[REDACTED_EMAIL]");
  });
});
