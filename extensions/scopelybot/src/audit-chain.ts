// audit-v2 chain core (PK-7b): one append-only, hash-chained JSONL file per
// workspace (<workspace>/scopelybot/audit-v2.jsonl) written by a synchronous,
// module-global writer. Each line is canonicalJson(record) where
//   record.hash = sha256(prev_hash || "\n" || canonicalJson(record without hash)),
// seq is strictly +1 and the first record is an epoch_marker citing the frozen
// v1 audit.jsonl (sha256/bytes/lines). scripts/verify-audit-chain.mjs checks a
// file independently (it duplicates canonicalJson; a golden vector pins both).
//
// Correctness never depends on module identity or memory: every append takes
// the lock, re-reads the tail FROM THE FILE, refuses to extend a tail it cannot
// verify (INTEGRITY, fail closed), closes a torn last line by appending "\n"
// (cited in the next record's repaired_torn_lines), writes, fsyncs and
// releases. The file is only ever opened to append or to read (chattr +a
// compatible): no truncate, rename or unlink; every open refuses a symlink and
// never blocks (a FIFO is refused, not waited on). The O_EXCL lockfile guards
// other processes (CLI runs, an overlapping old gateway); in-process appends
// cannot interleave because the whole append is synchronous. Docs:
// docs/audit-v2.md.

import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";

export type AuditEventType =
  | "epoch_marker"
  | "policy_change"
  | "audit_gap"
  | "http_intent"
  | "http_outcome"
  | "backend_off"
  | "write_blocked_read_only"
  | "write_blocked_unattributed"
  | "host_blocked"
  | "header_blocked"
  | "body_blocked"
  | "redirect_blocked"
  | "rate_limited"
  | "not_available"
  | "tool_call"
  | "confirm_ok"
  | "confirm_error"
  | "confirm_denied"
  | "confirm_expired"
  | "approver_change"
  | "inbound_block"
  | "inbound_flag"
  | "supervisor"
  | "digest_skipped";

export type AuditInput = { event_type: AuditEventType; audit_id?: string } & Record<
  string,
  unknown
>;
export type AuditRecord = AuditInput & {
  schema_version: 2;
  seq: number;
  ts: string;
  prev_hash: string;
  hash: string;
  audit_id: string;
};
export type AuditErrorCode =
  | "ENOSPC"
  | "EACCES"
  | "EROFS"
  | "LOCK"
  | "INTEGRITY"
  | "TOO_LARGE"
  | "IO";

export class AuditWriteError extends Error {
  constructor(
    readonly code: AuditErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuditWriteError";
  }
}

export const GENESIS_HASH = "0".repeat(64);
export const AUDIT_FILE = "audit-v2.jsonl";
const TAIL_WINDOW = 64 * 1024;
const SWEEP_WINDOW = 1024 * 1024;
const MAX_TORN_LINES = 8;
const MAX_V1_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 253;
const SOFT_RECORD_BYTES = 8 * 1024;
const MAX_RECORD_BYTES = 16 * 1024;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = 5;
const LOCK_SLEEP_MS = 20;
const TERMINAL = new Set(["http_outcome", "redirect_blocked", "rate_limited"]);

/** Sorted keys, no whitespace, safe integers only (floats only for param hashing). */
export function canonicalJson(value: unknown, allowFloats = false): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (allowFloats ? Number.isFinite(value) : Number.isSafeInteger(value)) {
      return JSON.stringify(value);
    }
    throw new TypeError("canonicalJson: unsupported number");
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => (v === undefined ? "null" : canonicalJson(v, allowFloats)));
    return `[${items.join(",")}]`;
  }
  const proto = typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .toSorted();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k], allowFloats)}`).join(",")}}`;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * A host- or response-supplied string bounded for a row: at most 253
 * characters, a longer value kept as a 240-character prefix plus "~" and 12
 * hex of its sha256, so no such value can push a row over the 16 KiB cap.
 */
export function boundedText(value: string): string {
  return value.length <= MAX_TEXT
    ? value
    : `${value.slice(0, 240)}~${sha256Hex(value).slice(0, 12)}`;
}

/** The record hash: sha256(prev_hash || 0x0A || canonicalJson(record without "hash")). */
export function recordHash(record: Record<string, unknown>): string {
  const { hash: _hash, ...body } = record;
  return sha256Hex(`${String(record.prev_hash)}\n${canonicalJson(body)}`);
}

