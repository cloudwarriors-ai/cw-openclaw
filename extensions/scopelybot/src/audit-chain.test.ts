// audit-v2 chain core (PK-7b, AC-7.7/7.13): canonical form, hash chain, epoch
// marker, singleton writer under concurrency, torn-tail repair, failure
// injection, lock behaviour, fs surface and recovery sweep. Every chain is
// checked by the independent verifier (scripts/verify-audit-chain.mjs).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyChain } from "../scripts/verify-audit-chain.mjs";
import {
  AuditWriteError,
  canonicalJson,
  GENESIS_HASH,
  getAuditWriter,
  newAuditId,
  recordHash,
  setAuditDepsForTest,
  type AuditInput,
} from "./audit-chain.js";
import { auditFile, GOLDEN, readAuditRows } from "./audit.test-helpers.js";

let workspace: string;
const base = {
  env: "dev",
  plugin_version: "0.1.0",
  bot_principal: { auth_mode: "anonymous", principal_id: null },
};
const row = (n = 0, extra: Record<string, unknown> = {}): AuditInput => ({
  ...base,
  event_type: "tool_call",
  phase: "single",
  detail: { n },
  ...extra,
});
const text = () => fs.readFileSync(auditFile(workspace), "utf8");
const errno = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "scopelybot-chain-"));
  setAuditDepsForTest(null);
});

afterEach(() => {
  setAuditDepsForTest(null);
  vi.restoreAllMocks();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("canonical form and ids", () => {
  it("golden vector: one fixed record -> one canonical string and hash", () => {
    expect(canonicalJson(GOLDEN.record)).toBe(GOLDEN.canonical);
    expect(recordHash(GOLDEN.record)).toBe(GOLDEN.hash);
  });

  it.each([[1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [2 ** 53], [new Date(0)], [() => 1]])(
    "refuses a non-canonical value %s",
    (value) => {
      expect(() => canonicalJson({ v: value })).toThrow(TypeError);
    },
  );

  it("drops undefined object values and turns undefined array items into null", () => {
    expect(canonicalJson({ b: undefined, a: [undefined, 1] })).toBe('{"a":[null,1]}');
  });

  it("mints 10,000 unique, sorted Crockford ULIDs", () => {
    const ids = Array.from({ length: 10_000 }, () => newAuditId());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.toSorted()).toEqual(ids);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });
});

describe("chain and epoch marker", () => {
  it("starts with one epoch_marker citing the v1 file, then chains rows 1..N", () => {
    const v1 = `${JSON.stringify({ ts: "2026-10-01T00:00:00.000Z", tool: "x" })}\n{"ts":"2026-10-02T00:00:00.000Z"}\n`;
    fs.mkdirSync(path.join(workspace, "scopelybot"));
    const v1File = path.join(workspace, "scopelybot", "audit.jsonl");
    fs.writeFileSync(v1File, v1);
    const before = fs.statSync(v1File);
    const writer = getAuditWriter(workspace);
    for (let i = 0; i < 5; i++) {
      writer.append(row(i));
    }
    const rows = readAuditRows(workspace, { withEpoch: true });
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows[0]).toMatchObject({
      event_type: "epoch_marker",
      prev_hash: GENESIS_HASH,
      detail: { reason: "cutover_v1" },
      v1: {
        exists: true,
        bytes: Buffer.byteLength(v1),
        lines: 2,
        sha256: sha(v1),
        last_ts: "2026-10-02T00:00:00.000Z",
      },
    });
    expect(verifyChain(text())).toMatchObject({ ok: true, head: { seq: 6 } });
    // v1 is read for the marker and never written.
    expect(fs.readFileSync(v1File, "utf8")).toBe(v1);
    expect(fs.statSync(v1File).mtimeMs).toBe(before.mtimeMs);
  });

  it("records an absent v1 file explicitly and never creates it", () => {
    getAuditWriter(workspace).append(row());
    expect(readAuditRows(workspace, { withEpoch: true })[0]).toMatchObject({
      v1: { exists: false, sha256: null },
    });
    expect(fs.existsSync(path.join(workspace, "scopelybot", "audit.jsonl"))).toBe(false);
  });

  it("two module instances racing on a fresh file write exactly one marker and one chain (AC-7.13)", async () => {
    vi.resetModules();
    const a = await import("./audit-chain.js");
    vi.resetModules();
    const b = await import("./audit-chain.js");
    expect(a.getAuditWriter).not.toBe(b.getAuditWriter);
    const writers = [
      a.getAuditWriter(workspace),
      b.getAuditWriter(workspace),
      getAuditWriter(workspace),
    ];
    await Promise.all(
      Array.from({ length: 100 }, async (_v, i) => {
        await Promise.resolve();
        writers[i % 3].append(row(i));
      }),
    );
    const rows = readAuditRows(workspace, { withEpoch: true });
    expect(rows.filter((r) => r.event_type === "epoch_marker")).toHaveLength(1);
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 101 }, (_v, i) => i + 1));
    expect(verifyChain(text()).ok).toBe(true);
  });
});

