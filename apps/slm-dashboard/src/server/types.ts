export type DashboardUser = {
  username: string;
  passwordHash: string;
  tenantId: string;
  displayName?: string;
};

export type SessionRecord = {
  sessionId: string;
  username: string;
  tenantId: string;
  displayName?: string;
  createdAtMs: number;
  expiresAtMs: number;
};

export type DashboardConfig = {
  port: number;
  cookieName: string;
  cookieSecure: boolean;
  sessionTtlMs: number;
  gatewayUrl: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  gatewayTimeoutMs: number;
  users: DashboardUser[];
};

export type GatewayMethodClient = {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
};

export type Clock = {
  now: () => number;
};
