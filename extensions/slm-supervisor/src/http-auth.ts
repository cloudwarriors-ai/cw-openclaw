type SlmHttpAuthFailure = {
  status: number;
  body: {
    ok: false;
    error: {
      code: string;
      message: string;
    };
  };
};

export type SlmHttpAuthConfig = {
  requireAuth: boolean;
  token?: string;
};

export function resolveSlmHttpAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): SlmHttpAuthConfig {
  return {
    requireAuth: parseEnvBoolean(env.OPENCLAW_SLM_HTTP_REQUIRE_AUTH),
    token: env.OPENCLAW_SLM_HTTP_AUTH_TOKEN?.trim() || undefined,
  };
}

export function enforceSlmHttpAuth(
  headers: {
    xOpenclawSlmToken?: string;
  },
  config: SlmHttpAuthConfig,
): SlmHttpAuthFailure | null {
  if (!config.requireAuth) {
    return null;
  }

  if (!config.token) {
    return {
      status: 500,
      body: {
        ok: false,
        error: {
          code: "slm_http_auth_misconfigured",
          message: "OPENCLAW_SLM_HTTP_AUTH_TOKEN is required when HTTP auth is enabled",
        },
      },
    };
  }

  const provided = headers.xOpenclawSlmToken?.trim();
  if (!provided || provided !== config.token) {
    return {
      status: 401,
      body: {
        ok: false,
        error: {
          code: "unauthorized",
          message: "missing or invalid x-openclaw-slm-token",
        },
      },
    };
  }

  return null;
}

function parseEnvBoolean(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
