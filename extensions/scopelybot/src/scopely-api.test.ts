// scopelyFetch tests: the single, deny-by-default choke point to the ZW app
// (PK-7a: AC-7.3 method/host guard, AC-7.5 no login/env fallback, AC-7.14
// request cap + 429, AC-7.16 redirects; the AC-7.12 single-choke-point scan is
// single-choke-point.test.ts), plus the
// original body-parsing regression anchor (live 2026-07-21): DRF answers DELETE
// with 204 No Content but STILL sets Content-Type: application/json, and the
// old resp.json() threw on it, misreporting a completed mutation as a failure.
// Every test runs against a real profile file in a temp workspace; fetch is a
// mock, so nothing leaves the process.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyChain } from "../scripts/verify-audit-chain.mjs";
import { getAuditWriter, setAuditDepsForTest } from "./audit-chain.js";
import {
  auditFile,
  correlatedId,
  correlationHeaders,
  readAuditRows,
} from "./audit.test-helpers.js";
import { readBackendProfile } from "./backend-profile.js";
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

const auditRows = () => readAuditRows(workspace);

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
  vi.restoreAllMocks();
  setAuditDepsForTest(null);
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
        event_type: "write_blocked_read_only",
        http: { method: method.toUpperCase(), path_template: p },
      });
    },
  );

  it("GET and HEAD pass, anonymously, with redirect: manual", async () => {
    await scopelyFetch("/api/v1/health/");
    await scopelyFetch("/api/v1/health/", { method: "HEAD" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    const id = correlatedId(url, `http://${DEV_HOST}/api/v1/health/`);
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    // No Cookie, no Authorization: only the guard's correlation headers.
    expect(init.headers).toEqual(correlationHeaders(id, "dev"));
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
        event_type: "body_blocked",
        http: { method: method.toUpperCase() },
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
      event_type: "backend_off",
      http: { method: "GET", host: DEV_HOST, path_template: "/api/v1/health/" },
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
        event_type: "header_blocked",
        http: { method: "GET" },
        detail: { header: name.toLowerCase() },
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
    const id = correlatedId(fetchMock.mock.calls[0][0], `http://${DEV_HOST}/api/v1/health/`);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      accept: "application/json",
      "content-type": "text/plain",
      ...correlationHeaders(id, "dev"),
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
    const id = correlatedId(fetchMock.mock.calls[0][0], `http://${DEV_HOST}/api/x/`);
    expect(init.headers).toEqual({
      "content-type": "application/json",
      ...correlationHeaders(id, "dev"),
    });
  });

  it("the dev profile's own hostHeader is the only Host override sent", async () => {
    writeProfile({ ...DEV, hostHeader: "vip.localhost" });
    await scopelyFetch("/api/v1/health/");
    const id = correlatedId(fetchMock.mock.calls[0][0], `http://${DEV_HOST}/api/v1/health/`);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      host: "vip.localhost",
      ...correlationHeaders(id, "dev"),
    });
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
      event_type: "host_blocked",
      http: { method: "GET" },
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
  it("2,000 seeded adversarial paths either refuse or fetch exactly the profile origin, correlated", async () => {
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
    // This test is about origin and correlation, not durability (the intent and
    // fs-surface tests pin fsync): skip the ~5 ms fsync of each of ~2,000 appends.
    setAuditDepsForTest({ fs: { ...fs, fsyncSync: () => undefined } });
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
      for (const [url, init] of fetchMock.mock.calls) {
        const u = new URL(url);
        const ids = u.searchParams.getAll("bot_audit_id");
        const correlated =
          ids.length === 1 &&
          /^[0-9A-HJKMNP-TV-Z]{26}$/.test(ids[0]) &&
          init.headers["x-correlation-id"] === ids[0];
        if (u.origin !== `http://${DEV_HOST}` || u.username || u.password || !correlated) {
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
      event_type: "host_blocked",
      http: { method: "GET" },
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
      event_type: "redirect_blocked",
      phase: "outcome",
      http: { method: "GET", host: DEV_HOST, path_template: "/api/v1/health", status },
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
    expect(auditRows().at(-1)?.event_type).toBe("rate_limited");
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
      event_type: "rate_limited",
      phase: "outcome",
      http: { status: 429 },
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
      truncated: true,
    });
    // The audit says so too: a cut answer is never recorded as "ok".
    expect(auditRows().findLast((r) => r.event_type === "http_outcome")?.result).toEqual({
      status: "truncated",
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
    correlatedId(fetchMock.mock.calls[0][0], `http://${DEV_HOST}/api/v1/vendors/`);
  });
});

// INV-15 (audit before action) and INV-5 (correlation), spec tests 18-25.
// Appends fail through an fs proxy that refuses chosen opens of the audit file.
function failingAudit(shouldFail: () => boolean, code = "ENOSPC") {
  const target = auditFile(workspace);
  const proxy = new Proxy(fs, {
    get(real, prop: string) {
      const fn = (real as unknown as Record<string, unknown>)[prop];
      if (prop !== "openSync" || typeof fn !== "function") {
        return fn;
      }
      return (...args: unknown[]) => {
        const append = typeof args[1] === "number" && (args[1] & fs.constants.O_APPEND) !== 0;
        if (args[0] === target && append && shouldFail()) {
          throw Object.assign(new Error(code), { code });
        }
        return (fn as (...a: unknown[]) => unknown).apply(real, args);
      };
    },
  });
  return proxy as unknown as typeof fs;
}

const ok = () => httpResponse({ status: 200, body: '{"ok":1}', contentType: "application/json" });
const chain = () => fs.readFileSync(auditFile(workspace), "utf8");
const byId = (id: string) => auditRows().filter((r) => r.audit_id === id);

describe("audit before request (INV-15) and correlation (INV-5)", () => {
  it("writes a durable http_intent before the request, then exactly one http_outcome with the same audit_id", async () => {
    let atFetch: ReturnType<typeof auditRows> = [];
    fetchMock.mockImplementation(async () => {
      atFetch = auditRows();
      return ok();
    });
    await scopelyFetch("/api/v1/health/?zeta=VALUE-ZETA&alpha=VALUE-ALPHA");
    const intent = atFetch.at(-1);
    expect(intent).toMatchObject({
      event_type: "http_intent",
      phase: "intent",
      http: {
        method: "GET",
        host: DEV_HOST,
        path_template: "/api/v1/health/",
        query_keys: ["alpha", "zeta"],
        status: null,
      },
    });
    expect(atFetch.some((r) => r.event_type === "http_outcome")).toBe(false);
    const [url, init] = fetchMock.mock.calls[0];
    const id = correlatedId(
      url,
      `http://${DEV_HOST}/api/v1/health/?zeta=VALUE-ZETA&alpha=VALUE-ALPHA`,
    );
    expect(id).toBe(intent?.audit_id);
    expect(init.headers["x-correlation-id"]).toBe(id);
    expect(byId(id).map((r) => [r.event_type, r.phase])).toEqual([
      ["http_intent", "intent"],
      ["http_outcome", "outcome"],
    ]);
    expect(byId(id)[1]).toMatchObject({ http: { status: 200 }, result: { status: "ok" } });
    expect(chain()).not.toContain("VALUE-"); // query keys only, never values
    expect(verifyChain(chain(), { requirePaired: true }).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses with audit_unavailable and sends nothing when the intent row cannot be written; the rate slot is not spent", async () => {
    writeProfile({ ...DEV, maxRequestsPerMinute: 1 });
    let failing = true;
    setAuditDepsForTest({ fs: failingAudit(() => failing) });
    const err = await expectRefused(scopelyFetch("/api/v1/health/"), "audit_unavailable");
    expect(err.message).toBe("Request not sent: the audit log is unavailable.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAuditWriter(workspace).degraded()).toMatchObject({ code: "ENOSPC" });
    failing = false;
    // The one per-minute slot is still free.
    await expect(scopelyFetch("/api/v1/health/")).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getAuditWriter(workspace).degraded()).toBeNull();
    const gap = auditRows().find((r) => r.event_type === "audit_gap");
    expect(gap).toMatchObject({ detail: { refused_requests: 1, error_code: "ENOSPC" } });
    expect(auditRows().map((r) => r.event_type)).toEqual([
      "audit_gap",
      "http_intent",
      "http_outcome",
    ]);
  });

  it("returns the answer when the outcome row fails (audit_degraded), closes the gap next append, and records the orphan as indeterminate after its deadline", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let failNext = false;
    let clock = Date.now();
    setAuditDepsForTest({
      now: () => clock,
      fs: failingAudit(() => {
        const fail = failNext;
        failNext = false;
        return fail;
      }),
    });
    fetchMock.mockImplementationOnce(async () => {
      failNext = true;
      return ok();
    });
    await expect(scopelyFetch("/api/v1/health/")).resolves.toEqual({
      ok: true,
      status: 200,
      data: { ok: 1 },
    });
    expect(errors).toHaveBeenCalledWith(
      expect.stringMatching(/^\[scopelybot-audit\] audit_degraded ENOSPC/),
    );
    expect(getAuditWriter(workspace).degraded()).toMatchObject({ code: "ENOSPC" });
    const orphan = auditRows().find((r) => r.event_type === "http_intent");
    expect(byId(String(orphan?.audit_id))).toHaveLength(1);

    fetchMock.mockImplementation(async () => ok());
    await scopelyFetch("/api/v1/health/");
    expect(auditRows().find((r) => r.event_type === "audit_gap")).toMatchObject({
      detail: { failures: 1, refused_requests: 0, error_code: "ENOSPC" },
    });
    expect(verifyChain(chain(), { requirePaired: true })).toMatchObject({
      ok: false,
      reason: "unpaired_intent",
    });

    clock += 14_000; // still inside the orphan's 15 s deadline: no recovery yet
    await scopelyFetch("/api/v1/health/");
    expect(byId(String(orphan?.audit_id))).toHaveLength(1);

    clock += 2_000; // past the 15 s deadline
    await scopelyFetch("/api/v1/health/");
    expect(byId(String(orphan?.audit_id)).at(-1)).toMatchObject({
      event_type: "http_outcome",
      result: { status: "indeterminate", reason: "crash_recovery" },
      recovery: { source: "recovery", intent_seq: orphan?.seq },
    });
    expect(verifyChain(chain(), { requirePaired: true }).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4); // four requests, nothing retried
  });

  it("dev read-write: a failed outcome row of a write latches further writes (no request), reads continue", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    writeProfile({ ...DEV, mode: "read-write" });
    let failNext = false;
    setAuditDepsForTest({
      fs: failingAudit(() => {
        const fail = failNext;
        failNext = false;
        return fail;
      }),
    });
    fetchMock.mockImplementationOnce(async () => {
      failNext = true;
      return ok();
    });
    await scopelyFetch("/api/x/", { method: "POST", body: "{}" });
    fetchMock.mockImplementation(async () => ok());
    await expectRefused(
      scopelyFetch("/api/x/", { method: "POST", body: "{}" }),
      "audit_unavailable",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(scopelyFetch("/api/v1/health/")).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resetScopelyGuardForTest(); // a restart clears the latch
    await scopelyFetch("/api/x/", { method: "POST", body: "{}" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["a timeout", new DOMException("timed out", "TimeoutError"), "indeterminate", "TimeoutError"],
    [
      "a connection reset",
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
      "indeterminate",
      "TypeError",
    ],
    [
      "a refused connection",
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
      "not_sent",
      "ECONNREFUSED",
    ],
    [
      "a DNS failure",
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }),
      "not_sent",
      "ENOTFOUND",
    ],
  ])("%s: one fetch, no retry, outcome %s", async (_label, error, status, errorClass) => {
    fetchMock.mockImplementation(async () => {
      throw error;
    });
    await expect(scopelyFetch("/api/v1/health/")).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const intent = auditRows().find((r) => r.event_type === "http_intent");
    expect(byId(String(intent?.audit_id)).at(-1)).toMatchObject({
      event_type: "http_outcome",
      http: { status: null },
      result: { status, error_class: errorClass },
    });
  });

  it("a 5xx is one fetch and an http_error outcome", async () => {
    respond({ status: 503, body: "busy" });
    const res = await scopelyFetch("/api/v1/health/");
    expect(res).toMatchObject({ ok: false, status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auditRows().at(-1)).toMatchObject({
      event_type: "http_outcome",
      http: { status: 503 },
      result: { status: "http_error" },
    });
  });

  it("an intent's deadline is 15 s after it was written (the recovery boundary)", async () => {
    await scopelyFetch("/api/v1/health/");
    const intent = auditRows().find((r) => r.event_type === "http_intent");
    const gap = Date.parse(String(intent?.http.deadline_ts)) - Date.parse(String(intent?.ts));
    expect(gap).toBeGreaterThan(14_900);
    expect(gap).toBeLessThanOrEqual(15_000);
  });

  it.each([
    ["a plain id", "abc-123:XY.z_", "abc-123:XY.z_"],
    ["exactly 128 characters", "a".repeat(128), "a".repeat(128)],
    ["129 characters", "a".repeat(129), null],
    ["a space", "bad id", null],
    ["a quote", 'id"injected', null],
  ])(
    "x-request-id with %s is stored only when it matches the id pattern",
    async (_l, value, stored) => {
      fetchMock.mockResolvedValueOnce(
        new Response("{}", { status: 200, headers: { "x-request-id": value } }),
      );
      await scopelyFetch("/api/v1/health/");
      expect(auditRows().at(-1)).toMatchObject({
        event_type: "http_outcome",
        http: { x_request_id: stored },
      });
    },
  );

  it("a very long redirect host is bounded: exactly one terminal row, never a refusal or an orphan", async () => {
    const host = `${"a".repeat(15_600)}.example`;
    respond({ status: 302, location: `http://${host}/` });
    await expectRefused(scopelyFetch("/api/v1/health/"), "redirect_blocked");
    const intent = auditRows().find((r) => r.event_type === "http_intent");
    const rows = byId(String(intent?.audit_id));
    expect(rows.map((r) => r.event_type)).toEqual(["http_intent", "redirect_blocked"]);
    const recorded = String(rows[1].http.redirect_to_host);
    expect(recorded.length).toBeLessThanOrEqual(253);
    expect(recorded).toBe(
      `${host.slice(0, 240)}~${createHash("sha256").update(host).digest("hex").slice(0, 12)}`,
    );
    expect(verifyChain(chain(), { requirePaired: true }).ok).toBe(true);
  });

  it("a very long query key is bounded in the row, and the request is still sent", async () => {
    const key = "k".repeat(20_000);
    await expect(scopelyFetch(`/api/v1/health/?${key}=1`)).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const keys = auditRows().find((r) => r.event_type === "http_intent")?.http.query_keys;
    expect(keys).toEqual([
      `${key.slice(0, 240)}~${createHash("sha256").update(key).digest("hex").slice(0, 12)}`,
    ]);
    expect(verifyChain(chain(), { requirePaired: true }).ok).toBe(true);
  });

  it("rows carry the live profile's env and policy; the fail-closed default reads env unknown", async () => {
    const raw = fs.readFileSync(path.join(workspace, "scopelybot-backend.json"));
    await scopelyFetch("/api/v1/health/");
    expect(auditRows().find((r) => r.event_type === "http_intent")).toMatchObject({
      env: "dev",
      policy: {
        state: "valid",
        mode: "read-only",
        profile_sha256: createHash("sha256").update(raw).digest("hex"),
      },
    });
    writeProfile(null);
    await expectRefused(scopelyFetch("/api/v1/health/"), "host_blocked");
    expect(auditRows().at(-1)).toMatchObject({
      event_type: "host_blocked",
      env: "unknown",
      policy: { state: "fail_closed_default", mode: "read-only", profile_sha256: null },
    });
    // Back to the first content (re-parsed: the cache keeps one entry per path).
    fs.writeFileSync(path.join(workspace, "scopelybot-backend.json"), raw);
    await scopelyFetch("/api/v1/health/");
    expect(auditRows().at(-1)).toMatchObject({ event_type: "http_outcome", env: "dev" });
    // Another workspace's profile read in between; this workspace's next read is
    // served from the cache and must still report its own policy.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "scopely-api-other-"));
    try {
      readBackendProfile(other);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
    await scopelyFetch("/api/v1/health/");
    expect(auditRows().at(-1)).toMatchObject({ event_type: "http_outcome", env: "dev" });
  });

  it("a 3xx pairs its intent with redirect_blocked and records only the redirect host, never Location", async () => {
    respond({ status: 302, location: "https://evil.test/LOCATION-SECRET-PATH?x=1" });
    await expectRefused(scopelyFetch("/api/v1/health/"), "redirect_blocked");
    const intent = auditRows().find((r) => r.event_type === "http_intent");
    expect(byId(String(intent?.audit_id)).map((r) => r.event_type)).toEqual([
      "http_intent",
      "redirect_blocked",
    ]);
    expect(auditRows().at(-1)).toMatchObject({
      http: { status: 302, redirect_to_host: "evil.test" },
    });
    expect(chain()).not.toContain("LOCATION-SECRET-PATH");
  });

  it("a 429 pairs its intent with an outcome rate_limited row; the local cap writes one row and no intent", async () => {
    fetchMock.mockResolvedValueOnce(httpResponse({ status: 429 }));
    await expectRefused(scopelyFetch("/api/v1/health/"), "rate_limited");
    const intent = auditRows().find((r) => r.event_type === "http_intent");
    expect(byId(String(intent?.audit_id)).map((r) => [r.event_type, r.phase])).toEqual([
      ["http_intent", "intent"],
      ["rate_limited", "outcome"],
    ]);
    resetScopelyGuardForTest();
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    writeProfile({ ...DEV, maxRequestsPerMinute: 1 });
    await scopelyFetch("/a/");
    const before = auditRows().length;
    await expectRefused(scopelyFetch("/b/"), "rate_limited");
    expect(auditRows().slice(before)).toEqual([
      expect.objectContaining({ event_type: "rate_limited", phase: "single" }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a 429 closes its intent: no crash_recovery row after the deadline, and it verifies paired", async () => {
    const t0 = Date.now();
    setAuditDepsForTest({ now: () => t0 });
    fetchMock.mockResolvedValueOnce(httpResponse({ status: 429 }));
    await expectRefused(scopelyFetch("/api/v1/health/"), "rate_limited");
    const intent = auditRows().find((r) => r.event_type === "http_intent");
    setAuditDepsForTest({ now: () => t0 + 20_000 }); // a restart after the deadline
    await scopelyFetch("/api/v1/health/");
    expect(byId(String(intent?.audit_id)).map((r) => r.event_type)).toEqual([
      "http_intent",
      "rate_limited",
    ]);
    expect(verifyChain(chain(), { requirePaired: true }).ok).toBe(true);
  });

  it("a body that fails mid-stream gets an outcome with its status and error_class body_read", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(new Uint8Array(8).fill(0x61));
        } else {
          controller.error(new Error("socket closed"));
        }
      },
    });
    fetchMock.mockResolvedValueOnce(httpResponse({ status: 200, body }));
    await expect(scopelyFetch("/api/v1/health/")).rejects.toThrow("socket closed");
    expect(auditRows().at(-1)).toMatchObject({
      event_type: "http_outcome",
      http: { status: 200 },
      result: { status: "error", error_class: "body_read" },
    });
  });

  it("overwrites a caller bot_audit_id, keeps the caller's other params, and sends the id exactly once", async () => {
    await scopelyFetch("/api/v1/x/?bot_audit_id=FORGED&keep=1");
    const u = new URL(fetchMock.mock.calls[0][0]);
    expect(u.searchParams.getAll("bot_audit_id")).toHaveLength(1);
    expect(u.searchParams.get("bot_audit_id")).not.toBe("FORGED");
    expect(u.searchParams.get("keep")).toBe("1");
    const intent = auditRows().find((r) => r.event_type === "http_intent");
    expect(u.searchParams.get("bot_audit_id")).toBe(intent?.audit_id);
    expect(intent?.http.query_keys).toEqual(["keep"]);
    expect(fetchMock.mock.calls[0][1].headers["x-vipbot-client"]).toBe("scopelybot/0.1.0 (dev)");
  });

  it.each(["X-Correlation-ID", "x-vipbot-client"])(
    "a caller-supplied %s header is still refused (header_blocked), before any intent",
    async (name) => {
      await expectRefused(
        scopelyFetch("/api/v1/health/", { headers: { [name]: "forged" } }),
        "header_blocked",
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(auditRows().some((r) => r.event_type === "http_intent")).toBe(false);
    },
  );

  it("guard refusals before the request write one row and no intent", async () => {
    await expectRefused(
      scopelyFetch("/api/x/", { method: "POST", body: "{}" }),
      "write_blocked_read_only",
    );
    await expectRefused(scopelyFetch("//evil.test/x"), "host_blocked");
    const rows = auditRows().filter((r) => r.event_type !== "policy_change");
    expect(rows.map((r) => r.event_type)).toEqual(["write_blocked_read_only", "host_blocked"]);
  });

  it("templates id-like path segments; rows never carry the raw ids", async () => {
    await scopelyFetch("/api/v1/users/4711/sessions/0f8fad5b-d9cb-469f-a165-70867728950e/");
    expect(auditRows().at(-1)?.http.path_template).toBe("/api/v1/users/:id/sessions/:id/");
    expect(chain()).not.toContain("0f8fad5b");
  });

  it("a tampered chain tail fails every request closed (INTEGRITY): no request until an operator reseal (Q3)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await scopelyFetch("/api/v1/health/");
    fs.writeFileSync(auditFile(workspace), chain().replace('"status":200', '"status":201'));
    await expectRefused(scopelyFetch("/api/v1/health/"), "audit_unavailable");
    await expectRefused(scopelyFetch("/api/v1/health/"), "audit_unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getAuditWriter(workspace).degraded()).toMatchObject({ code: "INTEGRITY" });
  });

  it("5 concurrent GETs: 5 intent/outcome pairs with unique ids, one verifiable chain", async () => {
    await Promise.all(Array.from({ length: 5 }, () => scopelyFetch("/api/v1/health/")));
    const intents = auditRows().filter((r) => r.event_type === "http_intent");
    expect(new Set(intents.map((r) => r.audit_id)).size).toBe(5);
    for (const intent of intents) {
      expect(byId(intent.audit_id).map((r) => r.event_type)).toEqual([
        "http_intent",
        "http_outcome",
      ]);
    }
    expect(verifyChain(chain(), { requirePaired: true }).ok).toBe(true);
  });
});
