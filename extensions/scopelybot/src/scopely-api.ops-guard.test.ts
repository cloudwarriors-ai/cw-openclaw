// Only this test module injects a reserved non-network origin into the real policy.
vi.mock("./ops-write-policy.js", async (original) => {
  const actual = await original<typeof import("./ops-write-policy.js")>();
  const origins = ["https://core-production.invalid:9443"];
  return {
    ...actual,
    isReviewedProductionOrigin: (origin: string) =>
      actual.isReviewedProductionOrigin(origin, origins),
    productionCoreEnabled: (profile: Parameters<typeof actual.productionCoreEnabled>[0]) =>
      actual.productionCoreEnabled(profile, origins),
    nativeWriteScope: (
      profile: Parameters<typeof actual.nativeWriteScope>[0],
      channel: string | undefined,
    ) => actual.nativeWriteScope(profile, channel, origins),
  };
});
// The guard's operator-layer branch (scopely-api.ts scopelyOpsInvoke, M13
// slice 1): the ONE request shape added to the read-only guard. Pins exactly
// what widened (a POST to the exact invoke path, a read capability, a
// guard-built body, guard-injected Authorization: Bearer, requester Zoom id and bot
// audit id headers) and that nothing else did (every other POST/PUT/PATCH/
// DELETE, caller-supplied identity headers, the token on any other request).
// The token file rules: read per request, refused when missing, empty, not a
// zwops_ token (identity.py _TOKEN_RE), not a regular file, not ours, or
// readable by group/other; never logged or audited.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The owner check compares the token file's uid with the gateway's own; this
// pass-through mock lets one test pretend the gateway runs as another user.
const ownUid = vi.hoisted(() => ({ value: undefined as number | undefined }));
// One test needs an audit id outside the kernel's id charset.
const auditIdOverride = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("./audit-chain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./audit-chain.js")>();
  return { ...actual, newAuditId: () => auditIdOverride.value ?? actual.newAuditId() };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    userInfo: () => ({ ...actual.userInfo(), uid: ownUid.value ?? actual.userInfo().uid }),
  };
});

import { readAuditRows } from "./audit.test-helpers.js";
import { kernelCanonical } from "./ops-kernel.test-helpers.js";
import {
  canonicalZoomId,
  OPS_INVOKE_PATH,
  OPS_READ_CAPABILITIES,
  type OpsInvocation,
  resetScopelyGuardForTest,
  ScopelyGuardError,
  scopelyFetch,
  scopelyOpsInvoke,
} from "./scopely-api.js";

// identity.py _TOKEN_RE: zwops_<12 hex>_<32-64 of [A-Za-z0-9_-]>.
const TOKEN = "zwops_0123456789ab_Test-Token_0123456789abcdefABCDEF_xyz";
const ROTATED = "zwops_fedcba987654_Rotated_Token-0123456789abcdefABCDEF";
const DEV_HOST = "100.114.142.100:8022";
const DEV = {
  env: "dev",
  baseUrl: `http://${DEV_HOST}`,
  allowedHosts: [DEV_HOST],
  hostHeader: "vip.localhost",
  authMode: "service-token",
};
const fetchMock = vi.fn();
let workspace: string;

const tokenFile = () => path.join(workspace, "scopelybot-ops-token");
function writeProfile(body: Record<string, unknown>) {
  fs.writeFileSync(path.join(workspace, "scopelybot-backend.json"), JSON.stringify(body));
}
function writeToken(content: string, mode = 0o600) {
  fs.rmSync(tokenFile(), { force: true, recursive: true });
  fs.writeFileSync(tokenFile(), content);
  fs.chmodSync(tokenFile(), mode);
}
const auditRows = () => readAuditRows(workspace);
const op = (extra: Partial<OpsInvocation> = {}): OpsInvocation => ({
  capability: "catalog.vendors.get",
  args: { vendor_key: "zoom" },
  requesterZoomId: "abcdef_operator_1",
  ...extra,
});

