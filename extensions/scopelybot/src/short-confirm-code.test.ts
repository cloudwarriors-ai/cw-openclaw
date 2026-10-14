import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const entropy = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());
vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomInt: entropy,
}));
vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));
vi.mock("./comfort.js", () => ({ sendScopelyText: send, getChannelThreadAnchor: () => undefined }));
vi.mock("./ops-roster-client.js", () => ({
  isCurrentApprover: async (actor: string) => actor === "human",
}));
import { setBackendProfileForTest } from "./backend-profile.js";
import { tryExecuteConfirm } from "./confirm.js";
import { stageWrite } from "./gated.js";
import { takePending } from "./pending-confirm.js";
import { makeShortCode } from "./short-confirm-code.js";

let directory: string;
let draw = 0;
const logger = vi.fn();
const run = vi.fn();
const preview =
  '{"vendor_key":"canary","changes":{"unit_amount":{"before":"10.00","after":"15.00"}}}';
const code = () => String(send.mock.calls.at(-1)?.[1]).match(/CONFIRM ([2-9A-HJKMNP-Z]{8})/)![1];
const confirm = (value: string, actor = "human", channel = "test-channel") =>
  tryExecuteConfirm({ text: `CONFIRM ${value}`, actor, conversationId: channel, logger });
beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "confirm-codes-")));
  vi.stubEnv("SCOPELYBOT_CONFIRM_CODE_DIR", directory);
  vi.stubEnv("SCOPELYBOT_ZOOM_CHANNEL", "test-channel");
  vi.useFakeTimers();
  draw = 0;
  entropy.mockReset().mockImplementation(() => draw++ % 31);
  send.mockReset().mockResolvedValue(undefined);
  run.mockReset().mockResolvedValue({ ok: true, status: 200, data: {} });
  logger.mockReset();
  setBackendProfileForTest({
    env: "local",
    mode: "read-write",
    baseUrl: "http://127.0.0.1:8100",
    allowedHosts: ["127.0.0.1:8100"],
    authMode: "service-token",
  });
});
afterEach(() => {
  vi.advanceTimersByTime(300_000);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setBackendProfileForTest(null);
  fs.rmSync(directory, { recursive: true, force: true });
});

it("reserves a private empty file and syncs file then directory before returning", () => {
  const sync = vi.spyOn(fs, "fsyncSync");
  const value = makeShortCode();
  expect(value).toMatch(/^[2-9a-hjkmnp-z]{8}$/);
  expect(entropy.mock.calls).toEqual(Array.from({ length: 8 }, () => [31]));
  const stat = fs.statSync(path.join(directory, value));
  expect(stat.size).toBe(0);
  expect(stat.mode & 0o777).toBe(0o600);
  expect(sync).toHaveBeenCalledTimes(2);
});

it("excludes collisions across independent module instances and exhausts safely", async () => {
  entropy.mockReturnValue(0);
  expect(makeShortCode()).toBe("22222222");
  vi.resetModules();
  const fresh = await import("./short-confirm-code.js");
  expect(() => fresh.makeShortCode()).toThrow("Unable to reserve");
  expect(fs.readdirSync(directory)).toEqual(["22222222"]);
  entropy.mockReturnValue(1);
  expect(fresh.makeShortCode()).toBe("33333333");
});

it("atomically reserves distinct names across concurrent real processes", async () => {
  const moduleUrl = new URL("./short-confirm-code.ts", import.meta.url).href;
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      promisify(execFile)(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "--eval",
          `import { makeShortCode } from ${JSON.stringify(moduleUrl)}; process.stdout.write(makeShortCode());`,
        ],
        { env: { ...process.env, SCOPELYBOT_CONFIRM_CODE_DIR: directory } },
      ),
    ),
  );
  const codes = results.map((result) => result.stdout);
  expect(new Set(codes).size).toBe(4);
  expect(fs.readdirSync(directory).toSorted()).toEqual(codes.toSorted());
});

it("refuses filesystem denial without retry, send or pending action", async () => {
  const open = vi.spyOn(fs, "openSync").mockImplementation(() => {
    throw Object.assign(new Error("access denied"), { code: "EACCES" });
  });
  await expect(stageWrite(preview, run, true)).rejects.toThrow("access denied");
  expect(open).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  expect(fs.readdirSync(directory)).toEqual([]);
});

it("burns the name and refuses delivery when close fails", async () => {
  entropy.mockReturnValue(0);
  const close = fs.closeSync;
  vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
    close(fd);
    throw new Error("close failed");
  });
  await expect(stageWrite(preview, run, true)).rejects.toThrow("close failed");
  expect(fs.readdirSync(directory)).toEqual(["22222222"]);
  expect(send).not.toHaveBeenCalled();
  expect(takePending("22222222", { conversationId: "test-channel" })).toBeUndefined();
});

