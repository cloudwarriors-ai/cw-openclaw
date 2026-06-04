import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { zoomPlugin } from "./src/channel.js";
import { shouldBlockTool, formatToolParams } from "./src/observe-tool-gate.js";
import { setZoomRuntime } from "./src/runtime.js";
import { registerZoomSubagentHooks } from "./src/subagent-hooks.js";
import { registerZoomTools } from "./src/tools.js";

export { monitorZoomProvider } from "./src/monitor.js";

const plugin = {
  id: "zoom",
  name: "Zoom Team Chat",
  description: "Zoom Team Chat channel plugin (S2S OAuth)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setZoomRuntime(api.runtime);
    api.registerChannel({ plugin: zoomPlugin });
    registerZoomTools(api);

    // Route subagent (spoke) completion results back into the originating Zoom thread.
    registerZoomSubagentHooks(api);

    // Gate write/mutation tools in observe-mode sessions.
    // Blocks silently — the monitor handler sends one consolidated approval card after dispatch.
    api.on("before_tool_call", async (event, ctx) => {
      const result = shouldBlockTool(ctx.sessionKey, event.toolName, event.params);
      if (!result.block) return;

      const paramStr = formatToolParams(event.params);
      api.logger.info?.(`zoom: blocked write tool ${event.toolName} in observe session`);

      return {
        block: true,
        blockReason: `This action requires reviewer approval before execution. Tool: ${event.toolName}, Parameters: ${paramStr}. Do NOT retry this tool — the request is pending approval. Inform the user that their change request needs to be approved first.`,
      };
    });
  },
};

export default plugin;
