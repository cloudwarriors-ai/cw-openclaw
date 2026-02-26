import { describe, expect, it } from "vitest";
import { enforceSlmHttpAuth, resolveSlmHttpAuthConfig } from "./http-auth.js";

describe("slm pipeline http auth", () => {
  it("does nothing when auth is disabled", () => {
    const config = resolveSlmHttpAuthConfig({
      OPENCLAW_SLM_HTTP_REQUIRE_AUTH: "0",
      OPENCLAW_SLM_HTTP_AUTH_TOKEN: "secret",
    });
    expect(
      enforceSlmHttpAuth(
        {
          xOpenclawSlmToken: undefined,
        },
        config,
      ),
    ).toBeNull();
  });

  it("rejects requests when token is missing", () => {
    const config = resolveSlmHttpAuthConfig({
      OPENCLAW_SLM_HTTP_REQUIRE_AUTH: "1",
      OPENCLAW_SLM_HTTP_AUTH_TOKEN: "secret",
    });
    const failure = enforceSlmHttpAuth({}, config);
    expect(failure?.status).toBe(401);
  });

  it("fails closed when auth is required but token is not configured", () => {
    const config = resolveSlmHttpAuthConfig({
      OPENCLAW_SLM_HTTP_REQUIRE_AUTH: "true",
    });
    const failure = enforceSlmHttpAuth(
      {
        xOpenclawSlmToken: "anything",
      },
      config,
    );
    expect(failure?.status).toBe(500);
  });
});
