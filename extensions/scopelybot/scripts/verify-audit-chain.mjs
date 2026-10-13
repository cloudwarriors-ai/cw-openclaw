#!/usr/bin/env node
// Independent verifier for the scopelybot audit-v2 chain (PK-7b). Node
// built-ins only; it shares no code with the plugin. canonicalJson and the
// record hash are duplicated from src/audit-chain.ts and pinned to it by a
// golden vector and a cross-implementation test (verify-audit-chain.test.ts).
//
//   node verify-audit-chain.mjs <file> [--anchor <last_seq>,<head_hash> | --anchor-file <json>]
//        [--v1-file <path>] [--v1-sha256 <hex>] [--prev-hash <hex> --first-seq <n>]
//        [--allow-torn-tail] [--require-paired] [--emit-anchor] [--json]
//
// Exit 0 = verified; 1 = verification failed (first bad seq + reason code);
// 2 = usage or IO error. Without an anchor the chain cannot detect a
// whole-line tail deletion or a fully recomputed chain (docs/audit-v2.md).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

export const GENESIS_HASH = "0".repeat(64);
const HEX64 = /^[0-9a-f]{64}$/;
const TERMINAL = new Set(["http_outcome", "redirect_blocked", "rate_limited"]);

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) {
      return JSON.stringify(value);
    }
    throw new TypeError("canonicalJson: unsupported number");
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  }
  const proto = typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .toSorted();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

export function recordHash(record) {
  const { hash: _hash, ...body } = record;
  return sha256Hex(`${String(record.prev_hash)}\n${canonicalJson(body)}`);
}

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * Verify chain text. Returns { ok: true, head, firstSeq, hashes, unpaired, warnings, epoch }
 * or { ok: false, reason, seq, line, warnings }.
 */
export function verifyChain(text, opts = {}) {
  const warnings = [];
  const fail = (reason, seq, line) => ({ ok: false, reason, seq: seq ?? null, line, warnings });
  if (text === "") {
    return fail("bad_genesis", null, 1);
  }
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  if (terminated) {
    lines.pop();
  }
  // An unterminated last line is a torn write until the writer closes it.
  const tornTail = !terminated && lines.length > 0 && lines.at(-1) !== "" ? lines.pop() : undefined;
  let prevHash = opts.prevHash ?? GENESIS_HASH;
  let expectSeq = opts.firstSeq ?? 1;
  let garbage = [];
  let head = null;
  let epoch = null;
  let lastTs = null;
  const hashes = new Map();
  const intents = new Map();
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    if (raw === "" || raw.includes("\r")) {
      return fail("non_canonical", expectSeq, lineNo); // blank line or CRLF
    }
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      // A fragment: legal only if the next record cites it (repaired_torn_lines).
      garbage.push({ bytes: Buffer.byteLength(raw), sha256: sha256Hex(raw), line: lineNo });
      continue;
    }
    if (!isObject(record)) {
      return fail("bad_json", expectSeq, lineNo);
    }
    let canonical;
    try {
      canonical = canonicalJson(record);
    } catch {
      canonical = undefined;
    }
    if (canonical !== raw) {
      return fail("non_canonical", record.seq, lineNo);
    }
    if (
      record.schema_version !== 2 ||
      !HEX64.test(String(record.hash)) ||
      !HEX64.test(String(record.prev_hash)) ||
      typeof record.event_type !== "string" ||
      typeof record.audit_id !== "string" ||
      typeof record.ts !== "string"
    ) {
      return fail("bad_schema", record.seq, lineNo);
    }
    if (record.seq !== expectSeq) {
      return fail("bad_seq", record.seq, lineNo);
    }
    const genesis = head === null && opts.prevHash === undefined;
    if (record.prev_hash !== prevHash) {
      return fail(genesis ? "bad_genesis" : "bad_prev_hash", record.seq, lineNo);
    }
    if (recordHash(record) !== record.hash) {
      return fail("bad_hash", record.seq, lineNo);
    }
    if (record.event_type === "epoch_marker") {
      const reason = isObject(record.detail) ? record.detail.reason : undefined;
      if (typeof reason !== "string" || (reason === "cutover_v1" && !isObject(record.v1))) {
        return fail("bad_schema", record.seq, lineNo);
      }
      epoch ??= record;
    } else if (genesis) {
      return fail("bad_genesis", record.seq, lineNo);
    }
    const cited = Array.isArray(record.repaired_torn_lines) ? record.repaired_torn_lines : [];
    const explained =
      cited.length === garbage.length &&
      cited.every(
        (c, k) => isObject(c) && c.bytes === garbage[k].bytes && c.sha256 === garbage[k].sha256,
      );
    if (!explained) {
      return fail("unexplained_garbage", record.seq, garbage[0]?.line ?? lineNo);
    }
    garbage = [];
    if (record.event_type === "http_intent") {
      intents.set(record.audit_id, record.seq);
    } else if (TERMINAL.has(record.event_type) && record.phase === "outcome") {
      intents.delete(record.audit_id);
    }
    if (lastTs !== null && record.ts < lastTs) {
      warnings.push(`ts_regression at seq ${record.seq}`);
    }
    lastTs = record.ts;
    prevHash = record.hash;
    hashes.set(record.seq, record.hash);
    head = { seq: record.seq, hash: record.hash, env: record.env };
    expectSeq += 1;
  }
  if (garbage.length > 0 || tornTail !== undefined) {
    if (!opts.allowTornTail) {
      return fail("torn_tail", expectSeq, garbage[0]?.line ?? lines.length + 1);
    }
    warnings.push("torn_tail (allowed): the next append repairs and cites it");
  }
  if (head === null) {
    return fail("bad_genesis", null, 1);
  }
  const unpaired = [...intents.values()];
  if (unpaired.length > 0) {
    warnings.push(`unpaired http_intent at seq ${unpaired.join(",")}`);
    if (opts.requirePaired) {
      return fail("unpaired_intent", unpaired[0], null);
    }
  }
  return { ok: true, head, firstSeq: opts.firstSeq ?? 1, hashes, unpaired, warnings, epoch };
}

