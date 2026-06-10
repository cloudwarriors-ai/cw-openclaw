// test-capture: a test-only harness extension. When OPENCLAW_TEST_CAPTURE is set it
// installs a global-fetch egress interceptor (captures + suppresses Zoom channel
// messages to ARMED channels — no writes to the live channel) and routing/tool-trace
// hooks (before_tool_call + agent_end). The armed capture-set is set per run by the
// harness via the control row in the store, so any agent can be tested with no restart.
//
// When the env flag is unset the extension is FULLY INERT (no hooks, no fetch wrap) —
// safe to ship disabled in production.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { DEFAULT_DB_PATH, openStore } from "./src/store.js";
import { installEgressInterceptor } from "./src/egress.js";
import { registerTraceHooks } from "./src/trace.js";

const plugin = {
  id: "test-capture",
  name: "TestCapture",
  description: "Test-only harness: capture+suppress Zoom egress and trace hub-and-spoke routing",
  configSchema: { type: "object" as const, additionalProperties: false, properties: {} },

  register(api: OpenClawPluginApi) {
    if (process.env.OPENCLAW_TEST_CAPTURE !== "1") {
      console.log("[test-capture] disabled (set OPENCLAW_TEST_CAPTURE=1 to enable)");
      return;
    }
    const dbPath = process.env.OPENCLAW_TEST_CAPTURE_DB ?? DEFAULT_DB_PATH;
    const db = openStore(dbPath);
    installEgressInterceptor(db);
    registerTraceHooks(api, db);
    console.log(`[test-capture] ENABLED — egress interceptor + trace hooks active (db=${dbPath})`);
  },
};

export default plugin;
