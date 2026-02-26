import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { SlmSupervisorAppService } from "./app-service.js";
import { parseSlmCommandArgs, registerSlmPilotCommand } from "./command-mode.js";

function createApi() {
  type RegisteredCommand = {
    name: string;
    handler: (ctx: Record<string, unknown>) => Promise<{ text?: string } | { text: string }>;
  };
  let command: RegisteredCommand | undefined;
  const api = {
    registerCommand(definition: unknown) {
      command = definition as RegisteredCommand;
    },
  } as unknown as OpenClawPluginApi;
  return {
    api,
    getCommand: () => command,
  };
}

describe("slm pilot command", () => {
  it("registers /slm command and uses default tenant from env", async () => {
    const app = {
      respond: vi.fn(async () => ({
        final_answer: "Use the deployment runbook.",
        source_path: "slm_only",
        trace_id: "7f5788a3-4f09-4f03-9236-ad8ea0953697",
        reason_codes: [],
        policy_flags: [],
      })),
    } as unknown as SlmSupervisorAppService;
    const { api, getCommand } = createApi();

    registerSlmPilotCommand(api, app, {
      OPENCLAW_SLM_PILOT_TENANT: "tenant-a",
    });

    const command = getCommand();
    expect(command?.name).toBe("slm");

    const result = await command?.handler({
      channel: "telegram",
      isAuthorizedSender: true,
      commandBody: "/slm how do we roll back quickly?",
      args: "how do we roll back quickly?",
      config: {} as never,
      senderId: "operator",
    });

    expect(app.respond).toHaveBeenCalledWith({
      tenant_id: "tenant-a",
      channel_id: "telegram:command",
      user_message: "how do we roll back quickly?",
      context_refs: [],
    });
    expect(result).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("trace_id="),
      }),
    );
  });

  it("requires explicit tenant when default tenant is unavailable", () => {
    const parsed = parseSlmCommandArgs("how do we roll back quickly?", "");
    expect(parsed).toBeInstanceOf(Error);
  });

  it("parses explicit tenant override", () => {
    const parsed = parseSlmCommandArgs("--tenant tenant-b answer this", "tenant-a");
    expect(parsed).toEqual({
      tenantId: "tenant-b",
      userMessage: "answer this",
    });
  });
});
