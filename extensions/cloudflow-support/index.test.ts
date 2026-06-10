import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("cloudflow-support tool scoping", () => {
  it("registers every tool as optional so per-agent allowlists can scope them", () => {
    // Non-optional plugin tools bypass allowlists and leak into every agent's
    // menu; optional ones are only visible to agents whose tools.allow opts in.
    process.env.OPENCLAW_WORKSPACE = os.tmpdir();
    const optionalFlags: Array<boolean | undefined> = [];
    const api = {
      registerTool: vi.fn((_tool: unknown, opts?: { optional?: boolean }) => {
        optionalFlags.push(opts?.optional);
      }),
      on: vi.fn(),
    } as never;

    plugin.register(api, undefined);

    expect(optionalFlags.length).toBeGreaterThan(0);
    expect(optionalFlags.every((flag) => flag === true)).toBe(true);
  });
});
