// scopelyFetch tests: the single, deny-by-default choke point to the ZW app
// (PK-7a: AC-7.3 method/host guard, AC-7.5 no login/env fallback, AC-7.14
// request cap + 429, AC-7.16 redirects; the AC-7.12 single-choke-point scan is
// single-choke-point.test.ts), plus the
// original body-parsing regression anchor (live 2026-07-21): DRF answers DELETE
// with 204 No Content but STILL sets Content-Type: application/json, and the
// old resp.json() threw on it, misreporting a completed mutation as a failure.
// Every test runs against a real profile file in a temp workspace; fetch is a
// mock, so nothing leaves the process.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  errorResult,
  resetScopelyGuardForTest,
  ScopelyGuardError,
  scopelyFetch,
} from "./scopely-api.js";

const DEV_HOST = "100.114.142.100:8022";
const DEV = { env: "dev", baseUrl: `http://${DEV_HOST}`, allowedHosts: [DEV_HOST] };
const fetchMock = vi.fn();
let workspace: string;

function writeProfile(body: Record<string, unknown> | null) {
  const file = path.join(workspace, "scopelybot-backend.json");
  if (body === null) {
    fs.rmSync(file, { force: true });
  } else {
    fs.writeFileSync(file, JSON.stringify(body));
  }
}

function auditRows(): Array<{ resultSummary: string; params: Record<string, unknown> }> {
  const file = path.join(workspace, "scopelybot", "audit.jsonl");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

// A real fetch Response (so the guard's bounded stream read is exercised).
function httpResponse(opts: {
  status: number;
  body?: string | ReadableStream<Uint8Array>;
  contentType?: string;
  location?: string;
}) {
  const headers = new Headers();
  if (opts.contentType) {
    headers.set("content-type", opts.contentType);
  }
  if (opts.location) {
    headers.set("location", opts.location);
  }
  const nullBody = opts.status === 204 || opts.status === 304;
  return new Response(nullBody ? null : (opts.body ?? ""), { status: opts.status, headers });
}

// Every call gets a fresh Response: a body can only be read once.
function respond(opts: Parameters<typeof httpResponse>[0]) {
  fetchMock.mockImplementation(async () => httpResponse(opts));
}

// A body stream that records how much of it was pulled and whether the guard
// cancelled it (an unread, uncancelled body pins the connection).
function trackedBody(chunkBytes: number, chunks = Number.POSITIVE_INFINITY) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) {
        controller.close();
        return;
      }
      state.pulled++;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x61));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

async function expectRefused(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ScopelyGuardError);
  expect((err as ScopelyGuardError).code).toBe(code);
  return err as ScopelyGuardError;
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "scopely-api-"));
  process.env.OPENCLAW_WORKSPACE = workspace;
  writeProfile(DEV);
  resetScopelyGuardForTest();
  fetchMock.mockReset();
  respond({ status: 200, body: "{}", contentType: "application/json" });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.OPENCLAW_WORKSPACE;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("scopelyFetch body parsing", () => {
  it("204 No Content with a JSON content-type resolves ok — never throws (live DELETE regression)", async () => {
    respond({ status: 204, body: "", contentType: "application/json" });
    const res = await scopelyFetch("/api/admin/x/");
    expect(res).toEqual({ ok: true, status: 204, data: "" });
  });

  it("parses a valid JSON body (normal path unchanged)", async () => {
    respond({
      status: 200,
      body: '{"count":1}',
      contentType: "application/json; charset=utf-8",
    });
    const res = await scopelyFetch("/api/admin/x/");
    expect(res).toEqual({ ok: true, status: 200, data: { count: 1 } });
  });

  it("falls back to raw text when the JSON content-type lies about the body", async () => {
    respond({ status: 502, body: "Bad Gateway", contentType: "application/json" });
    const res = await scopelyFetch("/api/admin/x/");
    expect(res).toEqual({ ok: false, status: 502, data: "Bad Gateway" });
  });

  it("non-JSON content-type returns the body as text", async () => {
    respond({ status: 200, body: "<html>", contentType: "text/html" });
    const res = await scopelyFetch("/api/admin/x/");
    expect(res).toEqual({ ok: true, status: 200, data: "<html>" });
  });
});

