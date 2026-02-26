import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { SlmSupervisorAppService } from "./app-service.js";

const COMMAND_NAME = "slm";

type ParsedSlmCommand = {
  tenantId: string;
  userMessage: string;
};

export function registerSlmPilotCommand(
  api: OpenClawPluginApi,
  appService: SlmSupervisorAppService,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const defaultTenantId = env.OPENCLAW_SLM_PILOT_TENANT?.trim() || env.SLM_TEST_TENANT?.trim() || "";

  api.registerCommand({
    name: COMMAND_NAME,
    description: "Pilot SLM-first response command",
    acceptsArgs: true,
    handler: async (ctx) => {
      const parsed = parseSlmCommandArgs(ctx.args, defaultTenantId);
      if (parsed instanceof Error) {
        return { text: `${parsed.message}\n${commandUsage(defaultTenantId)}` };
      }

      try {
        const response = await appService.respond({
          tenant_id: parsed.tenantId,
          channel_id: `${ctx.channel}:command`,
          user_message: parsed.userMessage,
          context_refs: [],
        });

        return {
          text: `${response.final_answer}\n\ntrace_id=${response.trace_id}\nsource_path=${response.source_path}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { text: `SLM command failed: ${message}` };
      }
    },
  });
}

export function parseSlmCommandArgs(
  rawArgs: string | undefined,
  defaultTenantId: string,
): ParsedSlmCommand | Error {
  const args = (rawArgs ?? "").trim();
  if (!args) {
    return new Error("missing prompt");
  }

  const prefixedTenant = parseTenantFlag(args);
  if (prefixedTenant) {
    if (!prefixedTenant.tenantId || !prefixedTenant.userMessage) {
      return new Error("missing tenant or prompt");
    }
    return prefixedTenant;
  }

  if (!defaultTenantId) {
    return new Error("tenant id is required");
  }

  return {
    tenantId: defaultTenantId,
    userMessage: args,
  };
}

function parseTenantFlag(args: string): ParsedSlmCommand | null {
  if (args.startsWith("--tenant=")) {
    const firstSpace = args.indexOf(" ");
    if (firstSpace < 0) {
      return { tenantId: args.slice("--tenant=".length).trim(), userMessage: "" };
    }
    const tenantId = args.slice("--tenant=".length, firstSpace).trim();
    const userMessage = args.slice(firstSpace + 1).trim();
    return { tenantId, userMessage };
  }

  if (!args.startsWith("--tenant ")) {
    return null;
  }

  const rest = args.slice("--tenant ".length).trim();
  if (!rest) {
    return { tenantId: "", userMessage: "" };
  }
  const firstSpace = rest.indexOf(" ");
  if (firstSpace < 0) {
    return { tenantId: rest.trim(), userMessage: "" };
  }
  return {
    tenantId: rest.slice(0, firstSpace).trim(),
    userMessage: rest.slice(firstSpace + 1).trim(),
  };
}

function commandUsage(defaultTenantId: string): string {
  if (defaultTenantId) {
    return "Usage: /slm <prompt> or /slm --tenant <tenant_id> <prompt>";
  }
  return "Usage: /slm --tenant <tenant_id> <prompt>";
}
