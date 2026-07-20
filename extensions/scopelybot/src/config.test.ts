import { describe, expect, it } from "vitest";
import { resolveScopelyBotConfig } from "./config.js";

describe("resolveScopelyBotConfig", () => {
  it("reads the enabled plugin entry from the OpenClaw root config", () => {
    const pluginConfig = {
      scopelyRepos: ["cloudwarriors-ai/scopely"],
      serviceContainers: ["scopely-scopely-backend-1"],
      writeApproverIds: ["approved-sender"],
    };
    expect(
      resolveScopelyBotConfig({ plugins: { entries: { scopelybot: { config: pluginConfig } } } }),
    ).toEqual(pluginConfig);
  });

  it("lets an explicit test override win", () => {
    const override = { serviceContainers: ["override"] };
    expect(resolveScopelyBotConfig({}, override)).toBe(override);
  });
});
