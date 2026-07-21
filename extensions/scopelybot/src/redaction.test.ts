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

  it("bounds long strings", () => {
    expect(redactText("x".repeat(100), 10)).toBe("xxxxxxxxxx...[truncated]");
  });
});
