/** Time-normalization tests prevent ambiguous DevTools query behavior. */

import { describe, expect, it } from "vitest";
import { normalizeEpoch } from "./devtools-client.js";

describe("normalizeEpoch", () => {
  const now = Date.parse("2026-07-18T12:00:00Z");

  it("normalizes relative, ISO, and epoch inputs", () => {
    expect(normalizeEpoch("1h", now)).toBe(Math.floor(now / 1000) - 3600);
    expect(normalizeEpoch("30m", now)).toBe(Math.floor(now / 1000) - 1800);
    expect(normalizeEpoch("2026-07-18T11:00:00Z", now)).toBe(
      Math.floor(Date.parse("2026-07-18T11:00:00Z") / 1000),
    );
    expect(normalizeEpoch("1234", now)).toBe(1234);
  });

  it("rejects ambiguous values", () => {
    for (const value of ["1hour", "yesterday", -1, 1.5, {}]) {
      expect(() => normalizeEpoch(value, now)).toThrow();
    }
  });
});
