// scripts/verify-audit-chain.mjs (PK-7b, AC-7.7): exit codes via the real CLI,
// the exhaustive byte-flip and tamper classes in-process, the honest limits
// without an anchor, anchors, rotation continuity, the v1 cross-check, and the
// cross-implementation pin against the TS writer. Fixtures are generated here.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJson as mjsCanonical,
  recordHash as mjsRecordHash,
  verifyChain,
} from "../scripts/verify-audit-chain.mjs";
import { getAuditWriter, setAuditDepsForTest } from "./audit-chain.js";
import { auditFile, GOLDEN } from "./audit.test-helpers.js";

const SCRIPT = fileURLToPath(new URL("../scripts/verify-audit-chain.mjs", import.meta.url));
let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "scopelybot-verify-"));
  setAuditDepsForTest(null);
});
afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

// A real 6-row chain from the TS writer: epoch marker + 5 rows (one intent/outcome pair).
function writeFixture(): string {
  const w = getAuditWriter(workspace);
  const base = {
    env: "dev",
    plugin_version: "0.1.0",
    bot_principal: { auth_mode: "anonymous", principal_id: null },
  };
  w.append({ ...base, event_type: "tool_call", detail: { n: 1 } });
  const intent = w.append({
    ...base,
    event_type: "http_intent",
    phase: "intent",
    http: { method: "GET", deadline_ts: new Date(Date.now() + 15_000).toISOString() },
  });
  w.append({
    ...base,
    event_type: "http_outcome",
    phase: "outcome",
    audit_id: intent.audit_id,
    http: { method: "GET", status: 200 },
  });
  w.append({ ...base, event_type: "tool_call", detail: { n: 2 } });
  w.append({ ...base, event_type: "policy_change", detail: { valid: true } });
  return fs.readFileSync(auditFile(workspace), "utf8");
}

const lines = (text: string) => text.trimEnd().split("\n");
const join = (ls: string[]) => `${ls.join("\n")}\n`;
const records = (text: string) => lines(text).map((l) => JSON.parse(l) as Record<string, unknown>);

// The attacker with write access: rewrite records and recompute every hash.
function recompute(recs: Record<string, unknown>[], firstPrev = "0".repeat(64)): string {
  let prev = firstPrev;
  return join(
    recs.map((r) => {
      const next: Record<string, unknown> = { ...r, prev_hash: prev };
      delete next.hash;
      next.hash = mjsRecordHash(next);
      prev = next.hash as string;
      return mjsCanonical(next);
    }),
  );
}

// Copies of the records with seq rewritten (the attacker renumbers, then recomputes).
function withSeq(recs: Record<string, unknown>[], seqOf: (seq: number, i: number) => number) {
  const copies = structuredClone(recs);
  copies.forEach((r, i) => {
    r.seq = seqOf(r.seq as number, i);
  });
  return copies;
}