async function refused(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ScopelyGuardError);
  expect((err as ScopelyGuardError).code).toBe(code);
  expect((err as Error).message).not.toContain(TOKEN);
  return err as ScopelyGuardError;
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ops-guard-"));
  process.env.OPENCLAW_WORKSPACE = workspace;
  writeProfile(DEV);
  writeToken(`${TOKEN}\n`);
  resetScopelyGuardForTest();
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ ok: true, request_id: "req-7", data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  ownUid.value = undefined;
  auditIdOverride.value = undefined;
  delete process.env.OPENCLAW_WORKSPACE;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("the invoke request is fixed by the guard", () => {
  it("POSTs the exact path with the guard-built body and exactly the guard's headers", async () => {
    const res = await scopelyOpsInvoke(op());
    expect(res).toEqual({
      ok: true,
      status: 200,
      data: { ok: true, request_id: "req-7", data: {} },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    const auditId = parsed.searchParams.get("bot_audit_id");
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`http://${DEV_HOST}${OPS_INVOKE_PATH}`);
    expect([...parsed.searchParams.keys()]).toEqual(["bot_audit_id"]);
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(init.headers).toEqual({
      "content-type": "application/json",
      host: "vip.localhost",
      "x-correlation-id": auditId,
      "x-vipbot-client": "scopelybot/0.1.0 (dev)",
      authorization: `Bearer ${TOKEN}`,
      "x-ops-requester-zoom-id": "abcdef_operator_1",
      "x-ops-bot-audit-id": auditId,
    });
    expect(JSON.parse(init.body)).toEqual({
      capability: "catalog.vendors.get",
      args: { vendor_key: "zoom" },
      correlation_id: auditId,
    });
  });

  it("no requester means no requester header, and the old email header is never sent", async () => {
    await scopelyOpsInvoke(
      op({ capability: "system.whoami", args: {}, requesterZoomId: undefined }),
    );
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("x-ops-requester-zoom-id");
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("x-ops-requester");
  });

  it("the token is re-read on every request (no cache) and its loss refuses the next one", async () => {
    await scopelyOpsInvoke(op());
    writeToken(ROTATED);
    await scopelyOpsInvoke(op());
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe(`Bearer ${ROTATED}`);
    fs.rmSync(tokenFile());
    await refused(scopelyOpsInvoke(op()), "auth_unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("the intent and outcome rows record the capability and the kernel ids, never the token or email", async () => {
    await scopelyOpsInvoke(op());
    const rows = auditRows().filter((r) => r.event_type.startsWith("http_"));
    expect(rows.map((r) => r.event_type)).toEqual(["http_intent", "http_outcome"]);
    for (const row of rows) {
      expect(row.http).toMatchObject({ capability: "catalog.vendors.get", requester_header: true });
    }
    expect(rows[1].result).toEqual({
      status: "ok",
      kernel: { ok: true, request_id: "req-7", error_code: null, detail: null },
    });
    const file = fs.readFileSync(path.join(workspace, "scopelybot", "audit-v2.jsonl"), "utf8");
    expect(file).not.toContain(TOKEN);
  });

  it("is sent once: a network error is not retried", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(scopelyOpsInvoke(op())).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("nothing else widened", () => {
  // Every mutating verb from a scopelyFetch caller is still refused, the
  // invoke path included: only scopelyOpsInvoke can build that request.
  it.each(
    ["POST", "PUT", "PATCH", "DELETE"].flatMap((method) =>
      [OPS_INVOKE_PATH, `${OPS_INVOKE_PATH}x/`, "/api/spine/v1/ops/mcp/", "/api/v1/vendors/"].map(
        (p) => [method, p] as const,
      ),
    ),
  )("%s %s from a caller stays refused under read-only", async (method, p) => {
    await refused(
      scopelyFetch(p, { method, body: JSON.stringify({ capability: "system.whoami", args: {} }) }),
      "write_blocked_read_only",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "authorization",
    "Authorization",
    "x-service-token",
    "x-ops-requester",
    "x-ops-requester-zoom-id",
    "X-Ops-Requester-Zoom-Id",
    "x-ops-bot-audit-id",
    "x-on-behalf-of",
    "x-correlation-id",
  ])("a caller cannot send %s", async (header) => {
    await refused(
      scopelyFetch("/api/v1/health/", { headers: { [header]: "v" } }),
      "header_blocked",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a GET under service-token carries no token, requester or bot audit id header", async () => {
    await scopelyFetch("/api/v1/health/");
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(Object.keys(headers).toSorted()).toEqual(
      ["host", "x-correlation-id", "x-vipbot-client"].toSorted(),
    );
    expect(JSON.stringify(headers)).not.toContain(TOKEN);
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
  });

  it.each(["catalog.vendors.create", "audit.search", "system.whoami.x", "", "constructor"])(
    "capability %j outside the read allow-list is refused before any I/O",
    async (capability) => {
      fs.rmSync(tokenFile());
      await refused(
        scopelyOpsInvoke(op({ capability: capability as OpsInvocation["capability"] })),
        "write_blocked_read_only",
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(auditRows().at(-1)).toMatchObject({ event_type: "write_blocked_read_only" });
    },
  );

  it("the allow-list contains only reviewed native reads", () => {
    expect([...OPS_READ_CAPABILITIES].toSorted()).toEqual(
      [
        "catalog.deployment_types.list",
        "catalog.project_types.list",
        "catalog.scoping_cards.get",
        "catalog.scoping_cards.list",
        "catalog.vendors.get",
        "catalog.vendors.list",
        "identity.users.get",
        "identity.users.list",
        "pricing.defaults.list",
        "sessions.get",
        "sessions.list",
        "system.health",
        "system.whoami",
      ].toSorted(),
    );
  });

  // The guard takes only the canonical form (ops-client canonicalizes first).
  it.each([
    ["upper case", "AbCdEf_Operator_1"],
    ["the JID suffix", "abcdef_operator_1@xmpp.zoom.us"],
    ["surrounding space", " abcdef_operator_1"],
    ["a newline", "abcdef_operator_1\r\nx-evil: 1"],
    ["an email", "alice@cloudwarriors.ai"],
    ["a comma pair", "abcdef_operator_1,op_bob_2"],
    ["5 characters", "abcde"],
    ["65 characters", "a".repeat(65)],
    ["an empty string", ""],
  ])("a requester id with %s is refused before any I/O", async (_label, requesterZoomId) => {
    await refused(scopelyOpsInvoke(op({ requesterZoomId })), "header_blocked");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditRows().at(-1)).toMatchObject({
      event_type: "header_blocked",
      detail: { header: "x-ops-requester-zoom-id" },
    });
  });

  it.each(["abcdef", "a".repeat(64), "op_bob-2_x"])("a canonical id %s is sent", async (id) => {
    await scopelyOpsInvoke(op({ requesterZoomId: id }));
    expect(fetchMock.mock.calls[0][1].headers["x-ops-requester-zoom-id"]).toBe(id);
  });

  it.each([
    ["an array", []],
    ["a string", "zoom"],
    ["over 4 KB", { vendor_key: "z".repeat(5000) }],
  ])("args that are %s are refused", async (_label, args) => {
    await refused(scopelyOpsInvoke(op({ args: args as Record<string, unknown> })), "body_blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The cap is 4096 BYTES of serialized args: {"vendor_key":""} is 17 bytes.
  const sized = (value: string) => ({ vendor_key: value });
  it("args of exactly 4096 bytes are sent; 4097 bytes are refused", async () => {
    expect(Buffer.byteLength(JSON.stringify(sized("z".repeat(4079))))).toBe(4096);
    await expect(scopelyOpsInvoke(op({ args: sized("z".repeat(4079)) }))).resolves.toMatchObject({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await refused(scopelyOpsInvoke(op({ args: sized("z".repeat(4080)) })), "body_blocked");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the cap counts bytes, not characters (multi-byte text)", async () => {
    const value = "\u00e9".repeat(2100); // 2,117 characters, 4,217 bytes serialized
    expect(JSON.stringify(sized(value)).length).toBeLessThan(4096);
    await refused(scopelyOpsInvoke(op({ args: sized(value) })), "body_blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// F2: an invoke reads up to the kernel's MAX_RESULT_BYTES (256 KB) plus 8 KB
// of envelope; every other request keeps the 64 KB read.
describe("the invoke's read cap", () => {
  const CAP = 256 * 1024 + 8 * 1024;
  const body = (bytes: number) => async () =>
    new Response("a".repeat(bytes), { status: 200, headers: { "content-type": "text/plain" } });

  it("a body of exactly the cap is read whole", async () => {
    fetchMock.mockImplementation(body(CAP));
    const res = await scopelyOpsInvoke(op());
    expect(res).toMatchObject({ ok: true, status: 200 });
    expect(res).not.toHaveProperty("truncated");
    expect((res.data as string).length).toBe(CAP);
  });

  it("one byte more is cut, not ok, and audited as truncated", async () => {
    fetchMock.mockImplementation(body(CAP + 1));
    const res = await scopelyOpsInvoke(op());
    expect(res).toMatchObject({ ok: false, truncated: true });
    expect(auditRows().findLast((r) => r.event_type === "http_outcome")?.result).toMatchObject({
      status: "truncated",
    });
  });

  it("a plain GET still reads at most 64 KB", async () => {
    fetchMock.mockImplementation(body(64 * 1024 + 1));
    const res = await scopelyFetch("/api/v1/health/");
    expect(res).toMatchObject({ ok: false, truncated: true });
  });
});

describe("the per-minute cap applies to invokes too", () => {
  it("past maxRequestsPerMinute an invoke is refused as busy, audited, and not sent", async () => {
    writeProfile({ ...DEV, maxRequestsPerMinute: 1 });
    await scopelyOpsInvoke(op());
    await refused(scopelyOpsInvoke(op()), "rate_limited");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auditRows().at(-1)).toMatchObject({
      event_type: "rate_limited",
      http: { capability: "catalog.vendors.get", method: "POST" },
    });
  });
});

describe("credential and kill-switch gates", () => {
  it("authMode anonymous never sends an invoke", async () => {
    writeProfile({ ...DEV, authMode: "anonymous" });
    await refused(scopelyOpsInvoke(op()), "auth_unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditRows().at(-1)).toMatchObject({
      event_type: "auth_unavailable",
      detail: { reason: "anonymous" },
    });
  });

  it("the kill switch refuses first, even with no token file", async () => {
    writeProfile({ ...DEV, mode: "off" });
    fs.rmSync(tokenFile());
    await refused(scopelyOpsInvoke(op()), "backend_off");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", () => fs.rmSync(tokenFile())],
    ["empty", () => writeToken("")],
    ["empty", () => writeToken(" \n\n")],
    ["permissions", () => writeToken(TOKEN, 0o644)],
    ["permissions", () => writeToken(TOKEN, 0o640)],
    ["permissions", () => writeToken(TOKEN, 0o604)],
    ["malformed", () => writeToken(`${TOKEN} second`)],
    ["malformed", () => writeToken("short")],
    // Shapes the kernel refuses (identity.py _TOKEN_RE), so none is ever sent:
    ["malformed", () => writeToken("svc_TEST.token-0123456789abcdef")],
    ["malformed", () => writeToken(`Bearer ${TOKEN}`)],
    ["malformed", () => writeToken(TOKEN.replace("0123456789ab", "0123456789AB"))],
    ["malformed", () => writeToken(TOKEN.replace("0123456789ab", "0123456789a"))],
    ["malformed", () => writeToken(`zwops_0123456789ab_${"a".repeat(31)}`)],
    ["malformed", () => writeToken(`zwops_0123456789ab_${"a".repeat(65)}`)],
    ["malformed", () => writeToken(`zwops_0123456789ab_${"a".repeat(40)}.`)],
    ["too_large", () => writeToken("a".repeat(5000))],
    [
      "not_regular_file",
      () => {
        fs.rmSync(tokenFile());
        fs.mkdirSync(tokenFile(), { mode: 0o700 });
      },
    ],
    [
      "not_regular_file",
      () => {
        const real = path.join(workspace, "real-token");
        fs.writeFileSync(real, TOKEN, { mode: 0o600 });
        fs.rmSync(tokenFile());
        fs.symlinkSync(real, tokenFile());
      },
    ],
  ])(
    "token file %s: refused with that code, nothing sent, no intent row",
    async (problem, setup) => {
      setup();
      const err = await refused(scopelyOpsInvoke(op()), "auth_unavailable");
      expect(err.message).toContain(`(${problem})`);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(auditRows().some((r) => r.event_type === "http_intent")).toBe(false);
      expect(auditRows().at(-1)).toMatchObject({
        event_type: "auth_unavailable",
        detail: { reason: problem },
      });
      const file = fs.readFileSync(path.join(workspace, "scopelybot", "audit-v2.jsonl"), "utf8");
      expect(file).not.toContain(TOKEN);
    },
  );

  it("the longest and shortest kernel-valid tokens are accepted", async () => {
    for (const secret of ["a".repeat(32), "Z_-9".repeat(16)]) {
      writeToken(`zwops_0123456789ab_${secret}\n`);
      await scopelyOpsInvoke(op());
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an audit id outside the kernel's id charset is refused before any I/O", async () => {
    auditIdOverride.value = "id with spaces";
    await refused(scopelyOpsInvoke(op()), "header_blocked");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditRows().some((r) => r.event_type === "http_intent")).toBe(false);
  });

  it("a bare spine refusal (401) is still summarized on the outcome row", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            detail: "Invalid token.",
            code: "authentication_failed",
            request_id: "r-401",
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );
    await scopelyOpsInvoke(op());
    expect(auditRows().findLast((r) => r.event_type === "http_outcome")?.result).toEqual({
      status: "http_error",
      kernel: {
        ok: null,
        request_id: "r-401",
        error_code: "authentication_failed",
        detail: "Invalid token.",
      },
    });
  });

  it("a token file owned by another user is refused", async () => {
    ownUid.value = 4242;
    await refused(scopelyOpsInvoke(op()), "auth_unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditRows().at(-1)?.detail).toEqual({ reason: "not_owner" });
  });
});

// IDENTITY-B contract: the plugin's normaliser and the kernel's (the mock's
// independent copy) agree on one shared table of vectors.
describe("canonical Zoom user id (shared vectors)", () => {
  const VECTORS = JSON.parse(
    fs.readFileSync(new URL("./fixtures/zoom_id_vectors.json", import.meta.url), "utf8"),
  ).vectors as { input: string; canonical: string | null; note: string; wire?: string }[];

  it("is the kernel's file at 87b8b516, byte for byte (56 rows)", () => {
    const raw = fs.readFileSync(new URL("./fixtures/zoom_id_vectors.json", import.meta.url));
    expect(createHash("sha256").update(raw).digest("hex")).toBe(
      "0e1ce67374b7f7d72338f6bdd7e0fd37a417ca9c5b3d104e832ea57fae00b314",
    );
    expect(VECTORS).toHaveLength(56);
  });

  // Rows an HTTP server may strip before the kernel sees them are about the
  // wire only: in process the value as written is malformed for both sides.
  it("rows marked as stripped (or maybe stripped) by WSGI are malformed in process", () => {
    const wire = VECTORS.filter((v) => v.wire !== undefined);
    expect(wire.map((v) => v.wire).toSorted((a, b) => String(a).localeCompare(String(b)))).toEqual(
      [...Array(2).fill("stripped_by_wsgi"), ...Array(10).fill("may_be_stripped_by_wsgi")].toSorted(
        (a, b) => String(a).localeCompare(String(b)),
      ),
    );
    for (const v of wire) {
      expect(v.canonical, v.note).toBeNull();
      expect(canonicalZoomId(v.input), v.note).toBeUndefined();
      expect(kernelCanonical(v.input), v.note).toBeNull();
    }
  });

  it("covers both accepted and refused forms", () => {
    expect(VECTORS.filter((v) => v.canonical !== null).length).toBeGreaterThanOrEqual(6);
    expect(VECTORS.filter((v) => v.canonical === null).length).toBeGreaterThanOrEqual(10);
  });

  it.each(VECTORS.map((v) => [v.note, v.input, v.canonical] as const))(
    "%s",
    (_case, input, canonical) => {
      expect(canonicalZoomId(input) ?? null).toBe(canonical);
      expect(kernelCanonical(input)).toBe(canonical);
    },
  );

  it.each([undefined, null, 42, {}])("a non-string (%s) has no canonical form", (value) => {
    expect(canonicalZoomId(value)).toBeUndefined();
  });
});

// A bot cannot fall back to a personal token owner's identity when its sender is missing.
describe("missing requester is blocked before credentials or network", () => {
  it.each(OPS_READ_CAPABILITIES.filter((cap) => cap !== "system.whoami"))(
    "%s is refused and audited",
    async (capability) => {
      await refused(
        scopelyOpsInvoke(op({ capability, requesterZoomId: undefined })),
        "header_blocked",
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(auditRows().some((row) => row.event_type === "header_blocked")).toBe(true);
    },
  );
});

describe("local write argument byte boundary", () => {
  beforeEach(() => vi.stubEnv("SCOPELYBOT_ZOOM_CHANNEL", "synthetic-channel"));
  afterEach(() => vi.unstubAllEnvs());
  it.each([4096, 4097, 16384, 16385])(
    "bounds a %i-byte write independently of reads",
    async (bytes) => {
      writeProfile({
        env: "local",
        baseUrl: "http://127.0.0.1:8100",
        allowedHosts: ["127.0.0.1:8100"],
        authMode: "service-token",
        mode: "read-write",
      });
      const args = { description: "x".repeat(bytes - 18) };
      expect(Buffer.byteLength(JSON.stringify(args))).toBe(bytes);
      const request = scopelyOpsInvoke(op({ capability: "catalog.scoping_cards.create", args }));
      if (bytes <= 16384) {
        await expect(request).resolves.toMatchObject({ ok: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } else {
        await refused(request, "body_blocked");
        expect(fetchMock).not.toHaveBeenCalled();
      }
    },
  );
  it("counts multibyte writes in UTF-8 bytes", async () => {
    writeProfile({
      env: "local",
      baseUrl: "http://127.0.0.1:8100",
      allowedHosts: ["127.0.0.1:8100"],
      authMode: "service-token",
      mode: "read-write",
    });
    const args = { description: "😀".repeat(4092) };
    expect(JSON.stringify(args).length).toBeLessThan(16384);
    expect(Buffer.byteLength(JSON.stringify(args))).toBeGreaterThan(16384);
    await refused(
      scopelyOpsInvoke(op({ capability: "catalog.scoping_cards.create", args })),
      "body_blocked",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("server roster exact local transport boundary", () => {
  const roster = [
    "ops.approvers.check",
    "ops.approvers.list",
    "ops.approvers.grant",
    "ops.approvers.revoke",
  ] as const;
  function local(mode = "read-write") {
    writeProfile({
      env: "local",
      mode,
      baseUrl: "http://127.0.0.1:8100",
      allowedHosts: ["127.0.0.1:8100"],
      authMode: "service-token",
    });
    resetScopelyGuardForTest();
  }
  it.each(roster)(
    "refuses %s on dev/default, local readonly, anonymous and missing sender",
    async (capability) => {
      await refused(scopelyOpsInvoke(op({ capability, args: {} })), "write_blocked_read_only");
      local("read-only");
      await refused(scopelyOpsInvoke(op({ capability, args: {} })), "write_blocked_read_only");
      local();
      await refused(
        scopelyOpsInvoke(op({ capability, args: {}, requesterZoomId: undefined })),
        "header_blocked",
      );
      writeProfile({
        env: "local",
        mode: "read-write",
        baseUrl: "http://127.0.0.1:8100",
        allowedHosts: ["127.0.0.1:8100"],
        authMode: "anonymous",
      });
      await refused(scopelyOpsInvoke(op({ capability, args: {} })), "auth_unavailable");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each(["ops.approvers.check", "ops.approvers.list"] as const)(
    "%s keeps 4KiB read args and exact endpoint",
    async (capability) => {
      local();
      await refused(
        scopelyOpsInvoke(op({ capability, args: { padding: "x".repeat(4096) } })),
        "body_blocked",
      );
      expect(fetchMock).not.toHaveBeenCalled();
      await scopelyOpsInvoke(op({ capability, args: {} }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(new URL(String(url)).pathname).toBe(OPS_INVOKE_PATH);
      expect(JSON.parse(options.body)).toMatchObject({ capability, args: {} });
    },
  );
});

it.each(["POST", "PUT", "PATCH", "DELETE"])(
  "production read-write never admits legacy raw %s",
  async (method) => {
    const { setBackendProfileForTest } = await import("./backend-profile.js");
    setBackendProfileForTest({
      env: "prod",
      baseUrl: "https://core-production.invalid:9443",
      allowedHosts: ["core-production.invalid:9443"],
      mode: "read-write",
      authMode: "service-token",
      productionCoreWrites: true,
    });
    try {
      await refused(scopelyFetch(OPS_INVOKE_PATH, { method }), "write_blocked_read_only");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      setBackendProfileForTest(null);
    }
  },
);

describe("production Core7 guarded transport", () => {
  const channel = "a".repeat(32) + "@conference.xmpp.zoom.us";
  const profile = {
    env: "prod",
    baseUrl: "https://core-production.invalid:9443",
    allowedHosts: ["core-production.invalid:9443"],
    authMode: "service-token",
    mode: "read-write",
    productionCoreWrites: true,
  };
  const admitted = [
    "pricing.items.create",
    "pricing.items.update",
    "catalog.scoping_cards.create",
    "catalog.scoping_cards.update",
    "catalog.scoping_cards.delete",
    "catalog.project_types.update",
    "catalog.deployment_types.update",
    "ops.confirm",
    "ops.cancel",
    "ops.pending",
    "ops.approvers.check",
    "ops.approvers.list",
  ];
  beforeEach(() => {
    writeProfile(profile);
    vi.stubEnv("SCOPELYBOT_ZOOM_CHANNEL", channel);
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each(admitted)(
    "admits only exact native %s with service token/channel",
    async (capability) => {
      const res = await scopelyOpsInvoke(
        op({ capability: capability as OpsInvocation["capability"] }),
      );
      expect(res.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(new URL(url).origin).toBe(profile.baseUrl);
      expect(new URL(url).pathname).toBe(OPS_INVOKE_PATH);
      expect(init.headers["x-ops-surface"]).toBe(channel);
      expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(init.headers["x-ops-requester-zoom-id"]).toBe("abcdef_operator_1");
      expect(init.redirect).toBe("manual");
    },
  );
  it("exhausts the existing write union and refuses every excluded name before transport", async () => {
    const { OPS_LOCAL_WRITE_CAPABILITIES } = await import("./scopely-api.js");
    for (const capability of [
      ...OPS_LOCAL_WRITE_CAPABILITIES,
      "unknown.capability",
    ] as OpsInvocation["capability"][]) {
      if (admitted.includes(capability)) {
        continue;
      }
      await refused(scopelyOpsInvoke(op({ capability })), "write_blocked_read_only");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    "",
    "synthetic-channel",
    "A".repeat(32) + "@conference.xmpp.zoom.us",
    "a".repeat(31) + "@conference.xmpp.zoom.us",
    "a".repeat(32) + "@evil.invalid",
  ])("rejects malformed production channel %s", async (bad) => {
    vi.stubEnv("SCOPELYBOT_ZOOM_CHANNEL", bad);
    await refused(scopelyOpsInvoke(op({ capability: "ops.confirm" })), "write_blocked_read_only");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(OPS_READ_CAPABILITIES)(
    "keeps native read %s available without write admission",
    async (capability) => {
      writeProfile({ ...profile, mode: "read-only", productionCoreWrites: false });
      expect((await scopelyOpsInvoke(op({ capability }))).ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["mode", "switch", "token", "sender"])(
    "revokes admission on %s loss without sending",
    async (failure) => {
      if (failure === "mode") {
        writeProfile({ ...profile, mode: "off" });
      }
      if (failure === "switch") {
        writeProfile({ ...profile, productionCoreWrites: false });
      }
      if (failure === "token") {
        fs.unlinkSync(tokenFile());
      }
      await expect(
        scopelyOpsInvoke(
          op({
            capability: "pricing.items.update",
            ...(failure === "sender" ? { requesterZoomId: undefined } : {}),
          }),
        ),
      ).rejects.toBeInstanceOf(ScopelyGuardError);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each(["timeout", "redirect"])("does not retry %s", async (failure) => {
    if (failure === "timeout") {
      fetchMock.mockRejectedValueOnce(new Error("timeout"));
    }
    if (failure === "redirect") {
      fetchMock.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid" } }),
      );
    }
    // The existing audit fixtures separately exhaust intent/outcome failures.
    {
      await expect(scopelyOpsInvoke(op({ capability: "pricing.items.update" }))).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
});

it.each(["intent", "outcome"])(
  "production %s audit failure remains fail-closed with no replay",
  async (phase) => {
    const { setAuditDepsForTest } = await import("./audit-chain.js");
    const { auditFile } = await import("./audit.test-helpers.js");
    writeProfile({
      env: "prod",
      mode: "read-write",
      authMode: "service-token",
      productionCoreWrites: true,
      baseUrl: "https://core-production.invalid:9443",
      allowedHosts: ["core-production.invalid:9443"],
    });
    vi.stubEnv("SCOPELYBOT_ZOOM_CHANNEL", "a".repeat(32) + "@conference.xmpp.zoom.us");
    let fail = phase === "intent";
    const proxy = new Proxy(fs, {
      get(real, prop) {
        if (prop !== "openSync") {
          return Reflect.get(real, prop);
        }
        return (...args: Parameters<typeof fs.openSync>) => {
          if (
            args[0] === auditFile(workspace) &&
            typeof args[1] === "number" &&
            args[1] & fs.constants.O_APPEND &&
            fail
          ) {
            throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
          }
          return real.openSync(...args);
        };
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    setAuditDepsForTest({ fs: proxy });
    try {
      if (phase === "outcome") {
        fetchMock.mockImplementationOnce(async () => {
          fail = true;
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" },
          });
        });
        expect((await scopelyOpsInvoke(op({ capability: "pricing.items.update" }))).ok).toBe(true);
        fail = false;
      }
      await refused(
        scopelyOpsInvoke(op({ capability: "pricing.items.update" })),
        "audit_unavailable",
      );
      expect(fetchMock).toHaveBeenCalledTimes(phase === "intent" ? 0 : 1);
    } finally {
      setAuditDepsForTest(null);
      errors.mockRestore();
      vi.unstubAllEnvs();
    }
  },
);
