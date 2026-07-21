// scopelyFetch response-body parsing tests. Regression anchor (live 2026-07-21):
// DRF answers DELETE with 204 No Content but STILL sets
// Content-Type: application/json on the empty body — the old resp.json() call
// threw "Unexpected end of JSON input", which the confirm executor reported as
// "❌ Error executing DELETE …" on a delete that had already SUCCEEDED on the
// backend. A successful mutation must never be reported as a failure by the
// bot's own response parsing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Auth is out of scope here — stub the cookie/login plumbing entirely.
vi.mock("./scopely-auth.js", () => ({
  scopelyEnsureAuth: () => Promise.resolve(),
  scopelyCookieHeader: () => "access=t",
  scopelyClearSession: () => {},
}));

import { scopelyFetch } from "./scopely-api.js";

const fetchMock = vi.fn();

function httpResponse(opts: { status: number; body: string; contentType?: string }) {
  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    headers: {
      get: (name: string) => (name === "content-type" ? (opts.contentType ?? null) : null),
    },
    text: () => Promise.resolve(opts.body),
    json: () => Promise.resolve(JSON.parse(opts.body)),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scopelyFetch body parsing", () => {
  it("204 No Content with a JSON content-type resolves ok — never throws (live DELETE regression)", async () => {
    fetchMock.mockResolvedValue(
      httpResponse({ status: 204, body: "", contentType: "application/json" }),
    );
    const res = await scopelyFetch("/api/admin/x/");
    expect(res).toEqual({ ok: true, status: 204, data: "" });
  });

  it("parses a valid JSON body (normal path unchanged)", async () => {
    fetchMock.mockResolvedValue(
      httpResponse({
        status: 200,
        body: '{"count":1}',
        contentType: "application/json; charset=utf-8",
      }),
    );
    const res = await scopelyFetch("/api/admin/x/");
    expect(res).toEqual({ ok: true, status: 200, data: { count: 1 } });
  });

  it("falls back to raw text when the JSON content-type lies about the body", async () => {
    fetchMock.mockResolvedValue(
      httpResponse({ status: 502, body: "Bad Gateway", contentType: "application/json" }),
    );
    const res = await scopelyFetch("/api/admin/x/");
    expect(res).toEqual({ ok: false, status: 502, data: "Bad Gateway" });
  });

  it("non-JSON content-type returns the body as text", async () => {
    fetchMock.mockResolvedValue(
      httpResponse({ status: 200, body: "<html>", contentType: "text/html" }),
    );
    const res = await scopelyFetch("/api/admin/x/");
    expect(res).toEqual({ ok: true, status: 200, data: "<html>" });
  });
});