// 26-char Crockford ULID: 48-bit ms time + 80-bit random, strictly increasing
// within the process (same ms: random part + 1), so ids sort in mint order.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let ulidMs = -1;
let ulidRand = 0n;
function base32(value: bigint, length: number): string {
  let out = "";
  for (let i = 0, v = value; i < length; i++, v >>= 5n) {
    out = CROCKFORD[Number(v & 31n)] + out;
  }
  return out;
}
export function newAuditId(): string {
  const now = Date.now();
  if (now > ulidMs) {
    ulidMs = now;
    ulidRand = BigInt(`0x${randomBytes(10).toString("hex")}`);
  } else {
    ulidRand = (ulidRand + 1n) & ((1n << 80n) - 1n);
  }
  return base32(BigInt(ulidMs), 10) + base32(ulidRand, 16);
}

export type AuditFs = Pick<
  typeof nodeFs,
  | "openSync"
  | "readSync"
  | "writeSync"
  | "fsyncSync"
  | "closeSync"
  | "fstatSync"
  | "lstatSync"
  | "unlinkSync"
  | "mkdirSync"
>;
type Deps = { fs: AuditFs; now: () => number; sleep: (ms: number) => void };
const DEFAULT_DEPS: Deps = {
  fs: nodeFs,
  now: () => Date.now(),
  // Bounded, synchronous back-off for the cross-process lock (max 5 x 20 ms).
  sleep: (ms) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
};
let depsOverride: Partial<Deps> | undefined;
const deps = (): Deps => ({ ...DEFAULT_DEPS, ...depsOverride });

function errorCode(err: unknown): AuditErrorCode {
  if (err instanceof AuditWriteError) {
    return err.code;
  }
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOSPC" || code === "EROFS") {
    return code;
  }
  return code === "EACCES" || code === "EPERM" ? "EACCES" : "IO";
}

function readRange(fs: AuditFs, fd: number, start: number, end: number): Buffer {
  const buf = Buffer.alloc(end - start);
  let got = 0;
  while (got < buf.length) {
    const n = fs.readSync(fd, buf, got, buf.length - got, start + got);
    if (n === 0) {
      break;
    }
    got += n;
  }
  return buf.subarray(0, got);
}

const { O_RDONLY, O_WRONLY, O_APPEND, O_CREAT, O_NONBLOCK } = nodeFs.constants;
const O_NOFOLLOW = nodeFs.constants.O_NOFOLLOW ?? 0;

// Opens a path that must be a regular file: never through a symlink, never
// blocking (a FIFO at the path would otherwise hang the event loop), and the
// opened fd is checked (no check-then-open race). null when it does not exist.
function openRegular(fs: AuditFs, path: string, flags: number, code: AuditErrorCode) {
  let fd: number;
  try {
    fd = fs.openSync(path, flags | O_NONBLOCK | O_NOFOLLOW, 0o640);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") {
      return null;
    }
    throw errno === "ELOOP" ? new AuditWriteError(code, `${path} is a symlink`) : err;
  }
  if (!fs.fstatSync(fd).isFile()) {
    fs.closeSync(fd);
    throw new AuditWriteError(code, `${path} is not a regular file`);
  }
  return fd;
}

/** Lines of the last `windowBytes` bytes (the first partial line dropped), or null when absent. */
function readTail(fs: AuditFs, file: string, windowBytes: number) {
  const fd = openRegular(fs, file, O_RDONLY, "INTEGRITY");
  if (fd === null) {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - windowBytes - 1);
    const lines = readRange(fs, fd, start, size).toString("utf8").split("\n");
    const terminated = lines.at(-1) === "";
    if (terminated) {
      lines.pop();
    }
    if (start > 0) {
      lines.shift();
    }
    return { size, lines, terminated, fromStart: start === 0 };
  } finally {
    fs.closeSync(fd);
  }
}

/** The self-check of one stored line: byte-exact canonical form and a matching hash. */
export function verifyLine(line: string, record: Record<string, unknown>): boolean {
  try {
    return (
      canonicalJson(record) === line &&
      record.schema_version === 2 &&
      Number.isSafeInteger(record.seq) &&
      recordHash(record) === record.hash
    );
  } catch {
    return false;
  }
}

function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

type Tail = {
  head: { seq: number; hash: string } | null;
  torn: { bytes: number; sha256: string }[];
  needsNewline: boolean;
  lines: string[];
};

