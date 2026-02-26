import { fileURLToPath } from "node:url";
import { createSlmDashboardApp } from "./app.js";
import { loadDashboardConfig } from "./config.js";
import { GatewayRpcClient } from "./gateway-client.js";

export async function startServer() {
  const config = loadDashboardConfig(process.env);
  const gatewayClient = new GatewayRpcClient({
    url: config.gatewayUrl,
    token: config.gatewayToken,
    password: config.gatewayPassword,
    timeoutMs: config.gatewayTimeoutMs,
  });
  const clientDir = fileURLToPath(new URL("../client", import.meta.url));
  const { app } = createSlmDashboardApp({
    config,
    gatewayClient,
    clientDir,
  });
  const server = app.listen(config.port, () => {
    process.stdout.write(`SLM dashboard running at http://127.0.0.1:${config.port}\n`);
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void startServer();
}