it.each(["missing", "relative", "symlink", "public", "not-directory"])(
  "refuses %s storage before sending",
  async (kind) => {
    if (kind === "missing") {
      vi.stubEnv("SCOPELYBOT_CONFIRM_CODE_DIR", path.join(directory, "absent"));
    }
    if (kind === "relative") {
      vi.stubEnv("SCOPELYBOT_CONFIRM_CODE_DIR", "relative");
    }
    if (kind === "public") {
      fs.chmodSync(directory, 0o755);
    }
    if (kind === "symlink") {
      fs.symlinkSync(directory, path.join(directory, "alias"));
      vi.stubEnv("SCOPELYBOT_CONFIRM_CODE_DIR", path.join(directory, "alias"));
    }
    if (kind === "not-directory") {
      fs.writeFileSync(path.join(directory, "file"), "");
      vi.stubEnv("SCOPELYBOT_CONFIRM_CODE_DIR", path.join(directory, "file"));
    }
    await expect(stageWrite(preview, run, true)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  },
);

it.each([1, 2])(
  "burns the reservation on fsync failure %d and never posts or arms it",
  async (failure) => {
    entropy.mockReturnValue(0);
    const actual = fs.fsyncSync;
    let calls = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (++calls === failure) {
        throw new Error("disk failure");
      }
      actual(fd);
    });
    await expect(stageWrite(preview, run, true)).rejects.toThrow("disk failure");
    expect(fs.readdirSync(directory)).toEqual(["22222222"]);
    expect(takePending("22222222", { conversationId: "test-channel" })).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  },
);

it("burns ambiguous delivery, then refuses reuse after restart", async () => {
  entropy.mockReturnValue(0);
  send.mockRejectedValue(new Error("delivery unknown"));
  await expect(stageWrite(preview, run, true)).rejects.toThrow("delivery unknown");
  expect(await confirm("22222222")).toContain("No pending action");
  vi.resetModules();
  expect(() => makeShortCode()).toThrow("Unable to reserve");
  expect(run).not.toHaveBeenCalled();
});

it("keeps the code human-only, preserves raw audit, and accepts one authorized confirmation", async () => {
  const result = await stageWrite(preview, run, true);
  const first = code();
  expect(JSON.stringify(result).toLowerCase()).not.toContain(first.toLowerCase());
  expect(await confirm(first, "unauthorized")).toContain("not authorized");
  expect(await confirm(first, "human", "other-channel")).toContain("No pending action");
  const replies = await Promise.all([confirm(first), confirm(first.toLowerCase())]);
  expect(replies.filter((reply) => reply?.includes("Done"))).toHaveLength(1);
  expect(run).toHaveBeenCalledTimes(1);
  expect(replies.join("\n")).toContain('Unit amount: "10.00" → "15.00"');
  expect(logger.mock.calls[0][0].params.summary).toBe(preview);
  expect(JSON.stringify(logger.mock.calls).toLowerCase()).not.toContain(first.toLowerCase());
  // Deliberately repeat every RNG draw: consumed names remain excluded.
  draw = 0;
  await stageWrite(preview, run, true);
  expect(code()).not.toBe(first);
  expect(await confirm(first)).toContain("No pending action");
  expect(run).toHaveBeenCalledTimes(1);
});

it.each([299_999, 300_000, 300_001])(
  "expires at the exact TTL boundary %d without reusing the name",
  async (age) => {
    await stageWrite(preview, run, true);
    const first = code();
    vi.advanceTimersByTime(age);
    await confirm(first);
    expect(run).toHaveBeenCalledTimes(age < 300_000 ? 1 : 0);
    draw = 0;
    expect(makeShortCode()).not.toBe(first.toLowerCase());
  },
);

it.each(["2222222", "222222222", "00000000", "IIIIIIII", "22222222 extra"])(
  "intercepts malformed short code %s",
  async (value) => {
    entropy.mockReturnValue(0);
    await stageWrite(preview, run, true);
    expect(await confirm(value)).toContain("Copy the complete CONFIRM line");
    expect(run).not.toHaveBeenCalled();
    expect(await confirm("22222222")).toContain("Done");
  },
);

it("refuses a display that expands beyond the cap before allocating or sending", async () => {
  const result = await stageWrite("\u0085".repeat(1000), run, true);
  expect(JSON.stringify(result)).toContain("cannot be displayed safely");
  expect(entropy).not.toHaveBeenCalled();
  expect(fs.readdirSync(directory)).toEqual([]);
  expect(send).not.toHaveBeenCalled();
});