/** Anchor, v1 and file-prefix checks on top of verifyChain (all inputs already read). */
export function verifyFile(bytes, opts = {}) {
  const result = verifyChain(bytes.toString("utf8"), opts);
  if (!result.ok) {
    return result;
  }
  const fail = (reason, seq) => ({ ok: false, reason, seq, line: null, warnings: result.warnings });
  const anchor = opts.anchor;
  if (anchor) {
    if (anchor.last_seq > result.head.seq || anchor.last_seq < result.firstSeq) {
      return fail("anchor_missing_seq", anchor.last_seq);
    }
    if (result.hashes.get(anchor.last_seq) !== anchor.head_hash) {
      return fail("anchor_mismatch", anchor.last_seq);
    }
    if (
      anchor.file_sha256 !== undefined &&
      (anchor.bytes > bytes.length ||
        sha256Hex(bytes.subarray(0, anchor.bytes)) !== anchor.file_sha256)
    ) {
      return fail("anchor_file_mismatch", anchor.last_seq);
    }
  }
  const v1 = result.epoch?.v1;
  if (
    opts.v1 &&
    (!isObject(v1) ||
      ["sha256", "bytes", "lines"].some((k) => k in opts.v1 && v1[k] !== opts.v1[k]))
  ) {
    return fail("v1_mismatch", result.epoch?.seq ?? null);
  }
  return result;
}

function parseArgs(argv) {
  const opts = {};
  let file;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) {
        throw new Error(`${arg} needs a value`);
      }
      return argv[++i];
    };
    if (arg === "--anchor") {
      const [seq, hash] = next().split(",");
      opts.anchor = { last_seq: Number(seq), head_hash: hash };
    } else if (arg === "--anchor-file") {
      opts.anchor = JSON.parse(readFileSync(next(), "utf8"));
    } else if (arg === "--v1-file") {
      const v1 = readFileSync(next());
      opts.v1 = {
        sha256: sha256Hex(v1),
        bytes: v1.length,
        lines: v1.filter((b) => b === 10).length,
      };
    } else if (arg === "--v1-sha256") {
      opts.v1 = { ...opts.v1, sha256: next() };
    } else if (arg === "--prev-hash") {
      opts.prevHash = next();
    } else if (arg === "--first-seq") {
      opts.firstSeq = Number(next());
    } else if (
      arg === "--allow-torn-tail" ||
      arg === "--require-paired" ||
      arg === "--emit-anchor" ||
      arg === "--json"
    ) {
      opts[arg.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = true;
    } else if (!arg.startsWith("--") && file === undefined) {
      file = arg;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  const anchor = opts.anchor;
  const badAnchor =
    anchor && (!Number.isSafeInteger(anchor.last_seq) || !HEX64.test(String(anchor.head_hash)));
  const badPrev =
    (opts.prevHash !== undefined) !== (opts.firstSeq !== undefined) ||
    (opts.prevHash !== undefined && !HEX64.test(opts.prevHash));
  if (
    !file ||
    badAnchor ||
    badPrev ||
    (opts.firstSeq !== undefined && !Number.isSafeInteger(opts.firstSeq))
  ) {
    throw new Error(
      "usage: verify-audit-chain.mjs <file> [--anchor <seq>,<hash> | --anchor-file <json>] [--v1-file <path>] [--v1-sha256 <hex>] [--prev-hash <hex> --first-seq <n>] [--allow-torn-tail] [--require-paired] [--emit-anchor] [--json]",
    );
  }
  return { file, opts };
}

export function main(argv) {
  let file;
  let opts;
  let bytes;
  try {
    ({ file, opts } = parseArgs(argv));
    bytes = readFileSync(file);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  const result = verifyFile(bytes, opts);
  const summary = result.ok
    ? {
        ok: true,
        last_seq: result.head.seq,
        head_hash: result.head.hash,
        unpaired: result.unpaired,
        warnings: result.warnings,
      }
    : {
        ok: false,
        reason: result.reason,
        seq: result.seq,
        line: result.line,
        warnings: result.warnings,
      };
  if (result.ok && opts.emitAnchor) {
    const anchor = {
      anchor_version: 1,
      env: result.head.env ?? "unknown",
      file: basename(file),
      first_seq: result.firstSeq,
      last_seq: result.head.seq,
      head_hash: result.head.hash,
      bytes: bytes.length,
      file_sha256: sha256Hex(bytes),
      ts: new Date().toISOString(),
    };
    process.stdout.write(`${JSON.stringify(anchor)}\n`);
  } else if (opts.json) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } else {
    process.stdout.write(
      result.ok
        ? `verified: seq 1..${result.head.seq} head ${result.head.hash}${result.warnings.map((w) => `\nwarning: ${w}`).join("")}\n`
        : `FAILED: ${result.reason} at seq ${result.seq ?? "?"} (line ${result.line ?? "?"})\n`,
    );
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