// The verified chain head plus the garbage after it. A parseable but invalid
// last line, or a head that does not link to the record before it, is INTEGRITY:
// the writer never extends a chain it can see is broken. Unparseable trailing
// lines are crash/ENOSPC fragments: up to 8 (64 KiB) are repaired and cited.
function inspectTail(tail: NonNullable<ReturnType<typeof readTail>>, expectHead: boolean): Tail {
  const torn: string[] = [];
  for (let i = tail.lines.length - 1; i >= 0; i--) {
    const line = tail.lines[i];
    if (line === "" || line.includes("\r")) {
      throw new AuditWriteError("INTEGRITY", "audit chain has a blank or CR line");
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      torn.unshift(line); // a crash/ENOSPC fragment: repaired and cited
      continue;
    }
    const record = parseObject(line);
    if (!record) {
      throw new AuditWriteError("INTEGRITY", `audit chain line is not a record (${typeof value})`);
    }
    // The head must link to the nearest earlier record, skipping repaired
    // fragments (a legitimate repair keeps that link; a forged head does not).
    let prev: Record<string, unknown> | undefined;
    for (let j = i - 1; j >= 0 && !prev; j--) {
      prev = parseObject(tail.lines[j]);
    }
    const linked = !prev || (prev.hash === record.prev_hash && Number(prev.seq) + 1 === record.seq);
    if (!verifyLine(line, record) || !linked) {
      throw new AuditWriteError(
        "INTEGRITY",
        `audit chain tail does not verify (seq ${String(record.seq)})`,
      );
    }
    return {
      head: { seq: record.seq as number, hash: record.hash as string },
      ...repairPlan(torn, tail),
      lines: tail.lines,
    };
  }
  if (expectHead || !tail.fromStart) {
    throw new AuditWriteError("INTEGRITY", "audit chain has no verifiable record");
  }
  return { head: null, ...repairPlan(torn, tail), lines: tail.lines };
}

// Any unterminated last line (a fragment, or a whole record whose "\n" was
// lost) is closed with "\n" before the next record; only fragments are cited.
function repairPlan(torn: string[], tail: { terminated: boolean; lines: string[] }) {
  const bytes = torn.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
  if (torn.length > MAX_TORN_LINES || bytes > TAIL_WINDOW) {
    throw new AuditWriteError("INTEGRITY", "audit chain tail has too much unexplained data");
  }
  return {
    torn: torn.map((line) => ({ bytes: Buffer.byteLength(line), sha256: sha256Hex(line) })),
    needsNewline: tail.lines.length > 0 && !tail.terminated,
  };
}

// The frozen v1 file, hashed once for the epoch marker (7b never writes v1).
// Absent is recorded as such; anything else unreadable, oversized or not a
// regular file fails the append, so the marker never misstates v1.
function describeV1(fs: AuditFs, file: string) {
  const path = "scopelybot/audit.jsonl";
  const fd = openRegular(fs, file, O_RDONLY, "INTEGRITY");
  if (fd === null) {
    return { path, exists: false, sha256: null, bytes: 0, lines: 0, last_ts: null };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size > MAX_V1_BYTES) {
      throw new AuditWriteError("INTEGRITY", "v1 audit.jsonl is larger than 8 MiB");
    }
    const data = readRange(fs, fd, 0, size);
    const ts = parseObject(data.toString("utf8").trimEnd().split("\n").at(-1) ?? "")?.ts;
    return {
      path,
      exists: true,
      sha256: sha256Hex(data),
      bytes: data.length,
      lines: data.filter((b) => b === 10).length,
      last_ts: typeof ts === "string" ? ts.slice(0, 64) : null,
    };
  } finally {
    fs.closeSync(fd);
  }
}

// Intents with no terminal row whose deadline passed (crash, lost ack or a
// failed outcome append). Their recovery rows are written inside the same
// locked append, so two writers cannot both write one.
function findOrphans(lines: string[], now: number) {
  const open = new Map<string, Record<string, unknown>>();
  for (const line of lines) {
    const r = parseObject(line);
    const id = typeof r?.audit_id === "string" ? r.audit_id : "";
    if (r?.event_type === "http_intent") {
      open.set(id, r);
    } else if (r && TERMINAL.has(String(r.event_type)) && r.phase === "outcome") {
      open.delete(id);
    }
  }
  const deadline = (r: Record<string, unknown>) =>
    Date.parse(String((r.http as Record<string, unknown> | undefined)?.deadline_ts));
  const orphans = [...open.values()].filter((r) => !(deadline(r) > now));
  return { orphans, inFlight: open.size > orphans.length };
}

const SYSTEM = { resolved: false, zoom_operator_id: null, source: "none", reason: "system" };

