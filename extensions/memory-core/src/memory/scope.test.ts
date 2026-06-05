import { describe, expect, it } from "vitest";
import { filterResultsByScope, resolveEffectiveScope, resolveSearchPathPrefix } from "./scope.js";

describe("resolveSearchPathPrefix", () => {
  it("returns undefined for global scope", () => {
    expect(resolveSearchPathPrefix("global", undefined)).toBeUndefined();
  });

  it("returns undefined for undefined scope", () => {
    expect(resolveSearchPathPrefix(undefined, undefined)).toBeUndefined();
  });

  it("returns memory/customers prefix for all-customers scope", () => {
    expect(resolveSearchPathPrefix("all-customers", undefined)).toEqual({
      prefix: "memory/customers",
    });
  });

  it("returns excludePrefixes for all-customers with excludeSlugs", () => {
    expect(
      resolveSearchPathPrefix("all-customers", undefined, [
        "test-customer",
        "zoomwarriors-support-channel",
      ]),
    ).toEqual({
      prefix: "memory/customers",
      excludePrefixes: [
        "memory/customers/test-customer",
        "memory/customers/zoomwarriors-support-channel",
      ],
    });
  });

  it("ignores empty excludeSlugs", () => {
    expect(resolveSearchPathPrefix("all-customers", undefined, ["", "acme"])).toEqual({
      prefix: "memory/customers",
      excludePrefixes: ["memory/customers/acme"],
    });
  });

  it("returns channel-specific prefix with slug", () => {
    expect(resolveSearchPathPrefix("channel", "acme-corp")).toEqual({
      prefix: "memory/customers/acme-corp",
    });
  });

  it("returns denied when channel scope has no slug", () => {
    expect(resolveSearchPathPrefix("channel", undefined)).toEqual({ denied: true });
    expect(resolveSearchPathPrefix("channel", "")).toEqual({ denied: true });
  });

  it("normalizes slashes in slug", () => {
    expect(resolveSearchPathPrefix("channel", "acme//corp\\test")?.prefix).toBe(
      "memory/customers/acme/corp/test",
    );
    expect(resolveSearchPathPrefix("channel", "/acme-corp/")?.prefix).toBe(
      "memory/customers/acme-corp",
    );
  });
});

describe("resolveEffectiveScope", () => {
  it("defaults to global without a slug", () => {
    expect(resolveEffectiveScope({})).toBe("global");
  });

  it("defaults to channel when a slug is present", () => {
    expect(resolveEffectiveScope({ channelSlug: "acme-corp" })).toBe("channel");
  });

  it("downgrades all-customers to channel when not allowed", () => {
    expect(
      resolveEffectiveScope({ requestedScope: "all-customers", channelSlug: "acme-corp" }),
    ).toBe("channel");
  });

  it("downgrades all-customers to global without a slug", () => {
    expect(resolveEffectiveScope({ requestedScope: "all-customers" })).toBe("global");
  });

  it("allows all-customers when explicitly allowed", () => {
    expect(
      resolveEffectiveScope({
        requestedScope: "all-customers",
        channelSlug: "acme-corp",
        allowAllCustomers: true,
      }),
    ).toBe("all-customers");
  });

  it("forces global for channel scope without slug", () => {
    expect(resolveEffectiveScope({ requestedScope: "channel" })).toBe("global");
  });

  it("ignores invalid scope values and falls back to default", () => {
    expect(resolveEffectiveScope({ requestedScope: "bogus", channelSlug: "acme-corp" })).toBe(
      "channel",
    );
  });

  it("honors explicit global request from scoped session", () => {
    expect(resolveEffectiveScope({ requestedScope: "global", channelSlug: "acme-corp" })).toBe(
      "global",
    );
  });
});

describe("filterResultsByScope", () => {
  const hits = [
    { path: "memory/customers/acme/notes.md" },
    { path: "memory/customers/other/notes.md" },
    { path: "memory/internal/runbook.md" },
    { path: "MEMORY.md" },
  ];

  it("passes everything through without a resolution", () => {
    expect(filterResultsByScope(hits, undefined)).toEqual(hits);
  });

  it("filters to the channel prefix", () => {
    expect(filterResultsByScope(hits, { prefix: "memory/customers/acme" })).toEqual([
      { path: "memory/customers/acme/notes.md" },
    ]);
  });

  it("filters all-customers with exclusions", () => {
    expect(
      filterResultsByScope(hits, {
        prefix: "memory/customers",
        excludePrefixes: ["memory/customers/other"],
      }),
    ).toEqual([{ path: "memory/customers/acme/notes.md" }]);
  });
});
