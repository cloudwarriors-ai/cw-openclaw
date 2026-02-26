import { describe, expect, it } from "vitest";
import { enforceSlmHttpAuth, resolveSlmHttpAuthConfig } from "./http-auth.js";

describe("slm supervisor http auth", () => {
  it("allows requests when auth is disabled", () => {
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

  it("rejects invalid token when auth is enabled", () => {
    const config = resolveSlmHttpAuthConfig({
      OPENCLAW_SLM_HTTP_REQUIRE_AUTH: "1",
      OPENCLAW_SLM_HTTP_AUTH_TOKEN: "secret",
    });
    const failure = enforceSlmHttpAuth(
      {
        xOpenclawSlmToken: "wrong-token",
      },
      config,
    );
    expect(failure?.status).toBe(401);
  });
});
