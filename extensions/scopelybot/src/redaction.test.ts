/** Regression tests for nested secret and PII redaction at tool boundaries. */

import { describe, expect, it } from "vitest";
import { redactText, redactValue } from "./redaction.js";

describe("ScopelyBot redaction", () => {
  it("redacts nested secret keys without mutating safe fields", () => {
    expect(
      redactValue({
        safe: "keep",
        nested: { password: "hunter2", authorization: "Bearer abc.def" },
        rows: [{ refresh_token: "xyz", id: 7 }],
      }),
    ).toEqual({
      safe: "keep",
      nested: { password: "[REDACTED]", authorization: "[REDACTED]" },
      rows: [{ refresh_token: "[REDACTED]", id: 7 }],
    });
  });

  it("redacts credentials, email addresses, and phone numbers embedded in text", () => {
    const result = redactText(
      "Authorization: Bearer abc.def user=casey@example.com phone=(212) 555-0199 access_token=xyz",
    );
    expect(result).not.toContain("abc.def");
    expect(result).not.toContain("casey@example.com");
    expect(result).not.toContain("212");
    expect(result).not.toContain("xyz");
  });

  // Operator-layer tokens (zwops_<12 hex>_<secret>) anywhere in text, so a
  // token echoed by an error or a model param never reaches a result or the
  // append-only audit chain.
  it.each([
    ["bare", "zwops_0123456789ab_Test-Token_0123456789abcdefABCDEF_xyz"],
    [
      "in a sentence",
      "fetch failed: zwops_0123456789ab_Test-Token_0123456789abcdefABCDEF_xyz, retry",
    ],
    [
      "after a header name",
      "authorization=zwops_fedcba987654_Rotated_Token-0123456789abcdefABCDEF",
    ],
    ["uppercase hex", "ZWOPS_0123456789AB_Test-Token_0123456789abcdefABCDEF_xyz"],
    ["the shortest kernel secret", `zwops_0123456789ab_${"a".repeat(32)}`],
  ])("redacts a zwops_ token (%s)", (_label, text) => {
    const result = redactText(text);
    expect(result).not.toMatch(/zwops_[0-9a-f]{12}_[A-Za-z0-9_-]{16,}/i);
    expect(result).not.toContain("Test-Token");
    expect(result).not.toContain("Rotated");
  });

  it("redacts zwops_ tokens inside nested values and keeps the rest", () => {
    const token = "zwops_0123456789ab_Test-Token_0123456789abcdefABCDEF_xyz";
    expect(redactValue({ q: `see ${token} now`, rows: [token], n: 1 })).toEqual({
      q: "see [REDACTED_TOKEN] now",
      rows: ["[REDACTED_TOKEN]"],
      n: 1,
    });
  });

  it("leaves look-alikes that are not tokens alone", () => {
    expect(redactText("zwops_ is the prefix; zwops_0123456789ab_short")).toBe(
      "zwops_ is the prefix; zwops_0123456789ab_short",
    );
  });

  it("bounds long strings", () => {
    expect(redactText("x".repeat(100), 10)).toBe("xxxxxxxxxx...[truncated]");
  });
});
