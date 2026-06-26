import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createAuditLogger } from "./src/audit.js";
import { registerPeOpsTools } from "./src/ops-tools.js";

const plugin = {
  id: "presalespebot",
  name: "PresalesPEBot",
  description: "Presales Knowledge Expert support and observability agent tools",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {},
  },

  register(api: OpenClawPluginApi) {
    const workspaceDir = process.env.OPENCLAW_WORKSPACE ?? "/root/.openclaw/workspace";
    const logger = createAuditLogger(workspaceDir);

    let toolCount = 0;
    const optionalApi: OpenClawPluginApi = {
      ...api,
      registerTool: (tool, opts) => {
        toolCount += 1;
        return api.registerTool(tool, { ...opts, optional: true });
      },
    };

    registerPeOpsTools(optionalApi, logger);

    console.log(`[presalespebot] Registered ${toolCount} tools (PE ops)`);
  },
};

export default plugin;
