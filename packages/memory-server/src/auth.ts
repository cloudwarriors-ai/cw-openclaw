import { MemoryApiError } from "./errors.js";
import { bearerTokenSchema } from "./types.js";

export type MemoryAuthContext = {
  tenantId: string;
  subject: string;
  isAdmin: boolean;
};

export type MemoryAuthResolver = (token: string) => MemoryAuthContext | null;

export function createStaticTokenAuth(tokens: Record<string, MemoryAuthContext>): MemoryAuthResolver {
  return (token) => tokens[token] ?? null;
}

export function resolveAuthContext(
  headers: {
    authorization?: string;
    xMemoryApiKey?: string;
  },
  resolver: MemoryAuthResolver,
): MemoryAuthContext {
  const bearerToken = parseBearerToken(headers.authorization);
  const apiKeyToken = headers.xMemoryApiKey?.trim();
  const token = bearerToken ?? (apiKeyToken && apiKeyToken.length > 0 ? apiKeyToken : "");
  if (!token) {
    throw new MemoryApiError(
      401,
      "unauthorized",
      "missing Authorization bearer token or X-Memory-API-Key header",
    );
  }

  const context = resolver(token);
  if (!context) {
    throw new MemoryApiError(403, "forbidden", "invalid token");
  }
  return context;
}

function parseBearerToken(authorization: string | undefined): string | undefined {
  const parsed = bearerTokenSchema.safeParse(authorization ?? "");
  if (!parsed.success) {
    return undefined;
  }
  const token = parsed.data.split(/\s+/)[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}
