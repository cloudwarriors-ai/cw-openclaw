import { describe, expect, it } from "vitest";
import { createPasswordHash, verifyPasswordHash } from "./password.js";

describe("password hashing", () => {
  it("verifies valid password hashes", () => {
    const hash = createPasswordHash("s3cret!");
    expect(verifyPasswordHash("s3cret!", hash)).toBe(true);
    expect(verifyPasswordHash("wrong", hash)).toBe(false);
  });

  it("rejects malformed hashes", () => {
    expect(verifyPasswordHash("anything", "not-a-hash")).toBe(false);
  });
});
