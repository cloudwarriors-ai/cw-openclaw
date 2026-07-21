// Daily-digest tests (daily-digest.ts — Slice 4). Cover: the due predicate
// (flag gate, UTC hour gate, once-per-day marker), section building against a
// mocked BFF (stats delta rendering, approvals count, stuck-deal line with the
// created->cutoff query shape, extraction failures, per-section fail-soft),
// line-boundary chunking under the Zoom limit, and the tick's persistence
// (marker + stats snapshot survive to the next day's delta).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scopelyFetchMock = vi.fn();
vi.mock("./scopely-api.js", () => ({
  scopelyFetch: (...args: unknown[]) => scopelyFetchMock(...args),
}));
const sendMock = vi.fn().mockResolvedValue(undefined);

import {
  buildDigest,
  chunkDigestText,
  digestDue,
  readDigestState,
  runDigestTick,
} from "./daily-digest.js";

let workspace: string;
// 2026-07-21T14:30Z — past the default 13:00 UTC digest hour.
const NOW = Date.parse("2026-07-21T14:30:00Z");

function ok(data: unknown) {
  return { ok: true, status: 200, data };
}

function mockAllReads() {
  scopelyFetchMock.mockImplementation((p: string) => {
    if (p === "/api/admin/stats/")
      return Promise.resolve(ok({ total_sessions: 713, in_progress: 391, orgs: 12 }));
    if (p === "/api/admin/approvals/") return Promise.resolve(ok({ count: 2, results: [{}, {}] }));
    if (p.startsWith("/api/admin/sessions/"))
      return Promise.resolve(ok({ count: 1, results: [{ id: 42, company_name: "Globex" }] }));
    if (p.startsWith("/api/extraction-monitor/"))
      return Promise.resolve(ok({ count: 0, results: [] }));
    return Promise.resolve({ ok: false, status: 404, data: "" });
  });
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "digest-test-"));
  process.env.SCOPELYBOT_DAILY_DIGEST = "1";
  process.env.SCOPELYBOT_ZOOM_CHANNEL = "chan@conference.xmpp.zoom.us";
  scopelyFetchMock.mockReset();
  sendMock.mockClear();
});
afterEach(() => {
  delete process.env.SCOPELYBOT_DAILY_DIGEST;
  delete process.env.SCOPELYBOT_ZOOM_CHANNEL;
  delete process.env.SCOPELYBOT_DIGEST_HOUR_UTC;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("digestDue", () => {
  it("false when the flag is unset (rollout gate)", () => {
    delete process.env.SCOPELYBOT_DAILY_DIGEST;
    expect(digestDue(workspace, NOW)).toBe(false);
  });

  it("false before the configured UTC hour, true after", () => {
    process.env.SCOPELYBOT_DIGEST_HOUR_UTC = "15";
    expect(digestDue(workspace, NOW)).toBe(false); // 14:30 < 15:00
    process.env.SCOPELYBOT_DIGEST_HOUR_UTC = "13";
    expect(digestDue(workspace, NOW)).toBe(true);
  });

  it("false once today's marker is persisted (once per day)", async () => {
    mockAllReads();
    expect(await runDigestTick(workspace, { now: () => NOW, send: sendMock })).toBe(true);
    expect(digestDue(workspace, NOW)).toBe(false);
    // Next UTC day is due again.
    expect(digestDue(workspace, NOW + 24 * 3600_000)).toBe(true);
  });
});

describe("buildDigest", () => {
  it("renders all four sections with a stats delta against the previous snapshot", async () => {
    mockAllReads();
    const digest = await buildDigest({ total_sessions: 700, in_progress: 391 });
    expect(digest.text).toContain("Daily Scopely VIP digest");
    expect(digest.text).toContain("total sessions: 713 (+13)");
    expect(digest.text).toContain("in progress: 391"); // zero delta → no suffix
    expect(digest.text).not.toContain("391 (");
    expect(digest.text).toContain("Pending approvals: 2");
    expect(digest.text).toContain("Possibly stuck (in progress, created >60d ago): 1 — #42 Globex");
    expect(digest.text).toContain("Extraction failures: none");
    expect(digest.statsSnapshot).toMatchObject({ total_sessions: 713 });
    // The stuck query uses status + created-date cutoff (the only staleness
    // dimension the admin list supports) and a bounded limit.
    const stuckCall = scopelyFetchMock.mock.calls
      .map((c) => c[0] as string)
      .find((p) => p.startsWith("/api/admin/sessions/"));
    expect(stuckCall).toMatch(/status=in_progress&date_to=\d{4}-\d{2}-\d{2}&limit=5/);
  });

  it("formats currency/size keys compact and rate keys as percentages (live-data polish)", async () => {
    // The first LIVE build rendered "pipeline value: 14570816.5" — raw floats.
    scopelyFetchMock.mockImplementation((p: string) => {
      if (p === "/api/admin/stats/")
        return Promise.resolve(
          ok({
            pipeline_value: 14570816.5,
            avg_deal_size: 79853.67,
            conversion_rate: 14.7,
            small_value: 420,
          }),
        );
      return Promise.resolve(ok({ count: 0, results: [] }));
    });
    const digest = await buildDigest({ pipeline_value: 14320816.5 });
    expect(digest.text).toContain("pipeline value: $14.57M (+$250.0k)");
    expect(digest.text).toContain("avg deal size: $79.9k");
    expect(digest.text).toContain("conversion rate: 14.7%");
    expect(digest.text).toContain("small value: $420");
  });

  it("stuck threshold is env-tunable via SCOPELYBOT_DIGEST_STUCK_DAYS", async () => {
    process.env.SCOPELYBOT_DIGEST_STUCK_DAYS = "30";
    try {
      mockAllReads();
      const digest = await buildDigest({});
      expect(digest.text).toContain("created >30d ago");
    } finally {
      delete process.env.SCOPELYBOT_DIGEST_STUCK_DAYS;
    }
  });

  it("a failing section renders unavailable without suppressing the digest", async () => {
    scopelyFetchMock.mockImplementation((p: string) => {
      if (p === "/api/admin/stats/") return Promise.reject(new Error("down"));
      if (p === "/api/admin/approvals/")
        return Promise.resolve({ ok: false, status: 502, data: "" });
      return Promise.resolve(ok({ count: 0, results: [] }));
    });
    const digest = await buildDigest({});
    expect(digest.text).toContain("Stats: unavailable");
    expect(digest.text).toContain("Pending approvals: unavailable (HTTP 502)");
    expect(digest.text).toContain("Possibly stuck deals: none");
  });
});

describe("chunkDigestText", () => {
  it("returns one chunk under the limit and splits on line boundaries above it", () => {
    expect(chunkDigestText("short")).toEqual(["short"]);
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`);
    const chunks = chunkDigestText(lines.join("\n"), 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1000);
      expect(chunk.startsWith("line")).toBe(true); // line-boundary splits
    }
    expect(chunks.join("\n")).toBe(lines.join("\n")); // lossless
  });

  it("hard-slices a single line longer than the limit — every chunk stays under it (review fix)", () => {
    // Reviewer repro: one line > 2×limit previously produced an over-limit
    // chunk ([4000, 5000] for a 9000-char line at limit 4000).
    const chunks = chunkDigestText("x".repeat(9000), 4000);
    expect(chunks).toEqual(["x".repeat(4000), "x".repeat(4000), "x".repeat(1000)]);
    // Oversize line arriving after accumulated content: current is flushed
    // first, then the line is slice-looped — nothing exceeds the limit.
    const mixed = chunkDigestText(`header\n${"y".repeat(9000)}\nfooter`, 4000);
    for (const chunk of mixed) expect(chunk.length).toBeLessThanOrEqual(4000);
    expect(mixed.join("")).toContain("footer");
  });
});

describe("runDigestTick", () => {
  it("posts the digest to the bound channel and persists marker + snapshot", async () => {
    mockAllReads();
    const posted = await runDigestTick(workspace, { now: () => NOW, send: sendMock });
    expect(posted).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toBe("chan@conference.xmpp.zoom.us");
    expect(String(sendMock.mock.calls[0][1])).toContain("Daily Scopely VIP digest");
    const state = readDigestState(workspace);
    expect(state.lastPostedDate).toBe("2026-07-21");
    expect(state.statsSnapshot).toMatchObject({ total_sessions: 713 });
    // Second tick same day: no-op.
    expect(await runDigestTick(workspace, { now: () => NOW + 60_000, send: sendMock })).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a bound channel", async () => {
    delete process.env.SCOPELYBOT_ZOOM_CHANNEL;
    mockAllReads();
    expect(await runDigestTick(workspace, { now: () => NOW, send: sendMock })).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