export type AuditWriter = {
  readonly file: string;
  append(input: AuditInput): AuditRecord;
  head(): { seq: number; hash: string } | null;
  degraded(): { since: string; code: AuditErrorCode } | null;
};

function createAuditWriter(file: string): AuditWriter {
  const lockFile = join(dirname(file), "audit-v2.lock");
  const v1File = join(dirname(file), "audit.jsonl");
  let cachedHead: { seq: number; hash: string } | null = null;
  let failure: { since: string; code: AuditErrorCode; count: number; refused: number } | null =
    null;
  let orphansPending = false;

  function lock(d: Deps): string {
    const token = randomBytes(8).toString("hex");
    for (let attempt = 0; attempt <= LOCK_RETRIES + 1; attempt++) {
      try {
        const fd = d.fs.openSync(lockFile, "wx", 0o640);
        try {
          d.fs.writeSync(fd, `${token} ${new Date(d.now()).toISOString()}\n`);
        } catch (err) {
          d.fs.unlinkSync(lockFile); // ours, just created: never leave an empty lock (ENOSPC)
          throw err;
        } finally {
          d.fs.closeSync(fd);
        }
        return token;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }
      }
      let held: nodeFs.Stats;
      try {
        held = d.fs.lstatSync(lockFile);
      } catch {
        continue; // released between our open and stat: retry now
      }
      if (!held.isFile()) {
        throw new AuditWriteError(
          "LOCK",
          `${lockFile} is not a regular file (inspect and remove it)`,
        );
      }
      const mtime = held.mtimeMs;
      if (d.now() - mtime > LOCK_STALE_MS) {
        try {
          d.fs.unlinkSync(lockFile); // a crashed holder: steal (best-effort, advisory)
        } catch {
          // another stealer won; retry the open
        }
        continue;
      }
      if (attempt >= LOCK_RETRIES) {
        break;
      }
      d.sleep(LOCK_SLEEP_MS);
    }
    throw new AuditWriteError("LOCK", "audit lock is held by another writer");
  }

  function unlock(d: Deps, token: string): void {
    try {
      const fd = openRegular(d.fs, lockFile, O_RDONLY, "LOCK");
      if (fd === null) {
        return;
      }
      let held: string;
      try {
        held = readRange(d.fs, fd, 0, 64).toString("utf8");
      } finally {
        d.fs.closeSync(fd);
      }
      if (held.startsWith(token)) {
        d.fs.unlinkSync(lockFile);
      }
    } catch {
      // gone or stolen: nothing of ours to release
    }
  }

  function seal(
    prev: { seq: number; hash: string } | null,
    body: Record<string, unknown>,
    now: number,
  ) {
    const record: Record<string, unknown> = {
      ...body,
      schema_version: 2,
      seq: (prev?.seq ?? 0) + 1,
      ts: new Date(now).toISOString(),
      prev_hash: prev?.hash ?? GENESIS_HASH,
      audit_id: typeof body.audit_id === "string" ? body.audit_id : newAuditId(),
    };
    record.hash = recordHash(record);
    let line = canonicalJson(record);
    const action = record.action as Record<string, unknown> | undefined;
    if (Buffer.byteLength(line) > SOFT_RECORD_BYTES && action?.params_redacted) {
      return seal(
        prev,
        { ...body, action: { ...action, params_redacted: null, params_dropped: true } },
        now,
      );
    }
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
      throw new AuditWriteError("TOO_LARGE", "audit record is larger than 16 KiB");
    }
    line += "\n";
    return {
      record: record as AuditRecord,
      line,
      head: { seq: record.seq as number, hash: record.hash as string },
    };
  }

  function appendLocked(d: Deps, input: AuditInput): AuditRecord {
    const now = d.now();
    // Orphan sweep: on a writer's first append, and after a failure until the
    // intents it may have left open are past their deadline.
    const sweep = cachedHead === null || orphansPending || failure !== null;
    const raw = readTail(d.fs, file, sweep ? SWEEP_WINDOW : TAIL_WINDOW);
    if (!raw && cachedHead) {
      throw new AuditWriteError("INTEGRITY", "audit chain file disappeared while in use");
    }
    // A writer that has a head expects one: an emptied file is refused like a vanished one.
    const tail = raw ? inspectTail(raw, cachedHead !== null) : null;
    let head = tail?.head ?? null;
    if (
      cachedHead &&
      head &&
      (head.seq < cachedHead.seq || (head.seq === cachedHead.seq && head.hash !== cachedHead.hash))
    ) {
      throw new AuditWriteError("INTEGRITY", "audit chain tail moved backwards");
    }
    const shared = {
      env: input.env,
      plugin_version: input.plugin_version,
      bot_principal: input.bot_principal,
    };
    const system = { ...shared, phase: "single", trigger: "startup", requester: SYSTEM };
    const bodies: Record<string, unknown>[] = [];
    if (!head) {
      bodies.push({
        ...system,
        event_type: "epoch_marker",
        detail: { reason: "cutover_v1", backend_from: "legacy", backend_to: "zw2" },
        v1: describeV1(d.fs, v1File),
      });
    }
    if (failure) {
      bodies.push({
        ...system,
        trigger: "hook",
        event_type: "audit_gap",
        detail: {
          from_ts: failure.since,
          to_ts: new Date(now).toISOString(),
          failures: failure.count,
          refused_requests: failure.refused,
          error_code: failure.code,
        },
      });
    }
    if (sweep && tail) {
      const { orphans, inFlight } = findOrphans(tail.lines, now);
      // Keep re-sweeping while an intent that may be orphaned is still inside its
      // deadline: one a failed append may have left, or one found by this
      // writer's first sweep (a crash and a quick restart).
      orphansPending = inFlight && (orphansPending || failure !== null || cachedHead === null);
      for (const intent of orphans) {
        bodies.push({
          ...system,
          phase: "outcome",
          trigger: "startup",
          event_type: "http_outcome",
          audit_id: intent.audit_id,
          http: {
            ...(intent.http as object),
            deadline_ts: undefined,
            status: null,
            duration_ms: null,
          },
          result: { status: "indeterminate", reason: "crash_recovery" },
          recovery: { source: "recovery", intent_seq: intent.seq, intent_ts: intent.ts },
        });
      }
    }
    bodies.push(input);
    if (tail?.torn.length) {
      bodies[0] = { ...bodies[0], repaired_torn_lines: tail.torn };
    }
    let out = tail?.needsNewline ? "\n" : "";
    const written: AuditRecord[] = [];
    for (const body of bodies) {
      const sealed = seal(head, body, now);
      out += sealed.line;
      head = sealed.head;
      written.push(sealed.record);
    }
    const fd = openRegular(d.fs, file, O_WRONLY | O_APPEND | O_CREAT, "INTEGRITY");
    if (fd === null) {
      throw new AuditWriteError("IO", "audit directory is missing");
    }
    try {
      const buf = Buffer.from(out, "utf8");
      for (let off = 0; off < buf.length; ) {
        off += d.fs.writeSync(fd, buf, off, buf.length - off);
      }
      d.fs.fsyncSync(fd);
    } finally {
      d.fs.closeSync(fd);
    }
    cachedHead = head;
    failure = null;
    return written[written.length - 1];
  }

  return {
    file,
    append(input) {
      const d = deps();
      try {
        d.fs.mkdirSync(dirname(file), { recursive: true });
        const token = lock(d);
        try {
          return appendLocked(d, input);
        } finally {
          unlock(d, token);
        }
      } catch (err) {
        const code = errorCode(err);
        failure ??= { since: new Date(d.now()).toISOString(), code, count: 0, refused: 0 };
        failure.count += 1;
        failure.code = code;
        if (input.event_type === "http_intent") {
          failure.refused += 1;
        }
        console.error(
          `[scopelybot-audit] audit_degraded ${code}: ${(err as Error)?.message ?? String(err)}`,
        );
        throw err instanceof AuditWriteError
          ? err
          : new AuditWriteError(code, `audit append failed (${code})`);
      }
    },
    head: () => cachedHead,
    degraded: () => (failure ? { since: failure.since, code: failure.code } : null),
  };
}

// One writer per resolved file, module-global: any number of register() calls
// in this module instance share it (a second module instance still serializes
// through the file tail and the lock).
const writers = new Map<string, AuditWriter>();

export function getAuditWriter(workspaceDir: string): AuditWriter {
  const file = join(workspaceDir, "scopelybot", AUDIT_FILE);
  let writer = writers.get(file);
  if (!writer) {
    writer = createAuditWriter(file);
    writers.set(file, writer);
  }
  return writer;
}

/** Test-only: inject fs/clock/sleep (null restores node:fs) and forget writers. */
export function setAuditDepsForTest(next: Partial<Deps> | null): void {
  if (!process.env.VITEST) {
    throw new Error("setAuditDepsForTest is test-only");
  }
  depsOverride = next ?? undefined;
  writers.clear();
}
