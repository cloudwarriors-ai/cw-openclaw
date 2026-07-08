import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPraxisBase,
  listIssuesPath,
  praxisFetch,
  praxisGet,
  praxisHealth,
} from "./praxis-client.js";

// The client reads PRAXIS_API_URL at module load (defaults to http://praxis:8000) and
// PRAXIS_API_TOKEN lazily per call, so we leave the base at its default and only stub the token.
const BASE = "http://praxis:8000";

function mockResponse(opts: {
  ok: boolean;
  status: number;
  body: unknown;
  json?: boolean;
}): Response {
  const json = opts.json ?? true;
  return {
    ok: opts.ok,
    status: opts.status,
    headers: {
      get: (h: string) =>
        h.toLowerCase() === "content-type" ? (json ? "application/json" : "text/plain") : null,
    },
    json: async () => opts.body,
    text: async () => (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("PRAXIS_API_TOKEN", "test-token");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("praxisFetch", () => {
  it("attaches the bearer token and parses a JSON body", async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, body: { issues: [] } }));
    const res = await praxisFetch("/api/v1/issues");

    expect(res).toEqual({ ok: true, status: 200, data: { issues: [] } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/issues`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("throws a clear error when PRAXIS_API_TOKEN is unset", async () => {
    vi.stubEnv("PRAXIS_API_TOKEN", "");
    await expect(praxisFetch("/api/v1/issues")).rejects.toThrow(
      "PRAXIS_API_TOKEN env var required",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("praxisGet", () => {
  it("returns the body on success", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: true, status: 200, body: { state: "blocked" } }),
    );
    expect(await praxisGet("/api/v1/issues/5")).toEqual({ state: "blocked" });
  });

  it("throws on non-2xx with status + body, never the token", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: false, status: 404, body: { detail: "Not found." } }),
    );
    await expect(praxisGet("/api/v1/issues/999")).rejects.toThrow(
      /Praxis API 404 on \/api\/v1\/issues\/999/,
    );
    await expect(praxisGet("/api/v1/issues/999")).rejects.not.toThrow(/test-token/);
  });
});

describe("listIssuesPath", () => {
  it("returns the bare path with no filters", () => {
    expect(listIssuesPath({})).toBe("/api/v1/issues");
  });

  it("encodes repo and state filters", () => {
    expect(listIssuesPath({ repo: "cloudwarriors-ai/scopely", state: "blocked" })).toBe(
      "/api/v1/issues?repo=cloudwarriors-ai%2Fscopely&state=blocked",
    );
  });
});

describe("praxisHealth", () => {
  it("reports ok when the server API version matches", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: true, status: 200, body: { info: { version: "v1" } } }),
    );
    expect(await praxisHealth()).toEqual({ ok: true, version: "v1" });
  });

  it("reports a version mismatch as not ok", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: true, status: 200, body: { info: { version: "v2" } } }),
    );
    const health = await praxisHealth();
    expect(health.ok).toBe(false);
    expect(health.version).toBe("v2");
    expect(health.error).toMatch(/version mismatch/);
  });

  it("reports a non-ok schema fetch as not ok without throwing", async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 502, body: "bad gateway" }));
    const health = await praxisHealth();
    expect(health.ok).toBe(false);
    expect(health.error).toMatch(/HTTP 502/);
  });
});

describe("getPraxisBase", () => {
  it("exposes the configured base with no trailing slash", () => {
    expect(getPraxisBase()).toBe(BASE);
  });
});

describe("issuePath", () => {
  it("prefers repo + number (the GitHub reference callers hold)", async () => {
    const { issuePath } = await import("./praxis-client.js");
    expect(issuePath({ repo: "cloudwarriors-ai/scopely", number: 837 })).toBe(
      "/api/v1/repos/cloudwarriors-ai/scopely/issues/837",
    );
    expect(issuePath({ repo: "cw/app", number: 7 }, "/diagnose")).toBe(
      "/api/v1/repos/cw/app/issues/7/diagnose",
    );
    // repo+number wins even when issue_id is also supplied.
    expect(issuePath({ repo: "cw/app", number: 7, issue_id: 99 }, "/events")).toBe(
      "/api/v1/repos/cw/app/issues/7/events",
    );
  });

  it("falls back to the internal issue_id route", async () => {
    const { issuePath } = await import("./praxis-client.js");
    expect(issuePath({ issue_id: 37 }, "/diagnose")).toBe("/api/v1/issues/37/diagnose");
  });

  it("throws a naming-the-fix error when neither addressing form is given", async () => {
    const { issuePath } = await import("./praxis-client.js");
    expect(() => issuePath({})).toThrow(/repo \+ number.*issue_id/);
  });
});