describe("tail checks fail closed", () => {
  it("refuses to extend a chain whose last line was edited (INTEGRITY), and stays refused", () => {
    const writer = getAuditWriter(workspace);
    writer.append(row(1));
    writer.append(row(2));
    fs.writeFileSync(auditFile(workspace), text().replace('"n":2', '"n":3'));
    expect(() => writer.append(row(3))).toThrow(expect.objectContaining({ code: "INTEGRITY" }));
    expect(writer.degraded()).toMatchObject({ code: "INTEGRITY" });
    expect(() => writer.append(row(4))).toThrow(AuditWriteError);
  });

  it("refuses a tail that no longer links to the record before it", () => {
    const writer = getAuditWriter(workspace);
    writer.append(row(1));
    writer.append(row(2));
    const lines = text().trimEnd().split("\n");
    fs.writeFileSync(auditFile(workspace), `${[lines[0], lines[2]].join("\n")}\n`);
    expect(() => getAuditWriterFresh().append(row(3))).toThrow(
      expect.objectContaining({ code: "INTEGRITY" }),
    );
  });

  it("refuses when the file disappears or moves backwards under a live writer", () => {
    const writer = getAuditWriter(workspace);
    writer.append(row(1));
    writer.append(row(2));
    const lines = text().trimEnd().split("\n");
    fs.writeFileSync(auditFile(workspace), `${lines.slice(0, 2).join("\n")}\n`);
    expect(() => writer.append(row(3))).toThrow(expect.objectContaining({ code: "INTEGRITY" }));
    fs.writeFileSync(auditFile(workspace), ""); // emptied to 0 bytes, not deleted
    expect(() => writer.append(row(3))).toThrow(expect.objectContaining({ code: "INTEGRITY" }));
    expect(fs.statSync(auditFile(workspace)).size).toBe(0); // no silent new epoch
    fs.rmSync(auditFile(workspace));
    expect(() => writer.append(row(3))).toThrow(expect.objectContaining({ code: "INTEGRITY" }));
    expect(fs.existsSync(auditFile(workspace))).toBe(false); // no silent new chain
  });

  it.each([
    ["a newline", "\n"],
    ["a carriage return", "\r"],
  ])("one stray %s appended is refused by a live and by a fresh writer", (_label, stray) => {
    const writer = getAuditWriter(workspace);
    writer.append(row(1));
    writer.append(row(2));
    fs.appendFileSync(auditFile(workspace), stray);
    expect(() => writer.append(row(3))).toThrow(expect.objectContaining({ code: "INTEGRITY" }));
    expect(() => getAuditWriterFresh().append(row(3))).toThrow(
      expect.objectContaining({ code: "INTEGRITY" }),
    );
  });

  it("a tail with no record in reach (2 MiB of NUL bytes) is INTEGRITY, never a second epoch", () => {
    getAuditWriter(workspace).append(row(1));
    fs.appendFileSync(auditFile(workspace), Buffer.alloc(2 * 1024 * 1024, 0));
    expect(() => getAuditWriterFresh().append(row(2))).toThrow(
      expect.objectContaining({ code: "INTEGRITY" }),
    );
    expect(
      text()
        .split("\n")
        .filter((l) => l.includes('"epoch_marker"')),
    ).toHaveLength(1);
  });

  it("torn fragments are repaired up to 64 KiB in total and refused above it", () => {
    const fragments = (n: number) => `{${"z".repeat(20_000)}\n`.repeat(n);
    getAuditWriter(workspace).append(row(1));
    fs.appendFileSync(auditFile(workspace), fragments(3)); // 60 KB: repaired and cited
    getAuditWriterFresh().append(row(2));
    const cited = readAuditRowsLoose().find((r) => Array.isArray(r.repaired_torn_lines));
    expect(cited?.repaired_torn_lines).toHaveLength(3);
    fs.appendFileSync(auditFile(workspace), fragments(5)); // 100 KB: over the cap
    expect(() => getAuditWriterFresh().append(row(3))).toThrow(
      expect.objectContaining({ code: "INTEGRITY", message: expect.stringMatching(/too much/) }),
    );
  });

  it("a live writer refuses a last record replaced self-consistently at the same seq", () => {
    const writer = getAuditWriter(workspace);
    writer.append(row(1));
    writer.append(row(2));
    const lines = text().trimEnd().split("\n");
    const last = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
    const replaced: Record<string, unknown> = { ...last, detail: { n: 999 } };
    delete replaced.hash;
    replaced.hash = recordHash(replaced); // same seq and prev_hash: still links
    const forged = [...lines.slice(0, -1), canonicalJson(replaced)].join("\n");
    fs.writeFileSync(auditFile(workspace), `${forged}\n`);
    expect(() => writer.append(row(3))).toThrow(expect.objectContaining({ code: "INTEGRITY" }));
  });

  it("refuses a forged head behind an unparseable line (the link is checked across fragments)", () => {
    const writer = getAuditWriter(workspace);
    for (let i = 0; i < 3; i++) {
      writer.append(row(i));
    }
    const forged: Record<string, unknown> = {
      ...row(99),
      schema_version: 2,
      seq: 99,
      ts: "2026-01-01T00:00:00.000Z",
      prev_hash: "f".repeat(64),
      audit_id: "X".repeat(26),
    };
    forged.hash = recordHash(forged);
    fs.appendFileSync(auditFile(workspace), `garbage\n${canonicalJson(forged)}\n`);
    expect(() => writer.append(row(100))).toThrow(expect.objectContaining({ code: "INTEGRITY" }));
    expect(() => getAuditWriterFresh().append(row(100))).toThrow(
      expect.objectContaining({ code: "INTEGRITY" }),
    );
  });

  it("refuses a self-consistent last record of another schema_version", () => {
    getAuditWriter(workspace).append(row(1));
    const lines = text().trimEnd().split("\n");
    const last = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
    const other: Record<string, unknown> = { ...last, schema_version: 3 };
    delete other.hash;
    other.hash = recordHash(other);
    const forged = [...lines.slice(0, -1), canonicalJson(other)].join("\n");
    fs.writeFileSync(auditFile(workspace), `${forged}\n`);
    expect(() => getAuditWriterFresh().append(row(2))).toThrow(
      expect.objectContaining({ code: "INTEGRITY" }),
    );
  });

  it("caps a record at 16 KiB: refused above it (TOO_LARGE), written below it", () => {
    const writer = getAuditWriter(workspace);
    expect(() => writer.append(row(1, { blob: "x".repeat(16_400) }))).toThrow(
      expect.objectContaining({ code: "TOO_LARGE" }),
    );
    expect(() => writer.append(row(2, { blob: "x".repeat(15_600) }))).not.toThrow();
    expect(readAuditRows(workspace).at(-1)?.detail).toEqual({ n: 2 });
  });

  it("tolerates a wall clock stepped back an hour: seq and hashes order, ts regression is a warning", () => {
    let now = Date.UTC(2026, 9, 12, 12);
    setAuditDepsForTest({ now: () => now });
    const writer = getAuditWriter(workspace);
    writer.append(row(1));
    now -= 3_600_000;
    writer.append(row(2));
    const result = verifyChain(text());
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/ts_regression at seq 3/);
  });
});