function cli(text: string | null, ...args: string[]) {
  const file = path.join(workspace, "chain.jsonl");
  if (text !== null) {
    fs.writeFileSync(file, text);
  }
  const out = spawnSync(process.execPath, [SCRIPT, ...(text === null ? [] : [file]), ...args], {
    encoding: "utf8",
  });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

describe("verify-audit-chain.mjs", () => {
  it("cross-implementation: the golden vector and the TS writer's output verify (exit 0)", () => {
    expect(mjsCanonical(GOLDEN.record)).toBe(GOLDEN.canonical);
    expect(mjsRecordHash(GOLDEN.record)).toBe(GOLDEN.hash);
    const text = writeFixture();
    expect(lines(text)).toHaveLength(6);
    const run = cli(text, "--require-paired", "--json");
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, last_seq: 6, unpaired: [] });
  });

  it("exhaustive byte flip: every single changed byte of the fixture fails", () => {
    const bytes = Buffer.from(writeFixture(), "utf8");
    let failed = 0;
    for (let i = 0; i < bytes.length; i++) {
      const copy = Buffer.from(bytes);
      copy[i] ^= 0x01;
      if (!verifyChain(copy.toString("utf8")).ok) {
        failed++;
      }
    }
    expect(failed).toBe(bytes.length);
  });

  it.each([
    [
      "interior line deleted",
      (ls: string[]) => join([...ls.slice(0, 2), ...ls.slice(3)]),
      "bad_seq",
    ],
    ["two lines swapped", (ls: string[]) => join([ls[0], ls[2], ls[1], ...ls.slice(3)]), "bad_seq"],
    [
      "duplicated line",
      (ls: string[]) => join([...ls.slice(0, 3), ls[2], ...ls.slice(3)]),
      "bad_seq",
    ],
    ["partial-line truncation", (ls: string[]) => join(ls).slice(0, -20), "torn_tail"],
    [
      "a blank line",
      (ls: string[]) => join([...ls.slice(0, 2), "", ...ls.slice(2)]),
      "non_canonical",
    ],
    ["CRLF line endings", (ls: string[]) => `${ls.join("\r\n")}\r\n`, "non_canonical"],
    [
      "key-reordered line",
      (ls: string[]) =>
        join([
          ls[0],
          JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(ls[1])).toReversed())),
          ...ls.slice(2),
        ]),
      "non_canonical",
    ],
    [
      "extra whitespace",
      (ls: string[]) => join([ls[0], ls[1].replace(":", ": "), ...ls.slice(2)]),
      "non_canonical",
    ],
    [
      "edited middle value",
      (ls: string[]) => join([ls[0], ls[1], ls[2].replace('"GET"', '"PUT"'), ...ls.slice(3)]),
      "bad_hash",
    ],
    [
      "a garbage line nobody cites",
      (ls: string[]) => join([...ls.slice(0, 3), '{"torn', ...ls.slice(3)]),
      "unexplained_garbage",
    ],
  ])("rejects %s (exit 1)", (_label, tamper, reason) => {
    const run = cli(tamper(lines(writeFixture())), "--json");
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: false, reason });
  });

  it("whole-line tail deletion passes without an anchor (the honest limit) and fails with one", () => {
    const text = writeFixture();
    const head = records(text).at(-1);
    const truncated = join(lines(text).slice(0, -1));
    expect(cli(truncated).code).toBe(0);
    const run = cli(truncated, "--anchor", `${String(head?.seq)},${String(head?.hash)}`, "--json");
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ reason: "anchor_missing_seq" });
  });

  it("a fully recomputed chain after editing row 3 passes alone and fails against the anchor", () => {
    const text = writeFixture();
    const head = records(text).at(-1);
    const recs = records(text);
    recs[2] = { ...recs[2], http: { method: "DELETE", status: 200 } };
    const forged = recompute(recs);
    expect(cli(forged).code).toBe(0);
    const run = cli(forged, "--anchor", `${String(head?.seq)},${String(head?.hash)}`, "--json");
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ reason: "anchor_mismatch" });
  });

  it("a seq gap or duplicate seq with recomputed hashes fails; an anchor beyond the file fails", () => {
    const recs = records(writeFixture());
    const gap = recompute(withSeq(recs, (seq, i) => (i >= 3 ? seq + 1 : seq)));
    expect(JSON.parse(cli(gap, "--json").stdout)).toMatchObject({ reason: "bad_seq", seq: 5 });
    const dup = recompute(withSeq(recs, (seq, i) => (i === 3 ? 3 : seq)));
    expect(JSON.parse(cli(dup, "--json").stdout)).toMatchObject({ reason: "bad_seq" });
    const run = cli(join(lines(writeFixtureFresh())), "--anchor", `99,${"a".repeat(64)}`, "--json");
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ reason: "anchor_missing_seq" });
  });

  it.each([
    ["no file argument", [] as string[]],
    ["an unknown flag", ["--frobnicate"]],
    ["a malformed anchor", ["--anchor", "x,y"]],
    ["--prev-hash without --first-seq", ["--prev-hash", "a".repeat(64)]],
  ])("bad usage (%s) exits 2", (_label, args) => {
    const run = args.length === 0 ? cli(null) : cli(writeFixture(), ...args);
    expect(run.code).toBe(2);
  });

  it("an unreadable file exits 2", () => {
    const out = spawnSync(process.execPath, [SCRIPT, path.join(workspace, "missing.jsonl")]);
    expect(out.status).toBe(2);
  });

  it("genesis: the first record must be an epoch_marker on the zero hash", () => {
    const recs = records(writeFixture());
    const noMarker = recompute(withSeq(recs.slice(1), (_seq, i) => i + 1));
    expect(JSON.parse(cli(noMarker, "--json").stdout)).toMatchObject({ reason: "bad_genesis" });
    const wrongPrev = recompute(recs, "f".repeat(64));
    expect(JSON.parse(cli(wrongPrev, "--json").stdout)).toMatchObject({ reason: "bad_genesis" });
    const badMarker = recompute([{ ...recs[0], detail: {} }, ...recs.slice(1)]);
    expect(JSON.parse(cli(badMarker, "--json").stdout)).toMatchObject({ reason: "bad_schema" });
    const { v1: _v1, ...noV1 } = recs[0];
    const cutoverWithoutV1 = recompute([noV1, ...recs.slice(1)]);
    expect(JSON.parse(cli(cutoverWithoutV1, "--json").stdout)).toMatchObject({
      reason: "bad_schema",
    });
    const numericReason = recompute([{ ...recs[0], detail: { reason: 5 } }, ...recs.slice(1)]);
    expect(JSON.parse(cli(numericReason, "--json").stdout)).toMatchObject({ reason: "bad_schema" });
    expect(JSON.parse(cli("", "--json").stdout)).toMatchObject({ reason: "bad_genesis" });
  });

  it("rotation continuity: a later segment verifies only with the right --prev-hash and --first-seq", () => {
    const text = writeFixture();
    const recs = records(text);
    const segment = join(lines(text).slice(3));
    const prev = String(recs[2].hash);
    expect(cli(segment, "--prev-hash", prev, "--first-seq", "4").code).toBe(0);
    expect(
      JSON.parse(cli(segment, "--prev-hash", "e".repeat(64), "--first-seq", "4", "--json").stdout),
    ).toMatchObject({ reason: "bad_prev_hash" });
    expect(JSON.parse(cli(segment, "--json").stdout)).toMatchObject({ reason: "bad_seq" });
  });

  it("cross-checks the epoch marker against the archived v1 file", () => {
    fs.mkdirSync(path.join(workspace, "scopelybot"), { recursive: true });
    const v1 = path.join(workspace, "scopelybot", "audit.jsonl");
    fs.writeFileSync(v1, '{"ts":"2026-10-01T00:00:00.000Z"}\n');
    const text = writeFixture();
    expect(cli(text, "--v1-file", v1).code).toBe(0);
    const other = path.join(workspace, "other-v1.jsonl");
    fs.writeFileSync(other, '{"ts":"2026-10-01T00:00:00.001Z"}\n');
    expect(JSON.parse(cli(text, "--v1-file", other, "--json").stdout)).toMatchObject({
      reason: "v1_mismatch",
    });
    expect(JSON.parse(cli(text, "--v1-sha256", "0".repeat(64), "--json").stdout)).toMatchObject({
      reason: "v1_mismatch",
    });
  });

  it("--emit-anchor prints a verifiable anchor; --anchor-file checks it, including the file prefix", () => {
    const text = writeFixture();
    const emitted = cli(text, "--emit-anchor");
    expect(emitted.code).toBe(0);
    const anchor = JSON.parse(emitted.stdout);
    expect(anchor).toMatchObject({
      anchor_version: 1,
      env: "dev",
      first_seq: 1,
      last_seq: 6,
      bytes: Buffer.byteLength(text),
    });
    const anchorFile = path.join(workspace, "anchor.json");
    fs.writeFileSync(anchorFile, JSON.stringify(anchor));
    expect(cli(text, "--anchor-file", anchorFile).code).toBe(0);
    const longer = text + lines(writeFixtureAppend()).at(-1) + "\n";
    expect(cli(longer, "--anchor-file", anchorFile).code).toBe(0); // the anchor is a prefix commitment
    fs.writeFileSync(anchorFile, JSON.stringify({ ...anchor, file_sha256: "0".repeat(64) }));
    expect(JSON.parse(cli(text, "--anchor-file", anchorFile, "--json").stdout)).toMatchObject({
      reason: "anchor_file_mismatch",
    });
  });

  it("an unpaired intent is reported, and fails only under --require-paired", () => {
    const text = join(lines(writeFixture()).slice(0, 3)); // intent kept, outcome dropped
    const plain = JSON.parse(cli(text, "--json").stdout);
    expect(plain).toMatchObject({ ok: true, unpaired: [3] });
    expect(JSON.parse(cli(text, "--require-paired", "--json").stdout)).toMatchObject({
      reason: "unpaired_intent",
      seq: 3,
    });
  });
});

// A second, independent chain (fresh workspace subdir) for anchor-length tests.
function writeFixtureFresh(): string {
  const saved = workspace;
  workspace = fs.mkdtempSync(path.join(saved, "fresh-"));
  try {
    return writeFixture();
  } finally {
    workspace = saved;
  }
}

// One more row appended by the writer to the same chain.
function writeFixtureAppend(): string {
  getAuditWriter(workspace).append({
    env: "dev",
    plugin_version: "0.1.0",
    bot_principal: { auth_mode: "anonymous", principal_id: null },
    event_type: "tool_call",
  });
  return fs.readFileSync(auditFile(workspace), "utf8");
}
