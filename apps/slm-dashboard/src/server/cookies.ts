import type { Response } from "express";

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }
  const parsed: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey || rawValue.length === 0) {
      continue;
    }
    const key = rawKey.trim();
    const value = rawValue.join("=").trim();
    if (!key || !value) {
      continue;
    }
    parsed[key] = decodeURIComponent(value);
  }
  return parsed;
}

function buildCookie(params: {
  name: string;
  value: string;
  secure: boolean;
  maxAgeSeconds: number;
}): string {
  const parts = [
    `${params.name}=${encodeURIComponent(params.value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${params.maxAgeSeconds}`,
  ];
  if (params.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function setSessionCookie(params: {
  res: Response;
  cookieName: string;
  value: string;
  secure: boolean;
  maxAgeSeconds: number;
}): void {
  params.res.setHeader(
    "Set-Cookie",
    buildCookie({
      name: params.cookieName,
      value: params.value,
      secure: params.secure,
      maxAgeSeconds: params.maxAgeSeconds,
    }),
  );
}

export function clearSessionCookie(params: {
  res: Response;
  cookieName: string;
  secure: boolean;
}): void {
  params.res.setHeader(
    "Set-Cookie",
    buildCookie({
      name: params.cookieName,
      value: "",
      secure: params.secure,
      maxAgeSeconds: 0,
    }),
  );
}