// How a path was opened: append / read / write, with any truncate, non-blocking
// and no-follow bits named (string flags are reported as given).
const { O_APPEND, O_TRUNC, O_WRONLY, O_RDWR, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
function openMode(flags: unknown): string {
  if (typeof flags !== "number") {
    return `str:${String(flags)}`;
  }
  const kind = flags & O_APPEND ? "append" : flags & (O_WRONLY | O_RDWR) ? "write" : "read";
  const bits = [
    flags & O_TRUNC ? "trunc" : "",
    flags & O_NONBLOCK ? "nonblock" : "",
    flags & O_NOFOLLOW ? "nofollow" : "",
  ].filter(Boolean);
  return `${kind}(${bits.join(",")})`;
}

// A real-fs proxy that can fail chosen calls; it also records every call that
// touches the audit file (by path or by an fd opened on it).
function faultyFs(
  opts: { failWrite?: (n: number) => Error | number | undefined; failOpenA?: Error } = {},
) {
  const auditFds = new Set<number>();
  const ops: string[] = [];
  let writes = 0;
  const target = auditFile(workspace);
  const proxy = new Proxy(fs, {
    get(real, prop: string) {
      const fn = (real as unknown as Record<string, unknown>)[prop];
      if (typeof fn !== "function") {
        return fn;
      }
      return (...args: unknown[]) => {
        const touches =
          args[0] === target || (typeof args[0] === "number" && auditFds.has(args[0]));
        if (touches) {
          ops.push(prop === "openSync" ? `openSync:${openMode(args[1])}` : prop);
        }
        const append = openMode(args[1]).startsWith("append");
        if (prop === "openSync" && args[0] === target && append && opts.failOpenA) {
          throw opts.failOpenA;
        }
        if (prop === "writeSync" && touches && opts.failWrite) {
          const fault = opts.failWrite(writes++);
          if (typeof fault === "number") {
            const buf = args[1] as Buffer;
            (fn as (...a: unknown[]) => unknown).call(real, args[0], buf, args[2], fault);
            throw errno("ENOSPC");
          }
          if (fault) {
            throw fault;
          }
        }
        const out = (fn as (...a: unknown[]) => unknown).apply(real, args);
        if (prop === "openSync" && args[0] === target) {
          auditFds.add(out as number);
        }
        if (prop === "closeSync") {
          auditFds.delete(args[0] as number);
        }
        return out;
      };
    },
  });
  return { fs: proxy as unknown as typeof fs, ops };
}

function getAuditWriterFresh() {
  setAuditDepsForTest({}); // forget cached writers (and heads), keep node:fs
  return getAuditWriter(workspace);
}

describe("failure injection (disk full, permissions, torn tails)", () => {
  it("ENOSPC mid-line: append throws, the torn tail fails the verifier, the next append repairs and cites it", () => {
    getAuditWriter(workspace).append(row(1));
    const faulty = faultyFs({ failWrite: (n) => (n === 0 ? 40 : undefined) });
    setAuditDepsForTest({ fs: faulty.fs });
    const writer = getAuditWriter(workspace);
    expect(() => writer.append(row(2))).toThrow(expect.objectContaining({ code: "ENOSPC" }));
    expect(writer.degraded()).toMatchObject({ code: "ENOSPC" });
    expect(verifyChain(text())).toMatchObject({ ok: false, reason: "torn_tail" });
    expect(verifyChain(text(), { allowTornTail: true }).ok).toBe(true);
    const fragment = text().split("\n").at(-1) ?? "";
    expect(fragment.length).toBe(40);

    writer.append(row(3));
    expect(writer.degraded()).toBeNull();
    const rows = readAuditRowsLoose();
    const gap = rows.find((r) => r.event_type === "audit_gap");
    expect(gap).toMatchObject({ detail: { failures: 1, error_code: "ENOSPC" } });
    expect(gap?.repaired_torn_lines).toEqual([{ bytes: 40, sha256: sha(fragment) }]);
    expect(verifyChain(text())).toMatchObject({ ok: true });
  });

  it("more than 8 unexplained trailing fragments is INTEGRITY, not a repair", () => {
    getAuditWriter(workspace).append(row(1));
    fs.appendFileSync(
      auditFile(workspace),
      Array.from({ length: 9 }, (_v, i) => `{"torn${i}`).join("\n"),
    );
    expect(() => getAuditWriterFresh().append(row(2))).toThrow(
      expect.objectContaining({ code: "INTEGRITY" }),
    );
  });

  it("a repair that is itself torn: the next record cites both fragments", () => {
    getAuditWriter(workspace).append(row(1));
    setAuditDepsForTest({ fs: faultyFs({ failWrite: () => 30 }).fs });
    const writer = getAuditWriter(workspace);
    expect(() => writer.append(row(2))).toThrow(AuditWriteError);
    expect(() => writer.append(row(3))).toThrow(AuditWriteError);
    setAuditDepsForTest(null);
    getAuditWriter(workspace).append(row(4));
    const cited = readAuditRowsLoose().find((r) => Array.isArray(r.repaired_torn_lines));
    expect(cited?.repaired_torn_lines).toHaveLength(2);
    expect(verifyChain(text()).ok).toBe(true);
  });

  it.each([
    ["EACCES", "EACCES"],
    ["EPERM", "EACCES"],
    ["EROFS", "EROFS"],
    ["EIO", "IO"],
  ])("%s on open fails the append as %s and marks the writer degraded", (code, expected) => {
    getAuditWriter(workspace).append(row(1));
    setAuditDepsForTest({ fs: faultyFs({ failOpenA: errno(code) }).fs });
    const writer = getAuditWriter(workspace);
    expect(() => writer.append(row(2))).toThrow(expect.objectContaining({ code: expected }));
    expect(writer.degraded()).toMatchObject({ code: expected });
  });

  it("only ever opens the audit file to append or read (no truncate, no symlink, no blocking) and uses write/fsync/read/fstat/close on it (chattr +a)", () => {
    const faulty = faultyFs();
    setAuditDepsForTest({ fs: faulty.fs });
    const writer = getAuditWriter(workspace);
    for (let i = 0; i < 3; i++) {
      writer.append(row(i));
    }
    const allowed = new Set([
      "openSync:append(nonblock,nofollow)",
      "openSync:read(nonblock,nofollow)",
      "readSync",
      "writeSync",
      "fsyncSync",
      "closeSync",
      "fstatSync",
    ]);
    expect(faulty.ops.length).toBeGreaterThan(0);
    expect(faulty.ops.filter((op) => !allowed.has(op))).toEqual([]);
    expect(faulty.ops).toContain("fsyncSync");
  });
});

describe("defensive opens (no FIFO hang, no symlink target, bounded v1)", () => {
  // Like the backend-profile FIFO test: a blocking open of a FIFO is refused
  // by this fs proxy, so losing O_NONBLOCK fails by assertion instead of hanging.
  const noBlockingFifo = new Proxy(fs, {
    get(real, prop: string) {
      const fn = (real as unknown as Record<string, unknown>)[prop];
      if (prop !== "openSync" || typeof fn !== "function") {
        return fn;
      }
      return (...args: unknown[]) => {
        const flags = args[1];
        const blocking = typeof flags !== "number" || !(flags & fs.constants.O_NONBLOCK);
        const fifo = fs.statSync(String(args[0]), { throwIfNoEntry: false })?.isFIFO();
        if (blocking && fifo) {
          throw Object.assign(new Error("blocking FIFO open"), { code: "EBLOCKINGFIFO" });
        }
        return (fn as (...a: unknown[]) => unknown).apply(real, args);
      };
    },
  }) as unknown as typeof fs;
  const dir = () => path.join(workspace, "scopelybot");

  it.skipIf(process.platform === "win32")(
    "a FIFO at the audit path is INTEGRITY, without blocking",
    () => {
      fs.mkdirSync(dir(), { recursive: true });
      expect(spawnSync("mkfifo", [auditFile(workspace)]).status).toBe(0);
      setAuditDepsForTest({ fs: noBlockingFifo });
      expect(() => getAuditWriter(workspace).append(row())).toThrow(
        expect.objectContaining({
          code: "INTEGRITY",
          message: expect.stringMatching(/not a regular file/),
        }),
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "a FIFO at the v1 path is INTEGRITY, without blocking",
    () => {
      fs.mkdirSync(dir(), { recursive: true });
      expect(spawnSync("mkfifo", [path.join(dir(), "audit.jsonl")]).status).toBe(0);
      setAuditDepsForTest({ fs: noBlockingFifo });
      expect(() => getAuditWriter(workspace).append(row())).toThrow(
        expect.objectContaining({ code: "INTEGRITY" }),
      );
    },
  );

  it("a symlinked audit path is refused and its target is never written", () => {
    fs.mkdirSync(dir(), { recursive: true });
    const victim = path.join(workspace, "victim.txt");
    fs.writeFileSync(victim, "victim content\n");
    fs.symlinkSync(victim, auditFile(workspace));
    expect(() => getAuditWriter(workspace).append(row())).toThrow(
      expect.objectContaining({ code: "INTEGRITY", message: expect.stringMatching(/symlink/) }),
    );
    expect(fs.readFileSync(victim, "utf8")).toBe("victim content\n");
  });

  it("a symlinked v1 file is refused, not hashed through the link", () => {
    fs.mkdirSync(dir(), { recursive: true });
    const other = path.join(workspace, "other.jsonl");
    fs.writeFileSync(other, '{"ts":"2026-10-01T00:00:00.000Z"}\n');
    fs.symlinkSync(other, path.join(dir(), "audit.jsonl"));
    expect(() => getAuditWriter(workspace).append(row())).toThrow(
      expect.objectContaining({ code: "INTEGRITY" }),
    );
    expect(fs.existsSync(auditFile(workspace))).toBe(false);
  });

  it("a v1 file over 8 MiB is refused; one of exactly 8 MiB is hashed", () => {
    fs.mkdirSync(dir(), { recursive: true });
    const v1 = path.join(dir(), "audit.jsonl");
    fs.writeFileSync(v1, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
    expect(() => getAuditWriter(workspace).append(row())).toThrow(
      expect.objectContaining({ code: "INTEGRITY", message: expect.stringMatching(/8 MiB/) }),
    );
    fs.writeFileSync(v1, Buffer.alloc(8 * 1024 * 1024, 0x61));
    getAuditWriter(workspace).append(row());
    expect(readAuditRows(workspace, { withEpoch: true })[0]).toMatchObject({
      v1: { exists: true, bytes: 8 * 1024 * 1024, lines: 0 },
    });
  });
});

describe("cross-process lock", () => {
  const lockFile = () => path.join(workspace, "scopelybot", "audit-v2.lock");
  const holdLock = (ageMs: number, now: number) => {
    fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
    fs.writeFileSync(lockFile(), "other-writer\n");
    const t = new Date(now - ageMs);
    fs.utimesSync(lockFile(), t, t);
  };

  it("a live lock held by another writer: bounded retries, then LOCK (no append)", () => {
    const now = Date.now();
    holdLock(0, now);
    const sleep = vi.fn();
    setAuditDepsForTest({ sleep, now: () => now });
    expect(() => getAuditWriter(workspace).append(row())).toThrow(
      expect.objectContaining({ code: "LOCK" }),
    );
    expect(sleep).toHaveBeenCalledTimes(5);
    expect(fs.existsSync(auditFile(workspace))).toBe(false);
    expect(fs.readFileSync(lockFile(), "utf8")).toBe("other-writer\n"); // never released by us
  });

  it("the stale threshold is 10 s: a 9.5 s old lock is respected, a 10.5 s old one is taken over", () => {
    const now = Date.now();
    holdLock(9_500, now);
    setAuditDepsForTest({ sleep: vi.fn(), now: () => now });
    expect(() => getAuditWriter(workspace).append(row())).toThrow(
      expect.objectContaining({ code: "LOCK" }),
    );
    holdLock(10_500, now);
    expect(() => getAuditWriter(workspace).append(row())).not.toThrow();
  });

  it.each([
    ["a directory", (p: string) => fs.mkdirSync(p)],
    ["a symlink", (p: string) => fs.symlinkSync(path.join(workspace, "elsewhere"), p)],
  ])("%s at the lock path is a clear LOCK error, not a hang or a steal", (_label, make) => {
    fs.mkdirSync(path.join(workspace, "scopelybot"), { recursive: true });
    make(lockFile());
    expect(() => getAuditWriter(workspace).append(row())).toThrow(
      expect.objectContaining({
        code: "LOCK",
        message: expect.stringMatching(/not a regular file/),
      }),
    );
    expect(fs.existsSync(auditFile(workspace))).toBe(false);
  });

  it("a stale lock (> 10 s) is stolen and the append proceeds", () => {
    const now = Date.now();
    holdLock(11_000, now);
    setAuditDepsForTest({ sleep: vi.fn(), now: () => now });
    expect(() => getAuditWriter(workspace).append(row())).not.toThrow();
    expect(readAuditRows(workspace)).toHaveLength(1);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it("releases only its own lock: a lock taken over meanwhile by another writer stays", () => {
    const lock = lockFile();
    const target = auditFile(workspace);
    const proxy = new Proxy(fs, {
      get(real, prop: string) {
        const fn = (real as unknown as Record<string, unknown>)[prop];
        if (prop !== "fsyncSync" || typeof fn !== "function") {
          return fn;
        }
        return (...args: unknown[]) => {
          // While we hold the lock, another writer steals it (ours looked stale).
          if (fs.existsSync(target)) {
            fs.writeFileSync(lock, "other-writer-token\n");
          }
          return (fn as (...a: unknown[]) => unknown).apply(real, args);
        };
      },
    });
    setAuditDepsForTest({ fs: proxy as unknown as typeof fs });
    getAuditWriter(workspace).append(row());
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.readFileSync(lock, "utf8")).toBe("other-writer-token\n");
  });

  it("a failed lock-token write (disk full) removes the lock it created", () => {
    const lock = lockFile();
    let lockFd = -1;
    const proxy = new Proxy(fs, {
      get(real, prop: string) {
        const fn = (real as unknown as Record<string, unknown>)[prop];
        if (typeof fn !== "function") {
          return fn;
        }
        return (...args: unknown[]) => {
          if (prop === "writeSync" && args[0] === lockFd) {
            lockFd = -1; // one failure only: the fd number is reused by the next open
            throw errno("ENOSPC");
          }
          const out = (fn as (...a: unknown[]) => unknown).apply(real, args);
          if (prop === "openSync" && args[0] === lock && args[1] === "wx") {
            lockFd = out as number;
          }
          return out;
        };
      },
    });
    setAuditDepsForTest({ fs: proxy as unknown as typeof fs });
    expect(() => getAuditWriter(workspace).append(row(1))).toThrow(
      expect.objectContaining({ code: "ENOSPC" }),
    );
    expect(fs.existsSync(lock)).toBe(false);
    expect(readAuditRows(workspace, { withEpoch: true })).toEqual([]); // nothing written unlocked
    setAuditDepsForTest({ sleep: vi.fn() }); // disk space back: no 10 s LOCK wait
    expect(() => getAuditWriter(workspace).append(row(2))).not.toThrow();
  });

  it("the lock is released when the append throws", () => {
    getAuditWriter(workspace).append(row(1));
    fs.appendFileSync(auditFile(workspace), "{}\n"); // a parseable non-record: INTEGRITY
    expect(() => getAuditWriterFresh().append(row(2))).toThrow(AuditWriteError);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it("an unwritable lock directory fails the append (EACCES), nothing written", () => {
    fs.mkdirSync(path.join(workspace, "scopelybot"));
    fs.chmodSync(path.join(workspace, "scopelybot"), 0o500);
    try {
      expect(() => getAuditWriter(workspace).append(row())).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );
    } finally {
      fs.chmodSync(path.join(workspace, "scopelybot"), 0o700);
    }
    expect(fs.existsSync(auditFile(workspace))).toBe(false);
  });
});

describe("recovery sweep (crash between intent and outcome)", () => {
  const intentRow = (t0: number) =>
    row(0, {
      event_type: "http_intent",
      phase: "intent",
      http: {
        method: "GET",
        host: "h",
        path_template: "/x",
        deadline_ts: new Date(t0 + 15_000).toISOString(),
      },
    });
  const recoveryRowsFor = (id: string) =>
    readAuditRows(workspace).filter((r) => r.recovery && r.audit_id === id);

  it("a crash and a restart inside the deadline: the orphan is recorded once the deadline passes", () => {
    const t0 = Date.UTC(2026, 9, 12, 12);
    let now = t0;
    setAuditDepsForTest({ now: () => now });
    const intent = getAuditWriter(workspace).append(intentRow(t0));
    now = t0 + 3_000;
    setAuditDepsForTest({ now: () => now }); // the restarted process: a fresh writer
    const writer = getAuditWriter(workspace);
    writer.append(row(1));
    expect(recoveryRowsFor(intent.audit_id)).toHaveLength(0);
    now = t0 + 20_000;
    writer.append(row(2));
    expect(recoveryRowsFor(intent.audit_id)).toEqual([
      expect.objectContaining({ result: { status: "indeterminate", reason: "crash_recovery" } }),
    ]);
    writer.append(row(3));
    expect(recoveryRowsFor(intent.audit_id)).toHaveLength(1);
    expect(verifyChain(text(), { requirePaired: true }).ok).toBe(true);
  });

  it("the first sweep reaches an orphan more than 64 KiB (up to 1 MiB) back", () => {
    const t0 = Date.UTC(2026, 9, 12, 12);
    let now = t0;
    setAuditDepsForTest({ now: () => now });
    const writer = getAuditWriter(workspace);
    const intent = writer.append(intentRow(t0));
    for (let i = 0; i < 15; i++) {
      writer.append(row(i, { blob: "y".repeat(7_000) })); // about 105 KB after the intent
    }
    now = t0 + 20_000;
    setAuditDepsForTest({ now: () => now });
    getAuditWriter(workspace).append(row(99));
    expect(recoveryRowsFor(intent.audit_id)).toHaveLength(1);
  });

  it("a fresh writer records an expired orphan intent as indeterminate, once", () => {
    const t0 = Date.UTC(2026, 9, 12, 12);
    let now = t0;
    setAuditDepsForTest({ now: () => now });
    const intent = getAuditWriter(workspace).append(
      row(0, {
        event_type: "http_intent",
        phase: "intent",
        http: {
          method: "GET",
          host: "h",
          path_template: "/x",
          deadline_ts: new Date(t0 + 15_000).toISOString(),
        },
      }),
    );
    expect(verifyChain(text(), { requirePaired: true })).toMatchObject({
      ok: false,
      reason: "unpaired_intent",
    });

    // Still inside its deadline: a restarted writer leaves it open.
    now = t0 + 5_000;
    setAuditDepsForTest({ now: () => now });
    getAuditWriter(workspace).append(row(1));
    expect(readAuditRows(workspace).filter((r) => r.recovery)).toHaveLength(0);

    now = t0 + 16_000;
    setAuditDepsForTest({ now: () => now }); // a restart: no cached head
    getAuditWriter(workspace).append(row(2));
    getAuditWriter(workspace).append(row(3));
    const recovered = readAuditRows(workspace).filter((r) => r.recovery);
    expect(recovered).toEqual([
      expect.objectContaining({
        event_type: "http_outcome",
        phase: "outcome",
        audit_id: intent.audit_id,
        result: { status: "indeterminate", reason: "crash_recovery" },
        recovery: { source: "recovery", intent_seq: intent.seq, intent_ts: intent.ts },
      }),
    ]);
    expect(verifyChain(text(), { requirePaired: true }).ok).toBe(true);
  });
});

function readAuditRowsLoose() {
  return text()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
