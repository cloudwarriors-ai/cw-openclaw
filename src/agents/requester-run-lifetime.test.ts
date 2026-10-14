import { describe, expect, it, vi } from "vitest";
import { requesterRunStartedAt, withRequesterRunLifetime } from "./requester-run-lifetime.js";

describe("host requester run lifetime", () => {
  it("isolates concurrent siblings even with the same run id and restores after errors", async () => {
    let clock = 100;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const first = withRequesterRunLifetime("same", async () => {
        expect(requesterRunStartedAt("same")).toBe(100);
        await gate;
        expect(requesterRunStartedAt("same")).toBe(100);
        expect(requesterRunStartedAt("different-child")).toBeUndefined();
      });
      clock = 200;
      await expect(
        withRequesterRunLifetime("same", async () => {
          await Promise.resolve();
          expect(requesterRunStartedAt("same")).toBe(200);
          throw new Error("scope error");
        }),
      ).rejects.toThrow("scope error");
      expect(requesterRunStartedAt("same")).toBeUndefined();
      release();
      await first;
      expect(requesterRunStartedAt("same")).toBeUndefined();
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it("gives nested logical runs fresh provenance and restores the parent", async () => {
    let clock = 100;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      await withRequesterRunLifetime("parent", async () => {
        clock = 200;
        await withRequesterRunLifetime("child", async () => {
          expect(requesterRunStartedAt("child")).toBe(200);
          expect(requesterRunStartedAt("parent")).toBeUndefined();
        });
        expect(requesterRunStartedAt("parent")).toBe(100);
      });
    } finally {
      spy.mockRestore();
    }
  });
});
