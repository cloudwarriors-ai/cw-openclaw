import { describe, expect, it } from "vitest";
import { resolveSearchPathPrefix } from "./types.js";
import { buildPathFilter } from "./manager-search.js";

describe("resolveSearchPathPrefix", () => {
  it("returns undefined for global scope", () => {
    expect(resolveSearchPathPrefix("global", undefined)).toBeUndefined();
  });

  it("returns undefined for undefined scope", () => {
    expect(resolveSearchPathPrefix(undefined, undefined)).toBeUndefined();
  });

  it("returns memory/customers prefix for all-customers scope", () => {
    const result = resolveSearchPathPrefix("all-customers", undefined);
    expect(result).toEqual({ prefix: "memory/customers" });
  });

  it("returns excludePrefixes for all-customers with excludeSlugs", () => {
    const result = resolveSearchPathPrefix("all-customers", undefined, [
      "test-customer",
      "zoomwarriors-support-channel",
    ]);
    expect(result).toEqual({
      prefix: "memory/customers",
      excludePrefixes: [
        "memory/customers/test-customer",
        "memory/customers/zoomwarriors-support-channel",
      ],
    });
  });

  it("ignores empty excludeSlugs", () => {
    const result = resolveSearchPathPrefix("all-customers", undefined, ["", "acme"]);
    expect(result).toEqual({
      prefix: "memory/customers",
      excludePrefixes: ["memory/customers/acme"],
    });
  });

  it("does not add excludePrefixes when excludeSlugs is empty array", () => {
    const result = resolveSearchPathPrefix("all-customers", undefined, []);
    expect(result).toEqual({ prefix: "memory/customers" });
  });

  it("returns channel-specific prefix with slug", () => {
    const result = resolveSearchPathPrefix("channel", "acme-corp");
    expect(result).toEqual({ prefix: "memory/customers/acme-corp" });
  });

  it("returns denied when channel scope has no slug", () => {
    const result = resolveSearchPathPrefix("channel", undefined);
    expect(result).toEqual({ denied: true });
  });

  it("returns denied when channel scope has empty slug", () => {
    const result = resolveSearchPathPrefix("channel", "");
    expect(result).toEqual({ denied: true });
  });

  it("normalizes slashes in slug", () => {
    const result = resolveSearchPathPrefix("channel", "acme//corp\\test");
    expect(result?.prefix).toBe("memory/customers/acme/corp/test");
  });

  it("strips leading/trailing slashes from slug", () => {
    const result = resolveSearchPathPrefix("channel", "/acme-corp/");
    expect(result?.prefix).toBe("memory/customers/acme-corp");
  });
});

describe("buildPathFilter", () => {
  it("returns undefined for no prefix", () => {
    expect(buildPathFilter(undefined)).toBeUndefined();
    expect(buildPathFilter("")).toBeUndefined();
  });

  it("builds LIKE clause with trailing slash", () => {
    const filter = buildPathFilter("memory/customers/acme");
    expect(filter).toBeDefined();
    expect(filter!.sql).toContain("LIKE");
    expect(filter!.params).toEqual(["memory/customers/acme/%"]);
  });

  it("uses alias when provided", () => {
    const filter = buildPathFilter("memory/customers", "c");
    expect(filter!.sql).toContain("c.path");
  });

  it("uses bare path when no alias", () => {
    const filter = buildPathFilter("memory/customers");
    expect(filter!.sql).toContain(" path LIKE");
    expect(filter!.sql).not.toContain(".");
  });

  it("escapes SQL wildcards in prefix", () => {
    const filter = buildPathFilter("memory/100%_done");
    expect(filter!.params[0]).toBe("memory/100\\%\\_done/%");
    expect(filter!.sql).toContain("ESCAPE");
  });

  it("normalizes slashes", () => {
    const filter = buildPathFilter("memory\\customers//acme");
    expect(filter!.params[0]).toBe("memory/customers/acme/%");
  });

  it("adds NOT LIKE clauses for excludePrefixes", () => {
    const filter = buildPathFilter("memory/customers", undefined, [
      "memory/customers/test-customer",
      "memory/customers/zoomwarriors-support-channel",
    ]);
    expect(filter).toBeDefined();
    expect(filter!.sql).toContain("LIKE");
    expect(filter!.sql).toContain("NOT LIKE");
    expect(filter!.params).toEqual([
      "memory/customers/%",
      "memory/customers/test-customer/%",
      "memory/customers/zoomwarriors-support-channel/%",
    ]);
  });

  it("skips empty excludePrefixes", () => {
    const filter = buildPathFilter("memory/customers", "c", [""]);
    expect(filter!.sql).not.toContain("NOT LIKE");
    expect(filter!.params).toEqual(["memory/customers/%"]);
  });
});
