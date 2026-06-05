import {
  defineBundledChannelEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import {
  formatToolParams,
  registerZoomSubagentHooks,
  registerZoomTools,
  shouldBlockTool,
} from "./register-full-api.js";

export default defineBundledChannelEntry({
  id: "zoom",
  name: "Zoom Team Chat",
  description: "Zoom Team Chat channel plugin (S2S OAuth)",
  importMetaUrl: import.meta.url,
  plugin: { specifier: "./src/channel.js", exportName: "zoomPlugin" },
  runtime: { specifier: "./src/runtime.js", exportName: "setZoomRuntime" },
  registerFull(api: OpenClawPluginApi) {
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
});