describe("method guard (AC-7.3)", () => {
  // Green's anonymous write endpoints plus an ordinary API path.
  const paths = [
    "/api/spine/v1/auth/access-requests/",
    "/api/spine/v1/auth/reset-password/request/",
    "/api/v1/auth/forgot-password/",
    "/api/v1/auth/login/",
    "/api/v1/vendors/",
  ];
  const methods = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "post", "Patch"];

  it.each(methods.flatMap((method) => paths.map((p) => [method, p])))(
    "read-only refuses %s %s before any network I/O, audited",
    async (method, p) => {
      await expectRefused(scopelyFetch(p, { method, body: "{}" }), "write_blocked_read_only");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(auditRows().at(-1)).toMatchObject({
        resultSummary: "write_blocked_read_only",
        params: { method: method.toUpperCase(), path: p },
      });
    },
  );

  it("GET and HEAD pass, anonymously, with redirect: manual", async () => {
    await scopelyFetch("/api/v1/health/");
    await scopelyFetch("/api/v1/health/", { method: "HEAD" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://${DEV_HOST}/api/v1/health/`);
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(Object.keys(init.headers)).toEqual([]); // no Cookie, no Authorization
    expect(fetchMock.mock.calls[1][1].method).toBe("HEAD");
  });

  // fetch would throw a bare TypeError for these; the guard refuses them first,
  // audited, and without spending the (here single) per-minute request token.
  it.each([
    ["GET", "{}"],
    ["HEAD", "{}"],
    ["get", ""],
  ])(
    "refuses a %s with a body %j before any request or rate token, audited",
    async (method, body) => {
      writeProfile({ ...DEV, mode: "read-write", maxRequestsPerMinute: 1 });
      const err = await expectRefused(
        scopelyFetch("/api/v1/health/", { method, body }),
        "body_blocked",
      );
      expect(err.message).toBe(`Blocked: a ${method.toUpperCase()} request cannot carry a body.`);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(auditRows().at(-1)).toMatchObject({
        resultSummary: "body_blocked",
        params: { method: method.toUpperCase() },
      });
      await scopelyFetch("/api/v1/health/");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("read-write lets a mutating method through (registry still blocks every zw2 write tool)", async () => {
    writeProfile({ ...DEV, mode: "read-write" });
    await scopelyFetch("/api/x/", { method: "POST", body: "{}" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mode=off (kill switch) refuses even a GET, effective on the next call", async () => {
    await scopelyFetch("/api/v1/health/");
    writeProfile({ ...DEV, mode: "off" });
    await expectRefused(scopelyFetch("/api/v1/health/"), "backend_off");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auditRows().at(-1)).toMatchObject({
      resultSummary: "backend_off",
      params: { method: "GET", host: DEV_HOST, path: "/api/v1/health/" },
    });
  });

  // Caller headers are an allow-list (accept, content-type): every other name
  // is refused, whichever HeadersInit shape carries it.
  it.each([
    ["X-HTTP-Method-Override", "DELETE"],
    ["x-http-method", "PATCH"],
    ["X-Method-Override", "PUT"],
    ["X-Original-Method", "DELETE"],
    ["Host", "zw2green.internal"],
    ["X-Forwarded-Host", "evil.test"],
    ["X-Forwarded-For", "127.0.0.1"],
    ["X-Forwarded-Proto", "http"],
    ["X-Forwarded-Prefix", "/admin"],
    ["X-Forwarded-Server", "evil.test"],
    ["X-Host", "evil.test"],
    ["X-Original-Host", "evil.test"],
    ["X-Original-URL", "/api/admin/"],
    ["X-Rewrite-URL", "/api/admin/"],
    ["Forwarded", "host=evil.test"],
    ["Via", "1.1 evil"],
    ["Upgrade", "websocket"],
    ["Authorization", "Bearer x"],
    ["Proxy-Authorization", "Basic x"],
    ["Cookie", "access_token=x"],
    ["X-Service-Token", "x"],
  ])("refuses a caller-supplied %s header on a GET, audited", async (name, value) => {
    for (const headers of [{ [name]: value }, new Headers({ [name]: value }), [[name, value]]]) {
      fetchMock.mockClear();
      await expectRefused(
        scopelyFetch("/api/v1/health/", { headers: headers as HeadersInit }),
        "header_blocked",
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(auditRows().at(-1)).toMatchObject({
        resultSummary: "header_blocked",
        params: { method: "GET", header: name.toLowerCase() },
      });
    }
  });

  it.each([["X-HTTP-Method-Override\r\nX-A"], ["Host "], ["Ηost"]])(
    "refuses a malformed header name %j before any request",
    async (name) => {
      await expectRefused(
        scopelyFetch("/api/v1/health/", { headers: { [name]: "evil.test" } }),
        "header_blocked",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("forwards only the allow-listed accept and content-type headers", async () => {
    await scopelyFetch("/api/v1/health/", {
      headers: new Headers({ Accept: "application/json", "Content-Type": "text/plain" }),
    });
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      accept: "application/json",
      "content-type": "text/plain",
    });
  });

  it("forwards no RequestInit option but method and body (no dispatcher, signal or redirect override)", async () => {
    writeProfile({ ...DEV, mode: "read-write" });
    const sneaky = {
      method: "POST",
      body: "{}",
      redirect: "follow",
      dispatcher: { evil: true },
      keepalive: true,
      credentials: "include",
      referrer: "https://evil.test/",
      integrity: "sha256-x",
    };
    await scopelyFetch("/api/x/", sneaky as never);
    const init = fetchMock.mock.calls[0][1];
    expect(Object.keys(init).toSorted()).toEqual(
      ["body", "headers", "method", "redirect", "signal"].filter((k) => k in init).toSorted(),
    );
    expect(init).toMatchObject({ method: "POST", body: "{}", redirect: "manual" });
    expect(init.dispatcher).toBeUndefined();
    expect(init.keepalive).toBeUndefined();
    expect(init.headers).toEqual({ "content-type": "application/json" });
  });

  it("the dev profile's own hostHeader is the only Host override sent", async () => {
    writeProfile({ ...DEV, hostHeader: "vip.localhost" });
    await scopelyFetch("/api/v1/health/");
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ host: "vip.localhost" });
  });
});

describe("host guard", () => {
  it.each([
    "@evil.test/x",
    ".evil.test/x",
    "//evil.test/x",
    "/\\evil.test/x",
    "\\\\evil.test/x",
    "https://evil.test/x",
    "evil.test/x",
    "",
  ])("refuses path %j that could leave the app host, audited", async (p) => {
    await expectRefused(scopelyFetch(p), "host_blocked");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditRows().at(-1)).toMatchObject({
      resultSummary: "host_blocked",
      params: { method: "GET" },
    });
  });

  it("refuses a non-string path (its text could change between check and use)", async () => {
    let reads = 0;
    const flipping = { toString: () => (reads++ === 0 ? "/ok/" : "@evil.test/x") };
    const err = await expectRefused(scopelyFetch(flipping as never), "host_blocked");
    expect(fetchMock).not.toHaveBeenCalled();
    // Refused by the path rule before its text is ever read, not only by the
    // later host check on the built URL.
    expect(reads).toBe(0);
    expect(err.message).toMatch(/absolute path/);
  });

  // Property check behind the guard's single host rule: the request URL is
  // baseUrl + a single-slash path, so no accepted path can change the origin.
  it("2,000 seeded adversarial paths either refuse or fetch exactly the profile origin", async () => {
    const parts = [
      "/",
      "\\",
      "@",
      ".",
      ":",
      "%2f",
      "%5c",
      "?",
      "#",
      "\t",
      "\n",
      "\r",
      "\0",
      " ",
      "..",
      "//",
      "。",
      "．",
      "evil.test",
      DEV_HOST,
      "%00",
      "%0d%0a",
      "\u00ad",
      "ß",
      "a",
    ];
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const offOrigin: string[] = [];
    for (let i = 0; i < 2000; i++) {
      resetScopelyGuardForTest();
      fetchMock.mockClear();
      let p = next() < 0.8 ? "/" : "";
      for (let j = 1 + Math.floor(next() * 8); j > 0; j--) {
        p += parts[Math.floor(next() * parts.length)];
      }
      await scopelyFetch(p).catch(() => undefined);
      for (const [url] of fetchMock.mock.calls) {
        const u = new URL(url);
        if (u.origin !== `http://${DEV_HOST}` || u.username || u.password) {
          offOrigin.push(`${JSON.stringify(p)} -> ${url}`);
        }
      }
    }
    expect(offOrigin).toEqual([]);
  });

  it("keeps an '@' inside a path on the app host", async () => {
    await scopelyFetch("/api/x@evil.test/");
    expect(new URL(fetchMock.mock.calls[0][0]).host).toBe(DEV_HOST);
  });

  it("no profile file: refused with 0 fetches and no login, even with legacy env credentials set (AC-7.5)", async () => {
    writeProfile(null);
    const saved = { ...process.env };
    Object.assign(process.env, {
      SCOPELY_BASE_URL: "https://vip.pscx.ai",
      SCOPELY_EMAIL: "bot@example.test",
      SCOPELY_PASSWORD: "x",
      GH_TOKEN: "x",
    });
    try {
      const err = await expectRefused(scopelyFetch("/api/v1/vendors/"), "host_blocked");
      expect(err.message).toMatch(/no valid backend profile/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      for (const key of ["SCOPELY_BASE_URL", "SCOPELY_EMAIL", "SCOPELY_PASSWORD", "GH_TOKEN"]) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  });

  it("an invalid profile file is the same fail-closed refusal, audited", async () => {
    writeProfile({ ...DEV, authMode: "cookie" });
    await expectRefused(scopelyFetch("/api/v1/vendors/"), "host_blocked");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditRows().at(-1)).toMatchObject({
      resultSummary: "host_blocked",
      params: { method: "GET" },
    });
  });
});

describe("redirects (AC-7.16): every 3xx is refused, never followed", () => {
  it.each([
    ["a foreign host", 302, "https://evil.test/x"],
    ["the same host (relative)", 301, "/api/v1/health/"],
    ["the same host (absolute)", 308, `http://${DEV_HOST}/api/v1/health/`],
    ["a protocol-relative foreign host", 302, "//evil.test/x"],
    ["a scheme change on the same host", 301, `https://${DEV_HOST}/x/`],
    ["a userinfo trick", 302, `http://${DEV_HOST}@evil.test/x`],
    ["itself (a loop)", 302, "/api/v1/health"],
    ["no Location at all", 301, undefined],
    ["a not-modified answer", 304, undefined],
    ["a 300 Multiple Choices answer", 300, "/x"],
    ["the last 3xx code", 399, undefined],
  ])("refuses a 3xx to %s with exactly one fetch, audited", async (_label, status, location) => {
    respond({ status, location });
    const err = await expectRefused(scopelyFetch("/api/v1/health"), "redirect_blocked");
    expect(err.message).toMatch(/redirect/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auditRows().at(-1)).toMatchObject({
      resultSummary: "redirect_blocked",
      params: { method: "GET", host: DEV_HOST, path: "/api/v1/health", status },
    });
  });

  it("refuses a redirect for a mutating method too (dev read-write)", async () => {
    writeProfile({ ...DEV, mode: "read-write" });
    respond({ status: 307, location: "/api/y/" });
    await expectRefused(
      scopelyFetch("/api/x/", { method: "POST", body: "{}" }),
      "redirect_blocked",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("request cap and 429 (AC-7.14)", () => {
  it("refuses requests beyond maxRequestsPerMinute with the busy reply, 0 extra fetches, audited", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
    writeProfile({ ...DEV, maxRequestsPerMinute: 2 });
    await scopelyFetch("/a/");
    await scopelyFetch("/b/");
    const err = await expectRefused(scopelyFetch("/c/"), "rate_limited");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(errorResult(err).content[0].text)).toEqual({
      ok: false,
      error: "The new app is busy, try again shortly.",
    });
    expect(auditRows().at(-1)?.resultSummary).toBe("rate_limited");
    clock.mockReturnValue(61_000); // exactly 60 s later the first two have expired
    await scopelyFetch("/d/");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("the window is monotonic: a wall clock stepped back an hour cannot pin the bot busy", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const wall = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 12, 12));
    writeProfile({ ...DEV, maxRequestsPerMinute: 1 });
    await scopelyFetch("/a/");
    await expectRefused(scopelyFetch("/b/"), "rate_limited");
    wall.mockReturnValue(Date.UTC(2026, 9, 12, 11)); // NTP steps the wall clock back
    clock.mockReturnValue(61_001);
    await scopelyFetch("/c/");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps an HTTP 429 to the same busy reply, never to an empty or partial answer", async () => {
    const { stream, state } = trackedBody(16);
    fetchMock.mockResolvedValueOnce(httpResponse({ status: 429, body: stream }));
    const err = await expectRefused(scopelyFetch("/api/v1/health/"), "rate_limited");
    expect(err.message).toBe("The new app is busy, try again shortly.");
    expect(auditRows().at(-1)).toMatchObject({
      resultSummary: "rate_limited",
      params: { status: 429 },
    });
    expect(state.cancelled).toBe(true); // the refused body is released, not left pinned
  });
});

describe("availability hygiene (F7)", () => {
  it("every request carries a 10 s timeout signal", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await scopelyFetch("/api/v1/health/");
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(fetchMock.mock.calls[0][1].signal).toBe(timeout.mock.results[0].value);
  });

  it("a refused 3xx body is cancelled, not left unread", async () => {
    const { stream, state } = trackedBody(16);
    fetchMock.mockResolvedValueOnce(httpResponse({ status: 302, location: "/x/", body: stream }));
    await expectRefused(scopelyFetch("/api/v1/health/"), "redirect_blocked");
    expect(state.cancelled).toBe(true);
  });

  // A cut answer is never a success: a 200 whose body was truncated is
  // ok: false, so the health check and JSON consumers treat it as a failure.
  it("reads at most 64 KB of a body, cancels the rest and reports the cut 200 as ok: false", async () => {
    // Finite on purpose: an uncapped read then fails the assertions below
    // instead of hanging the worker on an endless stream.
    const { stream, state } = trackedBody(16 * 1024, 2000);
    fetchMock.mockResolvedValueOnce(
      httpResponse({ status: 200, body: stream, contentType: "application/json" }),
    );
    const res = await scopelyFetch("/api/v1/health/");
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(6);
    expect(res).toEqual({
      ok: false,
      status: 200,
      data: `${"a".repeat(64 * 1024)}...[truncated]`,
    });
  });

  it("a body of exactly 64 KB is returned whole, unmarked and ok", async () => {
    const { stream, state } = trackedBody(16 * 1024, 4);
    fetchMock.mockResolvedValueOnce(
      httpResponse({ status: 200, body: stream, contentType: "text/plain" }),
    );
    const res = await scopelyFetch("/api/v1/health/");
    expect(res).toEqual({ ok: true, status: 200, data: "a".repeat(64 * 1024) });
    expect(state.cancelled).toBe(false);
  });
});

describe("no login replay (INV-16)", () => {
  it("a 401 is returned as data: one fetch, no retry, no login request", async () => {
    respond({ status: 401, body: '{"detail":"no"}', contentType: "application/json" });
    const res = await scopelyFetch("/api/v1/vendors/");
    expect(res).toEqual({ ok: false, status: 401, data: { detail: "no" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`http://${DEV_HOST}/api/v1/vendors/`);
  });
});
